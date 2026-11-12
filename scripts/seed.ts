// npm run seed [-- --demo | --campus]: loads the benchmarks' data into the running installation.
//   demo    the sample home/office (lamps, pumps, sensors, weather) the LLM use cases act on,
//           from the demo script shipped in the server image - resets those entities
//   campus  the 21,111 entities of the lamp benchmark (lib/campus.ts) - replaces a previous one
// Both by default. Safe to run again.
import { spawnSync } from 'node:child_process'
import { waitFor } from '../lib/api.ts'
import { ROOT, SERVER_URL } from '../lib/env.ts'
import { seedCampus } from '../lib/campus.ts'

const args = process.argv.slice(2)
const all = !args.includes('--demo') && !args.includes('--campus')

await waitFor(SERVER_URL + '/health')

if (all || args.includes('--demo')) {
    console.log('== Demo data')
    const result = spawnSync('docker', ['compose', 'exec', '-T', 'server', 'node', 'dist/src/scripts/Demo.js'], { cwd: ROOT, stdio: 'inherit' })
    if (result.status !== 0) {
        console.error(`Loading the demo data failed (exit ${result.status ?? result.error?.message}). Is SpaceTime running from this directory (docker compose ps)?`)
        process.exit(1)
    }
}

if (all || args.includes('--campus')) {
    console.log('== Campus')
    const start = performance.now()
    await seedCampus()
    console.log(`Campus seeded in ${((performance.now() - start) / 1000).toFixed(1)} s`)
}
