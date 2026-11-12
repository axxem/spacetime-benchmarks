// JSON over HTTP to the SpaceTime server.
import { setTimeout as sleep } from 'node:timers/promises'
import { SERVER_URL } from './env.ts'

export class ApiError extends Error {
    status: number
    constructor(method: string, path: string, status: number, body: string) {
        super(`${method} ${path}: ${status} ${body.slice(0, 500)}`)
        this.status = status
    }
}

// Sends body as JSON and returns the parsed response; throws ApiError on a non-2xx status.
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(SERVER_URL + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new ApiError(method, path, res.status, text)
    return (text ? JSON.parse(text) : undefined) as T
}

// Waits until url answers 2xx, for at most timeoutMs.
export async function waitFor(url: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url)
            if (res.ok) return
            last = `status ${res.status}`
        } catch (e: any) {
            last = e.cause?.code ?? e.message
        }
        await sleep(1000)
    }
    throw new Error(`${url} not reachable after ${timeoutMs / 1000} s (${last}) - is SpaceTime running? (docker compose up -d)`)
}

export const findEntity = async (name: string): Promise<any | null> => {
    const entities: any[] = await api('GET', `/entities/?name=${encodeURIComponent(name)}`)
    return entities.find(e => e.name?.toLowerCase() === name.toLowerCase()) ?? null
}
