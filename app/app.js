/**
 * Keyboard Punch — Phone-side & Desktop App Logic
 * 
 * Connects to the laptop companion via WebSocket over ADB reverse or local network.
 * Supports cross-device code synchronization, configurable WPM speed input,
 * and customizable focus delay countdown.
 */

(function () {
    'use strict';

    // ─── Constants ───────────────────────────────────────────
    const WS_URL = `ws://${location.hostname || 'localhost'}:8765`;
    const RECONNECT_INTERVAL = 3000;
    const MAX_HISTORY = 10;
    const HISTORY_KEY = 'keyboard_punch_history';
    const SETTINGS_KEY = 'keyboard_punch_settings';

    // ─── DOM Elements ────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    const elements = {
        ambientGlow: $('ambient-glow'),
        connectionBadge: $('connection-badge'),
        connectionDot: $('connection-dot'),
        connectionText: $('connection-text'),
        textInput: $('text-input'),
        textareaWrapper: $('textarea-wrapper'),
        charCount: $('char-count'),
        clearBtn: $('clear-btn'),
        speedInput: $('speed-input'),
        speedTag: $('speed-tag'),
        speedMinus: $('speed-minus'),
        speedPlus: $('speed-plus'),
        speedPresets: $('speed-presets'),
        delayInput: $('delay-input'),
        delayMinus: $('delay-minus'),
        delayPlus: $('delay-plus'),
        estimate: $('estimate'),
        preserveFormatting: $('preserve-formatting'),
        pasteMode: $('paste-mode'),
        progressSection: $('progress-section'),
        progressLabel: $('progress-label'),
        progressPercent: $('progress-percent'),
        progressBarFill: $('progress-bar-fill'),
        progressBarGlow: $('progress-bar-glow'),
        progressChars: $('progress-chars'),
        progressEta: $('progress-eta'),
        punchBtn: $('punch-btn'),
        punchBtnContent: $('punch-btn-content'),
        punchBtnLoading: $('punch-btn-loading'),
        updateBtn: $('update-btn'),
        stopBtn: $('stop-btn'),
        historyList: $('history-list'),
        historyEmpty: $('history-empty'),
        clearHistoryBtn: $('clear-history-btn'),
        countdownOverlay: $('countdown-overlay'),
        countdownNumber: $('countdown-number'),
        countdownCancel: $('countdown-cancel'),
        toast: $('toast'),
        toastIcon: $('toast-icon'),
        toastMessage: $('toast-message'),
    };

    // ─── State ───────────────────────────────────────────────
    let ws = null;
    let isConnected = false;
    let isPunching = false;
    let countdownTimer = null;
    let reconnectTimer = null;
    let toastTimer = null;
    let wakeLock = null;

    // ─── Wake Lock (prevent screen sleep while typing) ───────

    async function acquireWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => {
                    wakeLock = null;
                });
            }
        } catch (e) {
            // Wake Lock not supported or denied
        }
    }

    async function releaseWakeLock() {
        try {
            if (wakeLock) {
                await wakeLock.release();
                wakeLock = null;
            }
        } catch (e) { /* ignore */ }
    }

    // ─── Utility Functions ───────────────────────────────────

    function getSpeed() {
        const val = parseInt(elements.speedInput.value, 10);
        if (isNaN(val) || val < 10) return 10;
        if (val > 500) return 500;
        return val;
    }

    function getDelay() {
        const val = parseInt(elements.delayInput.value, 10);
        if (isNaN(val) || val < 0) return 0;
        if (val > 60) return 60;
        return val;
    }

    /**
     * Convert WPM to milliseconds delay between characters.
     * Average word = 5 characters, so:
     * delay_ms = 60000 / (WPM * 5) = 12000 / WPM
     */
    function wpmToDelay(wpm) {
        return Math.max(1, Math.round(12000 / wpm));
    }

    function countWords(text) {
        return text.trim() ? text.trim().split(/\s+/).length : 0;
    }

    function formatTime(seconds) {
        if (seconds < 60) return `~${Math.ceil(seconds)}s`;
        const mins = Math.floor(seconds / 60);
        const secs = Math.ceil(seconds % 60);
        return `~${mins}m ${secs}s`;
    }

    // ─── Settings Persistence ────────────────────────────────

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            if (saved.wpm) {
                elements.speedInput.value = saved.wpm;
            }
            if (saved.focusDelay !== undefined) {
                elements.delayInput.value = saved.focusDelay;
            }
            if (saved.preserveFormatting !== undefined) {
                elements.preserveFormatting.checked = saved.preserveFormatting;
            }
            if (saved.pasteMode !== undefined) {
                elements.pasteMode.checked = saved.pasteMode;
            }
        } catch (e) { /* ignore */ }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({
                wpm: getSpeed(),
                focusDelay: getDelay(),
                preserveFormatting: elements.preserveFormatting.checked,
                pasteMode: elements.pasteMode.checked,
            }));
        } catch (e) { /* ignore */ }
    }

    // ─── History ─────────────────────────────────────────────

    function loadHistory() {
        try {
            return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    function saveHistory(history) {
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
        } catch (e) { /* ignore */ }
    }

    function addToHistory(text) {
        if (!text.trim()) return;
        const history = loadHistory();
        const idx = history.findIndex(h => h.text === text);
        if (idx !== -1) history.splice(idx, 1);
        history.unshift({
            text: text,
            chars: text.length,
            time: new Date().toISOString(),
        });
        saveHistory(history);
        renderHistory();
    }

    function renderHistory() {
        const history = loadHistory();
        if (history.length === 0) {
            elements.historyEmpty.classList.remove('hidden');
            elements.historyList.querySelectorAll('.history-item').forEach(el => el.remove());
            return;
        }

        elements.historyEmpty.classList.add('hidden');
        elements.historyList.querySelectorAll('.history-item').forEach(el => el.remove());

        history.forEach((item) => {
            const el = document.createElement('div');
            el.className = 'history-item';
            el.setAttribute('role', 'button');
            el.setAttribute('tabindex', '0');

            const preview = item.text.replace(/\n/g, '↵ ').replace(/\t/g, '→ ');
            const timeAgo = getTimeAgo(new Date(item.time));

            el.innerHTML = `
                <span class="history-item-text">${escapeHtml(preview)}</span>
                <span class="history-item-meta">${item.chars} chars<br>${timeAgo}</span>
            `;

            el.addEventListener('click', () => {
                elements.textInput.value = item.text;
                updateCharCount();
                updateTextareaState();
                showToast('✓', 'Loaded from history', 'success');
            });

            elements.historyList.appendChild(el);
        });
    }

    function getTimeAgo(date) {
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ─── WebSocket Connection ────────────────────────────────

    function connect() {
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
            return;
        }

        try {
            ws = new WebSocket(WS_URL);
        } catch (e) {
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            isConnected = true;
            updateConnectionUI(true);
            clearTimeout(reconnectTimer);
            showToast('⚡', 'Connected to laptop companion', 'success');
        };

        ws.onclose = () => {
            isConnected = false;
            updateConnectionUI(false);
            if (isPunching) {
                stopPunching('Connection lost');
            }
            scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose will trigger next
        };

        ws.onmessage = (event) => {
            handleMessage(event.data);
        };
    }

    function scheduleReconnect() {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL);
    }

    function updateConnectionUI(connected) {
        elements.connectionDot.classList.toggle('connected', connected);
        elements.connectionBadge.classList.toggle('connected', connected);
        elements.connectionText.textContent = connected ? 'Connected' : 'Offline';
        elements.ambientGlow.classList.toggle('connected', connected);
        updatePunchButtonState();
    }

    // ─── Message Handling & Synchronization ──────────────────

    function handleMessage(data) {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) {
            return;
        }

        switch (msg.type) {
            case 'sync_state':
                if (msg.state) {
                    // When connecting, sync existing code if current text area is empty
                    if (msg.state.text && !elements.textInput.value.trim()) {
                        elements.textInput.value = msg.state.text;
                        updateCharCount();
                        updateTextareaState();
                    }
                    if (msg.state.wpm) {
                        elements.speedInput.value = msg.state.wpm;
                        updateSpeedDisplay();
                    }
                    if (msg.state.focus_delay_sec !== undefined) {
                        elements.delayInput.value = msg.state.focus_delay_sec;
                    }
                    if (msg.state.preserve_formatting !== undefined) {
                        elements.preserveFormatting.checked = msg.state.preserve_formatting;
                    }
                    if (msg.state.paste_mode !== undefined) {
                        elements.pasteMode.checked = msg.state.paste_mode;
                    }
                }
                break;

            case 'code_updated':
                // Received an update from another connected device (Mac or Phone)
                if (msg.text !== undefined) {
                    elements.textInput.value = msg.text;
                    updateCharCount();
                    updateTextareaState();
                    flashSyncHighlight();
                    showToast('🔄', 'Code updated from device', 'success');
                }
                if (msg.wpm) {
                    elements.speedInput.value = msg.wpm;
                    updateSpeedDisplay();
                }
                if (msg.focus_delay_sec !== undefined) {
                    elements.delayInput.value = msg.focus_delay_sec;
                }
                if (msg.preserve_formatting !== undefined) {
                    elements.preserveFormatting.checked = msg.preserve_formatting;
                }
                if (msg.paste_mode !== undefined) {
                    elements.pasteMode.checked = msg.paste_mode;
                }
                break;

            case 'progress':
                updateProgress(msg.current, msg.total);
                break;

            case 'complete':
                completePunching();
                break;

            case 'error':
                stopPunching(msg.message || 'An error occurred');
                showToast('✕', msg.message || 'Error', 'error');
                break;

            case 'stopped':
                stopPunching('Stopped');
                showToast('■', 'Typing stopped', 'error');
                break;

            case 'pong':
                break;
        }
    }

    function sendMessage(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
            return true;
        }
        return false;
    }

    function flashSyncHighlight() {
        elements.textareaWrapper.classList.remove('synced-highlight');
        void elements.textareaWrapper.offsetWidth; // Force re-render
        elements.textareaWrapper.classList.add('synced-highlight');
        setTimeout(() => {
            elements.textareaWrapper.classList.remove('synced-highlight');
        }, 1500);
    }

    // ─── Code Update / Sync Action ───────────────────────────

    function sendUpdateCode() {
        const text = elements.textInput.value;
        const wpm = getSpeed();
        const delaySec = getDelay();
        const preserve = elements.preserveFormatting.checked;
        const paste = elements.pasteMode.checked;

        if (!isConnected) {
            showToast('!', 'Not connected to laptop companion', 'error');
            return;
        }

        const sent = sendMessage({
            type: 'update_code',
            text: text,
            wpm: wpm,
            focus_delay_sec: delaySec,
            preserve_formatting: preserve,
            paste_mode: paste
        });

        if (sent) {
            elements.updateBtn.classList.add('updated-pulse');
            setTimeout(() => elements.updateBtn.classList.remove('updated-pulse'), 700);
            showToast('✓', 'Code synced to all devices', 'success');
        } else {
            showToast('✕', 'Failed to sync code', 'error');
        }
    }

    // ─── Punching / Typing Logic ─────────────────────────────

    function startPunchFlow() {
        const text = elements.textInput.value;
        if (!text.trim()) {
            showToast('!', 'Enter or paste some code first', 'error');
            return;
        }
        if (!isConnected) {
            showToast('!', 'Not connected to laptop companion', 'error');
            return;
        }

        const delaySec = getDelay();
        if (delaySec > 0) {
            startCountdown(delaySec, () => sendPunchCommand(text));
        } else {
            sendPunchCommand(text);
        }
    }

    function sendPunchCommand(text) {
        const wpm = getSpeed();
        const delayMs = wpmToDelay(wpm);

        const success = sendMessage({
            type: 'punch',
            text: text,
            delay_ms: delayMs,
            preserve_formatting: elements.preserveFormatting.checked,
            paste_mode: elements.pasteMode.checked,
            wpm: wpm,
        });

        if (success) {
            isPunching = true;
            addToHistory(text);
            showPunchingUI(text.length);
            elements.ambientGlow.classList.add('punching');
            acquireWakeLock();
        } else {
            showToast('!', 'Failed to send — check connection', 'error');
        }
    }

    function stopPunchingRequest() {
        sendMessage({ type: 'stop' });
    }

    function stopPunching(reason) {
        isPunching = false;
        hidePunchingUI();
        elements.ambientGlow.classList.remove('punching');
        releaseWakeLock();
    }

    function completePunching() {
        isPunching = false;
        hidePunchingUI();
        elements.ambientGlow.classList.remove('punching');
        releaseWakeLock();
        showToast('✓', 'Typing complete!', 'success');

        elements.punchBtn.style.background = 'linear-gradient(135deg, #00cec9, #55efc4)';
        setTimeout(() => {
            elements.punchBtn.style.background = '';
        }, 1200);
    }

    // ─── UI Updates ──────────────────────────────────────────

    function showPunchingUI(totalChars) {
        elements.progressSection.classList.remove('hidden');
        elements.punchBtnContent.classList.add('hidden');
        elements.punchBtnLoading.classList.remove('hidden');
        elements.punchBtn.disabled = true;
        elements.updateBtn.disabled = true;
        elements.stopBtn.classList.remove('hidden');
        elements.textInput.disabled = true;
        elements.textInput.style.opacity = '0.5';
        updateProgress(0, totalChars);
    }

    function hidePunchingUI() {
        elements.progressSection.classList.add('hidden');
        elements.punchBtnContent.classList.remove('hidden');
        elements.punchBtnLoading.classList.add('hidden');
        elements.stopBtn.classList.add('hidden');
        elements.textInput.disabled = false;
        elements.textInput.style.opacity = '';
        updatePunchButtonState();
    }

    function updateProgress(current, total) {
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        elements.progressPercent.textContent = `${percent}%`;
        elements.progressBarFill.style.width = `${percent}%`;
        elements.progressBarGlow.style.left = `calc(${percent}% - 30px)`;
        elements.progressChars.textContent = `${current} / ${total} chars`;

        const wpm = getSpeed();
        const delayMs = wpmToDelay(wpm);
        const remaining = total - current;
        const etaSeconds = (remaining * delayMs) / 1000;
        elements.progressEta.textContent = formatTime(etaSeconds);

        if (percent >= 100) {
            elements.progressLabel.textContent = 'Complete!';
        } else {
            elements.progressLabel.textContent = 'Typing...';
        }
    }

    function updateCharCount() {
        const text = elements.textInput.value;
        const chars = text.length;
        const words = countWords(text);
        elements.charCount.textContent = `${chars} char${chars !== 1 ? 's' : ''} · ${words} word${words !== 1 ? 's' : ''}`;
        updateEstimate();
        updatePunchButtonState();
    }

    function updateTextareaState() {
        const hasText = elements.textInput.value.length > 0;
        elements.textareaWrapper.classList.toggle('has-text', hasText);
    }

    function updatePunchButtonState() {
        const hasText = elements.textInput.value.trim().length > 0;
        elements.punchBtn.disabled = !hasText || !isConnected || isPunching;
        elements.updateBtn.disabled = !isConnected || isPunching;
    }

    function updateSpeedDisplay() {
        const wpm = getSpeed();

        let label = '';
        if (wpm <= 30) label = 'Slow';
        else if (wpm <= 60) label = 'Moderate';
        else if (wpm <= 120) label = 'Fast';
        else if (wpm <= 180) label = 'Very Fast';
        else label = 'Blazing';

        elements.speedTag.textContent = `${wpm} WPM · ${label}`;

        // Update active preset button
        if (elements.speedPresets) {
            elements.speedPresets.querySelectorAll('.preset-btn').forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.speed, 10) === wpm);
            });
        }

        updateEstimate();
        saveSettings();
    }

    function updateEstimate() {
        const text = elements.textInput.value;
        if (!text.trim()) {
            elements.estimate.textContent = '';
            return;
        }
        if (elements.pasteMode && elements.pasteMode.checked) {
            elements.estimate.textContent = 'Estimated time: Instant (Clipboard)';
            return;
        }
        const wpm = getSpeed();
        const delayMs = wpmToDelay(wpm);
        const totalMs = text.length * delayMs;
        const seconds = totalMs / 1000;
        elements.estimate.textContent = `Estimated time: ${formatTime(seconds)}`;
    }

    // ─── Countdown ───────────────────────────────────────────

    function startCountdown(seconds, callback) {
        let remaining = seconds;
        elements.countdownOverlay.classList.remove('hidden');
        elements.countdownNumber.textContent = remaining;

        countdownTimer = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(countdownTimer);
                countdownTimer = null;
                elements.countdownOverlay.classList.add('hidden');
                callback();
            } else {
                elements.countdownNumber.textContent = remaining;
            }
        }, 1000);
    }

    function cancelCountdown() {
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        elements.countdownOverlay.classList.add('hidden');
    }

    // ─── Toast ───────────────────────────────────────────────

    function showToast(icon, message, type = '') {
        clearTimeout(toastTimer);
        elements.toastIcon.textContent = icon;
        elements.toastMessage.textContent = message;
        elements.toast.className = `toast ${type}`;

        void elements.toast.offsetWidth;
        elements.toast.classList.add('show');

        toastTimer = setTimeout(() => {
            elements.toast.classList.remove('show');
        }, 3000);
    }

    // ─── Event Listeners ─────────────────────────────────────

    function initEventListeners() {
        // Text input
        elements.textInput.addEventListener('input', () => {
            updateCharCount();
            updateTextareaState();
        });

        // Clear text
        elements.clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            elements.textInput.value = '';
            updateCharCount();
            updateTextareaState();
            elements.textInput.focus();
        });

        // Speed Input & Steppers
        elements.speedInput.addEventListener('input', updateSpeedDisplay);
        elements.speedInput.addEventListener('change', () => {
            elements.speedInput.value = getSpeed();
            updateSpeedDisplay();
        });

        elements.speedMinus.addEventListener('click', () => {
            elements.speedInput.value = Math.max(10, getSpeed() - 5);
            updateSpeedDisplay();
        });

        elements.speedPlus.addEventListener('click', () => {
            elements.speedInput.value = Math.min(500, getSpeed() + 5);
            updateSpeedDisplay();
        });

        // Speed Presets
        if (elements.speedPresets) {
            elements.speedPresets.addEventListener('click', (e) => {
                const btn = e.target.closest('.preset-btn');
                if (btn && btn.dataset.speed) {
                    elements.speedInput.value = btn.dataset.speed;
                    updateSpeedDisplay();
                }
            });
        }

        // Delay Input & Steppers
        elements.delayInput.addEventListener('input', saveSettings);
        elements.delayInput.addEventListener('change', () => {
            elements.delayInput.value = getDelay();
            saveSettings();
        });

        elements.delayMinus.addEventListener('click', () => {
            elements.delayInput.value = Math.max(0, getDelay() - 1);
            saveSettings();
        });

        elements.delayPlus.addEventListener('click', () => {
            elements.delayInput.value = Math.min(60, getDelay() + 1);
            saveSettings();
        });

        // Settings toggles
        elements.preserveFormatting.addEventListener('change', saveSettings);
        if (elements.pasteMode) {
            elements.pasteMode.addEventListener('change', () => {
                saveSettings();
                updateEstimate();
            });
        }

        // Update button (sync code across devices)
        elements.updateBtn.addEventListener('click', sendUpdateCode);

        // Punch / Start Typing button
        elements.punchBtn.addEventListener('click', startPunchFlow);

        // Stop button
        elements.stopBtn.addEventListener('click', stopPunchingRequest);

        // Countdown cancel
        elements.countdownCancel.addEventListener('click', cancelCountdown);

        // Clear history
        elements.clearHistoryBtn.addEventListener('click', () => {
            localStorage.removeItem(HISTORY_KEY);
            renderHistory();
            showToast('✓', 'History cleared', 'success');
        });

        // Handle visibility change (reconnect when app comes to foreground)
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && !isConnected) {
                connect();
            }
        });

        // Prevent zoom on double tap
        let lastTouchEnd = 0;
        document.addEventListener('touchend', (e) => {
            const now = Date.now();
            if (now - lastTouchEnd <= 300) {
                e.preventDefault();
            }
            lastTouchEnd = now;
        }, { passive: false });
    }

    // ─── Initialization ──────────────────────────────────────

    function init() {
        loadSettings();
        updateSpeedDisplay();
        updateCharCount();
        updateTextareaState();
        renderHistory();
        initEventListeners();
        connect();

        // Keyboard shortcut: Ctrl/Cmd+Enter to punch, Ctrl/Cmd+S to update
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!elements.punchBtn.disabled) {
                    startPunchFlow();
                }
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                if (!elements.updateBtn.disabled) {
                    sendUpdateCode();
                }
            }
        });
    }

    // Start the app
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
