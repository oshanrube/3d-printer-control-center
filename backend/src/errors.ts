/**
 * Klipper (Creality build) reports errors as JSON, e.g.
 *   {"code":"key586","msg":"Move out of range: 10.000 345.000 1.862 [266817.130]","values":[...]}
 * and the JSON is sometimes malformed ({"code":"key61, "msg":...}), so fall back to regexes.
 */

// Hints only for codes confirmed on this fleet.
const KLIPPER_HINTS: Record<string, string> = {
  key586: 'A move went outside the build area. This usually means the file was sliced for a different printer model.',
};

export function describeKlipperError(raw: string | undefined | null): { code?: string; text: string; hint?: string } {
  const s = String(raw || '').trim();
  if (!s) return { text: '' };
  let code: string | undefined;
  let msg: string | undefined;
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object') {
      code = typeof j.code === 'string' ? j.code : undefined;
      msg = typeof j.msg === 'string' ? j.msg : undefined;
    }
  } catch {
    code = s.match(/\b(key\d+)\b/)?.[1];
    msg = s.match(/"msg"\s*:\s*"([^"]*)"/)?.[1];
  }
  if (!msg) return { text: s };
  return { code, text: `${msg}${code ? ` (${code})` : ''}`, hint: code ? KLIPPER_HINTS[code] : undefined };
}
