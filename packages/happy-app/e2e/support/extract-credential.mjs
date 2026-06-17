// Reproducible, local-only extraction of the happy web `auth_credentials` into the gitignored E2E
// fixture (e2e/.auth/credentials.json). Reads the current user's own Chrome/Chromium localStorage
// leveldb on disk — the app's masterSecret is one-way-derived into the daemon's access.key and cannot
// be reconstructed, so a real logged-in app credential is required. The secret is NEVER printed.
//
// Usage: node e2e/support/extract-credential.mjs [relayUrl]
// Picks the credential whose token the relay accepts (so the right account is chosen if several
// happy origins are logged in). Falls back to the single candidate. If nothing is found, drop the
// value manually per e2e/README.md.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const RELAY = process.argv[2] || process.env.EXPO_PUBLIC_HAPPY_SERVER_URL || 'http://localhost:3005';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.auth', 'credentials.json');
const RE = /\{"token":"[^"\\]+","secret":"[^"\\]+"\}|\{"secret":"[^"\\]+","token":"[^"\\]+"\}/g;

function scan() {
    const out = new Set();
    for (const browser of ['google-chrome', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge']) {
        const dir = join(homedir(), '.config', browser, 'Default', 'Local Storage', 'leveldb');
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter((x) => /\.(ldb|log)$/.test(x))) {
            let buf;
            try { buf = readFileSync(join(dir, f)); } catch { continue; }
            const s = buf.toString('latin1');
            for (const m of s.match(RE) || []) out.add(m);
            for (const m of s.replace(/\x00/g, '').match(RE) || []) out.add(m);
        }
    }
    return [...out].map((c) => { try { return JSON.parse(c); } catch { return null; } }).filter((o) => o && o.token && o.secret);
}

async function tokenValid(token) {
    try {
        const r = await fetch(`${RELAY}/v1/machines`, { headers: { authorization: `Bearer ${token}` } });
        return r.ok;
    } catch { return false; }
}

const candidates = scan();
if (candidates.length === 0) {
    console.error('[extract-credential] no auth_credentials found in any browser profile. See e2e/README.md to drop it manually.');
    process.exit(2);
}
let chosen = null;
for (const c of candidates) {
    if (await tokenValid(c.token)) { chosen = c; break; }
}
if (!chosen) {
    console.warn(`[extract-credential] none of the ${candidates.length} candidate(s) validated against ${RELAY}; using the first.`);
    chosen = candidates[0];
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ token: chosen.token, secret: chosen.secret }), { mode: 0o600 });
console.log(`[extract-credential] wrote ${OUT} (token len ${chosen.token.length}, secret len ${chosen.secret.length}). Value not printed.`);
