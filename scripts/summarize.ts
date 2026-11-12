// npm run summarize [-- <results directory>...]: Markdown tables of the results in
// results/local (default) or the given directories, e.g. results/paper results/local to put
// the paper's results next to your own.
//   LLM:   per LLM and command, the pass rate over all runs and the median chat round trip
//   lamps: per mode and number of lamps, the median times over all runs
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { ROOT } from '../lib/env.ts'

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['results/local']

const readLines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const median = (values: number[]) => {
    if (values.length === 0) return NaN
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const fmt = (n: number, digits = 1) => Number.isNaN(n) ? '-' : n.toFixed(digits)

for (const dir of dirs) {
    const path = dir.startsWith('/') ? dir : ROOT + dir
    if (!existsSync(path)) {
        console.log(`\n${dir}: not found`)
        continue
    }
    console.log(`\n# ${dir}`)
    const files = readdirSync(path)

    for (const file of files.filter(f => f.startsWith('llm-') && f.endsWith('.jsonl')).sort()) {
        const rows = readLines(`${path}/${file}`)
        const llm = `${rows[0]?.llmProvider} ${rows[0]?.llmModel ?? ''}`.trim()
        const runs = new Set(rows.map(r => r.runId)).size
        console.log(`\n## LLM: ${llm} (${runs} runs)\n`)
        console.log('| Command | Passed | Pass rate | Median s |')
        console.log('|---|---:|---:|---:|')
        const byMessage = new Map<string, any[]>()
        for (const r of rows) byMessage.set(r.message, [...(byMessage.get(r.message) ?? []), r])
        let passed = 0
        for (const [message, results] of byMessage) {
            const pass = results.filter(r => r.status === 'pass').length
            passed += pass
            console.log(`| ${message || '(no chat request)'} | ${pass}/${results.length} | ${fmt(100 * pass / results.length, 0)}% | ${fmt(median(results.map(r => r.durationSeconds)))} |`)
        }
        console.log(`| **All** | ${passed}/${rows.length} | ${fmt(100 * passed / rows.length, 0)}% | ${fmt(median(rows.map(r => r.durationSeconds)))} |`)
    }

    if (files.includes('lamps.jsonl')) {
        const rows = readLines(`${path}/lamps.jsonl`)
        console.log(`\n## Lamps (${new Set(rows.map(r => r.runId)).size} runs, medians)\n`)
        console.log('| Mode | Lamps | Runs | Script s | Last response s | All on s | Peak |')
        console.log('|---|---:|---:|---:|---:|---:|---:|')
        const groups = new Map<string, any[]>()
        for (const r of rows) {
            const key = `${r.mode}|${r.lamps}|${r.maxConcurrency ?? 'default'}`
            groups.set(key, [...(groups.get(key) ?? []), r])
        }
        for (const [key, results] of [...groups].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
            const [mode, lamps, cap] = key.split('|')
            console.log(`| ${mode}${cap !== 'default' ? ` (cap ${cap})` : ''} | ${lamps} | ${results.length} | ${fmt(median(results.map(r => r.scriptS)))} | ${fmt(median(results.map(r => r.lastResponseS)))} | ${fmt(median(results.map(r => r.allOnS)))} | ${median(results.map(r => r.peak))} |`)
        }
    }
}
