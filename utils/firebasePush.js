const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const db = require('../config/database');

let messagingInstance;
let initializationAttempted = false;

function firebaseMessaging() {
    if (initializationAttempted) return messagingInstance;
    initializationAttempted = true;

    const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
    if (!raw) {
        console.warn('FCM disabled: FIREBASE_SERVICE_ACCOUNT is not set.');
        return undefined;
    }

    try {
        const serviceAccount = JSON.parse(raw);
        if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
            throw new Error('service account JSON is missing project_id, client_email, or private_key');
        }
        const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
        messagingInstance = getMessaging(app);
        console.log(`FCM enabled for Firebase project ${serviceAccount.project_id}.`);
    } catch (error) {
        console.error('FCM disabled: FIREBASE_SERVICE_ACCOUNT is invalid:', error.message);
    }
    return messagingInstance;
}

function stringifyData(data = {}) {
    return Object.fromEntries(
        Object.entries(data)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => [key, String(value)])
    );
}

function isDeadTokenError(code) {
    return code === 'messaging/registration-token-not-registered'
        || code === 'messaging/invalid-registration-token';
}

async function sendMulticast(tokens, payload) {
    const messaging = firebaseMessaging();
    const uniqueTokens = [...new Set(tokens.map(token => String(token || '').trim()).filter(Boolean))];
    if (!messaging || !uniqueTokens.length) return { successCount: 0, failureCount: 0, invalidTokens: [] };

    let successCount = 0;
    let failureCount = 0;
    const invalidTokens = [];
    for (let offset = 0; offset < uniqueTokens.length; offset += 500) {
        const batch = uniqueTokens.slice(offset, offset + 500);
        const response = await messaging.sendEachForMulticast({
            tokens: batch,
            notification: { title: payload.title, body: payload.body },
            data: stringifyData(payload.data),
            android: {
                priority: 'high',
                // If a phone is offline, keep only the newest Guardian update
                // and expire it quickly instead of replaying notification history.
                collapseKey: payload.collapseKey || 'edutrack_parent_latest',
                ttl: Number(payload.ttlMs || 5 * 60 * 1000),
                notification: {
                    channelId: payload.channelId || 'edutrack_parent',
                    tag: payload.tag || 'edutrack_parent_latest',
                    sound: 'default',
                    defaultSound: true,
                    priority: 'high'
                }
            }
        });
        successCount += response.successCount;
        failureCount += response.failureCount;
        response.responses.forEach((item, index) => {
            if (!item.success && isDeadTokenError(item.error && item.error.code)) invalidTokens.push(batch[index]);
        });
    }
    return { successCount, failureCount, invalidTokens };
}

async function sendPushToParent(parentId, notification) {
    const [devices] = await db.query(
        `SELECT push_token FROM parent_devices
         WHERE parent_id = ? AND push_token IS NOT NULL AND push_token <> ''`,
        [parentId]
    );
    const result = await sendMulticast(devices.map(device => device.push_token), {
        title: notification.title,
        body: notification.message,
        channelId: 'edutrack_parent',
        collapseKey: 'edutrack_parent_latest',
        tag: 'edutrack_parent_latest',
        ttlMs: 5 * 60 * 1000,
        data: {
            type: notification.type || 'announcement_general',
            title: notification.title,
            body: notification.message,
            notification_id: notification.notificationId,
            student_id: notification.studentId
        }
    });
    if (result.invalidTokens.length) {
        await db.query('DELETE FROM parent_devices WHERE push_token IN (?)', [result.invalidTokens]);
    }
    return result;
}

async function sendPushToParents(parentIds, notification) {
    const uniqueParentIds = [...new Set(
        (parentIds || []).map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0)
    )];
    if (!uniqueParentIds.length) {
        return { successCount: 0, failureCount: 0, invalidTokens: [], registeredDeviceCount: 0 };
    }
    const [devices] = await db.query(
        `SELECT DISTINCT push_token FROM parent_devices
         WHERE parent_id IN (?) AND push_token IS NOT NULL AND push_token <> ''`,
        [uniqueParentIds]
    );
    const tokens = devices.map(device => device.push_token);
    const result = await sendMulticast(tokens, {
        title: notification.title,
        body: notification.message,
        channelId: 'edutrack_parent',
        collapseKey: 'edutrack_parent_latest',
        tag: 'edutrack_parent_latest',
        ttlMs: 5 * 60 * 1000,
        data: {
            type: notification.type || 'announcement_general',
            title: notification.title,
            body: notification.message,
            notification_id: notification.notificationId
        }
    });
    if (result.invalidTokens.length) {
        await db.query('DELETE FROM parent_devices WHERE push_token IN (?)', [result.invalidTokens]);
    }
    return { ...result, registeredDeviceCount: tokens.length };
}

async function sendPushToUsers({ schoolId = null } = {}, notification) {
    const params = [];
    let scope = '';
    if (schoolId) {
        scope = `AND (u.school_id = ? OR u.role IN ('super_admin','superintendent','asst_superintendent'))`;
        params.push(schoolId);
    }
    const [devices] = await db.query(
        `SELECT DISTINCT ud.push_token
         FROM user_devices ud
         INNER JOIN users u ON u.id = ud.user_id
         WHERE u.status = 'active'
           AND ud.push_token IS NOT NULL
           AND ud.push_token <> ''
           ${scope}`,
        params
    );
    const tokens = devices.map(device => device.push_token);
    const result = await sendMulticast(tokens, {
        title: notification.title,
        body: notification.message,
        channelId: 'edutrack_alerts',
        collapseKey: 'edutrack_holiday_latest',
        tag: 'edutrack_holiday_latest',
        ttlMs: 60 * 60 * 1000,
        data: {
            type: notification.type || 'announcement_holiday',
            title: notification.title,
            body: notification.message,
            holiday_id: notification.holidayId,
            holiday_date: notification.holidayDate,
            school_id: schoolId
        }
    });
    if (result.invalidTokens.length) {
        await db.query('DELETE FROM user_devices WHERE push_token IN (?)', [result.invalidTokens]);
    }
    return { ...result, registeredDeviceCount: tokens.length };
}

function firebasePushStatus() {
    return {
        configured: Boolean(String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim()),
        initialized: Boolean(firebaseMessaging())
    };
}

module.exports = {
    firebasePushStatus,
    sendMulticast,
    sendPushToParent,
    sendPushToParents,
    sendPushToUsers
};
