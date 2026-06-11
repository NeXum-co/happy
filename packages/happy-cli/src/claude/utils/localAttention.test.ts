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

    it('sets on notification_type permission_prompt even with a generic message', () => {
        expect(resolveLocalAttention({
            type: 'notification',
            message: 'Some new wording',
            notificationType: 'permission_prompt',
        })).toBe('set')
    })

    it('clears on idle notifications (idle-backstop, D-E02-13): waiting for input means no permission prompt is pending', () => {
        expect(resolveLocalAttention({
            type: 'notification',
            message: 'Claude is waiting for your input',
            notificationType: 'idle_prompt',
        })).toBe('clear')
    })

    it('clears on an idle message even without notification_type', () => {
        expect(resolveLocalAttention({
            type: 'notification',
            message: 'Claude is waiting for your input',
        })).toBe('clear')
    })

    it('ignores notifications without a message', () => {
        expect(resolveLocalAttention({ type: 'notification', message: undefined })).toBe('none')
    })

    it('ignores unrelated notification types', () => {
        expect(resolveLocalAttention({
            type: 'notification',
            message: 'Something else happened',
            notificationType: 'other',
        })).toBe('none')
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

    it('clears on PermissionDenied (deny/Esc in the TUI fires no other event)', () => {
        expect(resolveLocalAttention({ type: 'hook', eventName: 'PermissionDenied' })).toBe('clear')
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

    // Transcript-clear (D-E02-13): a conversation line written to the Claude
    // JSONL after the prompt was set means the turn moved on — the prompt is
    // no longer pending.
    it('clears on a user transcript line written after the prompt was set', () => {
        expect(resolveLocalAttention({
            type: 'transcript',
            lineType: 'user',
            timestampMs: 2_000,
            isSidechain: false,
            requestCreatedAt: 1_000,
        })).toBe('clear')
    })

    it('clears on an assistant transcript line written after the prompt was set', () => {
        expect(resolveLocalAttention({
            type: 'transcript',
            lineType: 'assistant',
            timestampMs: 2_000,
            isSidechain: false,
            requestCreatedAt: 1_000,
        })).toBe('clear')
    })

    it('does not clear on the assistant tool_use line that belongs to the prompt itself (written before the Notification)', () => {
        expect(resolveLocalAttention({
            type: 'transcript',
            lineType: 'assistant',
            timestampMs: 500,
            isSidechain: false,
            requestCreatedAt: 1_000,
        })).toBe('none')
    })

    it('does not clear on sidechain (subagent) transcript lines', () => {
        expect(resolveLocalAttention({
            type: 'transcript',
            lineType: 'user',
            timestampMs: 2_000,
            isSidechain: true,
            requestCreatedAt: 1_000,
        })).toBe('none')
    })

    it('does not clear on transcript lines without a timestamp (summary etc.)', () => {
        expect(resolveLocalAttention({
            type: 'transcript',
            lineType: 'summary',
            timestampMs: null,
            isSidechain: false,
            requestCreatedAt: 1_000,
        })).toBe('none')
    })

    it('does not clear on non-conversation transcript lines (system) even when recent', () => {
        expect(resolveLocalAttention({
            type: 'transcript',
            lineType: 'system',
            timestampMs: 2_000,
            isSidechain: false,
            requestCreatedAt: 1_000,
        })).toBe('none')
    })
})
