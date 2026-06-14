/**
 * Regression tests for SEC: the per-session hook secret must never travel as a
 * command argument (argv is readable via /proc/<pid>/cmdline and ps for any
 * same-user process). It must live only in a 0600 file whose path is passed.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { generateHookSecret, generateHookSettingsFile, cleanupHookSettingsFile } from './generateHookSettings'

function commandOf(filepath: string): string {
    const settings = JSON.parse(readFileSync(filepath, 'utf-8'))
    return settings.hooks.SessionStart[0].hooks[0].command
}

describe('generateHookSettingsFile secret handling', () => {
    it('keeps the secret out of the hook command and stores it in a 0600 file', () => {
        const secret = generateHookSecret()
        const filepath = generateHookSettingsFile(12345, secret)
        try {
            const command = commandOf(filepath)
            expect(command).not.toContain(secret)
            const match = command.match(/"([^"]*\.secret)"/)
            expect(match).toBeTruthy()
            const secretPath = match![1]
            expect(readFileSync(secretPath, 'utf-8')).toBe(secret)
            expect(statSync(secretPath).mode & 0o777).toBe(0o600)
        } finally {
            cleanupHookSettingsFile(filepath)
        }
    })

    it('cleanup removes the secret file', () => {
        const secret = generateHookSecret()
        const filepath = generateHookSettingsFile(12346, secret)
        const secretPath = commandOf(filepath).match(/"([^"]*\.secret)"/)![1]
        cleanupHookSettingsFile(filepath)
        expect(() => readFileSync(secretPath, 'utf-8')).toThrow()
    })
})
