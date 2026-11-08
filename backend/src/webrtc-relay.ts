import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { Printer } from './types.js';

/**
 * WebRTC -> snapshot relay.
 *
 * Creality's K2/newer-K1C cameras only speak WebRTC (libpeer on :8000). The only
 * engine that can decode their H264 over DTLS is Chromium, so we drive a headless
 * Chromium: one page per printer runs the exact browser handshake, draws the video
 * to a canvas, and streams JPEG frames back to Node. The backend then serves those
 * frames at /api/camera/:id/snapshot like any other camera.
 *
 * Relays are started on demand (first snapshot request) and torn down when no one
 * has asked for ~15s, so idle printers cost nothing.
 */

const CHROME = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
// A live viewer (dashboard polling the snapshot endpoint) holds the relay warm
// this long after its last request, for smooth video.
const IDLE_MS = Number(process.env.WEBRTC_IDLE_MS || 30000);
// Grace a freshly-started page gets to produce a first frame before it can be
// reclaimed. A dataset grab (no live viewer) warms, grabs, and releases within
// this window, so a printing camera decodes in short bursts instead of 24/7.
const GRACE_MS = Number(process.env.WEBRTC_GRACE_MS || 10000);
// Hard cap on simultaneous decode pages, so the relay can never saturate the Pi.
const MAX_PAGES = Number(process.env.WEBRTC_MAX_PAGES || 4);

function relayHtml(ip: string, port: number): string {
  // Runs in headless Chromium. Posts base64 JPEGs to window.__frame(b64).
  return `<!doctype html><html><body><video id="v" autoplay playsinline muted></video>
<canvas id="c" style="display:none"></canvas>
<script>
const IP=${JSON.stringify(ip)}, PORT=${port};
const EP='http://'+IP+':'+PORT+'/call/webrtc_local';
function munge(offer, answer){
  const offPts=((offer.match(/m=video[^\\r\\n]*/)||[''])[0]).split(' ').slice(3);
  let keep=new Set(); const out=[];
  for(const l of answer.replace(/\\r\\n/g,'\\n').split('\\n')){
    if(l.startsWith('m=video')){const p=l.split(' ');let pts=p.slice(3).filter((x,i,a)=>offPts.includes(x)&&a.indexOf(x)===i);if(!pts.length)pts=[offPts[0]];keep=new Set(pts);out.push(p.slice(0,3).concat(pts).join(' '));}
    else{const m=l.match(/^a=(rtpmap|fmtp|rtcp-fb):(-?\\d+)/);if(m&&!keep.has(m[2]))continue;out.push(l);}
  }
  return out.filter(x=>x!=='').join('\\r\\n')+'\\r\\n';
}
(async()=>{
 try{
  const pc=new RTCPeerConnection();
  const tr=pc.addTransceiver('video',{direction:'recvonly'});
  try{const h=RTCRtpReceiver.getCapabilities('video').codecs.filter(c=>/H264/i.test(c.mimeType));if(h.length&&tr.setCodecPreferences)tr.setCodecPreferences(h);}catch(e){}
  const v=document.getElementById('v'), c=document.getElementById('c'), ctx=c.getContext('2d');
  pc.ontrack=e=>{v.srcObject=e.streams[0];};
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise(r=>{if(pc.iceGatheringState==='complete')return r();const f=()=>{if(pc.iceGatheringState==='complete'){pc.removeEventListener('icegatheringstatechange',f);r();}};pc.addEventListener('icegatheringstatechange',f);setTimeout(r,4000);});
  const offer=pc.localDescription.sdp;
  const resp=await fetch(EP,{method:'POST',headers:{'Content-Type':'text/plain'},body:btoa(JSON.stringify({type:'offer',sdp:offer}))});
  const ans=JSON.parse(atob(await resp.text()));
  await pc.setRemoteDescription(new RTCSessionDescription({type:'answer',sdp:munge(offer,ans.sdp)}));
  // Capture loop (~3 fps, capped width)
  setInterval(()=>{
    if(!v.videoWidth) return;
    const w=Math.min(800, v.videoWidth), h=Math.round(w*v.videoHeight/v.videoWidth);
    if(c.width!==w){c.width=w;c.height=h;}
    try{ ctx.drawImage(v,0,0,w,h); const d=c.toDataURL('image/jpeg',0.6); if(window.__frame) window.__frame(d.slice(d.indexOf(',')+1)); }catch(e){}
  }, 330);
 }catch(e){ if(window.__err) window.__err(String(e&&e.message||e)); }
})();
</script></body></html>`;
}

interface Rec { page: Page; lastFrame?: Buffer; lastFrameAt: number; holdUntil: number; starting: boolean; }

export class WebrtcRelay {
  private browser?: Browser;
  private launching?: Promise<Browser | undefined>;
  private pages = new Map<number, Rec>();
  available = true;

  async init() {
    try {
      await this.ensureBrowser();
      setInterval(() => this.sweep(), 5000);
    } catch (e) {
      this.available = false;
      console.warn('[webrtc-relay] Chromium unavailable, WebRTC cameras disabled:', (e as any)?.message || e);
    }
  }

  private async ensureBrowser(): Promise<Browser | undefined> {
    if (this.browser) return this.browser;
    if (!this.launching) {
      this.launching = puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
               '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
      }).then(b => { this.browser = b; b.on('disconnected', () => { this.browser = undefined; this.pages.clear(); }); return b; })
        .catch(e => { this.launching = undefined; throw e; });
    }
    return this.launching;
  }

  /** Start (or keep) a relay page for a printer. Safe to call repeatedly. */
  async ensure(printer: Printer) {
    if (!this.available) return;
    if (this.pages.has(printer.id)) return;
    const browser = await this.ensureBrowser().catch(() => undefined);
    if (!browser) return;
    if (this.pages.has(printer.id)) return;
    await this.evictIfFull();
    const rec: Rec = { page: undefined as any, lastFrameAt: 0, holdUntil: Date.now() + GRACE_MS, starting: true };
    this.pages.set(printer.id, rec);
    try {
      const page = await browser.newPage();
      rec.page = page;
      await page.exposeFunction('__frame', (b64: string) => { rec.lastFrame = Buffer.from(b64, 'base64'); rec.lastFrameAt = Date.now(); });
      await page.exposeFunction('__err', (_m: string) => { /* keep quiet; snapshot falls back */ });
      const host = String(printer.ip).replace(/^https?:\/\//, '').split(':')[0];
      await page.setContent(relayHtml(host, printer.webrtcPort || 8000), { waitUntil: 'load' });
      rec.starting = false;
    } catch (e) {
      this.pages.delete(printer.id);
    }
  }

  /** Mark a printer as actively viewed, holding its relay warm for smooth video. */
  touch(id: number) { const r = this.pages.get(id); if (r) r.holdUntil = Math.max(r.holdUntil, Date.now() + IDLE_MS); }

  getFrame(id: number): Buffer | null {
    const r = this.pages.get(id);
    if (r?.lastFrame && Date.now() - r.lastFrameAt < 8000) return r.lastFrame;
    return null;
  }

  /**
   * Warm a relay, wait for one fresh frame, and return it — without taking a live
   * hold. Used by the dataset logger so a printing camera decodes in short bursts
   * (warm -> grab -> release) instead of pinning a core for the whole print.
   */
  async grab(printer: Printer, timeoutMs = 9000): Promise<Buffer | null> {
    if (!this.available) return null;
    await this.ensure(printer);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const f = this.getFrame(printer.id);
      if (f) return f;
      await new Promise(r => setTimeout(r, 300));
    }
    return this.getFrame(printer.id);
  }

  // When at capacity, drop the page whose hold expires soonest to make room.
  private async evictIfFull() {
    if (this.pages.size < MAX_PAGES) return;
    let victim: number | undefined; let soonest = Infinity;
    for (const [id, r] of this.pages) if (r.holdUntil < soonest) { soonest = r.holdUntil; victim = id; }
    if (victim !== undefined) {
      const r = this.pages.get(victim)!;
      this.pages.delete(victim);
      try { await r.page?.close(); } catch { /* ignore */ }
    }
  }

  private async sweep() {
    const now = Date.now();
    for (const [id, r] of this.pages) {
      if (now > r.holdUntil) {
        this.pages.delete(id);
        try { await r.page?.close(); } catch { /* ignore */ }
      }
    }
  }

  async stop() {
    for (const [, r] of this.pages) { try { await r.page?.close(); } catch { /* ignore */ } }
    this.pages.clear();
    try { await this.browser?.close(); } catch { /* ignore */ }
  }
}

export const relay = new WebrtcRelay();
