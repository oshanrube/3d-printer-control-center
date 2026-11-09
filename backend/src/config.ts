import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || '8082', 10),
  host: process.env.HOST || '0.0.0.0',
  // Persistent data (SQLite + captured snapshots for the future training set)
  dataDir: process.env.DATA_DIR || resolve(__dirname, '../../data'),
  // Where the built frontend lives (served as static)
  frontendDir: process.env.FRONTEND_DIR || resolve(__dirname, '../../frontend/dist'),
  // Moonraker defaults
  moonrakerPort: 7125,
  // Engine tuning
  stallMinutes: parseInt(process.env.STALL_MINUTES || '8', 10), // no progress + cold-ish while "printing"
  // Capture a snapshot every N seconds during a print (for the dataset)
  datasetSnapshotIntervalSec: parseInt(process.env.DATASET_SNAPSHOT_SEC || '20', 10),
  datasetEnabled: (process.env.DATASET_ENABLED ?? '1') === '1',
  // Auto-pause toggles (engine actions)
  autoPauseOnRunout: (process.env.AUTO_PAUSE_RUNOUT ?? '1') === '1',
  autoPauseOnError: (process.env.AUTO_PAUSE_ERROR ?? '1') === '1',
  // Idle-heater watchdog: heaters on while nothing is printing.
  idleHeaterAlertMin: parseInt(process.env.IDLE_HEATER_ALERT_MIN || '15', 10),
  // Turn heaters off after this long (0 = alert only). Never applied to a paused print.
  idleHeaterOffMin: parseInt(process.env.IDLE_HEATER_OFF_MIN || '45', 10),

  // Stage 1 failure detection: Obico's open-source failure detector (ml_api) on bc250.
  // Hyperparameters are Obico's own (FD_1ST_GEN_PARAMS), tuned for one frame per 10 s.
  detector: {
    url: (process.env.OBICO_URL || 'http://10.0.68.30:3333').replace(/\/+$/, ''),
    token: process.env.OBICO_TOKEN || '',
    enabled: process.env.OBICO_ENABLED === '1' || (process.env.OBICO_ENABLED !== '0' && !!process.env.OBICO_TOKEN),
    // Where the detector can fetch frames from this server (it downloads images by URL).
    imageBase: (process.env.OBICO_IMAGE_BASE || 'http://10.0.68.53:8081').replace(/\/+$/, ''),
    intervalSec: 10,
    sensitivity: Number(process.env.OBICO_SENSITIVITY || '1'),  // Obico's "detective sensitivity"
    autoPause: process.env.AUTO_PAUSE_FAILURE === '1',            // pause at the failure threshold (off: alert only)
  },

  // Stage 2 (optional second opinion): a vision LLM (llama.cpp server, OpenAI-compatible API).
  // Asked only when the detector raises an alarm. Active when AI_API_KEY is set, or AI_ENABLED=1.
  ai: {
    baseUrl: (process.env.AI_BASE_URL || 'http://10.0.68.30:8888').replace(/\/+$/, ''),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    enabled: process.env.AI_ENABLED === '1' || (process.env.AI_ENABLED !== '0' && !!process.env.AI_API_KEY),
    timeoutSec: parseInt(process.env.AI_TIMEOUT_SEC || '90', 10),
  },
};

export type Config = typeof config;
