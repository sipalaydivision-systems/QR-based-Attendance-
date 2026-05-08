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

    async function onScanSuccess(decodedText) {
        if (scannedIds.has(decodedText)) {
            showResult('This code was already scanned in this session.', 'warning', decodedText);
            return;
        }
        await submitScan(decodedText);
    }

    async function submitScan(code) {
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

    function showResult(message, type, code, person, action, time) {
        const resultEl = document.getElementById('scanResult');
        resultEl.className = 'scan-result ' + type;

        if (type === 'success' && person) {
            const actionText = action === 'time_in' ? 'Timed In' : action === 'time_out' ? 'Timed Out' : 'Complete';
            resultEl.innerHTML =
                '<p class="scan-name">' + person.name + '</p>' +
                '<p class="scan-action">' + actionText + '</p>' +
                (time ? '<p style="color:#6b7280;font-size:0.875rem">' + new Date(time).toLocaleTimeString() + '</p>' : '');
        } else {
            resultEl.innerHTML = '<p>' + message + '</p>';
        }
    }

    function addRecentScan(name, action, time) {
        recentScans.unshift({ name, action, time: time || new Date().toISOString() });
        if (recentScans.length > 20) recentScans.pop();
        renderRecentScans();
    }

    function renderRecentScans() {
        const container = document.getElementById('recentScans');
        if (!container) return;
        container.innerHTML = recentScans.map(s => {
            const actionText = s.action === 'time_in' ? 'IN' : s.action === 'time_out' ? 'OUT' : 'DONE';
            return '<div class="recent-scan-item"><span>' + s.name + ' — ' + actionText + '</span><span>' + new Date(s.time).toLocaleTimeString() + '</span></div>';
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
