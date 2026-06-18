import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub the rollup loader so the handler's loadRollup() call is deterministic and
// independent of ~/.claude/memory state. The runtime gate then evaluates the
// in-process topic env against this structured rollup (D-E05-2/8).
vi.mock('@/disposition/rollup', () => ({
    loadRollup: () => ({
        generatedFrom: 5,
        domains: {
            security: { a: 2, m: 0, o: 0, d: 0, n: 2, bucket: 'high-trust' },
        },
        topics: {},
    }),
}));

import { PermissionHandler } from './permissionHandler';
import type { Session } from '../session';
import type { EnhancedMode } from '../loop';

/** Minimal Session stub: records whether an escalation (push notification) fired. */
function makeStubSession() {
    const sendSessionNotification = vi.fn();
    const session = {
        api: { push: () => ({ sendSessionNotification }) },
        client: {
            sessionId: 'test-session',
            getMetadata: () => ({}),
            updateAgentState: vi.fn(),
            rpcHandlerManager: { registerHandler: vi.fn() },
        },
    } as unknown as Session;
    return { session, sendSessionNotification };
}

function callOptions() {
    const controller = new AbortController();
    return { controller, options: { signal: controller.signal, toolUseID: 'tu-1' } };
}

const mode = 'default' as unknown as EnhancedMode;

describe('PermissionHandler runtime gate wiring (E05)', () => {
    const originalTopic = process.env.HAPPY_JOB_DISPOSITION_TOPIC;

    beforeEach(() => {
        process.env.HAPPY_JOB_DISPOSITION_TOPIC = 'security/x';
    });

    afterEach(() => {
        if (originalTopic === undefined) {
            delete process.env.HAPPY_JOB_DISPOSITION_TOPIC;
        } else {
            process.env.HAPPY_JOB_DISPOSITION_TOPIC = originalTopic;
        }
    });

    it('high-trust topic + non-dangerous tool (Read) -> auto-approved, no escalation', async () => {
        const { session, sendSessionNotification } = makeStubSession();
        const handler = new PermissionHandler(session);
        const { options } = callOptions();

        const result = await handler.handleToolCall('Read', {}, mode, options);

        expect(result).toEqual({ behavior: 'allow', updatedInput: {} });
        expect(sendSessionNotification).not.toHaveBeenCalled();
    });

    it('high-trust topic + dangerous tool (Bash) -> NOT auto-approved, escalates to user', async () => {
        const { session, sendSessionNotification } = makeStubSession();
        const handler = new PermissionHandler(session);
        const { controller, options } = callOptions();

        // The dangerous-tool floor (D-E05-8) means Bash is not auto-approved; the
        // call falls through to handlePermissionRequest, which queues a pending
        // request and pushes a permission notification. The promise never resolves
        // here (no user response), so we observe the escalation via the push, then
        // abort to clean up the pending request.
        const pending = handler.handleToolCall('Bash', { command: 'rm -rf /' }, mode, options);
        const rejection = expect(pending).rejects.toThrow('Permission request aborted');

        await vi.waitFor(() => expect(sendSessionNotification).toHaveBeenCalledTimes(1));

        const pushArg = sendSessionNotification.mock.calls[0][0];
        expect(pushArg.data.tool).toBe('Bash');
        expect(pushArg.data.type).toBe('permission_request');

        controller.abort();
        await rejection;
    });

    it('no disposition topic -> non-dangerous tool still escalates (fail-closed forward)', async () => {
        delete process.env.HAPPY_JOB_DISPOSITION_TOPIC;
        const { session, sendSessionNotification } = makeStubSession();
        const handler = new PermissionHandler(session);
        const { controller, options } = callOptions();

        const pending = handler.handleToolCall('Read', {}, mode, options);
        const rejection = expect(pending).rejects.toThrow('Permission request aborted');

        await vi.waitFor(() => expect(sendSessionNotification).toHaveBeenCalledTimes(1));

        controller.abort();
        await rejection;
    });
});
