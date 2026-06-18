# Autonomous Job Spine (E04)

The daemon's autonomous-job subsystem: durable jobs that the daemon claims and
runs by spawning a Happy session, without anyone watching. Three origins
(manual, cron, event) feed ONE queue and ONE scheduler. The daemon wiring lives
in `../run.ts`; the HTTP/RPC surfaces in `../controlServer.ts` and
`../../api/apiMachine.ts`. See `../CLAUDE.md` for the daemon lifecycle.

## Unified spine (D-E04-4)

There is exactly one `jobs` table and one `JobScheduler`. The three triggers are
just feeders that write a `JobRecord` with a different `triggerType`
(`'manual' | 'cron' | 'event'`) and `triggerMetadata`. Once a row is pending,
execution is identical regardless of origin — the scheduler does not branch on
`triggerType`. If you add a fourth trigger, write to the same table; do NOT add
a parallel queue or scheduler.

- `buildJobFromSubmit` (`scheduler.ts`) → manual jobs
- `buildCronJob` (`cronFeeder.ts`) → cron jobs
- `buildEventJob` (`eventTrigger.ts`) → event jobs

## Stores share one SQLite file

`JobStore`, `CronStore`, and `EventStore` each open their OWN better-sqlite3
connection on the SAME file (`~/.happy/jobs.db`, WAL mode). Three connections,
one file — not a bug. They hold separate tables:

- `jobs` — job INSTANCES (the work units the scheduler runs)
- `cron_schedules` — recurring-job DEFINITIONS (orchestration, not work)
- `event_subscriptions` — event-trigger DEFINITIONS (orchestration, not work)

Definitions never run; they only spawn `jobs` rows. SQLite has no boolean —
`enabled` is INTEGER 0/1; `allowedTools` is JSON TEXT. Each store has a `close()`
called on daemon shutdown AFTER its feeder/scheduler tick loop is stopped, so no
tick queries a closed connection (ARCH-5).

## State machine (`stateMachine.ts`)

Legal transitions only — `assertTransition` throws on anything else:

```
pending  -> running | failed         (failed = the cancel edge, D-E04-17)
running  -> succeeded | failed | needs-attention
failed   -> pending | dead           (retry re-queues; exhausted -> dead)
needs-attention -> running | failed
succeeded, dead = terminal
```

A job reaches `dead` only via `failed`, never directly, so transient vs terminal
failure stays distinguishable. Non-obvious points:

- **`claimNext`** treats an ABSENT `scheduledAt` as immediately claimable. Event
  jobs have no `scheduledAt`; cron/retry jobs do, and are claimed only once
  `scheduledAt <= now`. The claim runs inside a transaction so a pending job is
  handed to exactly one worker.
- **Restart recovery** (`recoverOnStartup`, D-E04-14): jobs left `running` by a
  crashed daemon are checked with a pid-liveness probe. A live detached session
  is left alone (re-queuing would double-run); a dead/unknown pid resets the job
  to `pending`. This DELIBERATELY bypasses the state machine (running -> pending
  is not a legal edge) — it is crash recovery, not a lifecycle step.
- **Cancel-pending edge** (D-E04-17): a queued job cancelled before it ever ran
  goes `pending -> failed (cancelled) -> dead` — the same terminal path a failed
  job takes. It never ran, so there is no session to stop. Cancel lives in the
  `cancelJob` closure (`../run.ts`); a `running` job is refused there and must be
  killed via stop-job instead.

## Idempotency / dedup

Job ids are DETERMINISTIC for the dedup-able triggers, and `createIfAbsent`
(`INSERT OR IGNORE`) makes a repeated insert a no-op:

- cron: `cron:{scheduleId}:{occurrenceMs}`
- event: `event:{subId}:{idempotencyKey}` (e.g. the git sha)

A re-delivered event or a re-scanned cron window therefore cannot create a
duplicate job. Manual jobs and event jobs WITHOUT an idempotencyKey get a random
uuid (no dedup intended).

## Cron feeder (`cronFeeder.ts`)

A polling loop: each tick lists enabled schedules and, for each, enumerates fire
times in the half-open window `(watermark, now]` (`occurrencesBetween`), inserting
one idempotent job per occurrence.

- **NO missed-run catch-up** (D-E04-19). The watermark map (`scannedThrough`) is
  IN-MEMORY and never persisted. A schedule seen for the first time (startup or
  just-created) is lazy-initialised to `now`, so it is watched from this moment
  forward, never from `createdAt`. Persisting the watermark would make the feeder
  replay every fire time that elapsed while the daemon was down — exactly the
  backlog D-E04-19 forbids. Forgetting the watermark on restart is the mechanism.
- Per-schedule try/catch: one bad schedule (unparseable expr, store error) is
  logged and skipped, and its watermark STILL advances so it isn't retried over
  an ever-growing window (SF-4).

## Event trigger (`eventTrigger.ts` + the `triggerEvent` closure)

REACTIVE — there is NO feeder loop (D-E04-24). An event is pushed in via the
`/trigger-event` HTTP endpoint or the `trigger-event` RPC, both of which call the
`triggerEvent` closure in `../run.ts`. That closure:

1. `matchSubscriptions(subs, eventType, matchKey)` — selects enabled subscriptions
   with an exact `eventType` match AND either no `matchKey` or a `matchKey` equal
   to the event's. (`matchKey` for git.commit is the repo path.)
2. `buildEventJob` per match → a pending job with no `scheduledAt` (immediately
   claimable).

`buildEventJob` and `matchSubscriptions` are PURE: time and id come in as
arguments (the closure supplies `Date.now()` and a uuid), so they are
Date/random-free and trivially testable. The v1 event client is the git
post-commit hook installed by `happy event install-git-hook`
(`../../commands/eventGitHook.ts`), which POSTs a `git.commit` event with the
commit sha as the idempotencyKey.

## Tiers, semaphore, circuit breakers

- **Tier** (`'trusted' | 'supervised'`) decides the permission posture passed to
  the spawned session via the SHARED ENV CONTRACT (`tierEnv` in `scheduler.ts`):
  `trusted` → `HAPPY_JOB_PERMISSION_MODE=bypassPermissions`; `supervised` →
  `default` + optional `HAPPY_JOB_ALLOWED_TOOLS`. A `trusted` job is only spawned
  inside a git worktree (`.git` present); otherwise it is parked in
  `needs-attention` (containment guard, AC-3).
- **Semaphore = 1** for LOCAL-preset jobs (`Semaphore(1)` in `../run.ts`): only
  one local-model job runs at a time on this machine. Cloud jobs are NOT gated.
- **Circuit breakers**: `maxBudgetUsd`, `maxTurns`, and a wall-clock `timeoutAt`
  (enforced at the start of every scheduler tick — a job past its timeout is
  killed and driven to `dead`).
- **$0 for local presets** (D-E04-15): cost reporting (`HAPPY_JOB_REPORT_COST`)
  is set only for cloud jobs; local jobs cost nothing and the pricing fallback
  would mis-price them. Preset is local unless it clearly names a cloud preset
  (local-default, D-E04-5).

## E05 confidence gate (pre-spawn)

A second gate runs in `tick()` **directly after the AC-3 containment guard**,
before a job spawns. It calls the pure `evaluate(dispositionTopic, rollup)` (see
`../../disposition/CLAUDE.md`) and writes the verdict onto the job record
(`gateAction` / `gateBucket` / `gateReason`). The verdict drives the spawn:

- **escalate / hold** → park in `needs-attention` with `exitReason='gate:<bucket>'`
  — the SAME containment pattern AC-3 uses — and never spawn. Fail-closed
  (D-E05-5): missing/thin/corrupt disposition data holds.
- **proceed-supervised** → spawn, but with the **effective tier downgraded** to
  `supervised` (a declared `trusted` job loses `bypassPermissions` for this run;
  the persisted tier is untouched) so every tool call goes through `canUseTool`.
- **proceed** → spawn at the declared tier.

A job Joshua has already approved carries `gateResolved` and **skips re-gating**,
so it doesn't re-park. `resolveGate(approve)` drives `needs-attention → running`
and spawns via the shared `runJob()` — the spawn block is extracted out of
`tick()` so both paths share it (D-E05-4); `reject` takes the cancel path
`failed → dead`.

**AC-3 containment runs on BOTH spawn paths** (SEC-002): the
`trustedWithoutWorktree()` guard is checked in `tick()` AND again in `runJob()` /
a `resolveGate` pre-check, so an explicit approve can never spawn a
`trusted`/`bypassPermissions` job outside a git worktree.

A runtime sibling of this gate lives in the keyed session process
(`../../claude/utils/permissionHandler.ts`) and only auto-approves read-only
tools under a high-trust topic (D-E05-8); see `../../disposition/CLAUDE.md`.

## GOTCHA: every management action needs TWO surfaces (BUG-UAT-1)

An app-callable action must be wired in BOTH places or it silently works in one
path and not the other:

1. a control-server HTTP endpoint in `../controlServer.ts` (localhost-only,
   unauthenticated by design — D-E04-25), AND
2. a machine-RPC handler in `apiMachine.setRPCHandlers` (`../../api/apiMachine.ts`).

Both call the SAME closure from `../run.ts`. The git-hook deliberately uses the
HTTP `/trigger-event` path (it runs locally, no relay). When you add a new
management verb, add both surfaces.

## Files

- `jobTypes.ts` / `jobStore.ts` / `stateMachine.ts` — job records, durable store, transitions
- `scheduler.ts` — the worker pool (claim → gate → spawn → bind exit), tier env, `runJob`/`resolveGate`, retry wiring, `buildJobFromSubmit`
- `semaphore.ts` / `retry.ts` — concurrency permit, failure classification + backoff
- `jobView.ts` / `audit.ts` — external projection (drops `triggerMetadata`, keeps the E05 gate fields), per-job git audit
- the E05 gate core lives in `../../disposition/` (its own CLAUDE.md)
- `cronTypes.ts` / `cronStore.ts` / `cronSchedule.ts` / `cronFeeder.ts` — cron definitions, store, pure scheduling, feeder
- `eventTypes.ts` / `eventStore.ts` / `eventTrigger.ts` — event definitions, store, pure matching/build
