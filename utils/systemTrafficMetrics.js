const WINDOW_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DDOS_BURST_THRESHOLD_PER_MINUTE = Number(process.env.DDOS_BURST_THRESHOLD_PER_MINUTE || 120);

const state = {
    events: [],
    ipMinuteCounts: new Map()
};

function nowMs() {
    return Date.now();
}

function cleanIp(ip) {
    return String(ip || 'unknown')
        .split(',')[0]
        .trim()
        .replace(/^::ffff:/, '') || 'unknown';
}

function clientIp(req) {
    return cleanIp(
        req.headers['cf-connecting-ip'] ||
        req.headers['x-real-ip'] ||
        req.headers['x-forwarded-for'] ||
        req.ip ||
        req.socket?.remoteAddress
    );
}

function prune(now = nowMs()) {
    const cutoff = now - WINDOW_MS;
    while (state.events.length && state.events[0].ts < cutoff) {
        state.events.shift();
    }

    const minuteCutoff = Math.floor((now - (5 * MINUTE_MS)) / MINUTE_MS);
    for (const key of state.ipMinuteCounts.keys()) {
        const minute = Number(String(key).split('|').pop() || 0);
        if (minute < minuteCutoff) state.ipMinuteCounts.delete(key);
    }
}

function suspiciousReason(pathname, userAgent) {
    const path = String(pathname || '').toLowerCase();
    const ua = String(userAgent || '').toLowerCase();
    if (/(^|\/)\.env($|[/?#])/.test(path)) return 'env_probe';
    if (/(wp-admin|wp-login|xmlrpc\.php|phpmyadmin|setup\.php|config\.php|\.git\/)/.test(path)) return 'common_probe';
    if (/(sqlmap|nikto|acunetix|nessus|masscan|zgrab|python-requests)/.test(ua)) return 'scanner_user_agent';
    return '';
}

function trackSystemTraffic(req, res, next) {
    const startedAt = nowMs();
    const ip = clientIp(req);
    const minute = Math.floor(startedAt / MINUTE_MS);
    const ipMinuteKey = `${ip}|${minute}`;
    const ipMinuteCount = (state.ipMinuteCounts.get(ipMinuteKey) || 0) + 1;
    state.ipMinuteCounts.set(ipMinuteKey, ipMinuteCount);
    const burstDetected = ipMinuteCount > DDOS_BURST_THRESHOLD_PER_MINUTE;
    const probeReason = suspiciousReason(req.path || req.originalUrl, req.headers['user-agent']);

    res.on('finish', () => {
        const contentLength = Number(res.getHeader('content-length') || 0);
        state.events.push({
            ts: startedAt,
            ip,
            method: req.method,
            path: req.path || req.originalUrl || '/',
            status: Number(res.statusCode || 0),
            duration_ms: Math.max(0, nowMs() - startedAt),
            bytes: Number.isFinite(contentLength) ? contentLength : 0,
            ddos_signal: burstDetected,
            suspicious: !!(burstDetected || probeReason),
            reason: burstDetected ? 'rate_burst' : probeReason
        });
        prune();
    });

    return next();
}

function getSystemTrafficMetrics() {
    const now = nowMs();
    prune(now);
    const oneMinuteAgo = now - MINUTE_MS;
    const events = state.events.filter(e => e.ts >= now - WINDOW_MS);
    const minuteEvents = events.filter(e => e.ts >= oneMinuteAgo);
    const minuteBuckets = new Map();
    events.forEach(e => {
        const bucket = Math.floor(e.ts / MINUTE_MS);
        minuteBuckets.set(bucket, (minuteBuckets.get(bucket) || 0) + 1);
    });

    const ddosAttempts = events.filter(e => e.ddos_signal).length;
    const suspiciousRequests = events.filter(e => e.suspicious).length;
    const failedRequests = events.filter(e => e.status >= 400).length;
    const uniqueClients = new Set(events.map(e => e.ip)).size;
    const peakRequestsPerMinute = Math.max(0, ...minuteBuckets.values());
    const trafficBytes = events.reduce((sum, e) => sum + (Number(e.bytes) || 0), 0);
    const status = ddosAttempts > 0 || suspiciousRequests >= 10 || failedRequests >= 50 ? 'Watch' : 'Healthy';

    return {
        requests_last_hour: events.length,
        requests_last_minute: minuteEvents.length,
        peak_requests_per_minute: peakRequestsPerMinute,
        traffic_bytes_last_hour: trafficBytes,
        ddos_attempts: ddosAttempts,
        suspicious_requests: suspiciousRequests,
        failed_requests: failedRequests,
        unique_clients: uniqueClients,
        security_status: status,
        threshold_per_ip_per_minute: DDOS_BURST_THRESHOLD_PER_MINUTE
    };
}

module.exports = {
    trackSystemTraffic,
    getSystemTrafficMetrics
};
