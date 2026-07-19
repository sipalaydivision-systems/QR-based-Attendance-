const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const router = express.Router();
const db = require('../config/database');
const { requireAuth, requireRole, applySchoolFilter } = require('../middleware/auth');
const { getScannerKioskToken, getScannerKioskTokenFromRequest, isValidScannerKioskToken } = require('../utils/scannerKiosk');
const { getSystemTrafficMetrics } = require('../utils/systemTrafficMetrics');
const schoolYears = require('../utils/schoolYear');
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
const {
    ATTENDANCE_SCAN_LABELS,
    computeDailyAttendanceStatus,
    computeDailyAttendanceStatusFromEvents,
    decorateLateHalfDays,
    firstScanDecision,
    isLateHalfDay,
    normalizeEventLabel,
    returnScanLabel,
    statusLabel,
    timeOutScanLabel
} = require('../utils/attendanceStatus');
const {
    fanOutAnnouncement,
    normalizeAnnouncementType,
    notifyParentsForStudentScan
} = require('../utils/parentNotifications');
const { sendPushToUsers } = require('../utils/firebasePush');

function schoolLogoUrl(schoolId, logo) {
    if (!logo) return '';
    const version = crypto.createHash('md5').update(String(logo)).digest('hex').slice(0, 12);
    return `/api/schools/${schoolId}/logo-image?v=${version}`;
}

function systemLogoUrl(logo) {
    if (!logo) return '';
    const version = crypto.createHash('md5').update(String(logo)).digest('hex').slice(0, 12);
    return `/brand/system-logo-image?v=${version}`;
}

function localPublicAssetPath(value) {
    const rawPath = String(value || '').split(/[?#]/, 1)[0];
    if (!rawPath.startsWith('/')) return null;
    let decodedPath;
    try { decodedPath = decodeURIComponent(rawPath); } catch (_) { return null; }
    const publicRoot = path.resolve(__dirname, '..', 'public');
    const candidate = path.resolve(publicRoot, `.${decodedPath}`);
    if (!candidate.startsWith(`${publicRoot}${path.sep}`)) return null;
    try { return fs.statSync(candidate).isFile() ? candidate : null; } catch (_) { return null; }
}

const SCANNER_DESKTOP_CONFIG_CACHE_MS = 5000;
let scannerDesktopConfigCache = { loadedAt: 0, value: null };

async function loadScannerDesktopConfigCore(force = false) {
    if (!force && scannerDesktopConfigCache.value
        && Date.now() - scannerDesktopConfigCache.loadedAt < SCANNER_DESKTOP_CONFIG_CACHE_MS) {
        return scannerDesktopConfigCache.value;
    }

    const [settingsResult, schoolsResult] = await Promise.all([
        db.query(
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
        ),
        db.query("SELECT id, name, logo FROM schools WHERE status = 'active' ORDER BY name")
    ]);

    const rawSettings = {};
    settingsResult[0].forEach(row => { rawSettings[row.setting_key] = row.setting_value; });
    const rawSchools = schoolsResult[0];
    const versionPayload = {
        settings: Object.keys(rawSettings).sort().map(key => [key, rawSettings[key]]),
        schools: rawSchools.map(school => [school.id, school.name, school.logo || ''])
    };
    const configVersion = crypto.createHash('sha256')
        .update(JSON.stringify(versionPayload))
        .digest('hex')
        .slice(0, 20);
    const value = {
        configVersion,
        settings: {
            ...rawSettings,
            system_logo: systemLogoUrl(rawSettings.system_logo)
        },
        schools: rawSchools.map(school => ({
            id: school.id,
            name: school.name,
            logo: schoolLogoUrl(school.id, school.logo)
        }))
    };
    scannerDesktopConfigCache = { loadedAt: Date.now(), value };
    return value;
}

// School logos are public branding assets. Serve them separately so frequently
// refreshed dashboard JSON never retransmits large base64 image strings.
router.get('/schools/:id/logo-image', async (req, res) => {
    try {
        const [[school]] = await db.query('SELECT logo FROM schools WHERE id = ? LIMIT 1', [req.params.id]);
        const logo = String(school?.logo || '').trim();
        if (!logo) return res.status(404).end();
        const dataUrl = logo.match(/^data:(image\/(?:png|jpe?g|gif|webp));base64,(.+)$/i);
        if (dataUrl) {
            const bytes = Buffer.from(dataUrl[2], 'base64');
            res.set('Content-Type', dataUrl[1].toLowerCase());
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
            res.set('ETag', `"${crypto.createHash('md5').update(bytes).digest('hex')}"`);
            return res.send(bytes);
        }
        const localAsset = localPublicAssetPath(logo);
        if (localAsset) {
            return res.sendFile(localAsset, { maxAge: 31536000000, immutable: true });
        }
        if (logo.startsWith('/')) {
            res.set('Cache-Control', 'public, max-age=3600');
            return res.redirect(302, logo);
        }
        if (/^https?:\/\//i.test(logo)) {
            res.set('Cache-Control', 'public, max-age=3600');
            return res.redirect(302, logo);
        }
        return res.status(404).end();
    } catch (err) {
        console.error('School logo image error:', err);
        return res.status(500).end();
    }
});

function requireAuthOrScannerKiosk(req, res, next) {
    if (req.session && req.session.user) return requireAuth(req, res, next);
    if (isValidScannerKioskToken(getScannerKioskTokenFromRequest(req))) return next();
    return res.status(401).json({ error: 'Not authenticated' });
}

function getPublicBaseUrl(req) {
    const configured = process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    const normalized = String(configured || '').replace(/\/+$/, '');
    if (normalized && !/localhost|127\.0\.0\.1/i.test(normalized)) return normalized;
    return `${req.protocol}://${req.get('host') || ''}`.replace(/\/+$/, '');
}

router.use((req, res, next) => {
    if (req.session && req.session.user && req.session.user.role === 'parent') {
        return res.status(403).json({ error: 'Parent accounts can only use the parent mobile app APIs.' });
    }
    return next();
});

function normalizeOptionalSchoolId(value) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeContact(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('63') && digits.length === 12) digits = `0${digits.slice(2)}`;
    if (digits.length === 10 && digits.startsWith('9')) digits = `0${digits}`;
    return digits;
}

function titleCasePlatform(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^android$/i.test(raw)) return 'Android';
    if (/^ios$/i.test(raw)) return 'iOS';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function parentDeviceLabel(row) {
    const name = String(row.latest_device_name || '').trim();
    const platform = titleCasePlatform(row.latest_device_platform || row.platform || '');
    const version = String(row.latest_device_app_version || row.app_version || '').trim();
    const agent = String(row.latest_device_user_agent || row.user_agent || '').trim();
    if (name) return version && !name.includes(version) ? `${name} · v${version}` : name;
    if (platform) return `${platform} Guardian App${version ? ` · v${version}` : ''}`;
    if (/Android/i.test(agent)) return `Android Guardian App${version ? ` · v${version}` : ''}`;
    return version ? `Guardian App · v${version}` : 'Registered Guardian device';
}

function attachParentDeviceLabels(rows) {
    return (rows || []).map(row => ({
        ...row,
        device_count: Number(row.device_count || 0),
        latest_device_label: parentDeviceLabel(row)
    }));
}

// Coordinates are optional on a school — blank/invalid always coerces to
// NULL rather than blocking the rest of the record from saving.
function normalizeCoordinate(value, min, max) {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return n;
}

const DESKTOP_SCANNER_ACTIVE_SECONDS = 2 * 60;
const DESKTOP_SCANNER_RECENT_SECONDS = 2 * 60;
const DESKTOP_SCANNER_REMOTE_COMMANDS = new Set(['open_settings', 'refresh_config', 'sync_queue', 'start_preview', 'stop_preview', 'remote_click', 'remote_key', 'remote_text']);
const DESKTOP_SCANNER_PREVIEW_MAX_CHARS = 900000;
const DESKTOP_SCANNER_REMOTE_TEXT_MAX_CHARS = 1000;
const DESKTOP_SCANNER_CALENDAR_REFRESH_WINDOW_MINUTES = 10;

function limitText(value, maxLength) {
    return String(value || '').trim().slice(0, maxLength);
}

function normalizeScannerRemoteCommand(value) {
    const command = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_:-]/g, '');
    return DESKTOP_SCANNER_REMOTE_COMMANDS.has(command) ? command : '';
}

async function queueCalendarRefreshForDesktopScanners({ schoolId = null, requestedBy = null, reason = 'calendar-update' } = {}) {
    const scopedSchoolId = normalizeOptionalSchoolId(schoolId);
    const user = requestedBy || {};
    const payload = JSON.stringify({
        source: 'school_calendar',
        reason: limitText(reason, 200),
        school_id: scopedSchoolId,
        queued_at: nowDateTime()
    });

    const [result] = await db.query(
        `INSERT INTO desktop_scanner_commands
            (scanner_id, school_id, command, payload_json, status, requested_by, requested_by_name, expires_at)
         SELECT d.scanner_id, d.school_id, 'refresh_config', ?, 'pending', ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)
         FROM desktop_scanner_devices d
         WHERE d.scanner_id IS NOT NULL
           AND d.scanner_id <> ''
           AND d.last_seen_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${DESKTOP_SCANNER_CALENDAR_REFRESH_WINDOW_MINUTES} MINUTE)
           AND (? IS NULL OR d.school_id = ?)
           AND NOT EXISTS (
                SELECT 1
                FROM desktop_scanner_commands c
                WHERE c.scanner_id = d.scanner_id
                  AND c.command = 'refresh_config'
                  AND c.status = 'pending'
                  AND c.expires_at > CURRENT_TIMESTAMP
           )`,
        [
            payload,
            user.id || null,
            user.fullname || user.username || 'EduTrack System',
            scopedSchoolId,
            scopedSchoolId
        ]
    );

    return result.affectedRows || 0;
}

async function queueCalendarRefreshSafely(options) {
    try {
        return await queueCalendarRefreshForDesktopScanners(options);
    } catch (err) {
        console.error('Desktop scanner calendar refresh queue error:', err);
        return 0;
    }
}

function normalizeRemoteClickPayload(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const clamp = (value, max) => Math.max(0, Math.min(max, Number.parseFloat(value) || 0));
    return {
        x: clamp(p.x, 3000),
        y: clamp(p.y, 3000),
        width: Math.max(1, Math.min(3000, Number.parseFloat(p.width) || 1)),
        height: Math.max(1, Math.min(3000, Number.parseFloat(p.height) || 1))
    };
}

function normalizeRemoteKeyPayload(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    return {
        key: limitText(p.key, 40),
        code: limitText(p.code, 40),
        text: String(p.text || '').slice(0, 4),
        altKey: p.altKey === true || p.altKey === 'true' || p.altKey === '1',
        ctrlKey: p.ctrlKey === true || p.ctrlKey === 'true' || p.ctrlKey === '1',
        metaKey: p.metaKey === true || p.metaKey === 'true' || p.metaKey === '1',
        shiftKey: p.shiftKey === true || p.shiftKey === 'true' || p.shiftKey === '1',
        repeat: p.repeat === true || p.repeat === 'true' || p.repeat === '1'
    };
}

function normalizeRemoteTextPayload(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    return {
        text: String(p.text || '').slice(0, DESKTOP_SCANNER_REMOTE_TEXT_MAX_CHARS)
    };
}

function parsePayloadJson(value) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch (_err) {
        return null;
    }
}

function normalizePreviewImageData(value) {
    const raw = String(value || '').trim();
    const stripped = raw.replace(/^data:image\/jpe?g;base64,/i, '');
    if (!stripped || stripped.length > DESKTOP_SCANNER_PREVIEW_MAX_CHARS) return '';
    return /^[A-Za-z0-9+/=\r\n]+$/.test(stripped) ? stripped.replace(/\s+/g, '') : '';
}

function normalizeScannerDateTime(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    return `${match[1]}-${match[2]}-${match[3]} ${match[4].padStart(2, '0')}:${match[5]}:${match[6] || '00'}`;
}

function scannerPresenceState(ageSeconds) {
    const age = Math.max(0, Number(ageSeconds || 0));
    if (age <= DESKTOP_SCANNER_ACTIVE_SECONDS) return 'active';
    if (age <= DESKTOP_SCANNER_RECENT_SECONDS) return 'idle';
    return 'offline';
}

async function getDesktopScannerPresence(schoolId) {
    const now = nowDateTime();
    const params = [now];
    let where = '';
    if (schoolId) {
        where = 'WHERE d.school_id = ?';
        params.push(schoolId);
    }

    const [rows] = await db.query(`
        SELECT
            d.*,
            sc.name AS school_name,
            TIMESTAMPDIFF(SECOND, d.last_seen_at, ?) AS age_seconds
        FROM desktop_scanner_devices d
        LEFT JOIN schools sc ON d.school_id = sc.id
        ${where}
        ORDER BY d.school_id IS NULL, sc.name, d.last_seen_at DESC
    `, params);

    const devices = rows.map(row => {
        const ageSeconds = Math.max(0, Number(row.age_seconds || 0));
        const presence = scannerPresenceState(ageSeconds);
        return {
            scanner_id: row.scanner_id,
            school_id: row.school_id,
            school_name: row.school_name || null,
            device_name: row.device_name || 'Desktop Scanner',
            platform: row.platform || '',
            app_version: row.app_version || '',
            scanner_mode: row.scanner_mode || '',
            queued_count: Number(row.queued_count || 0),
            queued_today_count: Number(row.queued_today_count || 0),
            sync_in_progress: !!row.sync_in_progress,
            last_successful_sync_at: row.last_successful_sync_at || null,
            directory_last_refreshed_at: row.directory_last_refreshed_at || null,
            last_seen_at: row.last_seen_at,
            age_seconds: ageSeconds,
            presence,
            is_active: presence === 'active'
        };
    });

    const bySchool = new Map();
    devices.forEach(device => {
        if (!device.school_id) return;
        const key = String(device.school_id);
        if (!bySchool.has(key)) {
            bySchool.set(key, {
                total_scanners: 0,
                active_scanners: 0,
                idle_scanners: 0,
                offline_scanners: 0,
                queued_count: 0,
                sync_in_progress: false,
                latest: null
            });
        }
        const entry = bySchool.get(key);
        entry.total_scanners += 1;
        entry.queued_count += device.queued_count;
        entry.sync_in_progress = entry.sync_in_progress || device.sync_in_progress;
        if (device.presence === 'active') entry.active_scanners += 1;
        else if (device.presence === 'idle') entry.idle_scanners += 1;
        else entry.offline_scanners += 1;
        if (!entry.latest || device.age_seconds < entry.latest.age_seconds) entry.latest = device;
    });

    const summary = {
        total_scanners: devices.length,
        active_scanners: devices.filter(d => d.presence === 'active').length,
        idle_scanners: devices.filter(d => d.presence === 'idle').length,
        offline_scanners: devices.filter(d => d.presence === 'offline').length,
        schools_with_active_scanner: [...bySchool.values()].filter(s => s.active_scanners > 0).length,
        unassigned_scanners: devices.filter(d => !d.school_id).length,
        active_window_seconds: DESKTOP_SCANNER_ACTIVE_SECONDS
    };

    return { devices, bySchool, summary };
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

    // Offline enrollment gate: keep learners who are NOT enrolled in the active
    // school year (transferred out, or not re-enrolled after a rollover) OUT of
    // the offline directory, so the offline scanner won't accept them — matching
    // the online rule. Fail-open: learners with no enrollment records at all, or
    // when no active year is configured, are still included.
    const [[activeYr]] = await db
        .query("SELECT id FROM school_years WHERE status = 'active' ORDER BY id DESC LIMIT 1")
        .catch(() => [[null]]);
    const activeYearId = activeYr ? activeYr.id : null;
    const enrollmentGate = activeYearId
        ? ` AND (NOT EXISTS (SELECT 1 FROM student_enrollments e WHERE e.student_id = s.id)
                 OR EXISTS (SELECT 1 FROM student_enrollments e WHERE e.student_id = s.id
                            AND e.school_year_id = ? AND e.status = 'enrolled'))`
        : '';
    if (activeYearId) studentParams.push(activeYearId);

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
        WHERE ((s.qr_code IS NOT NULL AND s.qr_code <> '')
              OR (s.lrn IS NOT NULL AND s.lrn <> ''))
          AND s.status <> 'deleted'${enrollmentGate}`;

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
        WHERE ((t.qr_code IS NOT NULL AND t.qr_code <> '')
              OR (t.employee_id IS NOT NULL AND t.employee_id <> ''))
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
        qrCode: row.qr_code || (row.person_code ? `${row.person_type === 'teacher' ? 'TCH' : 'STU'}-${row.person_code}` : ''),
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
        WHERE ((s.qr_code IS NOT NULL AND s.qr_code <> '')
              OR (s.lrn IS NOT NULL AND s.lrn <> ''))
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
        WHERE ((t.qr_code IS NOT NULL AND t.qr_code <> '')
              OR (t.employee_id IS NOT NULL AND t.employee_id <> ''))
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
        const requestedVersion = limitText(req.query.config_version, 100);
        const force = req.query.force === '1' || req.query.force === 'true';
        const [core, summary] = await Promise.all([
            loadScannerDesktopConfigCore(force),
            getScannerDesktopSummary(schoolId)
        ]);
        const common = {
            success: true,
            baseUrl: getPublicBaseUrl(req),
            kioskToken: getScannerKioskToken(),
            serverTime: nowDateTime(),
            today: todayDate(),
            config_version: core.configVersion,
            summary
        };
        if (requestedVersion && requestedVersion === core.configVersion) {
            return res.json({ ...common, not_modified: true });
        }
        return res.json({ ...common, not_modified: false, settings: core.settings, schools: core.schools });
    } catch (err) {
        console.error('Scanner desktop config error:', err);
        return res.status(500).json({ success: false, error: 'Failed to load scanner desktop configuration.' });
    }
});

router.post('/scanner-desktop-heartbeat', requireAuthOrScannerKiosk, async (req, res) => {
    try {
        const scannerId = limitText(req.body.scanner_id || req.body.device_id, 100);
        if (!scannerId) {
            return res.status(400).json({ success: false, error: 'Scanner ID is required.' });
        }

        const schoolId = normalizeOptionalSchoolId(req.body.school_id || req.body.scanner_school_id);
        const appVersion = limitText(req.body.app_version, 50);
        const deviceName = limitText(req.body.device_name, 150);
        const platform = limitText(req.body.platform, 30);
        const scannerMode = limitText(req.body.scanner_mode, 30);
        const queuedCount = Math.max(0, Number.parseInt(req.body.queued_count, 10) || 0);
        const queuedTodayCount = Math.max(0, Number.parseInt(req.body.queued_today_count, 10) || 0);
        const syncInProgress = req.body.sync_in_progress === true || req.body.sync_in_progress === 'true' || req.body.sync_in_progress === '1';
        const online = !(req.body.online === false || req.body.online === 'false' || req.body.online === '0');
        const status = online ? 'online' : 'offline';
        const lastSuccessfulSyncAt = normalizeScannerDateTime(req.body.last_successful_sync_at);
        const directoryLastRefreshedAt = normalizeScannerDateTime(req.body.directory_last_refreshed_at);
        const seenAt = nowDateTime();

        await db.query(`
            INSERT INTO desktop_scanner_devices (
                scanner_id, school_id, device_name, platform, app_version,
                scanner_mode, status, online, queued_count, queued_today_count,
                sync_in_progress, last_successful_sync_at, directory_last_refreshed_at,
                last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                school_id = VALUES(school_id),
                device_name = VALUES(device_name),
                platform = VALUES(platform),
                app_version = VALUES(app_version),
                scanner_mode = VALUES(scanner_mode),
                status = VALUES(status),
                online = VALUES(online),
                queued_count = VALUES(queued_count),
                queued_today_count = VALUES(queued_today_count),
                sync_in_progress = VALUES(sync_in_progress),
                last_successful_sync_at = COALESCE(VALUES(last_successful_sync_at), last_successful_sync_at),
                directory_last_refreshed_at = COALESCE(VALUES(directory_last_refreshed_at), directory_last_refreshed_at),
                last_seen_at = VALUES(last_seen_at),
                updated_at = CURRENT_TIMESTAMP
        `, [
            scannerId,
            schoolId,
            deviceName || 'Desktop Scanner',
            platform,
            appVersion,
            scannerMode,
            status,
            online ? 1 : 0,
            queuedCount,
            queuedTodayCount,
            syncInProgress ? 1 : 0,
            lastSuccessfulSyncAt,
            directoryLastRefreshedAt,
            seenAt
        ]);

        return res.json({
            success: true,
            scanner_id: scannerId,
            school_id: schoolId,
            last_seen_at: seenAt,
            active_window_seconds: DESKTOP_SCANNER_ACTIVE_SECONDS
        });
    } catch (err) {
        console.error('Scanner desktop heartbeat error:', err);
        return res.status(500).json({ success: false, error: 'Failed to record desktop scanner heartbeat.' });
    }
});

router.post('/scanner-desktop-command', requireRole('super_admin'), async (req, res) => {
    try {
        const command = normalizeScannerRemoteCommand(req.body.command);
        if (!command) {
            return res.status(400).json({ success: false, error: 'Invalid scanner command.' });
        }

        const requestedSchoolId = normalizeOptionalSchoolId(req.body.school_id);
        let scannerId = limitText(req.body.scanner_id || req.body.device_id, 100);
        let device = null;

        if (scannerId) {
            const [rows] = await db.query(
                'SELECT scanner_id, school_id, device_name, last_seen_at FROM desktop_scanner_devices WHERE scanner_id = ? LIMIT 1',
                [scannerId]
            );
            device = rows[0] || null;
        } else if (requestedSchoolId) {
            const [rows] = await db.query(
                `SELECT scanner_id, school_id, device_name, last_seen_at
                 FROM desktop_scanner_devices
                 WHERE school_id = ?
                 ORDER BY last_seen_at DESC
                 LIMIT 1`,
                [requestedSchoolId]
            );
            device = rows[0] || null;
            scannerId = device ? device.scanner_id : '';
        }

        if (!scannerId || !device) {
            return res.status(404).json({ success: false, error: 'No desktop scanner device found for this command.' });
        }

        let payload = req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
        if (command === 'remote_click') {
            payload = normalizeRemoteClickPayload(req.body.payload);
        } else if (command === 'remote_key') {
            payload = normalizeRemoteKeyPayload(req.body.payload);
            if (!payload.key && !payload.text) {
                return res.status(400).json({ success: false, error: 'Remote key payload is empty.' });
            }
        } else if (command === 'remote_text') {
            payload = normalizeRemoteTextPayload(req.body.payload);
            if (!payload.text) {
                return res.status(400).json({ success: false, error: 'Remote text payload is empty.' });
            }
        }
        const user = req.session?.user || {};
        const [result] = await db.query(
            `INSERT INTO desktop_scanner_commands
             (scanner_id, school_id, command, payload_json, status, requested_by, requested_by_name, expires_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 2 MINUTE))`,
            [
                scannerId,
                device.school_id || requestedSchoolId || null,
                command,
                JSON.stringify(payload),
                user.id || null,
                user.fullname || user.username || 'Super Admin'
            ]
        );

        return res.json({
            success: true,
            command_id: result.insertId,
            scanner_id: scannerId,
            school_id: device.school_id || requestedSchoolId || null,
            command,
            expires_in_seconds: 120
        });
    } catch (err) {
        console.error('Scanner desktop command error:', err);
        return res.status(500).json({ success: false, error: 'Failed to send scanner command.' });
    }
});

async function pullPendingDesktopScannerCommand(scannerId) {
    const [rows] = await db.query(
        `SELECT id, scanner_id, school_id, command, payload_json, requested_by_name, requested_at, expires_at
         FROM desktop_scanner_commands
         WHERE scanner_id = ?
           AND status = 'pending'
           AND expires_at > NOW()
         ORDER BY requested_at ASC, id ASC
         LIMIT 1`,
        [scannerId]
    );

    const command = rows[0] || null;
    if (!command) return null;

    await db.query(
        `UPDATE desktop_scanner_commands
         SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`,
        [command.id]
    );

    return {
        id: command.id,
        scanner_id: command.scanner_id,
        school_id: command.school_id,
        command: command.command,
        payload: parsePayloadJson(command.payload_json) || {},
        requested_by_name: command.requested_by_name || 'Super Admin',
        requested_at: command.requested_at,
        expires_at: command.expires_at
    };
}

router.get('/scanner-desktop-command', requireAuthOrScannerKiosk, async (req, res) => {
    try {
        const scannerId = limitText(req.query.scanner_id || req.query.device_id, 100);
        if (!scannerId) {
            return res.status(400).json({ success: false, error: 'Scanner ID is required.' });
        }

        const waitSeconds = Math.max(0, Math.min(20, Number.parseInt(req.query.wait, 10) || 0));
        const deadline = Date.now() + (waitSeconds * 1000);
        let command = await pullPendingDesktopScannerCommand(scannerId);
        while (!command && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
            command = await pullPendingDesktopScannerCommand(scannerId);
        }
        if (!command) return res.json({ success: true, command: null });

        return res.json({ success: true, command });
    } catch (err) {
        console.error('Scanner desktop command poll error:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch scanner command.' });
    }
});

router.post('/scanner-desktop-command/:id/ack', requireAuthOrScannerKiosk, async (req, res) => {
    try {
        const commandId = parseInt(req.params.id, 10);
        const scannerId = limitText(req.body.scanner_id || req.body.device_id, 100);
        const status = String(req.body.status || '').toLowerCase() === 'failed' ? 'failed' : 'acknowledged';
        const errorMessage = limitText(req.body.error || req.body.error_message, 500);
        if (!commandId || !scannerId) {
            return res.status(400).json({ success: false, error: 'Command ID and scanner ID are required.' });
        }

        const [result] = await db.query(
            `UPDATE desktop_scanner_commands
             SET status = ?, acknowledged_at = CURRENT_TIMESTAMP, error_message = ?
             WHERE id = ? AND scanner_id = ?`,
            [status, errorMessage || null, commandId, scannerId]
        );

        return res.json({ success: true, updated: result.affectedRows > 0 });
    } catch (err) {
        console.error('Scanner desktop command ack error:', err);
        return res.status(500).json({ success: false, error: 'Failed to acknowledge scanner command.' });
    }
});

router.post('/scanner-desktop-preview', requireAuthOrScannerKiosk, async (req, res) => {
    try {
        const scannerId = limitText(req.body.scanner_id || req.body.device_id, 100);
        const schoolId = normalizeOptionalSchoolId(req.body.school_id || req.body.scanner_school_id);
        const imageData = normalizePreviewImageData(req.body.image_data);
        const width = Math.max(0, Math.min(3000, Number.parseInt(req.body.width, 10) || 0));
        const height = Math.max(0, Math.min(3000, Number.parseInt(req.body.height, 10) || 0));

        if (!scannerId) {
            return res.status(400).json({ success: false, error: 'Scanner ID is required.' });
        }
        if (!imageData) {
            return res.status(400).json({ success: false, error: 'Invalid preview image.' });
        }

        await db.query(
            `INSERT INTO desktop_scanner_previews
             (scanner_id, school_id, image_data, mime_type, width, height, captured_at)
             VALUES (?, ?, ?, 'image/jpeg', ?, ?, CURRENT_TIMESTAMP)
             ON DUPLICATE KEY UPDATE
                school_id = VALUES(school_id),
                image_data = VALUES(image_data),
                mime_type = VALUES(mime_type),
                width = VALUES(width),
                height = VALUES(height),
                captured_at = VALUES(captured_at),
                updated_at = CURRENT_TIMESTAMP`,
            [scannerId, schoolId, imageData, width, height]
        );

        const command = await pullPendingDesktopScannerCommand(scannerId);
        return res.json({ success: true, scanner_id: scannerId, command });
    } catch (err) {
        console.error('Scanner preview upload error:', err);
        return res.status(500).json({ success: false, error: 'Failed to upload scanner preview.' });
    }
});

router.get('/scanner-desktop-preview', requireRole('super_admin'), async (req, res) => {
    try {
        const scannerId = limitText(req.query.scanner_id || req.query.device_id, 100);
        if (!scannerId) {
            return res.status(400).json({ success: false, error: 'Scanner ID is required.' });
        }

        const [rows] = await db.query(
            `SELECT p.scanner_id, p.school_id, p.image_data, p.mime_type, p.width, p.height, p.captured_at,
                    TIMESTAMPDIFF(SECOND, p.captured_at, CURRENT_TIMESTAMP) AS age_seconds,
                    d.device_name, sc.name AS school_name
             FROM desktop_scanner_previews p
             LEFT JOIN desktop_scanner_devices d ON d.scanner_id = p.scanner_id
             LEFT JOIN schools sc ON sc.id = COALESCE(p.school_id, d.school_id)
             WHERE p.scanner_id = ?
             LIMIT 1`,
            [scannerId]
        );

        const frame = rows[0] || null;
        if (!frame) return res.json({ success: true, frame: null });

        return res.json({
            success: true,
            frame: {
                scanner_id: frame.scanner_id,
                school_id: frame.school_id,
                school_name: frame.school_name || '',
                device_name: frame.device_name || 'Desktop Scanner',
                image_data: `data:${frame.mime_type || 'image/jpeg'};base64,${frame.image_data}`,
                width: frame.width || 0,
                height: frame.height || 0,
                captured_at: frame.captured_at,
                age_seconds: Math.max(0, Number(frame.age_seconds || 0))
            }
        });
    } catch (err) {
        console.error('Scanner preview fetch error:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch scanner preview.' });
    }
});

router.get('/scanner-desktop-status', requireRole('super_admin'), async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');

        const schoolId = normalizeOptionalSchoolId(req.query.school_id);
        const schoolParams = schoolId ? [schoolId] : [];
        const scannerPresence = await getDesktopScannerPresence(schoolId);

        const [schoolRows] = await db.query(
            `SELECT id, name, logo
             FROM schools
             WHERE status = 'active'` + (schoolId ? ' AND id = ?' : '') + `
             ORDER BY name`,
            schoolParams
        );

        const schools = schoolRows.map(s => {
            const scannerInfo = scannerPresence.bySchool.get(String(s.id)) || null;
            const latestScanner = scannerInfo?.latest || null;
            const scannerStatus = scannerInfo && scannerInfo.active_scanners > 0
                ? 'active'
                : scannerInfo && scannerInfo.idle_scanners > 0
                    ? 'idle'
                    : scannerInfo && scannerInfo.total_scanners > 0
                        ? 'offline'
                        : 'none';

            return {
                id: s.id,
                name: s.name,
                logo: s.logo,
                scanner_total: scannerInfo ? scannerInfo.total_scanners : 0,
                scanner_active: scannerInfo ? scannerInfo.active_scanners : 0,
                scanner_idle: scannerInfo ? scannerInfo.idle_scanners : 0,
                scanner_offline: scannerInfo ? scannerInfo.offline_scanners : 0,
                scanner_status: scannerStatus,
                scanner_last_seen_at: latestScanner ? latestScanner.last_seen_at : null,
                scanner_last_seen_seconds: latestScanner ? latestScanner.age_seconds : null,
                scanner_id: latestScanner ? latestScanner.scanner_id : '',
                scanner_app_version: latestScanner ? latestScanner.app_version : '',
                scanner_device_name: latestScanner ? latestScanner.device_name : '',
                scanner_queued_count: scannerInfo ? scannerInfo.queued_count : 0,
                scanner_sync_in_progress: scannerInfo ? scannerInfo.sync_in_progress : false
            };
        });

        return res.json({
            success: true,
            scanner_status_summary: scannerPresence.summary,
            desktop_scanners: scannerPresence.devices,
            schools
        });
    } catch (err) {
        console.error('Desktop scanner status error:', err);
        return res.status(500).json({ success: false, error: 'Failed to load desktop scanner status.' });
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

function holidayDisplayDate(dateStr) {
    const value = new Date(`${dateStr}T00:00:00+08:00`);
    if (Number.isNaN(value.getTime())) return dateStr;
    return new Intl.DateTimeFormat('en-PH', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'Asia/Manila'
    }).format(value);
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
        .replace(/[\u200B-\u200D\u2060]/g, '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/[‐‑‒–—−﹣－]/g, '-')
        .replace(/\s*-\s*/g, '-')
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim();
}

function looksLikeQrLookupValue(value) {
    const cleaned = cleanScannedQrValue(value);
    return /^(STU|TCH)-/i.test(cleaned)
        || /^\d{5,20}$/.test(cleaned)
        || /^(?=.{5,}$)(?=.*\d)[A-Z0-9][A-Z0-9._-]*$/i.test(cleaned);
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

function collectQrCandidatesFromJson(candidates, value, depth = 0) {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string' || typeof value === 'number') {
        addQrCandidate(candidates, value);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(item => collectQrCandidatesFromJson(candidates, item, depth + 1));
        return;
    }
    if (typeof value !== 'object') return;
    Object.entries(value).forEach(([key, nestedValue]) => {
        const keyName = String(key || '').toLowerCase();
        if (/(qr|code|lrn|employee|emp|teacher|student|value|data|id)/i.test(keyName)) {
            collectQrCandidatesFromJson(candidates, nestedValue, depth + 1);
        } else if (typeof nestedValue === 'object' && nestedValue) {
            collectQrCandidatesFromJson(candidates, nestedValue, depth + 1);
        }
    });
}

function getQrLookupCandidates(value) {
    const candidates = new Set();
    addQrCandidate(candidates, value);

    const cleaned = cleanScannedQrValue(value);
    try {
        const parsed = new URL(cleaned);
        const qrParamKeys = ['qr_code', 'qr', 'code', 'q', 'lrn', 'student_lrn', 'student_code', 'employee_id', 'employee', 'emp_id', 'teacher_code', 'value', 'data'];
        qrParamKeys.forEach(key => addQrCandidate(candidates, parsed.searchParams.get(key)));
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        pathParts.forEach(part => {
            const decoded = cleanScannedQrValue(decodeURIComponent(part));
            if (looksLikeQrLookupValue(decoded)) addQrCandidate(candidates, decoded);
        });
        if (parsed.hash) {
            addQrCandidate(candidates, parsed.hash.replace(/^#/, ''));
            const hashQuery = parsed.hash.includes('?') ? parsed.hash.split('?').pop() : parsed.hash.replace(/^#/, '');
            const hashParams = new URLSearchParams(hashQuery);
            qrParamKeys.forEach(key => addQrCandidate(candidates, hashParams.get(key)));
        }
    } catch (_err) {
        // Plain QR payloads are expected; URLs are supported as a convenience.
    }

    try {
        collectQrCandidatesFromJson(candidates, JSON.parse(cleaned));
    } catch (_err) {
        // Not JSON; keep scanning the plain text below.
    }

    const embeddedPattern = /\b((?:STU|TCH)\s*[-:]\s*[A-Z0-9][A-Z0-9._-]{2,})\b/gi;
    let embeddedMatch;
    while ((embeddedMatch = embeddedPattern.exec(cleaned)) !== null) {
        addQrCandidate(candidates, embeddedMatch[1].replace(':', '-'));
    }

    const labeledNumberPattern = /\b(?:LRN|LEARNER\s+REFERENCE\s+NUMBER|EMPLOYEE\s+ID|EMPLOYEE|EMP|TEACHER|STUDENT)(?:\s*(?:NO|NUMBER|ID)\.?)?[\s#:.-]*(\d{5,20})\b/gi;
    let numberMatch;
    while ((numberMatch = labeledNumberPattern.exec(cleaned)) !== null) {
        addQrCandidate(candidates, numberMatch[1]);
    }

    const looseLabeledNumberPattern = /\b(?:LRN|LEARNER\s+REFERENCE\s+NUMBER|EMPLOYEE\s+ID|EMPLOYEE|EMP|TEACHER|STUDENT)(?:\s*(?:NO|NUMBER|ID)\.?)?[\s#:.-]{0,8}([0-9][0-9\s-]{3,28}[0-9])\b/gi;
    while ((numberMatch = looseLabeledNumberPattern.exec(cleaned)) !== null) {
        const compact = String(numberMatch[1] || '').replace(/\D/g, '');
        if (/^\d{5,20}$/.test(compact)) addQrCandidate(candidates, compact);
    }

    // Symmetric to the prefixing below: if a candidate is "STU-<code>" or
    // "TCH-<code>", also try the bare "<code>". ID cards encode "STU-<lrn>",
    // but a student's stored qr_code may be a different value (e.g. a random
    // "STU-<timestamp>-<rand>" assigned at import/enrollment when no LRN was
    // present) while their lrn column still holds the bare number. Trying the
    // bare code against lrn / employee_id recovers these otherwise-"not
    // recognized" scans.
    Array.from(candidates).forEach(candidate => {
        const stripped = candidate.replace(/^(STU|TCH)-/i, '');
        if (stripped && stripped !== candidate) {
            addQrCandidate(candidates, stripped);
        }
    });

    Array.from(candidates).forEach(candidate => {
        if (!/^(STU|TCH)-/i.test(candidate) && looksLikeQrLookupValue(candidate)) {
            addQrCandidate(candidates, 'STU-' + candidate);
            addQrCandidate(candidates, 'TCH-' + candidate);
        }
    });

    return Array.from(candidates).slice(0, 32);
}

async function getAttendanceLateThreshold(personType, dateStr) {
    const [rows] = await db.query(
        `SELECT setting_key, setting_value
         FROM settings
         WHERE setting_key IN ('am_time_in_end', 'am_late_time', 'late_threshold', 'teacher_duty_start_time', 'teacher_late_threshold')`
    );
    const settings = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
    const isTeacher = personType === 'teacher';
    // The official attendance logic uses one AM late line for students and
    // teachers. Falls back to role-specific grace only when no exact line exists.
    if (settings.am_late_time) {
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
    return sqlDateTime(dateStr, normalizeTimeSetting(settings.absence_cutoff_time || settings.pm_time_out_end, '16:00:00'));
}

// Daily attendance schedule boundaries used to label time-in/time-out transactions.
async function getAttendanceScheduleTimes(dateStr) {
    const [rows] = await db.query(
        `SELECT setting_key, setting_value
         FROM settings
         WHERE setting_key IN ('am_late_time', 'lunch_break_start', 'pm_time_in_start', 'pm_late_time', 'pm_time_out_end')`
    );
    const settings = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
    return {
        amLateStart: sqlDateTime(dateStr, normalizeTimeSetting(settings.am_late_time, '07:15:00')),
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
// Statuses that mean the person is currently OUTSIDE the school after a time-out scan.
const OUTSIDE_MONITORING_STATUSES = [
    'OUT',
    ATTENDANCE_SCAN_LABELS.EARLY_OUT,
    ATTENDANCE_SCAN_LABELS.LUNCH_OUT,
    ATTENDANCE_SCAN_LABELS.SUSPENSION_OUT,
    ATTENDANCE_SCAN_LABELS.COMPLETED
];

function isCurrentlyInside(attendanceRow) {
    const monitoring = String(attendanceRow.monitoring_status || '').toUpperCase();
    if (monitoring) return !OUTSIDE_MONITORING_STATUSES.includes(monitoring);
    // Legacy rows without monitoring_status: inside unless a time_out was recorded.
    return !attendanceRow.time_out;
}

function buildScanPersonInfo(person, personType, qrCode) {
    const personInfo = {
        id: person.id,
        qr_code: person.qr_code || qrCode,
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
    return personInfo;
}

async function handleNonSchoolDayScan({ res, qr_code, person, personType, today, now, schoolDay }) {
    const personInfo = buildScanPersonInfo(person, personType, qr_code);
    const [existing] = await db.query(
        'SELECT * FROM attendance WHERE person_type = ? AND person_id = ? AND date = ?',
        [personType, person.id, today]
    );
    const attendanceRow = existing[0] || null;
    const reasonText = nonSchoolDayScanMessage(schoolDay);

    if (attendanceRow && isCurrentlyInside(attendanceRow)) {
        const label = ATTENDANCE_SCAN_LABELS.SUSPENSION_OUT;
        await logAttendanceEvent(attendanceRow.id, personType, person.id, person.school_id, today, 'time_out', label, now);
        notifyParentsForStudentScan({ personType, personId: person.id, label, eventTime: now })
            .catch(err => console.error('Parent scan notification error:', err));
        await db.query(
            'UPDATE attendance SET time_out = ?, monitoring_status = ?, updated_at = ? WHERE id = ?',
            [now, label, now, attendanceRow.id]
        );
        return res.json({
            success: true,
            action: 'TIME_OUT',
            status: attendanceRow.status || 'present',
            display_status: label,
            attendance_status: 'Suspension Dismissal',
            remarks: reasonText,
            monitoring_status: label,
            suspension_dismissal: true,
            non_school_day: true,
            non_school_day_type: schoolDay.type,
            non_school_day_reason: schoolDay.reason,
            message: 'Class suspension time out recorded. This person is now marked out.',
            person: personInfo,
            time: formatTime12(now),
            time_in: attendanceRow.last_time_in || attendanceRow.time_in ? formatTime12(attendanceRow.last_time_in || attendanceRow.time_in) : null,
            time_out: formatTime12(now)
        });
    }

    return res.json({
        success: false,
        action: attendanceRow ? 'ALREADY_RECORDED' : 'NON_SCHOOL_DAY',
        status: attendanceRow ? attendanceRow.status : 'absent',
        display_status: attendanceRow ? (attendanceRow.monitoring_status || ATTENDANCE_SCAN_LABELS.SUSPENSION_OUT) : 'NON-SCHOOL DAY',
        attendance_status: attendanceRow ? 'Already Timed Out' : 'No Classes',
        error: attendanceRow
            ? 'Class suspension is active and this person is already timed out.'
            : reasonText,
        message: attendanceRow
            ? 'Class suspension is active and this person is already timed out.'
            : reasonText,
        person: personInfo,
        non_school_day: true,
        non_school_day_type: schoolDay.type,
        non_school_day_reason: schoolDay.reason,
        time: formatTime12(now),
        time_in: attendanceRow && (attendanceRow.last_time_in || attendanceRow.time_in) ? formatTime12(attendanceRow.last_time_in || attendanceRow.time_in) : null,
        time_out: attendanceRow && attendanceRow.time_out ? formatTime12(attendanceRow.time_out) : null
    });
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
        monitoringStatus: rowState.monitoring_status,
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

async function getAttendanceEvents(attendanceId) {
    const [events] = await db.query(
        `SELECT event, event_label, event_time
         FROM attendance_events
         WHERE attendance_id = ?
         ORDER BY event_time, id`,
        [attendanceId]
    );
    return events;
}

async function getAttendanceEventsByIds(attendanceIds) {
    const ids = [...new Set((attendanceIds || []).filter(Boolean))];
    const eventsByAttendance = new Map();
    if (ids.length === 0) return eventsByAttendance;
    const [eventRows] = await db.query(
        `SELECT attendance_id, event, event_label, event_time
         FROM attendance_events
         WHERE attendance_id IN (?)
         ORDER BY event_time, id`,
        [ids]
    );
    eventRows.forEach(event => {
        const key = event.attendance_id;
        if (!eventsByAttendance.has(key)) eventsByAttendance.set(key, []);
        eventsByAttendance.get(key).push(event);
    });
    return eventsByAttendance;
}

async function resolveAttendanceStatusFromEvents(personType, dateStr, attendanceId, firstTimeIn) {
    const [baseStatus, schedule, storedEvents] = await Promise.all([
        getBaseAttendanceStatus(personType, dateStr, firstTimeIn),
        getAttendanceScheduleTimes(dateStr),
        getAttendanceEvents(attendanceId)
    ]);
    const events = [...storedEvents];
    if (firstTimeIn && !events.some(event => String(event.event || '').toLowerCase() === 'time_in')) {
        events.unshift({
            event: 'time_in',
            event_label: ATTENDANCE_SCAN_LABELS.TIME_IN,
            event_time: firstTimeIn
        });
    }
    return computeDailyAttendanceStatusFromEvents({
        events,
        schedule,
        baseStatus
    });
}

// Same result as resolveAttendanceStatusFromEvents, but reuses data that a
// dashboard already loaded in bulk. This removes three repeated database reads
// per student without changing any attendance labels or status rules.
function resolveAttendanceStatusFromLoadedEvents({ firstTimeIn, lateThreshold, schedule, storedEvents }) {
    const baseStatus = firstTimeIn && compareDateTime(firstTimeIn, lateThreshold) >= 0
        ? 'late'
        : (firstTimeIn ? 'present' : 'absent');
    const events = [...(storedEvents || [])];
    if (firstTimeIn && !events.some(event => String(event.event || '').toLowerCase() === 'time_in')) {
        events.unshift({
            event: 'time_in',
            event_label: ATTENDANCE_SCAN_LABELS.TIME_IN,
            event_time: firstTimeIn
        });
    }
    return computeDailyAttendanceStatusFromEvents({ events, schedule, baseStatus });
}

function attendanceEventAction(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'time_in' || raw === 'time in') return 'time_in';
    if (raw === 'time_out' || raw === 'time out') return 'time_out';
    return raw;
}

function buildAttendanceScanSummary(row, dateStr, schedule, storedEvents) {
    const events = Array.isArray(storedEvents) ? [...storedEvents] : [];
    if (row.time_in && !events.some(event => attendanceEventAction(event.event) === 'time_in')) {
        const decision = firstScanDecision(row.time_in, schedule, row.status || 'present');
        events.unshift({
            event: 'time_in',
            event_label: decision.label || ATTENDANCE_SCAN_LABELS.TIME_IN,
            event_time: row.time_in
        });
    }
    if (row.time_out && !events.some(event => attendanceEventAction(event.event) === 'time_out' && String(event.event_time) === String(row.time_out))) {
        events.push({
            event: 'time_out',
            event_label: timeOutScanLabel(row.time_out, schedule),
            event_time: row.time_out
        });
    }

    const summary = {
        am_time_in: [],
        am_time_out: [],
        pm_time_in: [],
        pm_time_out: [],
        scan_statuses: []
    };

    events
        .filter(event => event && event.event_time)
        .sort((a, b) => compareDateTime(a.event_time, b.event_time))
        .forEach(event => {
            const action = attendanceEventAction(event.event);
            const label = normalizeEventLabel(event.event_label) || (action === 'time_out'
                ? timeOutScanLabel(event.event_time, schedule)
                : ATTENDANCE_SCAN_LABELS.TIME_IN);
            const entry = {
                time: event.event_time,
                time_display: formatTime12(event.event_time),
                label,
                status: label
            };
            let bucket = null;
            if (action === 'time_in') {
                bucket = compareDateTime(event.event_time, schedule.lunchStart) >= 0 ? 'pm_time_in' : 'am_time_in';
            } else if (action === 'time_out') {
                bucket = compareDateTime(event.event_time, schedule.pmInStart) >= 0 ? 'pm_time_out' : 'am_time_out';
            }
            if (bucket && summary[bucket]) summary[bucket].push(entry);
            summary.scan_statuses.push({ ...entry, action });
        });

    return summary;
}

async function hasSchoolDayEnded(dateStr) {
    const today = todayDate();
    if (dateStr < today) return true;
    if (dateStr > today) return false;
    return compareDateTime(nowDateTime(), await getSchoolDayEndDateTime(dateStr)) >= 0;
}

function dateOnly(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    const match = String(value).trim().match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : null;
}

async function activeSchoolYearBoundaryStatus(dateStr) {
    const activeYear = await schoolYears.getActiveSchoolYear().catch(() => null);
    if (!activeYear) return { inRange: true, reason: null, type: null };
    const start = dateOnly(activeYear.start_date);
    const end = dateOnly(activeYear.end_date);
    const label = activeYear.label ? ` ${activeYear.label}` : '';
    if (start && dateStr < start) {
        return { inRange: false, reason: `School year${label} has not started yet.`, type: 'School Year' };
    }
    if (end && dateStr > end) {
        return { inRange: false, reason: `School year${label} has ended.`, type: 'School Year' };
    }
    return { inRange: true, reason: null, type: null };
}

async function checkOperationalSchoolDay(dateStr, schoolId) {
    const schoolDay = await checkSchoolDay(dateStr, schoolId);
    if (!schoolDay.isSchoolDay) return schoolDay;
    const boundary = await activeSchoolYearBoundaryStatus(dateStr);
    if (!boundary.inRange) {
        return { isSchoolDay: false, reason: boundary.reason, type: boundary.type };
    }
    return schoolDay;
}

const absenceCountingDecisionCache = new Map();

function rememberAbsenceCountingDecision(key, value) {
    absenceCountingDecisionCache.set(key, { value, timestamp: Date.now() });
    while (absenceCountingDecisionCache.size > 500) {
        absenceCountingDecisionCache.delete(absenceCountingDecisionCache.keys().next().value);
    }
}

async function shouldCountComputedAbsences(dateStr, schoolId) {
    const cacheKey = `${dateStr}:${schoolId || 'all'}`;
    const cached = absenceCountingDecisionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 15000) return cached.value;
    const today = todayDate();
    if (dateStr > today) {
        rememberAbsenceCountingDecision(cacheKey, false);
        return false;
    }
    const schoolDay = await checkOperationalSchoolDay(dateStr, schoolId);
    const value = schoolDay.isSchoolDay ? await hasSchoolDayEnded(dateStr) : false;
    rememberAbsenceCountingDecision(cacheKey, value);
    return value;
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
    // Official dashboard totals keep full-day and half-day separate:
    // Present = full-day on-time, Late = full-day late, Half-Day = partial day.
    let query = `
        SELECT
            COUNT(DISTINCT CASE WHEN a.status = 'present' THEN a.person_id END) AS present,
            COUNT(DISTINCT CASE WHEN a.status = 'late' THEN a.person_id END) AS late,
            COUNT(DISTINCT CASE WHEN a.status = 'half_day' THEN a.person_id END) AS half_day,
            COUNT(DISTINCT CASE WHEN a.status IN ('present','late') THEN a.person_id END) AS full_day,
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

// Batch dashboard totals by school. The old dashboard executed the same six
// aggregate queries once per school, which could turn one SDS/ASDS refresh into
// hundreds of sequential MySQL calls and make the mobile app report a timeout.
async function getAttendanceStatusCountsBySchool(personType, dateStr, schoolId = null) {
    const isTeacher = personType === 'teacher';
    const table = isTeacher ? 'teachers' : 'students';
    const alias = isTeacher ? 't' : 's';
    let query = `
        SELECT ${alias}.school_id,
            COUNT(DISTINCT CASE WHEN a.status = 'present' THEN a.person_id END) AS present,
            COUNT(DISTINCT CASE WHEN a.status = 'late' THEN a.person_id END) AS late,
            COUNT(DISTINCT CASE WHEN a.status = 'half_day' THEN a.person_id END) AS half_day,
            COUNT(DISTINCT CASE WHEN a.status IN ('present','late') THEN a.person_id END) AS full_day,
            COUNT(DISTINCT CASE WHEN a.time_in IS NOT NULL THEN a.person_id END) AS timed_in,
            COUNT(DISTINCT CASE WHEN a.time_out IS NOT NULL THEN a.person_id END) AS timed_out
        FROM attendance a
        INNER JOIN ${table} ${alias}
            ON a.person_id = ${alias}.id
           AND a.person_type = ?
           AND ${alias}.status = 'active'
        WHERE a.date = ? AND a.time_in IS NOT NULL`;
    const params = [personType, dateStr];
    if (schoolId) {
        query += ` AND ${alias}.school_id = ?`;
        params.push(schoolId);
    }
    query += ` GROUP BY ${alias}.school_id`;
    const [rows] = await db.query(query, params);
    return new Map(rows.map(row => [String(row.school_id), {
        present: Number(row.present || 0),
        late: Number(row.late || 0),
        half_day: Number(row.half_day || 0),
        full_day: Number(row.full_day || 0),
        timed_in: Number(row.timed_in || 0),
        timed_out: Number(row.timed_out || 0)
    }]));
}

async function getEligibleCountsBySchool(personType, dateStr, schoolId = null) {
    const table = personType === 'teacher' ? 'teachers' : 'students';
    let query = `SELECT school_id, COUNT(*) AS count FROM ${table}
        WHERE status = 'active' AND COALESCE(active_from, DATE(created_at)) < ?`;
    const params = [dateStr];
    if (schoolId) {
        query += ' AND school_id = ?';
        params.push(schoolId);
    }
    query += ' GROUP BY school_id';
    const [rows] = await db.query(query, params);
    return new Map(rows.map(row => [String(row.school_id), Number(row.count || 0)]));
}

async function getAbsentCountsBySchool(personType, dateStr, schoolId = null) {
    const isTeacher = personType === 'teacher';
    const table = isTeacher ? 'teachers' : 'students';
    const alias = isTeacher ? 't' : 's';
    let query = `SELECT ${alias}.school_id, COUNT(*) AS count
        FROM ${table} ${alias}
        WHERE ${alias}.status = 'active'
          AND COALESCE(${alias}.active_from, DATE(${alias}.created_at)) < ?
          AND NOT EXISTS (
              SELECT 1 FROM attendance a
              WHERE a.person_type = ?
                AND a.person_id = ${alias}.id
                AND a.date = ?
                AND a.time_in IS NOT NULL
          )`;
    const params = [dateStr, personType, dateStr];
    if (schoolId) {
        query += ` AND ${alias}.school_id = ?`;
        params.push(schoolId);
    }
    query += ` GROUP BY ${alias}.school_id`;
    const [rows] = await db.query(query, params);
    return new Map(rows.map(row => [String(row.school_id), Number(row.count || 0)]));
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

async function validateTeacherGradeCategory({ schoolId, gradeLevelId, category }) {
    if (!gradeLevelId) return null;
    const [[grade]] = await db.query('SELECT id, name, school_id FROM grade_levels WHERE id = ? LIMIT 1', [gradeLevelId]);
    if (!grade) return 'Selected grade level was not found.';
    if (grade.school_id && Number(grade.school_id) !== Number(schoolId)) {
        return 'Selected grade level does not belong to the selected school.';
    }
    const match = String(grade.name || '').match(/\d+/);
    const number = match ? parseInt(match[0], 10) : NaN;
    const isShs = category === 'shs_teacher';
    if (isShs && !(number >= 11 && number <= 12)) return 'SHS teachers can only be assigned to Grades 11-12.';
    if (!isShs && !(number >= 1 && number <= 10)) return 'Regular teachers can only be assigned to Grades 1-10.';
    return null;
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

async function computeConsecutiveAbsenceFlags({ baseDate, schoolId, sectionId = null, days = 2, includeTeachers = true, maxScanDays = 45 }) {
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
        const baseSchoolDay = await checkOperationalSchoolDay(cappedBaseDate, schoolId);
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
    if (sectionId) { studentQuery += ' AND s.section_id = ?'; studentParams.push(sectionId); }

    let teacherQuery = `SELECT t.id, t.firstname, t.lastname, t.employee_id, t.school_id, t.created_at, t.active_from, sc.name as school_name, sc.logo as school_logo, sc.contact as school_contact
        FROM teachers t
        LEFT JOIN schools sc ON t.school_id = sc.id
        WHERE t.status = 'active'`;
    const teacherParams = [];
    if (schoolId) { teacherQuery += ' AND t.school_id = ?'; teacherParams.push(schoolId); }

    const [students, teachers] = await Promise.all([
        db.query(studentQuery, studentParams).then(r => r[0]),
        includeTeachers && !sectionId ? db.query(teacherQuery, teacherParams).then(r => r[0]) : Promise.resolve([])
    ]);

    if (sectionId && students.length === 0) return [];

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
    if (sectionId) {
        // A section dashboard only needs its own student attendance. Teacher
        // flags do not have a section-level meaning, so section calls disable
        // them and avoid reading every attendance row in the school.
        attendanceQuery += " AND person_type = 'student' AND person_id IN (?)";
        attendanceParams.push(students.map(student => student.id));
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
            school_logo: schoolLogoUrl(student.school_id, student.school_logo),
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
            school_logo: schoolLogoUrl(teacher.school_id, teacher.school_logo),
            person_type: 'teacher',
            absent_days: absentDays,
            requested_days: threshold,
            checked_dates: schoolDates.slice(0, absentDays),
            name: `${teacher.firstname} ${teacher.lastname}`.trim()
        }));

    return [...flaggedStudents, ...flaggedTeachers];
}

const consecutiveAbsenceFlagsCache = new Map();
const consecutiveAbsenceFlagsInFlight = new Map();
const CONSECUTIVE_ABSENCE_FLAGS_TTL_MS = 30000;

async function getConsecutiveAbsenceFlags(options) {
    const key = [
        options.baseDate,
        options.schoolId || 'all',
        options.sectionId || 'all-sections',
        Math.max(1, Number(options.days) || 2),
        options.includeTeachers === false ? 'students' : 'all-people',
        Math.max(1, Number(options.maxScanDays) || 45)
    ].join(':');
    const cached = consecutiveAbsenceFlagsCache.get(key);
    if (cached && (Date.now() - cached.timestamp) < CONSECUTIVE_ABSENCE_FLAGS_TTL_MS) {
        return cached.data;
    }
    if (consecutiveAbsenceFlagsInFlight.has(key)) {
        return consecutiveAbsenceFlagsInFlight.get(key);
    }
    const calculation = computeConsecutiveAbsenceFlags(options)
        .then(data => {
            consecutiveAbsenceFlagsCache.set(key, { data, timestamp: Date.now() });
            while (consecutiveAbsenceFlagsCache.size > 500) {
                consecutiveAbsenceFlagsCache.delete(consecutiveAbsenceFlagsCache.keys().next().value);
            }
            return data;
        })
        .finally(() => consecutiveAbsenceFlagsInFlight.delete(key));
    consecutiveAbsenceFlagsInFlight.set(key, calculation);
    return calculation;
}

// GET /api/is-school-day
router.get('/is-school-day', requireAuthOrScannerKiosk, async (req, res) => {
    try {
        const date = req.query.date || todayDate();
        const schoolId = req.query.school_id ? parseInt(req.query.school_id, 10) : null;
        const result = await checkOperationalSchoolDay(date, schoolId);
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
    const normalizedQrLookupCandidates = qrLookupCandidates.map(code => code.toUpperCase());

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
             WHERE s.qr_code IN (?) OR s.lrn IN (?)
                OR UPPER(TRIM(s.qr_code)) IN (?) OR UPPER(TRIM(s.lrn)) IN (?)`,
            [qrLookupCandidates, qrLookupCandidates, normalizedQrLookupCandidates, normalizedQrLookupCandidates]
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
                 WHERE t.qr_code IN (?) OR t.employee_id IN (?)
                    OR UPPER(TRIM(t.qr_code)) IN (?) OR UPPER(TRIM(t.employee_id)) IN (?)`,
                [qrLookupCandidates, qrLookupCandidates, normalizedQrLookupCandidates, normalizedQrLookupCandidates]
            );
            personType = 'teacher';
            person = rows[0];
        }

        if (!person) {
            // Log + return the scanned value so an admin can diagnose why no
            // student or teacher row matched (regenerated QR, deleted record,
            // wrong card, etc.). Without this, the kiosk just shows a generic
            // toast with no actionable detail.
            try {
                console.warn(`[scan] QR not recognized — value=${JSON.stringify(qr_code)} candidates=${JSON.stringify(qrLookupCandidates.slice(0, 4))}`);
            } catch (_) {}
            return res.json({
                success: false,
                error: `QR code not in system: "${qr_code}". The card may have been regenerated, the student removed, or this is not an EduTrack QR.`,
                scanned_value: qr_code,
                qr_unknown: true
            });
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

        const schoolDay = await checkOperationalSchoolDay(today, person.school_id);
        if (!schoolDay.isSchoolDay) {
            return handleNonSchoolDayScan({
                res,
                qr_code,
                person,
                personType,
                today,
                now,
                schoolDay
            });
        }

        // School Year enforcement (students only): only students enrolled in the
        // ACTIVE school year may record attendance. This is FAIL-OPEN by design —
        // a live scanning station must never be blocked by a school-year lookup
        // problem. We reject ONLY when we are confident the student exists in the
        // enrollment system but has no active 'enrolled' record (e.g. transferred
        // out, or not re-enrolled after a year rollover). A student with no
        // enrollment records at all (data gap / pre-existing) still scans.
        if (personType === 'student') {
            try {
                const activeYear = await schoolYears.getActiveSchoolYear();
                if (activeYear) {
                    const [enrRows] = await db.query(
                        `SELECT
                            MAX(CASE WHEN school_year_id = ? AND status = 'enrolled' THEN 1 ELSE 0 END) AS enrolled_active,
                            COUNT(*) AS total_rows
                         FROM student_enrollments WHERE student_id = ?`,
                        [activeYear.id, person.id]
                    );
                    const enrolledActive = Number(enrRows[0] && enrRows[0].enrolled_active) === 1;
                    const hasAnyRecord = Number(enrRows[0] && enrRows[0].total_rows) > 0;
                    if (!enrolledActive && hasAnyRecord) {
                        return res.json({
                            success: false,
                            error: 'Student is not enrolled in the active school year. Ask the adviser to enroll or transfer them first.',
                            not_enrolled: true,
                            // Including person makes the scanner show the actionable
                            // "Scan needs attention" card with name/grade/school —
                            // instead of the generic "QR code not recognized" toast
                            // that loses the enrollment context.
                            person: {
                                id: person.id,
                                name: person.name || `${person.firstname || ''} ${person.lastname || ''}`.trim(),
                                firstname: person.firstname || null,
                                lastname: person.lastname || null,
                                middlename: person.middlename || null,
                                lrn: person.lrn || null,
                                person_type: 'student',
                                grade_name: person.grade_name || null,
                                section_name: person.section_name || null,
                                school_name: person.school_name || null
                            }
                        });
                    }
                }
            } catch (syErr) {
                console.error('Scan: school-year enrollment check skipped:', syErr.message);
            }
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
            const closedDecision = firstScanDecision(now, schedule, 'absent');
            if (!closedDecision.allowed) {
                return res.json({
                    success: false,
                    action: 'ATTENDANCE_CLOSED',
                    status: 'absent',
                    display_status: ATTENDANCE_SCAN_LABELS.ATTENDANCE_CLOSED,
                    attendance_status: 'Attendance Closed',
                    remarks: closedDecision.remarks,
                    monitoring_status: ATTENDANCE_SCAN_LABELS.ATTENDANCE_CLOSED,
                    message: 'Attendance is already closed for today.',
                    person: personInfo,
                    time: formatTime12(now)
                });
            }
            const baseStatus = await getBaseAttendanceStatus(personType, today, statusTime);
            const scanDecision = firstScanDecision(statusTime, schedule, baseStatus);
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
            const displayStatus = scanDecision.label;

            const [insertResult] = await db.query(
                'INSERT INTO attendance (person_type, person_id, school_id, date, time_in, last_time_in, status, monitoring_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [personType, person.id, person.school_id, today, now, now, attendanceStatus, displayStatus]
            );
            await logAttendanceEvent(insertResult.insertId, personType, person.id, person.school_id, today, 'time_in', displayStatus, now);
            notifyParentsForStudentScan({ personType, personId: person.id, label: displayStatus, eventTime: now })
                .catch(err => console.error('Parent scan notification error:', err));

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
                        ? (resolvedStatus.label || 'Half-Day') + ' recorded.'
                        : attendanceStatus === 'late' ? 'Late time in recorded.' : 'Time in recorded.',
                person: personInfo,
                time: formatTime12(now),
                time_in: formatTime12(now)
            });
        }

        // ── Subsequent scans toggle between Time Out and Time In (multiple allowed per day) ──
        const attendanceRow = existing[0];
        if (normalizeEventLabel(attendanceRow.monitoring_status) === ATTENDANCE_SCAN_LABELS.COMPLETED) {
            return res.json({
                success: false,
                action: 'ALREADY_COMPLETED',
                status: attendanceRow.status,
                display_status: ATTENDANCE_SCAN_LABELS.ALREADY_COMPLETED,
                attendance_status: 'Already Completed',
                monitoring_status: ATTENDANCE_SCAN_LABELS.COMPLETED,
                message: 'Attendance for today is already completed. No more scans are needed.',
                person: personInfo,
                time: formatTime12(now),
                time_in: attendanceRow.last_time_in || attendanceRow.time_in ? formatTime12(attendanceRow.last_time_in || attendanceRow.time_in) : null,
                time_out: attendanceRow.time_out ? formatTime12(attendanceRow.time_out) : null
            });
        }
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
                action: 'ALREADY_RECORDED',
                status: attendanceRow.status,
                display_status: ATTENDANCE_SCAN_LABELS.ALREADY_RECORDED,
                attendance_status: 'Already Recorded',
                monitoring_status: attendanceRow.monitoring_status || ATTENDANCE_SCAN_LABELS.ALREADY_RECORDED,
                error: 'Already recorded. Please wait at least 1 minute before scanning again.',
                message: 'Already recorded. Please wait at least 1 minute before scanning again.',
                person: personInfo,
                time: formatTime12(now),
                time_in: attendanceRow.last_time_in || attendanceRow.time_in ? formatTime12(attendanceRow.last_time_in || attendanceRow.time_in) : null,
                time_out: attendanceRow.time_out ? formatTime12(attendanceRow.time_out) : null
            });
        }

        const schedule = await getAttendanceScheduleTimes(today);

        if (isCurrentlyInside(attendanceRow)) {
            // ── Time Out (leave premises / lunch out / end of day) ──
            const label = timeOutScanLabel(now, schedule);

            if (requireTimeOutConfirmation && !confirmedTimeOut) {
                return res.json({
                    success: true,
                    action: 'CONFIRM_TIME_OUT',
                    status: attendanceRow.status,
                    display_status: ATTENDANCE_SCAN_LABELS.PENDING_TIME_OUT,
                    attendance_status: 'Pending Time Out',
                    message: 'Already timed in. Please confirm before recording Time Out.',
                    person: personInfo,
                    time_in: formatTime12(attendanceRow.last_time_in || attendanceRow.time_in),
                    time_out: 'Pending Time Out',
                    monitoring_status: ATTENDANCE_SCAN_LABELS.PENDING_TIME_OUT
                });
            }

            await logAttendanceEvent(attendanceRow.id, personType, person.id, person.school_id, today, 'time_out', label, now);
            notifyParentsForStudentScan({ personType, personId: person.id, label, eventTime: now })
                .catch(err => console.error('Parent scan notification error:', err));
            const resolvedStatus = await resolveAttendanceStatusFromEvents(
                personType,
                today,
                attendanceRow.id,
                attendanceRow.time_in
            );

            await db.query(
                'UPDATE attendance SET time_out = ?, status = ?, monitoring_status = ?, updated_at = ? WHERE id = ?',
                [now, resolvedStatus.status, label, now, attendanceRow.id]
            );

            const outMessages = {
                [ATTENDANCE_SCAN_LABELS.COMPLETED]: 'Completed. Attendance for today is complete.',
                [ATTENDANCE_SCAN_LABELS.LUNCH_OUT]: 'Lunch out recorded. Scan again when you return.',
                [ATTENDANCE_SCAN_LABELS.EARLY_OUT]: 'Early out recorded. Scan again if you return before the session ends.'
            };
            return res.json({
                success: true,
                action: 'TIME_OUT',
                status: resolvedStatus.status,
                display_status: label,
                ...responseAttendanceMeta(resolvedStatus),
                monitoring_status: label,
                completed: label === ATTENDANCE_SCAN_LABELS.COMPLETED,
                message: resolvedStatus.status === 'half_day'
                    ? (resolvedStatus.label || 'Half-Day') + ' recorded. ' + (resolvedStatus.remarks || '')
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
        const label = returnScanLabel(attendanceRow.monitoring_status, now, schedule);
        if (label === ATTENDANCE_SCAN_LABELS.ATTENDANCE_CLOSED) {
            return res.json({
                success: false,
                action: 'ATTENDANCE_CLOSED',
                status: attendanceRow.status,
                display_status: ATTENDANCE_SCAN_LABELS.ATTENDANCE_CLOSED,
                attendance_status: 'Attendance Closed',
                monitoring_status: attendanceRow.monitoring_status,
                message: 'Attendance is already closed for today. This return scan was not recorded.',
                person: personInfo,
                time: formatTime12(now),
                time_in: attendanceRow.last_time_in || attendanceRow.time_in ? formatTime12(attendanceRow.last_time_in || attendanceRow.time_in) : null,
                time_out: attendanceRow.time_out ? formatTime12(attendanceRow.time_out) : null
            });
        }
        await logAttendanceEvent(attendanceRow.id, personType, person.id, person.school_id, today, 'time_in', label, now);
        notifyParentsForStudentScan({ personType, personId: person.id, label, eventTime: now })
            .catch(err => console.error('Parent scan notification error:', err));
        const resolvedStatus = await resolveAttendanceStatusFromEvents(
            personType,
            today,
            attendanceRow.id,
            attendanceRow.time_in
        );
        await db.query(
            'UPDATE attendance SET last_time_in = ?, status = ?, monitoring_status = ?, updated_at = ? WHERE id = ?',
            [now, resolvedStatus.status, label, now, attendanceRow.id]
        );

        return res.json({
            success: true,
            action: 'TIME_IN',
            status: resolvedStatus.status,
            display_status: label,
            ...responseAttendanceMeta(resolvedStatus),
            monitoring_status: label,
            message: label === ATTENDANCE_SCAN_LABELS.WELCOME_BACK
                ? 'Welcome back. Lunch return recorded.'
                : label === ATTENDANCE_SCAN_LABELS.PM_LATE_TIME_IN
                    ? 'PM late time in recorded.'
                    : label === ATTENDANCE_SCAN_LABELS.PM_TIME_IN
                        ? 'PM time in recorded.'
                        : 'Returned. Attendance scan recorded.',
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
const dashboardCache = new Map();
const dashboardCacheInFlight = new Map();
const DASHBOARD_CACHE_MAX_KEYS = 500;

router.get('/dashboard-data', requireAuth, async (req, res) => {
    let cacheKey = '';
    let finishSharedRequest = null;
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        const date = req.query.date || todayDate();
        const schoolId = applySchoolFilter(req);
        const canSeeDesktopScanners = req.session?.user?.role === 'super_admin';
        const includeAbsenceFlags = req.query.include_flags === '1';
        // Scanner device detail belongs to /scanner-status. Dashboard clients
        // receive only the summary unless an API caller explicitly asks for it.
        const includeScannerDevices = canSeeDesktopScanners && req.query.include_scanner_devices === '1';
        const absenceCountingActive = await shouldCountComputedAbsences(date, schoolId);
        cacheKey = `${date}-${schoolId || 'all'}-${absenceCountingActive ? 'absence-closed' : 'attendance-open'}-${canSeeDesktopScanners ? 'scanner-visible' : 'scanner-hidden'}-${includeScannerDevices ? 'scanner-devices' : 'scanner-summary'}-${includeAbsenceFlags ? 'flags-included' : 'flags-count-only'}`;
        const cacheTtlMs = 30000;

        // A client cache-busting query parameter must not force duplicate MySQL
        // work. Dashboard aggregates are shared briefly; live scanner detail is
        // served by its dedicated endpoint and is not slowed by this cache.
        const cached = dashboardCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < cacheTtlMs) {
            return res.json(cached.data);
        }
        const inFlight = dashboardCacheInFlight.get(cacheKey);
        if (inFlight) {
            const shared = await inFlight;
            if (shared) return res.json(shared);
        }
        dashboardCacheInFlight.set(cacheKey, new Promise(resolve => { finishSharedRequest = resolve; }));

        const schoolFilter = schoolId ? ' AND school_id = ?' : '';
        const schoolParams = schoolId ? [schoolId] : [];

        // These totals are independent. Running them together preserves the
        // exact dashboard values while removing a long sequential wait for
        // Principal and division-scoped requests.
        const [
            [schoolRows],
            [activeStudents],
            [allStudents],
            [teacherRows],
            computedAbsent,
            eligibleStudents,
            computedTeacherAbsent,
            eligibleTeachers,
            studentStatusCounts,
            teacherStatusCounts
        ] = await Promise.all([
            db.query(
                `SELECT COUNT(*) as count FROM schools WHERE status = 'active'` + (schoolId ? ' AND id = ?' : ''),
                schoolId ? [schoolId] : []
            ),
            db.query(`SELECT COUNT(*) as count FROM students WHERE status = 'active'` + schoolFilter, schoolParams),
            db.query(`SELECT COUNT(*) as count FROM students WHERE 1=1` + schoolFilter, schoolParams),
            db.query(`SELECT COUNT(*) as count FROM teachers WHERE status = 'active'` + schoolFilter, schoolParams),
            countStudentsWithoutTimeIn(date, schoolId),
            countAttendanceEligibleStudents(date, schoolId),
            countTeachersWithoutTimeIn(date, schoolId),
            countAttendanceEligibleTeachers(date, schoolId),
            getAttendanceStatusCounts('student', date, { schoolId }),
            getAttendanceStatusCounts('teacher', date, { schoolId })
        ]);

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
        const scannerPresence = canSeeDesktopScanners ? await getDesktopScannerPresence(schoolId) : null;

        // Fetch division totals in six grouped queries instead of repeating six
        // queries for every school. This keeps SDS/ASDS dashboard loads bounded
        // even when the division has many schools and thousands of students.
        const [
            eligibleStudentsBySchool,
            eligibleTeachersBySchool,
            studentStatusBySchool,
            teacherStatusBySchool,
            absentStudentsBySchool,
            absentTeachersBySchool,
            schoolAbsenceDecisions
        ] = await Promise.all([
            getEligibleCountsBySchool('student', date, schoolId),
            getEligibleCountsBySchool('teacher', date, schoolId),
            getAttendanceStatusCountsBySchool('student', date, schoolId),
            getAttendanceStatusCountsBySchool('teacher', date, schoolId),
            absenceCountingActive ? getAbsentCountsBySchool('student', date, schoolId) : Promise.resolve(new Map()),
            absenceCountingActive ? getAbsentCountsBySchool('teacher', date, schoolId) : Promise.resolve(new Map()),
            absenceCountingActive
                ? Promise.all(schoolBreakdown.map(async school => [
                    String(school.id),
                    await shouldCountComputedAbsences(date, school.id)
                ]))
                : Promise.resolve([])
        ]);
        const absenceActiveBySchool = new Map(schoolAbsenceDecisions);
        const emptyStatusCounts = {
            present: 0,
            late: 0,
            half_day: 0,
            full_day: 0,
            timed_in: 0,
            timed_out: 0
        };

        const breakdown = [];
        for (const s of schoolBreakdown) {
            const schoolKey = String(s.id);
            const eligible = eligibleStudentsBySchool.get(schoolKey) || 0;
            const teacherEligible = eligibleTeachersBySchool.get(schoolKey) || 0;
            const studentCounts = studentStatusBySchool.get(schoolKey) || emptyStatusCounts;
            const teacherCounts = teacherStatusBySchool.get(schoolKey) || emptyStatusCounts;
            const schoolAbsenceActive = absenceActiveBySchool.get(schoolKey) === true;
            const studentAbsent = schoolAbsenceActive ? (absentStudentsBySchool.get(schoolKey) || 0) : 0;
            const teacherAbsent = schoolAbsenceActive ? (absentTeachersBySchool.get(schoolKey) || 0) : 0;
            const fullDayStudents = studentCounts.full_day;
            const fullDayTeachers = teacherCounts.full_day;
            const scannerInfo = scannerPresence ? (scannerPresence.bySchool.get(String(s.id)) || null) : null;
            const latestScanner = scannerInfo?.latest || null;
            breakdown.push({
                id: s.id,
                name: s.name,
                logo: schoolLogoUrl(s.id, s.logo),
                enrollment: s.enrollment,
                attendance_eligible_students: Math.max(eligible, studentCounts.timed_in || 0),
                present: studentCounts.present,
                late: studentCounts.late,
                half_day: studentCounts.half_day,
                full_day: fullDayStudents,
                absent: studentAbsent,
                rate: Math.max(eligible, studentCounts.timed_in || 0) > 0 ? Math.min(100, Math.round((fullDayStudents / Math.max(eligible, studentCounts.timed_in || 0)) * 100)) : 0,
                teachers_total: s.teachers_total || 0,
                attendance_eligible_teachers: Math.max(teacherEligible, teacherCounts.timed_in || 0),
                teachers_present: teacherCounts.present,
                teachers_late: teacherCounts.late,
                teachers_half_day: teacherCounts.half_day,
                teachers_full_day: fullDayTeachers,
                teachers_absent: teacherAbsent,
                teacher_rate: Math.max(teacherEligible, teacherCounts.timed_in || 0) > 0 ? Math.min(100, Math.round((fullDayTeachers / Math.max(teacherEligible, teacherCounts.timed_in || 0)) * 100)) : 0,
                ...(canSeeDesktopScanners ? {
                scanner_total: scannerInfo ? scannerInfo.total_scanners : 0,
                scanner_active: scannerInfo ? scannerInfo.active_scanners : 0,
                scanner_idle: scannerInfo ? scannerInfo.idle_scanners : 0,
                scanner_offline: scannerInfo ? scannerInfo.offline_scanners : 0,
                scanner_status: scannerInfo && scannerInfo.active_scanners > 0
                    ? 'active'
                    : scannerInfo && scannerInfo.idle_scanners > 0
                        ? 'idle'
                        : 'offline',
                scanner_last_seen_at: latestScanner ? latestScanner.last_seen_at : null,
                scanner_last_seen_seconds: latestScanner ? latestScanner.age_seconds : null,
                scanner_id: latestScanner ? latestScanner.scanner_id : '',
                scanner_app_version: latestScanner ? latestScanner.app_version : '',
                scanner_device_name: latestScanner ? latestScanner.device_name : '',
                scanner_queued_count: scannerInfo ? scannerInfo.queued_count : 0,
                scanner_sync_in_progress: scannerInfo ? scannerInfo.sync_in_progress : false
                } : {})
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
        const schoolDayResult = await checkOperationalSchoolDay(date, schoolId);
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
            ...(includeAbsenceFlags ? { absence_flags: flaggedAbsent } : {}),
            absence_counting_active: absenceCountingActive,
            absence_counting_message: absenceCountingActive ? 'Absence counting is active.' : 'Absences are pending until the official end-of-school-day time.',
            is_school_day: isSchoolDay,
            non_school_day_reason: nonSchoolDayReason,
            non_school_day_type: nonSchoolDayType,
            ...(canSeeDesktopScanners ? {
                scanner_status_summary: scannerPresence.summary,
                ...(includeScannerDevices ? { desktop_scanners: scannerPresence.devices } : {}),
                system_security: getSystemTrafficMetrics()
            } : {}),
            schools: breakdown
        };

        dashboardCache.set(cacheKey, { data, timestamp: Date.now() });
        while (dashboardCache.size > DASHBOARD_CACHE_MAX_KEYS) {
            dashboardCache.delete(dashboardCache.keys().next().value);
        }
        finishSharedRequest(data);
        dashboardCacheInFlight.delete(cacheKey);

        return res.json(data);
    } catch (err) {
        if (finishSharedRequest) finishSharedRequest(null);
        if (cacheKey) dashboardCacheInFlight.delete(cacheKey);
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
// Store a main-app (SDS/ASDS/admin) user's FCM token for push delivery.
router.post('/user-device-token', requireAuth, async (req, res) => {
    const pushToken = String(req.body.push_token || '').trim();
    if (!pushToken) return res.status(400).json({ success: false, error: 'push_token required.' });
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS user_devices (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                push_token VARCHAR(255) NOT NULL,
                platform VARCHAR(20),
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_user_device_token (push_token),
                INDEX idx_user_devices_user (user_id)
            ) ENGINE=InnoDB
        `).catch(() => {});
        await db.query(
            `INSERT INTO user_devices (user_id, push_token, platform)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), updated_at = CURRENT_TIMESTAMP`,
            [req.session.user.id, pushToken, String(req.body.platform || 'android')]
        );
        return res.json({ success: true });
    } catch (err) {
        console.error('User device token error:', err);
        return res.status(500).json({ success: false, error: 'Failed to register device.' });
    }
});

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
    dashboardCache.clear();
    absenceCountingDecisionCache.clear();
    consecutiveAbsenceFlagsCache.clear();
    realtimePollCache.clear();
    schoolMapCache = null;
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
            const schoolDay = await checkOperationalSchoolDay(dayDate, schoolId);
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
const realtimePollCache = new Map();
const REALTIME_POLL_CACHE_TTL_MS = 2500;
router.get('/realtime-poll', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const clientHash = req.query.hash || '';
    const schoolId = applySchoolFilter(req);
    const pollCacheKey = String(schoolId || 'all');
    const cachedPoll = realtimePollCache.get(pollCacheKey);
    if (cachedPoll && (Date.now() - cachedPoll.timestamp) < REALTIME_POLL_CACHE_TTL_MS) {
        return res.json({
            ...cachedPoll.data,
            changed: cachedPoll.data.hash !== clientHash
        });
    }

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
        // Track all roster changes through indexed row metadata. The previous
        // three-second CRC of every student/teacher field forced full-table CPU
        // work even when nothing changed.
        const [studentRows] = await db.query(
            `SELECT COUNT(*) as cnt, SUM(status='active') as active, SUM(status='inactive') as inactive,
                    MAX(updated_at) as latest
             FROM students WHERE status != 'deleted'` + schoolWhere,
            schoolParams
        );
        const [teacherRows] = await db.query(
            `SELECT COUNT(*) as cnt, MAX(updated_at) as latest
             FROM teachers WHERE status != 'deleted'` + schoolWhere,
            schoolParams
        );
        const [schoolRows] = await db.query(
            `SELECT COUNT(*) as cnt, MAX(updated_at) as latest FROM schools WHERE 1=1` + (schoolId ? ' AND id = ?' : ''),
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
            `SELECT COUNT(*) as cnt, MAX(updated_at) as latest
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
                'auto_activate_on_scan',
                'ai_report_icon'
             )`
        );

        const raw = `${absenceCountingActive ? 'closed' : 'open'}-${countRows[0].cnt}-${latestRows[0].latest || ''}-${studentRows[0].cnt}-${studentRows[0].active}-${studentRows[0].inactive}-${studentRows[0].latest || ''}-${teacherRows[0].cnt}-${teacherRows[0].latest || ''}-${schoolRows[0].cnt}-${schoolRows[0].latest || ''}-${gradeRows[0].cnt}-${gradeRows[0].checksum}-${sectionRows[0].cnt}-${sectionRows[0].checksum}-${notificationRows[0].cnt}-${notificationRows[0].latest || ''}-${settingsRows[0].cnt}-${settingsRows[0].latest || ''}`;
        const hash = crypto.createHash('md5').update(raw).digest('hex').substring(0, 12);
        const changed = hash !== clientHash;

        const pollData = {
            hash,
            absence_counting_active: absenceCountingActive,
            attendance_count: countRows[0].cnt,
            student_count: studentRows[0].cnt
        };
        realtimePollCache.set(pollCacheKey, { data: pollData, timestamp: Date.now() });
        while (realtimePollCache.size > 500) {
            realtimePollCache.delete(realtimePollCache.keys().next().value);
        }
        return res.json({ ...pollData, changed });
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
        const searchTerm = String(req.query.search || '').trim();
        if (searchTerm) {
            query += ` AND (
                s.firstname LIKE ? OR s.lastname LIKE ? OR s.middlename LIKE ? OR s.lrn LIKE ?
                OR s.guardian_name LIKE ? OR s.guardian_contact LIKE ?
                OR sc.name LIKE ? OR gl.name LIKE ? OR sec.name LIKE ?
            )`;
            const s = `%${searchTerm}%`;
            params.push(s, s, s, s, s, s, s, s, s);
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

        // Keep the active school-year enrollment in sync with the student edit
        // modal. Guardian registration checks active enrollments, so changing a
        // guardian contact / section here must stay visible to the parent app.
        if ((!validStatus || validStatus === 'active') && school_id && grade_level_id && section_id) {
            const [[studentRow]] = await db.query(
                'SELECT status FROM students WHERE id = ? LIMIT 1',
                [req.params.id]
            );
            if (studentRow && studentRow.status === 'active') {
                try {
                    await schoolYears.enrollStudentInActiveYear({
                        studentId: req.params.id,
                        schoolId: school_id,
                        gradeLevelId: grade_level_id,
                        sectionId: section_id
                    });
                } catch (enrollErr) {
                    console.error('Update student: enrollment sync skipped:', enrollErr.message);
                }
            }
        }
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
        const searchTerm = String(req.query.search || '').trim();
        if (searchTerm) {
            query += ` AND (
                t.firstname LIKE ? OR t.lastname LIKE ? OR t.middlename LIKE ?
                OR t.employee_id LIKE ? OR t.contact LIKE ? OR t.email LIKE ?
                OR t.department LIKE ? OR t.subject LIKE ?
                OR sec.name LIKE ? OR gl.name LIKE ? OR s.name LIKE ?
            )`;
            const s = `%${searchTerm}%`;
            params.push(s, s, s, s, s, s, s, s, s, s, s);
        }
        query += ' ORDER BY t.lastname, t.firstname';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        console.error('Get teachers error:', err);
        return res.status(500).json({ error: 'Failed to fetch teachers.' });
    }
});

// Return the grade choices required by the teacher type. Older schools may not
// have grade-level rows yet, so create the missing rows once for that school.
router.post('/teacher-grade-options', requireRole('super_admin', 'principal'), async (req, res) => {
    const schoolId = parseInt(req.body.school_id, 10);
    const category = req.body.category === 'shs_teacher' ? 'shs_teacher' : 'teacher';
    if (!schoolId) return res.status(400).json({ error: 'Select a school first.' });
    const scopedSchool = applySchoolFilter(req);
    if (scopedSchool && Number(scopedSchool) !== Number(schoolId)) {
        return res.status(403).json({ error: 'You can only manage grades in your school.' });
    }
    try {
        const [[school]] = await db.query("SELECT id FROM schools WHERE id = ? AND status = 'active' LIMIT 1", [schoolId]);
        if (!school) return res.status(404).json({ error: 'Selected school was not found.' });
        const [existing] = await db.query('SELECT id, name, school_id FROM grade_levels WHERE school_id = ?', [schoolId]);
        const byNumber = new Map();
        existing.forEach(grade => {
            const match = String(grade.name || '').match(/\bgrade\s*(\d+)\b/i);
            if (match && !byNumber.has(parseInt(match[1], 10))) byNumber.set(parseInt(match[1], 10), grade);
        });
        const numbers = category === 'shs_teacher' ? [11, 12] : Array.from({ length: 10 }, (_, index) => index + 1);
        const grades = [];
        for (const number of numbers) {
            let grade = byNumber.get(number);
            if (!grade) {
                const name = `Grade ${number}`;
                const [result] = await db.query('INSERT INTO grade_levels (name, school_id) VALUES (?, ?)', [name, schoolId]);
                grade = { id: result.insertId, name, school_id: schoolId };
            }
            grades.push(grade);
        }
        return res.json({ success: true, grades });
    } catch (err) {
        console.error('Teacher grade options error:', err);
        return res.status(500).json({ error: 'Failed to load grade choices.' });
    }
});

// Resolve a typed advisory section to a real section record. This keeps the
// teacher form free-text while preserving all report/adviser relationships.
router.post('/teacher-sections/resolve', requireRole('super_admin', 'principal'), async (req, res) => {
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    const schoolId = parseInt(req.body.school_id, 10);
    const gradeLevelId = parseInt(req.body.grade_level_id, 10);
    if (!name || !schoolId || !gradeLevelId) {
        return res.status(400).json({ error: 'School, grade level, and section name are required.' });
    }
    const scopedSchool = applySchoolFilter(req);
    if (scopedSchool && Number(scopedSchool) !== Number(schoolId)) {
        return res.status(403).json({ error: 'You can only create sections in your school.' });
    }
    try {
        const [[grade]] = await db.query('SELECT id, school_id FROM grade_levels WHERE id = ? LIMIT 1', [gradeLevelId]);
        if (!grade || (grade.school_id && Number(grade.school_id) !== Number(schoolId))) {
            return res.status(400).json({ error: 'The selected grade does not belong to this school.' });
        }
        const [[existing]] = await db.query(
            `SELECT id FROM sections
             WHERE school_id = ? AND grade_level_id = ? AND LOWER(TRIM(name)) = LOWER(?)
               AND (status IS NULL OR status != 'deleted') LIMIT 1`,
            [schoolId, gradeLevelId, name]
        );
        if (existing) return res.json({ success: true, id: existing.id, created: false });
        const [result] = await db.query(
            'INSERT INTO sections (name, school_id, grade_level_id, status) VALUES (?, ?, ?, ?)',
            [name, schoolId, gradeLevelId, 'active']
        );
        return res.json({ success: true, id: result.insertId, created: true });
    } catch (err) {
        console.error('Resolve teacher section error:', err);
        return res.status(500).json({ error: 'Failed to save the advisory section.' });
    }
});

// POST /api/teachers
router.post('/teachers', requireAuth, async (req, res) => {
    const { employee_id, firstname, lastname, middlename, department, subject, contact, email, school_id, grade_level_id, section_id, category } = req.body;
    if (!firstname || !lastname || !school_id) {
        return res.status(400).json({ error: 'First name, last name, and school are required.' });
    }
    try {
        const gradeError = await validateTeacherGradeCategory({ schoolId: school_id, gradeLevelId: grade_level_id, category });
        if (gradeError) return res.status(400).json({ error: gradeError });
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
        const gradeError = await validateTeacherGradeCategory({ schoolId: school_id, gradeLevelId: grade_level_id, category });
        if (gradeError) return res.status(400).json({ error: gradeError });
        const assignment = await validateTeacherAssignment({ teacherId: req.params.id, schoolId: school_id, gradeLevelId: grade_level_id, sectionId: section_id });
        if (assignment?.error) return res.status(400).json({ error: assignment.error });
        const validStatus = ['active', 'inactive', 'deleted'].includes(status) ? status : (existing.status || 'inactive');
        const teacherCategory = category === 'shs_teacher' ? 'shs_teacher' : 'teacher';
        const fields = [
            'employee_id=?', 'firstname=?', 'lastname=?', 'middlename=?',
            'contact=?', 'email=?', 'school_id=?', 'grade_level_id=?', 'section_id=?', 'category=?', 'status=?'
        ];
        const params = [
            employee_id || null, firstname, lastname, middlename || null,
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
    const { name, school_id_code, address, contact, latitude, longitude } = req.body;
    if (!name) return res.status(400).json({ error: 'School name is required.' });
    try {
        // Auto-generate school_code from initials + sequence
        const initials = name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 6);
        const [existing] = await db.query('SELECT COUNT(*) as cnt FROM schools WHERE school_code LIKE ?', [initials + '%']);
        const code = initials + '-' + String(existing[0].cnt + 1).padStart(3, '0');
        const lat = normalizeCoordinate(latitude, -90, 90);
        const lng = normalizeCoordinate(longitude, -180, 180);
        const [result] = await db.query(
            'INSERT INTO schools (name, school_id_code, school_code, address, contact, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, school_id_code || null, code, address || null, contact || null, lat, lng]
        );
        return res.json({ success: true, id: result.insertId, school_code: code });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to create school.' });
    }
});

router.put('/schools/:id', requireAuth, async (req, res) => {
    const { name, school_id_code, address, contact, status, logo, latitude, longitude } = req.body;
    try {
        const [[existing]] = await db.query('SELECT logo, latitude, longitude FROM schools WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ error: 'School not found.' });
        const keepLogo = typeof logo === 'string' && logo.trim() ? logo.trim() : existing.logo;
        const lat = latitude !== undefined ? normalizeCoordinate(latitude, -90, 90) : existing.latitude;
        const lng = longitude !== undefined ? normalizeCoordinate(longitude, -180, 180) : existing.longitude;
        await db.query('UPDATE schools SET name=?, school_id_code=?, address=?, contact=?, status=?, logo=?, latitude=?, longitude=? WHERE id=?',
            [name, school_id_code || null, address || null, contact || null, status || 'active', keepLogo || null, lat, lng, req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update school.' });
    }
});

// GET /api/school-map-data — lightweight feed for the Sipalay City map widget
// on the super_admin dashboard. Reuses getDesktopScannerPresence() so scanner
// online/offline logic is never duplicated. Date-independent (unlike
// /dashboard-data), so the map doesn't need to recompute on every date change.
let schoolMapCache = null;
router.get('/school-map-data', requireRole('super_admin'), async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        if (schoolMapCache && (Date.now() - schoolMapCache.timestamp) < 5000) {
            return res.json(schoolMapCache.data);
        }
        const [schools] = await db.query(
            `SELECT id, name, logo, address, latitude, longitude
             FROM schools WHERE status = 'active' ORDER BY name`
        );
        const scannerPresence = await getDesktopScannerPresence(null);

        const data = schools.map(s => {
            const info = scannerPresence.bySchool.get(String(s.id)) || null;
            const latest = info?.latest || null;
            return {
                id: s.id,
                name: s.name,
                // Keep raw uploaded logo bytes out of this frequent response.
                // The versioned URL retains immediate upload/delete behavior.
                logo: schoolLogoUrl(s.id, s.logo),
                address: s.address,
                latitude: s.latitude != null ? Number(s.latitude) : null,
                longitude: s.longitude != null ? Number(s.longitude) : null,
                // Map-only simplification: online = at least one scanner actively
                // checking in right now. Idle/offline both render as "offline" on
                // the map. The School Breakdown table keeps its separate 3-state pill.
                online: !!(info && info.active_scanners > 0),
                scanner_total: info ? info.total_scanners : 0,
                scanner_active: info ? info.active_scanners : 0,
                scanner_idle: info ? info.idle_scanners : 0,
                scanner_offline: info ? info.offline_scanners : 0,
                scanner_last_seen_at: latest ? latest.last_seen_at : null,
                scanner_last_seen_seconds: latest ? latest.age_seconds : null,
                scanner_id: latest ? latest.scanner_id : '',
                scanner_app_version: latest ? latest.app_version : '',
                scanner_device_name: latest ? latest.device_name : '',
                scanner_queued_count: info ? info.queued_count : 0,
                scanner_sync_in_progress: info ? info.sync_in_progress : false
            };
        });
        const payload = { schools: data, system_security: getSystemTrafficMetrics() };
        schoolMapCache = { data: payload, timestamp: Date.now() };
        return res.json(payload);
    } catch (err) {
        console.error('School map data error:', err);
        return res.status(500).json({ error: 'Failed to fetch school map data.' });
    }
});

async function optimizedImageToDataUrl(file, options = {}) {
    const maxWidth = options.maxWidth || 512;
    const maxHeight = options.maxHeight || 512;
    const targetBytes = options.targetBytes || 120 * 1024;
    const attempts = options.attempts || [
        { scale: 1, quality: 82 },
        { scale: 0.75, quality: 74 },
        { scale: 0.5, quality: 66 }
    ];
    let optimized = null;

    for (const attempt of attempts) {
        optimized = await sharp(file.buffer, {
            failOn: 'error',
            limitInputPixels: 40_000_000
        })
            .rotate()
            .resize({
                width: Math.max(64, Math.round(maxWidth * attempt.scale)),
                height: Math.max(64, Math.round(maxHeight * attempt.scale)),
                fit: 'inside',
                withoutEnlargement: true
            })
            .webp({
                quality: attempt.quality,
                alphaQuality: 88,
                effort: 4,
                smartSubsample: true
            })
            .toBuffer();
        if (optimized.length <= targetBytes) break;
    }

    return `data:image/webp;base64,${optimized.toString('base64')}`;
}

function optimizedLogoToDataUrl(file) {
    return optimizedImageToDataUrl(file, {
        maxWidth: 512,
        maxHeight: 512,
        targetBytes: 120 * 1024
    });
}

function optimizedIconToDataUrl(file) {
    return optimizedImageToDataUrl(file, {
        maxWidth: 256,
        maxHeight: 256,
        targetBytes: 60 * 1024
    });
}

function optimizedDashboardArtToDataUrl(file) {
    return optimizedImageToDataUrl(file, {
        maxWidth: 1280,
        maxHeight: 720,
        targetBytes: 300 * 1024,
        attempts: [
            { scale: 1, quality: 82 },
            { scale: 0.75, quality: 74 },
            { scale: 0.5625, quality: 68 }
        ]
    });
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

router.get('/active-users-overview', requireRole('super_admin'), async (req, res) => {
    try {
        const [staff] = await db.query(
            `SELECT u.id, u.username, u.fullname, u.email, u.contact, u.role, u.school_id, u.status,
                    u.last_login,
                    COALESCE(ud.last_seen_at, u.last_login) AS last_seen_at,
                    COALESCE(ud.device_count, 0) AS device_count,
                    s.name AS school_name
             FROM users u
             LEFT JOIN schools s ON s.id = u.school_id
             LEFT JOIN (
                SELECT user_id, MAX(updated_at) AS last_seen_at, COUNT(*) AS device_count
                FROM user_devices
                GROUP BY user_id
             ) ud ON ud.user_id = u.id
             WHERE u.role IN ('super_admin','principal','superintendent','asst_superintendent')
               AND u.status <> 'deleted'
             ORDER BY FIELD(u.role,'super_admin','superintendent','asst_superintendent','principal'), u.fullname`
        );
        const [teachers] = await db.query(
            `SELECT t.id, t.employee_id, t.firstname, t.lastname, t.middlename, t.email, t.contact,
                    t.category, t.status, t.last_login AS last_seen_at,
                    IF(t.password IS NOT NULL AND t.password != '', 1, 0) AS has_password,
                    s.name AS school_name, gl.name AS grade_name, sec.name AS section_name
             FROM teachers t
             LEFT JOIN schools s ON s.id = t.school_id
             LEFT JOIN grade_levels gl ON gl.id = t.grade_level_id
             LEFT JOIN sections sec ON sec.id = t.section_id
             WHERE t.status <> 'deleted'
             ORDER BY t.lastname, t.firstname`
        );
        const [parents] = await db.query(
            `SELECT p.id, p.guardian_name, p.contact_number, p.normalized_contact, p.username,
                    p.status, p.last_login,
                    COALESCE(pd.last_seen_at, p.last_login) AS last_seen_at,
                    COALESCE(pd.device_count, 0) AS device_count,
                    lpd.device_name AS latest_device_name,
                    lpd.platform AS latest_device_platform,
                    lpd.app_version AS latest_device_app_version,
                    lpd.user_agent AS latest_device_user_agent
             FROM parents p
             LEFT JOIN (
                SELECT parent_id, MAX(COALESCE(last_seen_at, updated_at, created_at)) AS last_seen_at, COUNT(*) AS device_count
                FROM parent_devices
                GROUP BY parent_id
             ) pd ON pd.parent_id = p.id
             LEFT JOIN parent_devices lpd ON lpd.id = (
                SELECT pd2.id
                FROM parent_devices pd2
                WHERE pd2.parent_id = p.id
                ORDER BY COALESCE(pd2.last_seen_at, pd2.updated_at, pd2.created_at) DESC, pd2.id DESC
                LIMIT 1
             )
             WHERE p.status <> 'deleted'
             ORDER BY p.guardian_name`
        );
        const parentRows = attachParentDeviceLabels(parents);
        return res.json({
            generated_at: nowDateTime(),
            summary: {
                staff: staff.length,
                teachers: teachers.length,
                parents: parentRows.length,
                mobile_devices: parentRows.reduce((sum, p) => sum + Number(p.device_count || 0), 0) +
                    staff.reduce((sum, u) => sum + Number(u.device_count || 0), 0)
            },
            staff,
            teachers,
            parents: parentRows
        });
    } catch (err) {
        console.error('Active users overview error:', err);
        return res.status(500).json({ error: 'Failed to load active users.' });
    }
});

router.post('/active-users/:accountType/:id/password', requireRole('super_admin'), express.json(), async (req, res) => {
    const accountType = String(req.params.accountType || '').toLowerCase();
    const id = parseInt(req.params.id, 10);
    const password = String(req.body.password || '');
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid account.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    try {
        const hash = await bcrypt.hash(password, 10);
        if (accountType === 'admin' || accountType === 'staff') {
            const [result] = await db.query('UPDATE users SET password = ? WHERE id = ?', [hash, id]);
            if (!result.affectedRows) return res.status(404).json({ error: 'User not found.' });
        } else if (accountType === 'teacher' || accountType === 'adviser') {
            const [result] = await db.query('UPDATE teachers SET password = ? WHERE id = ?', [hash, id]);
            if (!result.affectedRows) return res.status(404).json({ error: 'Teacher not found.' });
        } else if (accountType === 'parent') {
            const [result] = await db.query('UPDATE parents SET password = ? WHERE id = ?', [hash, id]);
            if (!result.affectedRows) return res.status(404).json({ error: 'Parent not found.' });
        } else {
            return res.status(400).json({ error: 'Unsupported account type.' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Active user password reset error:', err);
        return res.status(500).json({ error: 'Failed to change password.' });
    }
});

router.delete('/active-users/:accountType/:id', requireRole('super_admin'), async (req, res) => {
    const accountType = String(req.params.accountType || '').toLowerCase();
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid account.' });
    try {
        if (accountType === 'admin' || accountType === 'staff') {
            if (Number(req.session.user.id) === id) {
                return res.status(400).json({ error: 'You cannot delete the account you are currently using.' });
            }
            const [[user]] = await db.query('SELECT id, role, status FROM users WHERE id = ? LIMIT 1', [id]);
            if (!user || user.status === 'deleted') return res.status(404).json({ error: 'User not found.' });
            if (user.role === 'super_admin') {
                const [[remaining]] = await db.query(
                    "SELECT COUNT(*) AS cnt FROM users WHERE role = 'super_admin' AND status = 'active' AND id <> ?",
                    [id]
                );
                if (!Number(remaining.cnt || 0)) {
                    return res.status(400).json({ error: 'At least one active Super Admin account must remain.' });
                }
            }
            await db.query("UPDATE users SET status = 'deleted' WHERE id = ?", [id]);
            await db.query('DELETE FROM user_devices WHERE user_id = ?', [id]);
        } else if (accountType === 'teacher' || accountType === 'adviser') {
            const [[teacher]] = await db.query('SELECT id, section_id, status FROM teachers WHERE id = ? LIMIT 1', [id]);
            if (!teacher || teacher.status === 'deleted') return res.status(404).json({ error: 'Teacher not found.' });
            await db.query("UPDATE teachers SET status = 'deleted', password = NULL WHERE id = ?", [id]);
            if (teacher.section_id) {
                await db.query(
                    'UPDATE sections SET adviser = NULL, adviser_teacher_id = NULL WHERE id = ? AND adviser_teacher_id = ?',
                    [teacher.section_id, id]
                );
            }
        } else if (accountType === 'parent') {
            const [[parent]] = await db.query('SELECT id, status FROM parents WHERE id = ? LIMIT 1', [id]);
            if (!parent || parent.status === 'deleted') return res.status(404).json({ error: 'Parent not found.' });
            await db.query("UPDATE parents SET status = 'deleted', password = CONCAT('deleted-', UUID()) WHERE id = ?", [id]);
            await db.query('DELETE FROM parent_devices WHERE parent_id = ?', [id]);
        } else {
            return res.status(400).json({ error: 'Unsupported account type.' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Active user delete error:', err);
        return res.status(500).json({ error: 'Failed to delete account.' });
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
        const [schedule, eventsByAttendance, pmLateTime, studentLateThreshold, teacherLateThreshold] = await Promise.all([
            getAttendanceScheduleTimes(date),
            getAttendanceEventsByIds(rows.map(row => row.id)),
            getPmLateTime(),
            getAttendanceLateThreshold('student', date),
            getAttendanceLateThreshold('teacher', date)
        ]);
        decorateLateHalfDays(rows, pmLateTime);
        rows.forEach(row => {
            const rowDate = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
            row.scan_summary = buildAttendanceScanSummary(row, rowDate, schedule, eventsByAttendance.get(row.id) || []);
            if (!row.time_in) {
                row.attendance_status = 'Absent';
                return;
            }
            const resolved = resolveAttendanceStatusFromLoadedEvents({
                firstTimeIn: row.time_in,
                lateThreshold: row.person_type === 'teacher' ? teacherLateThreshold : studentLateThreshold,
                schedule,
                storedEvents: eventsByAttendance.get(row.id) || []
            });
            row.status = resolved.status || row.status;
            row.attendance_status = resolved.label || statusLabel(row.status);
            row.half_day_type = resolved.halfDayType || null;
            row.late_half_day = !!resolved.lateHalfDay || !!row.late_half_day;
            row.remarks = resolved.remarks || '';
        });
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
            const logoPath = await optimizedLogoToDataUrl(req.file);
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
            const art = await optimizedDashboardArtToDataUrl(req.file);
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
            const icon = await optimizedIconToDataUrl(req.file);
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
            const logoPath = await optimizedIconToDataUrl(req.file);
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
    const holidayName = String(name || '').trim();
    const holidayDate = String(holiday_date || '').trim();
    if (!holidayName || !holidayDate) return res.status(400).json({ error: 'Name and date are required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayDate) || Number.isNaN(new Date(`${holidayDate}T00:00:00+08:00`).getTime())) {
        return res.status(400).json({ error: 'Enter a valid holiday date.' });
    }
    const holidayType = ['0', '1', '2'].includes(String(is_national)) ? Number(is_national) : 1;
    const schoolId = normalizeOptionalSchoolId(school_id);
    let conn;
    try {
        let schoolName = '';
        if (schoolId) {
            const [[school]] = await db.query('SELECT id, name FROM schools WHERE id = ? LIMIT 1', [schoolId]);
            if (!school) return res.status(400).json({ error: 'Selected school was not found.' });
            schoolName = school.name || '';
        }
        const [[duplicate]] = await db.query(
            `SELECT id FROM holidays
             WHERE holiday_date = ?
               AND ((? IS NULL AND school_id IS NULL) OR school_id = ?)
             LIMIT 1`,
            [holidayDate, schoolId, schoolId]
        );
        if (duplicate) return res.status(409).json({ error: 'Holiday already exists for that date and scope.' });
        conn = await db.getConnection();
        await conn.beginTransaction();
        const [holidayResult] = await conn.query(
            'INSERT INTO holidays (holiday_date, name, school_id, is_national) VALUES (?, ?, ?, ?)',
            [holidayDate, holidayName, schoolId, holidayType]
        );
        const typeLabel = holidayTypeLabel(holidayType);
        const scopeLabel = schoolName || 'all schools in the division';
        const notificationTitle = `${typeLabel}: ${holidayName}`;
        const notificationMessage = `No classes on ${holidayDisplayDate(holidayDate)} in observance of ${holidayName}. Attendance scanning is disabled for ${scopeLabel}.`;
        const user = req.session.user;
        const [notificationResult] = await conn.query(
            `INSERT INTO notifications
                (title, message, type, school_id, target_audience, created_by, created_by_name, created_by_role)
             VALUES (?, ?, 'announcement_holiday', ?, 'school', ?, ?, ?)`,
            [
                notificationTitle,
                notificationMessage,
                schoolId,
                user.id || null,
                user.fullname || user.username || 'EduTrack Admin',
                user.role || 'super_admin'
            ]
        );
        await conn.query('UPDATE holidays SET notification_id = ? WHERE id = ?', [notificationResult.insertId, holidayResult.insertId]);
        await conn.commit();
        conn.release();
        conn = null;

        const [parentDelivery, userDelivery, scannerRefreshCount] = await Promise.all([
            fanOutAnnouncement(notificationResult.insertId).catch(error => {
                console.error('Holiday Guardian delivery error:', error.message);
                return { parentCount: 0, pushSuccessCount: 0, pushFailureCount: 0, registeredDeviceCount: 0 };
            }),
            sendPushToUsers({ schoolId }, {
                holidayId: holidayResult.insertId,
                holidayDate,
                type: 'announcement_holiday',
                title: notificationTitle,
                message: notificationMessage
            }).catch(error => {
                console.error('Holiday EduTrack FCM send error:', error.message);
                return { successCount: 0, failureCount: 0, registeredDeviceCount: 0 };
            }),
            queueCalendarRefreshSafely({
                schoolId,
                requestedBy: user,
                reason: `${typeLabel}: ${holidayName}`
            })
        ]);
        return res.json({
            success: true,
            id: holidayResult.insertId,
            notification_id: notificationResult.insertId,
            parent_inbox_count: parentDelivery.parentCount,
            guardian_push_count: parentDelivery.pushSuccessCount,
            guardian_device_count: parentDelivery.registeredDeviceCount,
            edutrack_push_count: userDelivery.successCount,
            edutrack_device_count: userDelivery.registeredDeviceCount,
            scanner_refresh_count: scannerRefreshCount
        });
    } catch (err) {
        if (conn) {
            try { await conn.rollback(); } catch (_) {}
            conn.release();
        }
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Holiday already exists for that date.' });
        console.error('Add holiday error:', err);
        return res.status(500).json({ error: 'Failed to add holiday.' });
    }
});

router.delete('/holidays/:id', requireRole('super_admin'), async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        await conn.beginTransaction();
        const [[holiday]] = await conn.query('SELECT id, notification_id, school_id, holiday_date, name, is_national FROM holidays WHERE id = ? LIMIT 1', [req.params.id]);
        if (!holiday) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({ error: 'Holiday was not found.' });
        }
        if (holiday.notification_id) {
            await conn.query('DELETE FROM parent_notifications WHERE source_notification_id = ?', [holiday.notification_id]);
            await conn.query('DELETE FROM notifications WHERE id = ?', [holiday.notification_id]);
        }
        await conn.query('DELETE FROM holidays WHERE id = ?', [holiday.id]);
        await conn.commit();
        conn.release();
        conn = null;
        const scannerRefreshCount = await queueCalendarRefreshSafely({
            schoolId: holiday.school_id,
            requestedBy: req.session.user,
            reason: `Removed ${holidayTypeLabel(holiday.is_national)}: ${holiday.name || holiday.holiday_date}`
        });
        return res.json({ success: true, scanner_refresh_count: scannerRefreshCount });
    } catch (err) {
        if (conn) {
            try { await conn.rollback(); } catch (_) {}
            conn.release();
        }
        console.error('Delete holiday error:', err);
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
        const scannerRefreshCount = await queueCalendarRefreshSafely({
            requestedBy: req.session.user,
            reason: `${is_school_day === false || String(is_school_day) === '0' ? 'Non-school day posted' : 'School day restored'}: ${date}${reason ? ` - ${reason}` : ''}`
        });
        return res.json({ success: true, scanner_refresh_count: scannerRefreshCount });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to save school day.' });
    }
});

router.delete('/school-days/:id', requireRole('super_admin'), async (req, res) => {
    try {
        const [[schoolDay]] = await db.query('SELECT id, date, reason, is_school_day FROM school_days WHERE id = ? LIMIT 1', [req.params.id]);
        await db.query('DELETE FROM school_days WHERE id = ?', [req.params.id]);
        const scannerRefreshCount = schoolDay ? await queueCalendarRefreshSafely({
            requestedBy: req.session.user,
            reason: `Removed school-day override: ${schoolDay.date}${schoolDay.reason ? ` - ${schoolDay.reason}` : ''}`
        }) : 0;
        return res.json({ success: true, scanner_refresh_count: scannerRefreshCount });
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
        let query = `SELECT a.id, a.date, a.person_type, a.time_in, a.time_out, a.status, a.monitoring_status,
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
        const records = await Promise.all(rows.map(async row => {
            const rowDate = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
            const resolved = row.time_in
                ? await resolveAttendanceStatusFromEvents(row.person_type, rowDate, row.id, row.time_in)
                : null;
            return {
                ...row,
                attendance_status: resolved ? (resolved.label || statusLabel(resolved.status)) : statusLabel(row.status),
                half_day_type: resolved && resolved.halfDayType || null,
                remarks: resolved && resolved.remarks || '',
                monitoring_status: row.monitoring_status || (row.person_type === 'student'
                    ? (row.time_in ? 'Inside School' : 'No Time In')
                    : (row.time_in && !row.time_out ? 'Pending Time Out' : (row.time_out ? 'Complete' : 'No Time In')))
            };
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

        const absenceCountingActive = await shouldCountComputedAbsences(date, schoolId);
        const [
            eligibleStudentsBySchool,
            eligibleTeachersBySchool,
            studentStatusBySchool,
            teacherStatusBySchool,
            absentStudentsBySchool,
            absentTeachersBySchool,
            schoolAbsenceDecisions
        ] = await Promise.all([
            getEligibleCountsBySchool('student', date, schoolId),
            getEligibleCountsBySchool('teacher', date, schoolId),
            getAttendanceStatusCountsBySchool('student', date, schoolId),
            getAttendanceStatusCountsBySchool('teacher', date, schoolId),
            absenceCountingActive ? getAbsentCountsBySchool('student', date, schoolId) : Promise.resolve(new Map()),
            absenceCountingActive ? getAbsentCountsBySchool('teacher', date, schoolId) : Promise.resolve(new Map()),
            absenceCountingActive
                ? Promise.all(rows.map(async school => [String(school.id), await shouldCountComputedAbsences(date, school.id)]))
                : Promise.resolve([])
        ]);
        const absenceActiveBySchool = new Map(schoolAbsenceDecisions);
        const emptyStatus = { present: 0, late: 0, half_day: 0, full_day: 0, timed_in: 0, timed_out: 0 };

        const schools = rows.map(s => {
            const key = String(s.id);
            const studentCounts = studentStatusBySchool.get(key) || emptyStatus;
            const teacherCounts = teacherStatusBySchool.get(key) || emptyStatus;
            const eligible = Math.max(eligibleStudentsBySchool.get(key) || 0, studentCounts.timed_in || 0);
            const eligibleTeachers = Math.max(eligibleTeachersBySchool.get(key) || 0, teacherCounts.timed_in || 0);
            const countAbsences = absenceActiveBySchool.get(key) === true;
            return {
                id: s.id,
                name: s.name,
                logo: schoolLogoUrl(s.id, s.logo),
                enrolled: eligible,
                present: studentCounts.present,
                late: studentCounts.late,
                half_day: studentCounts.half_day,
                full_day: studentCounts.full_day,
                absent: countAbsences ? (absentStudentsBySchool.get(key) || 0) : 0,
                rate: eligible > 0 ? Math.min(100, Math.round((studentCounts.full_day / eligible) * 100)) : 0,
                teachers_present: teacherCounts.present,
                teachers_late: teacherCounts.late,
                teachers_half_day: teacherCounts.half_day,
                teachers_full_day: teacherCounts.full_day,
                teachers_total: s.teachers_total || 0,
                attendance_eligible_teachers: eligibleTeachers,
                teachers_absent: countAbsences ? (absentTeachersBySchool.get(key) || 0) : 0
            };
        });

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
        const schoolDay = await checkOperationalSchoolDay(targetDate, schoolId);
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
                MAX(a.id) as attendance_id,
                MAX(a.status) as att_status,
                MAX(a.time_in) as time_in,
                MAX(a.time_out) as time_out,
                MAX(a.last_time_in) as last_time_in,
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
        const presentStudents = await Promise.all(presentRows.map(async row => {
            const lateHalf = isLateHalfDay(row.att_status, row.time_in, pmLateTime);
            const resolved = row.attendance_id
                ? await resolveAttendanceStatusFromEvents('student', targetDate, row.attendance_id, row.time_in)
                : null;
            return {
                ...row,
                name: `${row.firstname || ''} ${row.lastname || ''}`.trim() || 'Student',
                late_half_day: !!(resolved && resolved.lateHalfDay) || lateHalf,
                attendance_status: (resolved && resolved.label) || row.attendance_status || 'Present',
                half_day_type: resolved && resolved.halfDayType || null,
                remarks: resolved && resolved.remarks || '',
                monitoring_status: row.monitoring_status || 'Inside School',
                attendance_date: targetDate,
                absent_days: 0,
                absent_from_date: null
            };
        }));
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
        const presentOnlyCount = presentStudents.filter(s => statusKey(s.att_status || s.attendance_status) === 'present').length;
        const lateCount = presentStudents.filter(s => statusKey(s.att_status || s.attendance_status) === 'late').length;
        const halfDayCount = presentStudents.filter(s => statusKey(s.att_status || s.attendance_status) === 'half_day').length;

        return res.json({
            date: targetDate,
            is_school_day: schoolDay.isSchoolDay,
            absence_counting_active: canCountAbsences,
            non_school_day_reason: schoolDay.reason,
            totals: {
                students_total: totalRow.cnt,
                present: presentOnlyCount,
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
        const schoolDay = await checkOperationalSchoolDay(today, schoolId);
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
        const schoolDay = await checkOperationalSchoolDay(date, schoolId);
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
        const user = req.session.user;
        const schoolId = applySchoolFilter(req);
        let query = `SELECT n.*, s.name as school_name, gl.name as grade_name, sec.name as section_name
            FROM notifications n
            LEFT JOIN schools s ON n.school_id = s.id
            LEFT JOIN grade_levels gl ON n.grade_level_id = gl.id
            LEFT JOIN sections sec ON n.section_id = sec.id
            WHERE 1=1`;
        const params = [];
        if (schoolId) { query += ' AND n.school_id = ?'; params.push(schoolId); }
        if (user.role === 'adviser') {
            const [[teacher]] = await db.query(
                `SELECT COALESCE(sec.school_id, t.school_id) AS school_id,
                        COALESCE(sec.grade_level_id, t.grade_level_id) AS grade_level_id,
                        t.section_id
                 FROM teachers t
                 LEFT JOIN sections sec ON sec.id = t.section_id
                 WHERE t.id = ?
                 LIMIT 1`,
                [user.teacher_id || 0]
            );
            if (!teacher) return res.json([]);
            query += ' AND (n.section_id = ? OR (n.school_id = ? AND n.section_id IS NULL AND n.grade_level_id IS NULL AND n.student_id IS NULL))';
            params.push(teacher.section_id || -1, teacher.school_id || -1);
        }
        query += ' ORDER BY n.created_at DESC LIMIT 200';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        console.error('Get notifications error:', err);
        return res.status(500).json({ error: 'Failed to load notifications.' });
    }
});

// Targeting scope for the announcement composer — locks the form to what the
// current role may actually send to (principal: own school; adviser: own section).
router.get('/notifications/scope', requireRole('super_admin', 'principal', 'adviser'), async (req, res) => {
    try {
        const user = req.session.user;
        const scope = { role: user.role, lock_school: false, lock_section: false, school: null, grade: null, section: null };
        if (user.role === 'principal') {
            if (user.school_id) {
                const [[sc]] = await db.query('SELECT id, name FROM schools WHERE id = ? LIMIT 1', [user.school_id]);
                scope.school = sc || { id: user.school_id, name: 'My School' };
                scope.lock_school = true;
            }
        } else if (user.role === 'adviser') {
            const [[teacher]] = await db.query(
                `SELECT COALESCE(sec.school_id, t.school_id) AS school_id,
                        COALESCE(sec.grade_level_id, t.grade_level_id) AS grade_level_id,
                        t.section_id,
                        sc.name AS school_name, gl.name AS grade_name, sec.name AS section_name
                 FROM teachers t
                 LEFT JOIN sections sec ON t.section_id = sec.id
                 LEFT JOIN schools sc ON sc.id = COALESCE(sec.school_id, t.school_id)
                 LEFT JOIN grade_levels gl ON gl.id = COALESCE(sec.grade_level_id, t.grade_level_id)
                 WHERE t.id = ?
                 LIMIT 1`,
                [user.teacher_id || 0]
            );
            if (teacher && teacher.school_id && teacher.section_id) {
                scope.school = { id: teacher.school_id, name: teacher.school_name || 'My School' };
                scope.grade = teacher.grade_level_id ? { id: teacher.grade_level_id, name: teacher.grade_name || '' } : null;
                scope.section = { id: teacher.section_id, name: teacher.section_name || 'My Section' };
                scope.lock_school = true;
                scope.lock_section = true;
            }
        }
        return res.json(scope);
    } catch (err) {
        console.error('Notification scope error:', err);
        return res.status(500).json({ error: 'Failed to load notification scope.' });
    }
});

// Parent contact directory — guardian name + number linked to each child, scoped
// to the caller (adviser: own section, principal: own school). Lets advisers and
// principals reach a child's parent. Stays in sync with the app's profile editor.
router.get('/parent-contacts', requireRole('super_admin', 'principal', 'adviser'), async (req, res) => {
    try {
        const user = req.session.user;
        let where = `s.status != 'deleted' AND s.guardian_contact IS NOT NULL AND s.guardian_contact != ''`;
        const params = [];
        if (user.role === 'adviser') {
            const [[teacher]] = await db.query('SELECT section_id FROM teachers WHERE id = ? LIMIT 1', [user.teacher_id || 0]);
            if (!teacher || !teacher.section_id) return res.json([]);
            where += ' AND s.section_id = ?';
            params.push(teacher.section_id);
        } else if (user.role === 'principal') {
            if (!user.school_id) return res.json([]);
            where += ' AND s.school_id = ?';
            params.push(user.school_id);
        } else {
            const schoolId = applySchoolFilter(req);
            if (schoolId) { where += ' AND s.school_id = ?'; params.push(schoolId); }
        }
        const [rows] = await db.query(
            `SELECT s.id AS student_id, s.firstname, s.lastname, s.middlename,
                    s.guardian_name, s.guardian_contact,
                    gl.name AS grade_name, sec.name AS section_name, sc.name AS school_name
             FROM students s
             LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
             LEFT JOIN sections sec ON s.section_id = sec.id
             LEFT JOIN schools sc ON s.school_id = sc.id
             WHERE ${where}
             ORDER BY s.lastname, s.firstname
             LIMIT 1000`,
            params
        );
        const contacts = rows.map(r => ({
            student_id: r.student_id,
            student_name: [r.lastname, r.firstname].filter(Boolean).join(', ') + (r.middlename ? ` ${r.middlename.charAt(0)}.` : ''),
            grade_name: r.grade_name || '',
            section_name: r.section_name || '',
            school_name: r.school_name || '',
            guardian_name: r.guardian_name || '',
            guardian_contact: r.guardian_contact || ''
        }));
        return res.json(contacts);
    } catch (err) {
        console.error('Parent contacts error:', err);
        return res.status(500).json({ error: 'Failed to load parent contacts.' });
    }
});

router.post('/notifications', requireRole('super_admin', 'principal', 'adviser'), async (req, res) => {
    const {
        title,
        message,
        type,
        school_id,
        grade_level_id,
        section_id,
        student_id,
        target_audience,
        attachment_url
    } = req.body;
    if (!title || !message) {
        return res.status(400).json({ error: 'Title and message are required.' });
    }
    try {
        const user = req.session.user;
        let finalSchoolId = normalizeOptionalSchoolId(school_id);
        let finalGradeId = normalizeOptionalSchoolId(grade_level_id);
        let finalSectionId = normalizeOptionalSchoolId(section_id);
        let finalStudentId = normalizeOptionalSchoolId(student_id);
        const normalizedType = normalizeAnnouncementType(type);
        const audience = String(target_audience || '').trim() || (finalStudentId ? 'student' : finalSectionId ? 'section' : finalGradeId ? 'grade' : 'school');

        if (user.role === 'principal') {
            if (!user.school_id) return res.status(403).json({ error: 'No school is assigned to your account.' });
            finalSchoolId = user.school_id;
        }

        if (user.role === 'adviser') {
            const [[teacher]] = await db.query(
                `SELECT COALESCE(sec.school_id, t.school_id) AS school_id,
                        COALESCE(sec.grade_level_id, t.grade_level_id) AS grade_level_id,
                        t.section_id,
                        TRIM(CONCAT_WS(' ', t.firstname, t.middlename, t.lastname)) AS adviser_name
                 FROM teachers t
                 LEFT JOIN sections sec ON sec.id = t.section_id
                 WHERE t.id = ?
                 LIMIT 1`,
                [user.teacher_id || 0]
            );
            if (!teacher || !teacher.school_id || !teacher.section_id) {
                return res.status(403).json({ error: 'Your adviser account is not linked to a school section.' });
            }
            finalSchoolId = teacher.school_id;
            finalGradeId = teacher.grade_level_id || finalGradeId || null;
            finalSectionId = teacher.section_id;
            if (finalStudentId) {
                const [[student]] = await db.query(
                    'SELECT id FROM students WHERE id = ? AND section_id = ? AND school_id = ? AND status != ? LIMIT 1',
                    [finalStudentId, teacher.section_id, teacher.school_id, 'deleted']
                );
                if (!student) return res.status(403).json({ error: 'You can only send student-specific notices to students in your advisory section.' });
            }
        }

        if (finalSectionId) {
            const [[section]] = await db.query('SELECT school_id, grade_level_id FROM sections WHERE id = ? LIMIT 1', [finalSectionId]);
            if (!section) return res.status(400).json({ error: 'Selected section was not found.' });
            if (finalSchoolId && Number(section.school_id) !== Number(finalSchoolId)) {
                return res.status(403).json({ error: 'Selected section is outside your school scope.' });
            }
            finalSchoolId = finalSchoolId || section.school_id;
            finalGradeId = finalGradeId || section.grade_level_id || null;
        }

        if (finalGradeId) {
            const [[grade]] = await db.query('SELECT school_id FROM grade_levels WHERE id = ? LIMIT 1', [finalGradeId]);
            if (!grade) return res.status(400).json({ error: 'Selected grade level was not found.' });
            if (finalSchoolId && grade.school_id && Number(grade.school_id) !== Number(finalSchoolId)) {
                return res.status(403).json({ error: 'Selected grade level is outside your school scope.' });
            }
            finalSchoolId = finalSchoolId || grade.school_id || null;
        }

        if (finalStudentId) {
            const [[student]] = await db.query('SELECT school_id, grade_level_id, section_id FROM students WHERE id = ? AND status != ? LIMIT 1', [finalStudentId, 'deleted']);
            if (!student) return res.status(400).json({ error: 'Selected student was not found.' });
            if (finalSchoolId && Number(student.school_id) !== Number(finalSchoolId)) {
                return res.status(403).json({ error: 'Selected student is outside your school scope.' });
            }
            if (finalSectionId && Number(student.section_id) !== Number(finalSectionId)) {
                return res.status(403).json({ error: 'Selected student is outside the selected section.' });
            }
            finalSchoolId = finalSchoolId || student.school_id;
            finalGradeId = finalGradeId || student.grade_level_id || null;
            finalSectionId = finalSectionId || student.section_id || null;
        }

        const [result] = await db.query(
            `INSERT INTO notifications
                (title, message, type, school_id, grade_level_id, section_id, student_id,
                 target_audience, attachment_url, created_by, created_by_name, created_by_role)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                title,
                message,
                normalizedType,
                finalSchoolId || null,
                finalGradeId || null,
                finalSectionId || null,
                finalStudentId || null,
                audience,
                attachment_url || null,
                user.id || null,
                user.fullname || user.username || null,
                user.role || null
            ]
        );
        const delivery = await fanOutAnnouncement(result.insertId);
        return res.json({
            success: true,
            id: result.insertId,
            sent_to_parents: delivery.parentCount,
            push_success_count: delivery.pushSuccessCount,
            push_failure_count: delivery.pushFailureCount,
            registered_device_count: delivery.registeredDeviceCount
        });
    } catch (err) {
        console.error('Create notification error:', err);
        return res.status(500).json({ error: 'Failed to create notification.' });
    }
});

// Returns { row } if the user may manage this announcement, else { error: 403|404 }.
async function loadManageableAnnouncement(id, user) {
    const [[row]] = await db.query('SELECT id, school_id, created_by FROM notifications WHERE id = ? LIMIT 1', [id]);
    if (!row) return { error: 404 };
    if (user.role === 'super_admin') return { row };
    if (user.role === 'principal') {
        return (user.school_id && Number(row.school_id) === Number(user.school_id)) ? { row } : { error: 403 };
    }
    if (user.role === 'adviser') {
        return (Number(row.created_by) === Number(user.id)) ? { row } : { error: 403 };
    }
    return { error: 403 };
}

router.delete('/notifications/:id', requireRole('super_admin', 'principal', 'adviser'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ error: 'Invalid announcement id.' });
        const check = await loadManageableAnnouncement(id, req.session.user);
        if (check.error === 404) return res.status(404).json({ error: 'Announcement not found.' });
        if (check.error === 403) return res.status(403).json({ error: 'You can only delete your own announcements.' });
        // Remove the delivered parent copies first, then the announcement itself.
        await db.query('DELETE FROM parent_notifications WHERE source_notification_id = ?', [id]);
        await db.query('DELETE FROM notifications WHERE id = ?', [id]);
        return res.json({ success: true });
    } catch (err) {
        console.error('Delete notification error:', err);
        return res.status(500).json({ error: 'Failed to delete announcement.' });
    }
});

// Edit an announcement's title/message/type. Re-fans-out so the copies already
// delivered to parents are updated in place (same source key).
router.put('/notifications/:id', requireRole('super_admin', 'principal', 'adviser'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ error: 'Invalid announcement id.' });
        const title = String(req.body.title || '').trim();
        const message = String(req.body.message || '').trim();
        if (!title || !message) return res.status(400).json({ error: 'Title and message are required.' });
        const check = await loadManageableAnnouncement(id, req.session.user);
        if (check.error === 404) return res.status(404).json({ error: 'Announcement not found.' });
        if (check.error === 403) return res.status(403).json({ error: 'You can only edit your own announcements.' });
        const normalizedType = normalizeAnnouncementType(req.body.type);
        await db.query(
            'UPDATE notifications SET title = ?, message = ?, type = ? WHERE id = ?',
            [title, message, normalizedType, id]
        );
        const delivery = await fanOutAnnouncement(id);
        return res.json({
            success: true,
            sent_to_parents: delivery.parentCount,
            push_success_count: delivery.pushSuccessCount,
            push_failure_count: delivery.pushFailureCount,
            registered_device_count: delivery.registeredDeviceCount
        });
    } catch (err) {
        console.error('Update notification error:', err);
        return res.status(500).json({ error: 'Failed to update announcement.' });
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
        const [
            [totalStudents],
            studentCounts,
            absentStudents,
            [totalTeachers],
            teacherCounts,
            absentTeachers
        ] = await Promise.all([
            db.query("SELECT COUNT(*) as cnt FROM students WHERE school_id = ? AND status = 'active' AND COALESCE(active_from, DATE(created_at)) < ?", [schoolId, today]),
            getAttendanceStatusCounts('student', today, { schoolId }),
            countStudentsWithoutTimeIn(today, schoolId),
            db.query("SELECT COUNT(*) as cnt FROM teachers WHERE school_id = ? AND status = 'active'", [schoolId]),
            getAttendanceStatusCounts('teacher', today, { schoolId }),
            countTeachersWithoutTimeIn(today, schoolId)
        ]);

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
        const [[totalStudents], studentCounts, absentStudents] = await Promise.all([
            db.query("SELECT COUNT(*) as cnt FROM students WHERE section_id = ? AND status = 'active' AND COALESCE(active_from, DATE(created_at)) < ?", [sectionId, today]),
            getAttendanceStatusCounts('student', today, { sectionId }),
            countSectionStudentsWithoutTimeIn(today, sectionId)
        ]);

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
            `SELECT t.section_id,
                    COALESCE(sec.school_id, t.school_id) AS school_id,
                    COALESCE(sec.grade_level_id, t.grade_level_id) AS grade_level_id,
                    sec.name as section_name, gl.name as grade_name, sc.name as school_name, sc.logo as school_logo
             FROM teachers t
             LEFT JOIN sections sec ON t.section_id = sec.id
             LEFT JOIN grade_levels gl ON gl.id = COALESCE(sec.grade_level_id, t.grade_level_id)
             LEFT JOIN schools sc ON sc.id = COALESCE(sec.school_id, t.school_id)
             WHERE t.id = ?`, [user.teacher_id]
        );
        if (teacher.length === 0) return res.status(404).json({ error: 'Teacher not found' });
        teacher[0].school_logo = schoolLogoUrl(teacher[0].school_id, teacher[0].school_logo);
        const sectionId = teacher[0].section_id;
        if (!sectionId) return res.json({ teacher: teacher[0], students: [], kpi: { total: 0, present: 0, late: 0, half_day: 0, absent: 0 } });

        const [students] = await db.query(
            `SELECT s.id, s.lrn, s.firstname, s.lastname, s.middlename, s.gender, s.guardian_contact, s.category, s.status,
                    s.active_from, s.created_at,
                    a.id as attendance_id, a.time_in, a.time_out, a.last_time_in, a.status as att_status, a.monitoring_status
             FROM students s
             LEFT JOIN attendance a ON a.person_type = 'student' AND a.person_id = s.id AND a.date = ?
             WHERE s.section_id = ? AND s.status != 'deleted'
             ORDER BY s.lastname, s.firstname`, [date, sectionId]
        );

        const activeStudents = students.filter(s => s.status === 'active');
        const present = activeStudents.filter(s => s.att_status === 'present');
        const late = activeStudents.filter(s => s.att_status === 'late');
        const halfDay = activeStudents.filter(s => s.att_status === 'half_day');
        const absent = activeStudents.filter(s => !s.att_status);

        // 2-day consecutive absence flagging — delegate to the same function the mobile app uses
        const schoolId = teacher[0].school_id;
        const [pmLateTime, schedule, eventsByAttendance, studentLateThreshold, flaggedResult] = await Promise.all([
            getPmLateTime(),
            getAttendanceScheduleTimes(date),
            getAttendanceEventsByIds(students.map(s => s.attendance_id)),
            getAttendanceLateThreshold('student', date),
            getConsecutiveAbsenceFlags({
                baseDate: date,
                schoolId,
                sectionId,
                days: 2,
                includeTeachers: false
            })
        ]);
        const flaggedIds = flaggedResult.map(f => f.id);

        return res.json({
            teacher: teacher[0],
            students: students.map(s => {
                const resolved = s.attendance_id && s.time_in
                    ? resolveAttendanceStatusFromLoadedEvents({
                        firstTimeIn: s.time_in,
                        lateThreshold: studentLateThreshold,
                        schedule,
                        storedEvents: eventsByAttendance.get(s.attendance_id) || []
                    })
                    : null;
                const scanSummary = s.attendance_id
                    ? buildAttendanceScanSummary(
                        { id: s.attendance_id, person_type: 'student', time_in: s.time_in, time_out: s.time_out, status: s.att_status },
                        date,
                        schedule,
                        eventsByAttendance.get(s.attendance_id) || []
                    )
                    : { am_time_in: [], am_time_out: [], pm_time_in: [], pm_time_out: [], scan_statuses: [] };
                return {
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
                    late_half_day: !!(resolved && resolved.lateHalfDay) || isLateHalfDay(s.att_status, s.time_in, pmLateTime),
                    attendance_status: resolved ? (resolved.label || statusLabel(resolved.status)) : statusLabel(s.att_status),
                    half_day_type: resolved && resolved.halfDayType || null,
                    remarks: resolved && resolved.remarks || '',
                    scan_summary: scanSummary,
                    flagged: flaggedIds.includes(s.id)
                };
            }),
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

async function getAdviserParentScope(teacherId) {
    const [[teacher]] = await db.query(
        `SELECT t.id, t.section_id,
                COALESCE(sec.school_id, t.school_id) AS school_id,
                COALESCE(sec.grade_level_id, t.grade_level_id) AS grade_level_id,
                sec.name AS section_name,
                gl.name AS grade_name,
                sc.name AS school_name
         FROM teachers t
         LEFT JOIN sections sec ON sec.id = t.section_id
         LEFT JOIN grade_levels gl ON gl.id = COALESCE(sec.grade_level_id, t.grade_level_id)
         LEFT JOIN schools sc ON sc.id = COALESCE(sec.school_id, t.school_id)
         WHERE t.id = ?`,
        [teacherId]
    );
    const activeYear = await schoolYears.getActiveSchoolYear().catch(() => null);
    if (!teacher || !teacher.section_id || !activeYear) {
        return { teacher, activeYear, contacts: [], parents: [] };
    }
    const [students] = await db.query(
        `SELECT s.id, s.lrn, s.firstname, s.lastname, s.middlename, s.guardian_contact,
                e.school_id, e.grade_level_id, e.section_id,
                sc.name AS school_name, gl.name AS grade_name, sec.name AS section_name
         FROM student_enrollments e
         INNER JOIN students s ON s.id = e.student_id
         LEFT JOIN schools sc ON sc.id = e.school_id
         LEFT JOIN grade_levels gl ON gl.id = e.grade_level_id
         LEFT JOIN sections sec ON sec.id = e.section_id
         WHERE e.school_year_id = ?
           AND e.section_id = ?
           AND e.status = 'enrolled'
           AND s.status = 'active'
           AND s.guardian_contact IS NOT NULL
           AND s.guardian_contact != ''
         ORDER BY s.lastname, s.firstname`,
        [activeYear.id, teacher.section_id]
    );
    const childrenByContact = new Map();
    students.forEach(student => {
        const contact = normalizeContact(student.guardian_contact);
        if (!contact) return;
        if (!childrenByContact.has(contact)) childrenByContact.set(contact, []);
        childrenByContact.get(contact).push({
            id: student.id,
            lrn: student.lrn || '',
            name: [student.firstname, student.middlename ? `${String(student.middlename).charAt(0).toUpperCase()}.` : '', student.lastname]
                .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
            school_name: student.school_name || '',
            grade_name: student.grade_name || '',
            section_name: student.section_name || ''
        });
    });
    const contacts = Array.from(childrenByContact.keys());
    if (!contacts.length) return { teacher, activeYear, contacts, parents: [] };
    const [parents] = await db.query(
        `SELECT p.id, p.guardian_name, p.contact_number, p.normalized_contact, p.username,
                p.status, p.last_login,
                COALESCE((
                    SELECT MAX(COALESCE(pd.last_seen_at, pd.updated_at, pd.created_at))
                    FROM parent_devices pd
                    WHERE pd.parent_id = p.id
                ), p.last_login) AS last_seen_at,
                (
                    SELECT COUNT(*)
                    FROM parent_devices pd
                    WHERE pd.parent_id = p.id
                ) AS device_count,
                lpd.device_name AS latest_device_name,
                lpd.platform AS latest_device_platform,
                lpd.app_version AS latest_device_app_version,
                lpd.user_agent AS latest_device_user_agent
         FROM parents p
         LEFT JOIN parent_devices lpd ON lpd.id = (
            SELECT pd2.id
            FROM parent_devices pd2
            WHERE pd2.parent_id = p.id
            ORDER BY COALESCE(pd2.last_seen_at, pd2.updated_at, pd2.created_at) DESC, pd2.id DESC
            LIMIT 1
         )
         WHERE p.normalized_contact IN (?)
         ORDER BY p.guardian_name`,
        [contacts]
    );
    return {
        teacher,
        activeYear,
        contacts,
        parents: attachParentDeviceLabels(parents).map(parent => ({
            ...parent,
            children: childrenByContact.get(parent.normalized_contact) || []
        }))
    };
}

// ---- Adviser Parent Registry (registered Guardian app accounts in my active section) ----
router.get('/adviser-parents', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'adviser' || !user.teacher_id) {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const scope = await getAdviserParentScope(user.teacher_id);
        return res.json({
            teacher: scope.teacher,
            active_year: scope.activeYear,
            parents: scope.parents
        });
    } catch (err) {
        console.error('Adviser parents error:', err);
        return res.status(500).json({ error: 'Failed to load registered parents.' });
    }
});

router.post('/adviser-parents/:id/password', requireAuth, express.json(), async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'adviser' || !user.teacher_id) {
        return res.status(403).json({ error: 'Access denied' });
    }
    const parentId = parseInt(req.params.id, 10);
    const password = String(req.body.password || '');
    if (!Number.isInteger(parentId) || parentId <= 0) return res.status(400).json({ error: 'Invalid parent account.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    try {
        const scope = await getAdviserParentScope(user.teacher_id);
        const [[parent]] = await db.query('SELECT id, normalized_contact FROM parents WHERE id = ? LIMIT 1', [parentId]);
        if (!parent || !scope.contacts.includes(parent.normalized_contact)) {
            return res.status(403).json({ error: 'This parent is not linked to your active section.' });
        }
        const hash = await bcrypt.hash(password, 10);
        await db.query('UPDATE parents SET password = ? WHERE id = ?', [hash, parentId]);
        return res.json({ success: true });
    } catch (err) {
        console.error('Adviser parent password reset error:', err);
        return res.status(500).json({ error: 'Failed to change parent password.' });
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
            const logoPath = await optimizedLogoToDataUrl(req.file);
            await db.query('UPDATE schools SET logo = ? WHERE id = ?', [logoPath, req.params.id]);
            invalidateLiveDashboardCaches();
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
        invalidateLiveDashboardCaches();
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

        // Full-day attendance counts per day. Half-day is tracked separately,
        // not mislabeled as full-day present.
        let pQuery = `SELECT DATE(a.date) as day, COUNT(DISTINCT a.person_id) as present
                      FROM attendance a
                      INNER JOIN students s ON a.person_id = s.id AND s.status = 'active'
                      WHERE a.person_type = 'student' AND a.date BETWEEN ? AND ? AND a.status IN ('present','late')`;
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
