/**
 * Klipper (Creality build) reports errors as JSON, e.g.
 *   {"code":"key586","msg":"Move out of range: 10.000 345.000 1.862 [266817.130]","values":[...]}
 * and the JSON is sometimes malformed ({"code":"key61, "msg":...}), so fall back to regexes.
 */

interface KlipperKey {
  /** Readable English name (Creality's own text is terse, odd English or Chinese). */
  text: string;
  /** What it usually means / what to do. Only where the cause is clear from this fleet's logs. */
  hint?: string;
  /** The printer pauses the print for it (the K2's filament-box errors run its PAUSE macro at once). */
  pauses?: boolean;
}

// Codes seen on this fleet. The K2 (CFS) codes and their firmware messages come from
// Nico's and Chopper's klippy.log, 2026-11-16..20; each 8xx one was followed by PAUSE.
const KLIPPER_KEYS: Record<string, KlipperKey> = {
  key3: { text: 'Klipper is still starting up', hint: 'Klipper is (re)connecting to its boards. Wait a moment; if it stays, restart the printer.' },
  key16: { text: 'Resume ignored: the print was not paused' },
  key60: { text: 'Internal error', hint: 'Klipper failed while running a command (on the K2 usually homing, G28), normally as a consequence of an earlier error: look at the error before this one.' },
  key61: { text: 'Unknown G-code command', hint: 'The file or a macro sent a command this printer does not know. Usually harmless.' },
  key96: { text: 'Must home before probe' },
  key111: { text: 'Nozzle too cold to extrude', hint: 'The nozzle was below the minimum extrusion temperature. Usually a resume after the printer cooled down while paused: heat the nozzle back to printing temperature before resuming.' },
  key509: { text: 'Nozzle temperature sensor reading out of range', hint: 'The toolhead board reads an impossible nozzle temperature (e.g. -66°C): check the hotend thermistor and its connector on the toolhead.' },
  key564: { text: 'Nozzle not heating as expected', hint: 'The hotend heated slower than Klipper expects: check the heater cartridge, thermistor and their connectors (or a draught/fan blowing on the nozzle).' },
  key586: { text: 'Move out of range', hint: 'A move went outside the build area. This usually means the file was sliced for a different printer model.' },
  key762: { text: 'Bed pressure (load cell) sensor not responding', hint: 'A bed pressure sensor gave no readings, so Klipper shut down. Restart the printer; if it repeats, check the load cell cables under the bed.' },
  key766: { text: 'Homing failed, needs homing again', hint: 'Homing (G28) did not complete, so Klipper shut down. Check nothing blocks the toolhead or bed, restart the printer and home again.' },
  key789: { text: 'Motor position tracking error too large', hint: 'A closed-loop motor could not follow its commanded position: the axis may be blocked, binding or overloaded.' },  // "位置跟踪误差过大"
  // ---- K2 filament box (CFS). Values are [box, slot] where given. ----
  key836: { text: 'Filament from the box did not reach the toolhead', pauses: true,
    hint: 'The box fed filament but the toolhead sensor never saw it: look for a jam, kink or broken strand in the tube between the box and the toolhead, or a chewed filament end. Reload the slot until the toolhead detects it, then resume.' },
  key839: { text: 'Out of filament: none reached the extruder from the filament box', pauses: true,
    hint: 'No other slot holds the same filament to switch to, so the printer paused. Load filament in that slot (or a matching spool), then resume.' },
  key840: { text: 'Filament box (CFS) switch state error', pauses: true,
    hint: 'The box did not finish switching slots. Check the box for a stuck or tangled filament, then resume (or retry the filament change on the screen).' },
  key841: { text: 'Filament cutter did not reset', pauses: true,
    hint: 'After cutting, the cutter sensor did not see the cutter spring back. Check the cutter lever on the toolhead is free (no filament stuck in it), then resume.' },
  key843: { text: 'Filament box could not read the spool tag (RFID)', pauses: true,
    hint: 'The box reader was busy or could not read the spool tag. Usually clears on retry: resume, or reseat the spool.' },
  key844: { text: 'Filament tube connector problem', pauses: true,
    hint: "The firmware reports the tube connector (\"pneumatic joint\") is abnormal and may collapse: check the tube is fully pushed into its connectors at the box and the toolhead and isn't crushed or kinked." },
  key845: { text: 'Nozzle blocked', pauses: true,
    hint: 'Filament could not be pushed through the nozzle (seen while purging after a filament change). Clear the nozzle (cold pull or needle; check the cutter and the tube from the box), check filament reaches the hotend, then resume.' },
  key846: { text: 'Printing in air: the box is feeding slower than the extruder', pauses: true,
    hint: 'The box feeds filament more slowly than the extruder pulls it, so the nozzle is running dry. Check the spool turns freely (not tangled or stuck on its holder) and nothing drags in the tube, then resume.' },
  key849: { text: 'Filament could not be pulled back into the box', pauses: true,
    hint: 'Retracting to the box failed: the filament did not leave the toolhead connection. Check for a jam or a swollen/blobbed filament end at the toolhead, pull it out by hand if needed, then resume.' },
  key852: { text: 'Toolhead and box filament sensors disagree', pauses: true,
    hint: "The toolhead filament sensor and the box sensor don't agree on whether filament is loaded. Check for a piece of filament left in the toolhead or the tube, then resume." },
  key863: { text: 'Filament retracted but the toolhead still detects filament', pauses: true,
    hint: 'After pulling filament back, the toolhead sensor still sees filament: a broken-off piece is probably left in the toolhead. Remove it, then resume.' },
  key865: { text: 'Filament could not be pulled back into the box', pauses: true,
    hint: 'Retracting to the box failed: the filament did not leave the toolhead connection. Check for a jam or a swollen/blobbed filament end at the toolhead, pull it out by hand if needed, then resume.' },
};

/** "[1, "D"]" / ["1","D"] -> " (CFS box 1, slot D)", when the values hold a box and slot. */
function cfsSlot(values: string): string {
  const m = String(values || '').match(/(\d+)\s*,\s*['"]?([A-Da-d])['"]?/);
  return m ? ` (CFS box ${m[1]}, slot ${m[2].toUpperCase()})` : '';
}
const isCfs = (key: string) => /^key8[3-6]\d$/.test(key);

/** True when the printer pauses the print itself for this Klipper key (e.g. "key836"). */
export function klipperKeyPauses(key: string | undefined): boolean {
  return !!(key && KLIPPER_KEYS[key]?.pauses);
}

/**
 * Creality's firmware mirrors Klipper errors as its own fault codes: 2000 + Klipper's
 * key number (Klipper key586 "Move out of range" -> Creality 2586), with the error's
 * values as the only message (e.g. "[159.578, 362.006, 3.990, 277498.667]").
 * Returns readable text for such a code, or null if it isn't a mirrored Klipper code.
 */
export function describeMirroredKlipperFault(code: number, values: string): string | null {
  if (code < 2000 || code >= 3000) return null;
  const key = `key${code - 2000}`;
  const k = KLIPPER_KEYS[key];
  const nums = (values.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const xyz = nums.length >= 3 ? `: X${nums[0].toFixed(1)} Y${nums[1].toFixed(1)} Z${nums[2].toFixed(1)}` : '';
  const where = key === 'key586' ? xyz : isCfs(key) ? cfsSlot(values) : '';
  const text = k ? `${k.text}${where} (${key})` : `Klipper error ${key}`;
  return k?.hint ? `${text}. ${k.hint}` : text;
}

/** Klipper key of a mirrored firmware fault code (2836 -> "key836"), else undefined. */
export function mirroredKey(code: number): string | undefined {
  return code >= 2000 && code < 3000 ? `key${code - 2000}` : undefined;
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
    const v = s.match(/"values"\s*:\s*\[([^\]]*)\]/)?.[1];
    if (v) values = [v];
  }
  if (!msg) return { text: s };
  const k = code ? KLIPPER_KEYS[code] : undefined;
  if (k) {
    // Our text replaces Creality's terse/Chinese message; keep the useful details.
    if (code === 'key586') msg = `${k.text}: ${msg.replace(/^Move out of range:?\s*/i, '')}`;
    else if (code === 'key789' && values.length) msg = `${k.text} on ${values.join(', ')}`;
    else if (code === 'key509') { const t = msg.match(/extruder_temp:\s*(-?[\d.]+)/)?.[1]; msg = `${k.text}${t ? ` (read ${t}°C)` : ''}`; }
    else msg = `${k.text}${code && isCfs(code) ? cfsSlot(values.join(',')) : ''}`;
  }
  return { code, text: `${msg}${code ? ` (${code})` : ''}`, hint: k?.hint };
}
