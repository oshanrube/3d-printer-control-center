import webpush from 'web-push';
import { kv, pushRepo } from './db.js';

let publicKey = '';

export function initPush() {
  let pub = kv.get('vapid_public');
  let priv = kv.get('vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    kv.set('vapid_public', pub);
    kv.set('vapid_private', priv);
  }
  publicKey = pub;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@local';
  webpush.setVapidDetails(subject, pub, priv);
}

export function getPublicKey() { return publicKey; }

export function subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  pushRepo.upsert(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

export function unsubscribe(endpoint: string) {
  pushRepo.remove(endpoint);
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  severity?: string;
  printerId?: number;
  url?: string;
}

export interface PushResult {
  total: number;
  sent: number;
  failures: Array<{ service: string; status?: number; error: string }>;
  removed: number; // expired subscriptions cleaned up
}

export async function sendPush(payload: PushPayload): Promise<PushResult> {
  const subs = pushRepo.all();
  const data = JSON.stringify(payload);
  const result: PushResult = { total: subs.length, sent: 0, failures: [], removed: 0 };
  await Promise.all(subs.map(async (s) => {
    let service = 'push service';
    try { service = new URL(s.endpoint).host; } catch { /* keep default */ }
    try {
      await webpush.sendNotification(s as any, data);
      result.sent++;
    } catch (err: any) {
      const status = err?.statusCode;
      const error = String(err?.body || err?.message || err).trim().slice(0, 300);
      if (status === 404 || status === 410) { pushRepo.remove(s.endpoint); result.removed++; } // subscription gone
      result.failures.push({ service, status, error });
      console.warn(`[push] ${service} rejected notification: ${status ?? ''} ${error}`);
    }
  }));
  return result;
}
