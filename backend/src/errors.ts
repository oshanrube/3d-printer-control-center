/**
 * Klipper (Creality build) reports errors as JSON, e.g.
 *   {"code":"key586","msg":"Move out of range: 10.000 345.000 1.862 [266817.130]","values":[...]}
 * and the JSON is sometimes malformed ({"code":"key61, "msg":...}), so fall back to regexes.
 */

// Hints only for codes confirmed on this fleet.
const KLIPPER_HINTS: Record<string, string> = {
  key586: 'A move went outside the build area. This usually means the file was sliced for a different printer model.',
  key789: 'A closed-loop motor could not follow its commanded position: the axis may be blocked, binding or overloaded.',
  key60: 'Klipper crashed while running a command, usually as a consequence of an earlier error.',
  key839: 'No other slot holds the same filament to switch to, so the printer paused. Load filament in that slot (or a matching spool), then resume.',
  key845: 'Filament could not be pushed through the nozzle (seen on the K2 while purging after a CFS filament change), so the printer paused. Clear the nozzle (cold pull or needle; check the cutter and the PTFE path from the box), check filament reaches the hotend, then resume.',
};
// English text for codes seen on this fleet (Creality's own messages are sometimes Chinese).
const KLIPPER_TEXT: Record<string, string> = {
  key586: 'Move out of range',
  key789: 'Motor position tracking error too large',          // "位置跟踪误差过大" (K2 closed-loop Z motors)
  key60: 'Internal error',
  key96: 'Must home before probe',
  key840: 'Filament box (CFS) switch state error',
  key839: 'Out of filament: none reached the extruder from the filament box', // "no filament detected at box extrude position"
  key845: 'Nozzle blocked',                                   // "the nozzle is blocked" (K2, during a CFS flush, 2026-11-18)
};

/**
 * Creality's firmware mirrors Klipper errors as its own fault codes: 2000 + Klipper's
 * key number (Klipper key586 "Move out of range" -> Creality 2586), with the error's
 * values as the only message (e.g. "[159.578, 362.006, 3.990, 277498.667]").
 * Returns readable text for such a code, or null if it isn't a mirrored Klipper code.
 */
/** CFS errors carry [box, slot], e.g. [1, "A"] -> "box 1, slot A". */
function cfsSlot(values: string): string {
  const m = String(values || '').match(/(\d+)\s*,\s*"?([A-Da-d])"?/);
  return m ? ` (CFS box ${m[1]}, slot ${m[2].toUpperCase()})` : '';
}
const CFS_KEYS = new Set(['key839', 'key840']);

export function describeMirroredKlipperFault(code: number, values: string): string | null {
  if (code < 2000 || code >= 3000) return null;
  const key = `key${code - 2000}`;
  const nums = (values.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const xyz = nums.length >= 3 ? `: X${nums[0].toFixed(1)} Y${nums[1].toFixed(1)} Z${nums[2].toFixed(1)}` : '';
  const where = key === 'key586' ? xyz : CFS_KEYS.has(key) ? cfsSlot(values) : '';
  const text = KLIPPER_TEXT[key] ? `${KLIPPER_TEXT[key]}${where} (${key})` : `Klipper error ${key}`;
  return KLIPPER_HINTS[key] ? `${text}. ${KLIPPER_HINTS[key]}` : text;
}

export function describeKlipperError(raw: string | undefined | null): { code?: string; text: string; hint?: string } {
  const s = String(raw || '').trim();
  if (!s) return { text: '' };
  let code: string | undefined;
  let msg: string | undefined;
  let values: string[] = [];
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object') {
      code = typeof j.code === 'string' ? j.code : undefined;
      msg = typeof j.msg === 'string' ? j.msg : undefined;
      if (Array.isArray(j.values)) values = j.values.map((v: any) => String(v));
    }
  } catch {
    code = s.match(/\b(key\d+)\b/)?.[1];
    msg = s.match(/"msg"\s*:\s*"([^"]*)"/)?.[1];
  }
  if (!msg) return { text: s };
  // Prefer our English text when Creality's message isn't (e.g. key789 is in Chinese).
  if (code && KLIPPER_TEXT[code] && /[^\x00-\x7F]/.test(msg)) msg = KLIPPER_TEXT[code];
  if (code === 'key789' && values.length) msg = `${msg} on ${values.join(', ')}`;
  if (code && CFS_KEYS.has(code) && KLIPPER_TEXT[code]) msg = `${KLIPPER_TEXT[code]}${cfsSlot(values.join(','))}`;
  return { code, text: `${msg}${code ? ` (${code})` : ''}`, hint: code ? KLIPPER_HINTS[code] : undefined };
}
