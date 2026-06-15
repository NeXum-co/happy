// src/disposition/gate.ts
/**
 * E05 confidence gate — pure. Maps a job's dispositionTopic to an autonomy
 * action via the disposition-rollup buckets (D-E05-1). Tier-agnostic: the caller
 * applies the effective tier for 'proceed-supervised'. Fail-closed: any unknown
 * or missing data resolves to 'hold' (D-E05-5).
 */
import type { DispositionRollup, DispositionBucket, GateAction, GateVerdict } from './types';

const BUCKET_ACTION: Record<DispositionBucket, GateAction> = {
  'high-trust': 'proceed',
  'modify-prone': 'proceed-supervised',
  'mixed': 'escalate',
  'override-prone': 'hold',
  'thin': 'hold',
};

export function evaluate(topic: string | null | undefined, rollup: DispositionRollup | null): GateVerdict {
  if (!topic || !rollup) {
    return { action: 'hold', bucket: 'thin', matchedTopic: null, reason: 'no disposition data (fail-closed)' };
  }
  const exact = rollup.topics[topic];
  if (exact) {
    return { action: BUCKET_ACTION[exact.bucket], bucket: exact.bucket, matchedTopic: topic, reason: `topic ${topic} = ${exact.bucket}` };
  }
  const domainKey = topic.split('/')[0];
  const domain = rollup.domains[domainKey];
  if (domain) {
    return { action: BUCKET_ACTION[domain.bucket], bucket: domain.bucket, matchedTopic: domainKey, reason: `domain ${domainKey} = ${domain.bucket}` };
  }
  return { action: 'hold', bucket: 'thin', matchedTopic: null, reason: `no entry for ${topic} (fail-closed)` };
}
