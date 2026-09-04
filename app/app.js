/**
 * Keyboard Punch — Phone-side App Logic
 * 
 * Connects to the laptop companion via WebSocket over ADB reverse.
 * Sends text for keystroke simulation with configurable WPM speed.
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
        speedSlider: $('speed-slider'),
        speedValue: $('speed-value'),
        estimate: $('estimate'),
        preserveFormatting: $('preserve-formatting'),
        focusDelay: $('focus-delay'),
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

    // ─── Wake Lock (prevent phone screen from sleeping) ──────

    async function acquireWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => {
                    wakeLock = null;
                });
            }
        } catch (e) {
            // Wake Lock not supported or denied — not critical
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

    /**
     * Convert WPM to milliseconds delay between characters.
     * Average word = 5 characters, so:
     * delay_ms = 60000 / (WPM * 5) = 12000 / WPM
     */
    function wpmToDelay(wpm) {
        return Math.round(12000 / wpm);
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

    function getSliderFillPercent(value, min, max) {
        return ((value - min) / (max - min)) * 100;
    }

    // ─── Settings Persistence ────────────────────────────────

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            if (saved.wpm) elements.speedSlider.value = saved.wpm;
            if (saved.preserveFormatting !== undefined) {
                elements.preserveFormatting.checked = saved.preserveFormatting;
            }
            if (saved.focusDelay !== undefined) {
                elements.focusDelay.checked = saved.focusDelay;
            }
        } catch (e) { /* ignore */ }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({
                wpm: parseInt(elements.speedSlider.value),
                preserveFormatting: elements.preserveFormatting.checked,
                focusDelay: elements.focusDelay.checked,
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
        // Remove duplicate if exists
        const idx = history.findIndex(h => h.text === text);
        if (idx !== -1) history.splice(idx, 1);
        // Add to front
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
        // Remove old items
        elements.historyList.querySelectorAll('.history-item').forEach(el => el.remove());

        history.forEach((item, index) => {
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
            showToast('⚡', 'Connected to laptop', 'success');
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
            // onclose will fire after this
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

    // ─── Message Handling ────────────────────────────────────

    function handleMessage(data) {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) {
            return;
        }

        switch (msg.type) {
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
                showToast('■', 'Punching stopped', 'error');
                break;
            case 'pong':
                // Heartbeat response
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

    // ─── Punching Logic ──────────────────────────────────────

    function startPunchFlow() {
        const text = elements.textInput.value;
        if (!text.trim()) {
            showToast('!', 'Enter some text first', 'error');
            return;
        }
        if (!isConnected) {
            showToast('!', 'Not connected to laptop', 'error');
            return;
        }

        if (elements.focusDelay.checked) {
            startCountdown(3, () => sendPunchCommand(text));
        } else {
            sendPunchCommand(text);
        }
    }

    function sendPunchCommand(text) {
        const wpm = parseInt(elements.speedSlider.value);
        const delayMs = wpmToDelay(wpm);

        const success = sendMessage({
            type: 'punch',
            text: text,
            delay_ms: delayMs,
            preserve_formatting: elements.preserveFormatting.checked,
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
        showToast('✓', 'Punching complete!', 'success');

        // Brief success flash on the button
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

        // ETA
        const wpm = parseInt(elements.speedSlider.value);
        const delayMs = wpmToDelay(wpm);
        const remaining = total - current;
        const etaSeconds = (remaining * delayMs) / 1000;
        elements.progressEta.textContent = formatTime(etaSeconds);

        if (percent >= 100) {
            elements.progressLabel.textContent = 'Complete!';
        } else {
            elements.progressLabel.textContent = 'Punching...';
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
    }

    function updateSpeedDisplay() {
        const wpm = parseInt(elements.speedSlider.value);
        const delayMs = wpmToDelay(wpm);

        let label = '';
        if (wpm <= 30) label = 'Slow';
        else if (wpm <= 60) label = 'Moderate';
        else if (wpm <= 120) label = 'Fast';
        else if (wpm <= 180) label = 'Very Fast';
        else label = 'Blazing';

        elements.speedValue.textContent = `${wpm} WPM · ${label}`;

        // Update slider fill
        const percent = getSliderFillPercent(wpm, 10, 250);
        elements.speedSlider.style.setProperty('--fill-percent', `${percent}%`);

        updateEstimate();
        saveSettings();
    }

    function updateEstimate() {
        const text = elements.textInput.value;
        if (!text.trim()) {
            elements.estimate.textContent = '';
            return;
        }
        const wpm = parseInt(elements.speedSlider.value);
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

        // Force reflow for re-animation
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

        // Speed slider
        elements.speedSlider.addEventListener('input', updateSpeedDisplay);

        // Settings toggles
        elements.preserveFormatting.addEventListener('change', saveSettings);
        elements.focusDelay.addEventListener('change', saveSettings);

        // Punch button
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

        // Prevent zoom on double tap (iOS/Android)
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

        // Keyboard shortcut: Ctrl/Cmd+Enter to punch
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!elements.punchBtn.disabled) {
                    startPunchFlow();
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
