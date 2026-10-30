/** Screen-only marker offsets: the underlying feature coordinates never move. */
export function layoutSoundMapOrigins(
  origins: readonly { songId: number; x: number; y: number }[],
  width: number,
  height: number,
): Map<number, { dx: number; dy: number }> {
  const placed: { x: number; y: number }[] = [];
  const offsets = new Map<number, { dx: number; dy: number }>();
  for (const origin of origins) {
    if (origin.x < 0 || origin.y < 0 || origin.x > width || origin.y > height) continue;
    let chosen = { x: origin.x, y: origin.y };
    search: for (let ring = 0; ring <= origins.length; ring++) {
      for (let step = 0; step < (ring === 0 ? 1 : 12); step++) {
        const angle = step * Math.PI / 6;
        const candidate = {
          x: Math.max(16, Math.min(width - 16, origin.x + Math.cos(angle) * ring * 32)),
          y: Math.max(16, Math.min(height - 16, origin.y + Math.sin(angle) * ring * 32)),
        };
        if (placed.every(p => Math.hypot(p.x - candidate.x, p.y - candidate.y) >= 29)) {
          chosen = candidate; break search;
        }
      }
    }
    placed.push(chosen);
    offsets.set(origin.songId, { dx: chosen.x - origin.x, dy: chosen.y - origin.y });
  }
  return offsets;
}
