/**
 * Type definitions for scheduled cron jobs.
 *
 * A CronSchedule is the persisted configuration for a recurring autonomous job.
 * The daemon fires it on the given cronExpr and creates a JobRecord each time.
 * Optional budget/turn/timeout/tool caps mirror the per-job controls on JobRecord.
 */

export interface CronSchedule {
  id: string;               // uuid
  cronExpr: string;         // standard 5-field cron expression
  directory: string;
  prompt: string;
  tier: 'trusted' | 'supervised';
  preset: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  timeoutMs?: number;
  allowedTools?: string[];
  dispositionTopic?: string; // E05: topic for the confidence gate on each fired job
  enabled: boolean;
  createdAt: number;        // epoch ms
}

export type CronScheduleView = CronSchedule;
