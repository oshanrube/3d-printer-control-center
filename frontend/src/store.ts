import { useEffect, useState } from 'preact/hooks';
import type { Printer, PrinterEvent, LiveState } from './api';

interface State {
  connected: boolean;
  printers: Printer[];
  events: PrinterEvent[];
}

let state: State = { connected: false, printers: [], events: [] };
const listeners = new Set<() => void>();
function set(next: Partial<State>) { state = { ...state, ...next }; listeners.forEach(l => l()); }

let ws: WebSocket | null = null;
let reconnectTimer: any = null;

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.onopen = () => set({ connected: true });
  ws.onclose = () => {
    set({ connected: false });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };
  ws.onerror = () => { try { ws?.close(); } catch {} };
  ws.onmessage = (ev) => {
    let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot') {
      set({ printers: msg.printers, events: msg.events });
    } else if (msg.type === 'state') {
      const live: LiveState = msg.state;
      set({ printers: state.printers.map(p => p.id === live.printerId ? { ...p, live } : p) });
    } else if (msg.type === 'event') {
      set({ events: [msg.event, ...state.events].slice(0, 200) });
      onEventHooks.forEach(h => h(msg.event));
    }
  };
}

const onEventHooks = new Set<(e: PrinterEvent) => void>();
export function onEvent(fn: (e: PrinterEvent) => void) { onEventHooks.add(fn); return () => onEventHooks.delete(fn); }

export function startStore() { if (!ws) connect(); }
export function getState() { return state; }
export function refreshPrinters(printers: Printer[]) { set({ printers }); }

export function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force(x => x + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return state;
}
