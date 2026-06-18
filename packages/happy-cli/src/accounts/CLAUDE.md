# accounts — versleutelde, provider-generieke account-store (E10)

## Doel

Een versleutelde, provider-generieke account-store onder `~/.happy/accounts.vault.json`.
Per account wordt **alleen** het OAuth-token versleuteld opgeslagen; metadata
(naam, `addedAt`, welke default) is leesbaar. Maakt meerdere Claude-abonnementen
mogelijk; de daemon ontsluit de vault en de proxy injecteert het juiste token.

## Key modules

- **`accountVault.ts`** — pure module (geen daemon/proxy-koppeling). Schema +
  KDF-helper + CRUD + `resolveAccount`. Alle functies krijgen `filePath` +
  `masterKey` **expliciet** als argument → unit-testbaar met een tmp-dir en een
  willekeurige sleutel; nooit een interne resolve.
- **`authProxy.ts`** (S2) — localhost-only (127.0.0.1) forward-proxy op een
  **ephemeral** poort (`listen(0)`). In-memory `routingKey → {account, realToken}`-
  map; `register/remap/unregister/stop`. Swapt de Bearer, injecteert
  `anthropic-beta: oauth-2025-04-20`, stript `x-api-key`, forward+**streamt** naar
  upstream (default `api.anthropic.com`; injecteerbaar voor tests). Geen
  HTTP-control-endpoint — de daemon roept de methodes direct aan (`remap` wordt in
  S3 de `accountSwitch`-verb).
- **`accountBinding.ts`** (S2) — pure `applyAccountBinding(extraEnv, opts, deps)`:
  resolve account (vault-naad) → register routing-key in de proxy → muteer
  `extraEnv` (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`) → signaleer API-key-strip.
  Expliciete deps (vaultFile, masterKey, proxy, mintKey) → unit-testbaar met een
  fake proxy + tmp vault.

## S2-invarianten (authProxy + binding)

- **`anthropic-beta: oauth-2025-04-20` is verplicht** (D-E10-11): `api.anthropic.com`
  weigert een geïnjecteerd subscription-OAuth-token **zonder** die flag met HTTP 429,
  **mét** de flag 200 (S0-bevinding). De proxy merget 'm met een bestaande waarde.
- **Echte tokens alleen in proxy-geheugen** (AC-7): de sessie-env krijgt enkel de
  routing-key als `ANTHROPIC_AUTH_TOKEN`. De binding-test bewaakt dat het echte
  token niet in `extraEnv` voorkomt.
- **Engaged-only binding** (D-E10-13): binding engaget alleen bij een expliciet
  `account` óf een geconfigureerde default; anders passeert de cloud-spawn
  ongewijzigd (backward-compat). **Fail-closed** (AC-6) geldt alleen als binding
  engaged is en resolve/proxy dan faalt → de spawn wordt geweigerd, nooit stil op
  een verkeerd account.
- **Eén binding-chokepoint** (D-E10-14): de binding leeft uitsluitend in
  `spawnSession` (`daemon/run.ts`). Scheduler/feeders rijgen alleen `account` door
  naar `SpawnSessionOptions.account`. Eén plek voor proxy-registratie én
  `ANTHROPIC_API_KEY`-strip, voor interactief én autonoom.
- **Alleen cloud-Claude** (D-E10-3): local-preset-spawns zetten al
  `ANTHROPIC_BASE_URL` (local-qwen) → binding skipt ze; niet-claude agents idem.
- **`account` is een nullable kolom** (D-E10-15) op `jobs`/`cron_schedules`/
  `event_subscriptions` (idempotente `ALTER TABLE ADD COLUMN`). NB: cron/event-store
  persisteren nu ook `dispositionTopic` (was een pre-existing gat → E05-gate zag
  altijd undefined → fail-closed hold).

## Invarianten (niet schenden)

- **Token nooit plaintext** at-rest of in logs (AC-1/AC-7). Het token gaat als
  `encrypt(masterKey, 'dataKey', token)` (AES-256-GCM) naar `oauthTokenEnc`
  (base64). De token-hygiëne-test in `accountVault.test.ts` bewaakt dat de
  letterlijke token-string niet in het vault-bestand op schijf voorkomt.
- **Fail-closed** (AC-6): een corrupt/onverwacht vault-bestand laat `loadVault`
  throwen; een onbekend account of een verkeerde sleutel laat `resolveAccount`
  `null` teruggeven (decrypt → `null`, niet raden). Nooit een token gokken of
  een leeg/partieel resultaat als geldig behandelen.
- **KDF-usage-string `'Happy Accounts'` + path `['vault']` is een one-way-door.**
  De vault-sleutel = `deriveKey(masterSecret, 'Happy Accounts', ['vault'])`.
  Wijzig deze string/path niet: bestaande vaults worden dan onontsleutelbaar.
- **Eén default-pointer per provider.** De default is `provider.defaultAccount`
  (single source of truth), niet een per-account `isDefault`-bool. `listAccounts`
  projecteert dit terug naar `isDefault`. Dit voorkomt een twee-defaults-bug —
  niet "verbeteren" naar per-account booleans.
- **Provider-generiek schema** (one-way-door): `providers[<provider>]` is een map,
  niet hardcoded op `claude`. De CLI gebruikt nu alleen `claude`, maar het
  schema-niveau blijft generiek.

## S3-invarianten (live switch) ✅

- **`accountSwitch.ts`** — pure `applyAccountSwitch(sessionIds, {account}, deps)`:
  resolve het doel-account **één keer** (fail-closed bij null → nul remaps, AC-6),
  dan per sessie `lookupRoutingKey` → `proxy.remap`. Ongebonden sessie → `skipped`,
  nooit een fout die de batch kapt. Expliciete deps (vaultFile, masterKey, proxy,
  lookupRoutingKey) → unit-testbaar (4 tests).
- **`routingKey`/`account` op `TrackedSession`** (`daemon/types.ts`): de daemon bezit
  de sessie↔routing-key-associatie (de `authProxy` blijft een domme `key→{account,
  token}`-map, D-E10-14). `applyAccountBinding` geeft de gemunte `routingKey` + account
  nu **terug** (was: weggegooid); `spawnSession` zet ze op de `TrackedSession` (tmux +
  non-tmux via de `spawnTrackedHappyProcess`-params). De webhook-merge muteert het
  bestaande object → ze overleven het toevoegen van `happySessionId`. `resumeSession`
  (reconnect) krijgt geen binding → geen routing-key (scope-grens, ongemoeid).
- **`accountSwitch`-verb = twee surfaces** (BUG-UAT-1): HTTP `/account-switch`
  (`controlServer.ts`) + RPC `account-switch` (`apiMachine.ts`) roepen dezelfde
  `accountSwitch`-closure in `run.ts` aan. `/list` projecteert nu `account` (voer voor
  de migratie-popup; de popup-UI zelf is app-werk, S5).
- **AC-7 onaangetast:** alleen de routing-key (niet het echte token) staat in de
  sessie-env; `TrackedSession.routingKey` is in-daemon-geheugen (niet-geheime indirectie).

## S4-invarianten (usage) ✅

- **`usageStore.ts`** — pure module (geen daemon/proxy-import): per-account
  `{ fiveHourUtil, sevenDayUtil, seenAt }` (utilisatie als fractie 0..1). `record`
  parset de `unified-5h/7d-utilization` headers, `snapshot` geeft een kopie.
  `now` injecteerbaar voor deterministische tests.
- **Proxy blijft dom** (D-E10-14): `authProxy` importeert `usageStore` NIET. Het krijgt
  een optionele `onResponse(account, headers)`-callback (in de `upRes`-callback); de
  daemon bedraadt die naar `usageStore.record` (`run.ts`). De proxy weet niets van de store.
- **Fail-soft** (D-E10-6): ontbrekende/niet-numerieke header → veld blijft `null`; een
  eerder-geziene waarde wordt nooit overschreven door een latere response zonder de
  header; géén signaal → géén phantom-entry. Nooit een verzonnen getal.
- **Twee read-surfaces** (BUG-UAT-1): HTTP `/usage` (`controlServer.ts`) + RPC
  `get-usage` (`apiMachine.ts`) lezen dezelfde `usageStore.snapshot()` via de
  `getUsage`-closure in `run.ts` → `{ usage: Record<account, AccountUsage> }`.
- **AC-7 ongemoeid:** usage = percentages (groen), geen tokens; niets nieuws in de sessie-env.

## S5.1-invarianten (app-management-surface) ✅

- **Account-management op twee surfaces** (BUG-UAT-1, D-E10-17): HTTP (`controlServer.ts`) +
  RPC (`apiMachine.ts`) over de bestaande `accountVault`-CRUD via dunne closures in `run.ts`:
  `list-accounts`, `add-account` (`{name, token, isDefault?}`), `set-default-account` (`{name}`),
  `remove-account` (`{name}`). De closures hergebruiken `vaultMasterKey(creds)` +
  `configuration.accountsVaultFile` (zelfde vorm als de `accountSwitch`-closure).
- **`list` is nu óók een RPC** (was HTTP-only): een gedeelde `listSessions`-closure in `run.ts`
  projecteert `{happySessionId, startedBy, pid, account?}`; zowel HTTP `/list` als RPC `list`
  roepen 'm aan. Levert de app de live per-sessie-account-map (gekeyd op `happySessionId`) voor
  de migratie-popup. De daemon-`TrackedSession` is de verse bron (remap kan 'm wijzigen) —
  géén account in server-gesyncte sessie-metadata.
- **`add-account` token-hygiëne** (security.md): het geplakte `setup-token` reist over het
  machine-encrypted RPC-kanaal en gaat versleuteld de vault in; het token wordt **nóóit gelogd**
  (de debug-regel noemt alleen naam + default-flag). `list-accounts` lekt geen token —
  `AccountInfo` heeft typstructureel geen token-veld.

## S6-invarianten (burnPolicy) ✅

- **`burnPolicy.ts`** — twee **pure** beslis-functies (geen daemon/proxy/IO-import, deps als
  argument, deterministisch — zoals `usageStore`/`accountSwitch`):
  - `chooseBurnAccount(usage, config)` → spawn-time keuze: eerste account in `order` met ruimte
    (`util < thresholdPct`), of `escalate` als álle vol, of `inactive` (policy uit / lege order).
  - `planBurnRemap(sessions, usage, config)` → lopende sessies waarvan het account de drempel
    raakt verschuiven naar het eerste account met ruimte (alleen als dat verschilt — geen thrashing).
  - `util(account) = max(fiveHourUtil ?? 0, sevenDayUtil ?? 0)` — **`null`-usage telt als ruimte**
    (0%), nooit als uitputting (fail-soft, D-E10-6). We blokkeren nooit op afwezige data.
- **Config op de vault** (`accountVault.ts`): `providers[provider].burnPolicy?` (optioneel → bestaande
  vaults blijven valide). `getBurnPolicy` geeft de uit-default `{enabled:false, order:[], thresholdPct:0.9}`
  als ze afwezig is; `setBurnPolicy` schrijft atomic. Drempel = fractie 0..1.
- **Spawn-binding** (D-E10-14, één chokepoint): `applyAccountBinding` krijgt `burnPolicy` + `usage` als
  optionele deps. Zónder expliciet `opts.account` + policy aan → `chooseBurnAccount`: `selected` →
  bind dat account; `escalate` → **default-fallback + `warning`** (D-E10-19, géén `ok:false` — de
  spawn faalt niet, de daemon `logger.warn`'t de warning). Een expliciet account slaat de policy over.
  Fail-closed (AC-6) blijft enkel voor een verkeerd/onontsleutelbaar account.
- **Monitor** (D-E10-20): `runBurnMonitorOnce` in `run.ts` draait op het heartbeat-interval (naast de
  reaper), **alleen als de policy aanstaat**: `planBurnRemap(account-bound sessies, usageStore.snapshot(),
  policy)` → per doel-account één `accountSwitch` (= S3-remap, geen respawn). **Throwt nooit** (try/catch,
  volgende tick). No-op bij lege plan → geen log-spam; de "alle vol"-zichtbaarheid zit op het spawn-pad.
- **Twee surfaces** (BUG-UAT-1): `get-burn-policy`/`set-burn-policy` op HTTP (`controlServer.ts`) + RPC
  (`apiMachine.ts`) via de `getBurnPolicyVerb`/`setBurnPolicyVerb`-closures. `set-burn-policy` valideert
  de shape (enabled bool, order non-empty strings, thresholdPct finite in [0,1]).
