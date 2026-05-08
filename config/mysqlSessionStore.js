const session = require('express-session');
const db = require('./database');

class MySQLSessionStore extends session.Store {
    constructor() {
        super();
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
        this.ready
            .then(async () => {
                const [rows] = await db.query(
                    'SELECT data FROM app_sessions WHERE sid = ? AND expires_at > ?',
                    [sid, Date.now()]
                );
                if (!rows.length) return callback(null, null);
                const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
                return callback(null, data);
            })
            .catch(callback);
    }

    set(sid, sess, callback) {
        const expiresAt = sess.cookie && sess.cookie.expires
            ? new Date(sess.cookie.expires).getTime()
            : Date.now() + 24 * 60 * 60 * 1000;

        this.ready
            .then(async () => {
                await db.query(
                    `INSERT INTO app_sessions (sid, data, expires_at)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`,
                    [sid, JSON.stringify(sess), expiresAt]
                );
                callback(null);
            })
            .catch(callback);
    }

    destroy(sid, callback) {
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
            : Date.now() + 24 * 60 * 60 * 1000;

        this.ready
            .then(async () => {
                await db.query('UPDATE app_sessions SET expires_at = ? WHERE sid = ?', [expiresAt, sid]);
                callback(null);
            })
            .catch(callback);
    }

    clearExpired(callback) {
        this.ready
            .then(async () => {
                await db.query('DELETE FROM app_sessions WHERE expires_at <= ?', [Date.now()]);
                callback(null);
            })
            .catch(callback);
    }
}

module.exports = MySQLSessionStore;
