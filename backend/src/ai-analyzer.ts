/**
 * AI print-failure detection, two stages.
 *
 * 1. Detector (always on when configured): Obico's open-source failure detector
 *    (ml_api, self-hosted on bc250). Every 10 s per printing printer we grab a camera
 *    frame, the detector returns "failure" boxes with confidences, and we run Obico's
 *    own temporal algorithm (EWM vs a long-term per-printer baseline, with their tuned
 *    FD_1ST_GEN_PARAMS) to decide "warning" (alert) and "failure" (alert/pause).
 *
 * 2. Vision LLM (optional second opinion): when the detector raises an alarm and a
 *    vision model is configured (llama.cpp server, OpenAI-compatible API), it is asked
 *    to describe what it sees; its view is added to the alert. It never vetoes.
 *
 * Results go to ai_checks (frames with detections are kept next to the print's dataset
 * frames) so detector scores + the print's final outcome become labelled data.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { aiRepo, kv, printsRepo } from './db.js';
import { captureForDataset } from './camera.js';
import type { Fleet } from './fleet.js';
import type { AiVerdict, LiveState, PrinterEvent } from './types.js';

// ---------------------------------------------------------------------------
// Obico's failure-detection algorithm (obico-server backend/lib/prediction.py and
// failure_detection.py, release df8190e), with their FD_1ST_GEN_PARAMS. Tuned for
// one frame every 10 s.
// ---------------------------------------------------------------------------
export const FD = {
  EWM_SPAN: 12,
  ROLLING_WIN_SHORT: 310,
  ROLLING_WIN_LONG: 7200,        // ~20 h of frames: per-printer baseline
  THRESHOLD_LOW: 0.38,
  THRESHOLD_HIGH: 0.78,
  INIT_SAFE_FRAME_NUM: 30,       // first ~5 min of each print never alert
  ROLLING_MEAN_SHORT_MULTIPLE: 3.8,
  ESCALATING_FACTOR: 1.75,       // warning -> failure
  VISUALIZATION_THRESH: 0.2,
};

export type Detection = [string, number, [number, number, number, number]];

export interface Prediction {
  currentP: number; currentFrameNum: number; lifetimeFrameNum: number;
  ewmMean: number; rollingMeanShort: number; rollingMeanLong: number;
}

export const newPrediction = (): Prediction =>
  ({ currentP: 0, currentFrameNum: 0, lifetimeFrameNum: 0, ewmMean: 0, rollingMeanShort: 0, rollingMeanLong: 0 });

const nextRollingMean = (p: number, mean: number, count: number, win: number) =>
  mean + (p - mean) / (win <= count ? win : count + 1);

export function updatePrediction(pred: Prediction, detections: Detection[]) {
  const p = detections.reduce((s, d) => s + d[1], 0);
  const alpha = 2 / (FD.EWM_SPAN + 1);
  pred.currentP = p;
  pred.currentFrameNum += 1;
  pred.lifetimeFrameNum += 1;
  pred.ewmMean = p * alpha + pred.ewmMean * (1 - alpha);
  pred.rollingMeanShort = nextRollingMean(p, pred.rollingMeanShort, pred.currentFrameNum, FD.ROLLING_WIN_SHORT);
  pred.rollingMeanLong = nextRollingMean(p, pred.rollingMeanLong, pred.lifetimeFrameNum, FD.ROLLING_WIN_LONG);
}

export function isFailing(pred: Prediction, sensitivity: number, escalating = 1): boolean {
  if (pred.currentFrameNum < FD.INIT_SAFE_FRAME_NUM) return false;
  const adjusted = (pred.ewmMean - pred.rollingMeanLong) * sensitivity / escalating;
  if (adjusted < FD.THRESHOLD_LOW) return false;
  if (adjusted > FD.THRESHOLD_HIGH) return true;
  return adjusted > (pred.rollingMeanShort - pred.rollingMeanLong) * FD.ROLLING_MEAN_SHORT_MULTIPLE;
}

/** Obico's 0-1 risk for display: <1/3 normal, 1/3-2/3 warning, >2/3 failure. */
export function normalizedRisk(pred: Prediction, sensitivity: number): number {
  const scale = (v: number, a: number, b: number, c: number, d: number) => Math.min(d, Math.max(c, ((v - a) * (d - c)) / (b - a) + c));
  let warn = (pred.rollingMeanShort - pred.rollingMeanLong) * FD.ROLLING_MEAN_SHORT_MULTIPLE;
  warn = Math.min(FD.THRESHOLD_HIGH, Math.max(FD.THRESHOLD_LOW, warn));
  const fail = warn * FD.ESCALATING_FACTOR;
  const p = (pred.ewmMean - pred.rollingMeanLong) * sensitivity;
  if (p > fail) return scale(p, fail, fail * 1.5, 2 / 3, 1);
  if (p > warn) return scale(p, warn, fail, 1 / 3, 2 / 3);
  return scale(p, 0, warn, 0, 1 / 3);
}

// ---------------------------------------------------------------------------

const VLM_PROMPT = `You check 3D printers (FDM, Creality K1C / K2 Plus) through a camera inside the enclosure.
A failure detector has flagged this frame. Describe what you see and judge the print.
Signs of failure: spaghetti / loose tangled filament, part detached or knocked over, big blob on the nozzle,
severe warping, layer shift, printing in mid-air. Be honest if it looks fine or the image is unclear.
Reply with JSON only: {"assessment":"success|failure|inconclusive","confidence":0-100,"reason":"one short sentence","defects":["..."]}`;

interface Track {
  inFlight: boolean;
  lastRun: number;
  printKey?: string;
  pred: Prediction;
  level: 'none' | 'warning' | 'failure';   // highest alarm already raised this print
  lastRowAt: number;
}

interface StageStatus { enabled: boolean; url: string; model?: string | null; lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null; checks: number }

export class AiAnalyzer {
  private tracks = new Map<number, Track>();
  private frames = new Map<string, { buf: Buffer; exp: number }>();  // served to the detector
  private detectorChain: Promise<unknown> = Promise.resolve();      // one detector request at a time
  private timer?: NodeJS.Timeout;
  status: { detector: StageStatus; vlm: StageStatus } = {
    detector: { enabled: config.detector.enabled, url: config.detector.url, lastOkAt: null, lastError: null, lastErrorAt: null, checks: 0 },
    vlm: { enabled: config.ai.enabled, url: config.ai.baseUrl, model: config.ai.model || null, lastOkAt: null, lastError: null, lastErrorAt: null, checks: 0 },
  };

  constructor(
    private fleet: Fleet,
    private report: (e: Omit<PrinterEvent, 'createdAt'>) => unknown,
  ) {}

  start() {
    if (!config.detector.enabled) {
      console.log('[ai] failure detector disabled (set OBICO_TOKEN to enable)');
      return;
    }
    console.log(`[ai] failure detector: ${config.detector.url}, every ${config.detector.intervalSec}s per printing printer`
      + `${config.ai.enabled ? `; vision second opinion: ${config.ai.baseUrl}` : ''}`);
    this.probe().catch(() => {});
    this.timer = setInterval(() => this.tick(), 2000);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  /** Frame handed to the detector by URL (single use, expires after 2 min). */
  takeFrame(key: string): Buffer | undefined {
    const f = this.frames.get(key);
    if (!f || f.exp < Date.now()) return undefined;
    return f.buf;
  }

  private fail(stage: StageStatus, name: string, msg: string) {
    const now = Date.now();
    if (msg !== stage.lastError || now - (stage.lastErrorAt || 0) > 10 * 60_000) console.warn(`[ai] ${name}: ${msg}`);
    stage.lastError = msg; stage.lastErrorAt = now;
  }

  private async probe() {
    try {
      const r = await fetch(`${config.detector.url}/hc/`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) this.fail(this.status.detector, 'detector', `health check HTTP ${r.status}`);
      else console.log('[ai] failure detector reachable');
    } catch (e: any) { this.fail(this.status.detector, 'detector', `unreachable: ${e?.message || e}`); }
  }

  private track(id: number): Track {
    let t = this.tracks.get(id);
    if (!t) {
      let pred = newPrediction();
      try { const saved = kv.get(`fd:${id}`); if (saved) pred = { ...pred, ...JSON.parse(saved) }; } catch { /* fresh */ }
      t = { inFlight: false, lastRun: 0, pred, level: 'none', lastRowAt: 0 };
      this.tracks.set(id, t);
    }
    return t;
  }

  private tick() {
    const now = Date.now();
    for (const [k, f] of this.frames) if (f.exp < now) this.frames.delete(k);
    for (const s of this.fleet.getStates()) {
      if (!s.online || s.state !== 'printing') continue;
      const t = this.track(s.printerId);
      if (t.inFlight || now - t.lastRun < config.detector.intervalSec * 1000) continue;
      t.inFlight = true; t.lastRun = now;
      this.runDetector(s, t)
        .catch(e => this.fail(this.status.detector, 'detector', e?.message || String(e)))
        .finally(() => { t.inFlight = false; });
    }
  }

  private async runDetector(s: LiveState, t: Track) {
    const client = this.fleet.client(s.printerId);
    if (!client) return;
    const printer = client.printer;

    // New print: reset the per-print state (Obico's reset_for_new_print), keep the baseline.
    const open = printsRepo.open(s.printerId);
    const printKey = open ? `print:${open.id}` : `file:${s.filename || ''}`;
    if (t.printKey !== printKey) {
      Object.assign(t.pred, { currentFrameNum: 0, currentP: 0, ewmMean: 0, rollingMeanShort: 0 });
      t.printKey = printKey; t.level = 'none';
      this.fleet.setAi(s.printerId, null);
    }

    const shot = await captureForDataset(printer);
    if (!shot) return;

    const key = randomBytes(16).toString('hex');
    this.frames.set(key, { buf: shot.body, exp: Date.now() + 120_000 });
    const started = Date.now();
    let detections: Detection[];
    try {
      detections = await this.callDetector(`${config.detector.imageBase}/api/ai/frame/${key}`);
    } finally { this.frames.delete(key); }
    const latencyMs = Date.now() - started;
    this.status.detector.checks++; this.status.detector.lastOkAt = Date.now();

    updatePrediction(t.pred, detections);
    try { kv.set(`fd:${s.printerId}`, JSON.stringify(t.pred)); } catch { /* best effort */ }
    const sens = config.detector.sensitivity;
    const risk = normalizedRisk(t.pred, sens);
    const shown = detections.filter(d => d[1] > FD.VISUALIZATION_THRESH);
    const verdict: AiVerdict = {
      source: 'detector',
      assessment: risk > 2 / 3 ? 'failure' : risk > 1 / 3 ? 'inconclusive' : 'success',
      confidence: Math.round(risk * 100),
      reason: shown.length ? `${shown.length} suspicious area${shown.length > 1 ? 's' : ''} in the camera view`
        : t.pred.currentFrameNum < FD.INIT_SAFE_FRAME_NUM ? 'Learning this print (first ~5 min)' : 'Nothing suspicious',
      defects: [], at: Date.now(),
    };
    this.fleet.setAi(s.printerId, verdict);

    // Keep every frame that had detections (plus one row a minute) for the dataset.
    const now = Date.now();
    if (detections.length || now - t.lastRowAt >= 60_000) {
      t.lastRowAt = now;
      let rel: string | null = null;
      if (detections.length) {
        const dir = open?.snapshot_dir || join('ai', `p${s.printerId}`);
        rel = join(dir, `det_${now}.jpg`);
        try { mkdirSync(join(config.dataDir, dir), { recursive: true }); writeFileSync(join(config.dataDir, rel), shot.body); } catch { rel = null; }
      }
      aiRepo.add({
        printerId: s.printerId, printId: open?.id ?? null, t: now, snapshot: rel, source: 'detector',
        assessment: verdict.assessment, confidence: verdict.confidence, reason: null, defects: [],
        progress: s.progress, model: 'obico-onnx', latencyMs, raw: JSON.stringify(detections).slice(0, 4000),
        score: t.pred.currentP, risk,
      });
    }

    // Decisions, exactly as Obico: pause level first, else alert level. Each once per print.
    const failure = isFailing(t.pred, sens, FD.ESCALATING_FACTOR);
    const warning = !failure && isFailing(t.pred, sens, 1);
    if (failure && t.level !== 'failure') { t.level = 'failure'; await this.alarm(s, 'failure', shot.body, risk); }
    else if (warning && t.level === 'none') { t.level = 'warning'; await this.alarm(s, 'warning', shot.body, risk); }
  }

  private callDetector(imgUrl: string): Promise<Detection[]> {
    const run = async () => {
      const headers: Record<string, string> = {};
      if (config.detector.token) headers.Authorization = `Bearer ${config.detector.token}`;
      const r = await fetch(`${config.detector.url}/p/?img=${encodeURIComponent(imgUrl)}`, { headers, signal: AbortSignal.timeout(60_000) });
      if (r.status === 401) throw new Error('detector rejected the token (OBICO_TOKEN)');
      const body: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`detector HTTP ${r.status}: ${body?.message || ''}`.trim());
      if (body?.message && !Array.isArray(body?.detections)) throw new Error(`detector: ${body.message}`);
      return (body?.detections || []) as Detection[];
    };
    const p = this.detectorChain.then(run, run);
    this.detectorChain = p.catch(() => {});
    return p;
  }

  private async alarm(s: LiveState, level: 'warning' | 'failure', jpeg: Buffer, risk: number) {
    const name = this.fleet.client(s.printerId)?.printer.name || `Printer ${s.printerId}`;
    const pause = level === 'failure' && config.detector.autoPause;

    // Optional second opinion from a vision LLM.
    let opinion = '';
    if (config.ai.enabled) {
      const v = await this.askVlm(s, jpeg).catch(e => { this.fail(this.status.vlm, 'vision model', e?.message || String(e)); return null; });
      if (v) opinion = ` Vision model: ${v.assessment} (${v.confidence}%): ${v.reason}`;
    }

    this.report({
      printerId: s.printerId, printerName: name, type: 'ai_failure',
      severity: level === 'failure' ? 'critical' : 'warning',
      title: level === 'failure' ? `🤖 ${name}: print is likely failing` : `🤖 ${name}: print may be failing`,
      message: `The failure detector sees signs of a failed print (risk ${Math.round(risk * 100)}%).`
        + `${pause ? ' Pausing the print.' : ' Check the camera.'}${opinion}`,
      filename: s.filename ?? null, actionTaken: pause ? 'auto-paused' : null,
    });
    if (pause) this.fleet.client(s.printerId)?.pause().catch(e => this.fail(this.status.detector, 'detector', `auto-pause failed: ${e?.message || e}`));
  }

  private async askVlm(s: LiveState, jpeg: Buffer): Promise<AiVerdict> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.ai.apiKey) headers.Authorization = `Bearer ${config.ai.apiKey}`;
    const started = Date.now();
    const r = await fetch(`${config.ai.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers, signal: AbortSignal.timeout(config.ai.timeoutSec * 1000),
      body: JSON.stringify({
        model: config.ai.model || 'default', temperature: 0, max_tokens: 300,
        messages: [
          { role: 'system', content: VLM_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: `File: ${s.filename || 'unknown'}, ${Math.round((s.progress || 0) * 100)}% done.` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
          ] },
        ],
      }),
    });
    const json: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? 'API key rejected (AI_API_KEY)' : `HTTP ${r.status}: ${json?.error?.message || ''}`);
    const content = String(json?.choices?.[0]?.message?.content ?? '');
    const v = parseVerdict(content);
    this.status.vlm.checks++; this.status.vlm.lastOkAt = Date.now();
    if (json?.model) this.status.vlm.model = json.model;
    const open = printsRepo.open(s.printerId);
    aiRepo.add({
      printerId: s.printerId, printId: open?.id ?? null, t: Date.now(), snapshot: null, source: 'vlm',
      assessment: v.assessment, confidence: v.confidence, reason: v.reason, defects: v.defects,
      progress: s.progress, model: json?.model ?? null, latencyMs: Date.now() - started, raw: content.slice(0, 2000),
    });
    return v;
  }
}

/** Parse a vision model's reply into a verdict; anything unparseable counts as inconclusive. */
export function parseVerdict(content: string): AiVerdict {
  const at = Date.now();
  const text = content.replace(/```(?:json)?/gi, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : text);
    const a = String(j.assessment || '').toLowerCase();
    const assessment = (['success', 'failure', 'inconclusive'] as const).find(x => a.includes(x)) || 'inconclusive';
    let confidence = Number(j.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    if (confidence > 0 && confidence <= 1) confidence *= 100;
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));
    const defects = Array.isArray(j.defects) ? j.defects.map((d: any) => String(d)).filter(Boolean).slice(0, 8) : [];
    return { source: 'vlm', assessment, confidence, reason: String(j.reason || '').slice(0, 300), defects, at };
  } catch {
    return { source: 'vlm', assessment: 'inconclusive', confidence: 0, reason: `Unreadable model reply: ${text.slice(0, 120)}`, defects: [], at };
  }
}
