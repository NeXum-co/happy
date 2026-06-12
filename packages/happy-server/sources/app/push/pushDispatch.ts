/**
 * Push notification dispatch.
 *
 * Single entry point: dispatchSessionEventPush — rich session-event
 * ("It's ready!", permission, question) called by CLI/daemon clients.
 *
 * Generic per-message pushes were removed: the CLI streams every assistant
 * chunk, tool_use, and tool_result as a session message, so notifying on each
 * insert produced one buzz every 10s during a turn with no useful title.
 * Connected clients still receive the realtime message update over socket;
 * only the Expo push for "new message" went away.
 *
 * Suppression: if the user has ANY non-machine client that is active
 * (connected + not backgrounded), suppress the push — they can see in-app
 * indicators (unread dots, tab title counter) instead.
 *
 * "Active" is determined by socket.data.appState:
 *   - Clients send `app-state: { state: 'active' | 'background' }` via socket.
 *   - Old clients that never send it are treated as active (connected = present).
 *   - On disconnect the socket (and its state) disappears automatically.
 */

import { db } from "@/storage/db";
import { isUserActive } from "@/app/push/focusTracker";
import { sendPushNotifications } from "@/app/push/pushSend";
import { sendFcmNotifications } from "@/app/push/fcmSend";
import { log } from "@/utils/log";

// Fork (E07): fork-app Android clients register raw FCM device tokens with this prefix on
// the token string (no DB migration — see pushRegistration.ts in happy-app). Prefixed
// tokens go through the raw FCM v1 sender; everything else stays on the Expo path
// (upstream-compat).
const FCM_TOKEN_PREFIX = 'fcm:';

/** Splits push tokens into FCM-prefixed (fork Android) and Expo (upstream) tokens. Exported for tests. */
export function splitPushTokens<T extends { token: string }>(tokens: T[]): { fcm: T[]; expo: T[] } {
    const fcm: T[] = [];
    const expo: T[] = [];
    for (const token of tokens) {
        (token.token.startsWith(FCM_TOKEN_PREFIX) ? fcm : expo).push(token);
    }
    return { fcm, expo };
}

async function fetchTokensAndSend(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
}): Promise<void> {
    // All push tokens are mobile — web/CLI never register push tokens.
    const tokens = await db.accountPushToken.findMany({
        where: { accountId: params.userId }
    });

    if (tokens.length === 0) {
        log({ module: 'push' }, `No push tokens for user ${params.userId} session ${params.sessionId} — skipped`);
        return;
    }

    const { fcm: fcmTokens, expo: expoTokens } = splitPushTokens(tokens);

    let okCount = 0;
    const errors: string[] = [];

    if (fcmTokens.length > 0) {
        // Cleanup of unregistered tokens happens inside sendFcmNotifications (FCM error
        // format differs from Expo tickets) — only counting/logging here.
        const fcmResults = await sendFcmNotifications(
            fcmTokens.map(t => ({
                tokenId: t.id,
                token: t.token.slice(FCM_TOKEN_PREFIX.length),
                title: params.title,
                body: params.body,
                data: params.data,
                channelId: params.channelId
            }))
        );
        for (const result of fcmResults) {
            if (result.ok) {
                okCount++;
            } else {
                errors.push(result.error ?? 'unknown');
            }
        }
    }

    const tickets = expoTokens.length > 0
        ? await sendPushNotifications(
            expoTokens.map(t => ({
                to: t.token,
                title: params.title,
                body: params.body,
                data: params.data,
                sound: 'default' as const,
                channelId: params.channelId
            }))
        )
        : [];

    for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
            okCount++;
            continue;
        }
        errors.push(ticket.details?.error || ticket.message || 'unknown');
        if (ticket.details?.error === 'DeviceNotRegistered') {
            void db.accountPushToken.deleteMany({
                where: { id: expoTokens[i].id }
            });
        }
    }

    if (errors.length === 0) {
        log({ module: 'push' }, `Push sent for user ${params.userId} session ${params.sessionId}: ${okCount} token(s)`);
    } else {
        log({ module: 'push', level: 'warn' }, `Push partial for user ${params.userId} session ${params.sessionId}: ok=${okCount} errors=${JSON.stringify(errors)}`);
    }
}

export async function dispatchSessionEventPush(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}): Promise<void> {
    const { userId, sessionId, title, body, data } = params;

    try {
        try {
            if (await isUserActive(userId)) {
                log({ module: 'push' }, `Suppressed session-event push for user ${userId} session ${sessionId}: user active`);
                return;
            }
        } catch (presenceError) {
            log({ module: 'push', level: 'error' }, `Presence check failed, sending push anyway: ${presenceError}`);
        }

        await fetchTokensAndSend({
            userId,
            sessionId,
            title,
            body,
            data: { sessionId, ...(data ?? {}) },
            channelId: 'messages'
        });
    } catch (error) {
        log({ module: 'push', level: 'error' }, `Session-event push dispatch failed: ${error}`);
    }
}
