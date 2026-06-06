// QR Scanner logic
(function () {
    const recentScans = [];
    const scannedIds = new Set(); // prevent duplicates in session
    let html5QrCode = null;

    function initScanner() {
        const readerEl = document.getElementById('qrReader');
        if (!readerEl || typeof Html5Qrcode === 'undefined') return;

        html5QrCode = new Html5Qrcode('qrReader');
        html5QrCode.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            onScanSuccess,
            () => {} // ignore scan errors (no QR in frame)
        ).catch(err => {
            console.warn('Camera not available:', err);
            readerEl.innerHTML = '<p style="padding:2rem;color:#6b7280;">Camera not available. Use manual entry below.</p>';
        });
    }

    function normalizeScanInput(value) {
        const cleaned = String(value || '')
            .replace(/^\uFEFF/, '')
            .replace(/[\u0000-\u001F\u007F]/g, '')
            .trim()
            .replace(/^["']|["']$/g, '')
            .trim();

        try {
            const parsed = new URL(cleaned);
            return parsed.searchParams.get('qr_code')
                || parsed.searchParams.get('qr')
                || parsed.searchParams.get('code')
                || parsed.searchParams.get('q')
                || decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || cleaned);
        } catch (_err) {
            return cleaned;
        }
    }

    async function onScanSuccess(decodedText) {
        const code = normalizeScanInput(decodedText);
        if (scannedIds.has(code)) {
            showResult('This code was already scanned in this session.', 'warning', code);
            return;
        }
        await submitScan(code);
    }

    async function submitScan(code) {
        code = normalizeScanInput(code);
        if (!code) return;
        const resultEl = document.getElementById('scanResult');
        resultEl.innerHTML = '<p>Processing...</p>';
        resultEl.className = 'scan-result';

        try {
            const res = await fetch('/api/scan-attendance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ qr_code: code })
            });
            const data = await res.json();

            if (data.success) {
                scannedIds.add(code);
                showResult(data.message, 'success', code, data.person, data.action, data.time);
                addRecentScan(data.person?.name || code, data.action, data.time);
            } else {
                showResult(data.message || 'Scan failed.', 'error', code);
            }
        } catch (err) {
            showResult('Network error. Please check your connection.', 'error', code);
        }
    }

    function displayTime(time) {
        if (!time) return new Date().toLocaleTimeString();
        if (/\bAM\b|\bPM\b/i.test(String(time))) return String(time);
        const parsed = new Date(time);
        return Number.isNaN(parsed.getTime()) ? String(time) : parsed.toLocaleTimeString();
    }

    function showResult(message, type, code, person, action, time) {
        const resultEl = document.getElementById('scanResult');
        resultEl.className = 'scan-result ' + type;

        if (type === 'success' && person) {
            const actionText = action === 'time_in' ? 'Timed In' : action === 'time_out' ? 'Timed Out' : 'Complete';
            resultEl.innerHTML =
                '<p class="scan-name">' + person.name + '</p>' +
                '<p class="scan-action">' + actionText + '</p>' +
                (time ? '<p style="color:#6b7280;font-size:0.875rem">' + displayTime(time) + '</p>' : '');
        } else {
            resultEl.innerHTML = '<p>' + message + '</p>';
        }
    }

    function addRecentScan(name, action, time) {
        recentScans.unshift({ name, action, time: displayTime(time) });
        if (recentScans.length > 20) recentScans.pop();
        renderRecentScans();
    }

    function renderRecentScans() {
        const container = document.getElementById('recentScans');
        if (!container) return;
        container.innerHTML = recentScans.map(s => {
            const actionText = s.action === 'time_in' ? 'IN' : s.action === 'time_out' ? 'OUT' : 'DONE';
            return '<div class="recent-scan-item"><span>' + s.name + ' - ' + actionText + '</span><span>' + displayTime(s.time) + '</span></div>';
        }).join('');
    }

    // Manual entry form
    const manualForm = document.getElementById('manualScanForm');
    if (manualForm) {
        manualForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = document.getElementById('manualCode');
            const code = input.value.trim();
            if (!code) return;
            await submitScan(code);
            input.value = '';
            input.focus();
        });
    }

    // Initialize camera scanner
    initScanner();
})();
