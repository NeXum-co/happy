import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configuration } from '@/configuration'
import { submitEventSubscription } from '@/daemon/controlClient'

const DEFAULT_PROMPT = 'Review the latest commit on this repo and report issues.'
const DEFAULT_TIER: 'supervised' | 'trusted' = 'supervised'
const PRESET = 'local-qwen'

/**
 * Render the post-commit hook script text (pure — no IO).
 *
 * The generated script, at commit time:
 *  - captures the commit sha, branch and message from git,
 *  - reads the daemon control port from `statePath` (daemon.state.json),
 *  - POSTs a `git.commit` event to the daemon's `/trigger-event` endpoint,
 *  - never fails the commit (`|| true`, `exit 0`).
 *
 * `repoRoot` is embedded literally as the subscription matchKey; the runtime
 * `$sha` is used as the idempotencyKey so re-runs on the same commit dedupe.
 */
export function renderPostCommitHook(opts: { repoRoot: string; statePath: string }): string {
  const { repoRoot, statePath } = opts
  return `#!/bin/sh
# Happy event trigger — git.commit (auto-generated, do not edit)
# Never fails the commit.

sha="$(git rev-parse HEAD 2>/dev/null)" || exit 0
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0
message="$(git log -1 --pretty=%s 2>/dev/null)" || exit 0

state_file="${statePath}"
[ -f "$state_file" ] || exit 0
port="$(grep -o '"httpPort"[[:space:]]*:[[:space:]]*[0-9]*' "$state_file" | grep -o '[0-9]*$')"
[ -n "$port" ] || exit 0

curl -s -X POST "http://127.0.0.1:$port/trigger-event" \\
  -H 'Content-Type: application/json' \\
  -d '{"eventType":"git.commit","matchKey":"${repoRoot}","idempotencyKey":"'"$sha"'","payload":{"sha":"'"$sha"'","branch":"'"$branch"'","message":"'"$message"'"}}' \\
  >/dev/null 2>&1 || true

exit 0
`
}

/**
 * Action for `happy event install-git-hook`. Creates a git.commit subscription
 * on the running daemon and installs a post-commit hook that triggers it.
 */
export async function handleEventCommand(args: string[]): Promise<void> {
  const subcommand = args[0]

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printHelp()
    return
  }

  if (subcommand !== 'install-git-hook') {
    console.error(chalk.red(`Unknown event subcommand: ${subcommand}`))
    printHelp()
    process.exit(1)
  }

  let prompt = DEFAULT_PROMPT
  let tier: 'supervised' | 'trusted' = DEFAULT_TIER
  const rest = args.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--prompt') {
      prompt = rest[++i]
      if (prompt === undefined) {
        console.error(chalk.red('--prompt requires a value'))
        process.exit(1)
      }
    } else if (arg === '--tier') {
      const value = rest[++i]
      if (value !== 'supervised' && value !== 'trusted') {
        console.error(chalk.red(`Invalid --tier value: ${value}. Must be 'supervised' or 'trusted'`))
        process.exit(1)
      }
      tier = value
    } else if (arg === '-h' || arg === '--help') {
      printHelp()
      return
    } else {
      console.error(chalk.red(`Unknown argument for event install-git-hook: ${arg}`))
      process.exit(1)
    }
  }

  // 1. Resolve repo root.
  let repoRoot: string
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
  } catch {
    console.error(chalk.red('Not a git repository. Run this command inside a git repo.'))
    process.exit(1)
  }

  // 2. Check the hook FIRST, before creating a subscription, to avoid orphans.
  const hookPath = join(repoRoot, '.git', 'hooks', 'post-commit')
  if (existsSync(hookPath)) {
    console.error(chalk.red(`A post-commit hook already exists: ${hookPath}`))
    console.error(chalk.yellow('Refusing to overwrite. Remove or merge it manually, then re-run.'))
    process.exit(1)
  }

  // 3. Create the subscription on the running daemon.
  const result = await submitEventSubscription({
    eventType: 'git.commit',
    matchKey: repoRoot,
    directory: repoRoot,
    prompt,
    tier,
    preset: PRESET,
  })

  if (result.error || !result.subscriptionId) {
    console.error(chalk.red('Could not reach the daemon — start the daemon first:'))
    console.error(chalk.cyan('  happy daemon start'))
    if (result.error) {
      console.error(chalk.gray(`  (${result.error})`))
    }
    process.exit(1)
  }

  // 4. Write the hook and make it executable.
  const script = renderPostCommitHook({ repoRoot, statePath: configuration.daemonStateFile })
  writeFileSync(hookPath, script, { encoding: 'utf8' })
  chmodSync(hookPath, 0o755)

  console.log(chalk.green('✓ Installed git.commit event trigger'))
  console.log(chalk.gray(`  Subscription: ${result.subscriptionId}`))
  console.log(chalk.gray(`  Hook:         ${hookPath}`))
}

function printHelp(): void {
  console.log(`
${chalk.bold('happy event')} - Manage event triggers

${chalk.bold('Usage:')}
  happy event install-git-hook [--prompt "..."] [--tier supervised|trusted]

${chalk.bold('install-git-hook')} (run inside a git repo)
  Creates a git.commit subscription on the running daemon and installs a
  post-commit hook that triggers it on every commit.

${chalk.bold('Options:')}
  --prompt "..."              Prompt for the triggered job
                              (default: "${DEFAULT_PROMPT}")
  --tier supervised|trusted   Execution tier (default: supervised)

${chalk.bold('Note:')} The daemon must be running. Start it with ${chalk.cyan('happy daemon start')}.
`)
}
