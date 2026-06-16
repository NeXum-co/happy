/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

export interface SessionEncryptionData {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  seq: number;
  metadataVersion: number;
  agentStateVersion: number;
}

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  encryption?: SessionEncryptionData;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /** E10: routing-key waarmee deze sessie via de authProxy aan een account hangt (live-switch via remap). */
  routingKey?: string;
  /** E10: het Claude-account waaraan deze sessie momenteel gebonden is. */
  account?: string;
}