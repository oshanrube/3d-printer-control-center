# 3D Printer Control Center

A fast, modern web dashboard for monitoring multiple Klipper / Moonraker 3D printers
at a glance — live status, temperatures, print progress, webcam feeds, and desktop
notifications. Pure HTML/CSS/JS served by Caddy; **no build step**.

## Features

- **Fleet overview header** — live counts of Printing / Ready / Done / Offline, click a tile to filter
- **At-a-glance cards** — status badge, bold progress bar, bed/nozzle temps, elapsed + ETA
- **Live reordering** — printing jobs float to the top automatically (webcams never reload)
- **Dark & light themes** — toggle in the header, remembers your choice, follows system default
- **Responsive** — works well on a phone for checking prints remotely
- **Webcam feeds** — per-printer MJPEG streams (toggle on/off)
- **Desktop notifications** — alerts when a print completes
- **Real-time** — direct Moonraker WebSocket subscriptions (no polling lag)
- **CORS-free proxy** — Caddy reverse-proxies printer APIs to avoid cross-origin issues
- **Persistent** — printers and settings saved in browser localStorage

## Quick Start (Docker)

```bash
docker compose up -d --build
```

Then open **http://<host>:8081**.

Default seeded printers (edit/remove in the UI, or edit `initializeDefaultPrinters()` in `script.js`):

| Name            | IP            |
|-----------------|---------------|
| Mokey D. Luffy  | 10.0.68.108   |
| Roronoa Zoro    | 10.0.68.130   |
| Nami            | 10.0.68.121   |
| Usopp           | 10.0.68.116   |
| Sanji           | 10.0.68.124   |
| K2 Plus         | 10.0.68.21    |

> Printers live in browser localStorage. On an install that already had a saved list,
> a one-time `ensureK2Plus()` migration injects the K2 Plus if it's missing (guarded by a
> flag, so it won't return if you deliberately remove it).

## How it connects to printers

- **Status**: the browser opens `ws://<printer-ip>:7125/websocket` and subscribes to
  `print_stats`, `heater_bed`, `extruder`, `display_status`, and `virtual_sdcard`.
- **Webcam**: `http://<printer-ip>:4408/webcam/?action=stream` (Creality K-series default;
  shows "Webcam unavailable" gracefully if the camera is off).
- **Proxy** (optional, CORS): `GET /api/proxy/<ip>:<port>/<endpoint>` is reverse-proxied by Caddy.

Each printer needs Moonraker reachable on the LAN. If you hit CORS issues when not using the
Docker/Caddy setup, add to `moonraker.conf`:

```
[authorization]
cors_domains:
    *
```

## Configuration

- **Add / edit / remove / disable** printers from the UI.
- **Poll interval** and **test notification** live in the ⚙️ settings panel.
- **Theme** (🌙/☀️) and **webcam visibility** (📷) toggles are in the header.

## Docker

```bash
docker compose up -d --build   # build + start
docker compose logs -f         # logs
docker compose down            # stop
```

Change the published port in `docker-compose.yml` (`"8081:80"`).

## File structure

```
├── index.html      # Markup: topbar, overview, grid, modals
├── styles.css      # Design tokens + dark/light themes + responsive layout
├── script.js       # KlipperDashboard class: WS, state, overview, theming
├── Caddyfile       # Static file server + CORS + printer proxy
├── Dockerfile      # caddy:2.7-alpine
└── docker-compose.yml
```

## License

MIT.
