import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';

const {
    mockIo,
    mockShouldReconnect
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockShouldReconnect: vi.fn(() => true)
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://127.0.0.1:3005',
        currentCliVersion: 'test'
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn();
        unregisterHandler = vi.fn();
        hasHandler = vi.fn(() => false);
    }
}));

vi.mock('@/utils/detectCLI', () => ({
    detectCLIAvailability: vi.fn(() => ({
        claude: false,
        codex: false,
        gemini: false,
        openclaw: false
    }))
}));

vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false
    }))
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect
}));

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib'
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy'
    };
}

describe('ApiMachineClient socket reconnection', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockShouldReconnect.mockReturnValue(true);
        socketHandlers = {};
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            close: vi.fn(),
            io: {
                on: vi.fn()
            }
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockIo).toHaveBeenCalledWith('ws://127.0.0.1:3005', expect.objectContaining({
            reconnection: false
        }));
        expect(mockSocket.connect).not.toHaveBeenCalled();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });
});

describe('ApiMachineClient setRPCHandlers — cancel-job (E04)', () => {
    // Regression: the app cancels a pending job via the machine-RPC 'cancel-job'
    // (apiSocket.machineRPC(..., 'cancel-job', { jobId })). The HTTP /cancel-job
    // control-server endpoint existed, but the RPC handler was never registered,
    // so the app's cancel was a silent no-op. Live UAT caught it; this locks it.
    beforeEach(() => vi.clearAllMocks());

    function makeClientWithCancel(cancelJob: (jobId: string) => boolean) {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn() as any,
            stopSession: vi.fn(() => true),
            requestShutdown: vi.fn(),
            cancelJob
        });
        const rpc = (client as any).rpcHandlerManager;
        const call = rpc.registerHandler.mock.calls.find((c: any[]) => c[0] === 'cancel-job');
        return { client, call };
    }

    it("registers a 'cancel-job' handler that routes to cancelJob and returns { cancelled }", async () => {
        const cancelJob = vi.fn(() => true);
        const { client, call } = makeClientWithCancel(cancelJob);
        expect(call).toBeDefined();
        const result = await call![1]({ jobId: 'job-123' });
        expect(cancelJob).toHaveBeenCalledWith('job-123');
        expect(result).toEqual({ cancelled: true });
        client.shutdown();
    });

    it("'cancel-job' handler rejects a missing jobId", async () => {
        const { client, call } = makeClientWithCancel(vi.fn(() => true));
        await expect(call![1]({})).rejects.toThrow('jobId is required');
        client.shutdown();
    });

    it("does not register 'cancel-job' when no cancelJob handler is provided", () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn() as any,
            stopSession: vi.fn(() => true),
            requestShutdown: vi.fn()
        });
        const rpc = (client as any).rpcHandlerManager;
        const call = rpc.registerHandler.mock.calls.find((c: any[]) => c[0] === 'cancel-job');
        expect(call).toBeUndefined();
        client.shutdown();
    });
});

describe('ApiMachineClient setRPCHandlers — cron (E04)', () => {
    // Mirrors the cancel-job block: the app manages cron schedules via the
    // machine-RPCs 'submit-cron' / 'list-crons' / 'delete-cron'. These lock the
    // handler registration, routing and input-validation. The submit-cron
    // handler runs the REAL validateCronExpr (no mock), so 'nonsense' is rejected
    // and a valid expression passes through.
    beforeEach(() => vi.clearAllMocks());

    function makeClient(handlers: Record<string, any>) {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn() as any,
            stopSession: vi.fn(() => true),
            requestShutdown: vi.fn(),
            ...handlers
        });
        const rpc = (client as any).rpcHandlerManager;
        const find = (method: string) =>
            rpc.registerHandler.mock.calls.find((c: any[]) => c[0] === method);
        return { client, find };
    }

    it("registers a 'submit-cron' handler that routes to submitCron and returns { cronId }", async () => {
        const submitCron = vi.fn(() => 'cron-123');
        const { client, find } = makeClient({ submitCron });
        const call = find('submit-cron');
        expect(call).toBeDefined();
        const result = await call![1]({ cronExpr: '*/5 * * * *', directory: '/x', prompt: 'p' });
        expect(submitCron).toHaveBeenCalledWith(expect.objectContaining({
            cronExpr: '*/5 * * * *',
            directory: '/x',
            prompt: 'p'
        }));
        expect(result).toEqual({ cronId: 'cron-123' });
        client.shutdown();
    });

    it("'submit-cron' handler rejects an invalid cronExpr", async () => {
        const { client, find } = makeClient({ submitCron: vi.fn(() => 'cron-123') });
        const call = find('submit-cron');
        await expect(call![1]({ cronExpr: 'nonsense', directory: '/x', prompt: 'p' }))
            .rejects.toThrow('invalid cronExpr');
        client.shutdown();
    });

    it("'submit-cron' handler rejects a missing directory or prompt", async () => {
        const { client, find } = makeClient({ submitCron: vi.fn(() => 'cron-123') });
        const call = find('submit-cron');
        await expect(call![1]({ cronExpr: '*/5 * * * *', prompt: 'p' }))
            .rejects.toThrow('directory is required');
        await expect(call![1]({ cronExpr: '*/5 * * * *', directory: '/x' }))
            .rejects.toThrow('prompt is required');
        client.shutdown();
    });

    it("registers a 'list-crons' handler that returns { crons }", async () => {
        const listCrons = vi.fn(() => [{ id: 'c1' } as any]);
        const { client, find } = makeClient({ listCrons });
        const call = find('list-crons');
        expect(call).toBeDefined();
        const result = await call![1]({});
        expect(listCrons).toHaveBeenCalled();
        expect(result).toEqual({ crons: [{ id: 'c1' }] });
        client.shutdown();
    });

    it("registers a 'delete-cron' handler that routes to deleteCron and returns { deleted }", async () => {
        const deleteCron = vi.fn(() => true);
        const { client, find } = makeClient({ deleteCron });
        const call = find('delete-cron');
        expect(call).toBeDefined();
        const result = await call![1]({ id: 'cron-123' });
        expect(deleteCron).toHaveBeenCalledWith('cron-123');
        expect(result).toEqual({ deleted: true });
        client.shutdown();
    });

    it("'delete-cron' handler rejects a missing id", async () => {
        const { client, find } = makeClient({ deleteCron: vi.fn(() => true) });
        const call = find('delete-cron');
        await expect(call![1]({})).rejects.toThrow('id is required');
        client.shutdown();
    });

    it("does not register the cron handlers when no cron handlers are provided", () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn() as any,
            stopSession: vi.fn(() => true),
            requestShutdown: vi.fn()
        });
        const rpc = (client as any).rpcHandlerManager;
        for (const method of ['submit-cron', 'list-crons', 'delete-cron']) {
            const call = rpc.registerHandler.mock.calls.find((c: any[]) => c[0] === method);
            expect(call).toBeUndefined();
        }
        client.shutdown();
    });
});

describe('ApiMachineClient setRPCHandlers — event (E04)', () => {
    // Mirrors the cron block: the app manages event subscriptions via the
    // machine-RPCs 'submit-event-subscription' / 'list-event-subscriptions' /
    // 'delete-event-subscription', and delivers events via 'trigger-event'. These
    // lock the handler registration, routing and input-validation.
    beforeEach(() => vi.clearAllMocks());

    function makeClient(handlers: Record<string, any>) {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn() as any,
            stopSession: vi.fn(() => true),
            requestShutdown: vi.fn(),
            ...handlers
        });
        const rpc = (client as any).rpcHandlerManager;
        const find = (method: string) =>
            rpc.registerHandler.mock.calls.find((c: any[]) => c[0] === method);
        return { client, find };
    }

    it("registers a 'submit-event-subscription' handler that routes to submitEventSubscription and returns { subscriptionId }", async () => {
        const submitEventSubscription = vi.fn(() => 'sub-123');
        const { client, find } = makeClient({ submitEventSubscription });
        const call = find('submit-event-subscription');
        expect(call).toBeDefined();
        const result = await call![1]({ eventType: 'git.commit', directory: '/x', prompt: 'p' });
        expect(submitEventSubscription).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'git.commit',
            directory: '/x',
            prompt: 'p'
        }));
        expect(result).toEqual({ subscriptionId: 'sub-123' });
        client.shutdown();
    });

    it("'submit-event-subscription' handler rejects a missing eventType, directory or prompt", async () => {
        const { client, find } = makeClient({ submitEventSubscription: vi.fn(() => 'sub-123') });
        const call = find('submit-event-subscription');
        await expect(call![1]({ directory: '/x', prompt: 'p' }))
            .rejects.toThrow('eventType is required');
        await expect(call![1]({ eventType: 'git.commit', prompt: 'p' }))
            .rejects.toThrow('directory is required');
        await expect(call![1]({ eventType: 'git.commit', directory: '/x' }))
            .rejects.toThrow('prompt is required');
        client.shutdown();
    });

    it("registers a 'list-event-subscriptions' handler that returns { subscriptions }", async () => {
        const listEventSubscriptions = vi.fn(() => [{ id: 's1' } as any]);
        const { client, find } = makeClient({ listEventSubscriptions });
        const call = find('list-event-subscriptions');
        expect(call).toBeDefined();
        const result = await call![1]({});
        expect(listEventSubscriptions).toHaveBeenCalled();
        expect(result).toEqual({ subscriptions: [{ id: 's1' }] });
        client.shutdown();
    });

    it("registers a 'delete-event-subscription' handler that routes to deleteEventSubscription and returns { deleted }", async () => {
        const deleteEventSubscription = vi.fn(() => true);
        const { client, find } = makeClient({ deleteEventSubscription });
        const call = find('delete-event-subscription');
        expect(call).toBeDefined();
        const result = await call![1]({ id: 'sub-123' });
        expect(deleteEventSubscription).toHaveBeenCalledWith('sub-123');
        expect(result).toEqual({ deleted: true });
        client.shutdown();
    });

    it("'delete-event-subscription' handler rejects a missing id", async () => {
        const { client, find } = makeClient({ deleteEventSubscription: vi.fn(() => true) });
        const call = find('delete-event-subscription');
        await expect(call![1]({})).rejects.toThrow('id is required');
        client.shutdown();
    });

    it("registers a 'trigger-event' handler that routes to triggerEvent and returns { created }", async () => {
        const triggerEvent = vi.fn(() => ({ created: ['job-1', 'job-2'] }));
        const { client, find } = makeClient({ triggerEvent });
        const call = find('trigger-event');
        expect(call).toBeDefined();
        const result = await call![1]({ eventType: 'git.commit', matchKey: '/repo', payload: { sha: 'abc' } });
        expect(triggerEvent).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'git.commit',
            matchKey: '/repo',
            payload: { sha: 'abc' }
        }));
        expect(result).toEqual({ created: ['job-1', 'job-2'] });
        client.shutdown();
    });

    it("'trigger-event' handler rejects a missing eventType", async () => {
        const { client, find } = makeClient({ triggerEvent: vi.fn(() => ({ created: [] })) });
        const call = find('trigger-event');
        await expect(call![1]({ payload: {} })).rejects.toThrow('eventType is required');
        client.shutdown();
    });

    it("does not register the event handlers when no event handlers are provided", () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn() as any,
            stopSession: vi.fn(() => true),
            requestShutdown: vi.fn()
        });
        const rpc = (client as any).rpcHandlerManager;
        for (const method of ['submit-event-subscription', 'list-event-subscriptions', 'delete-event-subscription', 'trigger-event']) {
            const call = rpc.registerHandler.mock.calls.find((c: any[]) => c[0] === method);
            expect(call).toBeUndefined();
        }
        client.shutdown();
    });
});
