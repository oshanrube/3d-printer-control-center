/**
 * AI print-failure analyzer.
 *
 * While a printer is printing, every AI_INTERVAL_SEC it grabs a camera snapshot and
 * asks a vision model (llama.cpp server on bc250, OpenAI-compatible API) whether the
 * print looks healthy. Every verdict is stored with its snapshot (ai_checks table,
 * next to the print's dataset frames), so verdicts + the print's final outcome form
 * a labelled dataset for evaluating / training a better detector later.
 *
 * Alerting is deliberately conservative: a vision model will produce false positives,
 * so an alert needs AI_FAILURE_STREAK consecutive "failure" verdicts at or above
 * AI_ALERT_CONFIDENCE, at most once per print. Auto-pause is opt-in (AI_AUTO_PAUSE=1).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { aiRepo, printsRepo } from './db.js';
import { captureForDataset } from './camera.js';
import type { Fleet } from './fleet.js';
import type { AiVerdict, LiveState, PrinterEvent } from './types.js';

const SYSTEM_PROMPT = `You monitor 3D printers (FDM, Creality K1C / K2 Plus) through a camera inside the enclosure.
Judge ONLY what the image shows. Classify the current print as:
- "failure": clear evidence of a failed print, e.g. spaghetti / tangled loose filament, part detached or knocked over,
  big blob of plastic around the nozzle, severe warping or lifted corners, obvious layer shift,
  or the nozzle printing in mid-air with nothing being built.
- "success": the part(s) on the bed look intact and are being built normally.
- "inconclusive": image too dark/blurry/occluded, too early to tell, or you are unsure.
Be conservative: only say "failure" when the evidence is clearly visible.
Reply with JSON only, no markdown:
{"assessment":"success|failure|inconclusive","confidence":0-100,"reason":"one short sentence","defects":["..."]}`;

interface Track {
  lastCheck: number;
  printKey?: string;      // identifies the current print (prints.id or filename)
  failStreak: number;
  successStreak: number;
  alerted: boolean;       // already alerted for this print
}

export interface AiStatus {
  enabled: boolean;
  baseUrl: string;
  model: string | null;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  checks: number;
}

export class AiAnalyzer {
  private tracks = new Map<number, Track>();
  private busy = false;
  private timer?: NodeJS.Timeout;
  private jsonMode = true;   // drop response_format if the server rejects it
  status: AiStatus = {
    enabled: config.ai.enabled, baseUrl: config.ai.baseUrl, model: config.ai.model || null,
    lastOkAt: null, lastError: null, lastErrorAt: null, checks: 0,
  };

  constructor(
    private fleet: Fleet,
    private report: (e: Omit<PrinterEvent, 'createdAt'>) => unknown,
  ) {}

  start() {
    if (!config.ai.enabled) {
      console.log('[ai] disabled (set AI_API_KEY, or AI_ENABLED=1, to enable)');
      return;
    }
    console.log(`[ai] enabled: ${config.ai.baseUrl}, every ${config.ai.intervalSec}s per printing printer`);
    this.probe().catch(() => {});
    this.timer = setInterval(() => this.tick(), 15_000);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.ai.apiKey) h.Authorization = `Bearer ${config.ai.apiKey}`;
    return h;
  }

  /** Learn the model name and confirm the key works. */
  private async probe() {
    try {
      const res = await fetch(`${config.ai.baseUrl}/v1/models`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) return this.fail(`model server answered HTTP ${res.status}: ${body?.error?.message || ''}`.trim());
      const id = body?.data?.[0]?.id || body?.models?.[0]?.name;
      if (id && !config.ai.model) this.status.model = id;
      console.log(`[ai] model server OK${id ? `, model: ${id}` : ''}`);
    } catch (e: any) {
      this.fail(`model server unreachable: ${e?.message || e}`);
    }
  }

  private fail(msg: string) {
    // Log a repeated error at most every 10 minutes.
    const now = Date.now();
    if (msg !== this.status.lastError || now - (this.status.lastErrorAt || 0) > 10 * 60_000) console.warn(`[ai] ${msg}`);
    this.status.lastError = msg; this.status.lastErrorAt = now;
  }

  private track(id: number): Track {
    let t = this.tracks.get(id);
    if (!t) { t = { lastCheck: 0, failStreak: 0, successStreak: 0, alerted: false }; this.tracks.set(id, t); }
    return t;
  }

  private async tick() {
    if (this.busy) return;                       // one request at a time: the model server has one GPU
    const now = Date.now();
    const due = this.fleet.getStates()
      .filter(s => s.online && s.state === 'printing' && s.printDuration >= config.ai.minPrintMin * 60)
      .map(s => ({ s, t: this.track(s.printerId) }))
      .filter(({ t }) => now - t.lastCheck >= config.ai.intervalSec * 1000)
      .sort((a, b) => a.t.lastCheck - b.t.lastCheck); // longest-waiting first
    if (!due.length) return;
    const { s, t } = due[0];
    t.lastCheck = now;
    this.busy = true;
    try { await this.check(s, t); }
    catch (e: any) { this.fail(`check failed: ${e?.message || e}`); }
    finally { this.busy = false; }
  }

  private async check(s: LiveState, t: Track) {
    const client = this.fleet.client(s.printerId);
    if (!client) return;
    const printer = client.printer;

    // New print? reset per-print state.
    const open = printsRepo.open(s.printerId);
    const printKey = open ? `print:${open.id}` : `file:${s.filename || ''}`;
    if (t.printKey !== printKey) {
      t.printKey = printKey; t.failStreak = 0; t.successStreak = 0; t.alerted = false;
      this.fleet.setAi(s.printerId, null);
    }

    const shot = await captureForDataset(printer);
    if (!shot) return;   // no camera frame right now; try again next interval

    // Store the frame next to the print's dataset frames.
    const dir = open?.snapshot_dir || join('ai', `p${s.printerId}`);
    const rel = join(dir, `ai_${Date.now()}.jpg`);
    try { mkdirSync(join(config.dataDir, dir), { recursive: true }); writeFileSync(join(config.dataDir, rel), shot.body); }
    catch { /* storage optional */ }

    const started = Date.now();
    const pct = Math.round((s.progress || 0) * 100);
    const userText = `Printer: ${printer.name}. File: ${s.filename || 'unknown'}. Progress: ${pct}%, `
      + `printing for ${Math.round(s.printDuration / 60)} min. Is this print healthy?`;
    const { content, model } = await this.ask(userText, shot.body.toString('base64'));
    const verdict = parseVerdict(content);
    const latencyMs = Date.now() - started;

    this.status.checks++; this.status.lastOkAt = Date.now();
    if (model && !config.ai.model) this.status.model = model;
    aiRepo.add({
      printerId: s.printerId, printId: open?.id ?? null, t: Date.now(), snapshot: rel,
      assessment: verdict.assessment, confidence: verdict.confidence, reason: verdict.reason,
      defects: verdict.defects, progress: s.progress, model: model || this.status.model, latencyMs, raw: content.slice(0, 2000),
    });
    this.fleet.setAi(s.printerId, verdict);
    this.evaluate(s, t, verdict);
  }

  private async ask(text: string, jpegB64: string): Promise<{ content: string; model: string | null }> {
    const body: any = {
      model: config.ai.model || this.status.model || 'default',
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegB64}` } },
        ] },
      ],
    };
    if (this.jsonMode) body.response_format = { type: 'json_object' };
    const res = await fetch(`${config.ai.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.ai.timeoutSec * 1000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || `HTTP ${res.status}`;
      if (this.jsonMode && res.status === 400 && /response_format|json/i.test(msg)) {
        this.jsonMode = false;                     // older server: retry without JSON mode
        return this.ask(text, jpegB64);
      }
      throw new Error(res.status === 401 ? 'model server rejected the API key (AI_API_KEY)' : `model server: ${msg}`);
    }
    return { content: String(json?.choices?.[0]?.message?.content ?? ''), model: json?.model ?? null };
  }

  private evaluate(s: LiveState, t: Track, v: AiVerdict) {
    if (v.assessment === 'failure' && v.confidence >= config.ai.alertConfidence) { t.failStreak++; t.successStreak = 0; }
    else if (v.assessment === 'success') { t.successStreak++; t.failStreak = 0; }
    // inconclusive: keep the streaks as they are

    // A clean run of healthy checks re-arms the alert (a recovered print can fail again).
    if (t.alerted && t.successStreak >= 3) t.alerted = false;
    if (t.alerted || t.failStreak < config.ai.failureStreak) return;
    t.alerted = true;

    const name = this.fleet.client(s.printerId)?.printer.name || `Printer ${s.printerId}`;
    const pause = config.ai.autoPause && v.confidence >= config.ai.pauseConfidence;
    const defects = v.defects.length ? ` Seen: ${v.defects.join(', ')}.` : '';
    this.report({
      printerId: s.printerId, printerName: name, type: 'ai_failure', severity: 'critical',
      title: `🤖 ${name}: print may be failing`,
      message: `${v.reason} (AI confidence ${v.confidence}%, ${t.failStreak} checks in a row).${defects}`
        + (pause ? ' Pausing the print.' : ' Check the camera.'),
      filename: s.filename ?? null, actionTaken: pause ? 'auto-paused' : null,
    });
    if (pause) this.fleet.client(s.printerId)?.pause().catch(e => this.fail(`auto-pause failed: ${e?.message || e}`));
  }
}

/** Parse the model's reply into a verdict; anything unparseable counts as inconclusive. */
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
    if (confidence > 0 && confidence <= 1) confidence *= 100;     // 0-1 scale
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));
    const defects = Array.isArray(j.defects) ? j.defects.map((d: any) => String(d)).filter(Boolean).slice(0, 8) : [];
    return { assessment, confidence, reason: String(j.reason || '').slice(0, 300), defects, at };
  } catch {
    return { assessment: 'inconclusive', confidence: 0, reason: `Unreadable model reply: ${text.slice(0, 120)}`, defects: [], at };
  }
}
