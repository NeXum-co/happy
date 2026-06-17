# happy-app web E2E (Playwright)

Committed, repeatable web-E2E. Built first for the E10 multi-subscription screens; the harness is
generic (reusable for E02 fleet / E08 screens).

## How it works

1. `pnpm e2e:export` produces a static web build in `dist-e2e/` (`expo export`, dev variant, relay
   baked to `EXPO_PUBLIC_HAPPY_SERVER_URL`).
2. `playwright.config.ts` serves `dist-e2e/` on **:8099** (dependency-free `static-server.mjs`, SPA
   fallback) — never the live `:8081`.
3. Fixtures (`e2e/fixtures/app.ts`) inject at runtime, before any app script:
   - the relay URL via `window.__HAPPY_CONFIG__.serverUrl`,
   - the app auth credential via `localStorage['auth_credentials']`.
4. `globalSetup` boots an **isolated test daemon** (own `HAPPY_HOME_DIR`, seeded **dummy** accounts,
   a fresh machine on the relay) so the account screens get real-but-safe RPC data. Skipped when no
   credential is present (then only the credential-free smoke runs).

## Credential (local only — never committed)

The daemon's `~/.happy/access.key` is the *dataKey* variant; its masterSecret is one-way-derived and
**cannot** be reconstructed, so the suite needs a real logged-in app credential `{token, secret}`
(the app uses a legacy single-masterSecret scheme — the test daemon's `access.key` is rebuilt in
legacy form from this credential so app↔daemon machine encryption interoperates).

**Automated (recommended):**
```bash
pnpm e2e:cred           # extracts auth_credentials from your local Chrome/Chromium into e2e/.auth/
```
It reads your own browser's localStorage leveldb on disk, picks the credential the relay accepts, and
writes `e2e/.auth/credentials.json` (gitignored, value never printed).

**Manual fallback:** open the web client where you're logged in → DevTools → Application → Local
Storage → copy the `auth_credentials` JSON → save it as `e2e/.auth/credentials.json`
(`{ "token": "...", "secret": "..." }`), or export `HAPPY_E2E_TOKEN` / `HAPPY_E2E_SECRET`.

Without it, the suite runs only `boot.spec.ts` (credential-free smoke) and skips the authed specs.

## Run

```bash
pnpm e2e:export          # (re)build dist-e2e
pnpm e2e                 # run the suite (serves dist-e2e on :8099)
pnpm e2e:ui              # interactive UI mode
```

Report: `e2e-report/`. Traces/screenshots retained on failure.

## Invariants (do not break)

- Never touch the live `~/.happy` daemon/vault — the test daemon uses its own `HAPPY_HOME_DIR`.
- Never serve on `:8081` — this harness uses `:8099`.
- Never echo/commit secrets (`auth_credentials`, tokens). `e2e/.auth/` is gitignored.
- Seeded accounts use **dummy** tokens — the screens only show metadata; usage is fail-soft "unknown".
