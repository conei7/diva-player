export const SOUND_MAP_DIMENSIONS = 1024;

export function readSoundMapAxes(params: URLSearchParams): [number, number] {
  const read = (key: string, fallback: number) => {
    const text = params.get(key);
    const value = text === null ? NaN : Number(text);
    return Number.isInteger(value) && value >= 0 && value < SOUND_MAP_DIMENSIONS ? value : fallback;
  };
  const x = read('axisX', 16);
  const y = read('axisY', 822);
  return [x, y === x ? (x + 1) % SOUND_MAP_DIMENSIONS : y];
}

export function randomSoundMapAxes(current: [number, number], random = Math.random): [number, number] {
  let x = Math.floor(random() * SOUND_MAP_DIMENSIONS);
  const candidate = Math.floor(random() * (SOUND_MAP_DIMENSIONS - 1));
  let y = candidate >= x ? candidate + 1 : candidate;
  if (x === current[0] && y === current[1]) {
    x = (x + 1) % SOUND_MAP_DIMENSIONS;
    if (x === y) y = (y + 1) % SOUND_MAP_DIMENSIONS;
  }
  return [x, y];
}

export function changeSoundMapAxes(params: URLSearchParams, axes: [number, number] | null): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set('layout', axes ? 'features' : 'pca');
  if (axes) {
    next.set('axisX', String(axes[0]));
    next.set('axisY', String(axes[1]));
  } else {
    next.delete('axisX');
    next.delete('axisY');
  }
  for (const key of ['zoom', 'centerX', 'centerY', 'selectedSongId']) next.delete(key);
  return next;
}
