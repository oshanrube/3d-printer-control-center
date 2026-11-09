import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { config } from './config.js';
import { printersRepo, eventsRepo, printsRepo, aiRepo } from './db.js';
import type { AiAnalyzer } from './ai-analyzer.js';
import { getPublicKey, subscribe, unsubscribe, sendPush } from './push.js';
import { fetchSnapshot } from './camera.js';
import { scanSubnet } from './scan.js';
import type { Fleet } from './fleet.js';
import type { LiveState, PrinterEvent } from './types.js';
import { describeKlipperError } from './errors.js';

// How long a pause/resume/cancel request waits for the printer before answering "accepted".
const ACTION_QUICK_MS = 3000;
// Minimum gap between live-state pushes per printer to dashboards (important changes bypass it).
const STATE_MIN_INTERVAL_MS = 1000;
// Failure labels the user can give a stopped (or bad completed) print.
export const FAILURE_REASONS = ['spaghetti', 'jam', 'layer_shift', 'warping', 'adhesion', 'wrong_file', 'not_failed', 'other'];

export function buildServer(fleet: Fleet, ai: { current?: AiAnalyzer } = {}) {
  const app = Fastify({ logger: false });
  app.register(fastifyWebsocket);

  const clients = new Set<WebSocket>();
  const send = (sock: WebSocket, obj: any) => { try { sock.send(JSON.stringify(obj)); } catch { /* ignore */ } };
  const broadcast = (obj: any) => { for (const c of clients) send(c, obj); };

  // Live state updates -> all ws clients. Moonraker reports ~4 updates/s per printer
  // (temperature noise); dashboards only need ~1/s, so coalesce to the latest state
  // once per second per printer. Changes that matter are sent immediately.
  const lastSent = new Map<number, { at: number; key: string }>();
  const pending = new Map<number, NodeJS.Timeout>();
  const keyOf = (s: LiveState) => [s.online, s.state, s.fault?.code ?? '', s.errorText ?? '', s.filename ?? '', s.ai?.assessment ?? ''].join('|');
  const sendState = (s: LiveState) => {
    lastSent.set(s.printerId, { at: Date.now(), key: keyOf(s) });
    broadcast({ type: 'state', state: s });
  };
  fleet.on('state', (s: LiveState) => {
    const id = s.printerId, prev = lastSent.get(id), now = Date.now();
    if (!prev || prev.key !== keyOf(s) || now - prev.at >= STATE_MIN_INTERVAL_MS) {
      clearTimeout(pending.get(id)); pending.delete(id);
      sendState(s);
    } else if (!pending.has(id)) {
      pending.set(id, setTimeout(() => {
        pending.delete(id);
        const latest = fleet.getState(id);
        if (latest) sendState(latest);
      }, STATE_MIN_INTERVAL_MS - (now - prev.at)));
    }
  });
  // Engine events are forwarded here via broadcastEvent()
  const broadcastEvent = (e: PrinterEvent) => broadcast({ type: 'event', event: e });

  function printersWithState() {
    return printersRepo.all().map(p => ({ ...p, live: fleet.getState(p.id) || null }));
  }

  app.register(async (f) => {
    f.get('/ws', { websocket: true }, (conn) => {
      const sock = conn.socket as unknown as WebSocket;
      clients.add(sock);
      send(sock, { type: 'snapshot', printers: printersWithState(), events: eventsRepo.recent(50) });
      sock.on('close', () => clients.delete(sock));
      sock.on('message', () => { /* client is read-only over ws for now */ });
    });
  });

  // ---- REST API ----
  app.get('/api/health', async () => ({ ok: true, time: Date.now() }));

  app.get('/api/printers', async () => printersWithState());

  app.post('/api/printers', async (req, reply) => {
    const b = req.body as any;
    if (!b?.name || !b?.ip) return reply.code(400).send({ error: 'name and ip required' });
    const p = printersRepo.add({
      name: String(b.name), ip: String(b.ip).replace(/^https?:\/\//, ''),
      moonrakerPort: b.moonrakerPort || config.moonrakerPort,
      cameraType: b.cameraType || 'auto', disabled: !!b.disabled,
    });
    fleet.reconcile();
    return p;
  });

  app.patch('/api/printers/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const patch: any = {};
    for (const k of ['name', 'ip', 'cameraType', 'moonrakerPort', 'disabled']) if (k in b) patch[k] = b[k];
    if (patch.ip) patch.ip = String(patch.ip).replace(/^https?:\/\//, '');
    const p = printersRepo.update(id, patch);
    if (!p) return reply.code(404).send({ error: 'not found' });
    fleet.reconcile();
    return p;
  });

  app.delete('/api/printers/:id', async (req) => {
    const id = Number((req.params as any).id);
    printersRepo.remove(id);
    fleet.reconcile();
    return { ok: true };
  });

  // Control actions
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/api/printers/:id/${action}`, async (req, reply) => {
      const id = Number((req.params as any).id);
      const client = fleet.client(id);
      if (!client) return reply.code(404).send({ error: 'Printer is not connected.' });
      // Creality's macros (park, cool down) can take minutes before Moonraker replies.
      // Wait briefly for a quick rejection; otherwise report it as accepted and let the
      // live state show the outcome.
      const run = client[action]();
      const quick = await Promise.race([
        run.then(() => ({ done: true as const }), (e: any) => ({ error: e?.message || String(e) })),
        new Promise<{ pending: true }>(r => setTimeout(() => r({ pending: true }), ACTION_QUICK_MS)),
      ]);
      if ('done' in quick) return { ok: true };
      if ('pending' in quick) {
        run.catch((e: any) => console.warn(`[action] ${action} on printer ${id} failed later: ${e?.message || e}`));
        return reply.code(202).send({ ok: true, pending: true });
      }
      return reply.code(409).send({ error: describeKlipperError(quick.error).text || quick.error });
    });
  }

  app.get('/api/events', async (req) => {
    const limit = Math.min(500, Number((req.query as any)?.limit) || 100);
    return eventsRepo.recent(limit);
  });

  app.get('/api/prints', async () => printsRepo.recent(50));

  // Failure labels (training data): stopped prints still needing a reason, and labelling.
  const WEEK = 7 * 24 * 3600_000;
  app.get('/api/prints/unlabelled', async () => printsRepo.unlabelled(Date.now() - WEEK));
  app.get('/api/prints/finished', async () => printsRepo.finished(Date.now() - WEEK));
  app.post('/api/prints/:id/label', async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = (req.body || {}) as any;
    const reason = String(b.reason || '');
    if (!FAILURE_REASONS.includes(reason)) return reply.code(400).send({ error: `reason must be one of: ${FAILURE_REASONS.join(', ')}` });
    const note = b.note ? String(b.note).slice(0, 500) : null;
    if (!printsRepo.label(id, reason, note)) return reply.code(404).send({ error: 'print not found' });
    broadcast({ type: 'labels' });   // dashboards refresh their "to label" lists
    return { ok: true };
  });
  // The print's last saved camera frame, to help remember what happened.
  app.get('/api/prints/:id/last-frame', async (req, reply) => {
    const p = printsRepo.get(Number((req.params as any).id));
    if (!p?.snapshot_dir) return reply.code(404).send();
    const dir = join(config.dataDir, p.snapshot_dir);
    let files: string[] = [];
    try { files = readdirSync(dir).filter(f => /^\d+\.jpg$/.test(f)).sort(); } catch { /* none */ }
    if (!files.length) return reply.code(404).send();
    reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'max-age=3600');
    return reply.send(readFileSync(join(dir, files[files.length - 1])));
  });

  // AI failure checks
  app.get('/api/ai/status', async () => ai.current?.status ?? { enabled: false });
  // Frames for the failure detector to download (random single-use keys, 2 min expiry).
  app.get('/api/ai/frame/:key', async (req, reply) => {
    const buf = ai.current?.takeFrame(String((req.params as any).key));
    if (!buf) return reply.code(404).send();
    reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store');
    return reply.send(buf);
  });
  app.get('/api/ai/checks', async (req) => {
    const q = req.query as any;
    return aiRepo.recent(q?.printerId ? Number(q.printerId) : undefined, Math.min(500, Number(q?.limit) || 50));
  });

  // Camera snapshot relay (backend reaches every printer)
  app.get('/api/camera/:id/snapshot', async (req, reply) => {
    const id = Number((req.params as any).id);
    const p = printersRepo.get(id);
    if (!p) return reply.code(404).send();
    const shot = await fetchSnapshot(p);
    if (!shot) return reply.code(502).send();
    reply.header('Content-Type', shot.contentType);
    reply.header('Cache-Control', 'no-store');
    return reply.send(shot.body);
  });

  // Network scan
  app.get('/api/scan', async (req) => {
    const base = String((req.query as any)?.base || defaultBase());
    const found = await scanSubnet(base);
    const known = new Set(printersRepo.all().map(p => String(p.ip).split(':')[0]));
    return found.map(f => ({ ...f, known: known.has(f.ip) }));
  });

  // ---- Push ----
  app.get('/api/push/vapid', async () => ({ publicKey: getPublicKey() }));
  app.post('/api/push/subscribe', async (req) => { subscribe(req.body as any); return { ok: true }; });
  app.post('/api/push/unsubscribe', async (req) => { unsubscribe((req.body as any)?.endpoint); return { ok: true }; });
  app.post('/api/push/test', async (_req, reply) => {
    const r = await sendPush({ title: 'Control Center', body: 'Test notification ✅', tag: 'test' });
    if (r.total === 0) return reply.code(409).send({ ...r, error: 'No devices are subscribed to notifications.' });
    if (r.sent === 0) {
      const f = r.failures[0];
      return reply.code(502).send({ ...r, error: `${f.service} rejected it${f.status ? ` (HTTP ${f.status})` : ''}: ${f.error}` });
    }
    return { ok: true, ...r };
  });

  // ---- Static frontend (SPA) ----
  if (existsSync(config.frontendDir)) {
    app.register(fastifyStatic, { root: config.frontendDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return { app, broadcastEvent };
}

function defaultBase(): string {
  const counts: Record<string, number> = {};
  for (const p of printersRepo.all()) {
    const m = String(p.ip).match(/^(\d+\.\d+\.\d+)\.\d+/);
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return best || '10.0.68';
}
