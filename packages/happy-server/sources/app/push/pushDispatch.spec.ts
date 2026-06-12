import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        accountPushToken: {
            findMany: (...args: unknown[]) => findMany(...args),
            deleteMany: vi.fn()
        }
    }
}));

vi.mock("@/app/push/focusTracker", () => ({
    isUserActive: vi.fn(async () => false)
}));

const sendPushNotifications = vi.fn(async (messages: unknown[]) => messages.map(() => ({ status: 'ok' as const })));
vi.mock("@/app/push/pushSend", () => ({
    sendPushNotifications: (messages: unknown[]) => sendPushNotifications(messages)
}));

const sendFcmNotifications = vi.fn(async (messages: unknown[]) => messages.map(() => ({ ok: true, tokenDeleted: false })));
vi.mock("@/app/push/fcmSend", () => ({
    sendFcmNotifications: (messages: unknown[]) => sendFcmNotifications(messages)
}));

vi.mock("@/utils/log", () => ({
    log: vi.fn()
}));

import { splitPushTokens, dispatchSessionEventPush } from "./pushDispatch";

describe("pushDispatch", () => {
    beforeEach(() => {
        findMany.mockReset();
        sendPushNotifications.mockClear();
        sendFcmNotifications.mockClear();
    });

    describe("splitPushTokens", () => {
        it("splits fcm:-prefixed tokens from Expo tokens", () => {
            const tokens = [
                { id: '1', token: 'fcm:device-token-a' },
                { id: '2', token: 'ExponentPushToken[xyz]' },
                { id: '3', token: 'fcm:device-token-b' }
            ];

            const { fcm, expo } = splitPushTokens(tokens);

            expect(fcm.map(t => t.id)).toEqual(['1', '3']);
            expect(expo.map(t => t.id)).toEqual(['2']);
        });

        it("returns empty groups for no tokens", () => {
            expect(splitPushTokens([])).toEqual({ fcm: [], expo: [] });
        });
    });

    describe("dispatchSessionEventPush", () => {
        it("routes fcm:-tokens to the FCM sender (prefix stripped) and Expo tokens to the Expo sender", async () => {
            findMany.mockResolvedValue([
                { id: 'tok-fcm', token: 'fcm:raw-device-token' },
                { id: 'tok-expo', token: 'ExponentPushToken[xyz]' }
            ]);

            await dispatchSessionEventPush({
                userId: 'user-1',
                sessionId: 'sess-1',
                title: 'Done',
                body: 'Session finished',
                data: { kind: 'done' }
            });

            expect(sendFcmNotifications).toHaveBeenCalledWith([{
                tokenId: 'tok-fcm',
                token: 'raw-device-token',
                title: 'Done',
                body: 'Session finished',
                data: { sessionId: 'sess-1', kind: 'done' },
                channelId: 'messages'
            }]);
            expect(sendPushNotifications).toHaveBeenCalledWith([{
                to: 'ExponentPushToken[xyz]',
                title: 'Done',
                body: 'Session finished',
                data: { sessionId: 'sess-1', kind: 'done' },
                sound: 'default',
                channelId: 'messages'
            }]);
        });

        it("skips the Expo sender when all tokens are FCM", async () => {
            findMany.mockResolvedValue([{ id: 'tok-fcm', token: 'fcm:raw-device-token' }]);

            await dispatchSessionEventPush({
                userId: 'user-1',
                sessionId: 'sess-1',
                title: 'Done',
                body: 'Session finished'
            });

            expect(sendFcmNotifications).toHaveBeenCalledTimes(1);
            expect(sendPushNotifications).not.toHaveBeenCalled();
        });

        it("skips the FCM sender when all tokens are Expo (upstream behavior unchanged)", async () => {
            findMany.mockResolvedValue([{ id: 'tok-expo', token: 'ExponentPushToken[xyz]' }]);

            await dispatchSessionEventPush({
                userId: 'user-1',
                sessionId: 'sess-1',
                title: 'Done',
                body: 'Session finished'
            });

            expect(sendPushNotifications).toHaveBeenCalledTimes(1);
            expect(sendFcmNotifications).not.toHaveBeenCalled();
        });
    });
});
