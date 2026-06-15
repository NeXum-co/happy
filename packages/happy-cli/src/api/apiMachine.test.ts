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
