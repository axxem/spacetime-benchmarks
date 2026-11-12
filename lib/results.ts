// Results go to RESULTS_DIR (results/local by default) as JSON Lines - one line per measured
// test, appended, so repeated runs accumulate and a crash never corrupts earlier lines. Every
// line carries a runId; environment-<runId>.json describes the machine and installation that run
// was measured on.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { AGENT_URL, RESULTS_DIR, ROOT } from './env.ts'

export const runId = new Date().toISOString().replace(/[:.]/g, '-')

export function appendResult(file: string, entry: Record<string, unknown>) {
    mkdirSync(RESULTS_DIR, { recursive: true })
    appendFileSync(`${RESULTS_DIR}/${file}`, JSON.stringify({ runId, timestamp: new Date().toISOString(), ...entry }) + '\n')
}

const run = (command: string, args: string[]) => {
    try {
        return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
        return null
    }
}

// The images of the running containers identify the exact SpaceTime build measured: by their
// registry digest (repository@sha256:...) when pulled from a registry, else the local image id.
function images(): Record<string, string> | null {
    const out = run('docker', ['compose', 'images', '--format', 'json'])
    if (!out) return null
    try {
        const rows: any[] = JSON.parse(out)
        return Object.fromEntries(rows.map(r => {
            const digests = run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', r.ID])
            const digest = digests ? (JSON.parse(digests) as string[])[0] : undefined
            return [r.Service ?? r.ContainerName, `${r.Repository}:${r.Tag} ${digest ?? r.ID}`]
        }))
    } catch {
        return null
    }
}

export async function agentInfo(): Promise<any> {
    try {
        return await (await fetch(AGENT_URL + '/')).json()
    } catch {
        return null
    }
}

export async function writeEnvironment(benchmark: string, extra: Record<string, unknown> = {}) {
    mkdirSync(RESULTS_DIR, { recursive: true })
    const environment = {
        runId,
        benchmark,
        node: process.version,
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        cpu: `${os.cpus()[0]?.model ?? 'unknown'} x ${os.availableParallelism()}`,
        memoryGB: Math.round(os.totalmem() / 2 ** 30),
        docker: run('docker', ['version', '--format', 'client {{.Client.Version}}, server {{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})']),
        dockerResources: run('docker', ['info', '--format', '{{.NCPU}} CPUs, {{.MemTotal}} bytes']),
        images: images(),
        ...extra,
    }
    writeFileSync(`${RESULTS_DIR}/environment-${runId}.json`, JSON.stringify(environment, null, 2) + '\n')
    return environment
}
