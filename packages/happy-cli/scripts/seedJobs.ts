/**
 * Seeds the isolated HAPPY_HOME_DIR jobStore with deterministic E04/E05 records for the committed
 * web-E2E (runs / crons / event-subscriptions screens). Mirrors e2eSeedVault.ts: writes directly to
 * the jobs.db BEFORE the daemon starts, so the screens render real-but-safe RPC data.
 *
 * Safety: NO 'pending' jobs are seeded — the scheduler's claimNext() only claims pending jobs, so
 * terminal (succeeded/failed) and gate-parked (needs-attention) jobs are never spawned. The seeded
 * cron uses a far-future expression and the event subscription only fires on an explicit git.commit
 * trigger, so neither auto-fires during a test run.
 *
 * Requires: HAPPY_HOME_DIR set. Run: HAPPY_HOME_DIR=~/.happy-e10-e2e tsx scripts/seedJobs.ts
 */
import { join } from 'node:path'
import { JobStore, type JobRecord } from '@/daemon/jobs/jobStore'
import { CronStore } from '@/daemon/jobs/cronStore'
import { EventStore } from '@/daemon/jobs/eventStore'
import { configuration } from '@/configuration'

const DIR = '/home/joshuam/code/demo'
const NOW = Date.now()

// Fill all 30 JobRecord columns; overrides set the fields a given seed cares about.
function job(overrides: Partial<JobRecord> & Pick<JobRecord, 'id' | 'status' | 'prompt'>): JobRecord {
    return {
        triggerType: 'manual',
        triggerMetadata: '{}',
        tier: 'supervised',
        preset: 'local-qwen',
        untrustedInput: null,
        directory: DIR,
        attempts: 1,
        maxAttempts: 3,
        sessionId: null,
        sessionPid: null,
        scheduledAt: null,
        claimedAt: null,
        timeoutAt: null,
        finishedAt: null,
        exitReason: null,
        costUsd: null,
        maxBudgetUsd: null,
        maxTurns: null,
        gitHeadBefore: null,
        gitHeadAfter: null,
        dispositionTopic: null,
        gateAction: null,
        gateBucket: null,
        gateReason: null,
        gateResolved: null,
        account: null,
        createdAt: NOW,
        ...overrides,
    }
}

function main() {
    const dbPath = join(configuration.happyHomeDir, 'jobs.db')

    const jobStore = new JobStore(dbPath)
    jobStore.init()

    // 1) Gate-parked job (E05): needs-attention + exitReason 'gate:*' drives the verdict rows +
    //    approve/reject buttons; untrustedInput=1 drives the "Untrusted input: Yes" row.
    jobStore.create(job({
        id: 'seed-job-gate',
        status: 'needs-attention',
        tier: 'trusted',
        prompt: 'Refactor the authentication module to use the new token store',
        exitReason: 'gate:hold',
        gateAction: 'hold',
        gateBucket: 'thin',
        gateReason: 'No disposition data for this topic yet — held for your approval',
        gateResolved: null,
        untrustedInput: 1,
        dispositionTopic: 'architecture/api-design',
        costUsd: 0,
        createdAt: NOW,
    }))

    // 1b) Second gate-parked job, dedicated to the live reject round-trip (machineResolveGate):
    //     rejecting drives it to 'dead' with NO spawn attempt, so the assertion is deterministic.
    jobStore.create(job({
        id: 'seed-job-gate2',
        status: 'needs-attention',
        tier: 'trusted',
        prompt: 'Rewrite the billing export to stream rows',
        exitReason: 'gate:hold',
        gateAction: 'hold',
        gateBucket: 'thin',
        gateReason: 'No disposition data for this topic yet — held for your approval',
        gateResolved: null,
        dispositionTopic: 'architecture/api-design',
        costUsd: 0,
        createdAt: NOW - 10_000,
    }))

    // 2) Succeeded + gate-resolved (UX-006): verdict rows are HIDDEN once resolved, only the topic
    //    row remains. Trusted tier, has a cost for the cost-line assertion.
    jobStore.create(job({
        id: 'seed-job-ok',
        status: 'succeeded',
        tier: 'trusted',
        prompt: 'Update the changelog for the 1.2 release',
        dispositionTopic: 'process/docs',
        gateAction: 'proceed',
        gateBucket: 'high-trust',
        gateReason: 'high trust — proceeded autonomously',
        gateResolved: 1,
        costUsd: 0.42,
        maxBudgetUsd: 5,
        claimedAt: NOW - 90_000,
        finishedAt: NOW - 30_000,
        createdAt: NOW - 100_000,
    }))

    // 3) Failed + supervised: exercises the failed status label + supervised tier + exit reason.
    jobStore.create(job({
        id: 'seed-job-fail',
        status: 'failed',
        tier: 'supervised',
        prompt: 'Run the database migration on the staging schema',
        exitReason: 'error: command timed out',
        costUsd: 0.1,
        claimedAt: NOW - 200_000,
        finishedAt: NOW - 150_000,
        createdAt: NOW - 200_000,
    }))

    const cronStore = new CronStore(dbPath)
    cronStore.init()
    // Far-future expression (Jan 1 03:00) so the feeder never fires it during a test.
    cronStore.create({
        id: 'seed-cron-1',
        cronExpr: '0 3 1 1 *',
        directory: DIR,
        prompt: 'Nightly cleanup of stale branches',
        tier: 'supervised',
        preset: 'local-qwen',
        untrustedInput: true,
        dispositionTopic: 'process/maintenance',
        enabled: true,
        createdAt: NOW,
    })

    const eventStore = new EventStore(dbPath)
    eventStore.init()
    // git.commit only fires on an explicit trigger-event, never auto-fires.
    eventStore.create({
        id: 'seed-event-1',
        eventType: 'git.commit',
        matchKey: 'main',
        directory: DIR,
        prompt: 'Review the latest commit for security regressions',
        tier: 'supervised',
        preset: 'local-qwen',
        untrustedInput: true,
        dispositionTopic: 'security/review',
        enabled: true,
        createdAt: NOW,
    })

    console.log('[e2e-seed-jobs] seeded 3 jobs, 1 cron, 1 event-subscription into', dbPath)
}

main()
