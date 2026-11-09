/**
 * Reference-run comparison: does this print look like a successful run of the same file
 * at the same step?
 *
 * Klipper's progress is the position in the G-code file, so the same progress on two
 * runs of the same file is the same layer. On the K1C/K2 the bed drops with Z while
 * the camera is fixed, so at the same step the part should look the same; a jam or a
 * detached part shows up as missing / different material.
 *
 * Method (validated on 2026-11-09, see CLAUDE.md): frames -> 96x54 greyscale, ignore
 * the top 42% (toolhead/gantry), z-score normalise (exposure), take the per-pixel
 * median of ~3 frames around the step on each run (removes the moving toolhead), and
 * score the mean absolute difference.
 *   same printer, healthy vs healthy: 0.02-0.10
 *   other K1C, healthy vs healthy:    0.15-0.26 (cameras sit slightly differently)
 *   jammed vs healthy:                rises to 0.35-0.65 as material goes missing
 *
 * Reference runs: only other runs of the same file that **completed successfully**
 * (and weren't labelled bad afterwards), or that you labelled "not a failure". Failed
 * and still-running prints are never references. Same printer preferred, then same
 * model. Until a file has a successful run, nothing is compared. Warning only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { config } from './config.js';
import { printsRepo, printersRepo, aiRepo } from './db.js';
import type { Fleet } from './fleet.js';
import type { LiveState, PrinterEvent, RefVerdict } from './types.js';

export const REF = {
  W: 96, H: 54, ROI_TOP: 0.42,
  TOL: 0.0025,                 // +-0.25% progress window around the step
  SAME_PRINTER_LIMIT: 0.20,    // healthy same-printer pairs measured <= 0.10
  CROSS_PRINTER_LIMIT: 0.33,   // healthy cross-printer pairs measured <= 0.26
  CONSECUTIVE: 3,              // checks in a row over the limit before warning
  CHECK_EVERY_MS: 120_000,
  MIN_PROGRESS: 0.01,
};

// ---------- image helpers ----------
type Small = Float32Array;
const cache = new Map<string, Small>();   // path -> small normalised image (bounded below)

export function smallImage(buf: Buffer): Small {
  const { W, H } = REF, roiTop = Math.round(H * REF.ROI_TOP);
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64 });
  const g = new Float32Array(W * H), n = new Float32Array(W * H);
  for (let y = 0; y < img.height; y++) {
    const row = Math.floor(y * H / img.height) * W;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4, j = row + Math.floor(x * W / img.width);
      g[j] += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]; n[j]++;
    }
  }
  for (let j = 0; j < g.length; j++) g[j] /= n[j] || 1;
  let m = 0, c = 0; for (let j = roiTop * W; j < g.length; j++) { m += g[j]; c++; } m /= c;
  let v = 0; for (let j = roiTop * W; j < g.length; j++) v += (g[j] - m) ** 2;
  const sd = Math.sqrt(v / c) || 1;
  for (let j = 0; j < g.length; j++) g[j] = (g[j] - m) / sd;
  return g;
}

function loadSmall(path: string): Small | null {
  const hit = cache.get(path);
  if (hit) return hit;
  try {
    const s = smallImage(readFileSync(path));
    if (cache.size > 4000) cache.delete(cache.keys().next().value!);
    cache.set(path, s);
    return s;
  } catch { return null; }
}

export function medianImage(imgs: Small[]): Small {
  const out = new Float32Array(imgs[0].length), buf = new Array<number>(imgs.length);
  for (let j = 0; j < out.length; j++) {
    for (let k = 0; k < imgs.length; k++) buf[k] = imgs[k][j];
    buf.sort((a, b) => a - b); out[j] = buf[buf.length >> 1];
  }
  return out;
}

export function imageDiff(a: Small, b: Small): number {
  const start = Math.round(REF.H * REF.ROI_TOP) * REF.W;
  let s = 0; for (let j = start; j < a.length; j++) s += Math.abs(a[j] - b[j]);
  return s / (a.length - start);
}

// ---------- reference runs ----------
interface Frame { t: number; progress: number; path: string }
interface Run { printerId: number; printIds: number[]; finalId: number; healthyUntil: number; frames: Frame[] }

const FAILED = new Set(['spaghetti', 'jam', 'layer_shift', 'warping', 'adhesion', 'wrong_file', 'other']);

/** Group a file's print rows into runs (restart fragments + their final row) per printer. */
function runsOf(filename: string): Run[] {
  const rows = printsRepo.byFile(filename);
  const runs: Run[] = [];
  let cur: number[] = [], curPrinter = -1;
  const close = (final: typeof rows[number]) => {
    const ids = [...cur, final.id];
    const frames = printsRepo.frames(ids).map(f => ({ t: f.t, progress: f.progress, path: join(config.dataDir, f.dir, f.file) }));
    // Only successful prints are references. A failed run is never used, not even up to an
    // estimated onset: you can't be sure when it really started going wrong (Luffy's
    // "fine until 55.5%" was only an estimate from heater power). Prints still running
    // aren't used either: they haven't succeeded yet.
    let healthyUntil = 0;
    if (final.ended_at !== null && final.outcome === 'completed' && !FAILED.has(final.failure_reason ?? '')) healthyUntil = 1;
    else if (final.failure_reason === 'not_failed') healthyUntil = Math.max(0, ...frames.map(f => f.progress)); // you stopped a good print
    runs.push({ printerId: final.printer_id, printIds: ids, finalId: final.id, healthyUntil, frames });
    cur = [];
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], next = rows[i + 1];
    if (r.printer_id !== curPrinter) { cur = []; curPrinter = r.printer_id; }
    // Old reconnect bug: a print split into an 'unknown' row + a new row of the same file
    // started right after. Treat that as one run.
    const splitByReconnect = r.outcome === 'unknown' && next && next.printer_id === r.printer_id
      && r.ended_at !== null && next.started_at - r.ended_at < 5 * 60_000;
    if (r.outcome === 'continued' || splitByReconnect) cur.push(r.id);
    else close(r);
  }
  return runs;
}

function medianNear(frames: Frame[], p: number, latestOnly = false): Small | null {
  // Reference: frames within +-TOL of the step. Current print: its last 3 frames, as long
  // as they're within 2*TOL (only ~2-3 frames are saved per TOL window, fewer after a restart).
  const near = latestOnly
    ? frames.filter(f => f.progress <= p + 1e-6 && p - f.progress <= 2 * REF.TOL).slice(-3)
    : frames.filter(f => Math.abs(f.progress - p) <= REF.TOL);
  if (near.length < 2) return null;
  const imgs = near.slice(0, 7).map(f => loadSmall(f.path)).filter((x): x is Small => !!x);
  return imgs.length >= 2 ? medianImage(imgs) : null;
}

interface Track { printId?: number; over: number; warned: boolean; lastAt: number; refFrame?: string }

export class RefComparer {
  private tracks = new Map<number, Track>();
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private fleet: Fleet, private report: (e: Omit<PrinterEvent, 'createdAt'>) => unknown) {}

  start() { this.timer = setInterval(() => { this.tick().catch(e => console.warn('[ref]', e?.message || e)); }, 15_000); }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Path of the reference frame shown for a printer's current step (for the Compare view). */
  referenceFrame(printerId: number): string | undefined { return this.tracks.get(printerId)?.refFrame; }

  /** Why a printer does / doesn't have a reference right now (diagnostics endpoint). */
  explain(printerId: number) {
    const s = this.fleet.getState(printerId);
    if (!s?.filename) return { error: 'not printing a file' };
    const open = printsRepo.open(printerId);
    const runs = runsOf(s.filename);
    const mine = runs.find(r => open && r.printIds.includes(open.id));
    return {
      printer: printerId, file: s.filename, progress: s.progress, openPrint: open?.id ?? null,
      myRun: mine ? { printIds: mine.printIds, frames: mine.frames.length, framesNearNow: mine.frames.filter(f => Math.abs(f.progress - s.progress) <= REF.TOL).length } : null,
      track: this.tracks.get(printerId) ?? null,
      candidates: runs.filter(r => r !== mine).map(r => ({
        printer: r.printerId, finalPrint: r.finalId, printIds: r.printIds, healthyUntil: Math.round(r.healthyUntil * 1000) / 10,
        frames: r.frames.length, framesNearNow: r.frames.filter(f => Math.abs(f.progress - s.progress) <= REF.TOL).length,
        usable: r.healthyUntil >= s.progress + REF.TOL,
      })),
    };
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const s of this.fleet.getStates()) {
        const t = this.tracks.get(s.printerId) ?? { over: 0, warned: false, lastAt: 0 };
        this.tracks.set(s.printerId, t);
        const printing = s.online && s.state === 'printing' && !!s.filename;
        // A result only describes the print it was made for: clear it the moment that
        // print ends or another one starts (otherwise the card kept showing an old run's
        // "Differs" and its mid-print reference frame next to a new print's first layers).
        const open = printing ? printsRepo.open(s.printerId) : undefined;
        if (!printing || (open && t.printId !== undefined && open.id !== t.printId)) {
          if (t.refFrame || s.reference) this.fleet.setReference(s.printerId, null);
          Object.assign(t, { printId: open?.id, over: 0, warned: false, refFrame: undefined, lastAt: 0 });
          if (!printing) continue;
        }
        if (s.progress < REF.MIN_PROGRESS) continue;
        if (now - t.lastAt < REF.CHECK_EVERY_MS) continue;
        t.lastAt = now;
        this.check(s, t);
        await new Promise(r => setImmediate(r));   // keep the event loop responsive between printers
      }
    } finally { this.busy = false; }
  }

  private check(s: LiveState, t: Track) {
    const open = printsRepo.open(s.printerId);
    if (!open) return;
    if (t.printId !== open.id) Object.assign(t, { printId: open.id, over: 0, warned: false, refFrame: undefined });

    const runs = runsOf(s.filename!);
    const mine = runs.find(r => r.printIds.includes(open.id));
    if (!mine) return;
    const p = s.progress;
    const cur = medianNear(mine.frames.filter(f => f.progress <= p + 1e-6), p, true);
    if (!cur) return;

    const myModel = this.fleet.model(s.printerId);
    const candidates = runs
      .filter(r => r !== mine && r.healthyUntil >= p + REF.TOL)
      .map(r => ({ r, same: r.printerId === s.printerId, model: this.fleet.model(r.printerId) }))
      .filter(c => c.same || !myModel || !c.model || c.model === myModel)
      .sort((a, b) => Number(b.same) - Number(a.same) || b.r.finalId - a.r.finalId);   // same printer first, then newest
    for (const c of candidates) {
      const ref = medianNear(c.r.frames, p);
      if (!ref) continue;
      const score = imageDiff(cur, ref);
      const limit = c.same ? REF.SAME_PRINTER_LIMIT : REF.CROSS_PRINTER_LIMIT;
      const refName = printersRepo.get(c.r.printerId)?.name || `Printer ${c.r.printerId}`;
      const nearest = c.r.frames.reduce((a, f) => (Math.abs(f.progress - p) < Math.abs(a.progress - p) ? f : a));
      t.refFrame = nearest.path;
      t.over = score > limit ? t.over + 1 : 0;
      const verdict: RefVerdict = {
        ok: score <= limit, score: Math.round(score * 100) / 100, limit, samePrinter: c.same,
        refPrinterName: refName, refPrintId: c.r.finalId, at: Date.now(),
        progress: Math.round(p * 1000) / 10, refProgress: Math.round(nearest.progress * 1000) / 10,
      };
      this.fleet.setReference(s.printerId, verdict);
      aiRepo.add({
        printerId: s.printerId, printId: open.id, t: Date.now(), snapshot: null, source: 'reference',
        assessment: verdict.ok ? 'success' : 'inconclusive', confidence: null, reason: `vs ${refName} run #${c.r.finalId}`,
        defects: [], progress: p, model: c.same ? 'same-printer' : 'cross-printer', latencyMs: null, raw: null, score, risk: null,
      });
      if (t.over >= REF.CONSECUTIVE && !t.warned) {
        t.warned = true;
        const name = this.fleet.client(s.printerId)?.printer.name || `Printer ${s.printerId}`;
        this.report({
          printerId: s.printerId, printerName: name, type: 'reference_mismatch', severity: 'warning',
          title: `📐 ${name}: doesn't look like a successful run`,
          message: `At ${Math.round(p * 100)}% the camera view differs from ${c.same ? 'an earlier successful run on this printer' : `${refName}'s successful run`} of the same file `
            + `(difference ${verdict.score}, normal ≤ ${limit}). Part may be missing, detached or not growing. Check the camera.`,
          filename: s.filename ?? null, actionTaken: null,
        });
      }
      return;   // one reference per check
    }
    this.fleet.setReference(s.printerId, null);
  }
}
