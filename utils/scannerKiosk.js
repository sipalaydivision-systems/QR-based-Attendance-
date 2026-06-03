const crypto = require('crypto');

function getScannerKioskToken() {
    const secret = process.env.SCANNER_KIOSK_SECRET || process.env.SESSION_SECRET || 'qr-attendance-secret-key';
    return crypto
        .createHmac('sha256', secret)
        .update('edutrack-scanner-kiosk-v1')
        .digest('hex');
}

function getScannerKioskTokenFromRequest(req) {
    return (
        req.get('x-scanner-kiosk-token') ||
        req.query.kiosk ||
        req.query.scanner_key ||
        (req.body && (req.body.scanner_kiosk_token || req.body.kiosk)) ||
        ''
    );
}

function isValidScannerKioskToken(value) {
    const token = String(value || '').trim();
    const expected = getScannerKioskToken();
    if (!token || token.length !== expected.length) return false;

    try {
        return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    } catch (_err) {
        return false;
    }
}

module.exports = {
    getScannerKioskToken,
    getScannerKioskTokenFromRequest,
    isValidScannerKioskToken
};
