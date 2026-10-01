/** Same deterministic control-group assignment as backend/segval/services/holdout.py. */
const BUCKETS = 10_000;

export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function inControl(segmentId: string, memberKey: string, holdoutPct: number): boolean {
  if (holdoutPct <= 0) return false;
  return fnv1a32(`${segmentId}:${memberKey}`) % BUCKETS < Math.round((holdoutPct * BUCKETS) / 100);
}
