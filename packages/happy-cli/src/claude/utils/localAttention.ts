/**
 * Local-mode attention decision logic (E02 fase G, AC-6 / D-E02-13).
 *
 * Terminal permission prompts live in Claude's TUI and never reach
 * agentState.requests. The Notification hook is the only signal that such a
 * prompt is pending. Clearing is defense-in-depth (D-E02-13), because an
 * interactive deny (Esc or "No") in Claude Code 2.1.173 fires NO hook event
 * at all (live-verified, fase G proof):
 *
 * 1. Hook events (PostToolUse / UserPromptSubmit / Stop / PermissionDenied)
 *    and the fd-3 thinking signal — cover the approve path and new prompts.
 * 2. Transcript lines: a conversation line written after the prompt was set
 *    means the turn moved on. (Inert on 2.1.173, which defers conversation
 *    writes — kept for other versions; live-verified in the fase G proof.)
 * 3. Idle notifications (notification_type "idle_prompt", fires 60 s after a
 *    Stop): the session is waiting for input, not for a permission answer.
 * 4. Read-side TTL (LOCAL_REQUEST_TTL_MS): consumers ignore a localRequest
 *    older than 30 min — the only layer that catches a deny followed by
 *    silence, since that scenario produces no signal whatsoever.
 *
 * This module is the single pure decision point: which events set
 * agentState.localRequest and which events clear it. Wiring lives in
 * runClaude.ts; the TTL read side lives in fleet/fleetStatus.ts (CLI) and
 * sources/sync/fleetLayout.ts (app).
 */

export type LocalAttentionEvent =
    | { type: 'notification'; message: string | undefined; notificationType?: string }
    | { type: 'hook'; eventName: string }
    | { type: 'thinking'; thinking: boolean }
    | {
        type: 'transcript';
        /** JSONL line type (user / assistant / system / summary). */
        lineType: string;
        /** The line's own timestamp in epoch ms, null when it has none. */
        timestampMs: number | null;
        isSidechain: boolean;
        /** createdAt of the pending localRequest being evaluated. */
        requestCreatedAt: number;
    };

export type LocalAttentionAction = 'set' | 'clear' | 'none';

/**
 * Consumers (waybar count, needs-you band) ignore a localRequest older than
 * this. Safety net for the deny path: an interactive deny fires no hook
 * event and writes nothing, so without a TTL the signal would stay forever.
 */
export const LOCAL_REQUEST_TTL_MS = 30 * 60 * 1000;

/**
 * Hook events that mean the terminal prompt is no longer pending. An
 * interactive deny fires NONE of these (live-verified against Claude Code
 * 2.1.173) — PermissionDenied only exists for the deny-with-continue path.
 */
const CLEARING_HOOK_EVENTS = new Set(['PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionDenied']);

export function resolveLocalAttention(event: LocalAttentionEvent): LocalAttentionAction {
    switch (event.type) {
        case 'notification':
            // notification_type is authoritative when present; the message
            // regexes keep working should Claude Code drop or rename it.
            if (event.notificationType === 'permission_prompt') {
                return 'set';
            }
            if (event.notificationType === 'idle_prompt') {
                return 'clear';
            }
            if (event.notificationType) {
                return 'none';
            }
            if (event.message && /permission/i.test(event.message)) {
                return 'set';
            }
            // Idle-backstop (D-E02-13): "Claude is waiting for your input"
            // means the session waits on a prompt, not on a permission.
            if (event.message && /waiting for your input/i.test(event.message)) {
                return 'clear';
            }
            return 'none';
        case 'hook':
            return CLEARING_HOOK_EVENTS.has(event.eventName) ? 'clear' : 'none';
        case 'thinking':
            // thinking→true means Claude is working again, so no prompt is
            // pending (a denied prompt does not resume thinking, though —
            // the turn aborts silently).
            return event.thinking ? 'clear' : 'none';
        case 'transcript':
            // Only conversation lines written AFTER the prompt was set count.
            // The assistant tool_use line that triggered the prompt carries a
            // timestamp before the Notification hook, so it never clears its
            // own prompt — regardless of when the scanner delivers it.
            return (event.lineType === 'user' || event.lineType === 'assistant')
                && !event.isSidechain
                && event.timestampMs !== null
                && event.timestampMs > event.requestCreatedAt
                ? 'clear'
                : 'none';
    }
}
