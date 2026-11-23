// Store jobs on a printer card: available switch, loaded filament, bed cleared, readiness.
import { useState } from 'preact/hooks';
import { api, type PrinterReadiness, type StoreJob } from './api';
import { JobActions, jobLabel } from './Inventory';

const fail = (what: string) => (e: any) => alert(`${what}: ${e?.message || e}`);

export function StoreJobStrip({ r, storeColours, onChange, job }: { r: PrinterReadiness; storeColours: string[]; onChange: () => void; job?: StoreJob }) {
  const [editing, setEditing] = useState(false);
  const [material, setMaterial] = useState(r.manualMaterial);
  const [colour, setColour] = useState(r.manualColour);
  const idle = r.online && ['standby', 'complete', 'cancelled'].includes(r.state);
  const act = (p: Promise<unknown>, what: string) => p.then(onChange).catch(fail(what));
  return (
    <div class={`job-strip ${r.ready ? 'ready' : ''}`}>
      <div class="job-top">
        <label class="inv-check" title="Let the controller load store jobs on this printer">
          <input type="checkbox" checked={r.available} onChange={(e: any) => act(api.printerJobs(r.id, { available: e.currentTarget.checked }), 'Saving')} />
          Store jobs
        </label>
        {r.available && (
          <label class="inv-check" title="When the camera sees the bed is clear, load AND start the next job automatically. Clear the bed once with the button below to teach the camera this printer's empty bed.">
            <input type="checkbox" checked={r.autoStart} onChange={(e: any) => act(api.printerJobs(r.id, { autoStart: e.currentTarget.checked }), 'Saving')} />
            🤖 Auto-start
          </label>
        )}
        <span class={r.ready ? 'job-ok' : 'muted'}>{r.ready ? '✅ ready for the next job' : r.available ? `⏳ ${r.why}` : ''}</span>
        <div class="spacer" />
        {r.available && idle && !r.bedClear && (
          <button class="btn btn-sm btn-primary" title={r.autoStart ? "Confirm the bed is empty and teach the camera what a clear bed looks like" : "Confirm the bed is empty"} onClick={() => act(api.bedCleared(r.id), 'Saving')}>Bed cleared</button>
        )}
      </div>
      {r.available && r.autoStart && (
        <div class="muted job-autostart">
          {!r.hasBedRef ? '📷 Clear the bed once and press “Bed cleared” to teach the camera this printer’s empty bed.'
            : r.bedClear ? '📷 Bed is clear — the next queued job will load and start automatically.'
            : idle ? '📷 Watching the camera: clear the bed and it will auto-start the next job.'
            : '🤖 Auto-start on: will advance the queue once this print ends and the bed is clear.'}
        </div>
      )}
      {job && (
        <div class={`job-now job-${job.status}`}>
          📦 <b>{jobLabel(job)}</b>
          <span class="muted">{job.status === 'loaded' ? `loaded (${job.file}): clear the bed and start it` : job.status === 'printing' ? 'printing' : job.status === 'printed' ? 'printed: check it' : job.status}</span>
          <div class="spacer" /><JobActions j={job} onDone={onChange} />
        </div>
      )}
      {(
        <div class="job-fil" title={r.filamentSource === 'printer' ? 'Read from the spool set on the printer' : 'Set here: this printer can\'t report its spool'}>
          🧵{' '}
          {r.spools.length
            ? r.spools.map(s => (
                <span class="spool" title={`${s.slot}${s.name ? ` · ${s.name}` : ''}`}>
                  <i style={{ background: s.colour || 'transparent' }} />{s.material} {s.colourName || s.colour}{r.spools.length > 1 ? ` (${s.slot})` : ''}
                </span>))
            : <span class="muted">{r.filamentSource === 'none' ? 'Loaded filament not set' : 'No spool loaded'}</span>}
          {r.filamentSource === 'printer'
            ? <button class="chip" title="Read the spools set on the printer's screen" onClick={() => act(api.refreshFilament(r.id), 'Reading the spools')}>↻</button>
            : <button class="chip" onClick={() => { setMaterial(r.manualMaterial); setColour(r.manualColour); setEditing(!editing); }}>{editing ? 'Close' : r.filamentSource === 'manual' ? 'Change' : 'Set'}</button>}
        </div>
      )}
      {editing && r.filamentSource !== 'printer' && (
        <div class="job-edit">
          <input class="inv-mat" placeholder="Material (ABS…)" value={material} onInput={(e: any) => setMaterial(e.currentTarget.value)} />
          <select value={colour} onChange={(e: any) => setColour(e.currentTarget.value)}>
            <option value="">Colour…</option>
            {storeColours.map(c => <option value={c}>{c}</option>)}
          </select>
          <button class="btn btn-sm btn-primary" onClick={() => act(api.printerJobs(r.id, { manualMaterial: material, manualColour: colour }), 'Saving').then(() => setEditing(false))}>Save</button>
          <span class="muted">This printer's firmware can't report its spool, so set what's loaded here when you change it.</span>
        </div>
      )}
    </div>
  );
}
