class KlipperDashboard {
    constructor() {
        this.printers = JSON.parse(localStorage.getItem('printers')) || [];
        this.pollInterval = parseInt(localStorage.getItem('pollInterval')) || 1;
        this.pollTimer = null;
        this.previousStates = new Map();
        this.notificationsEnabled = false;
        this.websockets = new Map(); // Store WebSocket connections for each printer
        this.reconnectTimers = new Map(); // Store reconnection timers
        this.printerCache = new Map(); // Cache printer data to merge updates
        this.printerStates = new Map(); // id -> { state, progress } for fleet overview + ordering
        this.webrtcPeers = new Map(); // id -> RTCPeerConnection (Creality libpeer WebRTC cameras)
        this.currentFilter = 'all';
        this.showWebcams = (localStorage.getItem('showWebcams') ?? '1') === '1';
        this.theme = localStorage.getItem('theme') ||
            ((window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark');
        this.applyTheme();

        this.initializeDefaultPrinters();
        this.ensureK2Plus();
        this.init();
    }

    initializeDefaultPrinters() {
        if (this.printers.length === 0) {
            // Add default printers from the issue description
            const defaultPrinters = [
                { id: 1, name: 'Mokey D. Luffy', ip: '10.0.68.108', disabled: false },
                { id: 2, name: 'Roronoa Zoro', ip: '10.0.68.130', disabled: false },
                { id: 3, name: 'Nami', ip: '10.0.68.121', disabled: false },
                { id: 4, name: 'Usopp', ip: '10.0.68.116', disabled: false },
                { id: 5, name: 'Sanji', ip: '10.0.68.124', disabled: false },
                { id: 6, name: 'K2 Plus', ip: '10.0.68.21', disabled: false }
            ];
            this.printers = defaultPrinters;
            this.savePrinters();
        }
    }

    // One-time migration: make sure the K2 Plus exists on installs that already
    // had a saved printer list from a previous version (where defaults don't re-seed).
    // Guarded by a flag so it won't reappear if the user deliberately removes it.
    ensureK2Plus() {
        try {
            if (localStorage.getItem('migrated_k2plus')) return;
            const K2_IP = '10.0.68.21';
            const exists = Array.isArray(this.printers) &&
                this.printers.some(p => this.getHostFromIp(p.ip) === K2_IP);
            if (!exists) {
                this.printers.push({ id: Date.now(), name: 'K2 Plus', ip: K2_IP, disabled: false });
                this.savePrinters();
            }
            localStorage.setItem('migrated_k2plus', '1');
        } catch (e) {
            console.warn('ensureK2Plus migration failed:', e);
        }
    }

    init() {
        document.body.classList.toggle('hide-webcams', !this.showWebcams);
        const wc = document.getElementById('toggleWebcams');
        if (wc) wc.setAttribute('aria-pressed', String(this.showWebcams));

        this.setupEventListeners();
        this.updateNotificationButton();
        this.renderPrinters();
        this.startWebSocketConnections();

        // Set poll interval input value
        document.getElementById('pollInterval').value = this.pollInterval;
    }

    cameraTypeOf(printer) {
        // 'auto' tries WebRTC (K2-style libpeer) then falls back to MJPEG (K1C-style).
        // Can be overridden per printer: 'creality-webrtc' | 'mjpeg' | 'none'.
        return printer.cameraType || 'auto';
    }

    applyTheme() {
        document.documentElement.setAttribute('data-theme', this.theme);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', this.theme === 'light' ? '#eef1f6' : '#0f1115');
    }

    toggleTheme() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        localStorage.setItem('theme', this.theme);
        this.applyTheme();
    }

    toggleWebcams() {
        this.showWebcams = !this.showWebcams;
        localStorage.setItem('showWebcams', this.showWebcams ? '1' : '0');
        document.body.classList.toggle('hide-webcams', !this.showWebcams);
        const wc = document.getElementById('toggleWebcams');
        if (wc) wc.setAttribute('aria-pressed', String(this.showWebcams));
        if (this.showWebcams) this.startAllWebrtc();
        else this.stopAllWebrtc();
    }

    // ---- Creality libpeer WebRTC camera (verified against K2 Plus) ----
    // The printer runs libpeer on :8000 with local HTTP signaling at /call/webrtc_local.
    // It answers with a stray payload type (96) plus the negotiated one; Chrome rejects
    // an answer referencing PTs it didn't offer, so we keep only the shared PT(s).

    getWebrtcEndpoint(printer) {
        const host = this.getHostFromIp(printer.ip);
        const port = printer.webrtcPort || 8000;
        // Same-origin via the Caddy proxy -> no CORS/preflight. Media stays peer-to-peer.
        return `/api/proxy/${host}:${port}/call/webrtc_local`;
    }

    waitForIceGathering(pc) {
        return new Promise(resolve => {
            if (pc.iceGatheringState === 'complete') return resolve();
            const check = () => {
                if (pc.iceGatheringState === 'complete') {
                    pc.removeEventListener('icegatheringstatechange', check);
                    resolve();
                }
            };
            pc.addEventListener('icegatheringstatechange', check);
            setTimeout(resolve, 4000); // fallback: don't wait forever
        });
    }

    // Keep only answer video PTs that were in our offer; dedupe; drop orphan rtpmap/fmtp/rtcp-fb.
    mungeWebrtcAnswer(offerSdp, answerSdp) {
        const offLine = (offerSdp.match(/m=video[^\r\n]*/) || [''])[0];
        const offPts = offLine.split(' ').slice(3);
        const lines = answerSdp.replace(/\r\n/g, '\n').split('\n');
        let keep = new Set();
        const out = [];
        for (const l of lines) {
            if (l.startsWith('m=video')) {
                const p = l.split(' ');
                let pts = p.slice(3).filter((x, i, a) => offPts.includes(x) && a.indexOf(x) === i);
                if (!pts.length) pts = [offPts[0]];
                keep = new Set(pts);
                out.push(p.slice(0, 3).concat(pts).join(' '));
            } else {
                const m = l.match(/^a=(rtpmap|fmtp|rtcp-fb):(\d+)/);
                if (m && !keep.has(m[2])) continue;
                out.push(l);
            }
        }
        return out.filter(x => x !== '').join('\r\n') + '\r\n';
    }

    mjpegCandidates(printer) {
        const h = this.getHostFromIp(printer.ip);
        return [printer.webcamUrl,
                `http://${h}:4408/webcam/?action=stream`,
                `http://${h}:8080/?action=stream`].filter(Boolean);
    }

    // Orchestrator: start a printer's camera according to its type (default 'auto').
    // Named startWebrtcCamera for historical call sites; handles MJPEG too.
    startWebrtcCamera(printer) {
        if (printer.disabled || !this.showWebcams) return;
        const type = this.cameraTypeOf(printer);
        if (type === 'none') return;
        if (!this._camActive) this._camActive = new Set();
        if (this._camActive.has(printer.id)) return; // already running
        const video = document.getElementById(`cam-${printer.id}`);
        const img = document.getElementById(`cam-img-${printer.id}`);
        if (!video && !img) return;
        const container = (video && video.parentElement) || (img && img.parentElement);
        const err = container ? container.querySelector('.webcam-error') : null;
        this._camActive.add(printer.id);

        const state = { done: false };
        const showVideo = () => { state.done = true; if (video) video.style.display = ''; if (img) { img.style.display = 'none'; img.removeAttribute('src'); } if (err) err.style.display = 'none'; };
        const showImg   = () => { if (state.done) return; state.done = true; if (img) img.style.display = ''; if (video) video.style.display = 'none'; if (err) err.style.display = 'none'; };
        const showErr   = () => { if (state.done) return; if (err) err.style.display = 'flex'; };

        const tryMjpeg = () => {
            if (state.done || !img) { showErr(); return; }
            const urls = this.mjpegCandidates(printer); let i = 0;
            const next = () => {
                if (state.done) return;
                if (i >= urls.length) { showErr(); return; }
                const u = urls[i++];
                img.onload = () => { if (!state.done) showImg(); };
                img.onerror = () => { next(); };
                img.src = u;
            };
            next();
        };

        if (type === 'mjpeg') { tryMjpeg(); return; }
        // 'creality-webrtc' or 'auto'
        this.connectWebrtc(printer, video, showVideo, () => {
            if (type === 'auto') tryMjpeg(); else showErr();
        });
    }

    // Verified against K2 Plus: libpeer on :8000, POST /call/webrtc_local, reconcile PTs.
    connectWebrtc(printer, video, onSuccess, onFail) {
        if (!video) { onFail && onFail(); return; }
        if (this.webrtcPeers.has(printer.id)) return;
        let pc;
        try { pc = new RTCPeerConnection(); } catch (e) { onFail && onFail(); return; }
        this.webrtcPeers.set(printer.id, pc);

        let settled = false;
        const finish = (ok) => {
            if (settled) return; settled = true; clearTimeout(watchdog);
            if (ok) onSuccess && onSuccess();
            else { this.stopWebrtcPeer(printer.id); onFail && onFail(); }
        };
        const watchdog = setTimeout(() => { if (!(video.videoWidth > 0)) finish(false); }, 12000);
        pc.ontrack = (event) => { video.srcObject = event.streams[0]; };
        video.onloadeddata = () => { if (video.videoWidth > 0) finish(true); };
        pc.onconnectionstatechange = () => {
            if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) finish(false);
        };

        (async () => {
            try {
                const tr = pc.addTransceiver('video', { direction: 'recvonly' });
                try {
                    const h264 = RTCRtpReceiver.getCapabilities('video').codecs.filter(c => /H264/i.test(c.mimeType));
                    if (h264.length && tr.setCodecPreferences) tr.setCodecPreferences(h264);
                } catch (_) {}
                await pc.setLocalDescription(await pc.createOffer());
                await this.waitForIceGathering(pc); // non-trickle: libpeer wants a complete offer
                const offer = pc.localDescription.sdp;
                const resp = await fetch(this.getWebrtcEndpoint(printer), {
                    method: 'POST', headers: { 'Content-Type': 'text/plain' },
                    body: btoa(JSON.stringify({ type: 'offer', sdp: offer }))
                });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const ans = JSON.parse(atob(await resp.text()));
                if (ans.type !== 'answer') throw new Error('no answer');
                ans.sdp = this.mungeWebrtcAnswer(offer, ans.sdp);
                await pc.setRemoteDescription(new RTCSessionDescription(ans));
            } catch (e) {
                console.warn(`WebRTC unavailable for ${printer.name}:`, e.message || e);
                finish(false);
            }
        })();
    }

    stopWebrtcPeer(id) {
        const pc = this.webrtcPeers.get(id);
        if (pc) { try { pc.close(); } catch (_) {} }
        this.webrtcPeers.delete(id);
        const video = document.getElementById(`cam-${id}`);
        if (video) { try { video.srcObject = null; } catch (_) {} }
    }

    // Fully stop a printer's camera (WebRTC peer + MJPEG image).
    stopWebrtcCamera(id) {
        this.stopWebrtcPeer(id);
        const img = document.getElementById(`cam-img-${id}`);
        if (img) { img.onload = null; img.onerror = null; img.removeAttribute('src'); }
        if (this._camActive) this._camActive.delete(id);
    }

    startAllWebrtc() {
        // Only start cameras for printers that are actually online (WS open).
        this.printers.forEach(p => {
            const ws = this.websockets.get(p.id);
            if (!p.disabled && ws && ws.readyState === WebSocket.OPEN && this.cameraTypeOf(p) !== 'none') {
                this.startWebrtcCamera(p);
            }
        });
    }

    stopAllWebrtc() {
        const ids = new Set([...(this._camActive || []), ...this.webrtcPeers.keys()]);
        ids.forEach(id => this.stopWebrtcCamera(id));
    }

    // ---- Network scan: find Moonraker printers on the LAN (via the Caddy proxy) ----
    scanBasePrefix() {
        // Most common /24 among configured printers, else a sensible default.
        const counts = {};
        this.printers.forEach(p => {
            const h = this.getHostFromIp(p.ip);
            const m = h.match(/^(\d+\.\d+\.\d+)\.\d+$/);
            if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
        });
        const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        return (best || '10.0.68') + '.';
    }

    async poolMap(items, limit, fn) {
        let idx = 0;
        const workers = Array.from({ length: limit }, async () => {
            while (idx < items.length) { const i = idx++; await fn(items[i]); }
        });
        await Promise.all(workers);
    }

    async scanNetwork() {
        if (this._scanning) return;
        this._scanning = true;
        this.scanFound = [];
        const statusEl = document.getElementById('scanStatus');
        const resultsEl = document.getElementById('scanResults');
        const startBtn = document.getElementById('scanStart');
        if (resultsEl) resultsEl.innerHTML = '';
        if (startBtn) startBtn.disabled = true;

        let base = (document.getElementById('scanBase') || {}).value || this.scanBasePrefix();
        if (!base.endsWith('.')) base += '.';

        const nums = Array.from({ length: 254 }, (_, i) => i + 1);
        let scanned = 0;
        const setStatus = () => { if (statusEl) statusEl.textContent = `Scanning ${base}1–254 … ${scanned}/254 checked, ${this.scanFound.length} found`; };
        setStatus();

        await this.poolMap(nums, 12, async (n) => {
            const ip = base + n;
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 2000);
                const r = await fetch(`/api/proxy/${ip}:7125/printer/info`, { signal: ctrl.signal });
                clearTimeout(timer);
                if (r.ok) {
                    const j = await r.json();
                    const hostname = (j && j.result && j.result.hostname) ? j.result.hostname : '';
                    this.scanFound.push({ ip, hostname });
                    this.renderScanResults();
                }
            } catch (_) { /* offline / not moonraker */ }
            scanned++;
            if (scanned % 6 === 0 || scanned === 254) setStatus();
        });

        if (statusEl) statusEl.textContent = `Done — found ${this.scanFound.length} printer(s) on ${base}0/24.`;
        if (startBtn) startBtn.disabled = false;
        this._scanning = false;
        this.renderScanResults();
    }

    renderScanResults() {
        const el = document.getElementById('scanResults');
        if (!el) return;
        const found = (this.scanFound || []).slice().sort((a, b) => {
            const na = parseInt(a.ip.split('.').pop(), 10), nb = parseInt(b.ip.split('.').pop(), 10);
            return na - nb;
        });
        el.innerHTML = found.map((f) => {
            const i = this.scanFound.indexOf(f);
            const known = this.printers.find(p => this.getHostFromIp(p.ip) === f.ip);
            const label = f.hostname || 'Unknown printer';
            if (known) {
                return `<div class="scan-row is-known">
                    <div><div class="scan-name">${label}</div><div class="scan-ip">${f.ip}</div></div>
                    <div class="scan-actions"><span class="scan-done">✓ ${known.name}</span></div>
                </div>`;
            }
            const options = ['<option value="new">➕ Add as new</option>']
                .concat(this.printers.map(p => `<option value="${p.id}">↻ ${p.name}</option>`)).join('');
            return `<div class="scan-row" id="scan-row-${i}">
                <div><div class="scan-name">${label}</div><div class="scan-ip">${f.ip}</div></div>
                <div class="scan-actions">
                    <select id="scan-sel-${i}">${options}</select>
                    <button class="btn btn-small btn-primary" onclick="dashboard.applyScan(${i})">Apply</button>
                </div>
            </div>`;
        }).join('') || '<div class="scan-status">No printers found yet.</div>';
    }

    applyScan(i) {
        const f = this.scanFound[i];
        if (!f) return;
        const sel = document.getElementById(`scan-sel-${i}`);
        const choice = sel ? sel.value : 'new';
        if (choice === 'new') {
            this.addPrinterDirect(f.hostname || `Printer ${f.ip}`, f.ip);
        } else {
            this.updatePrinterIp(Number(choice), f.ip);
        }
        const row = document.getElementById(`scan-row-${i}`);
        if (row) row.querySelector('.scan-actions').innerHTML = '<span class="scan-done">✓ Done</span>';
    }

    addPrinterDirect(name, ip) {
        const clean = ip.replace(/^https?:\/\//, '');
        if (this.printers.some(p => this.getHostFromIp(p.ip) === this.getHostFromIp(clean))) return;
        this.printers.push({ id: Date.now(), name, ip: clean, disabled: false });
        this.savePrinters();
        this.renderPrinters();
    }

    updatePrinterIp(id, ip) {
        const idx = this.printers.findIndex(p => p.id === id);
        if (idx === -1) return;
        const clean = ip.replace(/^https?:\/\//, '');
        const ws = this.websockets.get(id);
        if (ws) { try { ws.close(); } catch (_) {} }
        this.stopWebrtcCamera(id);
        this.printers[idx] = { ...this.printers[idx], ip: clean };
        this.savePrinters();
        this.renderPrinters();
    }

    setupEventListeners() {
        document.getElementById('addPrinter').addEventListener('click', () => {
            this.openModal('addPrinterModal');
        });

        // Scan network
        const scanBtn = document.getElementById('scanNetwork');
        if (scanBtn) scanBtn.addEventListener('click', () => {
            const baseInput = document.getElementById('scanBase');
            if (baseInput && !baseInput.value) baseInput.value = this.scanBasePrefix();
            this.openModal('scanModal');
            this.scanNetwork();
        });
        const scanStart = document.getElementById('scanStart');
        if (scanStart) scanStart.addEventListener('click', () => this.scanNetwork());

        // Theme toggle
        const themeBtn = document.getElementById('themeToggle');
        if (themeBtn) themeBtn.addEventListener('click', () => this.toggleTheme());

        // Webcam show/hide
        const webcamBtn = document.getElementById('toggleWebcams');
        if (webcamBtn) webcamBtn.addEventListener('click', () => this.toggleWebcams());

        // Settings panel
        const settingsBtn = document.getElementById('settingsBtn');
        const settingsPanel = document.getElementById('settingsPanel');
        if (settingsBtn && settingsPanel) {
            settingsBtn.addEventListener('click', () => {
                const open = settingsPanel.hasAttribute('hidden');
                if (open) settingsPanel.removeAttribute('hidden');
                else settingsPanel.setAttribute('hidden', '');
                settingsBtn.setAttribute('aria-expanded', String(open));
            });
        }

        // Overview tiles act as status filters
        document.querySelectorAll('.overview .stat').forEach(tile => {
            tile.addEventListener('click', () => this.applyFilter(tile.dataset.filter));
        });

        // Enable notifications button
        const enableBtn = document.getElementById('enableNotifications');
        if (enableBtn) {
            enableBtn.addEventListener('click', () => this.requestNotificationPermission());
        }

        // Test notification button
        const testBtn = document.getElementById('testNotification');
        if (testBtn) {
            testBtn.addEventListener('click', () => {
                const timeStr = new Date().toLocaleString();
                this.showNotification('Control Center', `This is a test notification (${timeStr})`);
            });
        }

        // Close modals (× button)
        document.querySelectorAll('.close').forEach(closeBtn => {
            closeBtn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                if (modal) modal.classList.remove('open');
            });
        });

        // Close modal when clicking the backdrop
        window.addEventListener('click', (event) => {
            if (event.target.classList && event.target.classList.contains('modal')) {
                event.target.classList.remove('open');
            }
        });

        // Close modal on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
            }
        });

        // Add printer form
        document.getElementById('addPrinterForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.addPrinter();
        });

        // Edit printer form
        document.getElementById('editPrinterForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveEditedPrinter();
        });

        // Save settings
        document.getElementById('saveSettings').addEventListener('click', () => {
            this.saveSettings();
        });
    }

    openModal(id) {
        const m = document.getElementById(id);
        if (m) m.classList.add('open');
    }

    closeModal(id) {
        const m = document.getElementById(id);
        if (m) m.classList.remove('open');
    }

    applyFilter(filter) {
        this.currentFilter = (this.currentFilter === filter && filter !== 'all') ? 'all' : (filter || 'all');
        document.querySelectorAll('.overview .stat').forEach(t => {
            t.classList.toggle('active', t.dataset.filter === this.currentFilter && this.currentFilter !== 'all');
        });
        this.printers.forEach(p => this.applyCardVisibility(p.id));
    }

    // Map a raw printer state to the filter bucket used by the overview tiles
    filterBucket(state) {
        if (state === 'printing' || state === 'paused') return 'printing';
        if (state === 'ready') return 'ready';
        if (state === 'complete') return 'complete';
        if (state === 'offline' || state === 'disabled') return 'offline';
        return 'ready';
    }

    applyCardVisibility(printerId) {
        const card = document.getElementById(`card-${printerId}`);
        if (!card) return;
        const st = this.printerStates.get(printerId);
        const bucket = this.filterBucket(st ? st.state : 'offline');
        const show = this.currentFilter === 'all' || this.currentFilter === bucket;
        card.style.display = show ? '' : 'none';
    }

    async requestNotificationPermission() {
        if (!('Notification' in window)) {
            alert('This browser does not support desktop notifications');
            return;
        }

        try {
            const permission = await Notification.requestPermission();
            this.notificationsEnabled = permission === 'granted';
            this.updateNotificationButton();
            
            if (permission === 'granted') {
                this.showNotification('Notifications Enabled', 'You will now receive print completion notifications!');
            } else if (permission === 'denied') {
                alert('Notifications have been blocked. To enable them:\n\n1. Click the lock icon in your address bar\n2. Set Notifications to "Allow"\n3. Refresh the page');
            }
        } catch (error) {
            console.error('Error requesting notification permission:', error);
            alert('Failed to request notification permission. Please try again.');
        }
    }

    updateNotificationButton() {
        const enableBtn = document.getElementById('enableNotifications');
        if (!enableBtn) return;
        const ico = enableBtn.querySelector('.btn-ico');
        const setIco = (c) => { if (ico) ico.textContent = c; };

        if (!('Notification' in window)) {
            enableBtn.className = 'btn btn-ghost notification-btn disabled';
            enableBtn.disabled = true;
            enableBtn.title = 'Notifications not supported';
            setIco('🔕');
            return;
        }

        switch (Notification.permission) {
            case 'granted':
                enableBtn.className = 'btn btn-ghost notification-btn enabled';
                enableBtn.disabled = true;
                enableBtn.title = 'Notifications enabled';
                setIco('🔔');
                this.notificationsEnabled = true;
                break;
            case 'denied':
                enableBtn.className = 'btn btn-ghost notification-btn blocked';
                enableBtn.disabled = false;
                enableBtn.title = 'Notifications blocked — click for help';
                setIco('🔕');
                this.notificationsEnabled = false;
                break;
            default:
                enableBtn.className = 'btn btn-ghost notification-btn';
                enableBtn.disabled = false;
                enableBtn.title = 'Enable notifications';
                setIco('🔔');
                this.notificationsEnabled = false;
        }
    }

    showNotification(title, body, options = {}) {
        try {
            if (!('Notification' in window)) {
                // Desktop notifications not supported; fallback
                console.log(`Notification: ${title} - ${body}`);
                return;
            }

            const permission = Notification.permission;
            if (permission !== 'granted') {
                console.log(`Notification blocked: ${title} - ${body}`);
                return;
            }

            // Permission granted: create desktop notification with sensible defaults
            const defaultIcon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="%23007bff"/><path d="M9 12.5l2 2 4-4" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            const notifOptions = {
                body,
                icon: options.icon || defaultIcon,
                tag: options.tag,
                requireInteraction: options.requireInteraction ?? false,
                ...options
            };
            const n = new Notification(title, notifOptions);
            n.onclick = () => {
                try {
                    window.focus();
                    if (options.onClickUrl) {
                        window.open(options.onClickUrl, '_blank');
                    }
                    n.close();
                } catch (_) {}
            };
        } catch (e) {
            // Fallback if notifications fail for any reason
            console.error('Notification failed:', e);
        }
    }

    addPrinter() {
        const name = document.getElementById('printerName').value.trim();
        const ip = document.getElementById('printerIP').value.trim();

        if (!name || !ip) {
            alert('Please fill in printer name and IP address');
            return;
        }

        const newPrinter = {
            id: Date.now(),
            name: name,
            ip: ip.replace(/^https?:\/\//, '').replace(/:4408$/, ''),
            disabled: false
        };

        this.printers.push(newPrinter);
        this.savePrinters();
        this.renderPrinters();
        
        // Reset form and close modal
        document.getElementById('addPrinterForm').reset();
        this.closeModal('addPrinterModal');
    }

    editPrinter(id) {
        const printer = this.printers.find(p => p.id === id);
        if (!printer) return;
        
        // Populate the edit form with current values
        document.getElementById('editPrinterName').value = printer.name;
        document.getElementById('editPrinterIP').value = printer.ip;
        
        // Store the printer ID for saving later
        this.editingPrinterId = id;

        // Show the edit modal
        this.openModal('editPrinterModal');
    }

    saveEditedPrinter() {
        const name = document.getElementById('editPrinterName').value.trim();
        const ip = document.getElementById('editPrinterIP').value.trim();
        
        if (!name || !ip) {
            alert('Please fill in printer name and IP address');
            return;
        }
        
        const printerIndex = this.printers.findIndex(p => p.id === this.editingPrinterId);
        if (printerIndex === -1) {
            alert('Printer not found');
            return;
        }
        
        // Close existing WebSocket connection if IP changed
        const oldPrinter = this.printers[printerIndex];
        const ipChanged = oldPrinter.ip !== ip.replace(/^https?:\/\//, '').replace(/:4408$/, '');
        
        if (ipChanged) {
            const ws = this.websockets.get(this.editingPrinterId);
            if (ws) {
                ws.close();
            }
            // Clear reconnection timer
            const timer = this.reconnectTimers.get(this.editingPrinterId);
            if (timer) {
                clearTimeout(timer);
                this.reconnectTimers.delete(this.editingPrinterId);
            }
        }
        
        // Update the printer
        this.printers[printerIndex] = {
            ...this.printers[printerIndex],
            name: name,
            ip: ip.replace(/^https?:\/\//, '').replace(/:4408$/, '')
        };
        
        this.savePrinters();
        this.renderPrinters();
        
        // Reconnect WebSocket if IP changed and printer is enabled
        if (ipChanged && !this.printers[printerIndex].disabled) {
            this.connectWebSocket(this.printers[printerIndex]);
        }
        
        // Reset form and close modal
        document.getElementById('editPrinterForm').reset();
        this.closeModal('editPrinterModal');
        this.editingPrinterId = null;
    }

    removePrinter(id) {
        if (confirm('Are you sure you want to remove this printer?')) {
            // Tear down any live connection/timer for this printer
            const ws = this.websockets.get(id);
            if (ws) { try { ws.close(); } catch (_) {} }
            this.websockets.delete(id);
            const timer = this.reconnectTimers.get(id);
            if (timer) { clearTimeout(timer); this.reconnectTimers.delete(id); }
            this.stopWebrtcCamera(id);
            this.printerStates.delete(id);

            this.printers = this.printers.filter(printer => printer.id !== id);
            this.savePrinters();
            this.renderPrinters();
        }
    }

    saveSettings() {
        const newInterval = parseInt(document.getElementById('pollInterval').value);
        if (newInterval && newInterval > 0) {
            this.pollInterval = newInterval;
            localStorage.setItem('pollInterval', this.pollInterval.toString());
            this.restartWebSocketConnections();
            alert('Settings saved successfully!');
        }
    }

    savePrinters() {
        localStorage.setItem('printers', JSON.stringify(this.printers));
    }

    togglePrinterDisabled(id) {
        const idx = this.printers.findIndex(p => p.id === id);
        if (idx === -1) return;
        const wasDisabled = !!this.printers[idx].disabled;
        this.printers[idx].disabled = !wasDisabled;
        this.savePrinters();
        
        // Handle WebSocket connection for toggled printer
        if (this.printers[idx].disabled) {
            // Disconnect WebSocket if printer is being disabled
            const ws = this.websockets.get(id);
            if (ws) {
                ws.close();
            }
            // Clear reconnection timer
            const timer = this.reconnectTimers.get(id);
            if (timer) {
                clearTimeout(timer);
                this.reconnectTimers.delete(id);
            }
        } else {
            // Connect WebSocket if printer is being enabled
            this.connectWebSocket(this.printers[idx]);
        }
        
        // Re-render the card UI and refresh statuses
        this.renderPrinters();
    }

    renderPrinters() {
        const grid = document.getElementById('printerGrid');
        this.stopAllWebrtc(); // tear down peers before rebuilding the DOM
        grid.innerHTML = '';
        this.printerStates.clear();

        this.printers.forEach(printer => {
            const card = this.createPrinterCard(printer);
            grid.appendChild(card);
        });

        this.updateEmptyState();
        this.updateOverview();

        // Fetch initial status for all printers. Cameras start per-printer when its
        // WebSocket connects (see connectWebSocket), so we don't hammer offline printers.
        this.updateAllPrinterStatus();
    }

    createPrinterCard(printer) {
        const card = document.createElement('div');
        card.className = 'printer-card';
        card.id = `card-${printer.id}`;
        const ip = this.getHostFromIp(printer.ip);
        const camType = this.cameraTypeOf(printer);
        let webcamInner = '';
        if (camType !== 'none') {
            // Both elements exist; startWebrtcCamera() shows whichever source connects.
            webcamInner = `<video class="webcam-stream" id="cam-${printer.id}" autoplay playsinline muted style="display:none"></video>
               <img class="webcam-stream" id="cam-img-${printer.id}" alt="${printer.name} camera" style="display:none">
               <div class="webcam-error">Camera unavailable</div>`;
        }
        card.innerHTML = `
            <div class="card-actions">
                <button class="icon-btn" onclick="dashboard.togglePrinterDisabled(${printer.id})" title="${printer.disabled ? 'Enable' : 'Disable'}">${printer.disabled ? '⏻' : '⏸'}</button>
                <button class="icon-btn" onclick="dashboard.editPrinter(${printer.id})" title="Edit">✏️</button>
                <button class="icon-btn danger" onclick="dashboard.removePrinter(${printer.id})" title="Remove">×</button>
            </div>
            <div class="printer-header">
                <div class="printer-id">
                    <div class="printer-name">${printer.name}</div>
                    <div class="printer-ip">${ip}</div>
                </div>
                <span class="badge status-disabled" id="badge-${printer.id}">
                    <span class="dot"></span><span id="status-text-${printer.id}">Offline</span>
                </span>
            </div>
            <div class="progress-section">
                <div class="progress-top">
                    <span class="progress-file" id="file-${printer.id}">—</span>
                    <span class="progress-pct" id="progress-${printer.id}">—</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" id="progress-bar-${printer.id}" style="width: 0%"></div>
                </div>
            </div>
            <div class="printer-info">
                <div class="info-item">
                    <div class="info-label">🛏️ Bed</div>
                    <div class="info-value" id="bed-temp-${printer.id}">—</div>
                </div>
                <div class="info-item">
                    <div class="info-label">🔥 Nozzle</div>
                    <div class="info-value" id="extruder-temp-${printer.id}">—</div>
                </div>
                <div class="info-item">
                    <div class="info-label">⏱️ Elapsed</div>
                    <div class="info-value" id="print-time-${printer.id}">—</div>
                </div>
                <div class="info-item">
                    <div class="info-label">🏁 ETA</div>
                    <div class="info-value" id="eta-${printer.id}">—</div>
                </div>
            </div>
            ${webcamInner ? `<div class="webcam-container">${webcamInner}</div>` : ''}
        `;
        if (printer.disabled) {
            card.classList.add('disabled');
        }
        // Seed initial state (disabled or offline) so overview/order are correct on first paint
        this.setPrinterState(printer, printer.disabled ? 'disabled' : 'offline', card);
        return card;
    }

    // Central place to reflect a printer's state in the UI: badge, card accent,
    // live ordering (via CSS order, no DOM rebuild), and overview.
    setPrinterState(printer, state, cardEl) {
        const prev = this.printerStates.get(printer.id) || {};
        const progress = typeof prev.progress === 'number' ? prev.progress : 0;
        this.printerStates.set(printer.id, { state, progress });

        const card = cardEl || document.getElementById(`card-${printer.id}`);
        if (card) {
            card.classList.remove('state-printing', 'state-ready', 'state-offline', 'state-complete', 'state-paused');
            const cardState = { printing: 'printing', paused: 'paused', ready: 'ready', complete: 'complete', offline: 'offline' }[state];
            if (cardState) card.classList.add(`state-${cardState}`);
            card.classList.toggle('disabled', state === 'disabled');

            const order = { printing: 0, paused: 1, complete: 2, ready: 3, offline: 4, disabled: 5 }[state] ?? 4;
            card.style.order = String(order);
        }

        const badge = document.getElementById(`badge-${printer.id}`);
        const text = document.getElementById(`status-text-${printer.id}`);
        if (badge) {
            const badgeClass = { printing: 'printing', paused: 'printing', ready: 'online', complete: 'complete', offline: 'offline', disabled: 'disabled' }[state] || 'offline';
            badge.className = `badge status-${badgeClass}`;
        }
        if (text) {
            text.textContent = { printing: 'Printing', paused: 'Paused', ready: 'Ready', complete: 'Complete', offline: 'Offline', disabled: 'Disabled' }[state] || 'Offline';
        }

        this.applyCardVisibility(printer.id);
        this.updateOverview();
    }

    setPrinterProgress(printerId, progress) {
        const st = this.printerStates.get(printerId);
        if (st) { st.progress = progress; this.printerStates.set(printerId, st); }
    }

    updateOverview() {
        let printing = 0, ready = 0, complete = 0, offline = 0;
        this.printerStates.forEach(({ state }) => {
            const b = this.filterBucket(state);
            if (b === 'printing') printing++;
            else if (b === 'ready') ready++;
            else if (b === 'complete') complete++;
            else if (b === 'offline') offline++;
        });
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
        set('ov-printing', printing);
        set('ov-ready', ready);
        set('ov-complete', complete);
        set('ov-offline', offline);
        set('ov-total', this.printers.length);
    }

    updateEmptyState() {
        const empty = document.getElementById('emptyState');
        const grid = document.getElementById('printerGrid');
        if (!empty || !grid) return;
        const none = this.printers.length === 0;
        if (none) empty.removeAttribute('hidden'); else empty.setAttribute('hidden', '');
        grid.style.display = none ? 'none' : '';
    }

    connectWebSocket(printer) {
        if (printer.disabled) {
            return;
        }

        const host = this.getHostFromIp(printer.ip);
        const wsUrl = `ws://${host}:7125/websocket`;
        
        try {
            const ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                console.log(`WebSocket connected to ${printer.name}`);
                
                // Subscribe to printer objects
                const subscribeMessage = {
                    jsonrpc: '2.0',
                    method: 'printer.objects.subscribe',
                    params: {
                        objects: {
                            print_stats: null,
                            heater_bed: null,
                            extruder: null,
                            display_status: null,
                            virtual_sdcard: null,
                        }
                    },
                    id: Date.now()
                };
                
                ws.send(JSON.stringify(subscribeMessage));

                // Clear any existing reconnect timer
                const reconnectTimer = this.reconnectTimers.get(printer.id);
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    this.reconnectTimers.delete(printer.id);
                }

                // Printer is reachable — now start its camera (avoids hammering offline printers)
                if (this.showWebcams && this.cameraTypeOf(printer) !== 'none') {
                    this.startWebrtcCamera(printer);
                }
            };
            
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    // Handle subscription updates
                    if (data.method === 'notify_status_update' && data.params) {
                        this.handleStatusUpdate(printer, data.params[0]);
                    } else if(data.result) {
                      this.handleStatusUpdate(printer, data.result.status);
                    }
                } catch (error) {
                    console.error(`Error parsing WebSocket message for ${printer.name}:`, error);
                }
            };
            
            ws.onclose = () => {
                console.log(`WebSocket disconnected from ${printer.name}`);
                this.websockets.delete(printer.id);
                this.updatePrinterOfflineStatus(printer);
                // Printer went away — drop its camera too
                this.stopWebrtcCamera(printer.id);

                // Schedule reconnection if printer is not disabled
                if (!printer.disabled) {
                    this.scheduleReconnect(printer);
                }
            };
            
            ws.onerror = (error) => {
                console.error(`WebSocket error for ${printer.name}:`, error);
                this.updatePrinterOfflineStatus(printer);
            };
            
            this.websockets.set(printer.id, ws);
            
        } catch (error) {
            console.error(`Failed to create WebSocket for ${printer.name}:`, error);
            this.updatePrinterOfflineStatus(printer);
            this.scheduleReconnect(printer);
        }
    }

    deepMerge(target, source) {
        // Deep merge function to merge objects recursively
        if (!source || typeof source !== 'object') return target;
        if (!target || typeof target !== 'object') return source;
        
        const result = { ...target };
        
        for (const key in source) {
            if (source.hasOwnProperty(key)) {
                if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                    // Recursively merge nested objects
                    result[key] = this.deepMerge(result[key] || {}, source[key]);
                } else {
                    // Direct assignment for primitive values, arrays, or null
                    result[key] = source[key];
                }
            }
        }
        
        return result;
    }

    scheduleReconnect(printer) {
        // Clear existing timer
        const existingTimer = this.reconnectTimers.get(printer.id);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        
        // Schedule reconnection in 5 seconds
        const timer = setTimeout(() => {
            if (!printer.disabled) {
                this.connectWebSocket(printer);
            }
            this.reconnectTimers.delete(printer.id);
        }, 5000);
        
        this.reconnectTimers.set(printer.id, timer);
    }

    handleStatusUpdate(printer, statusData) {
        // Update status based on received data
        let currentState = 'idle';

        // Get or initialize cached data for this printer
        let cachedData = this.printerCache.get(printer.id) || {
            print_stats: {},
            display_status: {},
            virtual_sdcard: {},
            heater_bed: {},
            extruder: {}
        };

        // Deep merge new data with cached data (only update provided values)
        if (statusData.print_stats) {
            cachedData.print_stats = this.deepMerge(cachedData.print_stats, statusData.print_stats);
        }
        if (statusData.display_status) {
            cachedData.display_status = this.deepMerge(cachedData.display_status, statusData.display_status);
        }
        if (statusData.virtual_sdcard) {
            cachedData.virtual_sdcard = this.deepMerge(cachedData.virtual_sdcard, statusData.virtual_sdcard);
        }
        if (statusData.heater_bed) {
            cachedData.heater_bed = this.deepMerge(cachedData.heater_bed, statusData.heater_bed);
        }
        if (statusData.extruder) {
            cachedData.extruder = this.deepMerge(cachedData.extruder, statusData.extruder);
        }

        // Update cache
        this.printerCache.set(printer.id, cachedData);

        // Use cached data for processing
        const printStats = cachedData.print_stats;
        const displayStatus = cachedData.display_status;
        const virtualSdcard = cachedData.virtual_sdcard;
        const heaterBed = cachedData.heater_bed;
        const extruder = cachedData.extruder;
        
        if (printStats) {
            currentState = printStats.state || 'idle';
            
            // Use virtual_sdcard.progress for more accurate progress calculation
            if (virtualSdcard && virtualSdcard.progress !== undefined) {
                const progress = virtualSdcard.progress;
              this.setPrinterProgress(printer.id, progress);
              document.getElementById(`progress-${printer.id}`).textContent =
                `${Math.round(progress * 100)}%`;
              document.getElementById(`progress-bar-${printer.id}`).style.width =
                `${progress * 100}%`;
              if (printStats.total_duration && progress > 0) {
                const remaining = printStats.total_duration * (1 - progress);
                const eta = new Date(Date.now() + remaining * 1000);
                document.getElementById(`eta-${printer.id}`).textContent =
                  eta.toLocaleTimeString();
              } else {
                document.getElementById(`eta-${printer.id}`).textContent = '-';
              }
            }
            
            // Update print information
            document.getElementById(`file-${printer.id}`).textContent = 
                printStats.filename || '-';

            
            if (printStats.print_duration) {
                const printTime = this.formatTime(printStats.print_duration);
                document.getElementById(`print-time-${printer.id}`).textContent = printTime;
            }
            

        }
        
        // Update temperatures
        if (heaterBed) {
            document.getElementById(`bed-temp-${printer.id}`).textContent =
                `${Math.round(heaterBed.temperature)}°C / ${Math.round(heaterBed.target)}°C`;
        }
        
        if (extruder) {
            document.getElementById(`extruder-temp-${printer.id}`).textContent = 
                `${Math.round(extruder.temperature)}°C / ${Math.round(extruder.target)}°C`;
        }
        
        // Map Klipper print_stats.state -> our UI state and reflect it everywhere
        let uiState;
        switch (currentState) {
            case 'printing': uiState = 'printing'; break;
            case 'paused':   uiState = 'paused'; break;
            case 'complete':
                uiState = 'complete';
                this.checkForPrintCompletion(printer, currentState);
                break;
            default:         uiState = 'ready';
        }
        // Don't override a user-disabled card with live data
        if (!printer.disabled) {
            this.setPrinterState(printer, uiState);
        }
    }

    updatePrinterOfflineStatus(printer) {
        this.setPrinterState(printer, printer.disabled ? 'disabled' : 'offline');
        this.setPrinterProgress(printer.id, 0);
        this.clearPrinterInfo(printer.id);
    }

    async fetchPrinterStatus(printer) {
        // This method is kept for initial status fetch if needed
        // WebSocket subscriptions will handle real-time updates
        return { online: false };
    }

    getHostFromIp(ip) {
        try {
            const clean = String(ip).replace(/^https?:\/\//, '');
            const [host] = clean.split(':');
            return host || clean;
        } catch (_) {
            return String(ip);
        }
    }

    getMoonrakerProxyEndpoint(printerIp) {
        // Derive host from stored ip (which might include a different port like 4408)
        const host = this.getHostFromIp(printerIp);

        // Use specific mapping if known; otherwise use the generic 7125 proxy
        return `/api/proxy/${host}:7125`;
    }

    async updatePrinterStatus(printer) {
        // For disabled printers, just update the UI status
        if (printer.disabled) {
            this.updatePrinterOfflineStatus(printer);
            return;
        }
        
        // For enabled printers, ensure WebSocket connection exists
        if (!this.websockets.has(printer.id)) {
            this.connectWebSocket(printer);
        }
    }

    checkForPrintCompletion(printer, currentState) {
        const previousState = this.previousStates.get(printer.id);
        
        if (previousState !== 'complete' && currentState === 'complete') {
            this.showCompletionNotification(printer);
        }
        
        this.previousStates.set(printer.id, currentState);
    }

    showCompletionNotification(printer) {
        this.showNotification(
            `Print Complete - ${printer.name}`,
            'Your 3D print has finished!',
            {
                tag: `printer-${printer.id}`,
                requireInteraction: true
            }
        );
    }

    clearPrinterInfo(printerId) {
        const fields = ['file', 'progress', 'bed-temp', 'extruder-temp', 'print-time', 'eta'];
        fields.forEach(field => {
            const element = document.getElementById(`${field}-${printerId}`);
            if (element) element.textContent = '-';
        });
        
        const progressBar = document.getElementById(`progress-bar-${printerId}`);
        if (progressBar) progressBar.style.width = '0%';
    }

    formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m ${remainingSeconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${remainingSeconds}s`;
        } else {
            return `${remainingSeconds}s`;
        }
    }

    async updateAllPrinterStatus() {
        // Connect WebSockets for all enabled printers
        this.printers.forEach(printer => {
            this.updatePrinterStatus(printer);
        });
    }

    startWebSocketConnections() {
        this.stopWebSocketConnections();
        this.updateAllPrinterStatus();
    }

    stopWebSocketConnections() {
        // Close all WebSocket connections
        this.websockets.forEach((ws, printerId) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });
        this.websockets.clear();
        
        // Clear all reconnection timers
        this.reconnectTimers.forEach((timer) => {
            clearTimeout(timer);
        });
        this.reconnectTimers.clear();
    }

    restartWebSocketConnections() {
        this.startWebSocketConnections();
    }
}

// Initialize dashboard when page loads
let dashboard;
document.addEventListener('DOMContentLoaded', () => {
    dashboard = new KlipperDashboard();
});

// Handle page visibility change to pause/resume WebSocket connections
document.addEventListener('visibilitychange', () => {
    if (dashboard) {
        if (document.hidden) {
            dashboard.stopWebSocketConnections();
            dashboard.stopAllWebrtc();
        } else {
            dashboard.startWebSocketConnections();
            if (dashboard.showWebcams) dashboard.startAllWebrtc();
        }
    }
});