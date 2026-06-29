const crypto = require('crypto');
const db = require('../config/database');
const { nowDateTime, normalizeTime, todayDate } = require('./appTime');
const { sendMulticast } = require('./firebasePush');

const DIVISION_ROLES = new Set(['super_admin', 'superintendent', 'asst_superintendent']);
const PRESENT_STATUSES = new Set(['present', 'late', 'half_day']);
const CHECK_INTERVAL_MS = 60 * 1000;
let timer = null;
let running = false;

async function ensureDeliveryTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS system_push_deliveries (
            id INT AUTO_INCREMENT PRIMARY KEY,
            delivery_key VARCHAR(191) NOT NULL,
            user_id INT NOT NULL,
            notification_type VARCHAR(60) NOT NULL,
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_system_push_delivery (delivery_key),
            INDEX idx_system_push_user (user_id, sent_at),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);
}

async function registeredRecipients() {
    const [rows] = await db.query(
        `SELECT u.id, u.role, u.school_id, ud.push_token
         FROM user_devices ud
         INNER JOIN users u ON u.id = ud.user_id
         WHERE u.status = 'active'
           AND ud.push_token IS NOT NULL
           AND ud.push_token <> ''
         ORDER BY u.id`
    );
    const recipients = new Map();
    for (const row of rows) {
        if (!recipients.has(row.id)) {
            recipients.set(row.id, {
                userId: Number(row.id),
                role: row.role,
                schoolId: row.school_id ? Number(row.school_id) : null,
                tokens: []
            });
        }
        recipients.get(row.id).tokens.push(row.push_token);
    }
    return [...recipients.values()];
}

async function schoolDayInfo(date, schoolId) {
    const [[override]] = await db.query(
        'SELECT is_school_day, reason FROM school_days WHERE date = ? LIMIT 1',
        [date]
    ).catch(() => [[null]]);
    if (override) {
        return {
            isSchoolDay: Boolean(override.is_school_day),
            reason: override.reason || (override.is_school_day ? '' : 'Non-school day')
        };
    }
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) {
        return { isSchoolDay: false, reason: day === 0 ? 'Sunday' : 'Saturday' };
    }
    const params = [date];
    let query = 'SELECT name FROM holidays WHERE holiday_date = ? AND (school_id IS NULL';
    if (schoolId) {
        query += ' OR school_id = ?';
        params.push(schoolId);
    }
    query += ') ORDER BY school_id IS NULL DESC LIMIT 1';
    const [[holiday]] = await db.query(query, params);
    return holiday
        ? { isSchoolDay: false, reason: holiday.name || 'Holiday' }
        : { isSchoolDay: true, reason: '' };
}

function addDays(date, amount) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + amount);
    return value.toISOString().slice(0, 10);
}

async function recentSchoolDates(date, schoolId, limit) {
    const dates = [];
    let cursor = date;
    for (let guard = 0; dates.length < limit && guard < 160; guard++) {
        if ((await schoolDayInfo(cursor, schoolId)).isSchoolDay) dates.push(cursor);
        cursor = addDays(cursor, -1);
    }
    return dates;
}

async function attendanceSummary(date, schoolId) {
    const studentParams = [date];
    let studentWhere = "s.status = 'active' AND COALESCE(s.active_from, DATE(s.created_at)) <= ?";
    if (schoolId) {
        studentWhere += ' AND s.school_id = ?';
        studentParams.push(schoolId);
    }
    const teacherParams = [date];
    let teacherWhere = "t.status = 'active' AND COALESCE(t.active_from, DATE(t.created_at)) <= ?";
    if (schoolId) {
        teacherWhere += ' AND t.school_id = ?';
        teacherParams.push(schoolId);
    }
    const attendanceParams = [date];
    let attendanceWhere = 'a.date = ?';
    if (schoolId) {
        attendanceWhere += ' AND a.school_id = ?';
        attendanceParams.push(schoolId);
    }
    const [studentTotalResult, teacherTotalResult, attendanceResult] = await Promise.all([
        db.query(`SELECT COUNT(*) AS count FROM students s WHERE ${studentWhere}`, studentParams),
        db.query(`SELECT COUNT(*) AS count FROM teachers t WHERE ${teacherWhere}`, teacherParams),
        db.query(
            `SELECT person_type, person_id, time_in, status
             FROM attendance a WHERE ${attendanceWhere}`,
            attendanceParams
        )
    ]);
    const studentTotal = Number(studentTotalResult[0][0]?.count || 0);
    const teacherTotal = Number(teacherTotalResult[0][0]?.count || 0);
    const studentRows = attendanceResult[0].filter(row => row.person_type === 'student');
    const teacherRows = attendanceResult[0].filter(row => row.person_type === 'teacher');
    const attended = rows => new Set(rows
        .filter(row => row.time_in || PRESENT_STATUSES.has(String(row.status || '').toLowerCase()))
        .map(row => Number(row.person_id))).size;
    const countStatus = (rows, status) => rows.filter(row => String(row.status || '').toLowerCase() === status).length;
    const studentsAttended = attended(studentRows);
    const teachersAttended = attended(teacherRows);
    return {
        studentTotal,
        studentsAttended,
        studentsAbsent: Math.max(0, studentTotal - studentsAttended),
        studentsLate: countStatus(studentRows, 'late'),
        studentsHalfDay: countStatus(studentRows, 'half_day'),
        teacherTotal,
        teachersAttended,
        teachersAbsent: Math.max(0, teacherTotal - teachersAttended),
        rate: studentTotal > 0 ? Math.min(100, Math.round((studentsAttended / studentTotal) * 100)) : 0
    };
}

async function flaggedStudentsForSchool(date, schoolId) {
    const dates = await recentSchoolDates(date, schoolId, 2);
    if (dates.length < 2) return [];
    const oldest = dates[dates.length - 1];
    const [students] = await db.query(
        `SELECT s.id, s.firstname, s.lastname, s.school_id,
                sc.name AS school_name, gl.name AS grade_name, sec.name AS section_name
         FROM students s
         LEFT JOIN schools sc ON sc.id = s.school_id
         LEFT JOIN grade_levels gl ON gl.id = s.grade_level_id
         LEFT JOIN sections sec ON sec.id = s.section_id
         WHERE s.status = 'active'
           AND s.school_id = ?
           AND COALESCE(s.active_from, DATE(s.created_at)) < ?
           AND NOT EXISTS (
               SELECT 1 FROM attendance a
               WHERE a.person_type = 'student'
                 AND a.person_id = s.id
                 AND a.date IN (?)
                 AND (a.time_in IS NOT NULL OR a.status IN ('present','late','half_day'))
           )
         ORDER BY s.lastname, s.firstname`,
        [schoolId, oldest, dates]
    );
    return students.map(student => ({
        ...student,
        absent_days: 2,
        checked_dates: dates,
        name: `${student.firstname} ${student.lastname}`.trim()
    }));
}

function recipientScope(recipient) {
    return DIVISION_ROLES.has(recipient.role) ? null : recipient.schoolId;
}

function hasNotificationScope(recipient) {
    return DIVISION_ROLES.has(recipient.role) || Boolean(recipient.schoolId);
}

async function wasDelivered(key) {
    const [[row]] = await db.query(
        'SELECT id FROM system_push_deliveries WHERE delivery_key = ? LIMIT 1',
        [key]
    );
    return Boolean(row);
}

async function sendOnce(recipient, key, type, payload) {
    // Claim the logical notification before sending it. INSERT IGNORE is
    // atomic, so overlapping Railway instances during a deploy cannot both
    // send the same report after racing through a SELECT check.
    const [claim] = await db.query(
        `INSERT IGNORE INTO system_push_deliveries
            (delivery_key, user_id, notification_type)
         VALUES (?, ?, ?)`,
        [key, recipient.userId, type]
    );
    if (claim.affectedRows !== 1) return false;

    try {
        const result = await sendMulticast(recipient.tokens, payload);
        if (result.invalidTokens.length) {
            await db.query('DELETE FROM user_devices WHERE push_token IN (?)', [result.invalidTokens]);
        }
        if (result.successCount < 1) {
            await db.query('DELETE FROM system_push_deliveries WHERE delivery_key = ?', [key]);
            return false;
        }
        return true;
    } catch (error) {
        await db.query('DELETE FROM system_push_deliveries WHERE delivery_key = ?', [key]).catch(() => {});
        throw error;
    }
}

async function sendDailyReports(date) {
    const recipients = await registeredRecipients();
    const summaryCache = new Map();
    const calendarCache = new Map();
    for (const recipient of recipients) {
        if (!hasNotificationScope(recipient)) continue;
        const schoolId = recipientScope(recipient);
        const scopeKey = schoolId || 'division';
        const deliveryKey = `daily-report:${date}:${recipient.userId}`;
        if (await wasDelivered(deliveryKey)) continue;
        if (!calendarCache.has(scopeKey)) calendarCache.set(scopeKey, await schoolDayInfo(date, schoolId));
        const calendar = calendarCache.get(scopeKey);
        let body;
        let summaryStats = null;
        if (!calendar.isSchoolDay) {
            body = `No classes today (${calendar.reason}). Attendance reports resume on the next school day.`;
        } else {
            if (!summaryCache.has(scopeKey)) summaryCache.set(scopeKey, await attendanceSummary(date, schoolId));
            const s = summaryCache.get(scopeKey);
            body = `${s.rate}% attendance • Students: ${s.studentsAttended} attended, ${s.studentsAbsent} absent, ${s.studentsLate} late, ${s.studentsHalfDay} half-day • Teachers: ${s.teachersAttended} attended, ${s.teachersAbsent} absent`;
            summaryStats = {
                students_present: String(s.studentsAttended),
                students_absent: String(s.studentsAbsent),
                students_late: String(s.studentsLate),
                students_half_day: String(s.studentsHalfDay),
                teachers_present: String(s.teachersAttended),
                teachers_absent: String(s.teachersAbsent),
                attendance_rate: String(s.rate)
            };
        }
        await sendOnce(recipient, deliveryKey, 'daily_summary', {
            title: 'SDO Sipalay AI Assistant · Daily Report',
            body,
            channelId: 'edutrack_daily_summary',
            collapseKey: `edutrack_daily_${date}`,
            tag: 'edutrack_daily_summary',
            ttlMs: 6 * 60 * 60 * 1000,
            // Rich payload — the foreground handler builds the in-app design
            // (robot icon + per-section stats). The basic notification field
            // serves as the background fallback so the user still sees ONE
            // alert when the app is killed.
            data: {
                type: 'daily_summary',
                title: 'Daily Attendance Summary',
                body,
                date,
                is_school_day: calendar.isSchoolDay ? '1' : '0',
                ...(summaryStats || {})
            }
        });
    }
}

function flagHash(flags) {
    return crypto.createHash('sha1')
        .update(flags.map(flag => `${flag.school_id}:${flag.id}`).sort().join('|'))
        .digest('hex')
        .slice(0, 12);
}

async function sendAbsenceFlags(date, { ignoreCutoff = false } = {}) {
    const [[cutoffRow]] = await db.query(
        `SELECT setting_value FROM settings
         WHERE setting_key IN ('absence_cutoff_time','pm_time_out_end')
         ORDER BY FIELD(setting_key,'absence_cutoff_time','pm_time_out_end') LIMIT 1`
    );
    const cutoff = normalizeTime(cutoffRow?.setting_value, '16:00:00');
    if (!ignoreCutoff && nowDateTime().slice(11) < cutoff) return;
    const [schools] = await db.query("SELECT id FROM schools WHERE status = 'active' ORDER BY id");
    const flagsBySchool = new Map();
    for (const school of schools) {
        if (!(await schoolDayInfo(date, school.id)).isSchoolDay) {
            flagsBySchool.set(Number(school.id), []);
            continue;
        }
        flagsBySchool.set(Number(school.id), await flaggedStudentsForSchool(date, school.id));
    }
    const allFlags = [...flagsBySchool.values()].flat();
    const recipients = await registeredRecipients();
    for (const recipient of recipients) {
        if (!hasNotificationScope(recipient)) continue;
        const schoolId = recipientScope(recipient);
        const flags = schoolId ? (flagsBySchool.get(Number(schoolId)) || []) : allFlags;
        if (!flags.length) continue;
        const key = `absence-flags:${date}:${recipient.userId}:${flagHash(flags)}`;
        const names = flags.slice(0, 3).map(flag => flag.name).join(', ');
        const remainder = flags.length > 3 ? ` and ${flags.length - 3} more` : '';
        const body = `${names}${remainder} ${flags.length === 1 ? 'has' : 'have'} been absent for 2 consecutive school days.`;
        await sendOnce(recipient, key, 'attendance_flagged', {
            title: flags.length === 1 ? '2-Day Absence Alert' : `${flags.length} Students Flagged`,
            body,
            channelId: 'edutrack_alerts',
            collapseKey: `edutrack_flags_${date}`,
            tag: 'edutrack_absence_flags',
            ttlMs: 12 * 60 * 60 * 1000,
            data: {
                type: 'attendance_flagged',
                title: '2-Day Absence Alert',
                body,
                date,
                flagged_count: flags.length
            }
        });
    }
}

async function runSystemPushScheduler() {
    if (running) return;
    running = true;
    try {
        await ensureDeliveryTable();
        const now = nowDateTime();
        const date = todayDate();
        const time = now.slice(11);
        const [[cutoffRow]] = await db.query(
            `SELECT setting_value FROM settings
             WHERE setting_key IN ('absence_cutoff_time','pm_time_out_end')
             ORDER BY FIELD(setting_key,'absence_cutoff_time','pm_time_out_end') LIMIT 1`
        );
        const cutoff = normalizeTime(cutoffRow?.setting_value, '16:00:00');
        if (time >= cutoff) {
            await sendAbsenceFlags(date, { ignoreCutoff: true });
        } else {
            await sendAbsenceFlags(addDays(date, -1), { ignoreCutoff: true });
        }
        // A catch-up window makes the report reliable after a Railway restart or
        // temporary outage instead of requiring the process to hit exactly 19:00.
        await sendDailyReports(time >= '19:00:00' ? date : addDays(date, -1));
        if (time >= '00:10:00' && time < '00:20:00') {
            await db.query('DELETE FROM system_push_deliveries WHERE sent_at < DATE_SUB(NOW(), INTERVAL 90 DAY)');
        }
    } catch (error) {
        console.error('System push scheduler error:', error);
    } finally {
        running = false;
    }
}

function startSystemPushScheduler() {
    if (timer) return;
    setTimeout(runSystemPushScheduler, 10 * 1000);
    timer = setInterval(runSystemPushScheduler, CHECK_INTERVAL_MS);
    if (timer.unref) timer.unref();
    console.log('System push scheduler enabled (2-day flags + 7:00 PM daily report).');
}

module.exports = {
    runSystemPushScheduler,
    sendAbsenceFlags,
    sendDailyReports,
    startSystemPushScheduler
};
