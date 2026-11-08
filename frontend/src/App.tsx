import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Printer, type PrinterEvent } from './api';
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
};

/* ---------- camera (snapshot polling via backend) ---------- */
function Camera({ printer }: { printer: Printer }) {
  const [src, setSrc] = useState<string>('');
  const [failed, setFailed] = useState(false);
  const live = printer.live;
  const active = !!live?.online;

  useEffect(() => {
    if (!active || printer.cameraType === 'none') { setSrc(''); return; }
    let stop = false;
    const tick = () => { if (!stop) setSrc(api.snapshotUrl(printer.id) + '?t=' + Date.now()); };
    tick();
    return () => { stop = true; };
  }, [active, printer.id, printer.cameraType]);

  if (!active || printer.cameraType === 'none') return null;
  return (
    <div class="cam">
      {!failed && src && (
        <img src={src} alt="camera"
          onLoad={() => { setFailed(false); setTimeout(() => setSrc(api.snapshotUrl(printer.id) + '?t=' + Date.now()), 350); }}
          onError={() => { setFailed(true); setTimeout(() => { setFailed(false); setSrc(api.snapshotUrl(printer.id) + '?t=' + Date.now()); }, 4000); }} />
      )}
      {failed && <div class="noimg">{printer.cameraType === 'webrtc' ? 'Connecting camera…' : 'Camera unavailable'}</div>}
    </div>
  );
}

/* ---------- printer card ---------- */
function PrinterCard({ printer, onEdit }: { printer: Printer; onEdit: (p: Printer) => void }) {
  const s = printer.live;
  const st = s?.state || 'offline';
  const busy = useRef(false);
  const act = async (a: 'pause' | 'resume' | 'cancel') => {
    if (busy.current) return; busy.current = true;
    try { if (a === 'cancel' && !confirm('Cancel this print?')) return; await api.action(printer.id, a); }
    catch { alert('Action failed'); } finally { busy.current = false; }
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
      </div>
      {s?.filamentDetected === false && <div class="muted" style="margin-top:8px;color:var(--st-offline)">🧵 Filament runout detected</div>}
      <Camera printer={printer} />
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
  const { printers, events, connected } = useStore();
  const [modal, setModal] = useState<null | { kind: 'printer'; p: Printer | 'new' } | { kind: 'scan' }>(null);
  const [push, setPush] = useState(pushStatus());
  const [theme, setTheme] = useState(document.documentElement.getAttribute('data-theme') || 'dark');

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); localStorage.setItem('theme', next); document.documentElement.setAttribute('data-theme', next);
  };
  const doPush = async () => {
    const r = await enablePush(); setPush(r);
    if (r === 'granted') { try { await api.testPush(); } catch {} }
    else if (r === 'denied') alert('Notifications blocked. Enable them for this site in your browser settings.');
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
          {sorted.map((p) => <PrinterCard key={p.id} printer={p} onEdit={(pr) => setModal({ kind: 'printer', p: pr })} />)}
        </div>

        {events.length > 0 && (
          <section class="events">
            <h2>Recent events</h2>
            {events.slice(0, 25).map((e: PrinterEvent) => (
              <div class={`evt ${e.severity}`}>
                <span class="ic">{evIcon[e.type] || 'ℹ️'}</span>
                <div><div class="et">{e.title}{e.actionTaken ? ` · ${e.actionTaken}` : ''}</div><div class="em">{e.message}</div></div>
                <span class="ts">{timeAgo(e.createdAt)}</span>
              </div>
            ))}
          </section>
        )}
      </main>

      {modal?.kind === 'printer' && <PrinterModal printer={modal.p} onClose={() => setModal(null)} />}
      {modal?.kind === 'scan' && <ScanModal printers={printers} onClose={() => setModal(null)} />}
    </div>
  );
}
