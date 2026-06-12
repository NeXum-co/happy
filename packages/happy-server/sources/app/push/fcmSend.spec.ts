import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";

const deleteMany = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        accountPushToken: {
            deleteMany: (...args: unknown[]) => deleteMany(...args)
        }
    }
}));

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const serviceAccountPath = join(tmpdir(), `fcm-service-account-test-${process.pid}.json`);

function writeServiceAccount() {
    writeFileSync(serviceAccountPath, JSON.stringify({
        project_id: 'nexum-happy-test',
        client_email: 'pusher@nexum-happy-test.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    }));
}

function oauthResponse() {
    return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), { status: 200 });
}

function fcmOkResponse() {
    return new Response(JSON.stringify({ name: 'projects/nexum-happy-test/messages/1' }), { status: 200 });
}

function fcmErrorResponse(status: number, errorStatus?: string) {
    const body = errorStatus
        ? JSON.stringify({ error: { code: status, status: errorStatus, message: 'boom' } })
        : 'not json';
    return new Response(body, { status });
}

function makeMessage(overrides?: Partial<import('./fcmSend').FcmMessage>): import('./fcmSend').FcmMessage {
    return {
        tokenId: 'tok-1',
        token: 'raw-fcm-device-token',
        title: 'Permission needed',
        body: 'Session wants to run a command',
        data: { sessionId: 'sess-1', kind: 'permission' },
        channelId: 'messages',
        ...overrides
    };
}

// Fresh module per test: fcmSend caches the OAuth access token at module level.
async function importFcmSend() {
    return await import('./fcmSend');
}

describe("fcmSend", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.resetModules();
        fetchMock.mockReset();
        deleteMany.mockReset();
        vi.stubGlobal('fetch', fetchMock);
        writeServiceAccount();
        process.env.FCM_SERVICE_ACCOUNT_PATH = serviceAccountPath;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.FCM_SERVICE_ACCOUNT_PATH;
        rmSync(serviceAccountPath, { force: true });
    });

    describe("buildFcmRequestBody", () => {
        it("builds a hybrid notification + data payload with high priority", async () => {
            const { buildFcmRequestBody } = await importFcmSend();
            const body = buildFcmRequestBody(makeMessage());

            expect(body).toEqual({
                message: {
                    token: 'raw-fcm-device-token',
                    notification: {
                        title: 'Permission needed',
                        body: 'Session wants to run a command'
                    },
                    data: {
                        sessionId: 'sess-1',
                        kind: 'permission'
                    },
                    android: {
                        priority: 'high',
                        notification: {
                            channel_id: 'messages',
                            sound: 'default'
                        }
                    }
                }
            });
        });

        it("stringifies non-string data values (FCM requires string data)", async () => {
            const { buildFcmRequestBody } = await importFcmSend();
            const body = buildFcmRequestBody(makeMessage({
                data: { sessionId: 'sess-1', count: 3, nested: { a: 1 } }
            })) as { message: { data: Record<string, string> } };

            expect(body.message.data).toEqual({
                sessionId: 'sess-1',
                count: '3',
                nested: '{"a":1}'
            });
        });
    });

    describe("sendFcmNotifications", () => {
        it("mints an OAuth token via JWT bearer flow and posts to the project send endpoint", async () => {
            fetchMock
                .mockResolvedValueOnce(oauthResponse())
                .mockResolvedValueOnce(fcmOkResponse());
            const { sendFcmNotifications, buildFcmRequestBody } = await importFcmSend();

            const results = await sendFcmNotifications([makeMessage()]);

            expect(results).toEqual([{ ok: true, tokenDeleted: false }]);
            expect(fetchMock).toHaveBeenCalledTimes(2);

            // OAuth call: JWT assertion signed with the service-account key, cloud-platform scope.
            const [oauthUrl, oauthInit] = fetchMock.mock.calls[0];
            expect(oauthUrl).toBe('https://oauth2.googleapis.com/token');
            const oauthParams = new URLSearchParams(oauthInit.body as string);
            expect(oauthParams.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
            const assertion = jwt.verify(oauthParams.get('assertion')!, publicKeyPem) as Record<string, unknown>;
            expect(assertion.iss).toBe('pusher@nexum-happy-test.iam.gserviceaccount.com');
            expect(assertion.scope).toBe('https://www.googleapis.com/auth/cloud-platform');
            expect(assertion.aud).toBe('https://oauth2.googleapis.com/token');

            // Send call: project from service account, bearer token, hybrid payload.
            const [sendUrl, sendInit] = fetchMock.mock.calls[1];
            expect(sendUrl).toBe('https://fcm.googleapis.com/v1/projects/nexum-happy-test/messages:send');
            expect(sendInit.headers['Authorization']).toBe('Bearer test-access-token');
            expect(JSON.parse(sendInit.body as string)).toEqual(buildFcmRequestBody(makeMessage()));
        });

        it("reuses the cached access token across calls", async () => {
            fetchMock
                .mockResolvedValueOnce(oauthResponse())
                .mockResolvedValueOnce(fcmOkResponse())
                .mockResolvedValueOnce(fcmOkResponse());
            const { sendFcmNotifications } = await importFcmSend();

            await sendFcmNotifications([makeMessage()]);
            await sendFcmNotifications([makeMessage({ tokenId: 'tok-2' })]);

            const oauthCalls = fetchMock.mock.calls.filter(([url]) => url === 'https://oauth2.googleapis.com/token');
            expect(oauthCalls).toHaveLength(1);
        });

        it("deletes the token on HTTP 404", async () => {
            fetchMock
                .mockResolvedValueOnce(oauthResponse())
                .mockResolvedValueOnce(fcmErrorResponse(404, 'NOT_FOUND'));
            const { sendFcmNotifications } = await importFcmSend();

            const results = await sendFcmNotifications([makeMessage()]);

            expect(results).toEqual([{ ok: false, tokenDeleted: true, error: 'NOT_FOUND' }]);
            expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'tok-1' } });
        });

        it("deletes the token on error.status UNREGISTERED", async () => {
            fetchMock
                .mockResolvedValueOnce(oauthResponse())
                .mockResolvedValueOnce(fcmErrorResponse(400, 'UNREGISTERED'));
            const { sendFcmNotifications } = await importFcmSend();

            const results = await sendFcmNotifications([makeMessage()]);

            expect(results).toEqual([{ ok: false, tokenDeleted: true, error: 'UNREGISTERED' }]);
            expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'tok-1' } });
        });

        it("keeps the token on other errors", async () => {
            fetchMock
                .mockResolvedValueOnce(oauthResponse())
                .mockResolvedValueOnce(fcmErrorResponse(500));
            const { sendFcmNotifications } = await importFcmSend();

            const results = await sendFcmNotifications([makeMessage()]);

            expect(results).toEqual([{ ok: false, tokenDeleted: false, error: 'HTTP 500' }]);
            expect(deleteMany).not.toHaveBeenCalled();
        });

        it("returns error results without throwing when FCM_SERVICE_ACCOUNT_PATH is unset", async () => {
            delete process.env.FCM_SERVICE_ACCOUNT_PATH;
            const { sendFcmNotifications } = await importFcmSend();

            const results = await sendFcmNotifications([makeMessage(), makeMessage({ tokenId: 'tok-2' })]);

            expect(results).toEqual([
                { ok: false, tokenDeleted: false, error: 'FCM_SERVICE_ACCOUNT_PATH not set' },
                { ok: false, tokenDeleted: false, error: 'FCM_SERVICE_ACCOUNT_PATH not set' }
            ]);
            expect(fetchMock).not.toHaveBeenCalled();
            expect(deleteMany).not.toHaveBeenCalled();
        });

        it("returns an empty array for no messages without touching config", async () => {
            delete process.env.FCM_SERVICE_ACCOUNT_PATH;
            const { sendFcmNotifications } = await importFcmSend();

            expect(await sendFcmNotifications([])).toEqual([]);
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });
});
