import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { api, FAILURE_REASONS, type Printer, type PrinterEvent, type StoppedPrint } from './api';
import { useStore } from './store';
import { enablePush, pushStatus } from './push';

/* ---------- helpers ---------- */
const pad = (n: number) => String(n).padStart(2, '0');
function fmtDur(sec?: number | null) {
  if (!sec || sec < 0) return '—';
  const s = Math.floor(sec); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s % 60)}s`;
}
function fmtETA(sec?: number | null) {
  if (!sec || sec <= 0) return '—';
  const d = new Date(Date.now() + sec * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
type LiveFans = NonNullable<NonNullable<Printer['live']>['fans']>;
function fmtChamber(c?: { temp: number; target?: number; heaterPower?: number } | null) {
  if (!c) return '—';
  if (c.target === undefined) return `${c.temp}°`;                        // no chamber heater (K1C)
  const heating = (c.heaterPower ?? 0) > 0.05 ? ' 🔥' : '';
  return c.target > 0 ? `${c.temp}° / ${c.target}°${heating}` : `${c.temp}°`;
}
function fmtFans(f: LiveFans) {
  const pct = (v?: number) => (v === undefined ? null : v > 0.005 ? `${Math.round(v * 100)}%` : 'off');
  const parts: string[] = [];
  if (f.part !== undefined) parts.push(`Part ${pct(f.part)}`);
  if (f.chamber !== undefined) parts.push(`Chamber ${pct(f.chamber)}${f.chamberAuto && f.chamber > 0.005 ? ' (auto)' : ''}`);
  if (f.side !== undefined) parts.push(`Side ${pct(f.side)}`);
  if (f.hotend !== undefined) parts.push(`Hotend ${f.hotend > 0.005 ? 'on' : 'off'}`);
  if (f.heater !== undefined) parts.push(`Heater ${pct(f.heater)}`);
  return parts.join(' · ');
}
function timeAgo(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}
const stateLabel: Record<string, string> = {
  offline: 'Offline', standby: 'Ready', printing: 'Printing', paused: 'Paused',
  complete: 'Complete', cancelled: 'Cancelled', error: 'Error',
};
const evIcon: Record<string, string> = {
  print_finished: '✅', print_cancelled: '🛑', filament_runout: '🧵', klipper_error: '⚠️',
  printer_offline: '📴', printer_online: '🔌', stall_suspected: '⏳', print_started: '▶️', paused: '⏸️', info: 'ℹ️',
  printer_fault: '⚠️', fault_cleared: '✔️', heaters_idle: '🔥', heaters_off: '🧯', ai_failure: '🤖', idle_off: '💡', jam_suspected: '🧵', reference_mismatch: '📐',
};

/* ---------- camera (snapshot polling via backend) ---------- */
// The WebRTC relay produces ~1 new frame/s (keyframe mode) and MJPEG snapshots are
// similar, so polling faster only re-downloads the same image (through Tailscale).
const CAMERA_REFRESH_MS = 1000;

function Camera({ printer }: { printer: Printer }) {
  const [src, setSrc] = useState<string>('');
  const [failed, setFailed] = useState(false);
  const live = printer.live;
  const active = !!live?.online;
  const alive = useRef(true);
  const timer = useRef<number | undefined>(undefined);

  // Load the next frame after `delay`, but only while the page is visible:
  // a hidden tab / locked phone pulls nothing.
  const next = (delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!alive.current) return;
      if (document.hidden) { next(CAMERA_REFRESH_MS); return; }
      setSrc(api.snapshotUrl(printer.id) + '?t=' + Date.now());
    }, delay);
  };

  useEffect(() => {
    alive.current = true;
    if (!active || printer.cameraType === 'none') { setSrc(''); return; }
    next(0);
    return () => { alive.current = false; window.clearTimeout(timer.current); };
  }, [active, printer.id, printer.cameraType]);

  if (!active || printer.cameraType === 'none') return null;
  return (
    <div class="cam">
      {!failed && src && (
        <img src={src} alt="camera"
          onLoad={() => { setFailed(false); next(CAMERA_REFRESH_MS); }}
          onError={() => { setFailed(true); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => { if (alive.current) { setFailed(false); next(0); } }, 4000); }} />
      )}
      {failed && <div class="noimg">{printer.cameraType === 'webrtc' ? 'Connecting camera…' : 'Camera unavailable'}</div>}
    </div>
  );
}

/* ---------- printer card ---------- */
function PrinterCard({ printer, onEdit, toLabel, onLabelled, onLater }: {
  printer: Printer; onEdit: (p: Printer) => void;
  toLabel?: StoppedPrint; onLabelled: () => void; onLater: (id: number) => void;
}) {
  const s = printer.live;
  const st = s?.state || 'offline';
  const [showRef, setShowRef] = useState(false);
  const busy = useRef(false);
  const act = async (a: 'pause' | 'resume' | 'cancel') => {
    if (busy.current) return; busy.current = true;
    try { if (a === 'cancel' && !confirm('Cancel this print?')) return; await api.action(printer.id, a); }
    catch (e: any) { alert(`Couldn't ${a} ${printer.name}: ${e?.message || e}`); }
    finally { busy.current = false; }
  };
  return (
    <div class={`card ${st} ${!s?.online ? 'offline-dim' : ''}`}>
      <div class="card-tools">
        <button class="icon-btn" title="Edit" onClick={() => onEdit(printer)}>✏️</button>
        <button class="icon-btn" title="Remove" onClick={async () => { if (confirm(`Remove ${printer.name}?`)) await api.removePrinter(printer.id); }}>×</button>
      </div>
      <div class="chead">
        <div><div class="pname">{printer.name}</div><div class="pip">{printer.ip}</div></div>
        <span class={`badge ${st}`}><span class="dot" />{stateLabel[st] || st}</span>
      </div>
      <div class="prog">
        <div class="prog-top">
          <span class="prog-file">{s?.filename || '—'}</span>
          <span class="prog-pct">{s ? Math.round((s.progress || 0) * 100) : 0}%</span>
        </div>
        <div class="bar"><div class="fill" style={{ width: `${s ? (s.progress || 0) * 100 : 0}%` }} /></div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">🛏️ Bed</div><div class="v">{s ? `${s.bedTemp}° / ${s.bedTarget}°` : '—'}</div></div>
        <div class="stat"><div class="k">🔥 Nozzle</div><div class="v">{s ? `${s.extruderTemp}° / ${s.extruderTarget}°` : '—'}</div></div>
        <div class="stat"><div class="k">⏱️ Elapsed</div><div class="v">{fmtDur(s?.printDuration)}</div></div>
        <div class="stat"><div class="k">🏁 ETA</div><div class="v">{fmtETA(s?.etaSeconds)}</div></div>
        <div class="stat"><div class="k">🌡️ Chamber</div><div class="v">{fmtChamber(s?.chamber)}</div></div>
        <div class="stat"><div class="k">💡 Light</div><div class="v">{s?.peripherals?.light === undefined ? '—' : s.peripherals.light > 0 ? 'On' : 'Off'}</div></div>
      </div>
      {s?.online && s.fans && Object.keys(s.fans).length > 0 && <div class="fan-line">💨 {fmtFans(s.fans)}</div>}
      {(s?.fault || (st === 'error' && s?.errorText)) && (
        <div class="fault-banner" title={s!.fault?.message || undefined}>
          ⚠️ {s!.fault ? <b>Error {s!.fault.code}</b> : <b>Printer error</b>}: {s!.fault?.description || s!.errorText}
          {(s!.bedTarget > 0 || s!.extruderTarget > 0) && <div class="fault-heat">🔥 Heaters still on</div>}
        </div>
      )}
      {s?.filamentDetected === false && <div class="muted" style="margin-top:8px;color:var(--st-offline)">🧵 Filament runout detected</div>}
      {s?.ai && (st === 'printing' || st === 'paused') && (
        <div class={`ai-line ai-${s.ai.assessment}`} title={[s.ai.reason, ...(s.ai.defects || [])].filter(Boolean).join(' · ')}>
          🤖 {s.ai.assessment === 'success' ? 'Looks OK' : s.ai.assessment === 'failure' ? 'Likely failing' : 'Warning'}
          {' '}<span class="muted">(failure risk {s.ai.confidence}%, {timeAgo(s.ai.at)})</span>
          {s.ai.reason && <div class="ai-reason">{s.ai.reason}</div>}
        </div>
      )}
      {toLabel && st !== 'printing' && st !== 'paused' && (
        <LabelPrompt print={toLabel} onDone={onLabelled} onLater={() => onLater(toLabel.id)} />
      )}
      {s?.reference && (st === 'printing' || st === 'paused') && (
        <div class={`ref-line ${s.reference.ok ? 'ok' : 'bad'}`}>
          📐 {s.reference.ok ? 'Matches' : 'Differs from'} a successful run {s.reference.samePrinter ? 'on this printer' : `on ${s.reference.refPrinterName}`}
          {' '}<span class="muted">(diff {s.reference.score} / {s.reference.limit} · now {s.reference.progress}% · reference {s.reference.refProgress}%)</span>
          <button class="chip" style="margin-left:6px" onClick={() => setShowRef(!showRef)}>{showRef ? 'Hide' : 'Compare'}</button>
        </div>
      )}
      <Camera printer={printer} />
      {showRef && s?.reference && (
        <div class="ref-view">
          <div class="muted">Successful run {s.reference.samePrinter ? '(this printer)' : `on ${s.reference.refPrinterName}`} at {s.reference.refProgress}% (this print was at {s.reference.progress}% when compared):</div>
          <img src={api.referenceFrameUrl(printer.id, s.reference.at)} alt="reference frame" />
        </div>
      )}
      {s?.online && (st === 'printing' || st === 'paused') && (
        <div class="actions">
          {st === 'printing'
            ? <button class="btn btn-sm" onClick={() => act('pause')}>⏸ Pause</button>
            : <button class="btn btn-sm btn-primary" onClick={() => act('resume')}>▶ Resume</button>}
          <button class="btn btn-sm btn-danger" onClick={() => act('cancel')}>🛑 Cancel</button>
        </div>
      )}
    </div>
  );
}

/* ---------- add/edit modal ---------- */
function PrinterModal({ printer, onClose }: { printer: Printer | 'new'; onClose: () => void }) {
  const editing = printer !== 'new';
  const [name, setName] = useState(editing ? (printer as Printer).name : '');
  const [ip, setIp] = useState(editing ? (printer as Printer).ip : '');
  const [cameraType, setCameraType] = useState(editing ? (printer as Printer).cameraType : 'auto');
  const save = async () => {
    if (!name || !ip) return alert('Name and IP required');
    if (editing) await api.updatePrinter((printer as Printer).id, { name, ip, cameraType });
    else await api.addPrinter({ name, ip, cameraType });
    onClose();
  };
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal-box">
        <h2>{editing ? 'Edit printer' : 'Add printer'}</h2>
        <div class="field"><label>Name</label><input value={name} onInput={(e: any) => setName(e.target.value)} placeholder="K2 Plus" /></div>
        <div class="field"><label>IP address</label><input value={ip} onInput={(e: any) => setIp(e.target.value)} placeholder="10.0.68.21" /></div>
        <div class="field"><label>Camera</label>
          <select value={cameraType} onChange={(e: any) => setCameraType(e.target.value)}>
            <option value="auto">Auto</option><option value="mjpeg">MJPEG (K1/K1C)</option>
            <option value="webrtc">WebRTC (K2)</option><option value="none">None</option>
          </select>
        </div>
        <div class="row"><button class="btn btn-primary" style="flex:1" onClick={save}>{editing ? 'Save' : 'Add'}</button>
          <button class="btn btn-ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}

/* ---------- frame viewer (lightbox) ---------- */
// Full-screen view of a print's saved frames, opening on the last one. Step back with
// the arrows / ← → keys / swipe to see when it went wrong. Esc, × or tapping outside closes.
function FrameViewer({ printId, title, onClose }: { printId: number; title: string; onClose: () => void }) {
  const [frames, setFrames] = useState<{ name: string; t: number }[] | null>(null);
  const [i, setI] = useState(0);
  const touchX = useRef<number | null>(null);
  useEffect(() => {
    api.printFrames(printId).then(f => { setFrames(f); setI(Math.max(0, f.length - 1)); }).catch(() => setFrames([]));
  }, [printId]);
  const n = frames?.length ?? 0;
  const go = (d: number) => setI(x => Math.min(Math.max(0, x + d), Math.max(0, n - 1)));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow; };
  }, [n]);
  const f = frames?.[i];
  const end = frames?.[n - 1]?.t;
  const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const before = f && end ? Math.round((end - f.t) / 60000) : 0;
  return createPortal(
    <div class="lightbox" onClick={(e) => e.target === e.currentTarget && onClose()}
      onTouchStart={(e: any) => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={(e: any) => {
        if (touchX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchX.current; touchX.current = null;
        if (Math.abs(dx) > 40) go(dx > 0 ? -1 : 1);
      }}>
      <div class="lb-top">
        <div class="lb-title">{title}</div>
        <button class="lb-btn" onClick={onClose} title="Close (Esc)">×</button>
      </div>
      {frames === null && <div class="lb-msg">Loading…</div>}
      {frames && n === 0 && (
        <img class="lb-img" src={api.lastFrameUrl(printId)} alt="last frame" onClick={(e) => e.stopPropagation()} />
      )}
      {f && <img class="lb-img" src={api.printFrameUrl(printId, f.name)} alt={`frame ${i + 1}`} />}
      {f && (
        <div class="lb-bar">
          <button class="lb-btn" disabled={i === 0} onClick={() => go(-1)} title="Earlier (←)">‹</button>
          <div class="lb-cap">
            {fmtTime(f.t)} · {i === n - 1 ? 'last frame' : `${before} min before the end`}
            <div class="lb-sub">frame {i + 1} of {n} · every 20 s</div>
          </div>
          <button class="lb-btn" disabled={i === n - 1} onClick={() => go(1)} title="Later (→)">›</button>
        </div>
      )}
      {frames && n > 1 && (
        <input class="lb-scrub" type="range" min={0} max={n - 1} value={i}
          onInput={(e: any) => setI(Number(e.currentTarget.value))} aria-label="Frame" />
      )}
      {/* Preload neighbours so stepping is instant. */}
      {frames && [i - 1, i + 1].filter(k => k >= 0 && k < n).map(k =>
        <link rel="preload" as="image" href={api.printFrameUrl(printId, frames[k].name)} />)}
    </div>,
    document.body,
  );
}

/* ---------- failure labels (training data) ---------- */
function ReasonChips({ print, onDone }: { print: StoppedPrint; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const pick = async (key: string) => {
    let note: string | undefined;
    if (key === 'other') { const n = prompt('What went wrong? (short note)'); if (n === null) return; note = n; }
    setBusy(true);
    try { await api.label(print.id, key, note); onDone(); }
    catch (e: any) { alert(`Couldn't save the label: ${e?.message || e}`); }
    finally { setBusy(false); }
  };
  return (
    <div class="chips">
      {FAILURE_REASONS.map(r => <button class="chip" disabled={busy} onClick={() => pick(r.key)}>{r.label}</button>)}
    </div>
  );
}

function LabelPrompt({ print, onDone, onLater }: { print: StoppedPrint; onDone: () => void; onLater: () => void }) {
  const [view, setView] = useState(false);
  return (
    <div class="label-prompt">
      {view && <FrameViewer printId={print.id} title={`${print.printerName} · ${print.filename || 'print'}`} onClose={() => setView(false)} />}
      <div class="label-head">
        <img class="thumb clickable" src={api.lastFrameUrl(print.id)} alt="" title="Tap to view (and step back through the frames)"
          onClick={() => setView(true)} onError={(e: any) => { e.currentTarget.style.display = 'none'; }} />
        <div>
          <div class="label-q">Why did the last print stop?</div>
          <div class="muted">{print.outcome === 'error' ? 'Error' : 'Cancelled'} {timeAgo(print.endedAt)} · {print.filename || 'unknown file'}</div>
        </div>
        <button class="icon-btn" title="Later" onClick={onLater}>×</button>
      </div>
      <ReasonChips print={print} onDone={onDone} />
    </div>
  );
}

function LabelModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<'stopped' | 'all'>('stopped');
  const [rows, setRows] = useState<StoppedPrint[] | null>(null);
  const load = async () => setRows(tab === 'stopped' ? await api.unlabelled() : await api.finished());
  useEffect(() => { setRows(null); load(); }, [tab]);
  const reasonLabel = (k?: string | null) => FAILURE_REASONS.find(r => r.key === k)?.label;
  const [view, setView] = useState<StoppedPrint | null>(null);
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal-box">
        {view && <FrameViewer printId={view.id} title={`${view.printerName} · ${view.filename || 'print'}`} onClose={() => setView(null)} />}
        <h2>Label failed prints</h2>
        <p class="muted" style="margin-bottom:12px">Saying why prints failed turns the recorded camera frames and sensor data into training data for better failure detection.</p>
        <div class="row" style="margin-bottom:12px">
          <button class={`btn btn-sm ${tab === 'stopped' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('stopped')}>Needs a label</button>
          <button class={`btn btn-sm ${tab === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('all')}>All recent (mark a completed print as bad)</button>
          <button class="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
        </div>
        {!rows && <p class="muted">Loading…</p>}
        {rows && rows.length === 0 && <p class="muted">{tab === 'stopped' ? 'Nothing to label. 🎉' : 'No prints in the last week.'}</p>}
        {rows && rows.map(p => (
          <div class="label-row">
            <div class="label-head">
              <img class="thumb clickable" src={api.lastFrameUrl(p.id)} alt="" title="Tap to view (and step back through the frames)"
                onClick={() => setView(p)} onError={(e: any) => { e.currentTarget.style.display = 'none'; }} />
              <div>
                <div class="label-q">{p.printerName}: {p.outcome}{p.reason ? ` · ${reasonLabel(p.reason)}` : ''}</div>
                <div class="muted">{timeAgo(p.endedAt)} · {p.filename || 'unknown file'}{p.note ? ` · “${p.note}”` : ''}</div>
              </div>
            </div>
            <ReasonChips print={p} onDone={() => { onChanged(); load(); }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- scan modal ---------- */
function ScanModal({ printers, onClose }: { printers: Printer[]; onClose: () => void }) {
  const [rows, setRows] = useState<{ ip: string; hostname: string; known: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setRows(await api.scan()); } finally { setBusy(false); } };
  useEffect(() => { run(); }, []);
  const apply = async (r: { ip: string; hostname: string }, target: string) => {
    if (target === 'new') await api.addPrinter({ name: r.hostname || `Printer ${r.ip}`, ip: r.ip });
    else await api.updatePrinter(Number(target), { ip: r.ip });
  };
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal-box">
        <h2>Scan network</h2>
        <p class="muted" style="margin-bottom:12px">Finds Moonraker printers on the LAN (via the Pi). Add new ones or repoint an existing printer to its current IP.</p>
        <div class="row" style="margin-bottom:12px"><button class="btn btn-sm btn-primary" onClick={run} disabled={busy}>{busy ? 'Scanning…' : 'Rescan'}</button>
          <button class="btn btn-sm btn-ghost" onClick={onClose}>Close</button></div>
        {!rows && <p class="muted">Scanning…</p>}
        {rows && rows.length === 0 && <p class="muted">No printers found.</p>}
        {rows && rows.map((r) => (
          <div class="scan-row">
            <div><div class="hn">{r.hostname || 'Unknown'}</div><div class="ip">{r.ip}</div></div>
            {r.known ? <span class="muted">✓ added</span> : <Applier r={r} printers={printers} onApply={apply} />}
          </div>
        ))}
      </div>
    </div>
  );
}
function Applier({ r, printers, onApply }: any) {
  const [t, setT] = useState('new'); const [done, setDone] = useState(false);
  if (done) return <span class="muted" style="color:var(--st-ready)">✓ done</span>;
  return (
    <div class="row">
      <select value={t} onChange={(e: any) => setT(e.target.value)}>
        <option value="new">➕ Add new</option>
        {printers.map((p: Printer) => <option value={p.id}>↻ {p.name}</option>)}
      </select>
      <button class="btn btn-sm btn-primary" onClick={async () => { await onApply(r, t); setDone(true); }}>Apply</button>
    </div>
  );
}

/* ---------- app ---------- */
export function App() {
  const { printers, events, connected, labelsVersion } = useStore();
  const [modal, setModal] = useState<null | { kind: 'printer'; p: Printer | 'new' } | { kind: 'scan' } | { kind: 'labels' }>(null);
  // Stopped prints still needing a failure reason (refreshed when one is labelled or a print stops).
  const [toLabel, setToLabel] = useState<StoppedPrint[]>([]);
  const [later, setLater] = useState<Set<number>>(new Set());
  const loadLabels = () => api.unlabelled().then(setToLabel).catch(() => {});
  useEffect(() => { loadLabels(); }, [labelsVersion]);
  useEffect(() => { const t = setInterval(loadLabels, 120_000); return () => clearInterval(t); }, []);
  const newestToLabel = (printerId: number) => toLabel.find(p => p.printerId === printerId && !later.has(p.id));
  const [push, setPush] = useState(pushStatus());
  const [theme, setTheme] = useState(document.documentElement.getAttribute('data-theme') || 'dark');

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); localStorage.setItem('theme', next); document.documentElement.setAttribute('data-theme', next);
  };
  const doPush = async () => {
    // Browsers only offer push on HTTPS (or localhost); on plain http the APIs don't exist.
    if (!window.isSecureContext) {
      alert('Notifications need a secure (HTTPS) connection, and this page is plain http://' + location.host + '.\n\n' +
            'Open the dashboard through its HTTPS address (Cloudflare Tunnel), or in Chrome allow this address under ' +
            'chrome://flags → "Insecure origins treated as secure", then relaunch Chrome and try again.');
      return;
    }
    let r: ReturnType<typeof pushStatus>;
    try { r = await enablePush(); }
    catch (e: any) { alert(`Couldn't enable notifications: ${e?.message || e}`); return; }
    setPush(r);
    if (r === 'granted') {
      try { await api.testPush(); alert('Notifications are on. A test notification was sent to this device.'); }
      catch (e: any) { alert(`Notifications are on, but the test notification wasn't delivered: ${e?.message || e}`); }
    } else if (r === 'denied') alert('Notifications are blocked. Allow them for this site in your browser settings, then try again.');
    else if (r === 'unsupported') alert('This browser does not support push notifications.');
  };

  const counts = { printing: 0, ready: 0, offline: 0, complete: 0 };
  for (const p of printers) {
    const s = p.live?.state;
    if (s === 'printing' || s === 'paused') counts.printing++;
    else if (s === 'complete') counts.complete++;
    else if (!p.live?.online) counts.offline++;
    else counts.ready++;
  }
  const order = (p: Printer) => ({ printing: 0, paused: 1, complete: 2, standby: 3, error: 3, cancelled: 4, offline: 5 } as any)[p.live?.state || 'offline'] ?? 5;
  const sorted = [...printers].sort((a, b) => order(a) - order(b));

  return (
    <div class="app">
      <div class="topbar">
        <div class="brand"><span class="logo">🖨️</span> Control Center</div>
        <span class={`conn ${connected ? 'on' : 'off'}`}>{connected ? 'live' : 'reconnecting…'}</span>
        <div class="overview">
          <div class="tile printing"><span class="n">{counts.printing}</span><span class="l">Printing</span></div>
          <div class="tile ready"><span class="n">{counts.ready}</span><span class="l">Ready</span></div>
          <div class="tile done"><span class="n">{counts.complete}</span><span class="l">Done</span></div>
          <div class="tile offline"><span class="n">{counts.offline}</span><span class="l">Offline</span></div>
        </div>
        <div class="spacer" />
        {toLabel.length > 0 && (
          <button class="btn btn-ghost btn-sm" title="Failed prints that need a reason" onClick={() => setModal({ kind: 'labels' })}>🏷️ {toLabel.length}</button>
        )}
        <button class="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'printer', p: 'new' })}>＋ Add</button>
        <button class="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'scan' })}>🔍 Scan</button>
        <button class="btn btn-ghost btn-sm" onClick={doPush} title="Notifications">
          {push === 'granted' ? '🔔' : push === 'denied' ? '🔕' : '🔔 Enable'}
        </button>
        <button class="btn btn-ghost btn-sm" onClick={toggleTheme}>{theme === 'dark' ? '🌙' : '☀️'}</button>
      </div>

      <main>
        {printers.length === 0 && <p class="muted" style="text-align:center;padding:40px">No printers yet. Click Add or Scan.</p>}
        <div class="grid">
          {sorted.map((p) => <PrinterCard key={p.id} printer={p} onEdit={(pr) => setModal({ kind: 'printer', p: pr })}
            toLabel={newestToLabel(p.id)} onLabelled={loadLabels} onLater={(id) => setLater(new Set([...later, id]))} />)}
        </div>

        {events.length > 0 && (
          <section class="events">
            <h2>Recent events</h2>
            {events.slice(0, 25).map((e: PrinterEvent) => (
              <div class={`evt ${e.severity}`}>
                <span class="ic">{evIcon[e.type] || 'ℹ️'}</span>
                <div><div class="et">{e.title}{e.actionTaken ? ` · ${e.actionTaken}` : ''}</div><div class="em">{e.message}</div>
                  {e.pushResult && <div class="push-res">📲 {e.pushResult}</div>}</div>
                <span class="ts">{timeAgo(e.createdAt)}</span>
              </div>
            ))}
          </section>
        )}
      </main>

      {modal?.kind === 'printer' && <PrinterModal printer={modal.p} onClose={() => setModal(null)} />}
      {modal?.kind === 'scan' && <ScanModal printers={printers} onClose={() => setModal(null)} />}
      {modal?.kind === 'labels' && <LabelModal onClose={() => setModal(null)} onChanged={loadLabels} />}
    </div>
  );
}
