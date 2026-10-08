/** Raw listening events remain authoritative even without resolved song metadata. */
export function latestPlayedAtBySongId(
  events: Iterable<{ s: number; t: number }>,
): Map<number, number> {
  const latest = new Map<number, number>();
  for (const { s, t } of events) {
    if (!Number.isInteger(s) || s <= 0 || !Number.isFinite(t)) continue;
    latest.set(s, Math.max(latest.get(s) ?? -Infinity, t));
  }
  return latest;
}
