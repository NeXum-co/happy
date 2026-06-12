/**
 * Sends push notifications via the Firebase Cloud Messaging HTTP v1 API (fork, E07 Route B).
 *
 * Used for fork-app tokens registered with the `fcm:` prefix (raw Android device tokens from
 * getDevicePushTokenAsync). OAuth2 access tokens are minted from a service-account JSON
 * (env `FCM_SERVICE_ACCOUNT_PATH`) via the JWT bearer flow using `jsonwebtoken` — deliberately
 * no google-auth-library dependency.
 *
 * Payload is hybrid notification + data: data-only messages are not delivered when the
 * Android app is killed (expo/expo#31886), so the OS renders the notification while `data`
 * carries sessionId/kind for tap-routing.
 *
 * Token cleanup is handled HERE, not by the caller: the FCM error format differs from Expo
 * push tickets. On HTTP 404 or `error.status === 'UNREGISTERED'` the token row is deleted
 * via db.accountPushToken.deleteMany. Results use a dedicated FcmSendResult interface —
 * intentionally not the Expo PushTicket shape.
 */

import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { db } from "@/storage/db";

const FCM_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

export interface FcmMessage {
    tokenId: string; // AccountPushToken.id — used for cleanup of unregistered tokens
    token: string; // raw FCM device token (without the `fcm:` prefix)
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
}

export interface FcmSendResult {
    ok: boolean;
    tokenDeleted: boolean;
    error?: string;
}

interface FcmServiceAccount {
    project_id: string;
    client_email: string;
    private_key: string;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

function loadServiceAccount(): FcmServiceAccount {
    const path = process.env.FCM_SERVICE_ACCOUNT_PATH;
    if (!path) {
        throw new Error('FCM_SERVICE_ACCOUNT_PATH not set');
    }
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as FcmServiceAccount;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
        throw new Error('FCM service account JSON misses project_id/client_email/private_key');
    }
    return parsed;
}

async function getAccessToken(serviceAccount: FcmServiceAccount): Promise<string> {
    if (cachedAccessToken && cachedAccessToken.expiresAt - ACCESS_TOKEN_EXPIRY_SKEW_MS > Date.now()) {
        return cachedAccessToken.token;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
        {
            iss: serviceAccount.client_email,
            scope: FCM_OAUTH_SCOPE,
            aud: FCM_OAUTH_TOKEN_URL,
            iat: nowSeconds,
            exp: nowSeconds + 3600
        },
        serviceAccount.private_key,
        { algorithm: 'RS256' }
    );

    const response = await fetch(FCM_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion
        }).toString()
    });
    if (!response.ok) {
        throw new Error(`FCM OAuth token request failed: HTTP ${response.status}`);
    }

    const result = await response.json() as { access_token: string; expires_in: number };
    cachedAccessToken = {
        token: result.access_token,
        expiresAt: Date.now() + result.expires_in * 1000
    };
    return result.access_token;
}

/**
 * Builds the FCM v1 request body for a single message. Exported for tests.
 * Hybrid payload: `notification` (OS-rendered, survives killed app) + `data` (tap-routing).
 * FCM requires all data values to be strings — non-strings are JSON-stringified.
 */
export function buildFcmRequestBody(message: FcmMessage): Record<string, unknown> {
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(message.data)) {
        data[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }

    return {
        message: {
            token: message.token,
            notification: {
                title: message.title,
                body: message.body
            },
            data,
            android: {
                priority: 'high',
                notification: {
                    channel_id: message.channelId,
                    sound: 'default'
                }
            }
        }
    };
}

/**
 * Sends messages one-by-one to the FCM v1 endpoint (no batch API in v1).
 * Configuration errors (missing/invalid service account, OAuth failure) never throw:
 * every message gets an error result, so the caller's Expo path is unaffected.
 */
export async function sendFcmNotifications(messages: FcmMessage[]): Promise<FcmSendResult[]> {
    if (messages.length === 0) {
        return [];
    }

    let serviceAccount: FcmServiceAccount;
    let accessToken: string;
    try {
        serviceAccount = loadServiceAccount();
        accessToken = await getAccessToken(serviceAccount);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'FCM configuration error';
        return messages.map(() => ({ ok: false, tokenDeleted: false, error: message }));
    }

    const sendUrl = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;
    const results: FcmSendResult[] = [];

    for (const message of messages) {
        try {
            const response = await fetch(sendUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(buildFcmRequestBody(message))
            });

            if (response.ok) {
                results.push({ ok: true, tokenDeleted: false });
                continue;
            }

            let errorStatus: string | undefined;
            try {
                const errorBody = await response.json() as { error?: { status?: string } };
                errorStatus = errorBody.error?.status;
            } catch {
                // non-JSON error body — fall through with HTTP status only
            }

            const isUnregistered = response.status === 404 || errorStatus === 'UNREGISTERED';
            if (isUnregistered) {
                await db.accountPushToken.deleteMany({
                    where: { id: message.tokenId }
                });
            }

            results.push({
                ok: false,
                tokenDeleted: isUnregistered,
                error: errorStatus ?? `HTTP ${response.status}`
            });
        } catch {
            results.push({ ok: false, tokenDeleted: false, error: 'Network error' });
        }
    }

    return results;
}
