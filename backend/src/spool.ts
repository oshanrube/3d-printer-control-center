// Remaining-filament estimate per printer.
//
// The owner marks a fresh spool (its weight, e.g. 1000 g) and we subtract what's been extruded
// since. Klipper's print_stats.filament_used (mm) resets at each print, so we accumulate its
// GROWTH into a persistent per-printer counter (used_mm); a new print just re-baselines. mm -> g
// uses the filament's density by material. It's an estimate (brand densities vary, purge/waste
// isn't perfectly accounted), but good enough for a "time to swap the spool" bar.

import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS printer_spool (
  printer_id INTEGER PRIMARY KEY,
  total_g REAL NOT NULL DEFAULT 1000,
  used_mm REAL NOT NULL DEFAULT 0,
  material TEXT NOT NULL DEFAULT '',
  set_at INTEGER NOT NULL
)`);

// Typical filament densities (g/cm^3). Brand/colour varies a few %, so this is an estimate.
const DENSITY: Record<string, number> = {
  PLA: 1.24, ABS: 1.04, ASA: 1.07, PETG: 1.27, TPU: 1.21, PC: 1.20, NYLON: 1.14, PA: 1.14, HIPS: 1.04,
};
const DIAM_MM = 1.75;

/** grams per mm of filament = cross-section area (mm^2) x density / 1000 (mm^3 -> cm^3). */
function gPerMm(material: string): number {
  const key = (material || '').toUpperCase().replace(/[^A-Z]/g, '');
  const d = DENSITY[key] ?? 1.24;
  return Math.PI * (DIAM_MM / 2) ** 2 * d / 1000;
}

const lastUsed = new Map<number, number>();   // last filament_used (mm) seen per printer this session

/** Accumulate the growth of this print's filament_used into the persistent spool counter. */
export function recordUsage(printerId: number, filamentUsedMm: number | undefined) {
  if (typeof filamentUsedMm !== 'number' || !(filamentUsedMm >= 0)) return;
  const prev = lastUsed.get(printerId);
  lastUsed.set(printerId, filamentUsedMm);
  if (prev === undefined) return;                 // first sample this session: just set the baseline
  const delta = filamentUsedMm - prev;
  if (delta <= 0) return;                          // a new print reset the counter, or no change
  const row = db.prepare('SELECT 1 FROM printer_spool WHERE printer_id = ?').get(printerId);
  if (!row) return;                               // no spool set for this printer yet
  db.prepare('UPDATE printer_spool SET used_mm = used_mm + ? WHERE printer_id = ?').run(delta, printerId);
}

export interface SpoolInfo { totalG: number; usedG: number; remainingG: number; pct: number; material: string; setAt: number }

export function info(printerId: number): SpoolInfo | null {
  const r = db.prepare('SELECT * FROM printer_spool WHERE printer_id = ?').get(printerId) as any;
  if (!r) return null;
  const usedG = r.used_mm * gPerMm(r.material);
  const remainingG = Math.max(0, r.total_g - usedG);
  const pct = r.total_g > 0 ? Math.max(0, Math.min(1, remainingG / r.total_g)) : 0;
  return { totalG: Math.round(r.total_g), usedG: Math.round(usedG), remainingG: Math.round(remainingG), pct, material: r.material, setAt: r.set_at };
}

/** Mark a fresh spool: set its weight/material and reset the used counter to zero. */
export function setSpool(printerId: number, totalG: number, material: string): SpoolInfo {
  db.prepare(`INSERT INTO printer_spool (printer_id, total_g, used_mm, material, set_at) VALUES (?,?,0,?,?)
    ON CONFLICT(printer_id) DO UPDATE SET total_g = excluded.total_g, used_mm = 0, material = excluded.material, set_at = excluded.set_at`)
    .run(printerId, totalG, material || '', Date.now());
  lastUsed.delete(printerId);   // re-baseline so the current print's already-extruded mm isn't charged to the new spool
  return info(printerId)!;
}
