// Lamp benchmark: switches on 10, 100, 1,000 and 10,000 lamps of the campus (npm run seed -- --campus) from
// an automation, through an entity connector, and measures how long it takes until every lamp is
// on. Every lamp's 'state' is linked to the 'Tuya mock' entity connector, so each change becomes a
// command the server sends to the lamp service - here a mock (lib/mock-tuya.ts) on this machine
// that answers after MOCK_LATENCY_MS (2 s), like a cloud API.
//
// Each size runs two ways:
//   loop     the script loops over Entity.filter()'s result and calls Entity.set() per lamp
//   setMany  one Entity.setMany() call with the filter
// Measured from submitting the automation: when the automation finished (it only queues the
// commands), when the lamp service sent its last response, and when the server had recorded
// every command as applied (polled every 100 ms).
//
// Results: results/local/lamps.jsonl, and a table at the end.
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { api, waitFor } from '../lib/api.ts'
import { CONNECTOR_NAME, LAMP_COUNT, ensureConnector } from '../lib/campus.ts'
import { LAMP_MAX_CONCURRENCY, MOCK_LATENCY_MS, MOCK_PORT, SERVER_URL } from '../lib/env.ts'
import { MockTuya } from '../lib/mock-tuya.ts'
import { appendResult, writeEnvironment } from '../lib/results.ts'

const mock = new MockTuya(MOCK_LATENCY_MS)
let connector: any

const counts = (): Promise<Record<string, number>> => api('GET', `/propertyCommands/counts?entityConnectorId=${connector.id}`)
const finished = (c: Record<string, number>) => (c.applied ?? 0) + (c.failed ?? 0)

// Waits until expected commands have finished (applied or failed); returns the counts.
async function waitForCommands(expected: number, timeoutMs = 10 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs
    let c: Record<string, number> = {}
    while (Date.now() < deadline) {
        c = await counts()
        if (finished(c) >= expected) return c
        await sleep(100)
    }
    throw new Error(`timed out waiting for ${expected} commands: ${JSON.stringify(c)}`)
}

// Every campus lamp 'off', at the mock and in SpaceTime, with no command history: a set that
// repeats a value requested in the last 180 s is skipped, so history from a previous case would
// turn the next one into a no-op.
async function resetLamps() {
    await api('DELETE', `/propertyCommands?entityConnectorId=${connector.id}`)
    mock.latencyMs = 0
    const { commands } = await api('POST', '/properties/set', { filter: { type: 'lamp', location: 'campus' }, property: 'state', value: 'off', requestedBy: 'benchmark reset' })
    await waitForCommands(commands)
    await api('DELETE', `/propertyCommands?entityConnectorId=${connector.id}`)
    mock.latencyMs = MOCK_LATENCY_MS
    mock.reset()
}

const cases = [
    { location: 'area-C3E', expected: 10 },
    { location: 'floor-C3', expected: 100 },
    { location: 'building-C', expected: 1000 },
    { location: 'campus', expected: 10000 },
]

const scripts: Record<string, (location: string) => string> = {
    loop: location => [
        `const lamps = await Entity.filter({ type: 'lamp', location: '${location}' })`,
        `for (const lamp of lamps) {`,
        `    await Entity.set(lamp.name, 'state', 'on')`,
        `}`,
        `print('Switched on ' + lamps.length + ' lamps in ${location}')`,
    ].join('\n'),
    setMany: location => [
        `const result = await Entity.setMany({ type: 'lamp', location: '${location}' }, 'state', 'on')`,
        `print('Switched on ' + result.commands + ' lamps in ${location}')`,
    ].join('\n'),
}

const results: { mode: string, lamps: number, scriptS: number, lastResponseS: number, allOnS: number, peak: number }[] = []

describe('Campus lamp switch', () => {
    before(async () => {
        await waitFor(SERVER_URL + '/health')
        await mock.start(MOCK_PORT)
        connector = (await ensureConnector(LAMP_MAX_CONCURRENCY)).connector
        const lamps: any[] = await api('POST', '/entities/find', { filter: { type: 'lamp', location: 'campus' } })
        assert.equal(lamps.length, LAMP_COUNT, `${LAMP_COUNT} campus lamps expected, found ${lamps.length} - run 'npm run seed -- --campus' first`)

        // Reachability of the mock from the server container, before timing anything.
        await api('DELETE', `/propertyCommands?entityConnectorId=${connector.id}`)
        mock.latencyMs = 0
        const probe = await api('POST', '/properties/set', { filter: { type: 'lamp', location: 'area-A0A' }, property: 'state', value: 'on', requestedBy: 'benchmark probe' })
        const probed = await waitForCommands(probe.commands, 60_000)
        assert.equal(probed.failed ?? 0, 0, `the server can't reach the mock lamp service at ${connector.configuration?.service} - see the README (firewall, MOCK_HOST)`)

        await writeEnvironment('lamps', { mockLatencyMs: MOCK_LATENCY_MS, maxConcurrency: LAMP_MAX_CONCURRENCY || 'server default', connector: CONNECTOR_NAME })
    })

    after(async () => {
        await mock.stop()
        const row = (r: typeof results[0]) => `| ${r.mode.padEnd(7)} | ${String(r.lamps).padStart(6)} | ${r.scriptS.toFixed(1).padStart(8)} s | ${r.lastResponseS.toFixed(1).padStart(11)} s | ${r.allOnS.toFixed(1).padStart(8)} s | ${String(r.peak).padStart(6)} |`
        console.log(['', '| Mode    |  Lamps |     Script | Last response |   All on |   Peak |', '|---------|--------|------------|---------------|----------|--------|', ...results.map(row), ''].join('\n'))
    })

    for (const mode of Object.keys(scripts)) {
        for (const { location, expected } of cases) {
            it(`switches on ${expected} lamps in ${location} (${mode})`, { timeout: 15 * 60 * 1000 }, async () => {
                await resetLamps()

                const name = `Campus lamp switch ${location} ${mode}`
                for (const old of (await api<any[]>('GET', '/automations/')).filter(a => a.name === name)) {
                    await api('DELETE', `/automations/${old.id}`)
                }
                const automation = await api('POST', '/automations/', { name, mode: 'script', script: scripts[mode](location) })

                const start = performance.now()
                const result: any = await api('PUT', `/automations/${automation.id}/run`, {})
                const scriptMs = performance.now() - start
                assert.ok(!result.error, result.error)

                const c = await waitForCommands(expected)
                const allOnMs = performance.now() - start
                const lastResponseMs = mock.lastResponse - start
                const entry = { mode, lamps: expected, scriptS: scriptMs / 1000, lastResponseS: lastResponseMs / 1000, allOnS: allOnMs / 1000, peak: mock.peak }
                results.push(entry)
                appendResult('lamps.jsonl', { ...entry, location, latencyMs: MOCK_LATENCY_MS, maxConcurrency: LAMP_MAX_CONCURRENCY || null, requests: mock.requests, commands: c })
                console.log(`${location} (${mode}): script ${entry.scriptS.toFixed(1)} s, last response ${entry.lastResponseS.toFixed(1)} s, all on ${entry.allOnS.toFixed(1)} s, peak ${mock.peak} concurrent, commands ${JSON.stringify(c)}`)

                assert.equal(result.log, `Switched on ${expected} lamps in ${location}`)
                assert.equal(c.applied, expected, `applied commands: ${JSON.stringify(c)}`)
                assert.equal(mock.requests, expected)
                const on = [...mock.devices.values()].filter(d => d.switch_led === true).length
                assert.equal(on, expected, 'lamps switched on at the lamp service')
                const lampsOn: any[] = await api('POST', '/entities/find', { filter: { type: 'lamp', location, state: 'on' } })
                assert.equal(lampsOn.length, expected, "lamps with state 'on' in SpaceTime")
            })
        }
    }
})
