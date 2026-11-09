export interface LiveState {
  printerId: number; online: boolean; state: string; stateMessage?: string;
  filename?: string | null; progress: number; printDuration: number; totalDuration: number;
  etaSeconds?: number | null; bedTemp: number; bedTarget: number;
  extruderTemp: number; extruderTarget: number; filamentDetected?: boolean | null;
  fault?: { code: number; message: string; description: string } | null; vendorBusy?: boolean;
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
  action: (id: number, a: 'pause' | 'resume' | 'cancel') =>
    j(`/api/printers/${id}/${a}`, { method: 'POST' }),
  events: (limit = 100) => j<PrinterEvent[]>(`/api/events?limit=${limit}`),
  scan: (base?: string) => j<{ ip: string; hostname: string; known: boolean }[]>(`/api/scan${base ? `?base=${base}` : ''}`),
  vapid: () => j<{ publicKey: string }>('/api/push/vapid'),
  subscribe: (sub: any) => j('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) }),
  testPush: () => j('/api/push/test', { method: 'POST' }),
  snapshotUrl: (id: number) => `/api/camera/${id}/snapshot`,
};
