# happy-app web E2E (Playwright)

Committed, repeatable web-E2E. Built first for the E10 multi-subscription screens; the harness is
generic (reusable for E02 fleet / E08 screens).

## How it works (self-contained — no real account, no live relay)

1. `pnpm e2e:export` produces a static web build in `dist-e2e/` (`expo export`, dev variant).
2. `playwright.config.ts` serves `dist-e2e/` on **:8099** (dependency-free `static-server.mjs`, SPA
   fallback) — never the live app `:8081`.
3. `globalSetup` stands up a **fully isolated backend** and seeds it deterministically:
   - `support/isolatedRelay.ts` boots a throwaway `happy-server` (PGlite, own DATA_DIR in `tmpdir`)
     on **:3099** — never the live relay `:3005`.
   - `support/seedAccount.ts` mints a **synthetic account** headlessly (`POST /v1/auth` with a fresh
     tweetnacl signing key; no QR) and a random 32-byte masterSecret → credential `{token, secret}`.
   - `startTestDaemon` (own `HAPPY_HOME_DIR`) registers a machine on :3099 and seeds **dummy** vault
     accounts for the E10 account screens.
   - `support/seedSessions.ts` seeds a deterministic **fleet**: encrypted-metadata sessions across
     projects, needs-you (remote `requests` via the `update-state` socket), local-attention
     (`localRequest`), idle, and archived (for the "Earlier (N)" collapse) — all decryptable by the
     app via legacy(masterSecret).
4. Fixtures (`e2e/fixtures/app.ts`) inject the relay URL (`window.__HAPPY_CONFIG__.serverUrl`, read
   from `.auth/relay.json`) and the synthetic credential (`localStorage['auth_credentials']`) before
   any app script — so the app boots authed against :3099 and renders the seeded fleet.
5. `globalTeardown` stops the daemon and the relay and removes the throwaway DATA_DIR.

No browser credential, no `pnpm e2e:cred`, no dependency on Joshua's real account — every run is
hermetic and deterministic. `support/credentials.ts` exposes the seeded fleet shape via `loadFleet()`
so specs can assert exact session identities.

## Run

```bash
pnpm e2e:export          # (re)build dist-e2e
pnpm e2e                 # run the suite (serves dist-e2e on :8099)
pnpm e2e:ui              # interactive UI mode
```

Report: `e2e-report/`. Traces/screenshots retained on failure.

## Invariants (do not break)

- Never touch the live relay `:3005` or the live `~/.happy` daemon/vault — the harness uses an
  isolated relay on `:3099` (throwaway PGlite DATA_DIR in `tmpdir`) and the test daemon's own
  `HAPPY_HOME_DIR`. `isolatedRelay.ts` hard-refuses port 3005.
- Never serve the app on `:8081` — this harness uses `:8099`.
- Detached process groups, killed by recorded pgid on teardown — never `pkill` by name.
- Never echo/commit secrets. `e2e/.auth/` (relay.json, credentials.json, fleet.json) is gitignored.
- Seeded vault accounts use **dummy** tokens — the screens only show metadata; usage is fail-soft
  "unknown". Seeded sessions carry synthetic encrypted metadata/agentState only.
