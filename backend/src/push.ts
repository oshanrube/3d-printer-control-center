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

export async function sendPush(payload: PushPayload) {
  const subs = pushRepo.all();
  const data = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s as any, data);
    } catch (err: any) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) pushRepo.remove(s.endpoint); // gone
    }
  }));
}
