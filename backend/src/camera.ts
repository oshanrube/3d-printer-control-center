import type { Printer } from './types.js';
import { relay } from './webrtc-relay.js';

/**
 * Camera access from the backend. The Pi (backend) can reach every printer —
 * including ones on an isolated IoT SSID — so the frontend only talks to us.
 *
 * MJPEG printers (K1/K1C) expose single-frame snapshots we poll/relay.
 * WebRTC-only printers (K2 etc.) have no snapshot endpoint, so we drive a
 * headless-Chromium WebRTC relay (webrtc-relay.ts) and serve its latest JPEG
 * frame here — same shape as an MJPEG snapshot.
 */

// Printers whose camera we should try over WebRTC.
function wantsWebrtc(printer: Printer): boolean {
  return printer.cameraType === 'webrtc' || printer.cameraType === 'auto';
}

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
  // WebRTC-capable cameras: keep the relay warm and serve its latest frame.
  if (wantsWebrtc(printer)) {
    relay.ensure(printer);   // idempotent; starts Chromium page if needed
    relay.touch(printer.id); // mark as actively viewed
    const frame = relay.getFrame(printer.id);
    if (frame) return { body: frame, contentType: 'image/jpeg' };
    // 'webrtc' (explicit) has no MJPEG fallback; for 'auto' fall through to MJPEG.
    if (printer.cameraType === 'webrtc') return null;
  }

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

/**
 * Snapshot for dataset logging (engine). Unlike fetchSnapshot (live viewing),
 * this does NOT take a live hold on the WebRTC relay — it warms, grabs one
 * frame, and lets the page be reclaimed, so a printing camera decodes in short
 * bursts instead of pinning a CPU core for the whole print.
 */
export async function captureForDataset(printer: Printer): Promise<{ body: Buffer; contentType: string } | null> {
  if (wantsWebrtc(printer)) {
    const frame = await relay.grab(printer);
    if (frame) return { body: frame, contentType: 'image/jpeg' };
    if (printer.cameraType === 'webrtc') return null;
  }
  return fetchSnapshot(printer);
}
