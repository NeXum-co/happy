/**
 * Projection of JobRecord for external consumption via RPC and HTTP.
 *
 * JobRecordView omits triggerMetadata (internal implementation detail) so that
 * the dashboard can display job data without leaking scheduling internals.
 */

import { z } from 'zod'
import type { JobRecord } from './jobTypes'

export type JobRecordView = Omit<JobRecord, 'triggerMetadata'>

/**
 * Zod schema mirroring JobRecordView, for typed HTTP responses in controlServer.
 * Keep in lockstep with the JobRecordView type (and JobRecord in ./jobTypes).
 */
export const jobRecordViewSchema = z.object({
    id: z.string(),
    triggerType: z.enum(['manual', 'cron', 'event']),
    tier: z.enum(['trusted', 'supervised']),
    preset: z.string(),
    directory: z.string(),
    prompt: z.string(),
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'dead', 'needs-attention']),
    attempts: z.number(),
    maxAttempts: z.number(),
    createdAt: z.number(),
    sessionId: z.string().optional(),
    sessionPid: z.number().optional(),
    scheduledAt: z.number().optional(),
    claimedAt: z.number().optional(),
    timeoutAt: z.number().optional(),
    finishedAt: z.number().optional(),
    exitReason: z.string().optional(),
    costUsd: z.number().optional(),
    maxBudgetUsd: z.number().optional(),
    maxTurns: z.number().optional(),
    gitHeadBefore: z.string().optional(),
    gitHeadAfter: z.string().optional(),
    dispositionTopic: z.string().optional(),
    gateAction: z.string().optional(),
    gateBucket: z.string().optional(),
    gateReason: z.string().optional(),
    gateResolved: z.boolean().optional(),
})

export function toJobRecordView(j: JobRecord): JobRecordView {
    const { triggerMetadata, ...view } = j
    return view
}
