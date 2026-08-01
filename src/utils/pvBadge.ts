import type { PV, PVService, PVType } from '../types/vocadb';

export interface PVBadgeStyle {
  background: string;
  color: string;
  border?: string;
}

type PVBadgePalette = {
  original: PVBadgeStyle;
  unofficial: PVBadgeStyle;
};

const PV_BADGE_PALETTES: Partial<Record<PVService, PVBadgePalette>> = {
  Youtube: {
    original: {
      background: 'rgba(239, 68, 68, 0.15)',
      color: '#ef4444',
      border: '1px solid rgba(239, 68, 68, 0.3)',
    },
    unofficial: {
      background: 'rgba(100, 30, 30, 0.3)',
      color: '#b91c1c',
      border: '1px solid rgba(100, 30, 30, 0.4)',
    },
  },
  NicoNicoDouga: {
    original: {
      background: 'rgba(59, 130, 246, 0.15)',
      color: '#3b82f6',
      border: '1px solid rgba(59, 130, 246, 0.3)',
    },
    unofficial: {
      background: 'rgba(30, 30, 100, 0.3)',
      color: '#1e40af',
      border: '1px solid rgba(30, 30, 100, 0.4)',
    },
  },
  SoundCloud: {
    original: {
      background: 'rgba(249, 115, 22, 0.14)',
      color: '#fb923c',
      border: '1px solid rgba(249, 115, 22, 0.28)',
    },
    unofficial: {
      background: 'rgba(90, 45, 15, 0.3)',
      color: '#a16207',
      border: '1px solid rgba(90, 45, 15, 0.42)',
    },
  },
  Bilibili: {
    original: {
      background: 'rgba(56, 189, 248, 0.14)',
      color: '#38bdf8',
      border: '1px solid rgba(56, 189, 248, 0.28)',
    },
    unofficial: {
      background: 'rgba(24, 65, 90, 0.3)',
      color: '#326477',
      border: '1px solid rgba(24, 65, 90, 0.42)',
    },
  },
};

const FALLBACK_PALETTE: PVBadgePalette = {
  original: {
    background: 'rgba(148, 163, 184, 0.15)',
    color: '#cbd5e1',
    border: '1px solid rgba(148, 163, 184, 0.28)',
  },
  unofficial: {
    background: 'rgba(71, 85, 105, 0.3)',
    color: '#94a3b8',
    border: '1px solid rgba(71, 85, 105, 0.42)',
  },
};

export function getPVBadgeStyle(service: PVService, pvType: PVType): PVBadgeStyle {
  const palette = PV_BADGE_PALETTES[service] ?? FALLBACK_PALETTE;
  return pvType === 'Original' ? palette.original : palette.unofficial;
}

export function isUnofficialOnly(pvs: Array<Pick<PV, 'service' | 'pvType' | 'disabled'>>, service: PVService): boolean {
  const servicePVs = pvs.filter(pv => !pv.disabled && pv.service === service);
  return servicePVs.length > 0 && servicePVs.every(pv => pv.pvType !== 'Original');
}
