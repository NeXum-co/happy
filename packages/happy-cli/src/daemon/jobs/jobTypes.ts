/**
 * Durable autonomous-job record types.
 *
 * A JobRecord is the persisted unit of autonomous work the daemon claims and
 * runs. Status follows the state machine in ./stateMachine.ts; numeric fields
 * are epoch milliseconds. Optional fields are absent until the relevant
 * lifecycle moment (claim, timeout, finish) sets them.
 */

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'needs-attention';
export type JobTier = 'trusted' | 'supervised';
export type TriggerType = 'manual' | 'cron' | 'event';

export interface JobRecord {
  id: string;
  triggerType: TriggerType;
  triggerMetadata: string;   // JSON string
  tier: JobTier;
  preset: string;            // e.g. 'local-qwen' (default) or a cloud preset
  directory: string;
  prompt: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;       // default 5
  sessionId?: string;
  scheduledAt?: number;      // epoch ms
  claimedAt?: number;
  timeoutAt?: number;
  finishedAt?: number;
  exitReason?: string;
  costUsd?: number;
  createdAt: number;
}
