export interface LiveState {
  printerId: number; online: boolean; state: string; stateMessage?: string;
  filename?: string | null; progress: number; printDuration: number; totalDuration: number;
  etaSeconds?: number | null; bedTemp: number; bedTarget: number;
  extruderTemp: number; extruderTarget: number; filamentDetected?: boolean | null;
  fault?: { code: number; message: string; description: string } | null; vendorBusy?: boolean;
  vendorFile?: string | null; preparing?: boolean;
  errorText?: string;
  markedOk?: boolean; autoPaused?: string | null;
  peripherals?: { light?: number; fan0?: number; fan1?: number; fan2?: number };
  chamber?: { temp: number; target?: number; heaterPower?: number } | null;
  fans?: { part?: number; chamber?: number; chamberAuto?: boolean; side?: number; hotend?: number; heater?: number };
  reference?: { ok: boolean; score: number; limit: number; samePrinter: boolean; refPrinterName: string; refPrintId: number; at: number; progress: number; refProgress: number } | null;
  ai?: { source: 'detector' | 'vlm'; assessment: 'success' | 'failure' | 'inconclusive'; confidence: number; reason: string; defects: string[]; at: number } | null;
  updatedAt: number;
}
export interface Printer {
  id: number; name: string; ip: string; moonrakerPort: number;
  cameraType: 'auto' | 'mjpeg' | 'webrtc' | 'none'; disabled: boolean; createdAt: number;
  live?: LiveState | null;
}
export interface PrinterEvent {
  id?: number; printerId: number; printerName: string; type: string; severity: string;
  title: string; message: string; filename?: string | null; actionTaken?: string | null; createdAt: number;
  pushResult?: string | null;
}

// ---- Store inventory (phase 1) ----
export interface StoreOption { group: string; value: string }
export interface StoreItem {
  productId: number; combinationId: number; reference: string; productName: string; options: StoreOption[];
  colour: string | null; label: string; storeQty: number; inStore: boolean; enabled: boolean; minQty: number;
  syncedAt: number | null; recipe: { partId: number; qty: number }[];
}
export interface SyncStatus { lastSyncAt: number | null; lastAttemptAt: number | null; lastError: string | null; items: number; reason: string | null; running: boolean }
export interface PartGcode {
  model: string; modelName: string; filename: string; size: number; uploadedAt: number;
  meta: { printerModel?: string; filamentType?: string; filamentColour?: string; printTime?: string; warnings: string[] };
}
export interface Part { id: number; name: string; unitsPerPlate: number; material: string; onHand: number; notes: string; gcodes: PartGcode[] }
export interface Spool { slot: string; material: string; colour: string; name: string; colourName: string | null }
export interface PrinterReadiness {
  id: number; name: string; model: string | null; modelName: string | null; state: string; online: boolean;
  available: boolean; bedClear: boolean; ready: boolean; why: string | null;
  filamentSource: 'printer' | 'manual' | 'none'; spools: Spool[]; manualMaterial: string; manualColour: string;
}
export interface PlannedJob {
  partId: number; part: string; colour: string | null; material: string; unitsPerPlate: number;
  forItems: string[]; printer: { id: number; name: string } | null; reason: string | null;
}
export interface Plan {
  computedAt: number; dryRun: boolean; printers: PrinterReadiness[]; jobs: PlannedJob[];
  items: { reference: string; label: string; storeQty: number; minQty: number; short: number; colour: string | null; problems: string[] }[];
}
export interface PrinterModel { model: string; name: string; printers: string[] }

export interface StoppedPrint {
  id: number; printerId: number; printerName: string; filename: string | null; outcome: string;
  startedAt: number; endedAt: number; reason?: string | null; note?: string | null;
}

// Failure labels (must match the backend's FAILURE_REASONS).
export const FAILURE_REASONS: { key: string; label: string }[] = [
  { key: 'spaghetti', label: '🍝 Spaghetti / came loose' },
  { key: 'jam', label: '🧵 Jam / printing in air' },
  { key: 'layer_shift', label: '↔️ Layer shift' },
  { key: 'warping', label: '📐 Warping / lifted corner' },
  { key: 'adhesion', label: '🧲 Didn\'t stick to bed' },
  { key: 'wrong_file', label: '📄 Wrong file / settings' },
  { key: 'not_failed', label: '✋ Not a failure (I stopped it)' },
  { key: 'other', label: '❓ Other' },
];

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const json = typeof opts?.body === 'string' ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(url, { ...opts, headers: { ...json, ...(opts?.headers || {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `${res.status}`);
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  printers: () => j<Printer[]>('/api/printers'),
  addPrinter: (p: { name: string; ip: string; cameraType?: string }) =>
    j<Printer>('/api/printers', { method: 'POST', body: JSON.stringify(p) }),
  updatePrinter: (id: number, patch: any) =>
    j<Printer>(`/api/printers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removePrinter: (id: number) => j(`/api/printers/${id}`, { method: 'DELETE' }),
  // Resolves { ok, pending? }; throws with the printer's own reason when it refuses.
  action: async (id: number, a: 'pause' | 'resume' | 'cancel'): Promise<{ ok: boolean; pending?: boolean }> => {
    const res = await fetch(`/api/printers/${id}/${a}`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `server returned ${res.status}`);
    return body;
  },
  events: (limit = 100) => j<PrinterEvent[]>(`/api/events?limit=${limit}`),
  scan: (base?: string) => j<{ ip: string; hostname: string; known: boolean }[]>(`/api/scan${base ? `?base=${base}` : ''}`),
  vapid: () => j<{ publicKey: string }>('/api/push/vapid'),
  subscribe: (sub: any) => j('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) }),
  // Throws with the server's explanation (no devices / push service rejected it).
  testPush: async () => {
    const res = await fetch('/api/push/test', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `server returned ${res.status}`);
    return body;
  },
  // "👍 Printing fine": the detectors stop flagging this print (and an auto-pause is resumed).
  looksFine: async (id: number): Promise<{ ok: boolean; resumed?: boolean }> => {
    const res = await fetch(`/api/printers/${id}/looks-fine`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `server returned ${res.status}`);
    return body;
  },
  storeItems: () => j<{ status: SyncStatus; items: StoreItem[] }>('/api/store/items'),
  storeSync: (reason: 'manual' | 'dashboard') => j<{ status: SyncStatus; items: StoreItem[] }>('/api/store/sync', { method: 'POST', body: JSON.stringify({ reason }) }),
  updateItem: (i: StoreItem, patch: { enabled?: boolean; minQty?: number }) =>
    j<StoreItem>(`/api/store/items/${i.productId}/${i.combinationId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  setRecipe: (i: StoreItem, parts: { partId: number; qty: number }[]) =>
    j<StoreItem>(`/api/store/items/${i.productId}/${i.combinationId}/recipe`, { method: 'PUT', body: JSON.stringify({ parts }) }),
  models: () => j<PrinterModel[]>('/api/store/models'),
  parts: () => j<Part[]>('/api/parts'),
  addPart: (p: { name: string; unitsPerPlate: number; material: string }) => j<Part>('/api/parts', { method: 'POST', body: JSON.stringify(p) }),
  updatePart: (id: number, patch: Partial<Pick<Part, 'name' | 'unitsPerPlate' | 'material' | 'onHand' | 'notes'>>) =>
    j<Part>(`/api/parts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePart: (id: number) => j(`/api/parts/${id}`, { method: 'DELETE' }),
  uploadGcode: (id: number, model: string, file: File) =>
    j<Part>(`/api/parts/${id}/gcode/${model}`, { method: 'PUT', body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) } }),
  deleteGcode: (id: number, model: string) => j<Part>(`/api/parts/${id}/gcode/${model}`, { method: 'DELETE' }),
  plan: () => j<Plan>('/api/store/plan'),
  printerJobs: (id: number, patch: { available?: boolean; manualMaterial?: string; manualColour?: string }) =>
    j<PrinterReadiness>(`/api/store/printers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  bedCleared: (id: number) => j<PrinterReadiness>(`/api/store/printers/${id}/bed-cleared`, { method: 'POST' }),
  refreshFilament: (id: number) => j<PrinterReadiness>(`/api/store/printers/${id}/refresh-filament`, { method: 'POST' }),
  colours: () => j<{ map: Record<string, string>; storeColours: string[] }>('/api/store/colours'),
  setColours: (map: Record<string, string>) => j<{ map: Record<string, string>; storeColours: string[] }>('/api/store/colours', { method: 'PUT', body: JSON.stringify({ map }) }),
  partStock: () => j<{ partId: number; colour: string; qty: number }[]>('/api/parts/stock'),
  setPartStock: (id: number, colour: string, qty: number) => j(`/api/parts/${id}/stock`, { method: 'PUT', body: JSON.stringify({ colour, qty }) }),
  snapshotUrl: (id: number) => `/api/camera/${id}/snapshot`,
  unlabelled: () => j<StoppedPrint[]>('/api/prints/unlabelled'),
  finished: () => j<StoppedPrint[]>('/api/prints/finished'),
  label: (id: number, reason: string, note?: string) =>
    j(`/api/prints/${id}/label`, { method: 'POST', body: JSON.stringify({ reason, note }) }),
  lastFrameUrl: (id: number) => `/api/prints/${id}/last-frame`,
  printFrames: (id: number, limit = 90) => j<{ name: string; t: number }[]>(`/api/prints/${id}/frames?limit=${limit}`),
  printFrameUrl: (id: number, name: string) => `/api/prints/${id}/frame/${name}`,
  referenceFrameUrl: (printerId: number, at: number) => `/api/printers/${printerId}/reference-frame?t=${at}`,
};
