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
};
// English text for codes seen on this fleet (Creality's own messages are sometimes Chinese).
const KLIPPER_TEXT: Record<string, string> = {
  key586: 'Move out of range',
  key789: 'Motor position tracking error too large',          // "位置跟踪误差过大" (K2 closed-loop Z motors)
  key60: 'Internal error',
  key96: 'Must home before probe',
  key840: 'Filament box (CFS) switch state error',
};

/**
 * Creality's firmware mirrors Klipper errors as its own fault codes: 2000 + Klipper's
 * key number (Klipper key586 "Move out of range" -> Creality 2586), with the error's
 * values as the only message (e.g. "[159.578, 362.006, 3.990, 277498.667]").
 * Returns readable text for such a code, or null if it isn't a mirrored Klipper code.
 */
export function describeMirroredKlipperFault(code: number, values: string): string | null {
  if (code < 2000 || code >= 3000) return null;
  const key = `key${code - 2000}`;
  const nums = (values.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const xyz = nums.length >= 3 ? `: X${nums[0].toFixed(1)} Y${nums[1].toFixed(1)} Z${nums[2].toFixed(1)}` : '';
  const text = KLIPPER_TEXT[key] ? `${KLIPPER_TEXT[key]} (${key})${key === 'key586' ? xyz : ''}` : `Klipper error ${key}`;
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
  return { code, text: `${msg}${code ? ` (${code})` : ''}`, hint: code ? KLIPPER_HINTS[code] : undefined };
}
