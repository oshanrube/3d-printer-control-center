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
};

export type Config = typeof config;
