import type { Printer } from './types.js';

/**
 * Camera access from the backend. The Pi (backend) can reach every printer —
 * including ones on an isolated IoT SSID — so the frontend only talks to us.
 *
 * MJPEG printers (K1/K1C) expose single-frame snapshots we poll/relay.
 * WebRTC-only printers (K2 etc.) have no snapshot endpoint; backend relay of
 * their stream needs a WebRTC client (phase 2), so snapshot() returns null.
 */

function host(printer: Printer): string {
  return String(printer.ip).replace(/^https?:\/\//, '').split(':')[0];
}

export function snapshotCandidates(printer: Printer): string[] {
  const h = host(printer);
  return [
    `http://${h}:4408/webcam/?action=snapshot`,
    `http://${h}:8080/?action=snapshot`,
  ];
}

// Remember which candidate worked, per printer, to avoid re-probing every time.
const workingUrl = new Map<number, string>();

export async function fetchSnapshot(printer: Printer): Promise<{ body: Buffer; contentType: string } | null> {
  const urls = (() => {
    const w = workingUrl.get(printer.id);
    const cands = snapshotCandidates(printer);
    return w ? [w, ...cands.filter(u => u !== w)] : cands;
  })();

  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || 'image/jpeg';
      if (!ct.startsWith('image/')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) continue;
      workingUrl.set(printer.id, url);
      return { body: buf, contentType: ct };
    } catch {
      /* try next */
    }
  }
  return null;
}

export function hasMjpegCamera(printer: Printer): boolean {
  return workingUrl.has(printer.id);
}
