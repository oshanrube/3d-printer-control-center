export interface LiveState {
  printerId: number; online: boolean; state: string; stateMessage?: string;
  filename?: string | null; progress: number; printDuration: number; totalDuration: number;
  etaSeconds?: number | null; bedTemp: number; bedTarget: number;
  extruderTemp: number; extruderTarget: number; filamentDetected?: boolean | null;
  fault?: { code: number; message: string; description: string } | null; vendorBusy?: boolean;
  errorText?: string;
  peripherals?: { light?: number; fan0?: number; fan1?: number; fan2?: number };
  chamber?: { temp: number; target?: number; heaterPower?: number } | null;
  fans?: { part?: number; chamber?: number; chamberAuto?: boolean; side?: number; hotend?: number; heater?: number };
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
}

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`${res.status}`);
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
  snapshotUrl: (id: number) => `/api/camera/${id}/snapshot`,
};
