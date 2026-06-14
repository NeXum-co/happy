/**
 * Projection of JobRecord for external consumption via RPC and HTTP.
 *
 * JobRecordView omits triggerMetadata (internal implementation detail) so that
 * the dashboard can display job data without leaking scheduling internals.
 */

import type { JobRecord } from './jobTypes'

export type JobRecordView = Omit<JobRecord, 'triggerMetadata'>

export function toJobRecordView(j: JobRecord): JobRecordView {
    const { triggerMetadata, ...view } = j
    return view
}
