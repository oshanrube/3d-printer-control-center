# K2 camera: Creality `libdelivery` protocol (reverse-engineered 2026-11-21)

On the K2 Plus (OpenWrt 21.02, Allwinner T113-i, armv7l) the USB camera outputs **H.264**
(Main profile, 1920x1080, 15 fps, keyframe every 15 frames = 1/s). `cam_app` owns it and
publishes the stream through Creality's pub/sub library `libdelivery.so`; `webrtc_local`
subscribes and only packetises it into RTP. There is no JPEG on the printer.

## Transport
- Each process is a *station* with a 16-bit ID and listens on `/tmp/delivery_socket<ID>`.
  `cam_app` = station **100** (`/tmp/delivery_socket100`). `webrtc_local` sessions use
  per-session IDs (372, 376, ...).
- A subscriber opens a plain `AF_UNIX`/`SOCK_STREAM` socket (no bind) to the publisher's path.

## Framing (`packData::pack`)
Every message: `u32 payload_len, u32 type` (little-endian), then `payload_len` bytes.

## Handshake (from `subscribeWorker::create_channel` / `send_all_topics`)
| Message | type | payload |
|---|---|---|
| export ("I am station N") | `0x10000` | `u32 N` |
| subscribe | `0x10001` | `u32 N, u32 topic[, topic...]` |
(`deliveryManager::subscribe_process`: type `0x10001` adds topics, anything else deletes them;
payload length must be a multiple of 4, `0xFFFFFFFF` entries are skipped.)

`webrtc_local` calls `deliveryStation::subscribe(100, 10000, 0)`: **topic 10000 = main
camera H.264**.

## Data
`cam_app` sends each frame as `len, type=10000, payload`. Payload = Annex-B H.264:
- keyframe (~37 KB): `00 00 00 01 67 ...` SPS, PPS, IDR (NAL 7, 8, 5)
- other frames (4-10 KB): 12 zero bytes, then `00 00 01 41 9a ...` (NAL 1)
About 13.6 messages/s, ~1 Mbit/s.

## Tools
- `k2probe.c`: connect, subscribe, log message headers, optionally save the payloads.
  Build: `arm-linux-gnueabihf-gcc -O2 -static -o k2probe k2probe.c` (Debian
  `gcc-arm-linux-gnueabihf libc6-dev-armhf-cross`).
  Run on the K2: `/tmp/k2probe <myStationId=901> <topic=10000> <seconds> [out.h264]`.
- Verified on Chopper (.21) mid-print: cam_app and webrtc_local unaffected; a keyframe
  cut out as SPS+PPS+IDR decodes to a 1920x1080 JPEG with ffmpeg on the Pi.

## K2 access
SSH as root with the Pi's `/root/.ssh/printers_ed25519` (OpenWrt Dropbear reads
`/etc/dropbear/authorized_keys`; it rejects the ECDSA key).
