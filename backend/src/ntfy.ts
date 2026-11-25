// ntfy push channel — a second, alarm-grade delivery path alongside Web Push.
//
// Why: Web Push on Android is delivered as a generic Chrome "site" notification; it can't carry an
// alarm-grade channel, Android's abuse mitigation quietly deprioritises it, and it forwards to Wear
// OS unreliably. A self-hosted ntfy server (on the owner's VPS, behind Traefik) gives a dedicated
// app with max-priority alerts (sound + vibrate through Do Not Disturb) that mirror to the Pixel
// Watch. This fires on the SAME events as Web Push (see sendPush), mapping severity to ntfy priority.
//
// Config (./.env, passed through docker-compose): NTFY_URL (e.g. https://ntfy.example.com),
// NTFY_TOPIC (e.g. printers), NTFY_TOKEN (tk_… — the server runs auth-default-access=deny-all).
// If URL or topic is unset the channel is simply skipped, so it's optional.

import type { PushPayload } from './push.js';

export interface NtfyResult { ok: boolean; error?: string }

// ntfy priority: 5 max (sounds through DND), 4 high, 3 default, 2 low, 1 min.
function priorityFor(severity?: string): number {
  switch (severity) {
    case 'critical': return 5;
    case 'warning': return 4;
    case 'info': return 2;
    default: return 3;
  }
}

/** Publish one alert to ntfy, or null when the channel isn't configured. */
export async function sendNtfy(payload: PushPayload): Promise<NtfyResult | null> {
  const base = (process.env.NTFY_URL || '').replace(/\/+$/, '');
  const topic = process.env.NTFY_TOPIC || '';
  const token = process.env.NTFY_TOKEN || '';
  if (!base || !topic) return null;   // not set up → skip, Web Push still runs

  // JSON publishing (POST to the base URL): keeps full UTF-8 for emoji titles/tags, which ntfy's
  // header-based API does not (Node's fetch also rejects non-ASCII header values).
  const body: Record<string, unknown> = {
    topic,
    title: payload.title,
    message: payload.body,
    priority: priorityFor(payload.severity),
  };
  if (payload.tag) body.tags = [payload.tag];
  if (payload.url) body.click = payload.url;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const r = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, error: `ntfy ${r.status}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
