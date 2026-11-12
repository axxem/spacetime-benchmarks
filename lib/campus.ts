// The lamp benchmark's dataset: one campus of 10 buildings x 10 floors x 10 areas x 10 rooms,
// one lamp per room - 21,111 entities. Every entity has a 'name', 'reference' and 'type'
// property; everything below the campus a 'location' relation to its parent, so a filter on
// location: 'campus' matches all 10,000 lamps, 'building-C' 1,000, 'floor-C3' 100 and
// 'area-C3E' 10.
//
// Numbering is 0-based (Floor 0..9; a building/area letter maps to its digit, A=0 .. J=9), so
// 'Lamp 2345' is the lamp in Room 345 (Floor 3, Area E, room 5) of Building C, reference
// 'lamp-C3E5'. Each lamp's 'state' ('off') is linked to the 'Tuya mock' entity connector, and
// its 'id' (the device id the connector sends to the lamp service) is its reference.
import { randomUUID } from 'node:crypto'
import { api } from './api.ts'
import { MOCK_HOST, MOCK_PORT } from './env.ts'

export const CONNECTOR_NAME = 'Tuya mock'
export const LAMP_COUNT = 10_000
const LETTERS = 'ABCDEFGHIJ'
const COUNT = 10

type Property = { name: string, dataType: string, value?: unknown, connectorPropertyId?: string }
type BulkEntity = { id: string, properties: Property[] }

const entity = (name: string, type: string, path: string, parentId?: string, extra: Property[] = []): BulkEntity => ({
    id: randomUUID(),
    properties: [
        { name: 'name', dataType: 'string', value: name },
        { name: 'reference', dataType: 'string', value: path ? `${type}-${path}` : type },
        { name: 'type', dataType: 'string', value: type },
        ...(parentId ? [{ name: 'location', dataType: 'relation', value: parentId }] : []),
        ...extra,
    ],
})

// Parents come before their children, so the dataset can be sent in order, in chunks.
export function buildCampus(stateMappingId: string): BulkEntity[] {
    const campus = entity('Campus', 'campus', '')
    const entities = [campus]
    for (let b = 0; b < COUNT; b++) {
        const building = entity(`Building ${LETTERS[b]}`, 'building', LETTERS[b], campus.id)
        entities.push(building)
        for (let f = 0; f < COUNT; f++) {
            const floor = entity(`Floor ${f}`, 'floor', `${LETTERS[b]}${f}`, building.id)
            entities.push(floor)
            for (let a = 0; a < COUNT; a++) {
                const area = entity(`Area ${LETTERS[a]}`, 'area', `${LETTERS[b]}${f}${LETTERS[a]}`, floor.id)
                entities.push(area)
                for (let r = 0; r < COUNT; r++) {
                    const path = `${LETTERS[b]}${f}${LETTERS[a]}${r}`
                    const room = entity(`Room ${f}${a}${r}`, 'room', path, area.id)
                    entities.push(room)
                    entities.push(entity(`Lamp ${b}${f}${a}${r}`, 'lamp', path, room.id, [
                        { name: 'state', dataType: 'string', value: 'off', connectorPropertyId: stateMappingId },
                        { name: 'id', dataType: 'string', value: `lamp-${path}` },
                    ]))
                }
            }
        }
    }
    return entities
}

export const mockServiceUrl = () => `http://${MOCK_HOST}:${MOCK_PORT}`

// The 'Tuya mock' entity connector, created if missing, pointed at the mock lamp service, with
// maxConcurrency set when given ('' leaves the server's default). Returns it and its 'state'
// mapping (true/false on the device <-> 'on'/'off' in SpaceTime).
export async function ensureConnector(maxConcurrency = ''): Promise<{ connector: any, mapping: any }> {
    const configuration: any = { service: mockServiceUrl() }
    if (maxConcurrency !== '') configuration.maxConcurrency = Number(maxConcurrency)
    const existing = (await api<any[]>('GET', `/entityConnectors/?name=${encodeURIComponent(CONNECTOR_NAME)}`)).find(c => c.name === CONNECTOR_NAME)
    const connector = existing
        ? await api('PUT', `/entityConnectors/${existing.id}`, { configuration })
        : await api('POST', '/entityConnectors/', { name: CONNECTOR_NAME, type: 'service', configuration })
    let mapping = (await api<any[]>('GET', `/connectorProperties/?entityConnectorId=${connector.id}`)).find(m => m.internalName === 'state')
    if (!mapping) {
        mapping = await api('POST', '/connectorProperties/', {
            entityConnectorId: connector.id,
            internalName: 'state', internalValue: "switch_led ? 'on' : 'off'",
            externalName: 'switch_led', externalValue: "state === 'on'",
        })
    }
    return { connector, mapping }
}

// Deletes a previous campus: every 'Campus' entity and all that is located in it.
export async function deleteCampus(): Promise<number> {
    const ids = new Set<string>()
    for (const campus of await api<any[]>('GET', '/entities/?name=Campus')) {
        ids.add(campus.id)
        for (const child of await api<any[]>('GET', `/entities/${campus.id}/related-from-all?type=location`)) ids.add(child.id)
    }
    if (ids.size === 0) return 0
    return (await api('DELETE', '/entities/bulk', { ids: [...ids] })).deleted
}

export async function seedCampus(log = console.log) {
    const { mapping } = await ensureConnector()
    const deleted = await deleteCampus()
    if (deleted) log(`Deleted the previous campus (${deleted} entities)`)
    const entities = buildCampus(mapping.id)
    const chunk = 5000
    for (let i = 0; i < entities.length; i += chunk) {
        await api('POST', '/entities/bulk', { entities: entities.slice(i, i + chunk) })
        log(`Campus: ${Math.min(i + chunk, entities.length)} of ${entities.length} entities`)
    }
}
