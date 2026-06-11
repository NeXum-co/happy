/**
 * Local-mode attention decision logic (E02 fase G, AC-6).
 *
 * Terminal permission prompts live in Claude's TUI and never reach
 * agentState.requests. The Notification hook is the only signal that such a
 * prompt is pending; PostToolUse / UserPromptSubmit / Stop hooks and the
 * fd-3 thinking signal tell us the prompt was answered. This module is the
 * single pure decision point: which events set agentState.localRequest and
 * which events clear it. Wiring lives in runClaude.ts.
 */

export type LocalAttentionEvent =
    | { type: 'notification'; message: string | undefined }
    | { type: 'hook'; eventName: string }
    | { type: 'thinking'; thinking: boolean };

export type LocalAttentionAction = 'set' | 'clear' | 'none';

/** Hook events that mean the terminal prompt is no longer pending. */
const CLEARING_HOOK_EVENTS = new Set(['PostToolUse', 'UserPromptSubmit', 'Stop']);

export function resolveLocalAttention(event: LocalAttentionEvent): LocalAttentionAction {
    switch (event.type) {
        case 'notification':
            // Only permission-style notifications count as needs-you. Idle
            // notifications ("Claude is waiting for your input") are ignored —
            // otherwise every idle session would light up the fleet (AC-6).
            return event.message && /permission/i.test(event.message) ? 'set' : 'none';
        case 'hook':
            return CLEARING_HOOK_EVENTS.has(event.eventName) ? 'clear' : 'none';
        case 'thinking':
            // thinking→true covers the deny path: a denied tool prompt makes
            // Claude continue thinking without any PostToolUse event.
            return event.thinking ? 'clear' : 'none';
    }
}
