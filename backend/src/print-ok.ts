// "Printing fine": the owner's word that the current print is OK, overriding the
// comparison-based detectors (reference run, jam/heater power) and AI auto-pause
// for the rest of that print. E.g. a different filament colour makes the camera
// view differ from the reference run while the print is perfectly fine.
import { kv, printsRepo } from './db.js';

/** Identifies the print a printer is running: its dataset row, else its file. */
export function printKeyOf(printerId: number, filename?: string | null): string {
  const open = printsRepo.open(printerId);
  return open ? `print:${open.id}` : `file:${filename || ''}`;
}

export function markPrintOk(printerId: number, filename?: string | null) {
  kv.set(`printok:${printerId}`, printKeyOf(printerId, filename));
}

export function isPrintOk(printerId: number, filename?: string | null): boolean {
  const v = kv.get(`printok:${printerId}`);
  return !!v && v === printKeyOf(printerId, filename);
}
