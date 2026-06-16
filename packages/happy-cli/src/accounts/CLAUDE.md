# accounts — versleutelde, provider-generieke account-store (E10)

## Doel

Een versleutelde, provider-generieke account-store onder `~/.happy/accounts.vault.json`.
Per account wordt **alleen** het OAuth-token versleuteld opgeslagen; metadata
(naam, `addedAt`, welke default) is leesbaar. Maakt meerdere Claude-abonnementen
mogelijk; de daemon ontsluit de vault en de proxy injecteert het juiste token.

## Key module

- **`accountVault.ts`** — pure module (geen daemon/proxy-koppeling). Schema +
  KDF-helper + CRUD + `resolveAccount`. Alle functies krijgen `filePath` +
  `masterKey` **expliciet** als argument → unit-testbaar met een tmp-dir en een
  willekeurige sleutel; nooit een interne resolve.

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

## Naad naar S2

`resolveAccount(filePath, masterKey, provider, account?)` levert
`{ name, oauthToken } | null`. S2's `authProxy` ontsluit de vault met
`vaultMasterKey(await readCredentials())` (de daemon-credential) en injecteert
het token als Bearer + `anthropic-beta: oauth-2025-04-20`. Die proxy/daemon-
integratie is **S2**, niet hier.
