import { config } from './config.js';
import { printersRepo } from './db.js';
import { initPush } from './push.js';
import { Fleet } from './fleet.js';
import { Engine } from './engine.js';
import { buildServer } from './server.js';

function seedIfEmpty() {
  if (printersRepo.all().length > 0) return;
  // Current confirmed fleet (edit later in the UI). WebRTC-camera printers vs MJPEG.
  const seed: Array<{ name: string; ip: string; cameraType: 'mjpeg' | 'webrtc' | 'auto' }> = [
    { name: 'K2 Plus', ip: '10.0.68.21', cameraType: 'webrtc' },
    { name: 'Roronoa Zoro', ip: '10.0.68.47', cameraType: 'mjpeg' },
    { name: 'Sanji', ip: '10.0.68.149', cameraType: 'webrtc' },
    { name: 'Usopp', ip: '10.0.68.167', cameraType: 'webrtc' },
    { name: 'Nami', ip: '10.0.68.232', cameraType: 'webrtc' },
    { name: 'Mokey D. Luffy', ip: '10.0.68.240', cameraType: 'mjpeg' },
  ];
  for (const s of seed) {
    printersRepo.add({ name: s.name, ip: s.ip, moonrakerPort: config.moonrakerPort, cameraType: s.cameraType, disabled: false });
  }
  console.log(`[seed] inserted ${seed.length} printers`);
}

async function main() {
  initPush();
  seedIfEmpty();

  const fleet = new Fleet();
  const { app, broadcastEvent } = buildServer(fleet);
  const engine = new Engine(fleet, broadcastEvent);
  engine.start();
  fleet.start();

  await app.listen({ host: config.host, port: config.port });
  console.log(`[server] listening on http://${config.host}:${config.port}`);

  const shutdown = async () => {
    console.log('\n[server] shutting down...');
    fleet.stop();
    try { await app.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
