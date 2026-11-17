// Store jobs on a printer card: available switch, loaded filament, bed cleared, readiness.
import { useState } from 'preact/hooks';
import { api, type PrinterReadiness } from './api';

const fail = (what: string) => (e: any) => alert(`${what}: ${e?.message || e}`);

export function StoreJobStrip({ r, storeColours, onChange }: { r: PrinterReadiness; storeColours: string[]; onChange: () => void }) {
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
        <span class={r.ready ? 'job-ok' : 'muted'}>{r.ready ? '✅ ready for the next job' : r.available ? `⏳ ${r.why}` : ''}</span>
        <div class="spacer" />
        {r.available && idle && !r.bedClear && (
          <button class="btn btn-sm btn-primary" onClick={() => act(api.bedCleared(r.id), 'Saving')}>Bed cleared</button>
        )}
      </div>
      {r.available && (
        <div class="job-fil">
          🧵{' '}
          {r.spools.length
            ? r.spools.map(s => (
                <span class="spool" title={`${s.slot}${s.name ? ` · ${s.name}` : ''}`}>
                  <i style={{ background: s.colour || 'transparent' }} />{s.material} {s.colourName || s.colour}{r.spools.length > 1 ? ` (${s.slot})` : ''}
                </span>))
            : <span class="muted">{r.filamentSource === 'none' ? 'No filament set' : 'No spool loaded'}</span>}
          {r.filamentSource === 'printer'
            ? <button class="chip" title="Read the spools set on the printer's screen" onClick={() => act(api.refreshFilament(r.id), 'Reading the spools')}>↻</button>
            : <button class="chip" onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Set'}</button>}
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
          <span class="muted">This printer's firmware can't report its spool: update it to 2.3.5 to read it automatically.</span>
        </div>
      )}
    </div>
  );
}
