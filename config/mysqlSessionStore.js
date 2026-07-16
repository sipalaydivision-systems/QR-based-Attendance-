const session = require('express-session');
const db = require('./database');
const {
    SESSION_MAX_AGE_MS,
    SESSION_TOUCH_INTERVAL_MS,
    SESSION_CACHE_TTL_MS
} = require('./session');

class MySQLSessionStore extends session.Store {
    constructor() {
        super();
        this.cache = new Map();
        this.lastTouches = new Map();
        this.cacheTtlMs = SESSION_CACHE_TTL_MS;
        this.touchIntervalMs = SESSION_TOUCH_INTERVAL_MS;
        this.maxCacheEntries = 25000;
        this.ready = this.ensureTable();
        this.cleanupTimer = setInterval(() => {
            this.clearExpired(() => {});
        }, 15 * 60 * 1000);
        this.cleanupTimer.unref?.();
    }

    async ensureTable() {
        await db.query(`
            CREATE TABLE IF NOT EXISTS app_sessions (
                sid VARCHAR(128) PRIMARY KEY,
                data JSON NOT NULL,
                expires_at BIGINT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_app_sessions_expires_at (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    }

    get(sid, callback) {
        const now = Date.now();
        const cached = this.cache.get(sid);
        if (cached && cached.expiresAt > now && now - cached.cachedAt < this.cacheTtlMs) {
            try {
                return callback(null, JSON.parse(cached.serialized));
            } catch (_) {
                this.cache.delete(sid);
            }
        }
        this.ready
            .then(async () => {
                const [rows] = await db.query(
                    'SELECT data FROM app_sessions WHERE sid = ? AND expires_at > ?',
                    [sid, Date.now()]
                );
                if (!rows.length) return callback(null, null);
                const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
                const expiresAt = data?.cookie?.expires
                    ? new Date(data.cookie.expires).getTime()
                    : now + SESSION_MAX_AGE_MS;
                this.remember(sid, data, expiresAt);
                return callback(null, data);
            })
            .catch(callback);
    }

    set(sid, sess, callback) {
        const expiresAt = sess.cookie && sess.cookie.expires
            ? new Date(sess.cookie.expires).getTime()
            : Date.now() + SESSION_MAX_AGE_MS;

        this.remember(sid, sess, expiresAt);
        this.ready
            .then(async () => {
                await db.query(
                    `INSERT INTO app_sessions (sid, data, expires_at)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`,
                    [sid, JSON.stringify(sess), expiresAt]
                );
                this.lastTouches.set(sid, Date.now());
                callback(null);
            })
            .catch(callback);
    }

    destroy(sid, callback) {
        this.cache.delete(sid);
        this.lastTouches.delete(sid);
        this.ready
            .then(async () => {
                await db.query('DELETE FROM app_sessions WHERE sid = ?', [sid]);
                callback(null);
            })
            .catch(callback);
    }

    touch(sid, sess, callback) {
        const expiresAt = sess.cookie && sess.cookie.expires
            ? new Date(sess.cookie.expires).getTime()
            : Date.now() + SESSION_MAX_AGE_MS;

        const now = Date.now();
        this.remember(sid, sess, expiresAt, true);
        if (now - (this.lastTouches.get(sid) || 0) < this.touchIntervalMs) {
            return callback(null);
        }
        this.lastTouches.set(sid, now);
        this.ready
            .then(async () => {
                await db.query('UPDATE app_sessions SET expires_at = ? WHERE sid = ?', [expiresAt, sid]);
                callback(null);
            })
            .catch(callback);
    }

    clearExpired(callback) {
        const now = Date.now();
        for (const [sid, item] of this.cache) {
            if (item.expiresAt <= now) {
                this.cache.delete(sid);
                this.lastTouches.delete(sid);
            }
        }
        this.ready
            .then(async () => {
                await db.query('DELETE FROM app_sessions WHERE expires_at <= ?', [Date.now()]);
                callback(null);
            })
            .catch(callback);
    }

    remember(sid, sess, expiresAt, preserveCacheAge = false) {
        const existing = this.cache.get(sid);
        this.cache.set(sid, {
            serialized: JSON.stringify(sess),
            expiresAt,
            cachedAt: preserveCacheAge && existing ? existing.cachedAt : Date.now()
        });
        while (this.cache.size > this.maxCacheEntries) {
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
            this.lastTouches.delete(oldest);
        }
    }
}

module.exports = MySQLSessionStore;
