const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const {
    todayDate,
    nowDateTime,
    normalizeTime,
    sqlDateTime,
    compareDateTime,
    formatTime12
} = require('../utils/appTime');
const {
    ATTENDANCE_SCAN_LABELS,
    computeDailyAttendanceStatusFromEvents,
    firstScanDecision,
    normalizeEventLabel,
    statusLabel,
    timeOutScanLabel
} = require('../utils/attendanceStatus');
const {
    createNoClassNotificationForParent,
    getParentInbox,
    getParentUnreadCount,
    markParentNotificationsRead,
    registerParentDevice,
    syncAnnouncementNotificationsForParent,
    syncAttendanceNotificationsForParent
} = require('../utils/parentNotifications');
const schoolYears = require('../utils/schoolYear');

const router = express.Router();

function schoolLogoUrl(schoolId, logo) {
    if (!schoolId || !logo) return '';
    const version = crypto.createHash('md5').update(String(logo)).digest('hex').slice(0, 12);
    return `/api/schools/${schoolId}/logo-image?v=${version}`;
}

function normalizeContact(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('63') && digits.length === 12) digits = `0${digits.slice(2)}`;
    if (digits.length === 10 && digits.startsWith('9')) digits = `0${digits}`;
    return digits;
}

function normalizedContactCandidates(value) {
    const raw = String(value || '');
    const candidates = new Set();
    const add = (part) => {
        const normalized = normalizeContact(part);
        if (normalized.length >= 7) candidates.add(normalized);
    };
    add(raw);
    raw.split(/[,;/|]+|\s+(?:or|and)\s+/i).forEach(add);
    (raw.match(/(?:\+?63|0)?9[\d\s().-]{7,}\d/g) || []).forEach(add);
    return candidates;
}

function contactMatches(candidateValue, normalizedContact) {
    if (!normalizedContact) return false;
    return normalizedContactCandidates(candidateValue).has(normalizedContact);
}

function isContactLike(value) {
    return normalizeContact(value).length >= 7;
}

function displayStudentName(student) {
    return [student.firstname, student.middlename ? `${student.middlename.charAt(0).toUpperCase()}.` : '', student.lastname]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function dateMinusDays(dateStr, days) {
    const [year, month, day] = String(dateStr).split('-').map(part => parseInt(part, 10));
    const date = new Date(year, month - 1, day);
    date.setDate(date.getDate() - days);
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

function sqlDateOnly(value) {
    if (!value) return '';
    if (value instanceof Date) {
        return [
            value.getFullYear(),
            String(value.getMonth() + 1).padStart(2, '0'),
            String(value.getDate()).padStart(2, '0')
        ].join('-');
    }
    return String(value).slice(0, 10);
}

function isAbsenceFinal(dateStr) {
    const today = todayDate();
    if (dateStr < today) return true;
    if (dateStr > today) return false;
    return compareDateTime(nowDateTime(), `${dateStr} 16:00:00`) >= 0;
}

async function requireParentAuth(req, res, next) {
    const isApi = (req.originalUrl || '').startsWith('/api/parent/');
    const user = req.session && req.session.user;
    if (!user || user.role !== 'parent') {
        if (isApi) return res.status(401).json({ error: 'Parent login required.', code: 'SESSION_EXPIRED' });
        return res.redirect('/parent-login');
    }
    try {
        const parentId = user.parent_id || user.id;
        const [[parent]] = await db.query('SELECT id, status FROM parents WHERE id = ? LIMIT 1', [parentId]);
        if (!parent || parent.status !== 'active') {
            const message = 'This Guardian account was removed or disabled. Please contact the school administrator.';
            return req.session.destroy(() => {
                if (isApi) return res.status(401).json({ error: message, code: 'ACCOUNT_DISABLED' });
                return res.redirect('/parent-login');
            });
        }
        return next();
    } catch (err) {
        console.error('Parent session validation error:', err);
        if (isApi) return res.status(500).json({ error: 'Unable to verify parent session.' });
        return res.redirect('/parent-login');
    }
}

async function renderParentAuth(res, view, opts = {}) {
    return res.render(view, Object.assign({
        title: view === 'parent_register' ? 'Parent Registration' : 'Parent Login',
        error: null,
        success: null,
        values: {}
    }, opts));
}

async function createOrReactivateParentAccount({ guardianName, contactNumber, normalized, username, password }) {
    const [existingContact] = await db.query(
        'SELECT id, status FROM parents WHERE normalized_contact = ? LIMIT 1',
        [normalized]
    );
    const existing = existingContact[0] || null;
    if (existing && existing.status === 'active') {
        const error = new Error('This mobile number is already registered. Please log in instead.');
        error.code = 'PARENT_EXISTS';
        throw error;
    }
    if (existing && existing.status === 'deleted') {
        const error = new Error('This mobile number was removed by the administrator. Please contact the school adviser or administrator.');
        error.code = 'PARENT_DELETED';
        throw error;
    }

    if (username) {
        let usernameRows;
        if (existing) {
            [usernameRows] = await db.query(
                'SELECT id FROM parents WHERE username = ? AND id != ? LIMIT 1',
                [username, existing.id]
            );
        } else {
            [usernameRows] = await db.query('SELECT id FROM parents WHERE username = ? LIMIT 1', [username]);
        }
        if (usernameRows.length) {
            const error = new Error('This username is already taken.');
            error.code = 'USERNAME_EXISTS';
            throw error;
        }
    }

    const hashed = await bcrypt.hash(password, 10);
    if (existing) {
        await db.query(
            `UPDATE parents
             SET guardian_name = ?, contact_number = ?, normalized_contact = ?,
                 username = ?, password = ?, status = 'active', last_login = ?
             WHERE id = ?`,
            [guardianName, contactNumber, normalized, username || null, hashed, nowDateTime(), existing.id]
        );
        return { id: existing.id, reactivated: true };
    }

    const [result] = await db.query(
        'INSERT INTO parents (guardian_name, contact_number, normalized_contact, username, password) VALUES (?, ?, ?, ?, ?)',
        [guardianName, contactNumber, normalized, username || null, hashed]
    );
    return { id: result.insertId, reactivated: false };
}

async function contactExistsForStudent(normalizedContact) {
    if (!normalizedContact) return false;
    const [rows] = await db.query(
        `SELECT guardian_contact
         FROM student_enrollments e
         INNER JOIN school_years sy ON sy.id = e.school_year_id AND sy.status = 'active'
         INNER JOIN students s ON s.id = e.student_id
         WHERE e.status = 'enrolled'
           AND s.status = 'active'
           AND s.guardian_contact IS NOT NULL
           AND s.guardian_contact != ''`
    );
    return rows.some(row => contactMatches(row.guardian_contact, normalizedContact));
}

async function getParentChildren(normalizedContact) {
    if (!normalizedContact) return [];
    const [rows] = await db.query(
        `SELECT
            s.id, s.lrn, s.firstname, s.lastname, s.middlename, s.guardian_contact, s.status,
            e.school_id, e.grade_level_id, e.section_id,
            sc.name AS school_name, sc.logo AS school_logo,
            gl.name AS grade_name,
            sec.name AS section_name,
            COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) AS adviser_name,
            at.contact AS adviser_contact,
            at.email AS adviser_email
         FROM student_enrollments e
         INNER JOIN school_years sy ON sy.id = e.school_year_id AND sy.status = 'active'
         INNER JOIN students s ON s.id = e.student_id
         LEFT JOIN schools sc ON e.school_id = sc.id
         LEFT JOIN grade_levels gl ON e.grade_level_id = gl.id
         LEFT JOIN sections sec ON e.section_id = sec.id
         LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
         WHERE e.status = 'enrolled'
           AND s.status = 'active'
           AND s.guardian_contact IS NOT NULL
           AND s.guardian_contact != ''
         ORDER BY s.lastname, s.firstname`
    );
    return rows
        .filter(row => contactMatches(row.guardian_contact, normalizedContact))
        .map(row => ({
            ...row,
            name: displayStudentName(row)
        }));
}

async function getAttendanceScheduleTimes(dateStr) {
    const [settingsRows] = await db.query(
        `SELECT setting_key, setting_value
         FROM settings
         WHERE setting_key IN ('am_late_time', 'lunch_break_start', 'pm_time_in_start', 'pm_late_time', 'pm_time_out_end')`
    );
    const settings = Object.fromEntries(settingsRows.map(row => [row.setting_key, row.setting_value]));
    return {
        amLateStart: sqlDateTime(dateStr, normalizeTime(settings.am_late_time, '07:15:00')),
        lunchStart: sqlDateTime(dateStr, normalizeTime(settings.lunch_break_start, '11:00:00')),
        pmInStart: sqlDateTime(dateStr, normalizeTime(settings.pm_time_in_start, '13:00:00')),
        pmLateStart: sqlDateTime(dateStr, normalizeTime(settings.pm_late_time, '13:15:00')),
        pmOutStart: sqlDateTime(dateStr, normalizeTime(settings.pm_time_out_end, '16:00:00'))
    };
}

async function getAttendanceEventsByIds(attendanceIds) {
    const ids = [...new Set((attendanceIds || []).filter(Boolean))];
    const map = new Map();
    if (ids.length === 0) return map;
    const [rows] = await db.query(
        `SELECT attendance_id, event, event_label, event_time
         FROM attendance_events
         WHERE attendance_id IN (?)
         ORDER BY event_time, id`,
        [ids]
    );
    rows.forEach(row => {
        if (!map.has(row.attendance_id)) map.set(row.attendance_id, []);
        map.get(row.attendance_id).push(row);
    });
    return map;
}

function attendanceEventAction(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'time_in' || raw === 'time in') return 'time_in';
    if (raw === 'time_out' || raw === 'time out') return 'time_out';
    return raw;
}

function eventTone(label) {
    const value = String(label || '').toLowerCase();
    if (value.includes('late')) return 'late';
    if (value.includes('lunch')) return 'lunch';
    if (value.includes('out') || value.includes('completed')) return 'out';
    if (value.includes('return') || value.includes('welcome')) return 'return';
    return 'in';
}

function buildAttendanceTimeline(row, schedule, storedEvents) {
    const events = Array.isArray(storedEvents) ? [...storedEvents] : [];
    if (row && row.time_in && !events.some(event => attendanceEventAction(event.event) === 'time_in')) {
        const decision = firstScanDecision(row.time_in, schedule, row.status || 'present');
        events.unshift({
            event: 'time_in',
            event_label: decision.label || ATTENDANCE_SCAN_LABELS.TIME_IN,
            event_time: row.time_in
        });
    }
    if (row && row.time_out && !events.some(event => attendanceEventAction(event.event) === 'time_out' && String(event.event_time) === String(row.time_out))) {
        events.push({
            event: 'time_out',
            event_label: timeOutScanLabel(row.time_out, schedule),
            event_time: row.time_out
        });
    }
    return events
        .filter(event => event && event.event_time)
        .sort((a, b) => compareDateTime(a.event_time, b.event_time))
        .map(event => {
            const action = attendanceEventAction(event.event);
            const label = normalizeEventLabel(event.event_label) || (action === 'time_out'
                ? timeOutScanLabel(event.event_time, schedule)
                : ATTENDANCE_SCAN_LABELS.TIME_IN);
            return {
                action,
                label,
                label_display: label,
                time: event.event_time,
                time_display: formatTime12(event.event_time),
                tone: eventTone(label)
            };
        });
}

function currentStudentState(attendance, timeline, resolved) {
    if (!attendance || !attendance.time_in) return (resolved && resolved.label) || 'No Time In';
    const latest = timeline[timeline.length - 1];
    const latestLabel = normalizeEventLabel(latest && latest.label);
    const monitoring = normalizeEventLabel(attendance.monitoring_status);
    if (latestLabel === ATTENDANCE_SCAN_LABELS.COMPLETED || monitoring === ATTENDANCE_SCAN_LABELS.COMPLETED) return 'Completed';
    if (latestLabel === ATTENDANCE_SCAN_LABELS.LUNCH_OUT || monitoring === ATTENDANCE_SCAN_LABELS.LUNCH_OUT) return 'Lunch Out';
    if (latest && latest.action === 'time_out') return 'Outside School';
    if (resolved && resolved.status === 'half_day' && !timeline.length) return resolved.label || 'Half-Day';
    return 'Inside School';
}

function resolveAttendance(attendance, schedule, storedEvents, absenceFinal = true) {
    if (!attendance || !attendance.time_in) {
        // A student with no time-in is only "Absent" once the day's attendance is
        // final (after the cutoff / end of day). Before that they are simply
        // "No Time In" — not absent — so parents aren't alarmed early in the day.
        return {
            status: absenceFinal ? 'absent' : 'no_time_in',
            label: absenceFinal ? 'Absent' : 'No Time In',
            timeline: [],
            current_status: absenceFinal ? 'Absent' : 'No Time In',
            latest_scan_time: null
        };
    }
    const timeline = buildAttendanceTimeline(attendance, schedule, storedEvents);
    const eventsForCompute = timeline.map(entry => ({
        event: entry.action,
        event_label: entry.label,
        event_time: entry.time
    }));
    const resolved = computeDailyAttendanceStatusFromEvents({
        events: eventsForCompute,
        schedule,
        baseStatus: attendance.status || 'present'
    });
    const latest = timeline[timeline.length - 1];
    return {
        status: resolved.status || attendance.status || 'present',
        label: resolved.label || statusLabel(resolved.status || attendance.status),
        remarks: resolved.remarks || '',
        half_day_type: resolved.halfDayType || null,
        timeline,
        current_status: currentStudentState(attendance, timeline, resolved),
        latest_scan_time: latest ? latest.time_display : null
    };
}

async function isSchoolDay(dateStr, schoolId) {
    const activeYear = await schoolYears.getActiveSchoolYear().catch(() => null);
    if (activeYear) {
        const dateOnly = value => {
            if (!value) return null;
            if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
            const match = String(value).trim().match(/\d{4}-\d{2}-\d{2}/);
            return match ? match[0] : null;
        };
        const start = dateOnly(activeYear.start_date);
        const end = dateOnly(activeYear.end_date);
        const label = activeYear.label ? ` ${activeYear.label}` : '';
        if (start && dateStr < start) {
            return { is_school_day: false, reason: `School year${label} has not started yet.`, type: 'School Year' };
        }
        if (end && dateStr > end) {
            return { is_school_day: false, reason: `School year${label} has ended.`, type: 'School Year' };
        }
    }
    const [year, month, dayOfMonth] = String(dateStr).split('-').map(part => parseInt(part, 10));
    const date = new Date(year, month - 1, dayOfMonth);
    const day = date.getDay();
    if (day === 0 || day === 6) {
        return { is_school_day: false, reason: 'Weekend', type: 'Weekend' };
    }
    const [[override]] = await db.query('SELECT is_school_day, reason FROM school_days WHERE date = ? LIMIT 1', [dateStr]);
    if (override) {
        return {
            is_school_day: Number(override.is_school_day) === 1,
            reason: override.reason || (Number(override.is_school_day) === 1 ? '' : 'No classes'),
            type: Number(override.is_school_day) === 1 ? 'School Day' : 'No Classes'
        };
    }
    const [holidays] = await db.query(
        `SELECT name
         FROM holidays
         WHERE holiday_date = ?
           AND (is_national = 1 OR school_id IS NULL OR school_id = ?)
         LIMIT 1`,
        [dateStr, schoolId || null]
    );
    if (holidays.length) {
        return { is_school_day: false, reason: holidays[0].name || 'Holiday', type: 'Holiday' };
    }
    return { is_school_day: true, reason: '', type: 'School Day' };
}

async function countConsecutiveAbsences(studentId, schoolId, baseDate) {
    // If the student is present today (has timed in), the streak is broken — no
    // flag, even before the school day is "final". This prevents the
    // "2 consecutive absences — contact the adviser" notice from showing for a
    // student who already came to school today (e.g. a late time-in).
    const [[presentToday]] = await db.query(
        `SELECT 1 AS present FROM attendance
         WHERE person_type = 'student' AND person_id = ? AND date = ? AND time_in IS NOT NULL
         LIMIT 1`,
        [studentId, baseDate]
    );
    if (presentToday) return 0;

    const schoolDates = [];
    const startOffset = isAbsenceFinal(baseDate) ? 0 : 1;
    for (let offset = startOffset; offset < 14 && schoolDates.length < 2; offset++) {
        const date = dateMinusDays(baseDate, offset);
        const schoolDay = await isSchoolDay(date, schoolId);
        if (schoolDay.is_school_day) schoolDates.push(date);
    }
    if (schoolDates.length < 2) return 0;
    const [rows] = await db.query(
        `SELECT date, time_in
         FROM attendance
         WHERE person_type = 'student'
           AND person_id = ?
           AND date IN (?)`,
        [studentId, schoolDates]
    );
    const presentDates = new Set(rows.filter(row => row.time_in).map(row => sqlDateOnly(row.date)));
    let count = 0;
    for (const date of schoolDates) {
        if (presentDates.has(date)) break;
        count++;
    }
    return count;
}

async function buildParentPayload(parent, date) {
    const children = await getParentChildren(parent.normalized_contact);
    const schedule = await getAttendanceScheduleTimes(date);
    const childIds = children.map(child => child.id);
    const attendanceByStudent = new Map();
    if (childIds.length) {
        const [attendanceRows] = await db.query(
            `SELECT *
             FROM attendance
             WHERE person_type = 'student'
               AND date = ?
               AND person_id IN (?)`,
            [date, childIds]
        );
        attendanceRows.forEach(row => attendanceByStudent.set(row.person_id, row));
    }
    const eventsByAttendance = await getAttendanceEventsByIds(
        Array.from(attendanceByStudent.values()).map(row => row.id)
    );

    const childPayload = [];
    for (const child of children) {
        const attendance = attendanceByStudent.get(child.id) || null;
        const schoolDay = await isSchoolDay(date, child.school_id);
        const resolved = (!schoolDay.is_school_day && (!attendance || !attendance.time_in))
            ? {
                status: 'non_school_day',
                label: schoolDay.type || 'No Classes',
                remarks: schoolDay.reason || 'No classes are scheduled today.',
                timeline: [],
                current_status: schoolDay.type || 'No Classes',
                latest_scan_time: null
            }
            : resolveAttendance(attendance, schedule, attendance ? (eventsByAttendance.get(attendance.id) || []) : [], isAbsenceFinal(date));
        const consecutiveAbsences = await countConsecutiveAbsences(child.id, child.school_id, date);
        childPayload.push({
            id: child.id,
            name: child.name,
            lrn: child.lrn || '',
            school_id: child.school_id || null,
            grade_level_id: child.grade_level_id || null,
            section_id: child.section_id || null,
            grade_level: child.grade_name || 'N/A',
            section: child.section_name || 'N/A',
            school_name: child.school_name || 'N/A',
            school_logo: schoolLogoUrl(child.school_id, child.school_logo),
            adviser_name: child.adviser_name || 'No adviser assigned',
            adviser_contact: child.adviser_contact || '',
            adviser_email: child.adviser_email || '',
            today_status: resolved.label,
            status_key: resolved.status,
            current_status: resolved.current_status,
            latest_scan_time: resolved.latest_scan_time,
            remarks: resolved.remarks || '',
            timeline: resolved.timeline,
            consecutive_absences: consecutiveAbsences,
            absence_final: schoolDay.is_school_day && isAbsenceFinal(date),
            is_school_day: schoolDay.is_school_day,
            non_school_day_type: schoolDay.is_school_day ? null : schoolDay.type,
            non_school_day_reason: schoolDay.is_school_day ? null : schoolDay.reason
        });
    }

    const schoolIds = [...new Set(children.map(child => child.school_id).filter(Boolean))];
    await syncAttendanceNotificationsForParent(parent, childPayload, date);
    await syncAnnouncementNotificationsForParent(parent, childPayload);
    for (const schoolId of schoolIds.length ? schoolIds : [null]) {
        const day = await isSchoolDay(date, schoolId);
        await createNoClassNotificationForParent(parent, schoolId, date, day);
    }
    const parentId = parent.parent_id || parent.id;
    const notifications = await getParentInbox(parentId, { limit: 100 });
    const unread_count = await getParentUnreadCount(parentId);
    return {
        date,
        parent: {
            id: parent.id,
            guardian_name: parent.guardian_name,
            contact_number: parent.contact_number,
            username: parent.username || ''
        },
        children: childPayload,
        notifications,
        unread_count
    };
}

async function buildParentNotifications(children, schoolIds, date) {
    const notifications = [];
    for (const child of children) {
        child.timeline.forEach(entry => {
            notifications.push({
                key: `scan-${child.id}-${entry.time}-${entry.label}`,
                type: 'attendance',
                title: `${child.name} - ${entry.label_display}`,
                message: `${entry.time_display} • ${child.school_name}`,
                child_id: child.id,
                child_name: child.name,
                created_at: entry.time,
                tone: entry.tone
            });
        });
        if (isAbsenceFinal(date) && !child.timeline.length && child.today_status === 'Absent') {
            notifications.push({
                key: `absent-${child.id}-${date}`,
                type: 'absent',
                title: `${child.name} is marked Absent`,
                message: `${child.grade_level} • ${child.section} • ${child.school_name}`,
                child_id: child.id,
                child_name: child.name,
                created_at: `${date} 16:00:00`,
                tone: 'out'
            });
        }
        if (child.consecutive_absences >= 2) {
            notifications.push({
                key: `flagged-${child.id}-${date}`,
                type: 'flagged',
                title: `${child.name} has ${child.consecutive_absences} consecutive absences`,
                message: `${child.grade_level} • ${child.section} • ${child.school_name}`,
                child_id: child.id,
                child_name: child.name,
                created_at: `${date} 16:01:00`,
                tone: 'out'
            });
        }
    }

    if (schoolIds.length) {
        const [rows] = await db.query(
            `SELECT id, title, message, type, school_id, created_at
             FROM notifications
             WHERE school_id IS NULL OR school_id IN (?)
             ORDER BY created_at DESC
             LIMIT 50`,
            [schoolIds]
        );
        rows.forEach(row => {
            notifications.push({
                key: `announcement-${row.id}`,
                type: row.type || 'announcement',
                title: row.title || 'Announcement',
                message: row.message || '',
                created_at: row.created_at,
                tone: row.type === 'holiday' || row.type === 'no_class' ? 'holiday' : 'in'
            });
        });
    } else {
        const [rows] = await db.query(
            `SELECT id, title, message, type, school_id, created_at
             FROM notifications
             WHERE school_id IS NULL
             ORDER BY created_at DESC
             LIMIT 25`
        );
        rows.forEach(row => {
            notifications.push({
                key: `announcement-${row.id}`,
                type: row.type || 'announcement',
                title: row.title || 'Announcement',
                message: row.message || '',
                created_at: row.created_at,
                tone: 'in'
            });
        });
    }

    for (const schoolId of schoolIds.length ? schoolIds : [null]) {
        const day = await isSchoolDay(date, schoolId);
        if (!day.is_school_day) {
            notifications.push({
                key: `no-class-${schoolId || 'all'}-${date}`,
                type: 'no_class',
                title: day.type || 'No Classes',
                message: day.reason || 'No classes are scheduled today.',
                created_at: `${date} 06:00:00`,
                tone: 'holiday'
            });
        }
    }

    return notifications
        .sort((a, b) => compareDateTime(b.created_at, a.created_at))
        .slice(0, 80);
}

async function loadBranding() {
    const [rows] = await db.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('system_logo','system_name','division_name','mobile_dashboard_school_art')"
    );
    return Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
}

router.get('/Download-app', async (req, res) => {
    const parentApkPath = path.join(__dirname, '..', 'public', 'downloads', 'edutrack-parent.apk');
    const branding = await loadBranding().catch(() => ({}));
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.render('parent_download', {
        title: 'EduTrack Guardian App',
        parentApkAvailable: fs.existsSync(parentApkPath),
        missing: req.query.missing === '1',
        latestVersion: PARENT_APP_LATEST.version,
        latestVersionCode: PARENT_APP_LATEST.version_code,
        branding
    });
});

router.get('/download-app', (req, res) => res.redirect('/Download-app'));

router.get('/download/parent-app', (req, res) => {
    const parentApkPath = path.join(__dirname, '..', 'public', 'downloads', 'edutrack-parent.apk');
    if (!fs.existsSync(parentApkPath)) return res.redirect('/Download-app?missing=1');
    // Redirect the stable web link to a versioned URL. The versioned APK can be
    // cached safely without making a future release appear stale.
    if (String(req.query.v || '') !== String(PARENT_APP_LATEST.version_code)) {
        return res.redirect(302, `/download/parent-app?v=${PARENT_APP_LATEST.version_code}`);
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.download(parentApkPath, `EduTrack-Guardian-${PARENT_APP_LATEST.version}.apk`);
});

router.get('/parent', (req, res) => {
    if (req.session.user && req.session.user.role === 'parent') return res.redirect('/parent/app');
    return res.redirect('/parent-login');
});

router.get('/parent-login', (req, res) => {
    if (req.session.user && req.session.user.role === 'parent') return res.redirect('/parent/app');
    return renderParentAuth(res, 'parent_login');
});

router.post('/parent-login', async (req, res) => {
    const identifier = String(req.body.identifier || '').trim();
    const password = String(req.body.password || '');
    if (!identifier || !password) {
        return renderParentAuth(res, 'parent_login', {
            error: 'Please enter your mobile number or username and password.',
            values: { identifier }
        });
    }
    const normalized = normalizeContact(identifier);
    try {
        const [rows] = await db.query(
            `SELECT *
             FROM parents
             WHERE status = 'active'
               AND (username = ? OR normalized_contact = ?)
             LIMIT 1`,
            [identifier, normalized]
        );
        if (rows.length === 0) {
            const [removedRows] = await db.query(
                "SELECT status FROM parents WHERE username = ? OR normalized_contact = ? LIMIT 1",
                [identifier, normalized]
            );
            if (removedRows[0] && removedRows[0].status === 'deleted') {
                return renderParentAuth(res, 'parent_login', {
                    error: 'This Guardian account was removed by the administrator. Please contact the school adviser or administrator.'
                });
            }
            if (isContactLike(identifier) && !(await contactExistsForStudent(normalized))) {
                return renderParentAuth(res, 'parent_login', {
                    error: 'This contact number is not registered. Please contact the school adviser or administrator.',
                    values: { identifier }
                });
            }
            return renderParentAuth(res, 'parent_login', {
                error: 'Parent account not found. Please register first using your registered guardian contact number.',
                values: { identifier }
            });
        }
        const parent = rows[0];
        const match = await bcrypt.compare(password, parent.password);
        if (!match) {
            return renderParentAuth(res, 'parent_login', {
                error: 'Invalid mobile number/username or password.',
                values: { identifier }
            });
        }
        req.session.user = {
            id: parent.id,
            parent_id: parent.id,
            username: parent.username || parent.contact_number,
            fullname: parent.guardian_name,
            role: 'parent',
            contact_number: parent.contact_number,
            normalized_contact: parent.normalized_contact
        };
        await db.query('UPDATE parents SET last_login = ? WHERE id = ?', [nowDateTime(), parent.id]);
        return res.redirect('/parent/app');
    } catch (err) {
        console.error('Parent login error:', err);
        return renderParentAuth(res, 'parent_login', {
            error: 'A server error occurred. Please try again.',
            values: { identifier }
        });
    }
});

router.get('/parent-register', (req, res) => {
    if (req.session.user && req.session.user.role === 'parent') return res.redirect('/parent/app');
    return renderParentAuth(res, 'parent_register');
});

router.post('/parent-register', async (req, res) => {
    const guardianName = String(req.body.guardian_name || '').trim();
    const contactNumber = String(req.body.contact_number || '').trim();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirm_password || '');
    const normalized = normalizeContact(contactNumber);
    const values = { guardian_name: guardianName, contact_number: contactNumber, username };
    if (!guardianName || !contactNumber || !password || !confirmPassword) {
        return renderParentAuth(res, 'parent_register', { error: 'Please complete all required fields.', values });
    }
    if (password.length < 6) {
        return renderParentAuth(res, 'parent_register', { error: 'Password must be at least 6 characters.', values });
    }
    if (password !== confirmPassword) {
        return renderParentAuth(res, 'parent_register', { error: 'Passwords do not match.', values });
    }
    try {
        if (!(await contactExistsForStudent(normalized))) {
            return renderParentAuth(res, 'parent_register', {
                error: 'This contact number is not registered. Please contact the school adviser or administrator.',
                values
            });
        }
        const account = await createOrReactivateParentAccount({
            guardianName,
            contactNumber,
            normalized,
            username,
            password
        });
        req.session.user = {
            id: account.id,
            parent_id: account.id,
            username: username || contactNumber,
            fullname: guardianName,
            role: 'parent',
            contact_number: contactNumber,
            normalized_contact: normalized
        };
        return res.redirect('/parent/app');
    } catch (err) {
        if (err.code === 'PARENT_EXISTS' || err.code === 'PARENT_DELETED' || err.code === 'USERNAME_EXISTS') {
            return renderParentAuth(res, 'parent_register', { error: err.message, values });
        }
        console.error('Parent registration error:', err);
        return renderParentAuth(res, 'parent_register', { error: 'A server error occurred. Please try again.', values });
    }
});

router.get('/parent/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/parent-login'));
});

router.get('/parent/app', requireParentAuth, async (req, res) => {
    const branding = await loadBranding().catch(() => ({}));
    return res.render('parent_app', {
        title: 'EduTrack Guardian App',
        parent: req.session.user,
        branding
    });
});

// ---- JSON auth for the native parent app (cookie session, same as web) ----
router.post('/api/parent/login', async (req, res) => {
    const identifier = String(req.body.identifier || '').trim();
    const password = String(req.body.password || '');
    if (!identifier || !password) {
        return res.status(400).json({ success: false, error: 'Please enter your mobile number or username and password.' });
    }
    const normalized = normalizeContact(identifier);
    try {
        const [rows] = await db.query(
            "SELECT * FROM parents WHERE status = 'active' AND (username = ? OR normalized_contact = ?) LIMIT 1",
            [identifier, normalized]
        );
        if (rows.length === 0) {
            const [removedRows] = await db.query(
                "SELECT status FROM parents WHERE username = ? OR normalized_contact = ? LIMIT 1",
                [identifier, normalized]
            );
            if (removedRows[0] && removedRows[0].status === 'deleted') {
                return res.status(403).json({
                    success: false,
                    code: 'PARENT_DELETED',
                    error: 'This Guardian account was removed by the administrator. Please contact the school adviser or administrator.'
                });
            }
            if (isContactLike(identifier) && !(await contactExistsForStudent(normalized))) {
                return res.status(404).json({ success: false, error: 'This contact number is not registered. Please contact the school adviser or administrator.' });
            }
            return res.status(404).json({ success: false, error: 'Parent account not found. Please register first using your registered guardian contact number.' });
        }
        const parent = rows[0];
        const match = await bcrypt.compare(password, parent.password);
        if (!match) {
            return res.status(401).json({ success: false, error: 'Invalid mobile number/username or password.' });
        }
        req.session.user = {
            id: parent.id,
            parent_id: parent.id,
            username: parent.username || parent.contact_number,
            fullname: parent.guardian_name,
            role: 'parent',
            contact_number: parent.contact_number,
            normalized_contact: parent.normalized_contact
        };
        await db.query('UPDATE parents SET last_login = ? WHERE id = ?', [nowDateTime(), parent.id]);
        return res.json({
            success: true,
            parent: { id: parent.id, guardian_name: parent.guardian_name, contact_number: parent.contact_number, username: parent.username || '' }
        });
    } catch (err) {
        console.error('Parent API login error:', err);
        return res.status(500).json({ success: false, error: 'A server error occurred. Please try again.' });
    }
});

router.post('/api/parent/register', async (req, res) => {
    const guardianName = String(req.body.guardian_name || '').trim();
    const contactNumber = String(req.body.contact_number || '').trim();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirm_password || '');
    const normalized = normalizeContact(contactNumber);
    if (!guardianName || !contactNumber || !password || !confirmPassword) {
        return res.status(400).json({ success: false, error: 'Please complete all required fields.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
    }
    if (password !== confirmPassword) {
        return res.status(400).json({ success: false, error: 'Passwords do not match.' });
    }
    try {
        if (!(await contactExistsForStudent(normalized))) {
            return res.status(404).json({ success: false, error: 'This contact number is not registered. Please contact the school adviser or administrator.' });
        }
        const account = await createOrReactivateParentAccount({
            guardianName,
            contactNumber,
            normalized,
            username,
            password
        });
        req.session.user = {
            id: account.id,
            parent_id: account.id,
            username: username || contactNumber,
            fullname: guardianName,
            role: 'parent',
            contact_number: contactNumber,
            normalized_contact: normalized
        };
        return res.json({
            success: true,
            parent: { id: account.id, guardian_name: guardianName, contact_number: contactNumber, username: username || '' }
        });
    } catch (err) {
        if (err.code === 'PARENT_EXISTS' || err.code === 'PARENT_DELETED' || err.code === 'USERNAME_EXISTS') {
            return res.status(409).json({ success: false, code: err.code, error: err.message });
        }
        console.error('Parent API register error:', err);
        return res.status(500).json({ success: false, error: 'A server error occurred. Please try again.' });
    }
});

router.post('/api/parent/logout', async (req, res) => {
    const deviceToken = String(req.body.device_token || '').trim();
    const parentId = req.session && req.session.user && (req.session.user.parent_id || req.session.user.id);
    try {
        if (deviceToken && parentId) {
            await db.query('DELETE FROM parent_devices WHERE parent_id = ? AND device_token = ?', [parentId, deviceToken]);
        }
    } catch (err) {
        console.error('Parent device logout cleanup error:', err);
    }
    req.session.destroy(() => res.json({ success: true }));
});

router.get('/api/parent/me', requireParentAuth, (req, res) => {
    const u = req.session.user;
    return res.json({
        id: u.id,
        guardian_name: u.fullname,
        contact_number: u.contact_number,
        username: u.username || ''
    });
});

router.get('/api/parent/branding', requireParentAuth, async (req, res) => {
    try {
        const branding = await loadBranding();
        return res.json({
            system_logo: branding.system_logo || '',
            system_name: branding.system_name || 'EduTrack',
            division_name: branding.division_name || 'Schools Division of Sipalay City',
            mobile_dashboard_school_art: branding.mobile_dashboard_school_art || ''
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to load parent app branding.' });
    }
});

// Public branding (no login) so the splash/login screen can show the
// admin-uploaded school logo before the guardian signs in.
router.get('/api/parent/public-branding', async (req, res) => {
    try {
        const branding = await loadBranding();
        return res.json({
            system_logo: branding.system_logo || '',
            system_name: branding.system_name || 'EduTrack',
            division_name: branding.division_name || 'Schools Division of Sipalay City'
        });
    } catch (err) {
        return res.json({});
    }
});

router.get('/api/parent/dashboard', requireParentAuth, async (req, res) => {
    try {
        const date = req.query.date || todayDate();
        const payload = await buildParentPayload(req.session.user, date);
        return res.json(payload);
    } catch (err) {
        console.error('Parent dashboard error:', err);
        return res.status(500).json({ error: 'Failed to load parent dashboard.' });
    }
});

// Tiny change detector for the open web Guardian app. Native Android receives
// the same changes instantly through FCM and uses a slow full-refresh fallback.
router.get('/api/parent/poll', requireParentAuth, async (req, res) => {
    try {
        const parentId = req.session.user.parent_id || req.session.user.id;
        const [[summary]] = await db.query(
            `SELECT
                (SELECT COALESCE(MAX(id), 0) FROM parent_notifications WHERE parent_id = ?) AS latest_notification_id,
                (SELECT COUNT(*) FROM parent_notifications WHERE parent_id = ? AND is_read = 0) AS unread_count`,
            [parentId, parentId]
        );
        res.set('Cache-Control', 'no-store');
        return res.json({
            latest_notification_id: Number(summary?.latest_notification_id || 0),
            unread_count: Number(summary?.unread_count || 0)
        });
    } catch (err) {
        console.error('Parent poll error:', err);
        return res.status(500).json({ error: 'Failed to check for updates.' });
    }
});

router.get('/api/parent/notifications', requireParentAuth, async (req, res) => {
    try {
        const date = req.query.date || todayDate();
        const payload = await buildParentPayload(req.session.user, date);
        return res.json({ notifications: payload.notifications, unread_count: payload.unread_count || 0 });
    } catch (err) {
        console.error('Parent notifications error:', err);
        return res.status(500).json({ error: 'Failed to load parent notifications.' });
    }
});

router.post('/api/parent/device-token', requireParentAuth, async (req, res) => {
    const deviceToken = String(req.body.device_token || '').trim();
    if (!deviceToken) return res.status(400).json({ success: false, error: 'Device token is required.' });
    try {
        await registerParentDevice({
            parentId: req.session.user.parent_id || req.session.user.id,
            contactNumber: req.session.user.contact_number,
            normalizedContact: req.session.user.normalized_contact,
            deviceToken,
            pushToken: String(req.body.push_token || '').trim() || null,
            platform: String(req.body.platform || '').trim() || 'android',
            appVersion: String(req.body.app_version || '').trim(),
            deviceName: String(req.body.device_name || '').trim(),
            userAgent: req.get('user-agent') || ''
        });
        return res.json({ success: true });
    } catch (err) {
        console.error('Parent device token error:', err);
        return res.status(500).json({ success: false, error: 'Failed to save notification device.' });
    }
});

// Token-authenticated inbox for Android WorkManager. This keeps Guardian alerts
// available after the UI process is closed or its cookie session expires.
router.post('/api/parent/device-notifications', async (req, res) => {
    const deviceToken = String(req.body.device_token || '').trim();
    if (deviceToken.length < 32) {
        return res.status(401).json({ success: false, error: 'Invalid notification device.' });
    }
    try {
        const [[device]] = await db.query(
            `SELECT
                pd.parent_id,
                p.id,
                p.guardian_name,
                p.contact_number,
                p.normalized_contact,
                p.username,
                p.status
             FROM parent_devices pd
             INNER JOIN parents p ON p.id = pd.parent_id
             WHERE pd.device_token = ?
             LIMIT 1`,
            [deviceToken]
        );
        if (!device || device.status !== 'active') {
            return res.status(401).json({ success: false, error: 'Notification device is not registered.' });
        }
        await db.query('UPDATE parent_devices SET last_seen_at = ?, updated_at = CURRENT_TIMESTAMP WHERE device_token = ?', [nowDateTime(), deviceToken]);
        const payload = await buildParentPayload(device, todayDate());
        return res.json({
            success: true,
            notifications: payload.notifications || [],
            unread_count: payload.unread_count || 0
        });
    } catch (err) {
        console.error('Parent background notifications error:', err);
        return res.status(500).json({ success: false, error: 'Failed to load background notifications.' });
    }
});

router.post('/api/parent/notifications/read', requireParentAuth, async (req, res) => {
    try {
        const ids = Array.isArray(req.body.notification_ids)
            ? req.body.notification_ids
            : (req.body.notification_id ? [req.body.notification_id] : null);
        const changed = await markParentNotificationsRead(req.session.user.parent_id || req.session.user.id, ids);
        const unread_count = await getParentUnreadCount(req.session.user.parent_id || req.session.user.id);
        return res.json({ success: true, changed, unread_count });
    } catch (err) {
        console.error('Parent notification read error:', err);
        return res.status(500).json({ success: false, error: 'Failed to mark notifications as read.' });
    }
});

router.post('/api/parent/change-password', requireParentAuth, async (req, res) => {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    const confirm = String(req.body.confirm_password || '');
    if (!current || !next || !confirm) {
        return res.status(400).json({ success: false, error: 'Please complete all password fields.' });
    }
    if (next.length < 6) {
        return res.status(400).json({ success: false, error: 'New password must be at least 6 characters.' });
    }
    if (next !== confirm) {
        return res.status(400).json({ success: false, error: 'New passwords do not match.' });
    }
    try {
        const [[parent]] = await db.query('SELECT id, password FROM parents WHERE id = ? LIMIT 1', [req.session.user.parent_id]);
        if (!parent) return res.status(404).json({ success: false, error: 'Account not found.' });
        const ok = await bcrypt.compare(current, parent.password);
        if (!ok) return res.status(401).json({ success: false, error: 'Your current password is incorrect.' });
        const hashed = await bcrypt.hash(next, 10);
        await db.query('UPDATE parents SET password = ? WHERE id = ?', [hashed, parent.id]);
        return res.json({ success: true });
    } catch (err) {
        console.error('Parent change-password error:', err);
        return res.status(500).json({ success: false, error: 'A server error occurred. Please try again.' });
    }
});

// Update guardian profile (name, contact number, username). A changed contact
// number cascades to every linked student's guardian_contact so the parent stays
// linked to their children AND advisers/principals see the new number when they
// contact the parent. Wrapped in a transaction to avoid orphaning the account.
router.post('/api/parent/profile', requireParentAuth, async (req, res) => {
    const guardianName = String(req.body.guardian_name || '').trim();
    const contactNumber = String(req.body.contact_number || '').trim();
    const username = String(req.body.username || '').trim();
    if (!guardianName) {
        return res.status(400).json({ success: false, error: 'Your name is required.' });
    }
    if (!isContactLike(contactNumber)) {
        return res.status(400).json({ success: false, error: 'Please enter a valid contact number.' });
    }
    const newNormalized = normalizeContact(contactNumber);
    const parentId = req.session.user.parent_id || req.session.user.id;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [[parent]] = await conn.query('SELECT * FROM parents WHERE id = ? LIMIT 1', [parentId]);
        if (!parent) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Account not found.' });
        }
        const oldNormalized = parent.normalized_contact;

        if (newNormalized !== oldNormalized) {
            const [dups] = await conn.query('SELECT id FROM parents WHERE normalized_contact = ? AND id != ? LIMIT 1', [newNormalized, parentId]);
            if (dups.length) {
                await conn.rollback();
                return res.status(409).json({ success: false, error: 'This contact number is already used by another parent account.' });
            }
        }
        if (username) {
            const [dupU] = await conn.query('SELECT id FROM parents WHERE username = ? AND id != ? LIMIT 1', [username, parentId]);
            if (dupU.length) {
                await conn.rollback();
                return res.status(409).json({ success: false, error: 'This username is already taken.' });
            }
        }

        await conn.query(
            'UPDATE parents SET guardian_name = ?, contact_number = ?, normalized_contact = ?, username = ? WHERE id = ?',
            [guardianName, contactNumber, newNormalized, username || null, parentId]
        );

        // Cascade the new contact + name to the students currently linked by the
        // old number (normalizeContact is JS logic, so compare in app code).
        const [students] = await conn.query(
            `SELECT id, guardian_contact FROM students
             WHERE status != 'deleted' AND guardian_contact IS NOT NULL AND guardian_contact != ''`
        );
        const linkedIds = students
            .filter(s => contactMatches(s.guardian_contact, oldNormalized))
            .map(s => s.id);
        if (linkedIds.length) {
            await conn.query(
                'UPDATE students SET guardian_contact = ?, guardian_name = ? WHERE id IN (?)',
                [contactNumber, guardianName, linkedIds]
            );
        }

        await conn.commit();
        // Keep the session in sync so the dynamic child-linking uses the new number.
        req.session.user.fullname = guardianName;
        req.session.user.contact_number = contactNumber;
        req.session.user.normalized_contact = newNormalized;
        req.session.user.username = username || contactNumber;
        return res.json({
            success: true,
            parent: { id: parentId, guardian_name: guardianName, contact_number: contactNumber, username: username || '' },
            linked_students: linkedIds.length
        });
    } catch (err) {
        try { await conn.rollback(); } catch (_) { /* connection already closed */ }
        console.error('Parent profile update error:', err);
        return res.status(500).json({ success: false, error: 'Failed to update your profile. Please try again.' });
    } finally {
        conn.release();
    }
});

// Latest published parent-app version. Bump this (and the Flutter pubspec version)
// whenever a new APK is released so the in-app updater offers the update.
const PARENT_APP_LATEST = { version: '1.0.48', version_code: 50 };
router.get('/api/parent/app-version', (req, res) => {
    return res.json({
        latest_version: PARENT_APP_LATEST.version,
        latest_version_code: PARENT_APP_LATEST.version_code,
        apk_url: `${req.protocol}://${req.get('host')}/download/parent-app?v=${PARENT_APP_LATEST.version_code}`,
        notes: 'Push-triggered dashboard updates keep notifications immediate while greatly reducing background data use.'
    });
});

module.exports = router;
