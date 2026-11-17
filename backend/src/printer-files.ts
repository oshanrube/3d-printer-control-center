// G-code files on a printer, over Moonraker's HTTP API (store jobs, phase 3).
import type { Printer } from './types.js';

const base = (p: Printer) => `http://${String(p.ip).replace(/^https?:\/\//, '').split(':')[0]}:${p.moonrakerPort || 7125}`;

async function call(p: Printer, path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<any> {
  const res = await fetch(base(p) + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${p.name}: ${path.split('?')[0]} HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`);
  return body?.result;
}

/** The printer's current print state, asked fresh (not from the live cache). */
export async function printState(p: Printer): Promise<string> {
  const r = await call(p, '/printer/objects/query?print_stats=state');
  return r?.status?.print_stats?.state ?? 'unknown';
}

export async function listGcodes(p: Printer): Promise<{ path: string; size: number; modified: number }[]> {
  return (await call(p, '/server/files/list?root=gcodes')) ?? [];
}

export async function uploadGcode(p: Printer, name: string, data: Buffer): Promise<void> {
  const form = new FormData();
  form.append('root', 'gcodes');
  form.append('file', new Blob([new Uint8Array(data)]), name);
  await call(p, '/server/files/upload', { method: 'POST', body: form }, 10 * 60_000);
}

export async function deleteGcode(p: Printer, path: string): Promise<void> {
  await call(p, `/server/files/gcodes/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
}

export async function startPrint(p: Printer, filename: string): Promise<void> {
  await call(p, `/printer/print/start?filename=${encodeURIComponent(filename)}`, { method: 'POST' }, 60_000);
}
