// LLM benchmark: natural-language commands to the SpaceTime agent, each checked for its actual
// effect on the installation - a property switched, or an automation created that does the
// right thing when run (PUT /automations/:id/test) under conditions the test sets up. Acts on
// the demo entities (npm run seed): Garden pump, Office lamp, Weather and so on.
//
// The LLM is the one the agent container runs (LLM_PROVIDER/LLM_MODEL in .env, applied with
// docker compose up -d). Each test logs one line to results/local/llm-<provider>[-<model>].jsonl:
// pass/fail, the round trip time of the chat request, the reply and the generated script.
// LLM output varies between runs: compare pass rates over several runs (npm run sweep).
import { before, describe, it } from 'node:test'
import { CronExpressionParser } from 'cron-parser'
import { waitFor } from '../lib/api.ts'
import { AGENT_URL, SERVER_URL } from '../lib/env.ts'
import { expect } from '../lib/expect.ts'
import { throttle } from '../lib/rate-limiter.ts'
import { agentInfo, appendResult, writeEnvironment } from '../lib/results.ts'

let llm: { provider: string, model: string } = { provider: 'unknown', model: '' }
const logFile = () => `llm-${`${llm.provider}${llm.model ? '-' + llm.model : ''}`.replace(/[^a-zA-Z0-9.-]/g, '_')}.jsonl`

before(async () => {
    await waitFor(SERVER_URL + '/health')
    await waitFor(AGENT_URL + '/')
    const info = await agentInfo()
    if (info?.entity !== 'entity') throw new Error(`the agent runs the '${info?.entity}' toolset, not 'entity' - set ENTITY=entity (docker-compose.yml) and docker compose up -d`)
    llm = { provider: info.provider, model: info.model }
    if (!await findEntity('Garden pump')) throw new Error("demo entity 'Garden pump' not found - run 'npm run seed' first")
    await writeEnvironment('llm', { llm })
    console.log(`LLM: ${llm.provider} ${llm.model}`)
})

const CHAT_URL = `${AGENT_URL}/chat`

// Benchmark instrumentation: times only the actual agent round-trip (the fetch itself, after
// throttle()'s rate-limit wait - which is test-harness bookkeeping, not agent work), and
// records the message + duration + the LLM's own reply + any automation script it generated,
// for whichever test is currently running, so `benchmarked()` can log one result per test once
// it knows pass/fail. Each test below calls this exactly once (the one command being
// benchmarked), so there's no ambiguity about which call this is.
let currentCommandMessage = ''
let currentCommandSeconds = 0
let currentCommandResponse = ''
let currentCommandScript = ''

async function timedChat(body: { message: string, sessionId?: string }): Promise<Response> {
    currentCommandMessage = (body as any).message ?? ''
    await throttle(llm.provider)
    const start = performance.now()
    const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    currentCommandSeconds = (performance.now() - start) / 1000
    // Cloned so this read doesn't consume the body the caller still needs to res.json() itself.
    // Best-effort - an unparseable/non-JSON body (e.g. a non-200 error page) just leaves this empty
    // rather than failing the test over logging.
    currentCommandScript = ''
    try {
        const data: any = await res.clone().json()
        currentCommandResponse = data?.data?.message ?? ''
        // Immediate-action tools (set_property_value/add_property_value/set_property_by_filter)
        // run once and are never persisted anywhere - agent.ts's chat() is the only place their
        // script is visible, via this same chat response (see entity-tools.ts's
        // recordTurnScript/takeTurnScripts). Default for tests whose tool creates an
        // automation instead - the lookup below overrides this when one was actually created.
        const immediateScripts: string[] = Array.isArray(data?.data?.scripts) ? data.data.scripts : []
        currentCommandScript = immediateScripts.join('\n\n')
    } catch {
        currentCommandResponse = ''
    }
    // Same lookup every automation-creating test already does itself afterward (findScheduled
    // over GET /automations/) - done here too so the script ends up in the log for every test
    // without each one having to report it separately. Both create_automation and
    // create_automation_script compile down to a stored mode:'script' automation with a real
    // script, so this takes priority over an immediate-action script (above) whenever one exists.
    try {
        const automations: any[] = await fetch(`${SERVER_URL}/automations/`).then(r => r.json())
        const scheduled = findScheduled(currentCommandMessage, automations, true)
        if (scheduled?.script) currentCommandScript = scheduled.script
    } catch { }
    return res
}

// Wraps it() to log one result line per test - the measured duration, pass/fail, the LLM's own
// reply and any script it generated - without changing the test's own pass/fail (the error is
// rethrown). node:test fails a test that exceeds its timeout without settling the test's
// promise, so the catch below would never run and a timed-out test would never be logged: our
// own timer, a little before node:test's, rejects first and logs it as 'fail'.
const TIMEOUT_LOG_MARGIN_MS = 1000

function benchmarked(name: string, fn: () => Promise<void>, timeout?: number) {
    it(name, { timeout }, async () => {
        currentCommandMessage = ''
        currentCommandSeconds = 0
        currentCommandResponse = ''
        currentCommandScript = ''
        const log = (status: 'pass' | 'fail') => appendResult(logFile(), {
            status,
            message: currentCommandMessage,
            llmProvider: llm.provider,
            llmModel: llm.model,
            durationSeconds: Number(currentCommandSeconds.toFixed(3)),
            response: currentCommandResponse,
            script: currentCommandScript,
        })
        let timer: NodeJS.Timeout | undefined
        try {
            await (timeout ? Promise.race([
                fn(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`benchmarked test timed out after ${timeout}ms`)), Math.max(timeout - TIMEOUT_LOG_MARGIN_MS, 0))
                }),
            ]) : fn())
            log('pass')
        } catch (err: any) {
            log('fail')
            throw err
        } finally {
            clearTimeout(timer)
        }
    })
}

// create_automation names the automation after the exact chat message (see storeAutomation
// in src/topic-tools.ts, reused by entity-tools.ts), so matching on that - instead of a
// hand-typed cron substring - can't silently pick up an unrelated leftover automation.
//
// A hand-built 'visual' automation may intentionally share its name with what these tests
// themselves create (to compare the two side by side), so a name match alone is ambiguous
// once both exist. Always prefer the 'script'-mode match - what create_automation/
// create_automation_script actually produce - over a same-named visual twin: both when
// looking for a stale script leftover to clean up before the test runs, and when looking for
// what the agent just created afterward. Falls back to any match (e.g. a visual-only name
// collision, where there's no script automation to prefer) so callers can still tell "nothing
// with this name at all" apart from "only a visual one".
//
// The model occasionally invents its own explicit 'name' for create_automation_script even
// when the request never asked for one (observed non-deterministically, e.g. with cohere -
// storeAutomation then stores it under that invented name instead of the raw message, so no
// exact match exists at all). Rather than fail outright on that, fall back to the most
// recently created mode:'script' automation (by its createdAt) - but only if it was created
// within the last RECENT_AUTOMATION_WINDOW_MS, so this can't accidentally pick up an unrelated script automation left over from an earlier test/run.
const RECENT_AUTOMATION_WINDOW_MS = 30000

// allowRecentFallback must stay false for every pre-chat "is there a stale leftover to delete"
// lookup and for the "no automation should exist at all" assertions - the fallback would
// otherwise risk matching a DIFFERENT test's automation created moments earlier in the same
// suite run. Only pass true for a post-chat "what did the agent just create" lookup.
function findScheduled(message: string, automations: any[], allowRecentFallback = false): any {
    const name = message.trim().toLowerCase()
    const matches = automations.filter((a: any) => typeof a.name === 'string' && a.name.trim().toLowerCase() === name)
    const exact = matches.find((a: any) => a.mode === 'script') ?? matches[0]
    if (exact || !allowRecentFallback) return exact

    const now = Date.now()
    const recentScripts = automations
        .filter((a: any) => a.mode === 'script' && typeof a.createdAt === 'string')
        .map((a: any) => ({ automation: a, createdAt: new Date(a.createdAt).getTime() }))
        .filter(({ createdAt }) => now - createdAt <= RECENT_AUTOMATION_WINDOW_MS)
        .sort((a, b) => b.createdAt - a.createdAt)
    return recentScripts[0]?.automation
}

// agent.ts documents a 5-field cron format (no leading seconds field), but the model
// sometimes adds one and produces an equally valid 6-field expression instead - cron-parser
// (behind Cron.next()/isScheduled() on the server) accepts both. Parse positionally by field
// count rather than asserting one specific literal string, which would only match one model's
// habit and not the other's.
function parseCron(cron: string): { minute: string, hour: string, day: string, month: string, weekday: string } {
    const fields = cron.trim().split(/\s+/)
    const [minute, hour, day, month, weekday] = fields.length === 6 ? fields.slice(1) : fields
    return { minute, hour, day, month, weekday }
}

// "every workday" can be expressed several equally valid ways ('1-5', 'MON-FRI', '1,2,3,4,5'),
// so checking the weekday field's raw text would only match one of the model's habits -
// instead, actually simulate the schedule (same cron-parser the server's own util/Cron.ts
// uses, just a newer major version here) and confirm every occurrence over two weeks lands on
// a weekday (1-5; JS Date.getDay(), 0=Sunday/6=Saturday) and never a weekend.
function cronWeekdaysOnly(cron: string): boolean {
    const interval = CronExpressionParser.parse(cron, { currentDate: new Date('2026-01-05T00:00:00Z') })
    for (let i = 0; i < 10; i++) {
        const day = interval.next().getDay()
        if (day === 0 || day === 6) return false
    }
    return true
}

// No mock-spacetime support for entities/properties (unlike topic-tools.test.ts's mock state
// system) - this talks to the real spacetime server directly, same as the tool itself does.
async function findProperty(entity: string, property: string): Promise<{ id: string }> {
    const entities: any[] = await fetch(`${SERVER_URL}/entities/?name=${encodeURIComponent(entity)}`).then(r => r.json())
    const found = entities.find(t => t.name.toLowerCase() === entity.toLowerCase())
    if (!found) throw new Error(`Entity not found: ${entity}`)
    const properties: any[] = await fetch(`${SERVER_URL}/properties/?entityId=${found.id}`).then(r => r.json())
    const property_ = properties.find(p => p.name === property)
    if (!property_) throw new Error(`Property not found: ${entity}.${property}`)
    return property_
}

async function getPropertyValue(entity: string, property: string): Promise<any> {
    const { id } = await findProperty(entity, property)
    const state: any = await fetch(`${SERVER_URL}/properties/${id}/state`).then(r => r.json())
    return state?.value
}

async function setPropertyValue(entity: string, property: string, value: unknown): Promise<void> {
    const { id } = await findProperty(entity, property)
    await fetch(`${SERVER_URL}/properties/${id}/value`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
    })
}

// An automation's script runs inside the long-running main server process (SERVER_URL), not
// this test process. Fetching the server's own `new Date().toISOString()` (rather than trusting
// this process's Date) used to matter a lot more when property values were bare local "HH:MM"
// strings needing local-timezone interpretation - the two processes genuinely disagreed about
// what hour "now" was in, in practice. Now that date/time properties (e.g. Weather.sunset) hold
// real timestamps, an ISO string with its UTC offset names one unambiguous instant no matter
// which process's local timezone reads it back - but asking the server for its own "now" still
// means this stays correct even if the two processes' clocks themselves ever drift apart.
async function getServerNow(): Promise<string> {
    const res = await fetch(`${SERVER_URL}/engine/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: 'new Date().toISOString()' }),
    })
    const { value, error } = await res.json() as any
    if (error) throw new Error(error)
    return value
}

async function findEntity(name: string): Promise<any | null> {
    const entities: any[] = await fetch(`${SERVER_URL}/entities/?name=${encodeURIComponent(name)}`).then(r => r.json())
    return entities.find(t => t.name.toLowerCase() === name.toLowerCase()) ?? null
}

describe('Use cases', () => {
    // Shared with 'turn it off' below, same as topic-tools.test.ts's session-reuse tests -
    // carries the sessionId across so the LLM has the conversational context to resolve
    // "it" to the garden pump, without either test having to name it explicitly.
    let sessionId: string | undefined

    benchmarked('turns on the garden pump', async () => {
        await setPropertyValue('Garden pump', 'state', 'off')

        const res = await timedChat({ message: `Turn on the garden pump` })
        expect(res.status).toBe(200)
        const data: any = await res.json()
        expect(data.status).toBe('ok')
        console.log(data.data.message)
        sessionId = data.data.sessionId
        expect(await getPropertyValue('Garden pump', 'state')).toBe('on')
    }, 120000)

    benchmarked('turn on garden pump if not raining and garden moisture 30% or less', async () => {
        // An AND of two comparisons on a single action fits create_automation's structured
        // conditions - no "otherwise", no OR - so this should route there, not to
        // create_automation_script. No time of day at all means starting now (scheduling
        // 'once'), same convention as the duration test above.
        const message = 'Turn on garden pump if not raining and garden moisture 30% or less'

        const existingAutomations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const existing = findScheduled(message, existingAutomations)
        if (existing && existing.mode === 'script') await fetch(`${SERVER_URL}/automations/${existing.id}`, { method: 'DELETE' })

        const res = await timedChat({ message })
        expect(res.status).toBe(200)
        const data: any = await res.json()
        expect(data.status).toBe('ok')
        console.log(data.data.message)

        const automations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const scheduled = findScheduled(message, automations, true)
        console.log('Scheduled automation:', scheduled)
        expect(scheduled).toBeDefined()
        expect(scheduled.mode).toBe('script')
        // Unlike the duration test above, this isn't a one-shot action with no time of day -
        // it's an ongoing conditional rule with no temporal cue at all ("if X and Y", no
        // "now"/duration/every-X-minutes), so both 'once' and 'recurring' (poll periodically)
        // are defensible; not asserting a specific value here.

        // "not raining" has some interpretive freedom in the exact operator/threshold the LLM
        // picks (rain == 0 vs <= 0, etc.), so this verifies behavior across scenarios (PUT
        // /:id/test, same as the freeform-script tests) rather than asserting exact script
        // text. Garden's 'moisture' is a derived property (-> Moisture sensor.moisture, added
        // in scripts/Entity.ts) - setting the SENSOR's value is what has to move the needle
        // here, exercising that the condition resolves through the derived link correctly.
        await setPropertyValue('Garden pump', 'state', 'off')
        await setPropertyValue('Weather', 'rain', 0)
        await setPropertyValue('Garden sensor', 'moisture', 20)
        let testRes = await fetch(`${SERVER_URL}/automations/${scheduled.id}/test`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(testRes.status).toBe(200)
        let testResult: any = await testRes.json()
        console.log('Test run (not raining, low moisture):', testResult)
        expect(testResult.error).toBeFalsy()
        expect(await getPropertyValue('Garden pump', 'state')).toBe('on')

        // Raining - condition should not apply even though moisture is still low.
        await setPropertyValue('Garden pump', 'state', 'off')
        await setPropertyValue('Weather', 'rain', 5)
        testRes = await fetch(`${SERVER_URL}/automations/${scheduled.id}/test`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(testRes.status).toBe(200)
        testResult = await testRes.json()
        console.log('Test run (raining, low moisture):', testResult)
        expect(testResult.error).toBeFalsy()
        expect(await getPropertyValue('Garden pump', 'state')).toBe('off')

        // Not raining, but moisture above the threshold - condition should not apply either.
        await setPropertyValue('Garden pump', 'state', 'off')
        await setPropertyValue('Weather', 'rain', 0)
        await setPropertyValue('Garden sensor', 'moisture', 50)
        testRes = await fetch(`${SERVER_URL}/automations/${scheduled.id}/test`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(testRes.status).toBe(200)
        testResult = await testRes.json()
        console.log('Test run (not raining, high moisture):', testResult)
        expect(testResult.error).toBeFalsy()
        expect(await getPropertyValue('Garden pump', 'state')).toBe('off')
    }, 120000)

    benchmarked('sets the garden lamp color to red at sunset every day', async () => {
        // "at sunset" isn't a literal clock time - it's Weather's own 'sunset' property (added
        // in scripts/Entity.ts), and it genuinely changes day to day in reality. Baking today's
        // value into a single fixed cron tick would silently go stale the moment it differs, so
        // this must instead compile to a periodic cron plus a real current-time-vs-Weather.sunset
        // comparison re-evaluated every time it runs - create_automation's own conditions[]
        // (entity: 'Weather', property: 'sunset', operator: '<=', value: 'now'), not a hand-
        // written create_automation_script, since this is a single AND-only comparison (see
        // create_automation's own description). Proven two ways below: the cron recurs
        // frequently rather than once a day, and the automation actually only fires its action
        // when sunset is close to "now" - not merely because the schedule happened to tick.
        const message = 'Set the color of the garden lamp to red at sunset every day'

        const existingAutomations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const existing = findScheduled(message, existingAutomations)
        if (existing && existing.mode === 'script') await fetch(`${SERVER_URL}/automations/${existing.id}`, { method: 'DELETE' })

        const res = await timedChat({ message })
        expect(res.status).toBe(200)
        const data: any = await res.json()
        expect(data.status).toBe('ok')
        console.log(data.data.message)

        const automations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const scheduled = findScheduled(message, automations, true)
        console.log('Scheduled automation:', scheduled)
        expect(scheduled).toBeDefined()
        expect(scheduled.mode).toBe('script')
        expect(scheduled.scheduling).toBe('recurring')

        // create_automation's conditions[].value: 'now' always compiles to exactly this
        // new Date(...) wrapping (see createAutomationTool's execute in entity-tools.ts) - a
        // hand-written create_automation_script wouldn't incidentally reproduce this precise
        // structure, so this confirms the structured-condition path was actually used rather
        // than a freeform script.
        expect(scheduled.script.toLowerCase()).toContain("new date(await entity.get('weather', 'sunset'))")
        expect(scheduled.script.toLowerCase()).toContain('new date())')

        // A periodic cron (every <=15 minutes), not a once-a-day tick resolved from today's
        // sunset value - checked by simulating two consecutive occurrences rather than parsing
        // the cron fields directly, since the model is free to pick any interval that recurs
        // often enough to re-check the condition in good time.
        const interval = CronExpressionParser.parse(scheduled.cron, { currentDate: new Date() })
        const firstOccurrence = interval.next().toDate()
        const secondOccurrence = interval.next().toDate()
        const minutesBetweenOccurrences = (secondOccurrence.getTime() - firstOccurrence.getTime()) / 60000
        expect(minutesBetweenOccurrences).toBeLessThanOrEqual(15)

        const originalSunset = await getPropertyValue('Weather', 'sunset')

        // Not sunset right now: a real timestamp a year from now - sunset/sunrise are now real
        // Date values (not a bare "HH:MM" resolved against today), so any timestamp genuinely in
        // the future unambiguously means "not yet", with none of the same-calendar-day
        // wraparound a clock-only value would risk. The script's own current-time-vs-sunset
        // check should hold the action back even though the schedule just fired - proves the
        // condition is real, not decorative.
        const farFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        await setPropertyValue('Weather', 'sunset', farFromNow)
        await setPropertyValue('Garden lamp', 'color', [50, 255, 255])
        let testRes = await fetch(`${SERVER_URL}/automations/${scheduled.id}/test`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(testRes.status).toBe(200)
        let testResult: any = await testRes.json()
        console.log('Test run (sunset far from now):', testResult)
        expect(testResult.error).toBeFalsy()
        expect(await getPropertyValue('Garden lamp', 'color')).toEqual([50, 255, 255])

        // Sunset right now: the same automation, unchanged, should fire this time.
        await setPropertyValue('Weather', 'sunset', await getServerNow())
        testRes = await fetch(`${SERVER_URL}/automations/${scheduled.id}/test`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(testRes.status).toBe(200)
        testResult = await testRes.json()
        console.log('Test run (sunset now):', testResult)
        expect(testResult.error).toBeFalsy()
        // Red in the HSV convention (agent.ts's ENTITY_PROMPTS color examples): hue 0.
        expect(await getPropertyValue('Garden lamp', 'color')).toEqual([0, 255, 255])

        await setPropertyValue('Weather', 'sunset', originalSunset)
    }, 120000)

    benchmarked('turns off the office lamp today at 17:00', async () => {
        const message = 'Turn off the office lamp today at 17:00'

        const existingAutomations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const existing = findScheduled(message, existingAutomations)
        if (existing && existing.mode === 'script') await fetch(`${SERVER_URL}/automations/${existing.id}`, { method: 'DELETE' })

        const res = await timedChat({ message })
        expect(res.status).toBe(200)
        const data: any = await res.json()
        expect(data.status).toBe('ok')
        console.log(data.data.message)

        const automations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const scheduled = findScheduled(message, automations, true)
        console.log('Scheduled automation:', scheduled)
        expect(scheduled).toBeDefined()
        expect(scheduled.mode).toBe('script')
        // "today" EXPLICITLY names a specific occurrence - fires once, never again.
        expect(scheduled.scheduling).toBe('once')
        // Only the time matters here - "today" may be encoded as a wildcarded daily pattern
        // (relying on 'scheduling: once' to stop it firing again) or as the literal calendar
        // date, and both are valid, so day/month/weekday aren't asserted.
        const cron = parseCron(scheduled.cron)
        expect(cron.minute).toBe('0')
        expect(cron.hour).toBe('17')

        // Functional check too, same as the other automation tests - run it and confirm the
        // actual effect, not just the generated script's text.
        await setPropertyValue('Office lamp', 'state', 'on')
        const testRes = await fetch(`${SERVER_URL}/automations/${scheduled.id}/test`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(testRes.status).toBe(200)
        const testResult: any = await testRes.json()
        console.log('Test run:', testResult)
        expect(testResult.error).toBeFalsy()
        expect(await getPropertyValue('Office lamp', 'state')).toBe('off')
    }, 120000)

    benchmarked('turns on the office lamp every work day at 08:00', async () => {
        const message = 'Turn on the office lamp every work day at 08:00'

        const existingAutomations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const existing = findScheduled(message, existingAutomations)
        if (existing && existing.mode === 'script') await fetch(`${SERVER_URL}/automations/${existing.id}`, { method: 'DELETE' })

        const res = await timedChat({ message })
        expect(res.status).toBe(200)
        const data: any = await res.json()
        expect(data.status).toBe('ok')
        console.log(data.data.message)

        const automations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const scheduled = findScheduled(message, automations, true)
        console.log('Scheduled automation:', scheduled)
        expect(scheduled).toBeDefined()
        expect(scheduled.mode).toBe('script')
        // "every work day" implies repetition - recurring, not a single occurrence.
        expect(scheduled.scheduling).toBe('recurring')
        const cron = parseCron(scheduled.cron)
        expect(cron.minute).toBe('0')
        expect(cron.hour).toBe('8')
        expect(cronWeekdaysOnly(scheduled.cron)).toBe(true)

        // Functional check too, same as the other automation tests - run it and confirm the
        // actual effect, not just the generated script's text.
        await setPropertyValue('Office lamp', 'state', 'off')
        const testRes = await fetch(`${SERVER_URL}/automations/${scheduled.id}/test`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(testRes.status).toBe(200)
        const testResult: any = await testRes.json()
        console.log('Test run:', testResult)
        expect(testResult.error).toBeFalsy()
        expect(await getPropertyValue('Office lamp', 'state')).toBe('on')
    }, 120000)

    benchmarked('turns on bathroom lamp for 2 minutes if motion is detected', async () => {
        // Combines a condition ('if motion is detected') with a duration ('for 2 minutes') -
        // conditions with no time/repetition cue read as an ongoing rule to keep checking
        // (same as the 'not raining' test above), so this should be 'recurring', with the
        // condition wrapping the capture/set/sleep/restore sequence duration produces.
        const message = 'Turn on bathroom lamp for 2 minutes if motion is detected'

        const existingAutomations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const existing = findScheduled(message, existingAutomations)
        if (existing && existing.mode === 'script') await fetch(`${SERVER_URL}/automations/${existing.id}`, { method: 'DELETE' })

        const res = await timedChat({ message })
        expect(res.status).toBe(200)
        const data: any = await res.json()
        expect(data.status).toBe('ok')
        console.log(data.data.message)

        const automations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const scheduled = findScheduled(message, automations, true)
        console.log('Scheduled automation:', scheduled)
        expect(scheduled).toBeDefined()
        expect(scheduled.mode).toBe('script')
        expect(scheduled.scheduling).toBe('recurring')

        // The condition's exact comparison ('motion' == 'on' vs some other representation) has
        // some interpretive freedom, and the script's 2-minute Time.sleep() makes actually
        // running it via /test impractical (that would block this test for the full duration) -
        // so this checks the script's structure instead of its exact text or real execution,
        // the same reasoning the 30-minute duration test (entity-tools.test.ts) applies for not
        // running its own sleep-based script.
        const script = scheduled.script.toLowerCase()
        expect(script).toMatch(/if\s*\(.*motion.*\)\s*\{/)
        expect(script).toContain("const prev0 = await entity.get('bathroom lamp', 'state');")
        expect(script).toContain("await entity.set('bathroom lamp', 'state', 'on');")
        expect(script).toContain('await time.sleep(120000);')
        expect(script).toContain("await entity.set('bathroom lamp', 'state', prev0);")
    }, 120000)

    benchmarked('turns off office lamp if no motion is detected for 15 minutes', async () => {
        // "for 15 minutes" here means the CONDITION itself must have held continuously that
        // long - a fundamentally different thing from create_automation's top-level 'duration'
        // (how long the ACTION's new value persists afterward, tested above) and from the cron
        // interval (how often to check). create_automation's structured conditions support this
        // directly via each condition's own 'durationSeconds' (compiled to Entity.heldFor()
        // under the hood) - this should NOT need create_automation_script, and must not use a
        // 15-minute cron with an instant check instead (which would misfire on the very first
        // no-motion reading rather than waiting out the full 15 minutes).
        const message = 'Turn off office lamp if no motion is detected for 15 minutes'

        const existingAutomations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const existing = findScheduled(message, existingAutomations)
        if (existing && existing.mode === 'script') await fetch(`${SERVER_URL}/automations/${existing.id}`, { method: 'DELETE' })

        const res = await timedChat({ message })
        expect(res.status).toBe(200)
        const data: any = await res.json()
        expect(data.status).toBe('ok')
        console.log(data.data.message)

        const automations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const scheduled = findScheduled(message, automations, true)
        console.log('Scheduled automation:', scheduled)
        expect(scheduled).toBeDefined()
        expect(scheduled.mode).toBe('script')
        expect(scheduled.scheduling).toBe('recurring')

        // Loose sanity check that it used the right mechanism at all (PropertyService.heldFor
        // always returns false unless the EARLIEST logged entry is already >= durationSeconds
        // old, with no API to backdate log entries - so there's no way to make it return true
        // without actually waiting out 900 real seconds).
        expect(scheduled.script.toLowerCase()).toContain('heldfor')
        expect(scheduled.script).toContain('900')

        // heldFor returns false only if there's a recent log entry that FAILS the condition -
        // writing 'on' right now (motion just detected) guarantees exactly that, regardless of
        // how long the demo server has been running (motion's very first seeded value never
        // changing could otherwise make heldFor true by now, since its own earliest log entry
        // would already be old enough on its own). With that guaranteed, the correct automation
        // is a no-op when run immediately - exploit that to verify real execution without
        // waiting out 900 seconds. This matters: a first live run passed naive text checks
        // (heldFor/900/set-to-'off' all textually present) despite being genuinely backwards -
        // it unconditionally set the lamp to 'off' first, then conditionally set it back to
        // 'on' when heldFor was true. Running it for real and checking state is UNCHANGED
        // catches that inverted logic directly, and is robust to stylistic variation (a local
        // variable vs the literal entity name) that made tighter text-matching both miss the
        // bug and reject correct code.
        await setPropertyValue('Office motion sensor', 'motion', 'on')
        await setPropertyValue('Office lamp', 'state', 'on')
        const testRes = await fetch(`${SERVER_URL}/automations/${scheduled.id}/test`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(testRes.status).toBe(200)
        const testResult: any = await testRes.json()
        console.log('Test run (heldFor should be false - no 15-minute-old history yet):', testResult)
        expect(testResult.error).toBeFalsy()
        expect(await getPropertyValue('Office lamp', 'state')).toBe('on')
    }, 120000)

    benchmarked('turns off all pumps', async () => {
        // No time/recurrence wording at all ("every", "at <time>", "if") - an immediate
        // action on a group, not a scheduling request, so this should go through
        // set_property_by_filter directly rather than create_automation. "pump" names a
        // CATEGORY with no other qualifier (unlike "all devices in the garden", which
        // filters by location) - the category lives on each entity's 'type' property
        // (type: 'pump'), not its own name and not some other property to guess at.
        // Two pump entities exist (Garden pump, Basement pump - scripts/Entity.ts) so this
        // genuinely exercises matching more than one, not just a single coincidental match.
        await setPropertyValue('Garden pump', 'state', 'on')
        await setPropertyValue('Basement pump', 'state', 'on')

        const res = await timedChat({ message: 'Turn off all pumps' })
        expect(res.status).toBe(200)
        const data: any = await res.json()
        expect(data.status).toBe('ok')
        console.log(data.data.message)

        expect(await getPropertyValue('Garden pump', 'state')).toBe('off')
        expect(await getPropertyValue('Basement pump', 'state')).toBe('off')

        // Applied immediately, not scheduled - no automation should have been created for it.
        const automations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        expect(findScheduled('Turn off all pumps', automations)).toBeUndefined()
    }, 120000)

    benchmarked('turns off all lamps in the office building, including the garden', async () => {
        // "Office building" contains Office/Basement/Bathroom/Garden (location relations -
        // scripts/Entity.ts), which in turn contain the actual lamps - so this only works if
        // 'location' filtering resolves transitively (EntityService.findByProperties), not
        // just entities located DIRECTLY in the office building (none of which are lamps).
        // No time/recurrence wording - an immediate action, not a scheduling request.
        await setPropertyValue('Office lamp', 'state', 'on')
        await setPropertyValue('Garden lamp', 'state', 'on')
        await setPropertyValue('Bathroom lamp', 'state', 'on')

        const res = await timedChat({ message: 'Turn off all lamps in the office building' })
        expect(res.status).toBe(200)
        const data: any = await res.json()
        expect(data.status).toBe('ok')
        console.log(data.data.message)

        expect(await getPropertyValue('Office lamp', 'state')).toBe('off')
        expect(await getPropertyValue('Garden lamp', 'state')).toBe('off')
        expect(await getPropertyValue('Bathroom lamp', 'state')).toBe('off')
    }, 120000)

    benchmarked('turns off all lamps, except garden lamp when dark', async () => {
        // Same underlying shape as the prior 'leave garden lamp on when dark' wording (one
        // unconditional action - turn off all lamps - with the garden lamp exempted, but ONLY
        // when dark; the exception itself doesn't apply when not dark, so garden lamp is turned
        // off too in that case) - rephrased as "except X when Y" to check the model parses this
        // alternate phrasing the same way rather than treating "except garden lamp" and "when
        // dark" as two independent, unrelated clauses (e.g. wrongly gating the WHOLE action on
        // darkness, which 'create_automation_script's description now has a worked right/wrong
        // example against).
        const message = 'Turn off all lamps now, except garden lamp when dark'

        const existingAutomations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const existing = findScheduled(message, existingAutomations)
        if (existing && existing.mode === 'script') await fetch(`${SERVER_URL}/automations/${existing.id}`, { method: 'DELETE' })

        const res = await timedChat({ message })
        expect(res.status).toBe(200)
        const data: any = await res.json()
        expect(data.status).toBe('ok')
        console.log(data.data.message)

        const automations = await fetch(`${SERVER_URL}/automations/`).then(r => r.json()) as any[]
        const scheduled = findScheduled(message, automations, true)
        console.log('Scheduled automation:', scheduled)
        expect(scheduled).toBeDefined()
        expect(scheduled.mode).toBe('script')
        console.log('Script:', scheduled.script)

        // Functional check too, same as the other automation tests - run it and confirm the
        // actual effect, not just the generated script's text. Weather's sunset/sunrise are now
        // real timestamps (not a bare "HH:MM" resolved against today - see getServerNow's
        // comment and the 'sets the garden lamp color to red at sunset' test above), so pushing
        // them far apart from "now" via real ISO timestamps - not clock-only strings - forces
        // each branch deterministically, the same trick the 'not raining' test uses for its own
        // property-driven condition.
        await setPropertyValue('Office lamp', 'state', 'on')
        await setPropertyValue('Garden lamp', 'state', 'on')
        await setPropertyValue('Bathroom lamp', 'state', 'on')

        const originalSunset = await getPropertyValue('Weather', 'sunset')
        const originalSunrise = await getPropertyValue('Weather', 'sunrise')
        const now = new Date(await getServerNow())
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()

        // Dark: sunset long past, sunrise not due until tomorrow - office/bathroom off
        // unconditionally either way, garden lamp left ON since the exception applies.
        await setPropertyValue('Weather', 'sunset', yesterday)
        await setPropertyValue('Weather', 'sunrise', tomorrow)
        let testRes = await fetch(`${SERVER_URL}/automations/${scheduled.id}/test`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(testRes.status).toBe(200)
        let testResult: any = await testRes.json()
        console.log('Test run (dark):', testResult)
        expect(testResult.error).toBeFalsy()
        expect(await getPropertyValue('Office lamp', 'state')).toBe('off')
        expect(await getPropertyValue('Bathroom lamp', 'state')).toBe('off')
        expect(await getPropertyValue('Garden lamp', 'state')).toBe('on')

        // Not dark: sunrise long past, sunset not due until much later - office/bathroom still
        // off unconditionally (turned back on here first), and the exception no longer applies,
        // so the garden lamp (also turned back on here) should get turned off too.
        await setPropertyValue('Office lamp', 'state', 'on')
        await setPropertyValue('Bathroom lamp', 'state', 'on')
        await setPropertyValue('Garden lamp', 'state', 'on')
        await setPropertyValue('Weather', 'sunrise', yesterday)
        await setPropertyValue('Weather', 'sunset', tomorrow)
        testRes = await fetch(`${SERVER_URL}/automations/${scheduled.id}/test`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(testRes.status).toBe(200)
        testResult = await testRes.json()
        console.log('Test run (not dark):', testResult)
        expect(testResult.error).toBeFalsy()
        expect(await getPropertyValue('Office lamp', 'state')).toBe('off')
        expect(await getPropertyValue('Bathroom lamp', 'state')).toBe('off')
        expect(await getPropertyValue('Garden lamp', 'state')).toBe('off')

        await setPropertyValue('Weather', 'sunset', originalSunset)
        await setPropertyValue('Weather', 'sunrise', originalSunrise)
    }, 180000)
})
