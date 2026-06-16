/**
 * Type definitions for event-triggered jobs.
 *
 * An EventSubscription is the persisted configuration for an autonomous job that
 * fires in response to an event (v1: 'git.commit'). The daemon matches an
 * incoming event against eventType and the optional matchKey, then creates a
 * JobRecord. Optional budget/turn/timeout/tool caps mirror the per-job controls
 * on JobRecord.
 */

export interface EventSubscription {
  id: string;               // uuid
  eventType: string;        // v1: 'git.commit'
  matchKey?: string;        // optional exact-match against payload.matchKey (e.g. repo path)
  directory: string;        // fixed job directory (= the repo for git.commit)
  prompt: string;
  tier: 'trusted' | 'supervised';   // default 'supervised'
  preset: string;                   // default 'local-qwen'
  maxBudgetUsd?: number;
  maxTurns?: number;
  timeoutMs?: number;
  allowedTools?: string[];
  dispositionTopic?: string;        // E05: topic for the confidence gate on each fired job
  account?: string;                 // E10: Claude-account waarop een gefirede cloud-job draait
  enabled: boolean;                 // default true
  createdAt: number;                // epoch ms
}

export type EventSubscriptionView = EventSubscription;
