// The few expect() matchers the use case tests use, on node:assert - so the assertions read
// the same as in the test suite these were taken from.
import assert from 'node:assert/strict'

export function expect(actual: any) {
    return {
        toBe: (expected: any) => assert.equal(actual, expected),
        toEqual: (expected: any) => assert.deepEqual(actual, expected),
        toBeDefined: () => assert.notEqual(actual, undefined, 'expected a value, got undefined'),
        toBeUndefined: () => assert.equal(actual, undefined),
        toBeFalsy: () => assert.ok(!actual, `expected a falsy value, got ${JSON.stringify(actual)}`),
        toContain: (part: string) => assert.ok(actual?.includes(part), `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(part)}`),
        toMatch: (pattern: RegExp) => assert.match(actual, pattern),
        toBeLessThanOrEqual: (limit: number) => assert.ok(actual <= limit, `expected ${actual} <= ${limit}`),
    }
}
