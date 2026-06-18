// Synthetic account + legacy-encryption helpers for the isolated-relay web-E2E (E10 Slice C).
//
// Creates a headless account on the isolated relay via POST /v1/auth (no QR), returning:
//   - token:        the relay auth token (Bearer for REST + socket auth)
//   - secret:       the app-format E2EE secret (base64url) stored in localStorage.auth_credentials
//   - masterSecret: the raw 32-byte key used for legacy(variant) encryption of session payloads
//
// `encLegacy` mirrors the legacy secretbox envelope the app decrypts (variant='legacy', no
// per-field dataEncryptionKey): nonce(24) || secretbox(nonce, masterSecret). Proven to round-trip
// app-side decrypt of both metadata and agentState.

import nacl from 'tweetnacl';

export interface SeededAccount {
    token: string;
    /** base64url — the app stores this as localStorage.auth_credentials.secret. */
    secret: string;
    /** raw 32 bytes — the legacy encryption key matching `secret`. */
    masterSecret: Uint8Array;
}

const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64');
const b64url = (u8: Uint8Array) => Buffer.from(u8).toString('base64url');

/** Legacy secretbox envelope (variant='legacy'): nonce || box, base64. */
export function encLegacy(obj: unknown, secret: Uint8Array): string {
    const nonce = nacl.randomBytes(24);
    const enc = nacl.secretbox(new TextEncoder().encode(JSON.stringify(obj)), nonce, secret);
    const out = new Uint8Array(nonce.length + enc.length);
    out.set(nonce);
    out.set(enc, nonce.length);
    return Buffer.from(out).toString('base64');
}

/** Create a fresh headless account on the relay (challenge-response, no QR). */
export async function seedAccount(relayUrl: string): Promise<SeededAccount> {
    const kp = nacl.sign.keyPair();
    const challenge = nacl.randomBytes(32);
    const signature = nacl.sign.detached(challenge, kp.secretKey);

    const res = await fetch(`${relayUrl}/v1/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            publicKey: b64(kp.publicKey),
            challenge: b64(challenge),
            signature: b64(signature),
        }),
    });
    if (!res.ok) {
        throw new Error(`seedAccount: POST /v1/auth failed ${res.status}: ${await res.text()}`);
    }
    const { token } = (await res.json()) as { token: string };
    if (!token) throw new Error('seedAccount: /v1/auth returned no token');

    const masterSecret = nacl.randomBytes(32);
    return { token, secret: b64url(masterSecret), masterSecret };
}
