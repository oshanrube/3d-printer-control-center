// Shared types for the control-center backend.

export interface Printer {
  id: number;
  name: string;
  ip: string;            // host or host:port; Moonraker assumed on :7125
  moonrakerPort: number; // default 7125
  cameraType: 'auto' | 'mjpeg' | 'webrtc' | 'none';
  webrtcPort?: number;   // libpeer signaling port, default 8000
  disabled: boolean;
  createdAt: number;
}

export interface AiVerdict {
  source: 'detector' | 'vlm';
  assessment: 'success' | 'failure' | 'inconclusive';   // detector: low / high risk / warning
  confidence: number;         // 0-100 (detector: smoothed failure risk)
  reason: string;
  defects: string[];
  at: number;                 // epoch ms
}

// Normalized live state we derive from Moonraker objects.
export type PrintState =
  | 'offline'
  | 'standby'   // connected, idle
  | 'printing'
  | 'paused'
  | 'complete'
  | 'cancelled'
  | 'error';

export interface LiveState {
  printerId: number;
  online: boolean;
  state: PrintState;
  klippyState?: string;       // ready / error / shutdown / startup
  stateMessage?: string;
  filename?: string | null;
  progress: number;           // 0..1
  printDuration: number;      // seconds
  totalDuration: number;      // seconds
  etaSeconds?: number | null;
  bedTemp: number;
  bedTarget: number;
  extruderTemp: number;
  extruderTarget: number;
  filamentDetected?: boolean | null; // from runout sensor if present
  // From Creality's own firmware feed (:9999). undefined = feed unavailable.
  fault?: { code: number; message: string; description: string } | null;
  vendorBusy?: boolean;       // firmware is running a job Klipper can't see yet (pre-print heat/level)
  errorText?: string;         // readable Klipper error (when state === 'error')
  ai?: AiVerdict | null;      // latest vision-model check of this printer's camera (during prints)
  // Light and switchable fans, 0-1 (only those the printer has). Automatic fans excluded.
  peripherals?: { light?: number; fan0?: number; fan1?: number; fan2?: number };
  // Chamber, for display. target/heaterPower only on printers with a chamber heater (K2).
  chamber?: { temp: number; target?: number; heaterPower?: number } | null;
  // Fan speeds 0-1, for display. chamber = effective speed of the chamber fan (manual
  // fan1 or the automatic temperature_fan, which share a pin); chamberAuto = automatic.
  fans?: { part?: number; chamber?: number; chamberAuto?: boolean; side?: number; hotend?: number; heater?: number };
  updatedAt: number;
}

export type EventType =
  | 'print_started'
  | 'print_finished'
  | 'print_cancelled'
  | 'filament_runout'
  | 'klipper_error'
  | 'printer_offline'
  | 'printer_online'
  | 'stall_suspected'
  | 'printer_fault'
  | 'fault_cleared'
  | 'heaters_idle'
  | 'heaters_off'
  | 'ai_failure'
  | 'jam_suspected'
  | 'idle_off'
  | 'paused'
  | 'resumed'
  | 'info';

export type Severity = 'info' | 'warning' | 'critical';

export interface PrinterEvent {
  id?: number;
  printerId: number;
  printerName: string;
  type: EventType;
  severity: Severity;
  title: string;
  message: string;
  filename?: string | null;
  actionTaken?: string | null; // e.g. 'auto-paused'
  createdAt: number;
}
