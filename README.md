# 3D Printer Control Center

A self-hosted control center for a fleet of Klipper/Moonraker 3D printers, built to
**detect print failures, auto-pause, and push alerts** — running on an Orange Pi.

It replaces the earlier static dashboard (kept under [`legacy/`](legacy/)) with a proper
**backend + frontend** architecture. The backend runs on the Pi (wired, reaches every
printer — even ones on an isolated IoT WiFi), so your phone only ever talks to the Pi.

## What it does

- **Live fleet monitoring** — one persistent Moonraker connection per printer; status,
  progress, temps, ETA, filament sensor, streamed to the UI over WebSocket.
- **Failure-detection engine** (rule-based):
  - ✅ Print finished → push
  - 🧵 Filament runout → **auto-pause** + push
  - ⚠️ Klipper/firmware error, thermal fault, shutdown → push
  - ⏳ Stall heuristic (no progress while "printing") → push
  - 📴 Printer offline mid-print → push
- **Controls** — pause / resume / cancel from the UI (and auto-pause from the engine).
- **Web Push notifications** to the installable PWA (works great on Android).
- **Camera** — backend relays MJPEG snapshots (so isolated-network cameras work on your
  phone). WebRTC-only printers (K2) are relayed in a later phase.
- **Network scan** — finds Moonraker printers on the LAN by hostname (DHCP-drift recovery).
- **Training dataset** — every print is logged (telemetry time-series + periodic camera
  frames, labeled by outcome) under `data/`, to train a vision failure-detector later.

## Architecture

```
Printers (Moonraker)  ──►  Backend (Node/TS on the Pi)  ──►  Frontend PWA (phone)
                            - Fleet: WS per printer            - live grid + controls
                            - Engine: rules + auto-pause       - events feed
                            - SQLite: events/prints/telemetry  - web push
                            - web-push (VAPID)                 - camera (via backend)
                            - camera snapshot relay
                            - serves the built frontend + REST + /ws
```

- **Backend**: `backend/` — Node 20 + TypeScript, Fastify, `ws`, `better-sqlite3`, `web-push`.
- **Frontend**: `frontend/` — Preact + Vite PWA.
- Both are built and served from one container (see `Dockerfile`).

## Run

```bash
docker compose up -d --build      # serves on http://<pi>:8081
```

Data (SQLite DB + captured snapshots) persists in `./data`. On first run the current
fleet is seeded; edit printers in the UI (✏️) or use 🔍 Scan.

### Notable env (docker-compose.yml)

| Var | Default | Meaning |
|-----|---------|---------|
| `AUTO_PAUSE_RUNOUT` | `1` | Auto-pause on filament runout |
| `AUTO_PAUSE_ERROR` | `1` | Treat Klipper error as halt |
| `STALL_MINUTES` | `8` | No-progress window before a stall alert |
| `DATASET_SNAPSHOT_SEC` | `20` | Capture interval for the training dataset |
| `VAPID_SUBJECT` | `mailto:admin@local` | Contact for web-push |

## API (selected)

- `GET /api/printers` · `POST /api/printers` · `PATCH /api/printers/:id` · `DELETE /api/printers/:id`
- `POST /api/printers/:id/{pause|resume|cancel}`
- `GET /api/events` · `GET /api/prints` · `GET /api/scan?base=10.0.68`
- `GET /api/camera/:id/snapshot`
- `GET /api/push/vapid` · `POST /api/push/subscribe` · `POST /api/push/test`
- `GET /ws` — live state + events

## Roadmap

- WebRTC camera relay for K2-class printers (backend-side WebRTC client).
- Vision-based spaghetti/failure detection trained on the captured dataset.
- Per-printer notification rules and quiet hours.

## License

MIT.
