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

## Naad naar S3/S4 (nog te bouwen)

- **S3 (live switch):** `authProxy.remap` bestaat al en is getest. S3 bouwt de
  `accountSwitch`-verb (twee surfaces: HTTP + RPC, BUG-UAT-1-patroon) die `remap`
  aanroept voor een set sessies + de multi-select migratie-popup. De daemon moet
  dan `routingKey → sessionId` bijhouden om sessies te adresseren.
- **S4 (usage):** de `unified-*` headers komen al ongewijzigd door de proxy (de
  authProxy-test bevestigt dat). S4 voegt de scrape + `usageStore` toe in de
  `upRes`-callback van `authProxy.ts`.
