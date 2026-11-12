// Stand-in for a cloud lamp API (the contract of the Tuya service SpaceTime's entity connectors
// talk to): PUT /<device id> with {switch_led: boolean} answers {success: true} after latencyMs;
// GET /<device id> returns the device's state. Runs on this machine; the SpaceTime server
// container reaches it as http://MOCK_HOST:MOCK_PORT. Counts requests and peak concurrency, and
// records when the first/last request arrived and the last response was sent.
import http from 'node:http'

export class MockTuya {
    server = http.createServer((req, res) => this.handle(req, res))
    latencyMs: number
    devices = new Map<string, { switch_led: boolean }>()
    requests = 0
    firstArrival = 0
    lastArrival = 0
    lastResponse = 0
    inFlight = 0
    peak = 0

    constructor(latencyMs: number) {
        this.latencyMs = latencyMs
    }

    // All interfaces, not only 127.0.0.1: on Linux the container reaches the host through the
    // Docker bridge. A large backlog, so thousands of connections opened at once are queued
    // instead of refused (the OS caps it too - macOS: sysctl kern.ipc.somaxconn).
    start = (port: number) => new Promise<void>((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen({ port, host: '0.0.0.0', backlog: 16384 }, () => resolve())
    })

    stop = () => new Promise(resolve => {
        this.server.closeAllConnections()
        this.server.close(resolve)
    })

    reset = () => {
        this.devices.clear()
        this.requests = this.peak = this.inFlight = 0
        this.firstArrival = this.lastArrival = this.lastResponse = 0
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse) {
        const id = decodeURIComponent((req.url ?? '/').substring(1))
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
            if (req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ object: id, ...(this.devices.get(id) ?? { switch_led: false }) }))
                return
            }
            this.requests++
            const now = performance.now()
            if (!this.firstArrival) this.firstArrival = now
            this.lastArrival = now
            this.inFlight++
            this.peak = Math.max(this.peak, this.inFlight)
            setTimeout(() => {
                this.inFlight--
                try {
                    this.devices.set(id, { ...this.devices.get(id), ...JSON.parse(body || '{}') })
                } catch { }
                this.lastResponse = performance.now()
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ success: true }))
            }, this.latencyMs)
        })
    }
}
