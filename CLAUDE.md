# 3D Printer Control Center: project context

A self-hosted control center for a fleet of Creality/Klipper printers, running on an Orange Pi at home. A **Node/TypeScript backend** reads every printer (Moonraker, plus Creality's own firmware feed), runs a **failure-detection engine** (auto-pause, push alerts, dataset logging for future AI training), and relays cameras. A **Preact PWA** frontend shows the live fleet.

Repo: `oshanrube/3d-printer-control-center`, default branch **`master`**. The old static dashboard (HTML + Caddy proxy) is kept in `legacy/` for reference only.

## Fleet

| ID | Name | IP | Model | Wi-Fi | Camera |
|---|---|---|---|---|---|
| 1 | K2 Plus | 10.0.68.21 | K2 Plus (F008) | RubeHomeAP | WebRTC only (1080p) |
| 2 | Roronoa Zoro | 10.0.68.47 | K1 family | RubeHomeIOT | MJPEG |
| 3 | Sanji | 10.0.68.149 | K1C | RubeHomeAP | WebRTC (720p) |
| 4 | Usopp | 10.0.68.167 | K1C | RubeHomeAP | WebRTC (720p) |
| 5 | Nami | 10.0.68.232 | K1C | RubeHomeAP | WebRTC (720p) |
| 6 | Mokey D. Luffy | 10.0.68.240 | K1C | RubeHomeIOT | MJPEG |

- **RubeHomeIOT has client isolation.** Phones on RubeHomeAP can't reach Luffy/Zoro directly, but the Pi (wired, `eth0` 10.0.68.53) reaches every printer. That's why everything goes through the backend.
- Printer IDs come from the SQLite DB (seeded in `backend/src/index.ts` on first run; editable in the UI).
- Moonraker on `:7125`, Creality status feed on `:9999`, WebRTC signaling on `:8000`, MJPEG on `:8080` / `:4408/webcam/`.

## Host and deployment

- **Orange Pi 3B** (Rockchip RK3566, 4× Cortex-A55, 7.5 GB RAM, vendor BSP kernel 5.10, Ubuntu 20.04). Local timezone **+05:30**.
- Repo checkout on the Pi: `/root/3d-printer-control-center`.
- Deploy: `cd /root/3d-printer-control-center && docker compose build control-center && docker compose up -d control-center`
- The app listens on **:8081** using **host networking** (`network_mode: host`). This is required: the WebRTC relay's Chromium must advertise the Pi's real LAN IP as its ICE candidate, or printers can't send it video.
- Data (SQLite DB, dataset snapshots) lives in `./data` (git-ignored), mounted at `/data` in the container.
- Git push from the Pi uses a deploy key: the repo's local `core.sshCommand` is `ssh -i /root/.ssh/toddler-express -o IdentitiesOnly=yes ...`. Commits are authored as `Oshan <oshanrube@gmail.com>` (set repo-locally on the Pi).
- **Previous agent setup:** the earlier Claude Code session ran *in a container on the Pi itself*, with `/workspace` bind-mounted to the repo. It ran host commands with:
  `docker run --rm --privileged --pid=host --net=host claude-agent-claude:latest nsenter -t 1 -m -u -i -n -p -- sh -c '...'`
  A session running anywhere else needs another way in: Cockpit's web terminal at `https://10.0.68.53:9090` (user `orangepi`), SSH, or a self-hosted GitHub runner.

## Architecture

```
backend/src/
  index.ts         startup: seed DB, init push, start relay, fleet, engine, server
  config.ts        env-driven settings (see below)
  types.ts         Printer, LiveState, PrinterEvent, EventType
  db.ts            better-sqlite3: printers, events, push_subscriptions, kv (VAPID), prints, telemetry
  moonraker.ts     resilient Moonraker JSON-RPC WebSocket client (subscribe, pause/resume/cancel, gcode)
  creality.ts      read-only client for the firmware feed ws://<printer>:9999 (faults, pre-print state)
  fleet.ts         one Moonraker + one Creality client per printer -> normalized LiveState
  engine.ts        detection rules, events, push, dataset capture
  camera.ts        snapshot API: WebRTC relay frame or MJPEG fetch; captureForDataset()
  webrtc-relay.ts  headless-Chromium WebRTC -> JPEG relay (see Cameras)
  push.ts          Web Push (VAPID keys persisted in kv)
  scan.ts          LAN scan for Moonraker (:7125)
  server.ts        Fastify REST + /ws live stream + static frontend
frontend/src/      Preact + Vite PWA: store.ts (WS-backed), App.tsx (cards, cameras, events, modals), push.ts, sw.js
```

REST: `GET/POST/PATCH/DELETE /api/printers`, `POST /api/printers/:id/{pause|resume|cancel}`, `GET /api/events`, `GET /api/prints`, `GET /api/camera/:id/snapshot`, `GET /api/scan`, `/api/push/{vapid,subscribe,unsubscribe,test}`. WS `/ws` sends a snapshot, then streams state and events.

Stack: Fastify 4, @fastify/websocket 8, better-sqlite3 11, web-push, ws, puppeteer-core 23, Node 20 (bookworm-slim, with Debian Chromium in the image). Multi-stage `Dockerfile`.

### Configuration (env, `docker-compose.yml`)
`PORT` (8081), `DATA_DIR`, `STALL_MINUTES` (8), `DATASET_SNAPSHOT_SEC` (20), `DATASET_ENABLED`, `AUTO_PAUSE_RUNOUT`, `AUTO_PAUSE_ERROR`, `IDLE_HEATER_ALERT_MIN` (15), `IDLE_HEATER_OFF_MIN` (45, 0 = alert only), `WEBRTC_DECODE` (`keyframes` default | `full`), `WEBRTC_IDLE_MS` (30000), `WEBRTC_GRACE_MS` (10000), `WEBRTC_MAX_PAGES` (4), `CHROMIUM_PATH`, `VAPID_SUBJECT`, `CLOUDFLARE_TUNNEL_TOKEN` (in `.env`).

## Detection engine (`engine.ts`)
- Print started / finished / cancelled; Klipper error (critical); printer offline during a print.
- Filament runout while printing -> critical + **auto-pause**.
- Stall: no progress for `STALL_MINUTES` while printing.
- **Creality fault** (from `:9999`) -> critical push explaining the code and whether heaters are still on; `fault_cleared` when it goes away.
- **Idle-heater watchdog:** heaters on (target > 0) with nothing printing -> alert at 15 min, `TURN_OFF_HEATERS` at 45 min, critical alert if still on 5 min later. Paused prints get the alert only. The firmware's pre-print phase (`vendorBusy`) is exempt for up to 60 min.
- Dataset: during each print, a snapshot + telemetry row every 20 s into `data/snapshots/p<id>_<ts>/` and the `prints`/`telemetry` tables, labelled with the outcome. Intended for training a failure-detection model later.

## Cameras
- **WebRTC printers** (K2 is WebRTC-only; the three K1Cs run WebRTC too) use libpeer: `POST http://<ip>:8000/call/webrtc_local` with base64 JSON `{type:'offer',sdp}` and get back base64 `{type:'answer',sdp}`.
  - libpeer's answer includes a **payload type that isn't in the offer** (sometimes a garbage negative number). Browsers reject it, so the answer must be **munged to keep only PTs present in both offer and answer**.
  - WebRTC media is UDP/SRTP: it can't be HTTP-proxied.
  - **Only Chromium can decode it.** Dead ends: `aiortc` can't complete DTLS with libpeer; `@roamhq/wrtc` has no H264 decoder.
  - The relay drives one headless-Chromium page per printer, on demand. Live viewing holds a page warm (`touch`); dataset capture uses grab-and-release; idle pages are torn down.
  - **Keyframes-only decode (default):** printers send a keyframe every ~1.0 s (K2) / ~0.67 s (K1C). An encoded-insertable-streams transform drops delta frames before the decoder: full resolution at ~1–1.5 fps for ~0.3 core per camera, versus 1+ core for full decode. All 4 WebRTC cameras live ≈ 120% CPU total.
  - Capture must be **timer-driven**: `requestVideoFrameCallback` doesn't fire in background tabs (every relay page but one). Background throttling is disabled via Chromium flags.
  - **No hardware decode:** the RK3566 VPU is only exposed through Rockchip's vendor MPP (`/dev/mpp_service`), which Chromium can't use (needs VAAPI or upstream V4L2). It would need a mainline kernel.
- **MJPEG printers** (Luffy, Zoro): `mjpg_streamer` on `:8080` (`/usr/bin/mjpg_streamer -i input_memfd.so -t 0 -o output_http.so -w /usr/share/mjpg-streamer/www/ -p 8080`), and the backend polls snapshots. The K1Cs could in principle run this too, but that was dropped in favour of the universal WebRTC relay.
- Each printer allows a limited number of WebRTC viewers, so while the relay is watching, the Creality app may not get a stream (and vice versa).

## Creality firmware facts
- `ws://<printer>:9999`: first message is a full snapshot, then deltas. Fields: `err {errcode,key,value}`, `state` (1 printing/preparing, 5 halted on error, 7 stopping, 4 stopped), `deviceState`, `model`, `printProgress`, targets. `creality.ts` never sends anything.
- **Error 521** = `ai detect camera dirty objects`: the pre-print AI camera check saw something on the bed. The screen shows it as "unknown exception".
- Printer logs: Creality services in `/usr/data/creality/userdata/log/` (`master-server.log` covers print control and fault codes; `app-server.log` covers cloud state and `err`). Klipper and Moonraker logs are in `/usr/data/printer_data/logs/`. Timestamps are local time.

## History / incidents
- **2026-11-08 21:19, Sanji:** a cloud-started reprint was halted by error 521 (the previous batch was still on the bed). The job never reached Klipper (Moonraker said "standby"), and **heaters stayed at bed 100°C / nozzle 190°C for ~9 h** until the error was dismissed at 06:13. This led to the `:9999` fault feed and the idle-heater watchdog.

## Open items
- [ ] **Cloudflare Tunnel** (needed for remote access and Web Push, since push requires HTTPS): create the tunnel, set the public hostname to `http://localhost:8081`, put `CLOUDFLARE_TUNNEL_TOKEN` in `/root/3d-printer-control-center/.env`, and run `docker compose --profile tunnel up -d`. The token was saved as the GitHub Actions secret `Cloudflare_tunnel`, but Actions secrets can't be read back; it has to be pasted into `.env` (or delivered by a self-hosted runner workflow).
- [ ] **Cloudflare Access is mandatory** before exposing the app: there is no app-level auth, and anyone with the URL could pause or cancel prints. Use a self-hosted Access app with an email allow-list, one-time PIN, and a long session.
- [ ] Then enable push on the phone (Android, Chrome PWA) and test.
- [ ] **Disable PCP on the Pi** (`pmproxy`/`pmcd` etc., which feed `cockpit-pcp`); it burns ~1 core. The agent was blocked from doing this, so the user must run: `sudo systemctl disable --now pmproxy pmie pmlogger pmcd pmie_check.timer pmie_daily.timer pmlogger_check.timer pmlogger_daily-poll.timer pmlogger_daily.timer`
- [ ] Verify `TURN_OFF_HEATERS` on a real printer (only simulated so far; Klipper accepted the call path).
- [ ] Only error 521 has a human description; other Creality codes show the firmware text. Add more as they're seen in logs.
- [ ] Ideas: app-level auth, a self-hosted runner for push-to-deploy, and an AI failure model trained on the dataset.

## Gotchas for agents
- The Pi's `/bin/sh` is **dash**: no bash-isms (`declare -A`, etc.) in host one-liners.
- Neither the Pi nor the old agent container has `sshpass`. For printer SSH, use `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` + `setsid`.
- The old agent container had no `node`. Run Node scripts inside the app container: put the file in `data/`, then `docker exec 3d-printer-control-center node /data/<file>`.
- Commit messages with apostrophes break `sh -c '...'` quoting: write the message to a file and use `git commit -F`.
- Auto-mode safety checks blocked: writes or service changes on printers over SSH, disabling logging/metrics services on the Pi, and reading printer init scripts. Ask the user, or have them add a permission rule; don't work around it.
- The printers are in production. Never interrupt an active print; check `print_stats.state` first.
