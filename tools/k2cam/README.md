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

## k2cam service (installed on Chopper .21, 2026-11-21)
`k2cam.c` subscribes like the probe (station 9001), keeps the latest keyframe in memory and
serves HTTP on **:8080** (the port the K2's nginx already proxies as `/webcam/`, so Fluidd and
`:4408/webcam/?action=snapshot` work too):
- `GET /keyframe`: latest keyframe, raw H.264, headers `X-Seq`, `X-Age-Ms` (503 if none in 5 s)
- `GET /?action=snapshot`: JPEG (default 1280x720), decoded on demand by the printer's own
  ffmpeg 4.3 (`nice 19`, one at a time, cached per keyframe; ~1.1 s on the busy T113)
- `GET /status`: JSON (subscribed, keyframe seq/bytes/age, frames, snapshots made)
Measured on Chopper mid-print: k2cam ~0% CPU, 0.8 MB RSS.

Build and install (from the Pi; nothing else on the printer changes):
```
arm-linux-gnueabihf-gcc -O2 -Wall -Wextra -static -o k2cam k2cam.c
K="ssh -i /root/.ssh/printers_ed25519 -o IdentitiesOnly=yes root@<k2-ip>"
$K "cat > /usr/bin/k2cam && chmod 755 /usr/bin/k2cam" < k2cam
$K "cat > /etc/init.d/k2cam && chmod 755 /etc/init.d/k2cam && /etc/init.d/k2cam enable && /etc/init.d/k2cam start" < k2cam.init
```
procd keeps it running (`respawn`), logs go to `logread`. Remove: `/etc/init.d/k2cam stop;
/etc/init.d/k2cam disable; rm /usr/bin/k2cam /etc/init.d/k2cam`. Both files are on the
overlay, so a firmware update removes them.

## Pi side (`backend/src/k2cam.ts`, camera type `k2`)
- Live view: one long-running ffmpeg per K2 decodes `/keyframe`s (an AUD is appended so the
  parser emits each frame at once); stops 60 s after the last viewer. ~0.10 core and 90 MB
  at 1 frame/s, 720p (the Chromium relay took ~0.3 core and a 130-260 MB page per camera).
- Dataset/AI frames: a live frame under 5 s old, else the printer's `/?action=snapshot`, so
  an unwatched K2 costs the Pi nothing.
- Without the relay's WebRTC session, the printer's `webrtc_local` went from 28% to 0% CPU.

## Hardware H.264 decode on the K2 (verified 2026-11-21, Chopper idle)
The T113-i (sun8iw20p1) has Allwinner's video engine (`/dev/cedar_dev`, unused by the
firmware: the camera already delivers H.264). Its CedarC **v1.3.0** libraries are on the
printer (`/usr/lib`, base image `/rom/usr/lib`). `cedartest.c` drives them via `dlopen`:
- Headers: libcedarc from the Lindenis V853 Tina SDK (2021), `lindenis-org/lindenis-v853-external`
  `libcedarc/include` (the 2018 v1.1.9 copy, aodzip/libcedarc, is older). VConfig layout checked
  against the printer's `InitializeVideoDecoder` (reads offsets 80/148/156/160 =
  bSecureosEn/nVeFreq/bSetProcInfoEnable/nSetProcInfoFreq); structs passed in are zero-padded.
- Sequence: `MemAdapterGetOpsS()->open()`, `CreateVideoDecoder`, **register the codec plugin
  by calling `CedarPluginVDInit()` from `libawh264.so`** (otherwise "unsupported format
  H264"; the player normally does this via `AddVDPlugin`), `InitializeVideoDecoder`
  (eCodecFormat 0x115, 1920x1080, bIsFramePackage 1, NV21 = 5, nVbvBufferSize 2 MB, memops),
  then per frame `RequestVideoStreamBuffer` (ring: copy into buf0/buf1) ->
  `SubmitVideoStreamData` (first+last part, valid) -> poll `DecodeVideoStream` +
  `RequestPicture` with 2 ms sleeps (the engine finishes asynchronously; a tight loop
  gave flaky results) -> `flush_cache` the planes -> read -> `ReturnPicture`.
- Do **not** append an AUD (NAL 9): with it nothing decodes. Feeding the same keyframe
  repeatedly also stalls (same frame_num/idr_pic_id looks like one picture); a real stream
  is fine. A picture comes out one submission later (needs the next start code).
- Result: 1920x1088 NV21 (crop to 1080), correct image; **~10 ms wall, 2.3 ms CPU per
  picture** vs ~430 ms CPU for ffmpeg's software decode on the same chip.
- Build: Debian buster `gcc-arm-linux-gnueabihf` (glibc 2.28; the K2 has 2.29),
  `arm-linux-gnueabihf-gcc -O2 -o cedartest cedartest.c -ldl`.
  Run: `cedartest kf0.h264,kf1.h264,kf2.h264 <runs> [out.nv21|""] [framePkg=1] [aud=0] [noB=0]`.
Next: hardware JPEG encode (`libvencoder`, `VideoEncCreate` with the JPEG codec) so k2cam
can serve JPEGs with almost no CPU.
