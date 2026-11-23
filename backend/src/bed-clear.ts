import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { smallImage, imageDiff } from './ref-compare.js';

/**
 * Camera-based "is the bed clear?" check, for auto-advancing the store queue.
 *
 * Each printer has an empty-bed reference image (taught when the owner first confirms the bed
 * is clear). To check, we grab a frame with the light on and diff it against the reference
 * (same 96x54 greyscale / mean-abs-difference engine as ref-compare, which ignores the top
 * 42% where the gantry sits). A clear bed matches its reference closely; a part left on the
 * bed stands out (measured ~0.9+ vs ~0.1-0.3 for clear-vs-clear). AUTO-START IS GATED on this,
 * so the threshold is conservative and callers require several clear reads in a row.
 */

const DIR = join(config.dataDir, 'bedref');
// A part on the bed measured ~0.9-1.0; a clear bed against its reference ~0.04-0.15 at the same idle position (noisier when
// the bed sits at a slightly different height). Stay well below the "part" band.
export const CLEAR_LIMIT = 0.20;

const small = new Map<number, Float32Array | null>();   // cached reference small-image per printer

function refPath(id: number) { return join(DIR, `p${id}.jpg`); }

/** Teach this printer's empty-bed reference from a frame (light should be on, bed clear). */
export function captureBedRef(printerId: number, jpg: Buffer): boolean {
  try {
    smallImage(jpg);                 // validate it decodes before saving
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(refPath(printerId), jpg);
    small.delete(printerId);
    return true;
  } catch (e) {
    console.warn(`[bed-clear] couldn't save reference for ${printerId}: ${(e as any)?.message || e}`);
    return false;
  }
}

export function hasBedRef(printerId: number): boolean {
  return small.get(printerId) != null || existsSync(refPath(printerId));
}

function refSmall(printerId: number): Float32Array | null {
  if (small.has(printerId)) return small.get(printerId)!;
  let s: Float32Array | null = null;
  try { if (existsSync(refPath(printerId))) s = smallImage(readFileSync(refPath(printerId))); } catch { s = null; }
  small.set(printerId, s);
  return s;
}

/** Difference between a frame and the empty-bed reference, or null if there's no reference. */
export function bedDiff(printerId: number, jpg: Buffer): number | null {
  const ref = refSmall(printerId);
  if (!ref) return null;
  try { return imageDiff(smallImage(jpg), ref); } catch { return null; }
}

/** True when the frame looks like the (clear) reference bed. */
export function looksClear(printerId: number, jpg: Buffer): boolean {
  const d = bedDiff(printerId, jpg);
  return d != null && d <= CLEAR_LIMIT;
}
