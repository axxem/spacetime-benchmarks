// npm run seed -- --demo | --campus: loads the data of one benchmark into the running installation.
//   demo    the sample home/office (lamps, pumps, sensors, weather) the LLM use cases act on,
//           from the demo script shipped in the server image - resets those entities, and
//           deletes the campus
//   campus  the 21,111 entities of the lamp benchmark (lib/campus.ts) - replaces a previous one
// Not both: with the campus loaded, the LLM's lookups of "all lamps" return 10,006 lamps, which
// changes what the LLM use cases measure and makes them far more expensive. Safe to run again.
import { spawnSync } from 'node:child_process'
import { waitFor } from '../lib/api.ts'
import { ROOT, SERVER_URL } from '../lib/env.ts'
import { seedCampus, deleteCampus } from '../lib/campus.ts'

const args = process.argv.slice(2)
const demo = args.includes('--demo')
const campus = args.includes('--campus')
if (demo === campus) {
    console.error(`Usage: npm run seed -- --demo     before the LLM benchmark (npm run test:llm)
       npm run seed -- --campus   before the lamp benchmark (npm run test:lamps)
One at a time: the LLM use cases must run without the campus.`)
    process.exit(1)
}

await waitFor(SERVER_URL + '/health')

if (demo) {
    const deleted = await deleteCampus()
    if (deleted) console.log(`Deleted the campus (${deleted} entities)`)
    console.log('== Demo data')
    const result = spawnSync('docker', ['compose', 'exec', '-T', 'server', 'node', 'dist/src/scripts/Demo.js'], { cwd: ROOT, stdio: 'inherit' })
    if (result.status !== 0) {
        console.error(`Loading the demo data failed (exit ${result.status ?? result.error?.message}). Is SpaceTime running from this directory (docker compose ps)?`)
        process.exit(1)
    }
}

if (campus) {
    console.log('== Campus')
    const start = performance.now()
    await seedCampus()
    console.log(`Campus seeded in ${((performance.now() - start) / 1000).toFixed(1)} s`)
}
