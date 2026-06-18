const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const db = require('../config/database');
const { requireAuth, requireRole, applySchoolFilter } = require('../middleware/auth');
const { getScannerKioskToken, getScannerKioskTokenFromRequest, isValidScannerKioskToken } = require('../utils/scannerKiosk');
const {
    todayDate,
    nowDateTime,
    timestampForFilename,
    normalizeTime,
    sqlDateTime,
    compareDateTime,
    secondsBetween,
    formatTime12
} = require('../utils/appTime');
const { computeDailyAttendanceStatus, statusLabel, decorateLateHalfDays, isLateHalfDay } = require('../utils/attendanceStatus');

function requireAuthOrScannerKiosk(req, res, next) {
    if (req.session && req.session.user) return next();
    if (isValidScannerKioskToken(getScannerKioskTokenFromRequest(req))) return next();
    return res.status(401).json({ error: 'Not authenticated' });
}

function getPublicBaseUrl(req) {
    const configured = process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    const normalized = String(configured || '').replace(/\/+$/, '');
    if (normalized && !/localhost|127\.0\.0\.1/i.test(normalized)) return normalized;
    return `${req.protocol}://${req.get('host') || ''}`.replace(/\/+$/, '');
}

function normalizeOptionalSchoolId(value) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function deriveTrackFromSection(sectionName) {
    const raw = String(sectionName || '').trim();
    const match = raw.match(/^(STEM|ABM|HUMSS|GAS|TVL(?:-[A-Z]+)?|Sports|Arts(?:\s+and\s+| & )Design)\s*-\s*(.+)$/i);
    if (!match) return '';
    const label = match[1].replace(/\s*&\s*/g, ' and ');
    const upper = label.toUpperCase();
    if (upper === 'ARTS AND DESIGN') return 'Arts and Design';
    if (upper.startsWith('TVL-')) return 'TVL';
    return upper === 'SPORTS' ? 'Sports' : upper;
}

async function getScannerDesktopSummary(schoolId) {
    const today = todayDate();
    let totalQuery = `
        SELECT
            COALESCE(SUM(CASE WHEN time_in IS NOT NULL THEN 1 ELSE 0 END), 0)
            + COALESCE(SUM(CASE WHEN time_out IS NOT NULL THEN 1 ELSE 0 END), 0) AS total_scans
        FROM attendance
        WHERE date = ?`;
    const totalParams = [today];
    if (schoolId) {
        totalQuery += ' AND school_id = ?';
        totalParams.push(schoolId);
    }

    let latestQuery = `
        SELECT
            a.person_type,
            a.time_in,
            a.time_out,
            a.status,
            sc.name AS school_name,
            CASE
                WHEN a.person_type = 'student' THEN CONCAT_WS(' ', s.firstname, s.lastname)
                ELSE CONCAT_WS(' ', t.firstname, t.lastname)
            END AS person_name
        FROM attendance a
        LEFT JOIN students s ON a.person_type = 'student' AND a.person_id = s.id
        LEFT JOIN teachers t ON a.person_type = 'teacher' AND a.person_id = t.id
        LEFT JOIN schools sc ON a.school_id = sc.id
        WHERE a.date = ?`;
    const latestParams = [today];
    if (schoolId) {
        latestQuery += ' AND a.school_id = ?';
        latestParams.push(schoolId);
    }
    latestQuery += ' ORDER BY COALESCE(a.updated_at, a.time_out, a.time_in, a.created_at) DESC LIMIT 1';

    const [[totalRow], [latestRows]] = await Promise.all([
        db.query(totalQuery, totalParams),
        db.query(latestQuery, latestParams)
    ]);

    const latestRecord = latestRows[0]
        ? {
            name: latestRows[0].person_name || 'Attendance Record',
            type: latestRows[0].person_type || 'person',
            school: latestRows[0].school_name || 'N/A',
            action: latestRows[0].time_out ? 'TIME_OUT' : 'TIME_IN',
            time: formatTime12(latestRows[0].time_out || latestRows[0].time_in),
            status: latestRows[0].status || 'present'
        }
        : null;

    return {
        today,
        todayScanCount: totalRow[0]?.total_scans || 0,
        lastRecord: latestRecord
    };
}

async function getScannerDesktopDirectory(schoolId) {
    const studentParams = [];
    const teacherParams = [];

    let studentQuery = `
        SELECT
            s.id AS person_id,
            s.qr_code,
            'student' AS person_type,
            s.category,
            s.lrn AS person_code,
            CONCAT_WS(' ', s.firstname, s.lastname) AS person_name,
            s.school_id,
            sc.name AS school_name,
            gl.name AS grade_name,
            sec.name AS section_name,
            COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) AS adviser,
            at.contact AS adviser_contact,
            at.email AS adviser_email,
            s.status AS person_status,
            COALESCE(s.updated_at, s.created_at) AS updated_at
        FROM students s
        LEFT JOIN schools sc ON s.school_id = sc.id
        LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
        LEFT JOIN sections sec ON s.section_id = sec.id
        LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
        WHERE s.qr_code IS NOT NULL
          AND s.qr_code <> ''
          AND s.status <> 'deleted'`;

    let teacherQuery = `
        SELECT
            t.id AS person_id,
            t.qr_code,
            'teacher' AS person_type,
            t.category,
            t.employee_id AS person_code,
            CONCAT_WS(' ', t.firstname, t.lastname) AS person_name,
            t.school_id,
            sc.name AS school_name,
            gl.name AS grade_name,
            sec.name AS section_name,
            COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) AS adviser,
            at.contact AS adviser_contact,
            at.email AS adviser_email,
            t.status AS person_status,
            COALESCE(t.updated_at, t.created_at) AS updated_at
        FROM teachers t
        LEFT JOIN schools sc ON t.school_id = sc.id
        LEFT JOIN grade_levels gl ON t.grade_level_id = gl.id
        LEFT JOIN sections sec ON t.section_id = sec.id
        LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
        WHERE t.qr_code IS NOT NULL
          AND t.qr_code <> ''
          AND t.status <> 'deleted'`;

    if (schoolId) {
        studentQuery += ' AND s.school_id = ?';
        teacherQuery += ' AND t.school_id = ?';
        studentParams.push(schoolId);
        teacherParams.push(schoolId);
    }

    studentQuery += ' ORDER BY sc.name, person_name';
    teacherQuery += ' ORDER BY sc.name, person_name';

    const [[students], [teachers]] = await Promise.all([
        db.query(studentQuery, studentParams),
        db.query(teacherQuery, teacherParams)
    ]);

    return [...students, ...teachers].map((row) => ({
        personId: row.person_id,
        qrCode: row.qr_code,
        personType: row.person_type,
        category: row.category || null,
        personCode: row.person_code || '',
        name: row.person_name || 'Attendance Record',
        schoolId: row.school_id || null,
        school: row.school_name || 'N/A',
        grade: row.grade_name || 'N/A',
        section: row.section_name || 'N/A',
        adviser: row.adviser || 'N/A',
        adviserContact: row.adviser_contact || '',
        adviserEmail: row.adviser_email || '',
        personStatus: row.person_status || 'active',
        updatedAt: row.updated_at || nowDateTime()
    }));
}

function normalizeDirectoryVersionDate(value) {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

async function getScannerDesktopDirectoryVersion(schoolId) {
    const studentParams = [];
    const teacherParams = [];

    let studentQuery = `
        SELECT
            COUNT(*) AS person_count,
            MAX(GREATEST(
                COALESCE(s.updated_at, s.created_at, '1970-01-01 00:00:00'),
                COALESCE(sc.updated_at, sc.created_at, '1970-01-01 00:00:00'),
                COALESCE(gl.created_at, '1970-01-01 00:00:00'),
                COALESCE(sec.created_at, '1970-01-01 00:00:00')
            )) AS latest_update,
            COALESCE(SUM(CRC32(CONCAT_WS('|',
                s.id,
                COALESCE(s.qr_code, ''),
                COALESCE(s.lrn, ''),
                COALESCE(s.firstname, ''),
                COALESCE(s.lastname, ''),
                COALESCE(s.middlename, ''),
                COALESCE(s.gender, ''),
                COALESCE(s.birthdate, ''),
                COALESCE(s.guardian_name, ''),
                COALESCE(s.guardian_contact, ''),
                COALESCE(s.category, ''),
                COALESCE(s.status, ''),
                COALESCE(s.school_id, ''),
                COALESCE(sc.name, ''),
                COALESCE(gl.name, ''),
                COALESCE(sec.name, ''),
                COALESCE(sec.adviser, ''),
                COALESCE(sec.adviser_teacher_id, ''),
                COALESCE(at.firstname, ''),
                COALESCE(at.lastname, ''),
                COALESCE(at.middlename, ''),
                COALESCE(at.contact, ''),
                COALESCE(at.email, '')
            ))), 0) AS checksum
        FROM students s
        LEFT JOIN schools sc ON s.school_id = sc.id
        LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
        LEFT JOIN sections sec ON s.section_id = sec.id
        LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
        WHERE s.qr_code IS NOT NULL
          AND s.qr_code <> ''
          AND s.status <> 'deleted'`;

    let teacherQuery = `
        SELECT
            COUNT(*) AS person_count,
            MAX(GREATEST(
                COALESCE(t.updated_at, t.created_at, '1970-01-01 00:00:00'),
                COALESCE(sc.updated_at, sc.created_at, '1970-01-01 00:00:00'),
                COALESCE(gl.created_at, '1970-01-01 00:00:00'),
                COALESCE(sec.created_at, '1970-01-01 00:00:00')
            )) AS latest_update,
            COALESCE(SUM(CRC32(CONCAT_WS('|',
                t.id,
                COALESCE(t.qr_code, ''),
                COALESCE(t.employee_id, ''),
                COALESCE(t.firstname, ''),
                COALESCE(t.lastname, ''),
                COALESCE(t.middlename, ''),
                COALESCE(t.contact, ''),
                COALESCE(t.email, ''),
                COALESCE(t.category, ''),
                COALESCE(t.status, ''),
                COALESCE(t.school_id, ''),
                COALESCE(sc.name, ''),
                COALESCE(gl.name, ''),
                COALESCE(sec.name, ''),
                COALESCE(sec.adviser, ''),
                COALESCE(sec.adviser_teacher_id, ''),
                COALESCE(at.firstname, ''),
                COALESCE(at.lastname, ''),
                COALESCE(at.middlename, ''),
                COALESCE(at.contact, ''),
                COALESCE(at.email, '')
            ))), 0) AS checksum
        FROM teachers t
        LEFT JOIN schools sc ON t.school_id = sc.id
        LEFT JOIN grade_levels gl ON t.grade_level_id = gl.id
        LEFT JOIN sections sec ON t.section_id = sec.id
        LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
        WHERE t.qr_code IS NOT NULL
          AND t.qr_code <> ''
          AND t.status <> 'deleted'`;

    if (schoolId) {
        studentQuery += ' AND s.school_id = ?';
        teacherQuery += ' AND t.school_id = ?';
        studentParams.push(schoolId);
        teacherParams.push(schoolId);
    }

    const [[studentRows], [teacherRows]] = await Promise.all([
        db.query(studentQuery, studentParams),
        db.query(teacherQuery, teacherParams)
    ]);

    const student = studentRows[0] || {};
    const teacher = teacherRows[0] || {};
    const studentCount = Number(student.person_count || 0);
    const teacherCount = Number(teacher.person_count || 0);
    const studentLatest = normalizeDirectoryVersionDate(student.latest_update);
    const teacherLatest = normalizeDirectoryVersionDate(teacher.latest_update);
    const studentChecksum = String(student.checksum || 0);
    const teacherChecksum = String(teacher.checksum || 0);
    const latestUpdate = [studentLatest, teacherLatest].filter(Boolean).sort().pop() || null;
    const directoryVersion = crypto
        .createHash('sha256')
        .update([schoolId || 'all', studentCount, studentLatest, studentChecksum, teacherCount, teacherLatest, teacherChecksum].join('|'))
        .digest('hex');

    return {
        directoryVersion,
        peopleCount: studentCount + teacherCount,
        latestUpdate
    };
}

function normalizeKioskScanTime(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    const hour = match[4].padStart(2, '0');
    const second = match[6] || '00';
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    return {
        date,
        dateTime: `${date} ${hour}:${match[5]}:${second}`
    };
}

// Outage forgiveness: the desktop scanner sends grace_anchor_time = the moment a
// power/app outage began. For a person's FIRST scan we judge late/half-day
// against this anchor (the last time they could have scanned) instead of the
// catch-up scan time. Must be the same day and not in the future to be honored.
function normalizeKioskGraceAnchor(value, today, now) {
    const parsed = normalizeKioskScanTime(value);
    if (!parsed) return null;
    if (parsed.date !== today) return null;
    if (compareDateTime(parsed.dateTime, now) > 0) return null;
    return parsed.dateTime;
}

// POST /api/scanner-admin-login
// Validates admin credentials from the desktop scanner settings screen.
// Uses the same accounts as the Web Admin Dashboard — no separate kiosk accounts.
router.post('/scanner-admin-login', async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password are required.' });
    }
    try {
        const [rows] = await db.query(
            "SELECT id, username, fullname, role, school_id, password FROM users WHERE username = ? AND status = 'active'",
            [username]
        );
        if (!rows.length) {
            return res.json({ success: false, error: 'Invalid username or password.' });
        }
        const user = rows[0];
        const allowedRoles = ['super_admin', 'superintendent', 'asst_superintendent', 'principal'];
        if (!allowedRoles.includes(user.role)) {
            return res.json({ success: false, error: 'Access denied. An administrator account is required to configure scanner settings.' });
        }
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.json({ success: false, error: 'Invalid username or password.' });
        }
        return res.json({
            success: true,
            admin: {
                id: user.id,
                username: user.username,
                fullname: user.fullname,
                role: user.role,
                school_id: user.school_id
            }
        });
    } catch (err) {
        console.error('Scanner admin login error:', err);
        return res.status(500).json({ success: false, error: 'Server error during authentication. Please try again.' });
    }
});

router.get('/scanner-desktop-config', async (req, res) => {
    try {
        const schoolId = normalizeOptionalSchoolId(req.query.school_id);
        const [settingsRows] = await db.query(
            `SELECT setting_key, setting_value
             FROM settings
             WHERE setting_key IN (
                'system_name',
                'division_name',
                'system_logo',
                'am_time_in_end',
                'am_late_time',
                'pm_time_out_end',
                'lunch_break_start',
                'pm_time_in_start',
                'pm_late_time',
                'late_threshold',
                'teacher_duty_start_time',
                'teacher_duty_end_time',
                'teacher_late_threshold',
                'student_attendance_rule',
                'teacher_attendance_rule',
                'teacher_time_out_rule',
                'absence_cutoff_time',
                'attendance_policy'
             )`
        );
        const settings = {};
        settingsRows.forEach(row => { settings[row.setting_key] = row.setting_value; });

        const [[schools], summary] = await Promise.all([
            db.query("SELECT id, name, logo FROM schools WHERE status = 'active' ORDER BY name"),
            getScannerDesktopSummary(schoolId)
        ]);

        return res.json({
            success: true,
            baseUrl: getPublicBaseUrl(req),
            kioskToken: getScannerKioskToken(),
            serverTime: nowDateTime(),
            today: todayDate(),
            settings,
            schools,
            summary
        });
    } catch (err) {
        console.error('Scanner desktop config error:', err);
        return res.status(500).json({ success: false, error: 'Failed to load scanner desktop configuration.' });
    }
});

router.get('/scanner-desktop-directory', requireAuthOrScannerKiosk, async (req, res) => {
    try {
        const schoolId = normalizeOptionalSchoolId(req.query.school_id);
        const [people, directoryMeta] = await Promise.all([
            getScannerDesktopDirectory(schoolId),
            getScannerDesktopDirectoryVersion(schoolId)
        ]);
        return res.json({
            success: true,
            generatedAt: nowDateTime(),
            ...directoryMeta,
            people
        });
    } catch (err) {
        console.error('Scanner desktop directory error:', err);
        return res.status(500).json({ success: false, error: 'Failed to load scanner desktop directory.' });
    }
});

router.get('/scanner-desktop-directory-version', requireAuthOrScannerKiosk, async (req, res) => {
    try {
        const schoolId = normalizeOptionalSchoolId(req.query.school_id);
        const directoryMeta = await getScannerDesktopDirectoryVersion(schoolId);
        return res.json({
            success: true,
            generatedAt: nowDateTime(),
            ...directoryMeta
        });
    } catch (err) {
        console.error('Scanner desktop directory version error:', err);
        return res.status(500).json({ success: false, error: 'Failed to check scanner directory updates.' });
    }
});

// Logo upload config. Logos are stored as data URLs so Railway redeploys do not wipe uploaded files.
const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Only image files are allowed (jpg, png, gif, webp).'));
    }
});

// =============================================
// School-day helpers
// =============================================
function holidayTypeLabel(type) {
    const value = Number(type);
    if (value === 2) return 'Class Suspension';
    if (value === 0) return 'Special Non-Working Day';
    return 'Regular Holiday';
}

async function checkSchoolDay(dateStr, schoolId) {
    // 1. Manual override in school_days table (highest priority)
    const [sdRows] = await db.query('SELECT * FROM school_days WHERE date = ?', [dateStr]);
    if (sdRows.length > 0) {
        return {
            isSchoolDay: !!sdRows[0].is_school_day,
            reason: sdRows[0].reason || (sdRows[0].is_school_day ? null : 'Non-school day'),
            type: sdRows[0].is_school_day ? null : 'Non-school Day'
        };
    }
    // 2. Weekend check
    const dayOfWeek = new Date(dateStr + 'T00:00:00').getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        return { isSchoolDay: false, reason: dayOfWeek === 0 ? 'Sunday' : 'Saturday', type: 'Weekend' };
    }
    // 3. Holidays table (national + school-specific)
    let hQuery = 'SELECT * FROM holidays WHERE holiday_date = ? AND (school_id IS NULL';
    const hParams = [dateStr];
    if (schoolId) { hQuery += ' OR school_id = ?'; hParams.push(schoolId); }
    hQuery += ') LIMIT 1';
    const [holidays] = await db.query(hQuery, hParams);
    if (holidays.length > 0) {
        return {
            isSchoolDay: false,
            reason: holidays[0].name || holidayTypeLabel(holidays[0].is_national),
            type: holidayTypeLabel(holidays[0].is_national)
        };
    }
    return { isSchoolDay: true, reason: null, type: null };
}

function addMinutes(dateObj, minutes) {
    return new Date(dateObj.getTime() + (Number(minutes) || 0) * 60000);
}

function normalizeTimeSetting(value, fallback) {
    return normalizeTime(value, fallback);
}

function nonSchoolDayScanMessage(schoolDay) {
    const type = schoolDay?.type || 'Non-school Day';
    const reason = schoolDay?.reason;
    return 'No attendance scanning today: ' + type + (reason ? ' - ' + reason : '') + '.';
}

function cleanScannedQrValue(value) {
    return String(value || '')
        .replace(/^\uFEFF/, '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim();
}

function addQrCandidate(candidates, value) {
    const cleaned = cleanScannedQrValue(value);
    if (!cleaned) return;
    candidates.add(cleaned);
    try {
        const decoded = cleanScannedQrValue(decodeURIComponent(cleaned));
        if (decoded) candidates.add(decoded);
    } catch (_err) {
        // Not URI encoded; keep the original candidate only.
    }
}

function getQrLookupCandidates(value) {
    const candidates = new Set();
    addQrCandidate(candidates, value);

    const cleaned = cleanScannedQrValue(value);
    try {
        const parsed = new URL(cleaned);
        ['qr_code', 'qr', 'code', 'q'].forEach(key => addQrCandidate(candidates, parsed.searchParams.get(key)));
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        addQrCandidate(candidates, pathParts[pathParts.length - 1]);
    } catch (_err) {
        // Plain QR payloads are expected; URLs are supported as a convenience.
    }

    Array.from(candidates).forEach(candidate => {
        if (!/^(STU|TCH)-/i.test(candidate)) {
            addQrCandidate(candidates, 'STU-' + candidate);
            addQrCandidate(candidates, 'TCH-' + candidate);
        }
    });

    return Array.from(candidates).slice(0, 12);
}

async function getAttendanceLateThreshold(personType, dateStr) {
    const [rows] = await db.query(
        `SELECT setting_key, setting_value
         FROM settings
         WHERE setting_key IN ('am_time_in_end', 'am_late_time', 'late_threshold', 'teacher_duty_start_time', 'teacher_late_threshold')`
    );
    const settings = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
    const isTeacher = personType === 'teacher';
    // An explicit AM Late Start Time wins as the exact late line (no extra grace).
    // Falls back to "school start + grace" only when no explicit time is configured.
    if (!isTeacher && settings.am_late_time) {
        return new Date(dateStr + 'T' + normalizeTimeSetting(settings.am_late_time, '07:15:00') + '+08:00');
    }
    const baseTime = normalizeTimeSetting(
        isTeacher ? (settings.teacher_duty_start_time || settings.am_time_in_end) : settings.am_time_in_end,
        '07:00:00'
    );
    const graceValue = isTeacher
        ? (settings.teacher_late_threshold ?? settings.late_threshold)
        : settings.late_threshold;
    const graceMinutes = parseInt(graceValue, 10) || 0;
    return addMinutes(new Date(dateStr + 'T' + baseTime + '+08:00'), graceMinutes);
}

// The PM Late cutoff ("HH:MM:SS"). A PM-only arrival on/after this is a late
// half-day. Defaults to 13:15 so the rule is active even before it is saved.
async function getPmLateTime() {
    const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'pm_late_time'");
    return normalizeTimeSetting(rows[0] && rows[0].setting_value, '13:15:00');
}

async function getSchoolDayEndDateTime(dateStr) {
    const [rows] = await db.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('absence_cutoff_time', 'pm_time_out_end')");
    const settings = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
    return sqlDateTime(dateStr, normalizeTimeSetting(settings.absence_cutoff_time || settings.pm_time_out_end, '17:00:00'));
}

// Daily attendance schedule boundaries used to label time-in/time-out transactions.
async function getAttendanceScheduleTimes(dateStr) {
    const [rows] = await db.query(
        `SELECT setting_key, setting_value
         FROM settings
         WHERE setting_key IN ('lunch_break_start', 'pm_time_in_start', 'pm_late_time', 'pm_time_out_end')`
    );
    const settings = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
    return {
        // AM-end / lunch-out boundary: a first arrival on/after this is a PM half-day,
        // and the lunch-out window runs from here to pmInStart. Default 11:00 (AM 7–11).
        lunchStart: sqlDateTime(dateStr, normalizeTimeSetting(settings.lunch_break_start, '11:00:00')),
        pmInStart: sqlDateTime(dateStr, normalizeTimeSetting(settings.pm_time_in_start, '13:00:00')),
        // PM Late Start Time: a PM-only arrival on/after this time is a late half-day
        // ("Half-Day (Late)"). Defaults to 13:15 (matching the settings UI default) so
        // the rule is active out of the box; admins can change it in Settings.
        pmLateStart: sqlDateTime(dateStr, normalizeTimeSetting(settings.pm_late_time, '13:15:00')),
        pmOutStart: sqlDateTime(dateStr, normalizeTimeSetting(settings.pm_time_out_end, '16:00:00'))
    };
}

// A return/PM time-in that lands on or after the PM Late Start Time is shown as
// "PM LATE" instead of "PM PRESENT". Display-only — the stored daily status
// (present / late / half_day) is unchanged, so report totals are unaffected.
function pmLabelFor(label, now, schedule) {
    if (label !== 'PM PRESENT') return label;
    if (schedule.pmLateStart && compareDateTime(now, schedule.pmLateStart) >= 0) return 'PM LATE';
    return label;
}

// Statuses that mean the person is currently OUTSIDE the school after a time-out scan.
const OUTSIDE_MONITORING_STATUSES = ['OUT', 'LUNCH OUT', 'COMPLETED'];

function isCurrentlyInside(attendanceRow) {
    const monitoring = String(attendanceRow.monitoring_status || '').toUpperCase();
    if (monitoring) return !OUTSIDE_MONITORING_STATUSES.includes(monitoring);
    // Legacy rows without monitoring_status: inside unless a time_out was recorded.
    return !attendanceRow.time_out;
}

function timeOutLabelFor(now, schedule) {
    if (compareDateTime(now, schedule.pmOutStart) >= 0) return 'COMPLETED';
    if (compareDateTime(now, schedule.lunchStart) >= 0 && compareDateTime(now, schedule.pmInStart) < 0) return 'LUNCH OUT';
    return 'OUT';
}

function timeInLabelFor(now, schedule) {
    return compareDateTime(now, schedule.pmInStart) >= 0 ? 'PM PRESENT' : 'RETURNED';
}

async function getBaseAttendanceStatus(personType, dateStr, timeIn) {
    if (!timeIn) return 'absent';
    const lateThreshold = await getAttendanceLateThreshold(personType, dateStr);
    return compareDateTime(timeIn, lateThreshold) >= 0 ? 'late' : 'present';
}

async function resolveAttendanceStatus(personType, dateStr, rowState) {
    const timeIn = rowState && rowState.time_in;
    if (!timeIn) {
        return { status: 'absent', label: 'Absent', remarks: 'No attendance recorded for the entire day' };
    }
    const [baseStatus, schedule] = await Promise.all([
        getBaseAttendanceStatus(personType, dateStr, timeIn),
        getAttendanceScheduleTimes(dateStr)
    ]);
    return computeDailyAttendanceStatus({
        timeIn,
        lastTimeIn: rowState.last_time_in || timeIn,
        timeOut: rowState.time_out,
        schedule,
        baseStatus
    });
}

function responseAttendanceMeta(resolved) {
    const status = resolved || {};
    return {
        attendance_status: status.label || statusLabel(status.status),
        half_day_type: status.halfDayType || null,
        late_half_day: !!status.lateHalfDay,
        remarks: status.remarks || ''
    };
}

async function logAttendanceEvent(attendanceId, personType, personId, schoolId, dateStr, event, label, eventTime) {
    try {
        await db.query(
            `INSERT INTO attendance_events
                (attendance_id, person_type, person_id, school_id, date, event, event_label, event_time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [attendanceId, personType, personId, schoolId, dateStr, event, label, eventTime]
        );
    } catch (err) {
        // The audit log must never block attendance recording itself.
        console.error('Attendance event log error:', err);
    }
}

async function hasSchoolDayEnded(dateStr) {
    const today = todayDate();
    if (dateStr < today) return true;
    if (dateStr > today) return false;
    return compareDateTime(nowDateTime(), await getSchoolDayEndDateTime(dateStr)) >= 0;
}

async function shouldCountComputedAbsences(dateStr, schoolId) {
    const today = todayDate();
    if (dateStr > today) return false;
    const schoolDay = await checkSchoolDay(dateStr, schoolId);
    if (!schoolDay.isSchoolDay) return false;
    return hasSchoolDayEnded(dateStr);
}

async function countStudentsWithoutTimeIn(dateStr, schoolId) {
    if (!(await shouldCountComputedAbsences(dateStr, schoolId))) return 0;
    let query = `SELECT COUNT(*) as count
        FROM students s
        WHERE s.status = 'active'
          AND COALESCE(s.active_from, DATE(s.created_at)) < ?
          AND NOT EXISTS (
              SELECT 1 FROM attendance a
              WHERE a.person_type = 'student'
                AND a.person_id = s.id
                AND a.date = ?
                AND a.time_in IS NOT NULL
          )`;
    const params = [dateStr, dateStr];
    if (schoolId) {
        query += ' AND s.school_id = ?';
        params.push(schoolId);
    }
    const [[row]] = await db.query(query, params);
    return row.count || 0;
}

async function countAttendanceEligibleStudents(dateStr, schoolId) {
    let query = `SELECT COUNT(*) as count
        FROM students s
        WHERE s.status = 'active'
          AND COALESCE(s.active_from, DATE(s.created_at)) < ?`;
    const params = [dateStr];
    if (schoolId) {
        query += ' AND s.school_id = ?';
        params.push(schoolId);
    }
    const [[row]] = await db.query(query, params);
    return row.count || 0;
}

async function countTeachersWithoutTimeIn(dateStr, schoolId) {
    if (!(await shouldCountComputedAbsences(dateStr, schoolId))) return 0;
    let query = `SELECT COUNT(*) as count
        FROM teachers t
        WHERE t.status = 'active'
          AND COALESCE(t.active_from, DATE(t.created_at)) < ?
          AND NOT EXISTS (
              SELECT 1 FROM attendance a
              WHERE a.person_type = 'teacher'
                AND a.person_id = t.id
                AND a.date = ?
                AND a.time_in IS NOT NULL
          )`;
    const params = [dateStr, dateStr];
    if (schoolId) {
        query += ' AND t.school_id = ?';
        params.push(schoolId);
    }
    const [[row]] = await db.query(query, params);
    return row.count || 0;
}

async function countAttendanceEligibleTeachers(dateStr, schoolId) {
    let query = `SELECT COUNT(*) as count
        FROM teachers t
        WHERE t.status = 'active'
          AND COALESCE(t.active_from, DATE(t.created_at)) < ?`;
    const params = [dateStr];
    if (schoolId) {
        query += ' AND t.school_id = ?';
        params.push(schoolId);
    }
    const [[row]] = await db.query(query, params);
    return row.count || 0;
}

async function getAttendanceStatusCounts(personType, dateStr, filters = {}) {
    const isTeacher = personType === 'teacher';
    const table = isTeacher ? 'teachers' : 'students';
    const alias = isTeacher ? 't' : 's';
    // Any timed-in attendee is counted in the shared present/attended total.
    // Late and half-day remain separate tallies so dashboards can still show
    // those badges without treating the person as absent.
    let query = `
        SELECT
            COUNT(DISTINCT CASE WHEN a.status IN ('present','late','half_day') THEN a.person_id END) AS present,
            COUNT(DISTINCT CASE WHEN a.status = 'late' THEN a.person_id END) AS late,
            COUNT(DISTINCT CASE WHEN a.status = 'half_day' THEN a.person_id END) AS half_day,
            COUNT(DISTINCT CASE WHEN a.status IN ('present','late','half_day') THEN a.person_id END) AS full_day,
            COUNT(DISTINCT CASE WHEN a.time_in IS NOT NULL THEN a.person_id END) AS timed_in,
            COUNT(DISTINCT CASE WHEN a.time_out IS NOT NULL THEN a.person_id END) AS timed_out
        FROM attendance a
        INNER JOIN ${table} ${alias}
            ON a.person_id = ${alias}.id
           AND a.person_type = ?
           AND ${alias}.status = 'active'
        WHERE a.date = ?
          AND a.time_in IS NOT NULL`;
    const params = [personType, dateStr];

    if (filters.schoolId) {
        query += ' AND a.school_id = ?';
        params.push(filters.schoolId);
    }
    if (!isTeacher && filters.sectionId) {
        query += ' AND s.section_id = ?';
        params.push(filters.sectionId);
    }

    const [[row]] = await db.query(query, params);
    return {
        present: Number(row.present || 0),
        late: Number(row.late || 0),
        half_day: Number(row.half_day || 0),
        full_day: Number(row.full_day || 0),
        timed_in: Number(row.timed_in || 0),
        timed_out: Number(row.timed_out || 0)
    };
}

async function countSectionStudentsWithoutTimeIn(dateStr, sectionId) {
    const [[section]] = await db.query('SELECT school_id FROM sections WHERE id = ? LIMIT 1', [sectionId]);
    const schoolId = section?.school_id || null;
    if (!(await shouldCountComputedAbsences(dateStr, schoolId))) return 0;
    const [[row]] = await db.query(`SELECT COUNT(*) as count
        FROM students s
        WHERE s.status = 'active'
          AND s.section_id = ?
          AND COALESCE(s.active_from, DATE(s.created_at)) < ?
          AND NOT EXISTS (
              SELECT 1 FROM attendance a
              WHERE a.person_type = 'student'
                AND a.person_id = s.id
                AND a.date = ?
                AND a.time_in IS NOT NULL
          )`, [sectionId, dateStr, dateStr]);
    return row.count || 0;
}

function displayPersonName(firstname, lastname, middlename) {
    return [firstname, middlename ? middlename.charAt(0) + '.' : '', lastname]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function validateTeacherAssignment({ teacherId, schoolId, gradeLevelId, sectionId }) {
    if (!sectionId) return null;
    const [[section]] = await db.query(
        'SELECT id, name, school_id, grade_level_id, adviser_teacher_id FROM sections WHERE id = ? LIMIT 1',
        [sectionId]
    );
    if (!section) return { error: 'Selected section was not found.' };
    if (schoolId && Number(section.school_id) !== Number(schoolId)) {
        return { error: 'Selected section does not belong to the selected school.' };
    }
    if (gradeLevelId && section.grade_level_id && Number(section.grade_level_id) !== Number(gradeLevelId)) {
        return { error: 'Selected section does not belong to the selected grade level.' };
    }
    return { section };
}

async function syncTeacherAdviserAssignment({ teacherId, oldSectionId, newSectionId, adviserName }) {
    if (oldSectionId && Number(oldSectionId) !== Number(newSectionId || 0)) {
        await db.query(
            'UPDATE sections SET adviser = NULL, adviser_teacher_id = NULL WHERE id = ? AND adviser_teacher_id = ?',
            [oldSectionId, teacherId]
        );
    }
    if (newSectionId) {
        await db.query(
            'UPDATE sections SET adviser = ?, adviser_teacher_id = ? WHERE id = ?',
            [adviserName, teacherId, newSectionId]
        );
    }
}

async function getPreviousSchoolDay(dateStr, schoolId) {
    const d = new Date(dateStr + 'T00:00:00');
    for (let i = 0; i < 30; i++) {
        d.setDate(d.getDate() - 1);
        const dStr = d.toISOString().slice(0, 10);
        const result = await checkSchoolDay(dStr, schoolId);
        if (result.isSchoolDay) return dStr;
    }
    const fallback = new Date(dateStr + 'T00:00:00');
    fallback.setDate(fallback.getDate() - 1);
    return fallback.toISOString().slice(0, 10);
}

async function getRecentSchoolDates(baseDate, schoolId, limit) {
    const dates = [];
    const cursor = new Date(baseDate + 'T00:00:00');
    let guard = 0;
    while (dates.length < limit && guard < 160) {
        const dStr = cursor.toISOString().slice(0, 10);
        const schoolDay = await checkSchoolDay(dStr, schoolId);
        if (schoolDay.isSchoolDay) dates.push(dStr);
        cursor.setDate(cursor.getDate() - 1);
        guard++;
    }
    return dates;
}

async function getConsecutiveAbsenceFlags({ baseDate, schoolId, days = 2, includeTeachers = true, maxScanDays = 45 }) {
    const threshold = Math.max(1, Number(days) || 2);
    const scanLimit = Math.max(threshold, Math.min(Number(maxScanDays) || 45, 120));
    const today = todayDate();
    const cappedBaseDate = baseDate > today ? today : baseDate;
    const recentSchoolDates = await getRecentSchoolDates(cappedBaseDate, schoolId, scanLimit);
    const schoolDates = [];
    for (const d of recentSchoolDates) {
        if (await shouldCountComputedAbsences(d, schoolId)) schoolDates.push(d);
    }
    if (schoolDates.length < threshold) return [];

    // Today may not be absence-countable yet, but a real scan today should still
    // break a previous absence streak immediately.
    const schoolDateSet = new Set(schoolDates);
    const breakDates = [...schoolDates];
    if (!schoolDateSet.has(cappedBaseDate)) {
        const baseSchoolDay = await checkSchoolDay(cappedBaseDate, schoolId);
        if (baseSchoolDay.isSchoolDay) breakDates.unshift(cappedBaseDate);
    }

    let studentQuery = `SELECT s.id, s.firstname, s.lastname, s.lrn, s.school_id, s.section_id, s.created_at, s.active_from, sc.name as school_name,
            sc.logo as school_logo, sc.contact as school_contact, gl.name as grade_name, sec.name as section_name,
            COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) as adviser,
            at.contact as adviser_contact,
            at.email as adviser_email
        FROM students s
        LEFT JOIN schools sc ON s.school_id = sc.id
        LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
        LEFT JOIN sections sec ON s.section_id = sec.id
        LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
        WHERE s.status = 'active'`;
    const studentParams = [];
    if (schoolId) { studentQuery += ' AND s.school_id = ?'; studentParams.push(schoolId); }

    let teacherQuery = `SELECT t.id, t.firstname, t.lastname, t.employee_id, t.school_id, t.created_at, t.active_from, sc.name as school_name, sc.logo as school_logo, sc.contact as school_contact
        FROM teachers t
        LEFT JOIN schools sc ON t.school_id = sc.id
        WHERE t.status = 'active'`;
    const teacherParams = [];
    if (schoolId) { teacherQuery += ' AND t.school_id = ?'; teacherParams.push(schoolId); }

    const [students, teachers] = await Promise.all([
        db.query(studentQuery, studentParams).then(r => r[0]),
        includeTeachers ? db.query(teacherQuery, teacherParams).then(r => r[0]) : Promise.resolve([])
    ]);

    const attendanceDates = [...new Set(breakDates)];
    const allDatesSql = attendanceDates.map(() => '?').join(',');
    const attendanceParams = [...attendanceDates];
    let attendanceQuery = `SELECT person_type, person_id, date, time_in, status
        FROM attendance
        WHERE date IN (${allDatesSql}) AND person_type IN ('student', 'teacher')`;
    if (schoolId) {
        attendanceQuery += ' AND school_id = ?';
        attendanceParams.push(schoolId);
    }
    const [attendanceRows] = await db.query(attendanceQuery, attendanceParams);
    const attendedStatuses = new Set(['present', 'late', 'half_day']);
    const presentSet = new Set(attendanceRows.filter(r => r.time_in || attendedStatuses.has(String(r.status || '').toLowerCase())).map(r => {
        const d = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
        return `${r.person_type}-${r.person_id}-${d}`;
    }));

    function wasCreatedOnOrAfterDate(person, dateStr) {
        const effectiveValue = person.active_from || person.created_at;
        if (!effectiveValue) return false;
        const effectiveDate = effectiveValue instanceof Date
            ? effectiveValue.toISOString().slice(0, 10)
            : String(effectiveValue).slice(0, 10);
        return effectiveDate >= dateStr;
    }

    function consecutiveDaysAbsent(type, person) {
        let count = 0;
        for (const d of breakDates) {
            if (wasCreatedOnOrAfterDate(person, d)) break;
            const key = `${type}-${person.id}-${d}`;
            if (presentSet.has(key)) break;
            if (!schoolDateSet.has(d)) continue;
            count++;
        }
        return count;
    }

    const flaggedStudents = students
        .map(student => ({ student, absentDays: consecutiveDaysAbsent('student', student) }))
        .filter(item => item.absentDays >= threshold)
        .map(({ student, absentDays }) => ({
            ...student,
            person_type: 'student',
            absent_days: absentDays,
            requested_days: threshold,
            checked_dates: schoolDates.slice(0, absentDays),
            name: `${student.firstname} ${student.lastname}`.trim()
        }));

    const flaggedTeachers = teachers
        .map(teacher => ({ teacher, absentDays: consecutiveDaysAbsent('teacher', teacher) }))
        .filter(item => item.absentDays >= threshold)
        .map(({ teacher, absentDays }) => ({
            ...teacher,
            person_type: 'teacher',
            absent_days: absentDays,
            requested_days: threshold,
            checked_dates: schoolDates.slice(0, absentDays),
            name: `${teacher.firstname} ${teacher.lastname}`.trim()
        }));

    return [...flaggedStudents, ...flaggedTeachers];
}

// GET /api/is-school-day
router.get('/is-school-day', requireAuthOrScannerKiosk, async (req, res) => {
    try {
        const date = req.query.date || todayDate();
        const schoolId = req.query.school_id ? parseInt(req.query.school_id, 10) : null;
        const result = await checkSchoolDay(date, schoolId);
        return res.json({ date, ...result });
    } catch (err) {
        console.error('is-school-day error:', err);
        return res.status(500).json({ error: 'Failed to check school day.' });
    }
});

// =============================================
// POST /api/scan-attendance
// =============================================
router.post('/scan-attendance', requireAuthOrScannerKiosk, async (req, res) => {
    const qr_code = cleanScannedQrValue(req.body.qr_code);
    if (!qr_code) {
        return res.status(400).json({ success: false, error: 'No QR code provided.' });
    }
    const qrLookupCandidates = getQrLookupCandidates(qr_code);

    try {
        const scannerKioskAuthorized = isValidScannerKioskToken(getScannerKioskTokenFromRequest(req));
        const queuedScanTime = scannerKioskAuthorized ? normalizeKioskScanTime(req.body.scan_time) : null;
        const today = queuedScanTime ? queuedScanTime.date : todayDate();
        const now = queuedScanTime ? queuedScanTime.dateTime : nowDateTime();
        const graceAnchor = scannerKioskAuthorized ? normalizeKioskGraceAnchor(req.body.grace_anchor_time, today, now) : null;
        const requireTimeOutConfirmation = req.body.require_time_out_confirmation === true || req.body.require_time_out_confirmation === 'true' || req.body.require_time_out_confirmation === '1';
        const confirmedTimeOut = req.body.confirm_time_out === true || req.body.confirm_time_out === 'true' || req.body.confirm_time_out === '1';

        // Check student first (with joins for school, grade, section)
        let [rows] = await db.query(
            `SELECT s.id, s.firstname, s.lastname, s.lrn, s.school_id, s.status AS person_status,
                    s.qr_code, s.category, sc.name AS school_name, gl.name AS grade_name, sec.name AS section_name,
                    COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) AS adviser,
                    at.contact AS adviser_contact,
                    at.email AS adviser_email
             FROM students s
             LEFT JOIN schools sc ON s.school_id = sc.id
             LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
             LEFT JOIN sections sec ON s.section_id = sec.id
             LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
             WHERE s.qr_code IN (?) OR s.lrn IN (?)`,
            [qrLookupCandidates, qrLookupCandidates]
        );
        let personType = 'student';
        let person = rows[0];

        // If not a student, check teacher
        if (!person) {
            [rows] = await db.query(
                `SELECT t.id, t.firstname, t.lastname, t.employee_id, t.school_id, t.status AS person_status,
                        t.qr_code, t.category, sc.name AS school_name, gl.name AS grade_name, sec.name AS section_name,
                        COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) AS adviser,
                        at.contact AS adviser_contact,
                        at.email AS adviser_email
                 FROM teachers t
                 LEFT JOIN schools sc ON t.school_id = sc.id
                 LEFT JOIN grade_levels gl ON t.grade_level_id = gl.id
                 LEFT JOIN sections sec ON t.section_id = sec.id
                 LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
                 WHERE t.qr_code IN (?) OR t.employee_id IN (?)`,
                [qrLookupCandidates, qrLookupCandidates]
            );
            personType = 'teacher';
            person = rows[0];
        }

        if (!person) {
            return res.json({ success: false, error: 'QR code not recognized.' });
        }

        // Reject deleted persons
        if (person.person_status === 'deleted') {
            return res.json({ success: false, error: 'This person has been removed from the system.' });
        }

        // Enforce scanner school assignment — reject persons from other schools
        const scannerSchoolId = normalizeOptionalSchoolId(req.body.scanner_school_id);
        if (scannerSchoolId && Number(person.school_id) !== Number(scannerSchoolId)) {
            return res.json({
                success: false,
                error: `This scanner is assigned to a different school. "${person.school_name || 'This person'}" belongs to another school and cannot be scanned here.`,
                wrong_school: true
            });
        }

        const schoolDay = await checkSchoolDay(today, person.school_id);
        if (!schoolDay.isSchoolDay) {
            return res.json({
                success: false,
                error: nonSchoolDayScanMessage(schoolDay),
                non_school_day: true,
                non_school_day_type: schoolDay.type,
                non_school_day_reason: schoolDay.reason
            });
        }

        // Imported students become attendance-eligible only after their first valid QR scan.
        if (person.person_status === 'inactive') {
            if (personType === 'student') {
                await db.query(
                    "UPDATE students SET status = 'active', active_from = ? WHERE id = ?",
                    [today, person.id]
                );
                person.person_status = 'active';
            } else {
                const [[autoSetting]] = await db.query("SELECT setting_value FROM settings WHERE setting_key='auto_activate_on_scan'");
                const autoActivate = !autoSetting || autoSetting.setting_value !== '0'; // default: enabled
                if (autoActivate) {
                    await db.query(
                        "UPDATE teachers SET status = 'active', active_from = ? WHERE id = ?",
                        [today, person.id]
                    );
                    person.person_status = 'active';
                } else {
                    return res.json({ success: false, error: 'This person is inactive. Please contact the admin to activate.' });
                }
            }
        }

        const personInfo = {
            id: person.id,
            qr_code: person.qr_code || qr_code,
            name: person.firstname + ' ' + person.lastname,
            type: personType,
            category: personType === 'student' ? (person.category || 'student') : (person.category || 'teacher'),
            school: person.school_name || 'N/A',
            person_status: person.person_status || 'active',
            adviser: person.adviser || 'N/A',
            adviser_contact: person.adviser_contact || '',
            adviser_email: person.adviser_email || ''
        };
        if (personType === 'student') {
            personInfo.lrn = person.lrn || 'N/A';
            personInfo.grade = person.grade_name || 'N/A';
            personInfo.section = person.section_name || 'N/A';
        } else {
            personInfo.employee_id = person.employee_id || 'N/A';
            personInfo.grade = person.grade_name || 'N/A';
            personInfo.section = person.section_name || 'N/A';
        }

        // Check existing attendance for today
        const [existing] = await db.query(
            'SELECT * FROM attendance WHERE person_type = ? AND person_id = ? AND date = ?',
            [personType, person.id, today]
        );

        if (existing.length === 0) {
            // ── First scan of the day = AM Time In (PRESENT on/before cutoff, LATE after) ──
            // Outage forgiveness: judge late/half-day against the outage anchor (the
            // last moment this person could have scanned) when the scanner is
            // recovering from a power interruption, while still recording the real
            // scan time. Never makes a status worse — the anchor is always earlier.
            const outageForgiven = !!graceAnchor && compareDateTime(graceAnchor, now) < 0;
            const statusTime = outageForgiven ? graceAnchor : now;
            const schedule = await getAttendanceScheduleTimes(today);
            const baseStatus = await getBaseAttendanceStatus(personType, today, statusTime);
            const computedStatus = computeDailyAttendanceStatus({
                timeIn: statusTime,
                lastTimeIn: statusTime,
                timeOut: null,
                schedule,
                baseStatus
            });
            const resolvedStatus = outageForgiven && !computedStatus.remarks
                ? { ...computedStatus, remarks: 'Credited on-time — scanner power interruption' }
                : computedStatus;
            const attendanceStatus = resolvedStatus.status;
            const displayStatus = attendanceStatus === 'half_day'
                ? pmLabelFor('PM PRESENT', now, schedule)
                : attendanceStatus === 'late' ? 'LATE' : 'PRESENT';

            const [insertResult] = await db.query(
                'INSERT INTO attendance (person_type, person_id, school_id, date, time_in, last_time_in, status, monitoring_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [personType, person.id, person.school_id, today, now, now, attendanceStatus, displayStatus]
            );
            await logAttendanceEvent(insertResult.insertId, personType, person.id, person.school_id, today, 'time_in', displayStatus, now);

            return res.json({
                success: true,
                action: 'TIME_IN',
                status: attendanceStatus,
                display_status: displayStatus,
                ...responseAttendanceMeta(resolvedStatus),
                monitoring_status: displayStatus,
                message: outageForgiven
                    ? 'Attendance recorded - credited on-time despite scanner power interruption.'
                    : attendanceStatus === 'half_day'
                        ? 'PM time in recorded - marked as HALF-DAY.'
                        : attendanceStatus === 'late' ? 'Attendance recorded - marked as LATE' : 'Attendance recorded successfully',
                person: personInfo,
                time: formatTime12(now),
                time_in: formatTime12(now)
            });
        }

        // ── Subsequent scans toggle between Time Out and Time In (multiple allowed per day) ──
        const attendanceRow = existing[0];
        const transactionTimes = [attendanceRow.last_time_in || attendanceRow.time_in, attendanceRow.time_out].filter(Boolean);
        let lastTransactionAt = transactionTimes[0];
        transactionTimes.forEach(value => {
            if (compareDateTime(value, lastTransactionAt) > 0) lastTransactionAt = value;
        });

        // Anti-cheat: block scans made less than 60 seconds after the previous transaction.
        const elapsedSec = secondsBetween(lastTransactionAt, now);
        if (elapsedSec < 60) {
            return res.json({
                success: false,
                error: 'Scan rejected - too soon after the previous scan (' + Math.round(elapsedSec) + 's). Please wait at least 1 minute.',
                person: personInfo
            });
        }

        const schedule = await getAttendanceScheduleTimes(today);

        if (isCurrentlyInside(attendanceRow)) {
            // ── Time Out (leave premises / lunch out / end of day) ──
            const label = timeOutLabelFor(now, schedule);

            if (requireTimeOutConfirmation && !confirmedTimeOut) {
                return res.json({
                    success: true,
                    action: 'CONFIRM_TIME_OUT',
                    status: attendanceRow.status,
                    message: 'Already timed in. Please confirm before recording Time Out.',
                    person: personInfo,
                    time_in: formatTime12(attendanceRow.last_time_in || attendanceRow.time_in),
                    time_out: 'Pending Time Out',
                    monitoring_status: 'Pending Time Out'
                });
            }

            const resolvedStatus = await resolveAttendanceStatus(personType, today, {
                ...attendanceRow,
                time_out: now
            });

            await db.query(
                'UPDATE attendance SET time_out = ?, status = ?, monitoring_status = ?, updated_at = ? WHERE id = ?',
                [now, resolvedStatus.status, label, now, attendanceRow.id]
            );
            await logAttendanceEvent(attendanceRow.id, personType, person.id, person.school_id, today, 'time_out', label, now);

            const outMessages = {
                'COMPLETED': 'Time out recorded - attendance for today is complete.',
                'LUNCH OUT': 'Lunch time out recorded. Scan again when you return.',
                'OUT': 'Time out recorded. Scan again when you return to school.'
            };
            return res.json({
                success: true,
                action: 'TIME_OUT',
                status: resolvedStatus.status,
                display_status: label,
                ...responseAttendanceMeta(resolvedStatus),
                monitoring_status: label,
                completed: label === 'COMPLETED',
                message: resolvedStatus.status === 'half_day'
                    ? 'Time out recorded - marked as HALF-DAY (' + resolvedStatus.remarks + ').'
                    : outMessages[label],
                person: personInfo,
                time: formatTime12(now),
                time_in: formatTime12(attendanceRow.last_time_in || attendanceRow.time_in),
                time_out: formatTime12(now)
            });
        }

        // ── Time In again after a Time Out (return from outside / PM session) ──
        // Returning from a lunch-out always counts as the afternoon session, so
        // it is labeled PM PRESENT even when scanned before the PM start time.
        const wasLunchOut = String(attendanceRow.monitoring_status || '').toUpperCase() === 'LUNCH OUT';
        const label = pmLabelFor(wasLunchOut ? 'PM PRESENT' : timeInLabelFor(now, schedule), now, schedule);
        const resolvedStatus = await resolveAttendanceStatus(personType, today, {
            ...attendanceRow,
            last_time_in: now
        });
        await db.query(
            'UPDATE attendance SET last_time_in = ?, status = ?, monitoring_status = ?, updated_at = ? WHERE id = ?',
            [now, resolvedStatus.status, label, now, attendanceRow.id]
        );
        await logAttendanceEvent(attendanceRow.id, personType, person.id, person.school_id, today, 'time_in', label, now);

        return res.json({
            success: true,
            action: 'TIME_IN',
            status: resolvedStatus.status,
            display_status: label,
            ...responseAttendanceMeta(resolvedStatus),
            monitoring_status: label,
            message: label === 'PM LATE'
                ? 'PM time in recorded - marked PM LATE. Welcome back!'
                : label === 'PM PRESENT'
                    ? 'PM time in recorded. Welcome back!'
                    : 'Return time in recorded. Welcome back!',
            person: personInfo,
            time: formatTime12(now),
            time_in: formatTime12(now),
            time_out: attendanceRow.time_out ? formatTime12(attendanceRow.time_out) : null
        });
    } catch (err) {
        console.error('Scan attendance error:', err);
        return res.status(500).json({ success: false, error: 'Server error processing scan.' });
    }
});

// =============================================
// GET /api/dashboard-data
// =============================================
const dashboardCache = { data: null, timestamp: 0, key: '' };

router.get('/dashboard-data', requireAuth, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        const date = req.query.date || todayDate();
        const schoolId = applySchoolFilter(req);
        const absenceCountingActive = await shouldCountComputedAbsences(date, schoolId);
        const cacheKey = `${date}-${schoolId || 'all'}-${absenceCountingActive ? 'absence-closed' : 'attendance-open'}`;

        // Return cached if fresh (3 seconds)
        if (!req.query._ && dashboardCache.key === cacheKey && (Date.now() - dashboardCache.timestamp) < 3000) {
            return res.json(dashboardCache.data);
        }

        const schoolFilter = schoolId ? ' AND school_id = ?' : '';
        const schoolParams = schoolId ? [schoolId] : [];

        // Total schools
        const [schoolRows] = await db.query(
            `SELECT COUNT(*) as count FROM schools WHERE status = 'active'` + (schoolId ? ' AND id = ?' : ''),
            schoolId ? [schoolId] : []
        );

        // Total students (active)
        const [activeStudents] = await db.query(
            `SELECT COUNT(*) as count FROM students WHERE status = 'active'` + schoolFilter,
            schoolParams
        );

        // Total students (all)
        const [allStudents] = await db.query(
            `SELECT COUNT(*) as count FROM students WHERE 1=1` + schoolFilter,
            schoolParams
        );

        // Total teachers
        const [teacherRows] = await db.query(
            `SELECT COUNT(*) as count FROM teachers WHERE status = 'active'` + schoolFilter,
            schoolParams
        );

        const computedAbsent = await countStudentsWithoutTimeIn(date, schoolId);
        const eligibleStudents = await countAttendanceEligibleStudents(date, schoolId);
        const computedTeacherAbsent = await countTeachersWithoutTimeIn(date, schoolId);
        const eligibleTeachers = await countAttendanceEligibleTeachers(date, schoolId);
        const studentStatusCounts = await getAttendanceStatusCounts('student', date, { schoolId });
        const teacherStatusCounts = await getAttendanceStatusCounts('teacher', date, { schoolId });

        // School-by-school breakdown (join on active status)
        let schoolBreakdownQuery = `
            SELECT s.id, s.name, s.logo,
                (SELECT COUNT(*) FROM students st WHERE st.school_id = s.id AND st.status = 'active') as enrollment,
                (SELECT COUNT(*) FROM teachers t WHERE t.school_id = s.id AND t.status = 'active') as teachers_total
            FROM schools s WHERE s.status = 'active'`;
        const breakdownParams = [];
        if (schoolId) {
            schoolBreakdownQuery += ' AND s.id = ?';
            breakdownParams.push(schoolId);
        }
        const [schoolBreakdown] = await db.query(schoolBreakdownQuery, breakdownParams);

        const breakdown = [];
        for (const s of schoolBreakdown) {
            const eligible = await countAttendanceEligibleStudents(date, s.id);
            const teacherEligible = await countAttendanceEligibleTeachers(date, s.id);
            const teacherAbsent = await countTeachersWithoutTimeIn(date, s.id);
            const studentCounts = await getAttendanceStatusCounts('student', date, { schoolId: s.id });
            const teacherCounts = await getAttendanceStatusCounts('teacher', date, { schoolId: s.id });
            const fullDayStudents = studentCounts.full_day;
            const fullDayTeachers = teacherCounts.full_day;
            breakdown.push({
                id: s.id,
                name: s.name,
                logo: s.logo,
                enrollment: s.enrollment,
                attendance_eligible_students: Math.max(eligible, studentCounts.timed_in || 0),
                present: studentCounts.present,
                late: studentCounts.late,
                half_day: studentCounts.half_day,
                full_day: fullDayStudents,
                absent: await countStudentsWithoutTimeIn(date, s.id),
                rate: Math.max(eligible, studentCounts.timed_in || 0) > 0 ? Math.min(100, Math.round((fullDayStudents / Math.max(eligible, studentCounts.timed_in || 0)) * 100)) : 0,
                teachers_total: s.teachers_total || 0,
                attendance_eligible_teachers: Math.max(teacherEligible, teacherCounts.timed_in || 0),
                teachers_present: teacherCounts.present,
                teachers_late: teacherCounts.late,
                teachers_half_day: teacherCounts.half_day,
                teachers_full_day: fullDayTeachers,
                teachers_absent: teacherAbsent,
                teacher_rate: Math.max(teacherEligible, teacherCounts.timed_in || 0) > 0 ? Math.min(100, Math.round((fullDayTeachers / Math.max(teacherEligible, teacherCounts.timed_in || 0)) * 100)) : 0
            });
        }

        const totalActive = activeStudents[0].count;
        const totalPresent = studentStatusCounts.present;
        const totalFullDay = studentStatusCounts.full_day;
        const attendanceDenominator = Math.max(eligibleStudents, studentStatusCounts.timed_in);

        // Teachers timed out today (only active teachers)
        const [timedOutTeachers] = await db.query(
            `SELECT COUNT(DISTINCT a.person_id) as count FROM attendance a
             INNER JOIN teachers t ON a.person_id = t.id
             WHERE a.person_type = 'teacher' AND t.status = 'active' AND a.date = ? AND a.time_out IS NOT NULL` + (schoolId ? ' AND a.school_id = ?' : ''),
            [date, ...schoolParams]
        );

        // Inactive students count
        const [inactiveStudents] = await db.query(
            `SELECT COUNT(*) as count FROM students WHERE status = 'inactive'` + schoolFilter,
            schoolParams
        );

        // 2-day absence flagged students (counts consecutive school-day absences)
        const flaggedAbsent = await getConsecutiveAbsenceFlags({
            baseDate: date,
            schoolId,
            days: 2,
            includeTeachers: false,
            maxScanDays: 45
        });

        // Check if today is a school day (uses helper with holidays + weekends + overrides)
        const schoolDayResult = await checkSchoolDay(date, schoolId);
        const isSchoolDay = schoolDayResult.isSchoolDay;
        const nonSchoolDayReason = schoolDayResult.reason;
        const nonSchoolDayType = schoolDayResult.type;

        // Branding so the mobile app can render the admin-uploaded logo / names
        // dynamically (updates without an app reinstall). Only a short version
        // hash travels in this frequently-polled response — the heavy base64
        // logo is fetched separately from /mobile-branding, and only when this
        // version changes, to avoid re-downloading it on every poll.
        const [brandingRows] = await db.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('system_logo', 'system_name', 'division_name', 'mobile_dashboard_school_art', 'ai_report_icon')"
        );
        const branding = Object.fromEntries(brandingRows.map(r => [r.setting_key, r.setting_value]));
        const logoVersion = branding.system_logo
            ? crypto.createHash('md5').update(String(branding.system_logo)).digest('hex').slice(0, 12)
            : '';
        const schoolArtVersion = branding.mobile_dashboard_school_art
            ? crypto.createHash('md5').update(String(branding.mobile_dashboard_school_art)).digest('hex').slice(0, 12)
            : '';
        const aiReportIconVersion = branding.ai_report_icon
            ? crypto.createHash('md5').update(String(branding.ai_report_icon)).digest('hex').slice(0, 12)
            : '';

        const data = {
            date,
            system_name: branding.system_name || '',
            division_name: branding.division_name || '',
            logo_version: logoVersion,
            school_art_version: schoolArtVersion,
            ai_report_icon_version: aiReportIconVersion,
            total_schools: schoolRows[0].count,
            total_students: allStudents[0].count,
            active_students: totalActive,
            attendance_eligible_students: attendanceDenominator,
            total_teachers: teacherRows[0].count,
            active_teachers: teacherRows[0].count,
            attendance_eligible_teachers: Math.max(eligibleTeachers, teacherStatusCounts.timed_in),
            students_present: totalPresent,
            students_late: studentStatusCounts.late,
            students_half_day: studentStatusCounts.half_day,
            students_full_day: totalFullDay,
            students_absent: computedAbsent,
            students_timed_out: 0,
            teachers_timed_out: timedOutTeachers[0].count,
            teachers_present: teacherStatusCounts.present,
            teachers_late: teacherStatusCounts.late,
            teachers_half_day: teacherStatusCounts.half_day,
            teachers_full_day: teacherStatusCounts.full_day,
            teachers_absent: computedTeacherAbsent,
            attendance_rate: attendanceDenominator > 0 ? Math.min(100, Math.round((totalFullDay / attendanceDenominator) * 100)) : 0,
            inactive_students: inactiveStudents[0].count,
            flagged_absent_2day: flaggedAbsent.length,
            absence_counting_active: absenceCountingActive,
            absence_counting_message: absenceCountingActive ? 'Absence counting is active.' : 'Absences are pending until the official end-of-school-day time.',
            is_school_day: isSchoolDay,
            non_school_day_reason: nonSchoolDayReason,
            non_school_day_type: nonSchoolDayType,
            schools: breakdown
        };

        // Cache result
        dashboardCache.data = data;
        dashboardCache.timestamp = Date.now();
        dashboardCache.key = cacheKey;

        return res.json(data);
    } catch (err) {
        console.error('Dashboard data error:', err);
        return res.status(500).json({ error: 'Failed to load dashboard data.' });
    }
});

// =============================================
// GET /api/mobile-branding
// Full branding (admin-uploaded logo data URL + names) for the mobile app.
// Fetched only when the logo_version from /dashboard-data changes, so the
// heavy base64 logo is not re-downloaded on every poll.
// =============================================
router.get('/mobile-branding', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('system_logo', 'system_name', 'division_name', 'mobile_dashboard_school_art', 'ai_report_icon')"
        );
        const branding = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
        const logo = branding.system_logo || '';
        const schoolArt = branding.mobile_dashboard_school_art || '';
        const aiReportIcon = branding.ai_report_icon || '';
        const logoVersion = logo
            ? crypto.createHash('md5').update(String(logo)).digest('hex').slice(0, 12)
            : '';
        const schoolArtVersion = schoolArt
            ? crypto.createHash('md5').update(String(schoolArt)).digest('hex').slice(0, 12)
            : '';
        const aiReportIconVersion = aiReportIcon
            ? crypto.createHash('md5').update(String(aiReportIcon)).digest('hex').slice(0, 12)
            : '';
        return res.json({
            system_logo: logo,
            system_name: branding.system_name || '',
            division_name: branding.division_name || '',
            logo_version: logoVersion,
            mobile_dashboard_school_art: schoolArt,
            school_art_version: schoolArtVersion,
            ai_report_icon: aiReportIcon,
            ai_report_icon_version: aiReportIconVersion
        });
    } catch (err) {
        console.error('Mobile branding error:', err);
        return res.status(500).json({ error: 'Failed to load branding.' });
    }
});

// =============================================
// GET /api/weekly-absence
// Lightweight: returns Mon-Fri absent counts for the week containing `date`
// in ONE call (replaces 5 heavy /dashboard-data calls from the mobile app).
// =============================================
const weeklyAbsenceCache = { data: null, timestamp: 0, key: '' };

function invalidateLiveDashboardCaches() {
    dashboardCache.data = null;
    dashboardCache.timestamp = 0;
    dashboardCache.key = '';
    weeklyAbsenceCache.data = null;
    weeklyAbsenceCache.timestamp = 0;
    weeklyAbsenceCache.key = '';
}

router.get('/weekly-absence', requireAuth, async (req, res) => {
    try {
        const baseDate = req.query.date || todayDate();
        const schoolId = applySchoolFilter(req);

        // Compute Monday→Friday of the week containing baseDate
        const fmt = (dt) => {
            const y = dt.getFullYear();
            const m = String(dt.getMonth() + 1).padStart(2, '0');
            const dd = String(dt.getDate()).padStart(2, '0');
            return `${y}-${m}-${dd}`;
        };
        const d = new Date(baseDate + 'T00:00:00');
        const dow = d.getDay(); // 0 = Sun
        const mondayOffset = dow === 0 ? -6 : 1 - dow;
        const monday = new Date(d);
        monday.setDate(monday.getDate() + mondayOffset);

        const days = [];
        for (let i = 0; i < 5; i++) {
            const day = new Date(monday);
            day.setDate(day.getDate() + i);
            days.push(fmt(day));
        }

        const cacheKey = `${days[0]}-${schoolId || 'all'}`;
        // Cache for 60s — weekly data changes slowly
        if (weeklyAbsenceCache.key === cacheKey && (Date.now() - weeklyAbsenceCache.timestamp) < 60000) {
            return res.json(weeklyAbsenceCache.data);
        }

        const week = [];
        for (const dayDate of days) {
            const schoolDay = await checkSchoolDay(dayDate, schoolId);
            const absent = schoolDay.isSchoolDay
                ? await countStudentsWithoutTimeIn(dayDate, schoolId)
                : 0;
            week.push({
                date: dayDate,
                is_school_day: schoolDay.isSchoolDay,
                students_absent: absent
            });
        }

        const payload = { week };
        weeklyAbsenceCache.data = payload;
        weeklyAbsenceCache.timestamp = Date.now();
        weeklyAbsenceCache.key = cacheKey;

        return res.json(payload);
    } catch (err) {
        console.error('Weekly absence error:', err);
        return res.status(500).json({ error: 'Failed to load weekly absence data.' });
    }
});

// =============================================
// GET /api/division-weekly-trend
// =============================================
router.get('/division-weekly-trend', requireAuth, async (req, res) => {
    try {
        const endDate = req.query.date || todayDate();
        // Get last 4 weeks (Mon-Fri blocks)
        const weeks = [];
        let d = new Date(endDate + 'T00:00:00');
        // Go to the Monday of the current week
        let day = d.getDay();
        let diff = day === 0 ? 6 : day - 1;
        d.setDate(d.getDate() - diff);

        for (let w = 0; w < 4; w++) {
            let monday = new Date(d);
            monday.setDate(monday.getDate() - (w * 7));
            let friday = new Date(monday);
            friday.setDate(friday.getDate() + 4);
            weeks.unshift({
                start: monday.toISOString().slice(0, 10),
                end: friday.toISOString().slice(0, 10),
                label: 'Mar ' + monday.getDate()
            });
        }

        // Better labels
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        weeks.forEach(function(w) {
            var sd = new Date(w.start + 'T00:00:00');
            w.label = months[sd.getMonth()] + ' ' + sd.getDate();
        });

        const labels = weeks.map(w => w.label);
        const present = [];
        const absent = [];
        const today = todayDate();

        for (const w of weeks) {
            const [pRow] = await db.query(
                `SELECT COUNT(DISTINCT a.person_id, a.date) as cnt FROM attendance a
                 INNER JOIN students s ON a.person_id = s.id AND s.status = 'active'
                 WHERE a.person_type = 'student' AND a.date BETWEEN ? AND ? AND a.time_in IS NOT NULL`,
                [w.start, w.end]
            );
            let cur = new Date(w.start + 'T00:00:00');
            let endW = new Date(w.end + 'T00:00:00');
            let aCount = 0;
            while (cur <= endW) {
                const ds = cur.toISOString().slice(0, 10);
                if (ds <= today) {
                    aCount += await countStudentsWithoutTimeIn(ds, null);
                }
                cur.setDate(cur.getDate() + 1);
            }
            let pCount = pRow[0].cnt;
            present.push(pCount);
            absent.push(aCount);
        }

        res.json({ labels, present, absent });
    } catch (err) {
        console.error('Weekly trend error:', err);
        res.status(500).json({ error: 'Failed to load weekly trend' });
    }
});

// =============================================
// GET /api/realtime-poll
// =============================================
router.get('/realtime-poll', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const clientHash = req.query.hash || '';
    const schoolId = applySchoolFilter(req);

    try {
        const today = todayDate();
        const absenceCountingActive = await shouldCountComputedAbsences(today, schoolId);
        const schoolFilter = schoolId ? ' AND school_id = ?' : '';
        const params = schoolId ? [today, schoolId] : [today];
        const schoolWhere = schoolId ? ' AND school_id = ?' : '';
        const schoolParams = schoolId ? [schoolId] : [];

        const [countRows] = await db.query(
            `SELECT COUNT(*) as cnt FROM attendance WHERE date = ?` + schoolFilter,
            params
        );
        const [latestRows] = await db.query(
            `SELECT MAX(updated_at) as latest FROM attendance WHERE date = ?` + schoolFilter,
            params
        );
        // Track ALL non-deleted students (not just active) so imports trigger refresh
        const [studentRows] = await db.query(
            `SELECT COUNT(*) as cnt, SUM(status='active') as active, SUM(status='inactive') as inactive,
                    COALESCE(SUM(CRC32(CONCAT_WS('|',
                        id,
                        COALESCE(lrn, ''),
                        COALESCE(firstname, ''),
                        COALESCE(lastname, ''),
                        COALESCE(middlename, ''),
                        COALESCE(gender, ''),
                        COALESCE(birthdate, ''),
                        COALESCE(guardian_name, ''),
                        COALESCE(guardian_contact, ''),
                        COALESCE(category, ''),
                        COALESCE(status, ''),
                        COALESCE(active_from, ''),
                        COALESCE(grade_level_id, ''),
                        COALESCE(section_id, ''),
                        COALESCE(school_id, '')
                    ))), 0) as checksum
             FROM students WHERE status != 'deleted'` + schoolWhere,
            schoolParams
        );
        const [teacherRows] = await db.query(
            `SELECT COUNT(*) as cnt,
                    COALESCE(SUM(CRC32(CONCAT_WS('|',
                        id,
                        COALESCE(employee_id, ''),
                        COALESCE(firstname, ''),
                        COALESCE(lastname, ''),
                        COALESCE(middlename, ''),
                        COALESCE(contact, ''),
                        COALESCE(email, ''),
                        COALESCE(category, ''),
                        COALESCE(status, ''),
                        COALESCE(active_from, ''),
                        COALESCE(grade_level_id, ''),
                        COALESCE(section_id, ''),
                        COALESCE(school_id, '')
                    ))), 0) as checksum
             FROM teachers WHERE status != 'deleted'` + schoolWhere,
            schoolParams
        );
        const [schoolRows] = await db.query(
            `SELECT COUNT(*) as cnt, COALESCE(SUM(CRC32(CONCAT_WS('|', id, name, status, COALESCE(contact, '')))), 0) as checksum FROM schools WHERE 1=1` + (schoolId ? ' AND id = ?' : ''),
            schoolId ? [schoolId] : []
        );
        const [gradeRows] = await db.query(
            `SELECT COUNT(*) as cnt, COALESCE(SUM(CRC32(CONCAT_WS('|', id, name, COALESCE(school_id, '')))), 0) as checksum FROM grade_levels WHERE 1=1` + schoolWhere,
            schoolParams
        );
        const [sectionRows] = await db.query(
            `SELECT COUNT(*) as cnt, COALESCE(SUM(CRC32(CONCAT_WS('|', id, name, COALESCE(adviser, ''), COALESCE(status, ''), COALESCE(grade_level_id, ''), COALESCE(school_id, '')))), 0) as checksum FROM sections WHERE 1=1` + schoolWhere,
            schoolParams
        );
        const [notificationRows] = await db.query(
            `SELECT COUNT(*) as cnt, MAX(created_at) as latest FROM notifications WHERE 1=1` + schoolWhere,
            schoolParams
        );
        const [settingsRows] = await db.query(
            `SELECT COUNT(*) as cnt,
                    COALESCE(SUM(CRC32(CONCAT_WS('|', setting_key, COALESCE(setting_value, '')))), 0) as checksum
             FROM settings
             WHERE setting_key IN (
                'system_name',
                'division_name',
                'system_logo',
                'mobile_dashboard_school_art',
                'am_time_in_end',
                'am_late_time',
                'lunch_break_start',
                'pm_time_in_start',
                'pm_late_time',
                'pm_time_out_end',
                'absence_cutoff_time',
                'late_threshold',
                'teacher_duty_start_time',
                'teacher_duty_end_time',
                'teacher_late_threshold',
                'auto_activate_on_scan'
             )`
        );

        const raw = `${absenceCountingActive ? 'closed' : 'open'}-${countRows[0].cnt}-${latestRows[0].latest || ''}-${studentRows[0].cnt}-${studentRows[0].active}-${studentRows[0].inactive}-${studentRows[0].checksum}-${teacherRows[0].cnt}-${teacherRows[0].checksum}-${schoolRows[0].cnt}-${schoolRows[0].checksum}-${gradeRows[0].cnt}-${gradeRows[0].checksum}-${sectionRows[0].cnt}-${sectionRows[0].checksum}-${notificationRows[0].cnt}-${notificationRows[0].latest || ''}-${settingsRows[0].cnt}-${settingsRows[0].checksum}`;
        const hash = crypto.createHash('md5').update(raw).digest('hex').substring(0, 12);
        const changed = hash !== clientHash;

        return res.json({
            changed,
            hash,
            absence_counting_active: absenceCountingActive,
            attendance_count: countRows[0].cnt,
            student_count: studentRows[0].cnt
        });
    } catch (err) {
        console.error('Realtime poll error:', err);
        return res.status(500).json({ error: 'Poll failed.' });
    }
});

// =============================================
// CRUD helpers for students, teachers, schools, etc.
// =============================================

// GET /api/students
router.get('/students', requireAuth, async (req, res) => {
    try {
        let schoolId = applySchoolFilter(req);
        if (!schoolId && (req.query.school_id || req.query.school)) schoolId = parseInt(req.query.school_id || req.query.school, 10);
        const gradeId = req.query.grade_level_id || req.query.grade;
        let query = `SELECT s.*, sc.name as school_name, gl.name as grade_name, sec.name as section_name
            FROM students s
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            WHERE s.status != 'deleted'`;
        const params = [];
        if (schoolId) { query += ' AND s.school_id = ?'; params.push(schoolId); }
        if (gradeId) { query += ' AND s.grade_level_id = ?'; params.push(parseInt(gradeId, 10)); }
        if (req.query.section_id) { query += ' AND s.section_id = ?'; params.push(parseInt(req.query.section_id, 10)); }
        if (req.query.status) { query += ' AND s.status = ?'; params.push(req.query.status); }
        if (req.query.category) { query += ' AND s.category = ?'; params.push(req.query.category); }
        if (req.query.search) {
            query += ' AND (s.firstname LIKE ? OR s.lastname LIKE ? OR s.lrn LIKE ?)';
            const s = `%${req.query.search}%`;
            params.push(s, s, s);
        }
        query += ' ORDER BY s.lastname, s.firstname';
        const [rows] = await db.query(query, params);
        return res.json(rows.map(row => ({
            ...row,
            track: deriveTrackFromSection(row.section_name)
        })));
    } catch (err) {
        console.error('Get students error:', err);
        return res.status(500).json({ error: 'Failed to fetch students.' });
    }
});

// POST /api/students
router.post('/students', requireAuth, async (req, res) => {
    const { lrn, firstname, lastname, middlename, gender, birthdate, grade_level_id, section_id, school_id, guardian_name, guardian_contact, category } = req.body;
    if (!firstname || !lastname || !school_id) {
        return res.status(400).json({ error: 'First name, last name, and school are required.' });
    }
    try {
        const qr_code = 'STU-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
        const [result] = await db.query(
            `INSERT INTO students (lrn, firstname, lastname, middlename, gender, birthdate, grade_level_id, section_id, school_id, guardian_name, guardian_contact, qr_code, category, active_from, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [lrn || null, firstname, lastname, middlename || null, gender || null, birthdate || null,
             grade_level_id || null, section_id || null, school_id, guardian_name || null, guardian_contact || null,
             qr_code, category || 'student', null, 'inactive']
        );
        return res.json({ success: true, id: result.insertId, qr_code });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A student with this LRN already exists.' });
        }
        console.error('Create student error:', err);
        return res.status(500).json({ error: 'Failed to create student.' });
    }
});

// PUT /api/students/:id
router.put('/students/:id', requireAuth, async (req, res) => {
    const { firstname, lastname, middlename, gender, birthdate, grade_level_id, section_id, school_id, guardian_name, guardian_contact, status, lrn, category } = req.body;
    try {
        const validStatus = ['active', 'inactive', 'deleted'].includes(status) ? status : null;
        const fields = [
            'firstname=?', 'lastname=?', 'middlename=?', 'gender=?', 'birthdate=?',
            'grade_level_id=?', 'section_id=?', 'school_id=?', 'guardian_name=?',
            'guardian_contact=?', 'lrn=?', 'category=?'
        ];
        const params = [
            firstname, lastname, middlename || null, gender || null, birthdate || null,
            grade_level_id || null, section_id || null, school_id, guardian_name || null,
            guardian_contact || null, lrn || null, category || 'student'
        ];
        if (validStatus) {
            fields.push('status=?');
            params.push(validStatus);
            if (validStatus === 'active') {
                fields.push('active_from = COALESCE(active_from, CURDATE())');
            }
        }
        params.push(req.params.id);
        await db.query(`UPDATE students SET ${fields.join(', ')} WHERE id=?`, params);
        return res.json({ success: true });
    } catch (err) {
        console.error('Update student error:', err);
        return res.status(500).json({ error: 'Failed to update student.' });
    }
});

// POST /api/students/bulk-delete  { ids: [1, 2, 3] }
router.post('/students/bulk-delete', requireAuth, async (req, res) => {
    try {
        const ids = Array.isArray(req.body.ids)
            ? req.body.ids.map((n) => parseInt(n, 10)).filter(Number.isFinite)
            : [];
        if (!ids.length) return res.status(400).json({ error: 'No students selected.' });
        const placeholders = ids.map(() => '?').join(',');
        const [result] = await db.query(
            `UPDATE students SET status = 'deleted' WHERE id IN (${placeholders})`,
            ids
        );
        return res.json({ success: true, deleted: result.affectedRows });
    } catch (err) {
        console.error('Bulk delete students error:', err);
        return res.status(500).json({ error: 'Failed to delete selected students.' });
    }
});

// DELETE /api/students/:id
router.delete('/students/:id', requireAuth, async (req, res) => {
    try {
        await db.query('UPDATE students SET status = ? WHERE id = ?', ['deleted', req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        console.error('Delete student error:', err);
        return res.status(500).json({ error: 'Failed to delete student.' });
    }
});

// GET /api/teachers
router.get('/teachers', requireAuth, async (req, res) => {
    try {
        let schoolId = applySchoolFilter(req);
        if (!schoolId && req.query.school_id) schoolId = parseInt(req.query.school_id, 10);
        let query = `SELECT t.id, t.employee_id, t.firstname, t.lastname, t.middlename, t.department, t.subject,
                t.contact, t.email, t.school_id, t.grade_level_id, t.section_id, t.qr_code,
                t.active_from, t.status, t.category, t.created_at, t.updated_at,
                IF(t.password IS NOT NULL AND t.password != '', 1, 0) as has_password,
                s.name as school_name, gl.name as grade_name, sec.name as section_name
            FROM teachers t
            LEFT JOIN schools s ON t.school_id = s.id
            LEFT JOIN grade_levels gl ON t.grade_level_id = gl.id
            LEFT JOIN sections sec ON t.section_id = sec.id
            WHERE t.status != 'deleted'`;
        const params = [];
        if (schoolId) { query += ' AND t.school_id = ?'; params.push(schoolId); }
        if (req.query.category) { query += ' AND t.category = ?'; params.push(req.query.category); }
        if (req.query.status) { query += ' AND t.status = ?'; params.push(req.query.status); }
        if (req.query.search) {
            query += ' AND (t.firstname LIKE ? OR t.lastname LIKE ? OR t.employee_id LIKE ? OR t.contact LIKE ? OR t.email LIKE ? OR sec.name LIKE ? OR gl.name LIKE ? OR s.name LIKE ?)';
            const s = `%${req.query.search}%`;
            params.push(s, s, s, s, s, s, s, s);
        }
        query += ' ORDER BY t.lastname, t.firstname';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        console.error('Get teachers error:', err);
        return res.status(500).json({ error: 'Failed to fetch teachers.' });
    }
});

// POST /api/teachers
router.post('/teachers', requireAuth, async (req, res) => {
    const { employee_id, firstname, lastname, middlename, department, subject, contact, email, school_id, grade_level_id, section_id, category } = req.body;
    if (!firstname || !lastname || !school_id) {
        return res.status(400).json({ error: 'First name, last name, and school are required.' });
    }
    try {
        const assignment = await validateTeacherAssignment({ schoolId: school_id, gradeLevelId: grade_level_id, sectionId: section_id });
        if (assignment?.error) return res.status(400).json({ error: assignment.error });
        const qr_code = 'TCH-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
        const teacherCategory = category === 'shs_teacher' ? 'shs_teacher' : 'teacher';
        const [result] = await db.query(
            `INSERT INTO teachers (employee_id, firstname, lastname, middlename, department, subject, contact, email, school_id, grade_level_id, section_id, qr_code, active_from, status, category)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [employee_id || null, firstname, lastname, middlename || null, department || null, subject || null, contact || null, email || null, school_id, grade_level_id || null, section_id || null, qr_code, null, 'inactive', teacherCategory]
        );
        await syncTeacherAdviserAssignment({
            teacherId: result.insertId,
            oldSectionId: null,
            newSectionId: section_id || null,
            adviserName: displayPersonName(firstname, lastname, middlename)
        });
        return res.json({ success: true, id: result.insertId, qr_code });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A teacher with this employee ID already exists.' });
        }
        console.error('Create teacher error:', err);
        return res.status(500).json({ error: 'Failed to create teacher.' });
    }
});

// PUT /api/teachers/:id
router.put('/teachers/:id', requireAuth, async (req, res) => {
    const { employee_id, firstname, lastname, middlename, department, subject, contact, email, school_id, grade_level_id, section_id, category, status, new_password, confirm_password } = req.body;
    if (!firstname || !lastname || !school_id) {
        return res.status(400).json({ error: 'First name, last name, and school are required.' });
    }
    if (new_password && new_password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (new_password && new_password !== confirm_password) {
        return res.status(400).json({ error: 'Passwords do not match.' });
    }
    try {
        const [[existing]] = await db.query('SELECT id, section_id, status FROM teachers WHERE id = ? AND status != ?', [req.params.id, 'deleted']);
        if (!existing) return res.status(404).json({ error: 'Teacher not found.' });
        const assignment = await validateTeacherAssignment({ teacherId: req.params.id, schoolId: school_id, gradeLevelId: grade_level_id, sectionId: section_id });
        if (assignment?.error) return res.status(400).json({ error: assignment.error });
        const validStatus = ['active', 'inactive', 'deleted'].includes(status) ? status : (existing.status || 'inactive');
        const teacherCategory = category === 'shs_teacher' ? 'shs_teacher' : 'teacher';
        const fields = [
            'employee_id=?', 'firstname=?', 'lastname=?', 'middlename=?', 'department=?', 'subject=?',
            'contact=?', 'email=?', 'school_id=?', 'grade_level_id=?', 'section_id=?', 'category=?', 'status=?'
        ];
        const params = [
            employee_id || null, firstname, lastname, middlename || null, department || null, subject || null,
            contact || null, email || null, school_id, grade_level_id || null, section_id || null, teacherCategory, validStatus
        ];
        if (new_password) {
            const hashed = await bcrypt.hash(new_password, 10);
            fields.push('password=?');
            params.push(hashed);
        }
        if (validStatus === 'active') {
            fields.push('active_from = COALESCE(active_from, CURDATE())');
        } else if (validStatus === 'inactive') {
            fields.push('active_from = NULL');
        }
        params.push(req.params.id);
        await db.query(`UPDATE teachers SET ${fields.join(', ')} WHERE id=?`, params);
        await syncTeacherAdviserAssignment({
            teacherId: req.params.id,
            oldSectionId: existing.section_id,
            newSectionId: section_id || null,
            adviserName: displayPersonName(firstname, lastname, middlename)
        });
        return res.json({ success: true });
    } catch (err) {
        console.error('Update teacher error:', err);
        return res.status(500).json({ error: 'Failed to update teacher.' });
    }
});

// DELETE /api/teachers/:id
router.delete('/teachers/:id', requireAuth, async (req, res) => {
    try {
        const [[existing]] = await db.query('SELECT section_id FROM teachers WHERE id = ? LIMIT 1', [req.params.id]);
        await db.query('UPDATE teachers SET status = ? WHERE id = ?', ['deleted', req.params.id]);
        if (existing?.section_id) {
            await db.query(
                'UPDATE sections SET adviser = NULL, adviser_teacher_id = NULL WHERE id = ? AND adviser_teacher_id = ?',
                [existing.section_id, req.params.id]
            );
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Delete teacher error:', err);
        return res.status(500).json({ error: 'Failed to delete teacher.' });
    }
});

// ---- Schools ----
router.get('/schools', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT s.*,
            (SELECT COUNT(*) FROM students st WHERE st.school_id = s.id AND st.status = 'active') as student_count,
            (SELECT COUNT(*) FROM teachers t WHERE t.school_id = s.id AND t.status = 'active') as teacher_count,
            (SELECT COUNT(*) FROM sections sec WHERE sec.school_id = s.id) as section_count
            FROM schools s ORDER BY s.name`);
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch schools.' });
    }
});

router.post('/schools', requireAuth, async (req, res) => {
    const { name, school_id_code, address, contact } = req.body;
    if (!name) return res.status(400).json({ error: 'School name is required.' });
    try {
        // Auto-generate school_code from initials + sequence
        const initials = name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 6);
        const [existing] = await db.query('SELECT COUNT(*) as cnt FROM schools WHERE school_code LIKE ?', [initials + '%']);
        const code = initials + '-' + String(existing[0].cnt + 1).padStart(3, '0');
        const [result] = await db.query(
            'INSERT INTO schools (name, school_id_code, school_code, address, contact) VALUES (?, ?, ?, ?, ?)',
            [name, school_id_code || null, code, address || null, contact || null]
        );
        return res.json({ success: true, id: result.insertId, school_code: code });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to create school.' });
    }
});

router.put('/schools/:id', requireAuth, async (req, res) => {
    const { name, school_id_code, address, contact, status, logo } = req.body;
    try {
        const [[existing]] = await db.query('SELECT logo FROM schools WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ error: 'School not found.' });
        const keepLogo = typeof logo === 'string' && logo.trim() ? logo.trim() : existing.logo;
        await db.query('UPDATE schools SET name=?, school_id_code=?, address=?, contact=?, status=?, logo=? WHERE id=?',
            [name, school_id_code || null, address || null, contact || null, status || 'active', keepLogo || null, req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update school.' });
    }
});

function uploadedFileToDataUrl(file) {
    return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

router.delete('/schools/:id', requireRole('super_admin'), async (req, res) => {
    try {
        const id = req.params.id;
        // Check for dependent records
        const [students] = await db.query('SELECT COUNT(*) as cnt FROM students WHERE school_id = ?', [id]);
        const [teachers] = await db.query('SELECT COUNT(*) as cnt FROM teachers WHERE school_id = ?', [id]);
        if (students[0].cnt > 0 || teachers[0].cnt > 0) {
            return res.status(400).json({ error: 'Cannot delete school with active students or teachers. Disable it instead.' });
        }
        await db.query('DELETE FROM sections WHERE school_id = ?', [id]);
        await db.query('DELETE FROM grade_levels WHERE school_id = ?', [id]);
        await db.query('DELETE FROM schools WHERE id = ?', [id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete school.' });
    }
});

// ---- Grade Levels ----
router.get('/grade-levels', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT gl.*, s.name as school_name FROM grade_levels gl LEFT JOIN schools s ON gl.school_id = s.id ORDER BY gl.name');
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch grade levels.' });
    }
});

router.post('/grade-levels', requireAuth, async (req, res) => {
    const { name, school_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Grade level name is required.' });
    try {
        const [result] = await db.query('INSERT INTO grade_levels (name, school_id) VALUES (?, ?)', [name, school_id || null]);
        return res.json({ success: true, id: result.insertId });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to create grade level.' });
    }
});

// ---- Sections ----
router.get('/sections', requireAuth, async (req, res) => {
    try {
        let query = `SELECT sec.*,
                COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) as adviser,
                at.employee_id as adviser_employee_id,
                at.contact as adviser_contact,
                at.email as adviser_email,
                gl.name as grade_name,
                s.name as school_name
            FROM sections sec
            LEFT JOIN grade_levels gl ON sec.grade_level_id = gl.id
            LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
            LEFT JOIN schools s ON sec.school_id = s.id WHERE 1=1`;
        const params = [];
        // Principals are hard-scoped to their own school; everyone else may filter by param.
        const scopedSchool = applySchoolFilter(req);
        const schoolId = scopedSchool || req.query.school_id || null;
        if (schoolId) { query += ' AND sec.school_id = ?'; params.push(schoolId); }
        if (req.query.grade_level_id) { query += ' AND sec.grade_level_id = ?'; params.push(req.query.grade_level_id); }
        query += ' ORDER BY sec.name';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch sections.' });
    }
});

// Principals may only act within their assigned school. Returns the principal's
// school_id, or null for non-principal roles (no extra restriction).
function principalSchoolId(req) {
    const u = req.session && req.session.user;
    return u && u.role === 'principal' ? (u.school_id || -1) : null;
}
// True when the given section belongs to the user's scope (always true for non-principals).
async function sectionInUserScope(req, sectionId) {
    const ps = principalSchoolId(req);
    if (ps === null) return true;
    const [rows] = await db.query('SELECT school_id FROM sections WHERE id = ?', [sectionId]);
    return rows.length > 0 && Number(rows[0].school_id) === Number(ps);
}

router.post('/sections', requireAuth, async (req, res) => {
    const { name, grade_level_id, school_id, adviser } = req.body;
    if (!name) return res.status(400).json({ error: 'Section name is required.' });
    const ps = principalSchoolId(req);
    if (ps !== null && ps <= 0) return res.status(403).json({ error: 'No school is assigned to your account.' });
    const finalSchool = ps !== null ? ps : (school_id || null);
    try {
        const [result] = await db.query(
            'INSERT INTO sections (name, grade_level_id, school_id, adviser) VALUES (?, ?, ?, ?)',
            [name, grade_level_id || null, finalSchool, adviser || null]
        );
        return res.json({ success: true, id: result.insertId });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to create section.' });
    }
});

router.put('/sections/:id', requireAuth, async (req, res) => {
    const { name, grade_level_id, school_id, adviser, status } = req.body;
    if (!name) return res.status(400).json({ error: 'Section name is required.' });
    if (!(await sectionInUserScope(req, req.params.id))) return res.status(403).json({ error: 'You can only edit sections in your school.' });
    const ps = principalSchoolId(req);
    const finalSchool = ps !== null ? ps : (school_id || null);
    try {
        const fields = ['name = ?', 'grade_level_id = ?', 'school_id = ?', 'adviser = ?'];
        const params = [name, grade_level_id || null, finalSchool, adviser || null];
        if (status) { fields.push('status = ?'); params.push(status); }
        params.push(req.params.id);
        await db.query('UPDATE sections SET ' + fields.join(', ') + ' WHERE id = ?', params);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update section.' });
    }
});

router.patch('/sections/:id/status', requireAuth, async (req, res) => {
    const { status } = req.body;
    if (!status || !['active', 'inactive'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status.' });
    }
    if (!(await sectionInUserScope(req, req.params.id))) return res.status(403).json({ error: 'You can only change sections in your school.' });
    try {
        await db.query('UPDATE sections SET status = ? WHERE id = ?', [status, req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update status.' });
    }
});

router.delete('/sections/:id', requireAuth, async (req, res) => {
    try {
        if (!(await sectionInUserScope(req, req.params.id))) return res.status(403).json({ error: 'You can only delete sections in your school.' });
        // Check for students in this section
        const [students] = await db.query('SELECT COUNT(*) as cnt FROM students WHERE section_id = ? AND status != ?', [req.params.id, 'deleted']);
        if (students[0].cnt > 0) {
            return res.status(400).json({ error: 'Cannot delete section with ' + students[0].cnt + ' student(s). Remove or reassign students first.' });
        }
        await db.query('DELETE FROM sections WHERE id = ?', [req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete section.' });
    }
});

// ---- Mobile: School structure tree ----
router.get('/mobile-school-structure', requireAuth, async (req, res) => {
    try {
        const schoolId = applySchoolFilter(req);
        const schoolWhere = schoolId ? ' WHERE s.id = ?' : '';
        const schoolParams = schoolId ? [schoolId] : [];

        const [schools] = await db.query(`SELECT s.*,
            (SELECT COUNT(*) FROM students st WHERE st.school_id = s.id AND st.status = 'active') as student_count,
            (SELECT COUNT(*) FROM teachers t WHERE t.school_id = s.id AND t.status = 'active') as teacher_count
            FROM schools s${schoolWhere} ORDER BY s.name`, schoolParams);

        const [grades] = await db.query(
            `SELECT gl.* FROM grade_levels gl WHERE 1=1${schoolId ? ' AND gl.school_id = ?' : ''} ORDER BY gl.name`,
            schoolId ? [schoolId] : []
        );
        const [sections] = await db.query(
            `SELECT sec.*,
                    COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) as adviser,
                    at.employee_id as adviser_employee_id,
                    at.contact as adviser_contact,
                    at.email as adviser_email
             FROM sections sec
             LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
             WHERE 1=1${schoolId ? ' AND sec.school_id = ?' : ''} ORDER BY sec.name`,
            schoolId ? [schoolId] : []
        );
        const [students] = await db.query(
            `SELECT st.id, st.lrn, st.firstname, st.lastname, st.middlename, st.grade_level_id, st.section_id, st.school_id,
                    st.status, st.category, sc.name as school_name, gl.name as grade_name, sec.name as section_name,
                    COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) as adviser,
                    at.contact as adviser_contact,
                    at.email as adviser_email
             FROM students st
             LEFT JOIN schools sc ON st.school_id = sc.id
             LEFT JOIN grade_levels gl ON st.grade_level_id = gl.id
             LEFT JOIN sections sec ON st.section_id = sec.id
             LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
             WHERE st.status != 'deleted'${schoolId ? ' AND st.school_id = ?' : ''} ORDER BY st.lastname, st.firstname`,
            schoolId ? [schoolId] : []
        );

        const sectionsByGrade = new Map();
        sections.forEach(section => {
            section.students = [];
            if (!sectionsByGrade.has(section.grade_level_id)) sectionsByGrade.set(section.grade_level_id, []);
            sectionsByGrade.get(section.grade_level_id).push(section);
        });

        const sectionsById = new Map(sections.map(section => [section.id, section]));
        students.forEach(student => {
            const section = sectionsById.get(student.section_id);
            if (section) section.students.push(student);
        });

        const gradesBySchool = new Map();
        grades.forEach(grade => {
            grade.sections = sectionsByGrade.get(grade.id) || [];
            if (!gradesBySchool.has(grade.school_id)) gradesBySchool.set(grade.school_id, []);
            gradesBySchool.get(grade.school_id).push(grade);
        });

        const payload = schools.map(school => ({
            ...school,
            grade_levels: gradesBySchool.get(school.id) || []
        }));

        return res.json({ schools: payload });
    } catch (err) {
        console.error('Mobile school structure error:', err);
        return res.status(500).json({ error: 'Failed to load mobile school structure.' });
    }
});

// ---- Users (admin management) ----
router.get('/users', requireRole('super_admin'), async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT u.id, u.username, u.fullname, u.email, u.role, u.school_id, u.status, u.last_login, u.created_at, s.name as school_name
             FROM users u LEFT JOIN schools s ON u.school_id = s.id ORDER BY u.fullname`
        );
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch users.' });
    }
});

// ---- Attendance records ----
router.get('/attendance', requireAuth, async (req, res) => {
    try {
        const date = req.query.date || todayDate();
        let query = `SELECT a.*,
            CASE WHEN a.person_type = 'student' THEN TRIM(CONCAT_WS(' ', s.firstname, s.lastname))
                 ELSE TRIM(CONCAT_WS(' ', t.firstname, t.lastname))
            END as person_name,
            s.lrn,
            t.employee_id,
            sc.name as school_name,
            gl.name as grade_name,
            sec.name as section_name,
            COALESCE(a.monitoring_status, CASE
                WHEN a.person_type = 'student' AND a.time_in IS NOT NULL THEN 'Inside School'
                WHEN a.person_type = 'teacher' AND a.time_in IS NOT NULL AND a.time_out IS NULL THEN 'Pending Time Out'
                WHEN a.time_out IS NOT NULL THEN 'Complete'
                ELSE 'No Time In'
            END) as monitoring_status
            FROM attendance a
            LEFT JOIN students s ON a.person_type = 'student' AND a.person_id = s.id
            LEFT JOIN teachers t ON a.person_type = 'teacher' AND a.person_id = t.id
            LEFT JOIN schools sc ON sc.id = COALESCE(s.school_id, t.school_id, a.school_id)
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            WHERE a.date = ?`;
        const params = [date];

        if (req.session.user.role === 'adviser') {
            // Advisers see only their own section's students — enforce server-side
            const tid = req.session.user.teacher_id;
            const [[tc]] = await db.query(`SELECT section_id, school_id FROM teachers WHERE id = ?`, [tid]).catch(() => [[null]]);
            if (!tc || !tc.section_id) return res.json([]);
            query += " AND a.person_type = 'student' AND s.section_id = ? AND a.school_id = ?";
            params.push(tc.section_id, tc.school_id);
        } else {
            const schoolId = applySchoolFilter(req);
            if (schoolId) { query += ' AND a.school_id = ?'; params.push(schoolId); }
            if (req.query.type) { query += ' AND a.person_type = ?'; params.push(req.query.type); }
        }

        query += ' ORDER BY a.time_in DESC';
        const [rows] = await db.query(query, params);
        decorateLateHalfDays(rows, await getPmLateTime());
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch attendance.' });
    }
});

// ---- Settings ----
router.get('/settings', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM settings');
        const settings = {};
        rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
        return res.json(settings);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch settings.' });
    }
});

router.post('/settings', requireRole('super_admin'), async (req, res) => {
    try {
        const entries = Object.entries(req.body);
        for (const [key, value] of entries) {
            await db.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [key, value, value]
            );
        }
        invalidateLiveDashboardCaches();
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to save settings.' });
    }
});

router.put('/settings', requireRole('super_admin'), async (req, res) => {
    try {
        const entries = Object.entries(req.body);
        for (const [key, value] of entries) {
            await db.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [key, value, value]
            );
        }
        invalidateLiveDashboardCaches();
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to save settings.' });
    }
});

// ---- System Logo Upload ----
router.post('/settings/logo', requireRole('super_admin'), (req, res) => {
    const systemLogoUpload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 2 * 1024 * 1024 },
        fileFilter: function (req, file, cb) {
            const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
            const ext = path.extname(file.originalname).toLowerCase();
            if (allowed.includes(ext)) cb(null, true);
            else cb(new Error('Only image files are allowed.'));
        }
    }).single('logo');

    systemLogoUpload(req, res, async function(err) {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        try {
            const logoPath = uploadedFileToDataUrl(req.file);
            await db.query(
                "INSERT INTO settings (setting_key, setting_value) VALUES ('system_logo', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
                [logoPath, logoPath]
            );
            invalidateLiveDashboardCaches();
            return res.json({ success: true, logo: logoPath });
        } catch (e) {
            return res.status(500).json({ error: 'Failed to save logo.' });
        }
    });
});

router.delete('/settings/logo', requireRole('super_admin'), async (req, res) => {
    try {
        const [[row]] = await db.query("SELECT setting_value FROM settings WHERE setting_key='system_logo'");
        if (row && row.setting_value && String(row.setting_value).startsWith('/uploads/')) {
            const filePath = path.join(__dirname, '..', 'public', row.setting_value);
            const fs = require('fs');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        await db.query("DELETE FROM settings WHERE setting_key='system_logo'");
        invalidateLiveDashboardCaches();
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to remove logo.' });
    }
});

// ---- Mobile Dashboard School Art Upload ----
router.post('/settings/mobile-dashboard-art', requireRole('super_admin'), (req, res) => {
    logoUpload.single('logo')(req, res, async function(err) {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        try {
            const art = uploadedFileToDataUrl(req.file);
            await db.query(
                "INSERT INTO settings (setting_key, setting_value) VALUES ('mobile_dashboard_school_art', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
                [art, art]
            );
            invalidateLiveDashboardCaches();
            return res.json({ success: true, art });
        } catch (e) {
            return res.status(500).json({ error: 'Failed to save mobile dashboard school art.' });
        }
    });
});

router.delete('/settings/mobile-dashboard-art', requireRole('super_admin'), async (req, res) => {
    try {
        await db.query("DELETE FROM settings WHERE setting_key='mobile_dashboard_school_art'");
        invalidateLiveDashboardCaches();
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to remove mobile dashboard school art.' });
    }
});

// ---- AI Daily Report Notification Icon ----
// The image the mobile app shows as the large icon on the 7 PM daily report
// notification (e.g. a robot icon). Stored as a base64 data URL setting and
// delivered to the app via /mobile-branding.
router.post('/settings/ai-report-icon', requireRole('super_admin'), (req, res) => {
    logoUpload.single('logo')(req, res, async function(err) {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        try {
            const icon = uploadedFileToDataUrl(req.file);
            await db.query(
                "INSERT INTO settings (setting_key, setting_value) VALUES ('ai_report_icon', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
                [icon, icon]
            );
            invalidateLiveDashboardCaches();
            return res.json({ success: true, icon });
        } catch (e) {
            return res.status(500).json({ error: 'Failed to save AI report icon.' });
        }
    });
});

router.delete('/settings/ai-report-icon', requireRole('super_admin'), async (req, res) => {
    try {
        await db.query("DELETE FROM settings WHERE setting_key='ai_report_icon'");
        invalidateLiveDashboardCaches();
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to remove AI report icon.' });
    }
});

const platformLogoKeys = {
    android: 'platform_android_logo',
    ios: 'platform_ios_logo',
    windows: 'platform_windows_logo',
    mac: 'platform_mac_logo'
};

// ---- Landing Page Platform Logo Uploads ----
router.post('/settings/platform-logo/:platform', requireRole('super_admin'), (req, res) => {
    const settingKey = platformLogoKeys[String(req.params.platform || '').toLowerCase()];
    if (!settingKey) return res.status(400).json({ error: 'Unsupported platform logo.' });

    logoUpload.single('logo')(req, res, async function(err) {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        try {
            const logoPath = uploadedFileToDataUrl(req.file);
            await db.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [settingKey, logoPath, logoPath]
            );
            invalidateLiveDashboardCaches();
            return res.json({ success: true, logo: logoPath });
        } catch (e) {
            return res.status(500).json({ error: 'Failed to save platform logo.' });
        }
    });
});

router.delete('/settings/platform-logo/:platform', requireRole('super_admin'), async (req, res) => {
    const settingKey = platformLogoKeys[String(req.params.platform || '').toLowerCase()];
    if (!settingKey) return res.status(400).json({ error: 'Unsupported platform logo.' });
    try {
        await db.query('DELETE FROM settings WHERE setting_key = ?', [settingKey]);
        invalidateLiveDashboardCaches();
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to remove platform logo.' });
    }
});

// ---- Status Counts (inactive / deleted) ----
router.get('/status-counts', requireAuth, async (req, res) => {
    try {
        const [[si]] = await db.query("SELECT COUNT(*) as c FROM students WHERE status='inactive'");
        const [[ti]] = await db.query("SELECT COUNT(*) as c FROM teachers WHERE status='inactive'");
        const [[sd]] = await db.query("SELECT COUNT(*) as c FROM students WHERE status='deleted'");
        const [[td]] = await db.query("SELECT COUNT(*) as c FROM teachers WHERE status='deleted'");
        return res.json({
            inactive_students: si.c,
            inactive_teachers: ti.c,
            deleted_students: sd.c,
            deleted_teachers: td.c
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch status counts.' });
    }
});

// ---- Bulk Activate All Inactive ----
router.post('/bulk-activate', requireRole('super_admin'), async (req, res) => {
    try {
        const [sr] = await db.query("UPDATE students SET status='active', active_from=CURDATE() WHERE status='inactive'");
        const [tr] = await db.query("UPDATE teachers SET status='active' WHERE status='inactive'");
        return res.json({ success: true, students: sr.affectedRows, teachers: tr.affectedRows });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to activate.' });
    }
});

// ---- Permanently Remove Deleted Records ----
router.post('/bulk-purge-deleted', requireRole('super_admin'), async (req, res) => {
    try {
        const [sr] = await db.query("DELETE FROM students WHERE status='deleted'");
        const [tr] = await db.query("DELETE FROM teachers WHERE status='deleted'");
        return res.json({ success: true, students: sr.affectedRows, teachers: tr.affectedRows });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to purge.' });
    }
});

// ---- Holidays CRUD ----
router.get('/holidays', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT h.*, s.name AS school_name FROM holidays h LEFT JOIN schools s ON h.school_id = s.id ORDER BY h.holiday_date`
        );
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch holidays.' });
    }
});

router.post('/holidays', requireRole('super_admin'), async (req, res) => {
    const { name, holiday_date, is_national, school_id } = req.body;
    if (!name || !holiday_date) return res.status(400).json({ error: 'Name and date are required.' });
    const holidayType = ['0', '1', '2'].includes(String(is_national)) ? Number(is_national) : 1;
    try {
        await db.query(
            'INSERT INTO holidays (holiday_date, name, school_id, is_national) VALUES (?, ?, ?, ?)',
            [holiday_date, name, school_id || null, holidayType]
        );
        return res.json({ success: true });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Holiday already exists for that date.' });
        return res.status(500).json({ error: 'Failed to add holiday.' });
    }
});

router.delete('/holidays/:id', requireRole('super_admin'), async (req, res) => {
    try {
        await db.query('DELETE FROM holidays WHERE id = ?', [req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete holiday.' });
    }
});

// ---- Admin Users CRUD ----
router.post('/users', requireRole('super_admin'), async (req, res) => {
    const { username, fullname, email, password, role, school_id, status } = req.body;
    if (!username || !fullname || !password) return res.status(400).json({ error: 'Username, full name, and password are required.' });
    const validRoles = ['super_admin', 'principal', 'superintendent', 'asst_superintendent'];
    if (role && !validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role selected.' });
    if (role === 'principal' && !school_id) return res.status(400).json({ error: 'Principal accounts must be assigned to a school.' });
    try {
        const bcrypt = require('bcrypt');
        const hash = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (username, password, fullname, email, role, school_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [username, hash, fullname, email || null, role || 'principal', school_id || null, status || 'active']
        );
        return res.json({ success: true });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already exists.' });
        return res.status(500).json({ error: 'Failed to create admin.' });
    }
});

router.put('/users/:id', requireRole('super_admin'), async (req, res) => {
    const { username, fullname, email, password, role, school_id, status } = req.body;
    if (!username || !fullname) return res.status(400).json({ error: 'Username and full name are required.' });
    const validRoles = ['super_admin', 'principal', 'superintendent', 'asst_superintendent'];
    if (role && !validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role selected.' });
    if (role === 'principal' && !school_id) return res.status(400).json({ error: 'Principal accounts must be assigned to a school.' });
    try {
        const requestedStatus = status && ['active', 'inactive'].includes(status) ? status : 'active';
        if (requestedStatus === 'inactive') {
            const [[current]] = await db.query('SELECT role FROM users WHERE id = ?', [req.params.id]);
            if (current?.role === 'super_admin') {
                const [[countRow]] = await db.query("SELECT COUNT(*) as count FROM users WHERE role='super_admin' AND status='active' AND id != ?", [req.params.id]);
                if ((countRow.count || 0) < 1) return res.status(400).json({ error: 'At least one active Super Admin account is required.' });
            }
        }
        if (password) {
            const bcrypt = require('bcrypt');
            const hash = await bcrypt.hash(password, 10);
            await db.query(
                'UPDATE users SET username=?, fullname=?, email=?, password=?, role=?, school_id=?, status=? WHERE id=?',
                [username, fullname, email || null, hash, role || 'principal', school_id || null, requestedStatus, req.params.id]
            );
        } else {
            await db.query(
                'UPDATE users SET username=?, fullname=?, email=?, role=?, school_id=?, status=? WHERE id=?',
                [username, fullname, email || null, role || 'principal', school_id || null, requestedStatus, req.params.id]
            );
        }
        return res.json({ success: true });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already exists.' });
        return res.status(500).json({ error: 'Failed to update admin.' });
    }
});

router.delete('/users/:id', requireRole('super_admin'), async (req, res) => {
    try {
        const [[current]] = await db.query('SELECT role, status FROM users WHERE id = ?', [req.params.id]);
        if (!current) return res.status(404).json({ error: 'User not found.' });
        if (current.role === 'super_admin' && current.status === 'active') {
            const [[countRow]] = await db.query("SELECT COUNT(*) as count FROM users WHERE role='super_admin' AND status='active' AND id != ?", [req.params.id]);
            if ((countRow.count || 0) < 1) return res.status(400).json({ error: 'At least one active Super Admin account is required.' });
        }
        await db.query('UPDATE users SET status = ? WHERE id = ?', ['inactive', req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to deactivate user.' });
    }
});

// ---- User Logs ----
router.get('/user-logs', requireAuth, async (req, res) => {
    try {
        let query = `SELECT ul.*, u.username, u.fullname FROM user_logs ul
             LEFT JOIN users u ON ul.user_id = u.id WHERE 1=1`;
        const params = [];
        if (req.query.date) {
            query += ' AND DATE(ul.created_at) = ?';
            params.push(req.query.date);
        }
        query += ' ORDER BY ul.created_at DESC LIMIT 200';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch logs.' });
    }
});

// ---- SMS Logs ----
router.get('/sms-logs', requireAuth, async (req, res) => {
    try {
        let query = 'SELECT * FROM sms_logs WHERE 1=1';
        const params = [];
        if (req.query.date) {
            query += ' AND DATE(created_at) = ?';
            params.push(req.query.date);
        }
        if (req.query.status) {
            query += ' AND status = ?';
            params.push(req.query.status);
        }
        query += ' ORDER BY created_at DESC LIMIT 200';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch SMS logs.' });
    }
});

// ---- Events ----
router.get('/events', requireAuth, async (req, res) => {
    try {
        const schoolId = applySchoolFilter(req);
        let query = `SELECT e.*, s.name as school_name FROM events e LEFT JOIN schools s ON e.school_id = s.id WHERE 1=1`;
        const params = [];
        if (schoolId) { query += ' AND e.school_id = ?'; params.push(schoolId); }
        if (req.query.status) { query += ' AND e.status = ?'; params.push(req.query.status); }
        query += ' ORDER BY e.event_date DESC';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch events.' });
    }
});

router.post('/events', requireRole('super_admin'), async (req, res) => {
    const { name, description, event_date, school_id } = req.body;
    if (!name || !event_date) return res.status(400).json({ error: 'Name and date are required.' });
    try {
        const [result] = await db.query(
            'INSERT INTO events (name, description, event_date, school_id) VALUES (?, ?, ?, ?)',
            [name, description || null, event_date, school_id || null]
        );
        return res.json({ success: true, id: result.insertId });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to create event.' });
    }
});

router.put('/events/:id', requireRole('super_admin'), async (req, res) => {
    const { name, description, event_date, school_id, status } = req.body;
    try {
        await db.query(
            'UPDATE events SET name=?, description=?, event_date=?, school_id=?, status=? WHERE id=?',
            [name, description || null, event_date, school_id || null, status || 'active', req.params.id]
        );
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update event.' });
    }
});

router.delete('/events/:id', requireRole('super_admin'), async (req, res) => {
    try {
        await db.query('UPDATE events SET status = ? WHERE id = ?', ['cancelled', req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete event.' });
    }
});

// ---- Event Attendance ----
router.get('/event-attendance', requireAuth, async (req, res) => {
    const eventId = req.query.event_id;
    if (!eventId) return res.status(400).json({ error: 'event_id is required.' });
    try {
        const [rows] = await db.query(
            `SELECT ea.*,
                CASE WHEN ea.person_type = 'student' THEN (SELECT CONCAT(firstname, ' ', lastname) FROM students WHERE id = ea.person_id)
                     ELSE (SELECT CONCAT(firstname, ' ', lastname) FROM teachers WHERE id = ea.person_id)
                END as person_name,
                s.name as school_name
             FROM event_attendance ea LEFT JOIN schools s ON ea.school_id = s.id
             WHERE ea.event_id = ? ORDER BY ea.created_at DESC`,
            [eventId]
        );
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch event attendance.' });
    }
});

// ---- School Days ----
router.get('/school-days', requireAuth, async (req, res) => {
    try {
        let query = 'SELECT * FROM school_days WHERE 1=1';
        const params = [];
        if (req.query.month) {
            query += ' AND DATE_FORMAT(date, "%Y-%m") = ?';
            params.push(req.query.month);
        }
        query += ' ORDER BY date DESC';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch school days.' });
    }
});

router.post('/school-days', requireRole('super_admin'), async (req, res) => {
    const { date, is_school_day, reason } = req.body;
    if (!date) return res.status(400).json({ error: 'Date is required.' });
    try {
        await db.query(
            'INSERT INTO school_days (date, is_school_day, reason) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE is_school_day = VALUES(is_school_day), reason = VALUES(reason)',
            [date, is_school_day !== undefined ? is_school_day : 1, reason || null]
        );
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to save school day.' });
    }
});

router.delete('/school-days/:id', requireRole('super_admin'), async (req, res) => {
    try {
        await db.query('DELETE FROM school_days WHERE id = ?', [req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete school day.' });
    }
});

// ---- Reports Data ----
router.get('/reports', requireAuth, async (req, res) => {
    const startDate = req.query.start_date || todayDate();
    const endDate = req.query.end_date || startDate;
    const type = req.query.type || 'student';
    const schoolId = applySchoolFilter(req);
    try {
        let query = `SELECT a.date, a.person_type, a.time_in, a.time_out, a.status,
            CASE WHEN a.person_type = 'student' THEN (SELECT CONCAT(firstname, ' ', lastname) FROM students WHERE id = a.person_id)
                 ELSE (SELECT CONCAT(firstname, ' ', lastname) FROM teachers WHERE id = a.person_id)
            END as person_name,
            s.name as school_name
            FROM attendance a LEFT JOIN schools s ON a.school_id = s.id
            WHERE a.date BETWEEN ? AND ? AND a.person_type = ?`;
        const params = [startDate, endDate, type];
        if (schoolId) { query += ' AND a.school_id = ?'; params.push(schoolId); }
        query += ' ORDER BY a.date DESC, a.time_in DESC';
        const [rows] = await db.query(query, params);
        const records = rows.map(row => ({
            ...row,
            monitoring_status: row.person_type === 'student'
                ? (row.time_in ? 'Inside School' : 'No Time In')
                : (row.time_in && !row.time_out ? 'Pending Time Out' : (row.time_out ? 'Complete' : 'No Time In'))
        }));

        // Stats summary
        const totalDays = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
        const uniquePersons = new Set(records.map(r => r.person_name)).size;
        const presentCount = records.filter(r => r.status === 'present').length;
        const lateCount = records.filter(r => r.status === 'late').length;
        const halfDayCount = records.filter(r => r.status === 'half_day').length;

        return res.json({
            records,
            summary: {
                total_days: totalDays,
                unique_persons: uniquePersons,
                present_count: presentCount,
                late_count: lateCount,
                half_day_count: halfDayCount,
                total_records: records.length
            }
        });
    } catch (err) {
        console.error('Reports error:', err);
        return res.status(500).json({ error: 'Failed to generate report.' });
    }
});

// ---- Reports: Daily Summary (per-school) ----
router.get('/reports/daily-summary', requireAuth, async (req, res) => {
    const date = req.query.date || todayDate();
    const schoolId = applySchoolFilter(req);
    try {
        let query = `
            SELECT s.id, s.name, s.logo,
                (SELECT COUNT(*) FROM students st WHERE st.school_id = s.id AND st.status = 'active') as enrolled,
                (SELECT COUNT(*) FROM teachers t WHERE t.school_id = s.id AND t.status = 'active') as teachers_total
            FROM schools s WHERE s.status = 'active'`;
        const params = [];
        if (schoolId) { query += ' AND s.id = ?'; params.push(schoolId); }
        query += ' ORDER BY s.name';
        const [rows] = await db.query(query, params);

        const schools = [];
        for (const s of rows) {
            const studentCounts = await getAttendanceStatusCounts('student', date, { schoolId: s.id });
            const teacherCounts = await getAttendanceStatusCounts('teacher', date, { schoolId: s.id });
            const eligible = Math.max(await countAttendanceEligibleStudents(date, s.id), studentCounts.timed_in || 0);
            const eligibleTeachers = Math.max(await countAttendanceEligibleTeachers(date, s.id), teacherCounts.timed_in || 0);
            schools.push({
                id: s.id,
                name: s.name,
                logo: s.logo,
                enrolled: eligible,
                present: studentCounts.present,
                late: studentCounts.late,
                half_day: studentCounts.half_day,
                full_day: studentCounts.full_day,
                absent: await countStudentsWithoutTimeIn(date, s.id),
                rate: eligible > 0 ? Math.min(100, Math.round((studentCounts.full_day / eligible) * 100)) : 0,
                teachers_present: teacherCounts.present,
                teachers_late: teacherCounts.late,
                teachers_half_day: teacherCounts.half_day,
                teachers_full_day: teacherCounts.full_day,
                teachers_total: s.teachers_total || 0,
                attendance_eligible_teachers: eligibleTeachers,
                teachers_absent: await countTeachersWithoutTimeIn(date, s.id)
            });
        }

        // Totals
        const totals = schools.reduce((acc, s) => {
            acc.enrolled += s.enrolled;
            acc.present += s.present;
            acc.late += s.late;
            acc.half_day += s.half_day;
            acc.full_day += s.full_day;
            acc.absent += s.absent;
            acc.teachers_present += s.teachers_present;
            acc.teachers_late += s.teachers_late;
            acc.teachers_half_day += s.teachers_half_day;
            acc.teachers_full_day += s.teachers_full_day;
            acc.teachers_total += s.teachers_total;
            acc.teachers_absent += s.teachers_absent;
            return acc;
        }, { enrolled: 0, present: 0, late: 0, half_day: 0, full_day: 0, absent: 0, teachers_present: 0, teachers_late: 0, teachers_half_day: 0, teachers_full_day: 0, teachers_total: 0, teachers_absent: 0 });
        totals.rate = totals.enrolled > 0 ? Math.min(100, Math.round((totals.full_day / totals.enrolled) * 100)) : 0;

        return res.json({ schools, totals });
    } catch (err) {
        console.error('Daily summary error:', err);
        return res.status(500).json({ error: 'Failed to generate daily summary.' });
    }
});

// ---- Reports: Absentee List ----
router.get('/reports/absentees', requireAuth, async (req, res) => {
    const date = req.query.date || todayDate();
    const schoolId = applySchoolFilter(req);
    try {
        if (!(await shouldCountComputedAbsences(date, schoolId))) {
            return res.json([]);
        }
        let query = `SELECT s.id, s.firstname, s.lastname, s.lrn, s.section_id, sc.name as school_name,
                sc.contact as school_contact, gl.name as grade_name, sec.name as section_name,
                COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) as adviser,
                at.contact as adviser_contact,
                at.email as adviser_email
            FROM students s
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
            WHERE s.status = 'active'
              AND COALESCE(s.active_from, DATE(s.created_at)) < ?
              AND NOT EXISTS (
                  SELECT 1 FROM attendance a
                  WHERE a.person_type = 'student'
                    AND a.person_id = s.id
                    AND a.date = ?
                    AND a.time_in IS NOT NULL
              )`;
        const params = [date, date];
        if (schoolId) { query += ' AND s.school_id = ?'; params.push(schoolId); }
        query += ' ORDER BY sc.name, gl.name, sec.name, s.lastname';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        console.error('Absentee list error:', err);
        return res.status(500).json({ error: 'Failed to generate absentee list.' });
    }
});

// ---- Mobile/Web: Date Attendance Details ----
router.get('/date-attendance-details', requireAuth, async (req, res) => {
    const targetDate = req.query.date || todayDate();
    const schoolId = applySchoolFilter(req);
    try {
        const today = todayDate();
        const isFutureDate = targetDate > today;
        const schoolFilter = schoolId ? ' AND s.school_id = ?' : '';
        const schoolParams = schoolId ? [targetDate, schoolId] : [targetDate];
        const schoolDay = await checkSchoolDay(targetDate, schoolId);
        const canCountAbsences = await shouldCountComputedAbsences(targetDate, schoolId);

        const [[totalRow]] = await db.query(
            `SELECT COUNT(*) as cnt FROM students s WHERE s.status = 'active' AND COALESCE(s.active_from, DATE(s.created_at)) < ?` + schoolFilter,
            schoolParams
        );

        // Prevent false absences on future dates, weekends, holidays, and declared non-school days.
        if (isFutureDate || !schoolDay.isSchoolDay) {
            return res.json({
                date: targetDate,
                is_future_date: isFutureDate,
                is_school_day: schoolDay.isSchoolDay,
                absence_counting_active: false,
                non_school_day_reason: schoolDay.reason,
                totals: {
                    students_total: totalRow.cnt,
                    present: 0,
                    attended: 0,
                    late: 0,
                    half_day: 0,
                    absent: 0
                },
                present_students: [],
                absent_students: []
            });
        }

        let presentQuery = `SELECT s.id, s.firstname, s.lastname, s.lrn,
                gl.name as grade_name, sec.name as section_name,
                COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) as adviser,
                at.contact as adviser_contact,
                at.email as adviser_email,
                sc.name as school_name,
                CASE
                    WHEN SUM(CASE WHEN a.status = 'half_day' THEN 1 ELSE 0 END) > 0 THEN 'Half-Day'
                    WHEN SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) > 0 THEN 'Late'
                    ELSE 'Present'
                END as attendance_status,
                MAX(a.status) as att_status,
                MAX(a.time_in) as time_in,
                MAX(a.monitoring_status) as monitoring_status
            FROM attendance a
            INNER JOIN students s ON a.person_id = s.id
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
            WHERE a.person_type = 'student'
              AND s.status = 'active'
              AND a.date = ?
              AND a.time_in IS NOT NULL`;
        const presentParams = [targetDate];
        if (schoolId) { presentQuery += ' AND a.school_id = ?'; presentParams.push(schoolId); }
        presentQuery += ` GROUP BY s.id, s.firstname, s.lastname, s.lrn, gl.name, sec.name, sec.adviser, at.firstname, at.middlename, at.lastname, at.contact, at.email, sc.name
                          ORDER BY s.lastname, s.firstname`;

        let absentQuery = `SELECT s.id, s.firstname, s.lastname, s.lrn,
                gl.name as grade_name, sec.name as section_name,
                COALESCE(NULLIF(sec.adviser, ''), TRIM(CONCAT_WS(' ', at.firstname, at.middlename, at.lastname))) as adviser,
                at.contact as adviser_contact,
                at.email as adviser_email,
                sc.name as school_name
            FROM students s
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            LEFT JOIN teachers at ON sec.adviser_teacher_id = at.id
            WHERE s.status = 'active'
              AND COALESCE(s.active_from, DATE(s.created_at)) < ?
              AND NOT EXISTS (
                  SELECT 1 FROM attendance a
                  WHERE a.person_type = 'student'
                    AND a.person_id = s.id
                    AND a.date = ?
                    AND a.time_in IS NOT NULL
              )`;
        const absentParams = [targetDate, targetDate];
        if (schoolId) { absentQuery += ' AND s.school_id = ?'; absentParams.push(schoolId); }
        absentQuery += ' ORDER BY s.lastname, s.firstname';

        const [presentRows, absentRows] = await Promise.all([
            db.query(presentQuery, presentParams).then(r => r[0]),
            canCountAbsences ? db.query(absentQuery, absentParams).then(r => r[0]) : Promise.resolve([]),
        ]);

        const streakFlags = canCountAbsences
            ? await getConsecutiveAbsenceFlags({
                baseDate: targetDate,
                schoolId,
                days: 1,
                includeTeachers: false,
                maxScanDays: 60
            })
            : [];
        const streakByStudentId = new Map(
            streakFlags.map(item => [String(item.id), item])
        );

        const pmLateTime = await getPmLateTime();
        const presentStudents = presentRows.map(row => {
            const lateHalf = isLateHalfDay(row.att_status, row.time_in, pmLateTime);
            return {
                ...row,
                name: `${row.firstname || ''} ${row.lastname || ''}`.trim() || 'Student',
                late_half_day: lateHalf,
                // Keep attendance_status filter/count-stable ('Half-Day'); views append
                // "(Late)" using late_half_day so the Half-Day filter still matches.
                attendance_status: row.attendance_status || 'Present',
                monitoring_status: row.monitoring_status || 'Inside School',
                attendance_date: targetDate,
                absent_days: 0,
                absent_from_date: null
            };
        });
        const absentStudents = absentRows.map(row => ({
            ...(() => {
                const streak = streakByStudentId.get(String(row.id));
                const absentDays = Math.max(1, parseInt(streak?.absent_days, 10) || 1);
                const checkedDates = Array.isArray(streak?.checked_dates) ? streak.checked_dates : [];
                const absentFromDate = checkedDates.length
                    ? checkedDates[checkedDates.length - 1]
                    : targetDate;
                return {
                    absent_days: absentDays,
                    absent_from_date: absentFromDate
                };
            })(),
            ...row,
            name: `${row.firstname || ''} ${row.lastname || ''}`.trim() || 'Student',
            attendance_status: 'Absent',
            monitoring_status: 'No Time In',
            attendance_date: targetDate
        }));
        const statusKey = value => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
        const lateCount = presentStudents.filter(s => statusKey(s.att_status || s.attendance_status) === 'late').length;
        const halfDayCount = presentStudents.filter(s => statusKey(s.att_status || s.attendance_status) === 'half_day').length;

        return res.json({
            date: targetDate,
            is_school_day: schoolDay.isSchoolDay,
            absence_counting_active: canCountAbsences,
            non_school_day_reason: schoolDay.reason,
            totals: {
                students_total: totalRow.cnt,
                present: presentStudents.length,
                attended: presentStudents.length,
                late: lateCount,
                half_day: halfDayCount,
                absent: absentStudents.length
            },
            present_students: presentStudents,
            absent_students: absentStudents
        });
    } catch (err) {
        console.error('Date attendance details error:', err);
        return res.status(500).json({ error: 'Failed to load date attendance details.' });
    }
});

// ---- Absence Flagging (2+ consecutive days) ----
router.get('/absence-flags', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const days = parseInt(req.query.days) || 2;
    let schoolId = applySchoolFilter(req);
    if (!schoolId && (req.query.school_id || req.query.school)) schoolId = parseInt(req.query.school_id || req.query.school, 10);
    try {
        const baseDate = req.query.date || todayDate();
        const includeTeachers = req.query.include_teachers !== '0';
        const flagged = await getConsecutiveAbsenceFlags({
            baseDate,
            schoolId,
            days,
            includeTeachers,
            maxScanDays: parseInt(req.query.max_days, 10) || 45
        });

        return res.json(flagged);
    } catch (err) {
        console.error('Absence flags error:', err);
        return res.status(500).json({ error: 'Failed to check absence flags.' });
    }
});

// ---- Not Scanned Today ----
router.get('/not-scanned-today', requireAuth, async (req, res) => {
    const today = req.query.date || todayDate();
    const type = req.query.type || 'student';
    const schoolId = applySchoolFilter(req);
    try {
        const schoolDay = await checkSchoolDay(today, schoolId);
        const canCountAbsences = await shouldCountComputedAbsences(today, schoolId);
        if (today > todayDate() || !schoolDay.isSchoolDay) {
            return res.json([]);
        }

        let query, params;
        if (type === 'student') {
            query = `SELECT s.id, s.firstname, s.lastname, s.lrn, sc.name as school_name,
                gl.name as grade_name, sec.name as section_name
                FROM students s
                LEFT JOIN schools sc ON s.school_id = sc.id
                LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
                LEFT JOIN sections sec ON s.section_id = sec.id
                WHERE s.status = 'active'
                AND COALESCE(s.active_from, DATE(s.created_at)) < ?
                AND s.id NOT IN (SELECT person_id FROM attendance WHERE person_type = 'student' AND date = ?)`;
            params = [today, today];
            if (schoolId) { query += ' AND s.school_id = ?'; params.push(schoolId); }
        } else {
            query = `SELECT t.id, t.firstname, t.lastname, t.employee_id, sc.name as school_name
                FROM teachers t
                LEFT JOIN schools sc ON t.school_id = sc.id
                WHERE t.status = 'active'
                AND COALESCE(t.active_from, DATE(t.created_at)) < ?
                AND t.id NOT IN (SELECT person_id FROM attendance WHERE person_type = 'teacher' AND date = ?)`;
            params = [today, today];
            if (schoolId) { query += ' AND t.school_id = ?'; params.push(schoolId); }
        }
        query += ' ORDER BY lastname, firstname';
        const [rows] = await db.query(query, params);
        return res.json(rows.map(row => ({
            ...row,
            attendance_status: canCountAbsences ? 'Absent' : 'Pending',
            monitoring_status: canCountAbsences ? 'No Time In' : 'Not Yet Timed In'
        })));
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch not-scanned list.' });
    }
});

// ---- Inactive Students ----
router.get('/inactive-students', requireAuth, async (req, res) => {
    const schoolId = applySchoolFilter(req);
    try {
        let query = `SELECT s.*, sc.name as school_name, gl.name as grade_name, sec.name as section_name
            FROM students s
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            WHERE s.status = 'inactive'`;
        const params = [];
        if (schoolId) { query += ' AND s.school_id = ?'; params.push(schoolId); }
        query += ' ORDER BY s.lastname, s.firstname';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch inactive students.' });
    }
});

// ---- Check if today is a school day ----
router.get('/is-school-day', requireAuthOrScannerKiosk, async (req, res) => {
    const date = req.query.date || todayDate();
    try {
        const schoolId = normalizeOptionalSchoolId(req.query.school_id);
        const schoolDay = await checkSchoolDay(date, schoolId);
        return res.json({
            is_school_day: schoolDay.isSchoolDay,
            isSchoolDay: schoolDay.isSchoolDay,
            reason: schoolDay.reason,
            type: schoolDay.type
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to check school day.' });
    }
});

// ---- Notifications CRUD ----
router.get('/notifications', requireAuth, async (req, res) => {
    try {
        const schoolId = applySchoolFilter(req);
        let query = `SELECT n.*, s.name as school_name FROM notifications n
            LEFT JOIN schools s ON n.school_id = s.id WHERE 1=1`;
        const params = [];
        if (schoolId) { query += ' AND n.school_id = ?'; params.push(schoolId); }
        query += ' ORDER BY n.created_at DESC LIMIT 200';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        console.error('Get notifications error:', err);
        return res.status(500).json({ error: 'Failed to load notifications.' });
    }
});

router.post('/notifications', requireRole('super_admin'), async (req, res) => {
    const { title, message, type, school_id } = req.body;
    if (!title || !message) {
        return res.status(400).json({ error: 'Title and message are required.' });
    }
    try {
        await db.query(
            'INSERT INTO notifications (title, message, type, school_id) VALUES (?, ?, ?, ?)',
            [title, message, type || 'general', school_id || null]
        );
        return res.json({ success: true });
    } catch (err) {
        console.error('Create notification error:', err);
        return res.status(500).json({ error: 'Failed to create notification.' });
    }
});

router.delete('/notifications/:id', requireRole('super_admin'), async (req, res) => {
    try {
        await db.query('DELETE FROM notifications WHERE id = ?', [req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete notification.' });
    }
});

// ---- Backups API ----
router.get('/backups', requireRole('super_admin'), async (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const backupsDir = path.join(__dirname, '..', 'backups');
    try {
        if (!fs.existsSync(backupsDir)) {
            return res.json([]);
        }
        const files = fs.readdirSync(backupsDir)
            .filter(f => f.endsWith('.sql'))
            .map(f => {
                const stats = fs.statSync(path.join(backupsDir, f));
                return {
                    filename: f,
                    size: stats.size,
                    size_display: stats.size > 1048576
                        ? (stats.size / 1048576).toFixed(2) + ' MB'
                        : (stats.size / 1024).toFixed(2) + ' KB',
                    created_at: stats.mtime.toISOString()
                };
            })
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return res.json(files);
    } catch (err) {
        console.error('List backups error:', err);
        return res.status(500).json({ error: 'Failed to list backups.' });
    }
});

router.post('/backups', requireRole('super_admin'), async (req, res) => {
    const { execSync } = require('child_process');
    const path = require('path');
    const backupsDir = path.join(__dirname, '..', 'backups');
    const timestamp = timestampForFilename();
    const filename = `backup_${timestamp}.sql`;
    const filePath = path.join(backupsDir, filename);

    try {
        const dbName = process.env.DB_NAME || 'qr_attend';
        const dbUser = process.env.DB_USER || 'root';
        const dbPass = process.env.DB_PASS || '';
        const dbHost = process.env.DB_HOST || 'localhost';
        const dbPort = process.env.DB_PORT || '3306';

        let cmd = `"C:\\xampp\\mysql\\bin\\mysqldump.exe" -h ${dbHost} -P ${dbPort} -u ${dbUser}`;
        if (dbPass) cmd += ` -p${dbPass}`;
        cmd += ` ${dbName} > "${filePath}"`;

        execSync(cmd, { shell: true, timeout: 60000 });

        const fs = require('fs');
        const stats = fs.statSync(filePath);
        return res.json({
            success: true,
            filename,
            size: stats.size,
            size_display: stats.size > 1048576
                ? (stats.size / 1048576).toFixed(2) + ' MB'
                : (stats.size / 1024).toFixed(2) + ' KB'
        });
    } catch (err) {
        console.error('Create backup error:', err);
        return res.status(500).json({ error: 'Failed to create backup. Make sure mysqldump is available.' });
    }
});

router.get('/backups/:filename', requireRole('super_admin'), (req, res) => {
    const path = require('path');
    const fs = require('fs');
    const filename = path.basename(req.params.filename); // prevent directory traversal
    if (!filename.endsWith('.sql')) {
        return res.status(400).json({ error: 'Invalid file type.' });
    }
    const filePath = path.join(__dirname, '..', 'backups', filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup file not found.' });
    }
    res.download(filePath, filename);
});

router.delete('/backups/:filename', requireRole('super_admin'), (req, res) => {
    const path = require('path');
    const fs = require('fs');
    const filename = path.basename(req.params.filename); // prevent directory traversal
    if (!filename.endsWith('.sql')) {
        return res.status(400).json({ error: 'Invalid file type.' });
    }
    const filePath = path.join(__dirname, '..', 'backups', filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup file not found.' });
    }
    try {
        fs.unlinkSync(filePath);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete backup.' });
    }
});

// =============================================
// School KPI (today's attendance stats for a school)
// =============================================
router.get('/school-kpi/:id', requireAuth, async (req, res) => {
    const schoolId = parseInt(req.params.id, 10);
    const today = todayDate();
    try {
        const [totalStudents] = await db.query(
            "SELECT COUNT(*) as cnt FROM students WHERE school_id = ? AND status = 'active' AND COALESCE(active_from, DATE(created_at)) < ?", [schoolId, today]);
        const studentCounts = await getAttendanceStatusCounts('student', today, { schoolId });
        const absentStudents = await countStudentsWithoutTimeIn(today, schoolId);
        const [totalTeachers] = await db.query(
            "SELECT COUNT(*) as cnt FROM teachers WHERE school_id = ? AND status = 'active'", [schoolId]);
        const teacherCounts = await getAttendanceStatusCounts('teacher', today, { schoolId });
        const absentTeachers = await countTeachersWithoutTimeIn(today, schoolId);

        const present = studentCounts.present;
        const total = Math.max(totalStudents[0].cnt, studentCounts.timed_in);
        return res.json({
            students_total: total,
            students_present: present,
            students_late: studentCounts.late,
            students_half_day: studentCounts.half_day,
            students_absent: absentStudents,
            teachers_total: totalTeachers[0].cnt,
            teachers_present: teacherCounts.present,
            teachers_late: teacherCounts.late,
            teachers_half_day: teacherCounts.half_day,
            teachers_absent: absentTeachers
        });
    } catch (err) {
        console.error('School KPI error:', err);
        return res.status(500).json({ error: 'Failed to get KPI.' });
    }
});

// Section KPI (today's attendance stats for a section)
router.get('/section-kpi/:id', requireAuth, async (req, res) => {
    const sectionId = parseInt(req.params.id, 10);
    const today = todayDate();
    try {
        const [totalStudents] = await db.query(
            "SELECT COUNT(*) as cnt FROM students WHERE section_id = ? AND status = 'active' AND COALESCE(active_from, DATE(created_at)) < ?", [sectionId, today]);
        const studentCounts = await getAttendanceStatusCounts('student', today, { sectionId });
        const absentStudents = await countSectionStudentsWithoutTimeIn(today, sectionId);

        const present = studentCounts.present;
        const total = Math.max(totalStudents[0].cnt, studentCounts.timed_in);
        return res.json({
            total: total,
            present: present,
            late: studentCounts.late,
            half_day: studentCounts.half_day,
            absent: absentStudents
        });
    } catch (err) {
        console.error('Section KPI error:', err);
        return res.status(500).json({ error: 'Failed to get KPI.' });
    }
});

// ---- Adviser Dashboard API ----
router.get('/adviser-dashboard', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'adviser' || !user.teacher_id) {
        return res.status(403).json({ error: 'Access denied' });
    }
    const date = req.query.date || todayDate();
    try {
        const [teacher] = await db.query(
            `SELECT t.section_id, t.school_id, sec.name as section_name, gl.name as grade_name, sc.name as school_name, sc.logo as school_logo
             FROM teachers t
             LEFT JOIN sections sec ON t.section_id = sec.id
             LEFT JOIN grade_levels gl ON t.grade_level_id = gl.id
             LEFT JOIN schools sc ON t.school_id = sc.id
             WHERE t.id = ?`, [user.teacher_id]
        );
        if (teacher.length === 0) return res.status(404).json({ error: 'Teacher not found' });
        const sectionId = teacher[0].section_id;
        if (!sectionId) return res.json({ teacher: teacher[0], students: [], kpi: { total: 0, present: 0, late: 0, half_day: 0, absent: 0 } });

        const [students] = await db.query(
            `SELECT s.id, s.lrn, s.firstname, s.lastname, s.middlename, s.guardian_contact, s.category, s.status,
                    s.active_from, s.created_at,
                    a.time_in, a.time_out, a.last_time_in, a.status as att_status, a.monitoring_status
             FROM students s
             LEFT JOIN attendance a ON a.person_type = 'student' AND a.person_id = s.id AND a.date = ?
             WHERE s.section_id = ? AND s.status != 'deleted'
             ORDER BY s.lastname, s.firstname`, [date, sectionId]
        );

        const pmLateTime = await getPmLateTime();
        const activeStudents = students.filter(s => s.status === 'active');
        const present = activeStudents.filter(s => ['present', 'late', 'half_day'].includes(s.att_status));
        const late = activeStudents.filter(s => s.att_status === 'late');
        const halfDay = activeStudents.filter(s => s.att_status === 'half_day');
        const absent = activeStudents.filter(s => !s.att_status);

        // 2-day consecutive absence flagging — delegate to the same function the mobile app uses
        const schoolId = teacher[0].school_id;
        const flaggedResult = await getConsecutiveAbsenceFlags({
            baseDate: date,
            schoolId,
            days: 2,
            includeTeachers: false
        });
        const flaggedIds = flaggedResult
            .filter(f => f.section_id === sectionId)
            .map(f => f.id);

        return res.json({
            teacher: teacher[0],
            students: students.map(s => ({
                id: s.id,
                lrn: s.lrn,
                firstname: s.firstname,
                lastname: s.lastname,
                middlename: s.middlename || '',
                gender: s.gender || '',
                name: (s.lastname && s.firstname) ? s.lastname + ', ' + s.firstname + (s.middlename ? ' ' + s.middlename.charAt(0) + '.' : '') : s.firstname || s.lastname,
                guardian_contact: s.guardian_contact,
                category: s.category,
                student_status: s.status,
                time_in: s.time_in ? formatTime12(s.time_in) : null,
                time_out: s.time_out ? formatTime12(s.time_out) : null,
                last_time_in: s.last_time_in ? formatTime12(s.last_time_in) : null,
                att_status: s.att_status,
                monitoring_status: s.monitoring_status,
                late_half_day: isLateHalfDay(s.att_status, s.time_in, pmLateTime),
                attendance_status: statusLabel(s.att_status),
                flagged: flaggedIds.includes(s.id)
            })),
            kpi: {
                total: activeStudents.length,
                present: present.length,
                late: late.length,
                half_day: halfDay.length,
                absent: absent.length,
                flagged: flaggedIds.length
            }
        });
    } catch (err) {
        console.error('Adviser dashboard error:', err);
        return res.status(500).json({ error: 'Failed to load dashboard data.' });
    }
});

// ---- Adviser 7-Day Trend (section-scoped present counts) ----
router.get('/adviser-trend', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'adviser' || !user.teacher_id) {
        return res.status(403).json({ error: 'Access denied' });
    }
    const endDate = req.query.end_date || todayDate();
    const startDate = req.query.start_date || endDate;
    try {
        const [[teacher]] = await db.query('SELECT section_id FROM teachers WHERE id = ?', [user.teacher_id]);
        if (!teacher || !teacher.section_id) return res.json({ days: [] });
        const [rows] = await db.query(
            `SELECT a.date, COUNT(*) AS present
             FROM attendance a
             JOIN students s ON s.id = a.person_id AND s.section_id = ?
             WHERE a.person_type = 'student' AND a.date BETWEEN ? AND ? AND a.time_in IS NOT NULL
             GROUP BY a.date`,
            [teacher.section_id, startDate, endDate]
        );
        const counts = {};
        rows.forEach(r => {
            const key = (r.date instanceof Date) ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
            counts[key] = r.present;
        });
        return res.json({ days: counts });
    } catch (err) {
        console.error('Adviser trend error:', err);
        return res.status(500).json({ error: 'Failed to load trend.' });
    }
});

// ---- School Logo Upload ----
router.post('/schools/:id/logo', requireAuth, function(req, res) {
    logoUpload.single('logo')(req, res, async function(err) {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        try {
            const logoPath = uploadedFileToDataUrl(req.file);
            await db.query('UPDATE schools SET logo = ? WHERE id = ?', [logoPath, req.params.id]);
            return res.json({ success: true, logo: logoPath });
        } catch (e) {
            console.error('Logo upload error:', e);
            return res.status(500).json({ error: 'Failed to save logo.' });
        }
    });
});

router.delete('/schools/:id/logo', requireAuth, async (req, res) => {
    try {
        await db.query('UPDATE schools SET logo = NULL WHERE id = ?', [req.params.id]);
        return res.json({ success: true });
    } catch (e) {
        console.error('Logo delete error:', e);
        return res.status(500).json({ error: 'Failed to remove logo.' });
    }
});

// =============================================
// GET /api/monthly-attendance
// Returns per-day absent count for a given month
// ?year=2026&month=4&school_id=
// =============================================
router.get('/monthly-attendance', requireAuth, async (req, res) => {
    try {
        const year  = parseInt(req.query.year)  || new Date().getFullYear();
        const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
        const schoolId = applySchoolFilter(req) || (req.query.school_id ? parseInt(req.query.school_id) : null);

        const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
        const endDate   = new Date(year, month, 0).toISOString().slice(0,10);

        // Present counts per day (half-day attendees count as present)
        let pQuery = `SELECT DATE(a.date) as day, COUNT(DISTINCT a.person_id) as present
                      FROM attendance a
                      INNER JOIN students s ON a.person_id = s.id AND s.status = 'active'
                      WHERE a.person_type = 'student' AND a.date BETWEEN ? AND ? AND a.status IN ('present','late','half_day')`;
        const pParams = [startDate, endDate];
        if (schoolId) { pQuery += ' AND a.school_id = ?'; pParams.push(schoolId); }
        pQuery += ' GROUP BY DATE(a.date)';
        const [pRows] = await db.query(pQuery, pParams);

        const presMap = {};
        pRows.forEach(r => { presMap[r.day.toISOString ? r.day.toISOString().slice(0,10) : String(r.day).slice(0,10)] = r.present; });

        // Build calendar days
        const days = [];
        let cur = new Date(startDate + 'T00:00:00');
        const end = new Date(endDate + 'T00:00:00');
        while (cur <= end) {
            const ds = cur.toISOString().slice(0,10);
            const dow = cur.getDay();
            const isWeekend = (dow === 0 || dow === 6);
            const present = presMap[ds] || 0;
            const absent = isWeekend ? 0 : await countStudentsWithoutTimeIn(ds, schoolId);
            const totalStudents = Math.max(await countAttendanceEligibleStudents(ds, schoolId), present);
            days.push({ date: ds, present, absent, total: totalStudents, isWeekend });
            cur.setDate(cur.getDate() + 1);
        }

        const totalStudents = days.reduce((max, day) => Math.max(max, day.total || 0), 0);
        return res.json({ year, month, totalStudents, days });
    } catch (err) {
        console.error('Monthly attendance error:', err);
        return res.status(500).json({ error: 'Failed to load monthly attendance.' });
    }
});

module.exports = router;
