/**
 * Seeds an isolated HAPPY_HOME_DIR account-vault with DUMMY claude accounts + a burn-policy, for the
 * committed web-E2E (E10). Dummy tokens only — the screens render account metadata + fail-soft usage,
 * so no real Anthropic token is needed (and none is ever written). Real-token inference stays in the
 * CLI runbook (TC-E10-M05), not here.
 *
 * Requires: HAPPY_HOME_DIR set, and access.key already copied into it (same account → vault KDF).
 * Run: HAPPY_HOME_DIR=~/.happy-e10-e2e tsx scripts/e2eSeedVault.ts
 */
import { readCredentials } from '@/persistence'
import { vaultMasterKey, addAccount, setBurnPolicy, listAccounts } from '@/accounts/accountVault'
import { configuration } from '@/configuration'

async function main() {
    const vaultFile = configuration.accountsVaultFile
    const creds = await readCredentials()
    if (!creds) {
        console.error('[e2e-seed] no access.key in HAPPY_HOME_DIR — copy ~/.happy/access.key first')
        process.exit(1)
    }
    const masterKey = await vaultMasterKey(creds)
    const accounts = [
        { name: 'A', isDefault: true },
        { name: 'B', isDefault: false },
        { name: 'C', isDefault: false },
    ]
    for (const a of accounts) {
        await addAccount(vaultFile, masterKey, {
            provider: 'claude',
            name: a.name,
            oauthToken: `dummy-e2e-token-${a.name}`,
            isDefault: a.isDefault,
        })
    }
    await setBurnPolicy(vaultFile, 'claude', { enabled: true, order: ['A', 'B', 'C'], thresholdPct: 0.9 })
    const list = await listAccounts(vaultFile, 'claude')
    console.log('[e2e-seed] seeded:', JSON.stringify(list))
}

main().catch((e) => {
    console.error('[e2e-seed] failed:', e instanceof Error ? e.message : e)
    process.exit(1)
})
