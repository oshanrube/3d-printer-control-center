/**
 * "Possible jam / printing in air" warnings, from hotend heater power.
 *
 * When filament stops flowing the hotend no longer has plastic to melt, so its heater
 * works less. Heater power barely tracks the commanded flow within a print, but its
 * level is a strong signal (findings from 2026-11-09, see CLAUDE.md):
 *   - Sanji jammed mid-print: power stepped from ~0.43 to ~0.36 (-15%) at the onset.
 *   - Nami under-extruded from early on: 0.35 while healthy Luffy/Sanji ran 0.48/0.44
 *     on the same file, temperature and fan (74% vs 93% of Luffy).
 *
 * Two checks, both warnings only (never pause):
 *   peer: same model + file + target temperature + part-fan speed, printing at the same
 *         time; this printer below PEER_RATIO of the peers' median for HOLD minutes.
 *   self: target unchanged and average part-fan speed matching; the last 5 min at
 *         least SELF_DROP below the median level 15-60 min ago, for HOLD minutes.
 * Both skip the first MIN_RUN minutes of a print. One warning per print.
 */
import { printsRepo } from './db.js';
import type { Fleet } from './fleet.js';
import type { LiveState, PrinterEvent } from './types.js';

export const JAM = {
  MIN_RUN_MIN: 15,
  HOLD_MIN: 5,
  PEER_RATIO: 0.85,        // healthy peers measured 0.93 apart; the jam 0.74
  PEER_WINDOW_MIN: 10,
  FAN_TOLERANCE: 0.05,
  // Jams seen: Sanji -15%, Luffy -12.5%. Healthy prints: at most -6.4%.
  SELF_DROP: 0.10,
  // Reference = median power 15-60 min ago. Ending it 15 min back means a fresh jam
  // can't leak into its own reference before the warning has had time to fire (with
  // a 10-35 min window, Luffy's jam diluted the reference and never held long enough).
  SELF_BASE_FROM_MIN: 60,
  SELF_BASE_TO_MIN: 15,
  SELF_RECENT_MIN: 5,
};

export interface Row { t: number; power: number | null; target: number | null; fan0: number | null }

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const valid = (r: Row) => r.power !== null && r.target !== null && r.fan0 !== null;

/** Mean power + fan over the last `min` minutes (null if too few samples). */
export function recentLevel(rows: Row[], now: number, min = JAM.PEER_WINDOW_MIN): { power: number; fan: number; target: number } | null {
  const w = rows.filter(r => valid(r) && r.t > now - min * 60_000 && r.t <= now);
  if (w.length < min * 2) return null;                   // 20 s rows -> want >= ~2/min
  if (new Set(w.map(r => r.target)).size !== 1) return null;
  return { power: mean(w.map(r => r.power!)), fan: mean(w.map(r => r.fan0!)), target: w[0].target! };
}

/** Self check: fractional drop of the last 5 min vs the median 15-60 min ago, or null if not comparable. */
export function selfDrop(rows: Row[], now: number): number | null {
  const win = rows.filter(r => valid(r) && r.t > now - JAM.SELF_BASE_FROM_MIN * 60_000 && r.t <= now);
  if (!win.length || new Set(win.map(r => r.target)).size !== 1) return null;
  const base = win.filter(r => r.t <= now - JAM.SELF_BASE_TO_MIN * 60_000);
  const recent = win.filter(r => r.t > now - JAM.SELF_RECENT_MIN * 60_000);
  if (base.length < 60 || recent.length < 10) return null;          // >= ~20 min of reference
  // The slicer nudges the part fan layer to layer (e.g. 74-82%); what matters is that the
  // average cooling in the two windows matches.
  if (Math.abs(mean(recent.map(r => r.fan0!)) - mean(base.map(r => r.fan0!))) > JAM.FAN_TOLERANCE) return null;
  return 1 - mean(recent.map(r => r.power!)) / median(base.map(r => r.power!));
}

/** Peer check: this printer's level / median of comparable peers' levels, or null. */
export function peerRatio(me: { power: number; fan: number; target: number }, peers: { power: number; fan: number; target: number }[]): number | null {
  const comparable = peers.filter(p => p.target === me.target && Math.abs(p.fan - me.fan) <= JAM.FAN_TOLERANCE);
  if (!comparable.length) return null;
  return me.power / median(comparable.map(p => p.power));
}

interface Track { printId?: number; peerSince?: number; selfSince?: number; alerted: boolean }

export class JamDetector {
  private tracks = new Map<number, Track>();
  private timer?: NodeJS.Timeout;

  constructor(
    private fleet: Fleet,
    private report: (e: Omit<PrinterEvent, 'createdAt'>) => unknown,
  ) {}

  start() { this.timer = setInterval(() => { try { this.tick(); } catch (e: any) { console.warn('[jam]', e?.message || e); } }, 60_000); }
  stop() { if (this.timer) clearInterval(this.timer); }

  tick(now = Date.now()) {
    const printing = this.fleet.getStates().filter(s => s.online && s.state === 'printing' && s.printDuration >= JAM.MIN_RUN_MIN * 60);
    const info = printing.map(s => {
      const open = printsRepo.open(s.printerId);
      if (!open) return null;
      const rows = printsRepo.powerSince(open.id, now - (JAM.SELF_BASE_FROM_MIN + 1) * 60_000);
      return { s, printId: open.id, rows, level: recentLevel(rows, now), model: this.fleet.model(s.printerId) };
    }).filter((x): x is NonNullable<typeof x> => !!x);

    for (const me of info) {
      const t = this.tracks.get(me.s.printerId) ?? { alerted: false };
      if (t.printId !== me.printId) { Object.assign(t, { printId: me.printId, peerSince: undefined, selfSince: undefined, alerted: false }); }
      this.tracks.set(me.s.printerId, t);
      if (t.alerted) continue;

      // Peer check
      let ratio: number | null = null; let peerNames: string[] = [];
      if (me.level) {
        const peers = info.filter(o => o !== me && o.level && o.s.filename === me.s.filename
          && (!me.model || !o.model || o.model === me.model));
        ratio = peerRatio(me.level, peers.map(p => p.level!));
        peerNames = peers.filter(p => p.level!.target === me.level!.target && Math.abs(p.level!.fan - me.level!.fan) <= JAM.FAN_TOLERANCE)
          .map(p => this.fleet.client(p.s.printerId)?.printer.name || `Printer ${p.s.printerId}`);
      }
      if (ratio !== null && ratio < JAM.PEER_RATIO) t.peerSince ??= now; else t.peerSince = undefined;

      // Self check
      const drop = selfDrop(me.rows, now);
      if (drop !== null && drop >= JAM.SELF_DROP) t.selfSince ??= now; else t.selfSince = undefined;

      const hold = JAM.HOLD_MIN * 60_000;
      const peerHit = t.peerSince !== undefined && now - t.peerSince >= hold;
      const selfHit = t.selfSince !== undefined && now - t.selfSince >= hold;
      if (!peerHit && !selfHit) continue;
      t.alerted = true;
      this.warn(me.s, peerHit ? { kind: 'peer', ratio: ratio!, peers: peerNames } : { kind: 'self', drop: drop! });
    }
  }

  private warn(s: LiveState, why: { kind: 'peer'; ratio: number; peers: string[] } | { kind: 'self'; drop: number }) {
    const name = this.fleet.client(s.printerId)?.printer.name || `Printer ${s.printerId}`;
    const detail = why.kind === 'peer'
      ? `Its hotend heater is working ${Math.round((1 - why.ratio) * 100)}% less than ${why.peers.join(' and ')} on the same file, which usually means little or no plastic is flowing.`
      : `Its hotend heater power dropped ${Math.round(why.drop * 100)}% and stayed down, at the same temperature and fan speed, which usually means filament stopped flowing.`;
    this.report({
      printerId: s.printerId, printerName: name, type: 'jam_suspected', severity: 'warning',
      title: `🧵 ${name}: possible jam / printing in air`,
      message: `${detail} Check the camera.`,
      filename: s.filename ?? null, actionTaken: null,
    });
  }
}
