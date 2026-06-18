/**
 * Autonomous job scheduler / worker pool.
 *
 * On each tick the scheduler atomically claims the oldest eligible pending job
 * from the store and runs it by spawning a Happy session. The tier decides the
 * permission posture passed to the spawned agent via environment variables
 * (the SHARED ENV CONTRACT a sibling phase consumes). Local-preset jobs are
 * gated through a semaphore so only N run concurrently on this machine; cloud
 * jobs are not gated.
 *
 * Containment gate (D-E04-2 / AC-3): a 'trusted' (bypassPermissions) job is only
 * allowed to run trusted when its directory is a LINKED git worktree, its branch
 * is not main/master, and it is not flagged as processing untrusted input.
 * Otherwise it is parked in 'needs-attention' (with a specific exitReason) and
 * never spawned.
 *
 * `spawn` is injected as a constructor dependency so the scheduler stays
 * testable with a fake spawn over a real store/semaphore/retry stack.
 */

import { execFileSync } from 'node:child_process'
import { logger } from '@/ui/logger'
import type { JobStore } from './jobStore'
import type { Semaphore } from './semaphore'
import type { JobRecord } from './jobTypes'
import { classifyFailure, shouldRetry, backoffMs } from './retry'
import { captureGitState } from './audit'
import { evaluate } from '@/disposition/gate'
import { loadRollup as loadRollupReal } from '@/disposition/rollup'
import type { DispositionRollup } from '@/disposition/types'
import type { JobTier } from './jobTypes'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers'

/**
 * Default circuit-breakers (D-E04-6). EVERY autonomous job gets a concrete
 * budget, turn, and wall-clock ceiling at build time, so a job submitted with no
 * caps can never run unbounded (the "27M-token infinite loop" risk). A caller
 * value always overrides the default. The budget default is a no-op safety for
 * local ($0) jobs and a real cap for cloud presets.
 */
export const DEFAULT_MAX_TURNS = 50
export const DEFAULT_MAX_BUDGET_USD = 5
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000 // 30 min wall-clock

/**
 * Git containment facts for a job's directory, used by the trusted-job gate
 * (D-E04-2). `isWorktree` is true only for a LINKED git worktree (common-dir
 * differs from git-dir); `branch` is the current branch or null when it cannot
 * be resolved.
 */
export interface GitContainment {
  isWorktree: boolean
  branch: string | null
}

/**
 * Real git-containment probe: a directory is a linked worktree when its
 * git-common-dir resolves DIFFERENTLY from its git-dir. Any git failure (not a
 * repo, detached, git missing) degrades to the safe `{ isWorktree: false, branch:
 * null }`, which parks a trusted job rather than running it.
 */
function realGitContainment(dir: string): GitContainment {
  try {
    const commonDir = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()
    const gitDir = execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim()
    const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    return { isWorktree: commonDir !== gitDir, branch: branch.length > 0 ? branch : null }
  } catch (error) {
    logger.debug(`[JOB SCHEDULER] gitContainment probe failed for ${dir}, treating as non-worktree:`, error)
    return { isWorktree: false, branch: null }
  }
}

interface SchedulerDeps {
  store: JobStore
  localSemaphore: Semaphore
  spawn: (opts: SpawnSessionOptions) => Promise<SpawnSessionResult>
  killSession?: (sessionId: string) => void
  killOnly?: (sessionId: string) => void
  gitContainment?: (dir: string) => GitContainment
  intervalMs?: number
  now?: () => number
  backoff?: (attempt: number) => number
  // E05: the pre-spawn gate reads the disposition-rollup. Injected so tests pass
  // a fake without touching the filesystem (mirrors the spawn/now deps); defaults
  // to the real read-only loader.
  loadRollup?: () => DispositionRollup | null
}

interface TriggerMetadata {
  allowedTools?: string[]
}

/**
 * Model-routing env per local preset (D-E04-5 local-default). Applied verbatim
 * to the spawned session's process env so the SDK reaches llama-swap instead of
 * the cloud. HAPPY_JOB_MODEL pins the seed model (remote mode ignores
 * ANTHROPIC_MODEL, so the explicit pin is what actually routes — see
 * resolveSeedMode). A cloud preset is absent here and keeps the daemon default.
 */
const LOCAL_PRESET_ENV: Record<string, Record<string, string>> = {
  'local-qwen': {
    ANTHROPIC_BASE_URL: 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'local',
    ANTHROPIC_MODEL: 'qwen-moe',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen-moe',
    HAPPY_JOB_MODEL: 'qwen-moe',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    API_TIMEOUT_MS: '900000',
  },
}

export class JobScheduler {
  private readonly store: JobStore
  private readonly localSemaphore: Semaphore
  private readonly spawn: (opts: SpawnSessionOptions) => Promise<SpawnSessionResult>
  private readonly killSession?: (sessionId: string) => void
  private readonly killOnly?: (sessionId: string) => void
  private readonly gitContainment: (dir: string) => GitContainment
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly backoff: (attempt: number) => number
  private readonly loadRollup: () => DispositionRollup | null
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(deps: SchedulerDeps) {
    this.store = deps.store
    this.localSemaphore = deps.localSemaphore
    this.spawn = deps.spawn
    this.killSession = deps.killSession
    this.killOnly = deps.killOnly
    this.gitContainment = deps.gitContainment ?? realGitContainment
    this.intervalMs = deps.intervalMs ?? 1000
    this.now = deps.now ?? Date.now
    this.backoff = deps.backoff ?? (attempt => backoffMs(attempt))
    this.loadRollup = deps.loadRollup ?? (() => loadRollupReal())
  }

  /**
   * Build the SHARED ENV CONTRACT for a job. `effectiveTier` is the tier the
   * gate resolved for this run (E05): a 'proceed-supervised' verdict downgrades a
   * declared 'trusted' job to 'supervised' for the permission-mode/allowedTools
   * posture, without mutating the persisted record. Defaults to the declared tier.
   */
  tierEnv(job: JobRecord, effectiveTier: JobTier = job.tier): Record<string, string> {
    const env: Record<string, string> = {
      HAPPY_JOB_PERMISSION_MODE: effectiveTier === 'trusted' ? 'bypassPermissions' : 'default',
    }
    if (effectiveTier === 'supervised') {
      const meta = this.parseTriggerMetadata(job)
      if (Array.isArray(meta.allowedTools) && meta.allowedTools.length > 0) {
        env.HAPPY_JOB_ALLOWED_TOOLS = meta.allowedTools.join(',')
      }
    }
    if (job.maxBudgetUsd !== undefined) env.HAPPY_JOB_MAX_BUDGET_USD = String(job.maxBudgetUsd)
    if (job.maxTurns !== undefined) env.HAPPY_JOB_MAX_TURNS = String(job.maxTurns)
    // Cost reporting is only meaningful for cloud presets (a real Claude model
    // with known pricing). Local jobs cost nothing and would be mis-priced by the
    // pricing fallback, so only cloud jobs are told to report their cost (IMP-4).
    if (!this.isLocal(job)) env.HAPPY_JOB_REPORT_COST = '1'
    // E05: the runtime gate in the keyed session process reads this topic to make
    // its own canUseTool decision (D-E05-7). Slice 3 consumes this env name.
    if (job.dispositionTopic) env.HAPPY_JOB_DISPOSITION_TOPIC = job.dispositionTopic
    Object.assign(env, LOCAL_PRESET_ENV[job.preset] ?? {})
    return env
  }

  /**
   * Parse a job's triggerMetadata, tolerating a corrupt row. A malformed value
   * must not throw out of tick() (which would crash the daemon), so a parse
   * failure degrades to empty metadata with a logged warning.
   */
  private parseTriggerMetadata(job: JobRecord): TriggerMetadata {
    try {
      return JSON.parse(job.triggerMetadata) as TriggerMetadata
    } catch (error) {
      logger.debug(`[JOB SCHEDULER] Corrupt triggerMetadata for job ${job.id}, treating as empty:`, error)
      return {}
    }
  }

  /**
   * A preset is local unless it clearly names a cloud preset. Anything
   * containing 'local'/'qwen' is local, and any preset not prefixed 'cloud'
   * defaults to local (local-default, D-E04-5).
   */
  private isLocal(job: JobRecord): boolean {
    const preset = job.preset.toLowerCase()
    if (preset.includes('local') || preset.includes('qwen')) return true
    return !preset.startsWith('cloud')
  }

  /**
   * Containment verdict for a job about to spawn at `effectiveTier` (D-E04-2 /
   * AC-3 / SEC-002). Returns null when it may run, or a specific exitReason when
   * a TRUSTED (bypassPermissions) job must be parked: it must sit in a LINKED git
   * worktree (not a plain clone), off the protected main/master branch, and not
   * be flagged as processing untrusted external input. Supervised jobs always
   * pass (null). Gating on effectiveTier means an E05 downgrade-to-supervised is
   * honoured — a downgraded job is no longer bypassPermissions, so the trusted-only
   * containment no longer applies. Checked on EVERY spawn path (tick() pre-gate,
   * runJob() chokepoint, resolveGate('approve')) so no path bypasses it (SEC-002).
   */
  private containmentBlock(job: JobRecord, effectiveTier: JobTier): string | null {
    if (effectiveTier !== 'trusted') return null
    const containment = this.gitContainment(job.directory)
    if (!containment.isWorktree) return 'trusted-requires-worktree'
    if (containment.branch === 'main' || containment.branch === 'master') return 'trusted-on-protected-branch'
    if (job.untrustedInput === true) return 'untrusted-requires-supervision'
    return null
  }

  async tick(): Promise<void> {
    this.enforceTimeouts()

    const job = this.store.claimNext(this.now())
    if (!job) return

    // Containment pre-gate (D-E04-2 / AC-3): park an obviously-uncontained trusted
    // job before the E05 eval. The authoritative guard is the runJob() chokepoint
    // on the (possibly E05-downgraded) effectiveTier; this is the early park on
    // the declared tier with a specific exitReason (worktree / protected-branch /
    // untrusted-input). Parking surfaces it to the operator (jobs/CLAUDE.md) —
    // Joshua confirmed park over run-as-supervised (D-E04-sweep-4).
    const preBlock = this.containmentBlock(job, job.tier)
    if (preBlock) {
      this.store.transition(job.id, 'needs-attention', { exitReason: preBlock })
      return
    }

    // E05 pre-spawn confidence gate (D-E05-1/4/7). A job Joshua has already
    // approved (gateResolved) skips the eval and runs at its declared tier; every
    // other job is gated against the disposition-rollup before it spawns.
    let effectiveTier: JobTier = job.tier
    if (!job.gateResolved) {
      const verdict = evaluate(job.dispositionTopic, this.loadRollup())
      this.store.patch(job.id, { gateAction: verdict.action, gateBucket: verdict.bucket, gateReason: verdict.reason })
      // escalate/hold → park in needs-attention (the AC-3 containment pattern),
      // never spawn. Joshua resolves via resolveGate. Fail-closed (D-E05-5).
      if (verdict.action === 'hold' || verdict.action === 'escalate') {
        this.store.transition(job.id, 'needs-attention', { exitReason: `gate:${verdict.bucket}` })
        return
      }
      // proceed-supervised downgrades the effective tier (D-E05-1 tier-floor).
      effectiveTier = verdict.action === 'proceed-supervised' ? 'supervised' : job.tier
    }

    // Audit trail (D-E04-7): record the git HEAD before the job runs so a
    // reviewer can diff what it changed. captureGitState never throws.
    this.store.patch(job.id, { gitHeadBefore: captureGitState(job.directory).head })

    await this.runJob(job, effectiveTier)
  }

  /**
   * Spawn a claimed (running) job under the given effective tier and bind its
   * outcome to the store. Shared by tick() (post-gate) and resolveGate('approve')
   * so the spawn path stays in one place (D-E05-4).
   */
  private async runJob(job: JobRecord, effectiveTier: JobTier): Promise<void> {
    // AC-3/D-E04-2 containment chokepoint (SEC-002): every spawn path passes
    // through here, so a trusted/bypassPermissions job is never spawned outside a
    // linked worktree, on a protected branch, or with untrusted input — not via
    // tick(), and not via resolveGate('approve'). Gates on effectiveTier.
    const block = this.containmentBlock(job, effectiveTier)
    if (block) {
      this.store.transition(job.id, 'needs-attention', { exitReason: block })
      return
    }
    const gated = this.isLocal(job)
    const release = gated ? await this.localSemaphore.acquire() : undefined
    try {
      const opts: SpawnSessionOptions = {
        directory: job.directory,
        agent: 'claude',
        initialPrompt: job.prompt,
        environmentVariables: this.tierEnv(job, effectiveTier),
        sessionName: 'job-' + job.id,
        account: job.account,
      }

      let result: SpawnSessionResult
      try {
        result = await this.spawn(opts)
      } catch (error) {
        this.handleFailure(job, error)
        return
      }

      if (result.type === 'success') {
        // The job stays 'running'; the running -> succeeded transition is
        // driven by the spawned session's lifecycle (P7), not here. The pid is
        // stored so restart recovery can tell a still-alive detached session
        // apart from a dead one (IMP-1).
        this.store.patch(job.id, { sessionId: result.sessionId, sessionPid: result.pid })
        return
      }

      if (result.type === 'requestToApproveDirectoryCreation') {
        // Autonomous jobs cannot answer an approval prompt → permanent failure.
        this.toDead(job, 'directory-creation-required')
        return
      }

      // result.type === 'error'
      this.handleFailure(job, { message: result.errorMessage })
    } finally {
      release?.()
    }
  }

  /**
   * Resolve a gate-parked job (D-E05-4). approve → needs-attention -> running and
   * spawn (honouring a proceed-supervised downgrade); reject → the cancel path
   * needs-attention -> failed -> dead. Returns false if the job is not parked.
   */
  async resolveGate(jobId: string, decision: 'approve' | 'reject'): Promise<boolean> {
    const job = this.store.get(jobId)
    if (!job || job.status !== 'needs-attention') return false

    if (decision === 'approve') {
      const effectiveTier: JobTier = job.gateAction === 'proceed-supervised' ? 'supervised' : job.tier
      // AC-3/D-E04-2 containment holds on the approve path too (SEC-002): refuse to
      // spawn a trusted/bypassPermissions job that is uncontained (no worktree,
      // protected branch, or untrusted input), even on explicit approve.
      const block = this.containmentBlock(job, effectiveTier)
      if (block) {
        this.store.patch(jobId, { gateReason: `approve refused: ${block} (AC-3 / D-E04-2)` })
        return false
      }
      // Clear the gate:* park reason so the approved (now running) job no longer reads
      // as parked (ARCH-003); gateAction/gateBucket stay as historical audit and
      // gateResolved marks it done.
      this.store.transition(jobId, 'running', { gateResolved: true, exitReason: undefined })
      await this.runJob(job, effectiveTier)
    } else {
      this.store.transition(jobId, 'failed', { exitReason: 'gate-rejected' })
      this.store.transition(jobId, 'dead', { finishedAt: this.now() })
    }
    return true
  }

  /**
   * Bind a spawned session's process exit to its job's terminal transition.
   * Non-job sessions (no matching sessionId) and already-terminal jobs are
   * ignored. success -> succeeded; killed -> needs-attention (operator parked
   * it); crashed -> the normal retry-or-dead failure path.
   */
  onSessionExit(sessionId: string, outcome: 'success' | 'killed' | 'crashed'): void {
    const job = this.store.findBySessionId(sessionId)
    if (!job || job.status !== 'running') return

    if (outcome === 'success') {
      // Audit trail (D-E04-7): capture the git HEAD after the job finished so a
      // reviewer can compare gitHeadBefore/gitHeadAfter or diffSince the before.
      // TODO(E04 review endpoint): wire diffSince into the diff-review endpoint.
      const after = captureGitState(job.directory).head
      this.store.transition(job.id, 'succeeded', { finishedAt: this.now(), gitHeadAfter: after })
      return
    }
    if (outcome === 'killed') {
      this.store.transition(job.id, 'needs-attention', { exitReason: 'killed', finishedAt: this.now() })
      return
    }
    this.handleFailure(job, { message: 'session crashed' })
  }

  /**
   * Wall-clock enforcement: any running job past its timeoutAt is killed and
   * driven to dead with exitReason 'wall-clock-timeout'. Runs at the start of
   * every tick so a stuck session cannot outlive its budget.
   *
   * enforceTimeouts is the SOLE transition authority on the timeout path. It
   * uses `killOnly` to signal the pid WITHOUT any state transition (unlike the
   * operator-stop `killSession`, which synchronously calls onSessionExit and
   * would otherwise race this method's running -> failed -> dead transitions and
   * overwrite the exitReason). `killSession` is intentionally NOT used here.
   */
  private enforceTimeouts(): void {
    const now = this.now()
    for (const job of this.store.list({ status: 'running' })) {
      if (job.timeoutAt === undefined || job.timeoutAt >= now || job.sessionId === undefined) continue
      this.killOnly?.(job.sessionId)
      this.store.transition(job.id, 'failed', { exitReason: 'wall-clock-timeout' })
      this.store.transition(job.id, 'dead', { finishedAt: this.now() })
    }
  }

  private handleFailure(job: JobRecord, error: unknown): void {
    const err = error as { status?: number; message?: string }
    const cls = classifyFailure({ status: err.status, message: err.message })
    const nextAttempt = job.attempts + 1
    const exitReason = err.message ?? `error (status ${err.status ?? 'unknown'})`

    if (shouldRetry(nextAttempt, job.maxAttempts, cls)) {
      this.store.transition(job.id, 'failed', { attempts: nextAttempt, exitReason })
      // Defer the retry by an exponential backoff so a persistently failing job
      // (e.g. a downed local model) is not re-claimed on the very next tick.
      this.store.transition(job.id, 'pending', { scheduledAt: this.now() + this.backoff(nextAttempt) })
    } else {
      this.store.transition(job.id, 'failed', { attempts: nextAttempt, exitReason })
      this.store.transition(job.id, 'dead', { finishedAt: this.now() })
    }
  }

  private toDead(job: JobRecord, exitReason: string): void {
    this.store.transition(job.id, 'failed', { attempts: job.attempts + 1, exitReason })
    this.store.transition(job.id, 'dead', { finishedAt: this.now() })
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.running) return
      this.running = true
      // A throw inside a tick (e.g. an unexpected store error) must not become
      // an unhandled rejection — that would trip the daemon's unhandledRejection
      // handler and shut the whole daemon down for one bad tick. Log and continue.
      this.tick()
        .catch(error => { logger.debug('[JOB SCHEDULER] tick failed, continuing:', error) })
        .finally(() => { this.running = false })
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

export interface SubmitJobParams {
  directory: string
  prompt: string
  tier?: JobRecord['tier']
  preset?: string
  untrustedInput?: boolean
  maxBudgetUsd?: number
  maxTurns?: number
  timeoutMs?: number
  allowedTools?: string[]
  dispositionTopic?: string
  account?: string
}

/**
 * Pure mapping from submit-job params to a fresh pending JobRecord.
 * Defaults: supervised tier, 'local-qwen' preset, 5 max attempts, and the
 * default circuit-breakers (D-E04-6) — every job gets a concrete budget, turn,
 * and wall-clock ceiling; a caller value overrides the default.
 */
export function buildJobFromSubmit(params: SubmitJobParams, now: number, id: string): JobRecord {
  const job: JobRecord = {
    id,
    triggerType: 'manual',
    triggerMetadata: JSON.stringify({ allowedTools: params.allowedTools ?? [] }),
    tier: params.tier ?? 'supervised',
    preset: params.preset ?? 'local-qwen',
    directory: params.directory,
    prompt: params.prompt,
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    timeoutAt: now + (params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    maxBudgetUsd: params.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
    maxTurns: params.maxTurns ?? DEFAULT_MAX_TURNS,
    createdAt: now,
  }
  // timeoutAt/maxBudgetUsd/maxTurns already have the F1 defaults applied in the
  // object literal above (caller value or DEFAULT_*); only the remaining optional
  // fields are copied through here.
  if (params.untrustedInput !== undefined) job.untrustedInput = params.untrustedInput
  if (params.dispositionTopic !== undefined) job.dispositionTopic = params.dispositionTopic
  if (params.account !== undefined) job.account = params.account
  return job
}
