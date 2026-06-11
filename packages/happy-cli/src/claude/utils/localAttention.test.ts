/**
 * Unit tests for the local-mode attention decision logic (E02 fase G, AC-6).
 *
 * Pure function: decides which Claude Code hook events set the
 * agentState.localRequest signal and which events clear it.
 */
import { describe, expect, it } from 'vitest'

import { resolveLocalAttention } from './localAttention'

describe('resolveLocalAttention', () => {
    it('sets on a Notification whose message indicates a permission prompt', () => {
        expect(resolveLocalAttention({
            type: 'notification',
            message: 'Claude needs your permission to use Bash',
        })).toBe('set')
    })

    it('matches "permission" case-insensitively', () => {
        expect(resolveLocalAttention({
            type: 'notification',
            message: 'PERMISSION required for tool Write',
        })).toBe('set')
    })

    it('ignores idle notifications (waiting for input is not needs-you)', () => {
        expect(resolveLocalAttention({
            type: 'notification',
            message: 'Claude is waiting for your input',
        })).toBe('none')
    })

    it('ignores notifications without a message', () => {
        expect(resolveLocalAttention({ type: 'notification', message: undefined })).toBe('none')
    })

    it('clears on PostToolUse (tool ran, so the prompt was approved)', () => {
        expect(resolveLocalAttention({ type: 'hook', eventName: 'PostToolUse' })).toBe('clear')
    })

    it('clears on UserPromptSubmit', () => {
        expect(resolveLocalAttention({ type: 'hook', eventName: 'UserPromptSubmit' })).toBe('clear')
    })

    it('clears on Stop', () => {
        expect(resolveLocalAttention({ type: 'hook', eventName: 'Stop' })).toBe('clear')
    })

    it('clears when thinking flips to true (covers the deny path)', () => {
        expect(resolveLocalAttention({ type: 'thinking', thinking: true })).toBe('clear')
    })

    it('does nothing when thinking flips to false', () => {
        expect(resolveLocalAttention({ type: 'thinking', thinking: false })).toBe('none')
    })

    it('does nothing for unrelated hook events', () => {
        expect(resolveLocalAttention({ type: 'hook', eventName: 'SessionStart' })).toBe('none')
        expect(resolveLocalAttention({ type: 'hook', eventName: 'PreToolUse' })).toBe('none')
    })
})
