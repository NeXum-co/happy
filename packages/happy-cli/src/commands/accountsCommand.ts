/**
 * `happy accounts` — beheer Claude-abonnementen in de versleutelde vault (E10).
 *
 * Onboarding = de token-acquisitie (`claude setup-token`) + vault-add. De
 * interactieve setup-token is niet unit-testbaar (no-mocking-regel); de testbare
 * kern (de vault) zit in accountVault.ts. Dit is de dunne CLI-surface eromheen.
 */
import { spawnSync } from 'node:child_process'
import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readCredentials } from '@/persistence'
import { vaultMasterKey, addAccount, listAccounts, removeAccount, setDefaultAccount } from '@/accounts/accountVault'

async function requireMasterKey(): Promise<Uint8Array> {
  const creds = await readCredentials()
  if (!creds) {
    throw new Error('Niet ingelogd op happy (geen access.key). Run `happy` eerst.')
  }
  return vaultMasterKey(creds)
}

async function accountsAdd(name: string, opts: { default?: boolean }): Promise<void> {
  const key = await requireMasterKey()
  console.log('Start `claude setup-token` — log in op het gewenste account…')
  const result = spawnSync('claude', ['setup-token'], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' })
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('`claude setup-token` faalde of leverde geen output.')
  }
  const token = result.stdout.trim().split('\n').pop()!.trim()
  if (!token.startsWith('sk-ant-oat01-')) {
    throw new Error('Geen geldig setup-token ontvangen.')
  }
  await addAccount(configuration.accountsVaultFile, key, { provider: 'claude', name, oauthToken: token, isDefault: opts.default })
  console.log(`Account '${name}' toegevoegd${opts.default ? ' (default)' : ''}.`)
}

async function accountsList(): Promise<void> {
  const accs = await listAccounts(configuration.accountsVaultFile, 'claude')
  if (accs.length === 0) {
    console.log('Geen accounts. Voeg toe met `happy accounts add <naam>`.')
    return
  }
  for (const a of accs) {
    console.log(`${a.isDefault ? '* ' : '  '}${a.name}`)
  }
}

async function accountsRemove(name: string): Promise<void> {
  await removeAccount(configuration.accountsVaultFile, 'claude', name)
  console.log(`Account '${name}' verwijderd.`)
}

async function accountsDefault(name: string): Promise<void> {
  await setDefaultAccount(configuration.accountsVaultFile, 'claude', name)
  console.log(`Default account: '${name}'.`)
}

function showAccountsHelp(): void {
  console.log(`
${chalk.bold('happy accounts')} - Beheer Claude-abonnementen in de versleutelde vault (E10)

${chalk.bold('Usage:')}
  happy accounts add <name> [--default]   Voeg een account toe via 'claude setup-token'
  happy accounts list                     Toon alle accounts (* = default)
  happy accounts remove <name>            Verwijder een account
  happy accounts default <name>           Maak een account de default
  happy accounts help                     Toon dit bericht
`)
}

/** Handle the `happy accounts` subcommand tree (manual-dispatch, mirrors connect.ts). */
export async function handleAccountsCommand(args: string[]): Promise<void> {
  const subcommand = args[0]

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAccountsHelp()
    return
  }

  switch (subcommand.toLowerCase()) {
    case 'add': {
      const name = args[1]
      if (!name) {
        throw new Error('Naam ontbreekt. Gebruik: happy accounts add <naam> [--default]')
      }
      await accountsAdd(name, { default: args.includes('--default') || args.includes('-d') })
      break
    }
    case 'list':
      await accountsList()
      break
    case 'remove': {
      const name = args[1]
      if (!name) {
        throw new Error('Naam ontbreekt. Gebruik: happy accounts remove <naam>')
      }
      await accountsRemove(name)
      break
    }
    case 'default': {
      const name = args[1]
      if (!name) {
        throw new Error('Naam ontbreekt. Gebruik: happy accounts default <naam>')
      }
      await accountsDefault(name)
      break
    }
    default:
      console.error(chalk.red(`Unknown accounts subcommand: ${subcommand}`))
      showAccountsHelp()
      process.exit(1)
  }
}
