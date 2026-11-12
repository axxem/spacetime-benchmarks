// Keeps chat requests under RATE_LIMIT per minute, for LLM providers with an account-level
// rate limit that a fast sequence of tests would exceed. Not applied for a local Ollama model
// or OpenRouter. The request times are kept in a file, so the limit also holds across the
// back-to-back runs of npm run sweep.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { RATE_LIMIT, RESULTS_DIR } from './env.ts'

const STATE_FILE = `${RESULTS_DIR}/.rate-limit-state.json`

async function readTimes(): Promise<number[]> {
    try {
        return JSON.parse(await readFile(STATE_FILE, 'utf8'))
    } catch {
        return []
    }
}

export async function throttle(provider: string): Promise<void> {
    if (provider === 'ollama' || provider === 'openrouter') return
    const now = Date.now()
    let times = (await readTimes()).filter(t => t > now - 60000)
    if (times.length >= RATE_LIMIT) {
        await sleep(times[0]! + 60000 - now + 1)
        times = times.slice(1)
    }
    times.push(Date.now())
    await mkdir(RESULTS_DIR, { recursive: true })
    await writeFile(STATE_FILE, JSON.stringify(times))
}
