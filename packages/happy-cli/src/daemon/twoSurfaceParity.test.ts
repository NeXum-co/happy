/**
 * Two-surface parity guard (E10, BUG-UAT-1).
 *
 * Every account/burn management verb MUST be exposed on BOTH surfaces:
 *  - the local HTTP control server (`controlServer.ts`, `typed.post('/<verb>')`)
 *  - the machine RPC client (`apiMachine.ts`, `registerHandler('<verb>')`)
 *
 * The E10 build was bitten by a verb landing on only one surface (BUG-UAT-1).
 * This test fails the moment a verb is added to one surface but not the other,
 * so the contract can't silently drift. It reads the source rather than booting
 * a daemon: a structural invariant, zero-flake, and independent of auth/env.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

/**
 * The E10 account/burn verb contract. Each logical verb has an RPC name and an
 * HTTP route. They match 1:1 except `get-usage`, whose HTTP route is `/usage` by
 * design (the closures are shared; only the path/verb label differs — see the
 * BUG-UAT-1 notes in run.ts:1120 and controlServer.ts:367).
 */
const E10_VERBS = [
    { rpc: 'list-accounts', http: '/list-accounts' },
    { rpc: 'add-account', http: '/add-account' },
    { rpc: 'set-default-account', http: '/set-default-account' },
    { rpc: 'remove-account', http: '/remove-account' },
    { rpc: 'account-switch', http: '/account-switch' },
    { rpc: 'get-usage', http: '/usage' },
    { rpc: 'get-burn-policy', http: '/get-burn-policy' },
    { rpc: 'set-burn-policy', http: '/set-burn-policy' },
] as const;

const httpSrc = readFileSync(resolve(SRC, 'daemon/controlServer.ts'), 'utf8');
const rpcSrc = readFileSync(resolve(SRC, 'api/apiMachine.ts'), 'utf8');

const hasHttpRoute = (route: string) =>
    new RegExp(`typed\\.(post|get)\\(\\s*['"]${route}['"]`).test(httpSrc);
const hasRpcHandler = (verb: string) =>
    new RegExp(`registerHandler\\(\\s*['"]${verb}['"]`).test(rpcSrc);

describe('E10 two-surface verb parity (BUG-UAT-1)', () => {
    it('exposes every account/burn verb on the HTTP control server', () => {
        const missing = E10_VERBS.filter(v => !hasHttpRoute(v.http)).map(v => v.http);
        expect(missing, `HTTP routes missing in controlServer.ts: ${missing.join(', ')}`).toEqual([]);
    });

    it('exposes every account/burn verb on the machine RPC surface', () => {
        const missing = E10_VERBS.filter(v => !hasRpcHandler(v.rpc)).map(v => v.rpc);
        expect(missing, `RPC handlers missing in apiMachine.ts: ${missing.join(', ')}`).toEqual([]);
    });

    it('keeps the two surfaces in sync (every verb present on BOTH)', () => {
        const drifted = E10_VERBS
            .filter(v => hasHttpRoute(v.http) !== hasRpcHandler(v.rpc))
            .map(v => `${v.rpc} (HTTP ${hasHttpRoute(v.http) ? '✓' : '✗'} / RPC ${hasRpcHandler(v.rpc) ? '✓' : '✗'})`);
        expect(drifted, `surface drift: ${drifted.join(', ')}`).toEqual([]);
    });
});
