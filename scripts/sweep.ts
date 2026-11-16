// npm run sweep: runs the LLM benchmark REPEAT times (default 5) in a row - LLM output varies,
// so a pass rate over several runs says more than one run. Every run appends to the same
// results/local/llm-<provider>[-<model>].jsonl.
//
// To compare LLMs in one go, list them in COMBOS as provider[:model], comma separated, e.g.
//   COMBOS="openrouter:google/gemini-2.5-flash,openrouter:openai/gpt-oss-120b" npm run sweep
// The agent container is restarted with each one (docker compose up -d agent), and is left
// running with the last; `docker compose up -d agent` brings back the one in .env. Each
// provider's API key must be in .env.
import { spawnSync } from 'node:child_process'
import { waitFor } from '../lib/api.ts'
import { AGENT_URL, ROOT } from '../lib/env.ts'

const repeat = parseInt(process.env.REPEAT ?? '5')
const combos = (process.env.COMBOS ?? '').split(',').map(c => c.trim()).filter(Boolean).map(c => {
    const [provider, ...model] = c.split(':')
    return { provider, model: model.join(':') }
})

const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
    spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env }).status

async function sweep(label: string) {
    for (let i = 1; i <= repeat; i++) {
        console.log(`\n=== ${label} (run ${i}/${repeat}) ===`)
        run(process.execPath, ['--test', '--test-concurrency=1', 'test/llm-usecases.test.ts'])
    }
}

if (combos.length === 0) {
    await sweep('LLM from .env')
} else {
    for (const { provider, model } of combos) {
        // The shell environment takes precedence over .env in docker compose.
        const status = run('docker', ['compose', 'up', '-d', 'agent'], { ...process.env, LLM_PROVIDER: provider, LLM_MODEL: model })
        if (status !== 0) throw new Error(`restarting the agent with ${provider} ${model} failed`)
        await waitFor(AGENT_URL + '/')
        await sweep(`${provider} ${model || '(default model)'}`)
    }
}
console.log('\nDone - npm run summarize shows the pass rates.')
