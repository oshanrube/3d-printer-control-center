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

### Internet path and remote access
```
Internet ── SLT fibre (CGNAT) ── Huawei HG8245H5 ONT (192.168.10.1) ── Tenda router (10.0.68.1) ── Pi (10.0.68.53)
```
- The ISP (SLT) uses **CGNAT**: a traceroute's hop after the Huawei is `100.94.0.1`. The shared public IPv4 is not ours, so **port forwarding can't work**. The Huawei's SLT firmware doesn't display its WAN IP anywhere. The Huawei has IPv6 (DHCPv6-PD), but the Tenda doesn't pass it through.
- **HTTPS and remote access are via Tailscale** (installed on the Pi host from the official apt repo, `tailscaled` enabled at boot). The Pi is the `printers` machine: **https://printers.tail16d5a7.ts.net** (Let's Encrypt cert, tailnet-only), set up with `tailscale serve --bg 8081`; check it with `tailscale serve status`. Only the owner's devices can reach it, so the app's missing login isn't exposed. Web Push works on this origin. Notifications are delivered by Google, so they arrive even when the phone's Tailscale is off; opening the dashboard needs Tailscale on.

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
  ai-analyzer.ts   AI failure detection: Obico detector on bc250 (+ optional vision-LLM second opinion)
  errors.ts        readable Klipper/Creality error text + hints
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
`OBICO_URL`, `OBICO_TOKEN` (in `.env`), `OBICO_IMAGE_BASE`, `OBICO_SENSITIVITY` (1), `AUTO_PAUSE_FAILURE` (0), `AI_API_KEY` (in `.env`), `AI_BASE_URL`,
`PORT` (8081), `DATA_DIR`, `STALL_MINUTES` (8), `DATASET_SNAPSHOT_SEC` (20), `DATASET_ENABLED`, `AUTO_PAUSE_RUNOUT`, `AUTO_PAUSE_ERROR`, `IDLE_HEATER_ALERT_MIN` (15), `IDLE_HEATER_OFF_MIN` (45, 0 = alert only), `WEBRTC_DECODE` (`keyframes` default | `full`), `WEBRTC_IDLE_MS` (30000), `WEBRTC_GRACE_MS` (10000), `WEBRTC_MAX_PAGES` (4), `CHROMIUM_PATH`, `VAPID_SUBJECT`, `CLOUDFLARE_TUNNEL_TOKEN` (in `.env`).

## Detection engine (`engine.ts`)
- Print started / finished / cancelled, tracked with an `inPrint` flag: only transitions the engine actually saw count, so backend restarts and reconnects can't replay a finished print (this used to happen on every restart) or re-announce a running one. A dropped connection doesn't end dataset capture.
- Klipper error (critical), once per distinct error (not on every reconnect). Creality's JSON errors (sometimes malformed) are made readable in `errors.ts`, with hints for confirmed codes (`key586` = move out of range, usually a file sliced for another printer model).
- Printer offline (warning during a print).
- Filament runout while printing -> critical + **auto-pause**.
- Stall: no progress for `STALL_MINUTES` while printing.
- **Creality fault** (from `:9999`) -> critical push explaining the code and whether heaters are still on; `fault_cleared` when it goes away. The firmware also mirrors Klipper errors as its own codes (Klipper `key586` -> Creality `2586`); after a 5 s settle, a fault is skipped if Klipper is in error, since the Klipper alert already covers it.
- **Idle-heater watchdog:** heaters on (target > 0) with nothing printing -> alert at 15 min, `TURN_OFF_HEATERS` at 45 min, critical alert if still on 5 min later. Paused prints get the alert only. The firmware's pre-print phase (`vendorBusy`) is exempt for up to 60 min.
- **Idle light/fans off:** the light (`output_pin LED`) and switchable fans (`output_pin fan0` part cooling, `fan1` chamber/exhaust, `fan2` side/auxiliary; **`fan1` shares its pin with the automatic `temperature_fan chamber_fan`**, so they're the same physical fan) are switched off once each has been on for `IDLE_OFF_MIN` (10) while nothing is printing (not printing/paused, not in the firmware's pre-print phase). Timing is per device, so a light turned on later gets its full time. The **light goes through Creality's :9999 service** (`{"method":"set","params":{"lightSw":0|1}}`, as the Creality app does), because switching it with Klipper's `SET_PIN` works but leaves the **touch screen showing the old state** (Creality's `lightSw` doesn't follow Klipper). It falls back to `SET_PIN PIN=LED VALUE=x` if the feed is down. Fans use Creality's `M107 P<n>` macro, which also clears the hidden fan-enable pin (`fan0_en` on K2, `my_fan_output_pins` on K1C); the screen tracks fans correctly. **Light on at print start:** when a print starts or the firmware starts preparing one, the light is switched on if it's off (the AI detector and Creality's pre-print bed check need it). This happens once per print, so switching it off by hand mid-print is respected (`LIGHT_ON_PRINT`, default 1). Never touches `heater_fan hotend_fan`, `temperature_fan chamber_fan`, or the K2's `power`/`ptc_power`. Logged as an `idle_off` event (no push).
- **Chamber + fans on the dashboard:** `temperature_sensor chamber_temp` is the reliable chamber reading (on the K1C the automatic `chamber_fan` reads the same thermistor, `PC5`, with a different table and shows ~60°C when the chamber is ~43°C). The K2 adds `heater_generic chamber_heater` (target/power). The card shows Chamber and Light tiles plus a fan line: Part (fan0), Chamber (max of manual fan1 and automatic `temperature_fan`, marked "(auto)" when automatic), Side (fan2), Hotend (`heater_fan hotend_fan`), and Heater (K2 `heater_fan chamber_fan`, the chamber-heater circulation fan).
- **AI failure detection** (`ai-analyzer.ts`), see the bc250 section below.
- Dataset: during each print, a snapshot + telemetry row every 20 s into `data/snapshots/p<id>_<ts>/` and the `prints`/`telemetry` tables, labelled with the outcome. Intended for training a failure-detection model later.

## Cameras
- **WebRTC printers** (K2 is WebRTC-only; the three K1Cs run WebRTC too) use libpeer: `POST http://<ip>:8000/call/webrtc_local` with base64 JSON `{type:'offer',sdp}` and get back base64 `{type:'answer',sdp}`.
  - libpeer's answer includes a **payload type that isn't in the offer** (sometimes a garbage negative number). Browsers reject it, so the answer must be **munged to keep only PTs present in both offer and answer**.
  - WebRTC media is UDP/SRTP: it can't be HTTP-proxied.
  - **Only Chromium can decode it.** Dead ends: `aiortc` can't complete DTLS with libpeer; `@roamhq/wrtc` has no H264 decoder.
  - The relay drives one headless-Chromium page per printer, on demand. Live viewing holds a page warm (`touch`); dataset capture uses grab-and-release; idle pages are torn down.
  - **Keyframes-only decode (default):** printers send a keyframe every ~1.0 s (K2) / ~0.67 s (K1C). An encoded-insertable-streams transform drops delta frames before the decoder: full resolution at ~1–1.5 fps for ~0.3 core per camera, versus 1+ core for full decode. All 4 WebRTC cameras live ≈ 120% CPU total.
  - **Self-healing:** a page whose connection fails/closes, or that produces no frame within 20 s or stops producing frames for 15 s, is rebuilt on the next request. (Before this, a page whose connection dropped stayed open forever while the dashboard kept polling, and the camera showed 502 until a restart.)
  - Capture must be **timer-driven**: `requestVideoFrameCallback` doesn't fire in background tabs (every relay page but one). Background throttling is disabled via Chromium flags.
  - **No hardware decode:** the RK3566 VPU is only exposed through Rockchip's vendor MPP (`/dev/mpp_service`), which Chromium can't use (needs VAAPI or upstream V4L2). It would need a mainline kernel.
- **MJPEG printers** (Luffy, Zoro): `mjpg_streamer` on `:8080` (`/usr/bin/mjpg_streamer -i input_memfd.so -t 0 -o output_http.so -w /usr/share/mjpg-streamer/www/ -p 8080`), and the backend polls snapshots. The K1Cs could in principle run this too, but that was dropped in favour of the universal WebRTC relay.
- Each printer allows a limited number of WebRTC viewers, so while the relay is watching, the Creality app may not get a stream (and vice versa).

## AI failure detection and bc250
**bc250** (`oshanrube-amdbc250`, 10.0.68.30) is an AMD BC-250 board (12 threads; 16 GB shared, of which Linux sees 7.5 GB and the GPU takes 8 GB) running SkillFishOS (Debian-based, apt). SSH from the Pi as `oshanrube` with the dedicated key `/root/.ssh/bc250_control` (passwordless sudo). RAM is tight (~1 GB free).
- **llama.cpp server** (`llama-server.service`, port 8888) runs **Qwen3.5-9B** (Q4_K_M) on the GPU via Vulkan, and is the owner's **local model for Claude Code**. It has **no vision** (`--no-mmproj-auto`, no mmproj file), and its API key is in `/etc/llama/api.key`. Don't change this server without asking: the GPU is nearly full (6.4 of 8 GB).
- **Obico failure detector** (Obico `ml_api`, CPU/ONNX build from `obico-server` release `df8190e`): Docker container `obico-ml` (image `obico-ml-api:cpu-df8190e`), port **3333**, `--restart unless-stopped`, 1.5 GB memory cap, ~350 MB used. Source in `~/obico/src`. Bearer token in `~/obico/ml_api_token`, copied to the Pi's `.env` as `OBICO_TOKEN`. API: `GET /p/?img=<url>` (it downloads the image) returns `{"detections":[["failure", conf, [cx,cy,w,h]], ...]}`; `GET /hc/` is the health check. Docker (`docker.io`, `docker-cli`, `docker-buildx`) was installed for this.
- **How the backend uses it:** every 10 s per printing printer it grabs a frame, serves it at a single-use `/api/ai/frame/<key>` for bc250 to fetch, and runs **Obico's own temporal algorithm and tuned parameters** (`FD_1ST_GEN_PARAMS`, built for one frame per 10 s): EWM span 12 against a ~20 h per-printer baseline, first 30 frames of each print safe, warning at the threshold, failure at 1.75×. Each fires once per print as an `ai_failure` push. Auto-pause at the failure level is opt-in (`AUTO_PAUSE_FAILURE=1`). Prediction state persists in `kv` (`fd:<printerId>`), **with the print it belongs to and the alert level**, so a backend restart mid-print doesn't restart the 30-frame learning window or re-alert. Frames with detections are saved next to the print's dataset frames, with rows in `ai_checks` (`source`, `score`, `risk`), plus one row a minute otherwise.
- **Validated:** Nami's real spaghetti frame scored failure boxes 0.54 / 0.48 / 0.24 / 0.24 right on the tangle, while five healthy printers scored 0; inference takes 0.3–0.5 s per frame. In simulation: spaghetti mid-print gives a warning after 20 s and failure after 40 s; healthy prints, weak noise and one-off spurious frames never alert.
- **Limitation:** the baseline is per printer and learned over time, so in the first hours of monitoring a new printer, a print that's bad from the very first frame may not alert.
- **Blind spot: printing in air / filament jams.** The Obico model only detects spaghetti: Sanji's jam on 2026-11-09 scored 0 risk for over an hour, and the K1C runout sensor only checks filament *presence*. On the K1C/K2 the **bed drops** as Z rises with the camera fixed, so a jam shows as a growing gap between the nozzle and the part's top.
- **Jam detection research (not alerting yet).** Hotend heater power falls when no plastic is melting. Sanji's jam showed as a step from ~0.43 to ~0.36 PWM (−15%) at the exact onset, 17:55 local. But **heater power alone is not usable**: the normal level depends on the file (Sanji's healthy antler print ran at 0.345), and a healthy Nami print had a 17% dip from geometry changes. A 12%/3-minute relative-drop rule caught the jam in 7 minutes but would have false-alarmed on Nami. What looks right is **heater power vs commanded flow**: Luffy and Nami, same model, file, temperature and fan, showed Luffy (healthy) at 0.48 power for 7.2 mm³/s, rising when extruding, and Nami (failing) at 0.35 for 8.5 mm³/s, falling when extruding. Since 2026-11-09, each 20 s telemetry row records `extruder_power`, `extruder_velocity` (commanded filament mm/s), `z`, `fan0`, averaged from 5 s samples (`motion_report` is subscribed, but excluded from live state so it doesn't flood the dashboard stream). Raw Klipper logs from the incident are in `data/research/`. Next step: once some healthy prints and jams are recorded, fit power ≈ a + b·flow per printer/temp/fan, and alert when power stops responding to flow.
- **Vision-LLM second opinion** (optional; `AI_API_KEY`): asked only when the detector raises an alarm, and its view is appended to the alert (it never vetoes). It can't work until the llama.cpp server has a vision projector.
- The Orange Pi's RK3566 has an NPU, and Obico also ships an **RKNN** model (built for rk3588). Running the detector on the Pi's NPU is a possible future option.

## Creality firmware facts
- `ws://<printer>:9999`: first message is a full snapshot, then deltas. Fields: `err {errcode,key,value}`, `state` (1 printing/preparing, 5 halted on error, 7 stopping, 4 stopped), `deviceState`, `model`, `printProgress`, targets. `creality.ts` never sends anything.
- **Error 521** = `ai detect camera dirty objects`: the pre-print AI camera check saw something on the bed. The screen shows it as "unknown exception".
- Printer logs: Creality services in `/usr/data/creality/userdata/log/` (`master-server.log` covers print control and fault codes; `app-server.log` covers cloud state and `err`). Klipper and Moonraker logs are in `/usr/data/printer_data/logs/`. Timestamps are local time.

## History / incidents
- **2026-11-08 21:19, Sanji:** a cloud-started reprint was halted by error 521 (the previous batch was still on the bed). The job never reached Klipper (Moonraker said "standby"), and **heaters stayed at bed 100°C / nozzle 190°C for ~9 h** until the error was dismissed at 06:13. This led to the `:9999` fault feed and the idle-heater watchdog.

- **2026-11-09, Sanji and Nami: filament jams / printing in air** on `ONIC-DM-3-4INCH` (ABS, 260°C). Sanji jammed at 12:25 UTC and wasn't noticed until ~13:30. Nami under-extruded from early in its print. Both were cancelled. The Obico detector missed both (no spaghetti), which led to the jam-detection research above.
- **Dataset fragments:** until 2026-11-09, each backend restart mid-print opened a new `prints` row. On startup, `closeFragments()` closes open rows with a newer row, as `continued` if the next row is the same file and `unknown` otherwise. A restart now rejoins the open row.
- **2026-11-09 14:14, Usopp:** a file sliced for the **K2 Plus** (350 mm bed, `M8200` CFS commands) was sent to the K1C. Its start gcode moved to Y345, and Klipper stopped with `key586` "Move out of range" before printing. The K1C-sliced copy of the same model printed fine.

## Open items
- [ ] Enable push on the phone over the Tailscale HTTPS address and confirm the test notification arrives.
- [ ] In the Tailscale admin console, **disable key expiry** for the `printers` machine, or it drops off the tailnet after ~180 days.
- [ ] (Unused) The Cloudflare `cloudflared` service is still in `docker-compose.yml` behind the `tunnel` profile. Free-plan Cloudflare Tunnel needs the whole domain on Cloudflare (subdomain-only/CNAME setup is Business+), so it was dropped for Tailscale. Remove it, or keep it for a future dedicated domain. If the app is ever exposed publicly, add auth first.
- [ ] **Disable PCP on the Pi** (`pmproxy`/`pmcd` etc., which feed `cockpit-pcp`); it burns ~1 core. The agent was blocked from doing this, so the user must run: `sudo systemctl disable --now pmproxy pmie pmlogger pmcd pmie_check.timer pmie_daily.timer pmlogger_check.timer pmlogger_daily-poll.timer pmlogger_daily.timer`
- [ ] Verify `TURN_OFF_HEATERS` on a real printer (only simulated so far; Klipper accepted the call path).
- [ ] Only error 521 has a human description; other Creality codes show the firmware text. Add more as they're seen in logs.
- [ ] Ideas: app-level auth, a self-hosted runner for push-to-deploy, and an AI failure model trained on the dataset.

## Performance notes (Orange Pi)
- 2026-11-09: the Pi hit load ~14 on 4 cores. The main costs were `pmproxy` (PCP, ~0.9 core, **still to be disabled by the user**), 4 WebRTC relays (~0.25 core each), `tailscaled` (~0.25 core, encrypting camera images to the phone), and the backend.
- **Live updates are throttled** to 1/s per printer (`STATE_MIN_INTERVAL_MS`). Moonraker sends ~4/s of temperature noise; unthrottled, that was 23 messages/s and 16 KB/s per dashboard, and froze the page on slow CPUs (headless Chromium on the Pi never finished rendering). State, online, fault, error, file and AI-verdict changes bypass the throttle.
- **Camera polling** is once per second (the relay makes ~1 frame/s in keyframe mode) and pauses while the page is hidden.
- `motion_report` updates don't rebuild or broadcast live state (`fleet.ts`).
- Headless Chromium in the app container has no emoji font, so emoji show as boxes in screenshots. That's cosmetic.

## Gotchas for agents
- The Pi's `/bin/sh` is **dash**: no bash-isms (`declare -A`, etc.) in host one-liners.
- Neither the Pi nor the old agent container has `sshpass`. For printer SSH, use `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` + `setsid`.
- The old agent container had no `node`. Run Node scripts inside the app container: put the file in `data/`, then `docker exec 3d-printer-control-center node /data/<file>`.
- Commit messages with apostrophes break `sh -c '...'` quoting: write the message to a file and use `git commit -F`.
- Auto-mode safety checks blocked: writes or service changes on printers over SSH, disabling logging/metrics services on the Pi, and reading printer init scripts. Ask the user, or have them add a permission rule; don't work around it.
- The printers are in production. Never interrupt an active print; check `print_stats.state` first.
