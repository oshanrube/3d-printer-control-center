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
        
        // Migrate any legacy data formats/URLs before proceeding
        this.migrateLegacyWebcamUrls();
        
        this.initializeDefaultPrinters();
        this.ensureK2Plus();
        this.init();
    }

    migrateLegacyWebcamUrls() {
        try {
            if (!Array.isArray(this.printers) || this.printers.length === 0) return;
            let updated = false;
            this.printers = this.printers.map(p => {
                const printer = { ...p };
                if (printer.webcamUrl && /:8080(\/stream|\/\?action=stream)/.test(printer.webcamUrl)) {
                    // Determine IP:PORT from printer.ip or from the webcamUrl itself
                    let ipPort = '';
                    if (printer.ip) {
                        ipPort = String(printer.ip).replace(/^https?:\/\//, '');
                    }
                    if (!ipPort) {
                        try {
                            const u = new URL(printer.webcamUrl);
                            ipPort = u.host; // includes hostname:port
                        } catch (_) {
                            // leave empty if parsing fails
                        }
                    }
                    if (ipPort) {
                        printer.webcamUrl = `http://${ipPort}/webcam/?action=stream`;
                        updated = true;
                    }
                }
                return printer;
            });
            if (updated) {
                this.savePrinters();
            }
        } catch (e) {
            console.warn('Migration of legacy webcam URLs failed:', e);
        }
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
        this.setupEventListeners();
        this.updateNotificationButton();
        this.renderPrinters();
        this.startWebSocketConnections();
        
        // Set poll interval input value
        document.getElementById('pollInterval').value = this.pollInterval;
    }

    setupEventListeners() {
        // Add printer button
        document.getElementById('addPrinter').addEventListener('click', () => {
            document.getElementById('addPrinterModal').style.display = 'block';
        });

        // Enable notifications button
        const enableBtn = document.getElementById('enableNotifications');
        if (enableBtn) {
            enableBtn.addEventListener('click', () => {
                this.requestNotificationPermission();
            });
        }

        // Test notification button
        const testBtn = document.getElementById('testNotification');
        if (testBtn) {
            testBtn.addEventListener('click', () => {
                const now = new Date();
                const timeStr = now.toLocaleString();
                this.showNotification('Klipper Dashboard', `This is a test notification (${timeStr})`);
            });
        }

        // Close modals
        document.querySelectorAll('.close').forEach(closeBtn => {
            closeBtn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                if (modal) {
                    modal.style.display = 'none';
                }
            });
        });

        // Close modal when clicking outside
        window.addEventListener('click', (event) => {
            const addModal = document.getElementById('addPrinterModal');
            const editModal = document.getElementById('editPrinterModal');
            if (event.target === addModal) {
                addModal.style.display = 'none';
            }
            if (event.target === editModal) {
                editModal.style.display = 'none';
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

        if (!('Notification' in window)) {
            enableBtn.textContent = 'Notifications Not Supported';
            enableBtn.disabled = true;
            enableBtn.className = 'notification-btn disabled';
            return;
        }

        const permission = Notification.permission;
        switch (permission) {
            case 'granted':
                enableBtn.textContent = '✓ Notifications Enabled';
                enableBtn.disabled = true;
                enableBtn.className = 'notification-btn enabled';
                this.notificationsEnabled = true;
                break;
            case 'denied':
                enableBtn.textContent = '✗ Notifications Blocked';
                enableBtn.disabled = false;
                enableBtn.className = 'notification-btn blocked';
                this.notificationsEnabled = false;
                break;
            default: // 'default'
                enableBtn.textContent = 'Enable Notifications';
                enableBtn.disabled = false;
                enableBtn.className = 'notification-btn';
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
        document.getElementById('addPrinterModal').style.display = 'none';
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
        document.getElementById('editPrinterModal').style.display = 'block';
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
        document.getElementById('editPrinterModal').style.display = 'none';
        this.editingPrinterId = null;
    }

    removePrinter(id) {
        if (confirm('Are you sure you want to remove this printer?')) {
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
        grid.innerHTML = '';

        this.printers.forEach(printer => {
            const card = this.createPrinterCard(printer);
            grid.appendChild(card);
        });

        // Fetch initial status for all printers
        this.updateAllPrinterStatus();
    }

    createPrinterCard(printer) {
        const card = document.createElement('div');
        card.className = 'printer-card';
        card.innerHTML = `
            <button class="remove-printer" onclick="dashboard.removePrinter(${printer.id})" title="Remove Printer">×</button>
            <button class="edit-printer" onclick="dashboard.editPrinter(${printer.id})" title="Edit Printer">✏️</button>
            <button class="disable-printer" onclick="dashboard.togglePrinterDisabled(${printer.id})" title="${printer.disabled ? 'Enable' : 'Disable'} Printer">${printer.disabled ? '⏻' : '⏸'}</button>
            <div class="printer-header">
                <div class="printer-name">${printer.name} <span class="printer-ip">(${printer.ip.replace(/^https?:\/\//, '')})</span></div>
                <div class="printer-status">
                    <span class="status-indicator ${printer.disabled ? 'status-disabled' : 'status-offline'}" id="status-${printer.id}"></span>
                    <span id="status-text-${printer.id}">${printer.disabled ? 'Disabled' : 'Offline'}</span>
                </div>
            </div>
            <div class="printer-info">
                <div class="info-item">
                    <div class="info-label">Current File</div>
                    <div class="info-value" id="file-${printer.id}">-</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Progress</div>
                    <div class="info-value" id="progress-${printer.id}">-</div>
                    <div class="progress-bar">
                        <div class="progress-fill" id="progress-bar-${printer.id}" style="width: 0%"></div>
                    </div>
                </div>
                <div class="info-item">
                    <div class="info-label">Bed Temperature</div>
                    <div class="info-value" id="bed-temp-${printer.id}">-</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Extruder Temperature</div>
                    <div class="info-value" id="extruder-temp-${printer.id}">-</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Print Time</div>
                    <div class="info-value" id="print-time-${printer.id}">-</div>
                </div>
                <div class="info-item">
                    <div class="info-label">ETA</div>
                    <div class="info-value" id="eta-${printer.id}">-</div>
                </div>
            </div>
            <div class="webcam-container">
                <img class="webcam-stream" src="${this.getWebcamUrl(printer.ip)}" alt="Webcam feed" 
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                <div class="webcam-error" style="display: none;">
                    Webcam unavailable
                </div>
            </div>
        `;
        if (printer.disabled) {
            card.classList.add('disabled');
        }
        return card;
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
        
        // Update status indicator and text
        const statusIndicator = document.getElementById(`status-${printer.id}`);
        const statusText = document.getElementById(`status-text-${printer.id}`);
        
        if (statusIndicator && statusText) {
            switch (currentState) {
                case 'printing':
                    statusIndicator.className = 'status-indicator status-printing';
                    statusText.textContent = 'Printing';
                    break;
                case 'complete':
                    statusIndicator.className = 'status-indicator status-complete';
                    statusText.textContent = 'Complete';
                    this.checkForPrintCompletion(printer, currentState);
                    break;
                case 'paused':
                    statusIndicator.className = 'status-indicator status-printing';
                    statusText.textContent = 'Paused';
                    break;
                default:
                    statusIndicator.className = 'status-indicator status-online';
                    statusText.textContent = 'Ready';
            }
        }
    }

    updatePrinterOfflineStatus(printer) {
        const statusIndicator = document.getElementById(`status-${printer.id}`);
        const statusText = document.getElementById(`status-text-${printer.id}`);
        
        if (statusIndicator && statusText) {
            if (printer.disabled) {
                statusIndicator.className = 'status-indicator status-disabled';
                statusText.textContent = 'Disabled';
            } else {
                statusIndicator.className = 'status-indicator status-offline';
                statusText.textContent = 'Offline';
            }
            this.clearPrinterInfo(printer.id);
        }
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

    getWebcamUrl(ip) {
        const host = this.getHostFromIp(ip);
        return `http://${host}:4408/webcam/?action=stream`;
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
            const card = document.getElementById(`status-${printer.id}`)?.closest('.printer-card');
            if (card) {
                card.classList.add('disabled');
            }
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
        } else {
            dashboard.startWebSocketConnections();
        }
    }
});