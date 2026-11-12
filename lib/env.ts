// Settings for the tests, from .env in the repository root (the same file docker compose
// reads), overridden by the environment.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
const envFile = ROOT + '.env'
if (existsSync(envFile)) process.loadEnvFile(envFile)

const setting = (name: string, fallback: string) => process.env[name] || fallback

export const SERVER_URL = setting('SERVER_URL', 'http://localhost:8010')
export const AGENT_URL = setting('AGENT_URL', 'http://localhost:8030')
export const RESULTS_DIR = setting('RESULTS_DIR', ROOT + 'results/local')
export const RATE_LIMIT = parseInt(setting('RATE_LIMIT', '15'))
export const MOCK_PORT = parseInt(setting('MOCK_PORT', '8099'))
export const MOCK_HOST = setting('MOCK_HOST', 'host.docker.internal')
export const MOCK_LATENCY_MS = parseInt(setting('MOCK_LATENCY_MS', '2000'))
// Empty: the server's default; 0: no cap.
export const LAMP_MAX_CONCURRENCY = process.env.LAMP_MAX_CONCURRENCY ?? ''
