const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const QRCode = require('qrcode');
const { Readable } = require('stream');
const crypto = require('crypto');
const router = express.Router();
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getScannerKioskToken } = require('../utils/scannerKiosk');
const { todayDate, currentMonth, nowDateTime, normalizeTime, sqlDateTime, compareDateTime } = require('../utils/appTime');
const schoolYears = require('../utils/schoolYear');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function schoolLogoUrl(schoolId, logo) {
    if (!schoolId || !logo) return '';
    const version = crypto.createHash('md5').update(String(logo)).digest('hex').slice(0, 12);
    return `/api/schools/${schoolId}/logo-image?v=${version}`;
}

// Scanner kiosk is intentionally available without a dashboard login for guard stations and autostart desktops.
router.get('/scanner', async (req, res) => {
    res.render('scanner', {
        title: 'QR Scanner',
        page: 'scanner',
        kioskMode: true,
        scannerKioskToken: getScannerKioskToken()
    });
});

// All admin routes require authentication
router.use(requireAuth);
router.use((req, res, next) => {
    if (req.session.user && req.session.user.role === 'parent') {
        return res.redirect('/parent/app');
    }
    return next();
});

// Helper: get correct dashboard URL for a role
function getDashboardUrl(role) {
    switch (role) {
        case 'parent': return '/parent/app';
        case 'superintendent': return '/admin/sds-dashboard';
        case 'asst_superintendent': return '/admin/asds-dashboard';
        case 'principal': return '/admin/principal-dashboard';
        case 'adviser': return '/admin/adviser-dashboard';
        default: return '/admin/dashboard';
    }
}

function normalizeSchoolKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizeSchoolMeaningKey(value) {
    const stopWords = new Set([
        'school', 'elementary', 'primary', 'integrated', 'national',
        'high', 'city', 'district', 'division', 'department', 'of', 'the',
        'ng', 'si', 'es', 'nhs'
    ]);
    return normalizeSchoolKey(value)
        .split(' ')
        .filter(token => token && !stopWords.has(token))
        .join(' ');
}

function detectSchoolLevel(value) {
    const key = ` ${normalizeSchoolKey(value)} `;
    if (!key.trim()) return '';
    if (/\bintegrated\b/.test(key)) return 'integrated';
    const isHighSchool = /\bnational high school\b|\bhigh school\b|\bjunior high\b|\bsenior high\b|\bfarm school\b|\bnhs\b/.test(key);
    const isElementary = /\belementary\b|\bprimary\b|\bes\b/.test(key);
    if (isHighSchool && !isElementary) return 'high';
    if (isElementary && !isHighSchool) return 'elementary';
    return '';
}

function schoolLevelCompatible(targetLevel, schoolLevel) {
    if (!targetLevel || !schoolLevel) return true;
    if (targetLevel === 'integrated' || schoolLevel === 'integrated') return true;
    return targetLevel === schoolLevel;
}

function normalizeLookupKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizeGradeKey(value) {
    const raw = normalizeLookupKey(value);
    const numberMatch = raw.match(/\d+/);
    return numberMatch ? `grade ${parseInt(numberMatch[0], 10)}` : raw;
}

function parseGradeNumber(value) {
    const match = normalizeGradeKey(value).match(/\bgrade\s+(\d+)\b/);
    return match ? parseInt(match[1], 10) : NaN;
}

function deriveTrackFromSection(sectionName) {
    const match = String(sectionName || '').trim().match(/^(STEM|ABM|HUMSS|GAS|TVL(?:-[A-Z]+)?|Sports|Arts(?:\s+and\s+| & )Design)\s*-\s*/i);
    if (!match) return '';
    const track = match[1].replace(/\s*&\s*/g, ' and ');
    if (/^arts/i.test(track)) return 'Arts and Design';
    if (/^sports$/i.test(track)) return 'Sports';
    if (/^tvl/i.test(track)) return 'TVL';
    return track.toUpperCase();
}

function formatGradeLabel(value) {
    const key = normalizeGradeKey(value);
    const numberMatch = key.match(/^grade\s+(\d+)$/);
    if (numberMatch) return `Grade ${parseInt(numberMatch[1], 10)}`;
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function validateGradeForImportCategory(gradeStr, category) {
    if (!gradeStr) return null;
    const gradeNumber = parseGradeNumber(gradeStr);
    if (!Number.isFinite(gradeNumber)) return null;
    const label = formatGradeLabel(gradeStr);
    if (category === 'shs_student' || category === 'shs_teacher') {
        if (gradeNumber < 11 || gradeNumber > 12) {
            return `${label} is not valid for SHS import. Use the SHS template with Grades 11-12 only.`;
        }
    }
    if (category === 'student' || category === 'teacher') {
        if (gradeNumber < 1 || gradeNumber > 10) {
            return `${label} is not valid for this import. Use Grades 1-10 here, or use the SHS template for Grades 11-12.`;
        }
    }
    return null;
}

function normalizePersonName(value) {
    return normalizeLookupKey(value).replace(/\b(ma|maria|mr|mrs|ms|dr)\b/g, '').replace(/\s+/g, ' ').trim();
}

function fullName(firstname, lastname, middlename) {
    return [firstname, middlename, lastname].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function displayName(firstname, lastname, middlename) {
    return [firstname, middlename ? middlename.charAt(0) + '.' : '', lastname].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// Normalize Sex/Gender values from import files to the students.gender enum.
function parseSexValue(raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v) return null;
    if (v === 'm' || v.startsWith('mal')) return 'Male';
    if (v === 'f' || v.startsWith('fem')) return 'Female';
    if (v.startsWith('o')) return 'Other';
    return null;
}

function parseImportName(nameStr) {
    const raw = String(nameStr || '').trim();
    if (!raw) return { firstname: '', lastname: '', middlename: '' };
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
        return { lastname: parts[0], firstname: parts[1], middlename: parts[2] || '' };
    }
    const words = raw.split(/\s+/);
    if (words.length === 1) return { firstname: words[0], lastname: '', middlename: '' };
    if (words.length === 2) return { firstname: words[0], lastname: words[1], middlename: '' };
    return { firstname: words[0], lastname: words[words.length - 1], middlename: words.slice(1, -1).join(' ') };
}

function getRowValue(row, keys) {
    for (const key of keys) {
        if (row[key] != null && String(row[key]).trim() !== '') return String(row[key]).trim();
    }
    const simplifyHeader = (value) => normalizeLookupKey(
        String(value || '')
            .replace(/\([^)]*\)/g, ' ')
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/\{[^}]*\}/g, ' ')
    );

    const rowKeys = Object.keys(row).map(rawKey => ({
        rawKey,
        norm: normalizeLookupKey(rawKey),
        simple: simplifyHeader(rawKey)
    }));

    const candidates = [];
    for (const key of keys) {
        const norm = normalizeLookupKey(key);
        const simple = simplifyHeader(key);
        if (norm) candidates.push(norm);
        if (simple && simple !== norm) candidates.push(simple);
    }

    const uniqueCandidates = [...new Set(candidates)];

    // Exact normalized / simplified match.
    for (const candidate of uniqueCandidates) {
        const matched = rowKeys.find(item => item.norm === candidate || item.simple === candidate);
        if (matched && row[matched.rawKey] != null && String(row[matched.rawKey]).trim() !== '') {
            return String(row[matched.rawKey]).trim();
        }
    }

    // Partial fallback for headers with helper text attached to the field name.
    for (const candidate of uniqueCandidates) {
        const matched = rowKeys.find(item =>
            item.norm.startsWith(candidate + ' ')
            || item.simple.startsWith(candidate + ' ')
            || item.norm.includes(' ' + candidate + ' ')
            || item.simple.includes(' ' + candidate + ' ')
        );
        if (matched && row[matched.rawKey] != null && String(row[matched.rawKey]).trim() !== '') {
            return String(row[matched.rawKey]).trim();
        }
    }

    return '';
}

function parseExcelCellValue(cell) {
    const raw = cell ? cell.value : null;
    if (raw == null) return '';
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
        return String(raw).trim();
    }
    if (raw instanceof Date) {
        return raw.toISOString().slice(0, 10);
    }
    if (typeof raw === 'object') {
        if (Array.isArray(raw.richText)) {
            return raw.richText.map(item => item.text || '').join('').trim();
        }
        if (raw.text != null && String(raw.text).trim() !== '') {
            return String(raw.text).trim();
        }
        if (raw.result != null && String(raw.result).trim() !== '') {
            return String(raw.result).trim();
        }
        if (raw.hyperlink != null && String(raw.hyperlink).trim() !== '') {
            // If the cell stores a hyperlink object, keep readable text first, then URL.
            const display = raw.text != null ? String(raw.text).trim() : '';
            return display || String(raw.hyperlink).trim();
        }
    }
    return String(raw).trim();
}

function findSchoolMatch(schools, input) {
    const target = normalizeSchoolKey(input);
    if (!target) return null;
    const targetMeaning = normalizeSchoolMeaningKey(input);
    const targetTokens = targetMeaning.split(' ').filter(Boolean);
    const targetLevel = detectSchoolLevel(input);
    const schoolList = Array.isArray(schools) ? schools : [];
    const levelCandidates = targetLevel
        ? schoolList.filter(school => schoolLevelCompatible(targetLevel, detectSchoolLevel(school.name)))
        : schoolList;

    for (const school of schoolList) {
        const keys = [school.name, school.school_id_code, school.school_code];
        for (const rawKey of keys) {
            const key = normalizeSchoolKey(rawKey);
            if (key && key === target) return school;
        }
    }

    if (targetMeaning) {
        const meaningMatches = levelCandidates.filter(school =>
            normalizeSchoolMeaningKey(school.name) === targetMeaning
        );
        if (meaningMatches.length === 1) return meaningMatches[0];
    }

    const partialMatches = [];
    for (const school of levelCandidates) {
        const key = normalizeSchoolKey(school.name);
        if (!key) continue;
        if (key.includes(target) || target.includes(key)) partialMatches.push(school);
    }
    if (partialMatches.length === 1) return partialMatches[0];

    // Token-based fuzzy fallback (handles extra middle tokens like "Agripino Alvarez" vs "Agripino").
    let best = null;
    const bestCandidates = [];
    let bestScore = 0;
    for (const school of levelCandidates) {
        const schoolTokens = normalizeSchoolMeaningKey(school.name).split(' ').filter(Boolean);
        if (!schoolTokens.length || !targetTokens.length) continue;
        const overlap = schoolTokens.filter(token => targetTokens.includes(token)).length;
        if (!overlap) continue;
        const smaller = Math.min(schoolTokens.length, targetTokens.length);
        const score = overlap / smaller;
        const firstTokenMatch = schoolTokens[0] === targetTokens[0];
        if (!firstTokenMatch || score < 0.8) continue;
        if (score > bestScore) {
            best = school;
            bestScore = score;
            bestCandidates.length = 0;
            bestCandidates.push(school.id);
        } else if (score === bestScore) {
            bestCandidates.push(school.id);
        }
    }
    if (best && bestCandidates.length === 1) return best;

    return null;
}

async function findGradeByName(gradeStr, schoolId) {
    const target = normalizeGradeKey(gradeStr);
    if (!target) return null;
    let query = 'SELECT id, name, school_id FROM grade_levels WHERE 1=1';
    const params = [];
    if (schoolId) {
        query += ' AND (school_id = ? OR school_id IS NULL)';
        params.push(schoolId);
    }
    const [rows] = await db.query(query, params);
    const matches = rows.filter(row => normalizeGradeKey(row.name) === target);
    if (!matches.length) return null;
    if (schoolId) {
        const exactSchool = matches.find(row => Number(row.school_id) === Number(schoolId));
        if (exactSchool) return exactSchool;
        const globalRow = matches.find(row => row.school_id == null);
        if (globalRow) return globalRow;
    }
    return matches[0];
}

async function findSectionByName(sectionName, schoolId, gradeLevelId) {
    const target = normalizeLookupKey(sectionName);
    if (!target) return null;
    let query = 'SELECT id, name, adviser, adviser_teacher_id, school_id, grade_level_id FROM sections WHERE 1=1';
    const params = [];
    if (schoolId) {
        query += ' AND school_id = ?';
        params.push(schoolId);
    }
    if (gradeLevelId) {
        query += ' AND grade_level_id = ?';
        params.push(gradeLevelId);
    }
    const [rows] = await db.query(query, params);
    return rows.find(row => normalizeLookupKey(row.name) === target) || null;
}

async function findSectionByNameInSchool(sectionName, schoolId) {
    const target = normalizeLookupKey(sectionName);
    if (!target || !schoolId) return null;
    const [rows] = await db.query(
        'SELECT id, name, adviser, adviser_teacher_id, school_id, grade_level_id FROM sections WHERE school_id = ?',
        [schoolId]
    );
    const matches = rows.filter(row => normalizeLookupKey(row.name) === target);
    if (matches.length === 1) return matches[0];
    return null;
}

function schoolCodePrefix(name) {
    const compact = String(name || '')
        .replace(/[^A-Za-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    const initial = compact.map(token => token.charAt(0)).join('').toUpperCase();
    const clean = initial.replace(/[^A-Z0-9]/g, '').slice(0, 6);
    return clean || 'SCH';
}

async function createSchoolRecord(rawName) {
    const name = String(rawName || '').replace(/\s+/g, ' ').trim();
    const prefix = schoolCodePrefix(name);
    const [existingCodes] = await db.query(
        'SELECT school_code FROM schools WHERE school_code LIKE ?',
        [`${prefix}-%`]
    );
    const used = new Set(existingCodes.map(row => String(row.school_code || '').trim()));
    let sequence = 1;
    let code = `${prefix}-${String(sequence).padStart(3, '0')}`;
    while (used.has(code)) {
        sequence += 1;
        code = `${prefix}-${String(sequence).padStart(3, '0')}`;
    }
    const [result] = await db.query(
        'INSERT INTO schools (name, school_id_code, school_code, address, contact, status) VALUES (?, ?, ?, ?, ?, ?)',
        [name, null, code, null, null, 'active']
    );
    return { id: result.insertId, name, school_id_code: null, school_code: code, status: 'active' };
}

async function findTeacherMatch(empId, firstname, lastname, middlename, schoolId) {
    if (empId) {
        const [byEmployeeId] = await db.query('SELECT id, status, active_from, section_id FROM teachers WHERE employee_id = ?', [empId]);
        if (byEmployeeId.length > 0) return byEmployeeId[0];
    }

    const incomingName = normalizePersonName(fullName(firstname, lastname, middlename));
    if (!incomingName || !schoolId) return null;
    const [teachers] = await db.query(
        'SELECT id, firstname, lastname, middlename, status, active_from, section_id FROM teachers WHERE school_id = ? AND status != ?',
        [schoolId, 'deleted']
    );
    return teachers.find(teacher =>
        normalizePersonName(fullName(teacher.firstname, teacher.lastname, teacher.middlename)) === incomingName
        || normalizePersonName(`${teacher.lastname} ${teacher.firstname} ${teacher.middlename || ''}`) === incomingName
    ) || null;
}

// ---- Dashboard Pages ----
// Each route enforces that the session user's role matches.
// If the session was overwritten by another login (same browser),
// the user is redirected to THEIR correct dashboard.
router.get('/dashboard', async (req, res) => {
    const role = req.session.user.role;
    if (role !== 'super_admin') {
        return res.redirect(getDashboardUrl(role));
    }
    const [schools] = await db.query("SELECT id, name FROM schools WHERE status = 'active' ORDER BY name");
    res.render('dashboard', { title: 'Dashboard', page: 'dashboard', schools });
});

router.get('/scanner-status', requireRole('super_admin'), async (req, res) => {
    res.render('scanner_status', {
        title: 'Desktop Scanner Status',
        page: 'scanner_status',
        todayDate: todayDate()
    });
});

router.get('/principal-dashboard', async (req, res) => {
    const role = req.session.user.role;
    if (role !== 'principal') {
        return res.redirect(getDashboardUrl(role));
    }
    const schoolId = req.session.user.school_id || null;
    // A principal is scoped strictly to their assigned school. Never load other schools.
    const [schools] = schoolId
        ? await db.query("SELECT id, name FROM schools WHERE id = ? AND status = 'active'", [schoolId])
        : [[]];
    res.render('principal_dashboard', {
        title: 'Principal Dashboard',
        page: 'principal_dashboard',
        schools,
        principalSchoolId: schoolId,
        principalSchoolName: schools[0] ? schools[0].name : null
    });
});

router.get('/sds-dashboard', async (req, res) => {
    const role = req.session.user.role;
    if (role !== 'superintendent') {
        return res.redirect(getDashboardUrl(role));
    }
    res.render('division_dashboard', { title: 'Dashboard', page: 'sds_dashboard' });
});

router.get('/asds-dashboard', async (req, res) => {
    const role = req.session.user.role;
    if (role !== 'asst_superintendent') {
        return res.redirect(getDashboardUrl(role));
    }
    res.render('division_dashboard', { title: 'Dashboard', page: 'asds_dashboard' });
});

router.get('/adviser-dashboard', async (req, res) => {
    const role = req.session.user.role;
    if (role !== 'adviser') {
        return res.redirect(getDashboardUrl(role));
    }
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) {
        return res.render('error', { title: 'Setup Required', message: 'Your account is not linked to a teacher record. Please contact the administrator.', user: req.session.user });
    }
    try {
        const teacher = await loadAdviserTeacher(teacherId);
        if (!teacher) {
            return res.render('error', { title: 'Teacher Not Found', message: 'The linked teacher record was not found.', user: req.session.user });
        }
        res.render('adviser_dashboard', {
            title: 'Adviser Dashboard',
            page: 'adviser_dashboard',
            teacher,
            headerSchool: teacher.school_id ? { name: teacher.school_name || 'My School', logo: teacher.school_logo || null } : null
        });
    } catch (err) {
        console.error('Adviser dashboard error:', err);
        return res.render('error', { title: 'Error', message: 'Failed to load adviser dashboard.', user: req.session.user });
    }
});

// ---- SF2 Report ----
router.get('/sf2-report', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.redirect('/adviser-login');
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.render('error', { title: 'SF2 Error', message: 'No teacher record linked.', user: req.session.user });

    const pad2 = n => String(n).padStart(2, '0');
    const dateOnly = value => {
        if (!value) return null;
        if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
        const match = String(value).trim().match(/\d{4}-\d{2}-\d{2}/);
        return match ? match[0] : null;
    };
    // School year + month selection. SF2 is monthly; the chosen school year labels
    // the report and (for past years) drives the historical roster. Archived SF2
    // stays reachable by picking an older school year from the dropdown.
    const allSchoolYears = await schoolYears.listSchoolYears().catch(() => []);
    let selectedYear = null;
    if (req.query.sy) selectedYear = await schoolYears.getSchoolYearById(req.query.sy).catch(() => null);
    let monthParam = req.query.month; // e.g. "2026-06"
    const validMonth = monthParam && /^\d{4}-\d{2}$/.test(monthParam);
    if (!selectedYear) {
        if (validMonth) selectedYear = await schoolYears.getSchoolYearForDate(`${monthParam}-01`).catch(() => null);
        if (!selectedYear) selectedYear = await schoolYears.getActiveSchoolYear().catch(() => null);
    }
    if (!validMonth) {
        if (selectedYear && selectedYear.start_date && selectedYear.end_date) {
            const cm = currentMonth();
            const syStart = dateOnly(selectedYear.start_date);
            const syEnd = dateOnly(selectedYear.end_date);
            monthParam = (syStart && syEnd && `${cm}-01` >= syStart && `${cm}-01` <= syEnd)
                ? cm : String(syStart || selectedYear.start_date).slice(0, 7);
        } else {
            monthParam = currentMonth();
        }
    }
    // Keep direct links and AJAX requests inside the selected school year's
    // configured month range. The browser picker enforces this too, but the
    // server remains authoritative for manually edited URLs.
    if (selectedYear && selectedYear.start_date && selectedYear.end_date) {
        const startMonth = String(dateOnly(selectedYear.start_date) || selectedYear.start_date).slice(0, 7);
        const endMonth = String(dateOnly(selectedYear.end_date) || selectedYear.end_date).slice(0, 7);
        if (monthParam < startMonth) monthParam = startMonth;
        if (monthParam > endMonth) monthParam = endMonth;
    }
    const [year, month] = monthParam.split('-').map(Number);

    try {
        // Teacher + school + section info
        const teacher = await loadAdviserTeacher(teacherId);
        if (!teacher) return res.render('error', { title: 'SF2 Error', message: 'Teacher not found.', user: req.session.user });

        // School head (principal user for this school)
        const [[principal]] = await db.query(
            `SELECT fullname FROM users WHERE role = 'principal' AND school_id = ? AND status = 'active' LIMIT 1`,
            [teacher.school_id]
        ).catch(() => [[null]]);

        // Roster for the report. Active year => current section roster (cache).
        // Past/closed year => the enrollment snapshot for that year + section,
        // falling back to the current roster when no historical snapshot exists
        // (e.g. the first year, before any archived enrollments were created).
        let students;
        if (selectedYear && selectedYear.status !== 'active') {
            [students] = await db.query(
                `SELECT s.id, s.lrn, s.firstname, s.lastname, s.middlename, s.gender,
                        DATE_FORMAT(COALESCE(s.active_from, s.created_at), '%Y-%m-%d') as enrolled_from
                 FROM student_enrollments e
                 JOIN students s ON s.id = e.student_id
                 WHERE e.school_year_id = ? AND e.section_id = ? AND s.status <> 'deleted'
                 ORDER BY FIELD(s.gender,'Male','Female','Other'), s.lastname, s.firstname`,
                [selectedYear.id, teacher.section_id]
            );
        }
        if (!students || !students.length) {
            [students] = await db.query(
                `SELECT id, lrn, firstname, lastname, middlename, gender,
                        DATE_FORMAT(COALESCE(active_from, created_at), '%Y-%m-%d') as enrolled_from
                 FROM students
                 WHERE section_id = ? AND status = 'active'
                 ORDER BY FIELD(gender,'Male','Female','Other'), lastname, firstname`,
                [teacher.section_id]
            );
        }

        // Month boundaries built from plain strings — no Date/UTC conversion that can shift days
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const startDate = `${year}-${pad2(month)}-01`;
        const endDate = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;
        const syStartDate = selectedYear ? dateOnly(selectedYear.start_date) : null;
        const syEndDate = selectedYear ? dateOnly(selectedYear.end_date) : null;
        const reportStartDate = syStartDate && syStartDate > startDate ? syStartDate : startDate;
        const reportEndDate = syEndDate && syEndDate < endDate ? syEndDate : endDate;

        // Attendance for the month (time_in = present). status drives the SF2
        // codes: late => Tardy (upper-half shade), half_day => Cutting (lower-half shade).
        const [attendance] = await db.query(
            `SELECT person_id, DATE_FORMAT(date,'%Y-%m-%d') as date_str, time_in, status
             FROM attendance
             WHERE person_type = 'student'
               AND school_id = ?
               AND date BETWEEN ? AND ?`,
            [teacher.school_id, reportStartDate, reportEndDate]
        );
        const presentSet = new Set(attendance.filter(r => r.time_in).map(r => `${r.person_id}-${r.date_str}`));
        const lateSet = new Set();
        const cuttingSet = new Set();
        attendance.forEach(r => {
            if (!r.time_in) return;
            const key = `${r.person_id}-${r.date_str}`;
            const st = String(r.status || '').toLowerCase();
            if (st === 'late') lateSet.add(key);
            else if (st === 'half_day') cuttingSet.add(key);
        });

        // Holidays (national + this school) and manual school-day overrides — same rules
        // the scanner and dashboards use via checkSchoolDay()
        const [holidayRows] = await db.query(
            `SELECT DATE_FORMAT(holiday_date,'%Y-%m-%d') as d
             FROM holidays
             WHERE holiday_date BETWEEN ? AND ? AND (school_id IS NULL OR school_id = ?)`,
            [reportStartDate, reportEndDate, teacher.school_id]
        );
        const holidaySet = new Set(holidayRows.map(r => r.d));
        const [overrideRows] = await db.query(
            `SELECT DATE_FORMAT(date,'%Y-%m-%d') as d, is_school_day
             FROM school_days WHERE date BETWEEN ? AND ?`,
            [reportStartDate, reportEndDate]
        ).catch(() => [[]]);
        const overrides = new Map(overrideRows.map(r => [r.d, !!r.is_school_day]));

        // School days = weekdays minus holidays, respecting manual overrides.
        // The SF2 grid only has M-F columns, so weekend class days are excluded.
        const schoolDays = [];
        for (let day = 1; day <= daysInMonth; day++) {
            const dstr = `${year}-${pad2(month)}-${pad2(day)}`;
            if (dstr < reportStartDate || dstr > reportEndDate) continue;
            const dow = new Date(dstr + 'T00:00:00Z').getUTCDay(); // string-derived, TZ-safe
            if (dow === 0 || dow === 6) continue;
            const isSchool = overrides.has(dstr) ? overrides.get(dstr) : !holidaySet.has(dstr);
            if (isSchool) schoolDays.push(dstr);
        }

        // Weekday-aligned grid slots (M T W TH F per week), holidays left blank in place
        const firstDow = new Date(startDate + 'T00:00:00Z').getUTCDay(); // 0=Sun..6=Sat
        const mondayOffset = (firstDow + 6) % 7; // days since Monday of the 1st's week
        const slotIndex = d => {
            const day = Number(d.slice(8, 10));
            const pos = mondayOffset + day - 1;
            return Math.floor(pos / 7) * 5 + (pos % 7); // pos%7 is 0-4 for weekdays
        };
        const slotCount = Math.max(25, Math.ceil((mondayOffset + daysInMonth) / 7) * 5);
        const slots = new Array(slotCount).fill(null);
        schoolDays.forEach(d => { slots[slotIndex(d)] = d; });

        // Absences only count for past school days, or today once the school day has
        // ended (absence_cutoff_time / pm_time_out_end setting) — same rule as
        // shouldCountComputedAbsences() in the attendance API.
        const today = todayDate();
        let lastCountable;
        if (reportEndDate < today) {
            lastCountable = reportEndDate;
        } else {
            const [cutRows] = await db.query(
                `SELECT setting_key, setting_value FROM settings
                 WHERE setting_key IN ('absence_cutoff_time','pm_time_out_end')`
            );
            const cut = Object.fromEntries(cutRows.map(r => [r.setting_key, r.setting_value]));
            const cutoffTime = normalizeTime(cut.absence_cutoff_time || cut.pm_time_out_end, '17:00:00');
            const dayEnded = compareDateTime(nowDateTime(), sqlDateTime(today, cutoffTime)) >= 0;
            if (dayEnded) {
                lastCountable = today < reportStartDate ? reportStartDate : today;
            } else {
                const t = new Date(today + 'T00:00:00Z');
                t.setUTCDate(t.getUTCDate() - 1);
                lastCountable = t.toISOString().slice(0, 10);
            }
        }
        if (lastCountable > reportEndDate) lastCountable = reportEndDate;
        if (lastCountable < reportStartDate) lastCountable = '';

        // Enrollment cut-off: first Friday of the report month
        let firstFriday = endDate;
        for (let day = 1; day <= daysInMonth; day++) {
            const dstr = `${year}-${pad2(month)}-${pad2(day)}`;
            if (new Date(dstr + 'T00:00:00Z').getUTCDay() === 5) { firstFriday = dstr; break; }
        }

        // School year label — from the selected school_years row, falling back to
        // the settings string, then a derived label.
        let schoolYear;
        if (selectedYear && selectedYear.label) {
            schoolYear = selectedYear.label;
        } else {
            const [[syRow]] = await db.query(`SELECT setting_value FROM settings WHERE setting_key = 'school_year'`).catch(() => [[null]]);
            schoolYear = syRow ? syRow.setting_value : `${year}-${year + 1}`;
        }

        const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

        // SF2 remarks (teacher-editable): auto-create table on first use, then load
        await db.query(`
            CREATE TABLE IF NOT EXISTS sf2_remarks (
                id INT AUTO_INCREMENT PRIMARY KEY,
                teacher_id INT NOT NULL,
                month_year CHAR(7) NOT NULL,
                student_id INT NOT NULL DEFAULT 0,
                remark_key VARCHAR(30) NOT NULL,
                remark_value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_sf2_remark (teacher_id, month_year, student_id, remark_key)
            )
        `).catch(() => {});
        const [remarkRows] = await db.query(
            `SELECT student_id, remark_key, remark_value FROM sf2_remarks
             WHERE teacher_id = ? AND month_year = ?`,
            [teacherId, monthParam]
        ).catch(() => [[]]);
        const remarksMap = {};
        const summaryMap = {};
        remarkRows.forEach(r => {
            if (r.student_id === 0) summaryMap[r.remark_key] = r.remark_value;
            else remarksMap[r.student_id] = r.remark_value;
        });
        // Persist school_head across months: if not saved for this month, use most recent saved value
        if (!summaryMap.school_head) {
            const [[prev]] = await db.query(
                `SELECT remark_value FROM sf2_remarks
                 WHERE teacher_id = ? AND student_id = 0 AND remark_key = 'school_head'
                   AND remark_value != '' AND remark_value IS NOT NULL
                 ORDER BY month_year DESC LIMIT 1`,
                [teacherId]
            ).catch(() => [[null]]);
            if (prev && prev.remark_value) summaryMap.school_head = prev.remark_value;
        }

        // SF2 attendance overrides (teacher can set each cell's code per the legend)
        await db.query(`
            CREATE TABLE IF NOT EXISTS sf2_attendance_overrides (
                id INT AUTO_INCREMENT PRIMARY KEY,
                teacher_id INT NOT NULL,
                student_id INT NOT NULL,
                date_str CHAR(10) NOT NULL,
                is_present TINYINT(1) NOT NULL DEFAULT 1,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_sf2_ov (teacher_id, student_id, date_str)
            )
        `).catch(() => {});
        // Add the 4-state code column on existing installs (present/late/half_day/absent)
        await db.query("ALTER TABLE sf2_attendance_overrides ADD COLUMN code VARCHAR(10) NULL AFTER is_present").catch(() => {});
        const [attOvRows] = await db.query(
            `SELECT student_id, date_str, is_present, code FROM sf2_attendance_overrides
             WHERE teacher_id = ? AND date_str BETWEEN ? AND ?`,
            [teacherId, startDate, endDate]
        ).catch(() => [[]]);
        // Apply overrides on top of scanner data — teacher override takes precedence.
        attOvRows.forEach(r => {
            const key = `${r.student_id}-${r.date_str}`;
            const code = r.code || (r.is_present ? 'present' : 'absent');
            presentSet.delete(key);
            lateSet.delete(key);
            cuttingSet.delete(key);
            if (code === 'present') presentSet.add(key);
            else if (code === 'late') { presentSet.add(key); lateSet.add(key); }
            else if (code === 'half_day') { presentSet.add(key); cuttingSet.add(key); }
            // 'absent' => present stays removed
        });

        res.render('sf2_report', {
            title: 'SF2 Report',
            page: 'sf2_report',
            teacher,
            principal: principal ? principal.fullname : '',
            students,
            presentSet: [...presentSet],
            lateSet: [...lateSet],
            cuttingSet: [...cuttingSet],
            schoolDays,
            slots,
            lastCountable,
            firstFriday,
            year,
            month,
            monthName: MONTH_NAMES[month - 1],
            schoolYear,
            startDate,
            endDate,
            remarksMap,
            summaryMap,
            monthParam,
            schoolYearsList: allSchoolYears,
            selectedSyId: selectedYear ? selectedYear.id : null,
            syStart: selectedYear ? selectedYear.start_date : null,
            syEnd: selectedYear ? selectedYear.end_date : null
        });
    } catch (err) {
        console.error('SF2 report error:', err);
        return res.render('error', { title: 'SF2 Error', message: 'Failed to generate SF2.', user: req.session.user });
    }
});

// ---- SF2 Save Remarks ----
router.post('/sf2-save-remarks', express.json(), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'No teacher record' });

    const { month, remarks, summary, overrides } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month' });

    const submittedStudentIds = new Set();
    if (remarks && typeof remarks === 'object') {
        Object.keys(remarks).forEach(sid => {
            const studentId = parseInt(sid, 10);
            if (!isNaN(studentId) && studentId > 0) submittedStudentIds.add(studentId);
        });
    }
    if (Array.isArray(overrides)) {
        overrides.forEach(ov => {
            const studentId = parseInt(ov && ov.student_id, 10);
            if (!isNaN(studentId) && studentId > 0) submittedStudentIds.add(studentId);
        });
    }

    try {
        const teacher = await loadAdviserTeacher(teacherId);
        if (!teacher || !teacher.section_id) return res.status(403).json({ error: 'Your adviser account is not linked to a section.' });
        const ids = Array.from(submittedStudentIds);
        if (ids.length) {
            const [ownedRows] = await db.query(
                `SELECT id FROM students WHERE section_id = ? AND status != 'deleted' AND id IN (?)`,
                [teacher.section_id, ids]
            );
            const owned = new Set(ownedRows.map(row => Number(row.id)));
            const outside = ids.filter(id => !owned.has(Number(id)));
            if (outside.length) {
                return res.status(403).json({ error: 'SF2 changes can only be saved for students in your advisory section.' });
            }
        }
    } catch (err) {
        console.error('SF2 scope validation error:', err);
        return res.status(500).json({ error: 'Failed to validate SF2 scope.' });
    }

    const remarkRows = [];
    if (remarks && typeof remarks === 'object') {
        Object.entries(remarks).forEach(([sid, text]) => {
            const studentId = parseInt(sid, 10);
            if (!isNaN(studentId) && studentId > 0) {
                remarkRows.push([teacherId, month, studentId, 'remark', String(text).slice(0, 500)]);
            }
        });
    }
    const SUMMARY_KEYS = ['dropped_out_m','dropped_out_f','transferred_out_m','transferred_out_f','transferred_in_m','transferred_in_f','school_head'];
    if (summary && typeof summary === 'object') {
        SUMMARY_KEYS.forEach(key => {
            const val = summary[key] !== undefined ? String(summary[key]).slice(0, 100) : '';
            remarkRows.push([teacherId, month, 0, key, val]);
        });
    }

    try {
        if (remarkRows.length) {
            await db.query(
                `INSERT INTO sf2_remarks (teacher_id, month_year, student_id, remark_key, remark_value)
                 VALUES ? ON DUPLICATE KEY UPDATE remark_value = VALUES(remark_value), updated_at = CURRENT_TIMESTAMP`,
                [remarkRows]
            );
        }
        // Save attendance overrides (teacher-set cell codes per the SF2 legend)
        if (Array.isArray(overrides) && overrides.length) {
            await db.query("ALTER TABLE sf2_attendance_overrides ADD COLUMN code VARCHAR(10) NULL AFTER is_present").catch(() => {});
            const validDate = /^\d{4}-\d{2}-\d{2}$/;
            const VALID_CODES = ['present', 'late', 'half_day', 'absent'];
            for (const ov of overrides) {
                const sid = parseInt(ov.student_id, 10);
                if (isNaN(sid) || sid <= 0) continue;
                if (!validDate.test(ov.date)) continue;
                if (String(ov.date).slice(0, 7) !== month) continue;
                const code = VALID_CODES.includes(ov.code) ? ov.code : (ov.is_present ? 'present' : 'absent');
                const isPresent = code === 'absent' ? 0 : 1;
                await db.query(
                    `INSERT INTO sf2_attendance_overrides (teacher_id, student_id, date_str, is_present, code)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE is_present = VALUES(is_present), code = VALUES(code), updated_at = CURRENT_TIMESTAMP`,
                    [teacherId, sid, ov.date, isPresent, code]
                );
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error('SF2 save remarks error:', err);
        res.status(500).json({ error: 'Save failed' });
    }
});

// ---- Adviser: Edit Student ----
router.post('/adviser-edit-student', express.json(), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'No teacher record' });

    const { student_id, firstname, lastname, middlename, lrn, gender, guardian_contact } = req.body;
    const sid = parseInt(student_id, 10);
    if (!sid || sid <= 0) return res.status(400).json({ error: 'Invalid student' });

    // Validate required fields
    const fn = String(firstname || '').trim();
    const ln = String(lastname || '').trim();
    const mn = String(middlename || '').trim() || null;
    const lrnVal = String(lrn || '').trim();
    const gc = String(guardian_contact || '').trim() || null;
    if (!fn || !ln) return res.status(400).json({ error: 'First name and last name are required' });

    // Normalize gender
    const gMap = { male: 'Male', female: 'Female', other: 'Other', m: 'Male', f: 'Female' };
    const gNorm = gMap[(String(gender || '').trim().toLowerCase())] || null;

    try {
        // Security: ensure the student belongs to this teacher's section
        const [[t]] = await db.query(`SELECT section_id, school_id FROM teachers WHERE id = ?`, [teacherId]);
        if (!t) return res.status(403).json({ error: 'Teacher not found' });

        const [[s]] = await db.query(`SELECT id FROM students WHERE id = ? AND section_id = ? AND status != 'deleted'`, [sid, t.section_id]);
        if (!s) return res.status(403).json({ error: 'Student not in your section' });

        // Check LRN uniqueness if changed
        if (lrnVal) {
            const [dup] = await db.query(`SELECT id FROM students WHERE lrn = ? AND id != ?`, [lrnVal, sid]);
            if (dup.length > 0) return res.status(400).json({ error: 'LRN already used by another student' });
        }

        // Profile fields only. A section change is a separate, approval-based
        // transfer handled by POST /api/transfers/student (the receiving adviser
        // confirms), so it is intentionally not applied here.
        await db.query(
            `UPDATE students SET firstname=?, lastname=?, middlename=?, lrn=?, gender=?, guardian_contact=? WHERE id=?`,
            [fn, ln, mn, lrnVal || null, gNorm, gc, sid]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Adviser edit student error:', err);
        res.status(500).json({ error: 'Update failed' });
    }
});

// ---- Adviser: sections in their school (destinations for a student transfer) ----
router.get('/adviser-sections', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'No teacher record' });
    try {
        const t = await loadAdviserTeacher(teacherId);
        if (!t) return res.status(403).json({ error: 'Teacher not found' });
        let [rows] = await db.query(
            `SELECT sec.id, sec.name, gl.name AS grade_name
             FROM sections sec
             LEFT JOIN grade_levels gl ON sec.grade_level_id = gl.id
             WHERE sec.school_id = ? AND (sec.status IS NULL OR sec.status != 'deleted')
             ORDER BY gl.name, sec.name`,
            [t.school_id]
        );
        const teacherGrade = parseGradeNumber(t.grade_name || '');
        const teacherIsShs = t.category === 'shs_teacher' || (teacherGrade >= 11 && teacherGrade <= 12);
        rows = rows.filter(row => {
            const grade = parseGradeNumber(row.grade_name || '');
            return teacherIsShs ? grade >= 11 && grade <= 12 : grade >= 1 && grade <= 10;
        });
        res.json(rows);
    } catch (err) {
        console.error('Adviser sections error:', err);
        res.status(500).json({ error: 'Failed to load sections' });
    }
});

// Shared: load the adviser's teacher record (with school/grade/section names).
async function loadAdviserTeacher(teacherId) {
    const [[teacher]] = await db.query(
        `SELECT t.id, t.firstname, t.lastname, t.middlename, t.email, t.contact,
                t.section_id,
                COALESCE(sec.school_id, t.school_id) AS school_id,
                COALESCE(sec.grade_level_id, t.grade_level_id) AS grade_level_id,
                t.category,
                sc.name as school_name, sc.logo as school_logo, sc.school_id_code,
                gl.name as grade_name, sec.name as section_name,
                t.school_id AS teacher_school_id,
                sec.school_id AS section_school_id
         FROM teachers t
         LEFT JOIN sections sec ON t.section_id = sec.id
         LEFT JOIN schools sc ON sc.id = COALESCE(sec.school_id, t.school_id)
         LEFT JOIN grade_levels gl ON gl.id = COALESCE(sec.grade_level_id, t.grade_level_id)
         WHERE t.id = ?`, [teacherId]
    );
    if (teacher) {
        teacher.school_logo = schoolLogoUrl(teacher.school_id, teacher.school_logo);
        const gradeNumber = parseGradeNumber(teacher.grade_name || '');
        teacher.is_shs = teacher.category === 'shs_teacher' || (gradeNumber >= 11 && gradeNumber <= 12);
        teacher.track = teacher.is_shs ? deriveTrackFromSection(teacher.section_name) : '';
    }
    return teacher;
}

// Shared: split the adviser's roster into status groups for the active + closed
// years. Used by both the Student List (enrolled) and Student Management pages.
async function loadAdviserGroups(teacher) {
    const sectionId = teacher.section_id;
    const active = await schoolYears.getActiveSchoolYear();
    const activeId = active ? active.id : null;
    const groups = { enrolled: [], notEnrolled: [], transferred: [], archived: [] };
    if (sectionId) {
        // Enrolled (active roster) — cache-based so no student is ever lost to a
        // missing enrollment record. These are attendance-eligible right now.
        const [enrolled] = await db.query(
            `SELECT id, lrn, firstname, lastname, middlename, gender, guardian_contact, status, active_from, created_at
             FROM students WHERE section_id = ? AND status = 'active' ORDER BY lastname, firstname`,
            [sectionId]
        );
        groups.enrolled = enrolled;
        if (activeId) {
            const [transferred] = await db.query(
                `SELECT s.id, s.lrn, s.firstname, s.lastname, s.middlename, s.gender,
                        e.transfer_to_school, e.transfer_date, e.remarks
                 FROM student_enrollments e JOIN students s ON s.id = e.student_id
                 WHERE e.section_id = ? AND e.school_year_id = ? AND e.status = 'transferred_out' AND s.status <> 'deleted'
                 ORDER BY s.lastname, s.firstname`,
                [sectionId, activeId]
            );
            groups.transferred = transferred;
            const [notEnrolled] = await db.query(
                `SELECT DISTINCT s.id, s.lrn, s.firstname, s.lastname, s.middlename, s.gender, s.guardian_contact
                 FROM student_enrollments e JOIN students s ON s.id = e.student_id
                 WHERE e.section_id = ? AND s.status NOT IN ('active', 'deleted')
                   AND NOT EXISTS (SELECT 1 FROM student_enrollments te
                       WHERE te.student_id = s.id AND te.school_year_id = ? AND te.status = 'transferred_out')
                 ORDER BY s.lastname, s.firstname`,
                [sectionId, activeId]
            );
            groups.notEnrolled = notEnrolled;
        }
        const [archived] = await db.query(
            `SELECT s.id, s.lrn, s.firstname, s.lastname, s.middlename,
                    sy.label AS year_label, gl.name AS grade_name, sec.name AS section_name
             FROM student_enrollments e JOIN students s ON s.id = e.student_id
             JOIN school_years sy ON sy.id = e.school_year_id AND sy.status = 'closed'
             LEFT JOIN grade_levels gl ON gl.id = e.grade_level_id
             LEFT JOIN sections sec ON sec.id = e.section_id
             WHERE e.section_id = ? AND s.status <> 'deleted'
             ORDER BY sy.label DESC, s.lastname, s.firstname`,
            [sectionId]
        );
        groups.archived = archived;
    }
    return { groups, activeYearLabel: active ? active.label : null };
}

// ---- Adviser: Student List (enrolled roster of my section only) ----
router.get('/adviser-students', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.redirect('/adviser-login');
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.render('error', { title: 'Error', message: 'No teacher record linked.', user: req.session.user });
    try {
        const teacher = await loadAdviserTeacher(teacherId);
        if (!teacher) return res.render('error', { title: 'Error', message: 'Teacher not found.', user: req.session.user });
        const { groups, activeYearLabel } = await loadAdviserGroups(teacher);
        res.render('adviser_students', {
            title: 'My Students', page: 'adviser_students', teacher,
            students: groups.enrolled, activeYearLabel
        });
    } catch (err) {
        console.error('Adviser students error:', err);
        res.render('error', { title: 'Error', message: 'Failed to load students.', user: req.session.user });
    }
});

// ---- Adviser: Student Management — one focused view per sidebar item ----
const STUDENT_VIEWS = {
    enroll: 'Enroll a Student',
    notEnrolled: 'Not Enrolled Students',
    transferred: 'Transferred Students',
    archived: 'Archived Students'
};
router.get('/adviser-student-management', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.redirect('/adviser-login');
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.render('error', { title: 'Error', message: 'No teacher record linked.', user: req.session.user });
    try {
        const teacher = await loadAdviserTeacher(teacherId);
        if (!teacher) return res.render('error', { title: 'Error', message: 'Teacher not found.', user: req.session.user });
        const view = Object.prototype.hasOwnProperty.call(STUDENT_VIEWS, req.query.view) ? req.query.view : 'enroll';
        const { groups, activeYearLabel } = await loadAdviserGroups(teacher);
        res.render('adviser_student_management', {
            title: STUDENT_VIEWS[view], page: 'adviser_student_management', studentView: view, teacher,
            groups, activeYearLabel
        });
    } catch (err) {
        console.error('Adviser student management error:', err);
        res.render('error', { title: 'Error', message: 'Failed to load student management.', user: req.session.user });
    }
});

// ---- Adviser: Import Students Page ----
router.get('/adviser-import-students', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.redirect('/adviser-login');
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.render('error', { title: 'Error', message: 'No teacher record linked.', user: req.session.user });
    try {
        const teacher = await loadAdviserTeacher(teacherId);
        if (!teacher) return res.render('error', { title: 'Error', message: 'Teacher not found.', user: req.session.user });

        let students = [];
        if (teacher.section_id) {
            [students] = await db.query(
                `SELECT id, lrn, firstname, lastname, middlename, gender, guardian_contact, status
                 FROM students
                 WHERE section_id = ? AND status != 'deleted'
                 ORDER BY lastname, firstname`,
                [teacher.section_id]
            );
        }
        res.render('adviser_import_students', {
            title: 'Import Students',
            page: 'adviser_student_import',
            isShs: !!teacher.is_shs,
            teacher,
            students
        });
    } catch (err) {
        console.error('Adviser import page error:', err);
        res.render('error', { title: 'Error', message: 'Failed to load import page.', user: req.session.user });
    }
});

// ---- Adviser: Add Student ----
router.post('/adviser-add-student', express.json(), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'No teacher record' });

    const { lrn, firstname, lastname, middlename, gender, guardian_contact } = req.body;
    const fn = String(firstname || '').trim();
    const ln = String(lastname || '').trim();
    const mn = String(middlename || '').trim() || null;
    const lrnVal = String(lrn || '').trim() || null;
    const gc = String(guardian_contact || '').trim() || null;
    if (!fn || !ln) return res.status(400).json({ error: 'First name and last name are required' });

    const gMap = { male: 'Male', female: 'Female', m: 'Male', f: 'Female' };
    const gNorm = gMap[(String(gender || '').trim().toLowerCase())] || null;

    try {
        const t = await loadAdviserTeacher(teacherId);
        if (!t || !t.section_id) return res.status(400).json({ error: 'No section assigned to your account' });

        if (lrnVal) {
            const [dup] = await db.query(`SELECT id FROM students WHERE lrn = ?`, [lrnVal]);
            if (dup.length > 0) return res.status(409).json({ error: 'A student with this LRN already exists. Use "Enroll a Student" above to find and enroll them — even if they are from another school.' });
        }

        const qr_code = lrnVal ? 'STU-' + lrnVal : 'STU-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
        const [result] = await db.query(
            `INSERT INTO students (lrn, firstname, lastname, middlename, gender, school_id, grade_level_id, section_id, guardian_contact, qr_code, category, active_from, status)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,CURDATE(),'active')`,
            [lrnVal, fn, ln, mn, gNorm, t.school_id, t.grade_level_id, t.section_id, gc, qr_code,
             (t.category === 'shs_teacher' || (parseGradeNumber(t.grade_name) >= 11 && parseGradeNumber(t.grade_name) <= 12)) ? 'shs_student' : 'student']
        );
        // Record the per-year enrollment (best-effort — the student is already in
        // the section via the cache columns even if the SY record can't be written).
        try {
            await schoolYears.enrollStudentInActiveYear({
                studentId: result.insertId, schoolId: t.school_id, gradeLevelId: t.grade_level_id,
                sectionId: t.section_id, enrolledBy: teacherId
            });
        } catch (enrollErr) {
            console.error('Add student: enrollment record skipped:', enrollErr.message);
        }
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A student with this LRN already exists. Use "Enroll a Student" above to find and enroll them — even if they are from another school.' });
        console.error('Adviser add student error:', err);
        res.status(500).json({ error: 'Failed to add student' });
    }
});

// ---- Adviser: Search students to enroll (by LRN or name, within own school) ----
router.get('/adviser-search-students', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'No teacher record' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, students: [] });
    try {
        const [[t]] = await db.query('SELECT section_id, school_id FROM teachers WHERE id = ?', [teacherId]);
        if (!t) return res.status(400).json({ error: 'Teacher not found' });
        const like = '%' + q + '%';
        // Division-wide search: find the learner anywhere (e.g. an incoming Grade 7
        // or SHS student still recorded under their feeder/previous school) so the
        // adviser can transfer them in. The source school is returned for clarity.
        const [rows] = await db.query(
            `SELECT s.id, s.lrn, s.firstname, s.lastname, s.middlename,
                    s.school_id AS current_school_id, s.section_id AS current_section_id, s.status AS current_status,
                    sch.name AS current_school_name, sec.name AS current_section_name, gl.name AS current_grade_name
             FROM students s
             LEFT JOIN schools sch ON s.school_id = sch.id
             LEFT JOIN sections sec ON s.section_id = sec.id
             LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
             WHERE s.status <> 'deleted'
               AND (s.lrn LIKE ? OR CONCAT_WS(' ', s.firstname, s.middlename, s.lastname) LIKE ?
                    OR CONCAT_WS(' ', s.lastname, s.firstname) LIKE ?)
             ORDER BY s.lastname, s.firstname
             LIMIT 25`,
            [like, like, like]
        );
        // One query for the latest prior enrollment of all results (avoids N+1).
        const ids = rows.map((r) => r.id);
        const priorByStudent = {};
        if (ids.length) {
            const [priors] = await db.query(
                `SELECT e.student_id, sy.label AS year_label, e.status,
                        gl.name AS grade_name, sec.name AS section_name
                 FROM student_enrollments e
                 JOIN school_years sy ON e.school_year_id = sy.id
                 LEFT JOIN grade_levels gl ON e.grade_level_id = gl.id
                 LEFT JOIN sections sec ON e.section_id = sec.id
                 WHERE e.student_id IN (?)
                 ORDER BY sy.label DESC, e.id DESC`,
                [ids]
            );
            for (const p of priors) {
                if (!priorByStudent[p.student_id]) priorByStudent[p.student_id] = p; // keep latest only
            }
        }
        const students = rows.map((r) => ({
            id: r.id,
            lrn: r.lrn || '',
            name: [r.lastname, r.firstname].filter(Boolean).join(', ') + (r.middlename ? ' ' + r.middlename.charAt(0) + '.' : ''),
            already_mine: Number(r.current_section_id) === Number(t.section_id) && String(r.current_status) === 'active',
            from_other_school: Number(r.current_school_id) !== Number(t.school_id),
            current_school_name: r.current_school_name || null,
            current_section_name: r.current_section_name || null,
            current_grade_name: r.current_grade_name || null,
            prior: priorByStudent[r.id] || null
        }));
        res.json({ success: true, students });
    } catch (err) {
        console.error('Adviser search students error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// ---- Adviser: Enroll an existing student into my section for the active year ----
router.post('/adviser-enroll-student', express.json(), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'No teacher record' });
    const sid = parseInt(req.body.student_id, 10);
    if (!sid) return res.status(400).json({ error: 'Invalid student' });
    try {
        const [[t]] = await db.query('SELECT section_id, school_id, grade_level_id FROM teachers WHERE id = ?', [teacherId]);
        if (!t || !t.section_id) return res.status(400).json({ error: 'No section assigned to your account' });
        const [[stu]] = await db.query("SELECT id, school_id FROM students WHERE id = ? AND status <> 'deleted'", [sid]);
        if (!stu) return res.status(404).json({ error: 'Student not found' });
        // Division-wide enrollment: if the student is currently in another school
        // (an incoming learner from a feeder/previous school), enrolling them moves
        // them into this school + section for the active year — an immediate
        // transfer-in. Their previous-school attendance and history stay intact.
        const transferredIn = Number(stu.school_id) !== Number(t.school_id);
        await schoolYears.enrollStudentInActiveYear({
            studentId: sid, schoolId: t.school_id, gradeLevelId: t.grade_level_id,
            sectionId: t.section_id, enrolledBy: teacherId
        });
        res.json({ success: true, transferred_in: transferredIn });
    } catch (err) {
        console.error('Adviser enroll student error:', err);
        res.status(500).json({ error: err.message || 'Failed to enroll student' });
    }
});

// ---- Adviser: Mark a student Transferred Out (to another school) ----
router.post('/adviser-transfer-out', express.json(), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'No teacher record' });
    const sid = parseInt(req.body.student_id, 10);
    const toSchool = String(req.body.to_school || '').trim();
    const transferDate = String(req.body.transfer_date || '').trim() || null;
    const remarks = String(req.body.remarks || '').trim() || null;
    if (!sid) return res.status(400).json({ error: 'Invalid student' });
    if (!toSchool) return res.status(400).json({ error: 'Please enter the school the student transferred to.' });
    try {
        const [[t]] = await db.query('SELECT section_id, school_id FROM teachers WHERE id = ?', [teacherId]);
        if (!t || !t.section_id) return res.status(400).json({ error: 'No section assigned to your account' });
        const [[stu]] = await db.query("SELECT id, school_id, grade_level_id FROM students WHERE id = ? AND status <> 'deleted'", [sid]);
        if (!stu) return res.status(404).json({ error: 'Student not found' });
        if (Number(stu.school_id) !== Number(t.school_id)) {
            return res.status(403).json({ error: 'That student belongs to another school.' });
        }
        const active = await schoolYears.getActiveSchoolYear();
        if (!active) return res.status(400).json({ error: 'There is no active school year.' });
        // Mark the active-year enrollment transferred_out (upsert so it works even
        // if the enrollment record was missing).
        await db.query(
            `INSERT INTO student_enrollments
                (student_id, school_year_id, school_id, grade_level_id, section_id, status,
                 transfer_to_school, transfer_date, remarks, enrolled_by, created_at)
             VALUES (?, ?, ?, ?, ?, 'transferred_out', ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
                status = 'transferred_out',
                transfer_to_school = VALUES(transfer_to_school),
                transfer_date = VALUES(transfer_date),
                remarks = VALUES(remarks),
                updated_at = NOW()`,
            [sid, active.id, t.school_id, stu.grade_level_id, t.section_id, toSchool, transferDate, remarks, teacherId]
        );
        // Cache inactive: drop from the active roster and block scanning; records kept.
        await db.query("UPDATE students SET status = 'inactive' WHERE id = ?", [sid]);
        res.json({ success: true });
    } catch (err) {
        console.error('Adviser transfer out error:', err);
        res.status(500).json({ error: 'Failed to mark the student as transferred.' });
    }
});

// ---- Adviser: Preview Import (parse file, no DB write) ----
router.post('/adviser-import-students', upload.single('file'), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'No teacher record' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    let rawRows = [];
    try {
        const t = await loadAdviserTeacher(teacherId);
        if (!t || !t.section_id) return res.status(400).json({ error: 'No section assigned to your account' });

        const ext = String(req.file.originalname || '').toLowerCase();
        if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(req.file.buffer);
            const sheet = workbook.getWorksheet('Template') || workbook.worksheets[0];
            if (!sheet) return res.status(400).json({ error: 'No worksheet found in the uploaded file.' });
            const headers = [];
            sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
                const raw = parseExcelCellValue(cell);
                headers[colNumber] = raw.split('\n')[0].trim();
            });
            sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
                if (rowNumber <= 1) return;
                const obj = {};
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    const key = headers[colNumber];
                    if (key) obj[key] = parseExcelCellValue(cell);
                });
                if (Object.values(obj).some(v => String(v || '').trim() !== '')) {
                    rawRows.push({ row: obj, rowNum: rowNumber });
                }
            });
        } else {
            await new Promise((resolve, reject) => {
                let rowNum = 1;
                const stream = Readable.from(req.file.buffer.toString());
                stream.pipe(csv())
                    .on('data', row => { rowNum++; rawRows.push({ row, rowNum }); })
                    .on('end', resolve)
                    .on('error', reject);
            });
        }

        if (!rawRows.length) return res.status(400).json({ error: 'No student rows found in the uploaded file.' });

        const gradeNumber = parseGradeNumber(t.grade_name);
        const category = Number.isFinite(gradeNumber) && gradeNumber >= 11 ? 'shs_student' : 'student';
        const errors = [];
        const previewStudents = [];
        const pendingRows = [];
        let willImport = 0;
        let willUpdate = 0;

        for (const { row, rowNum } of rawRows) {
            try {
                const rawName = getRowValue(row, ['Student Name', 'Learner Name', 'Name', 'student_name']);
                const parsed = parseImportName(rawName);
                const fn = parsed.firstname || getRowValue(row, ['First Name', 'Firstname', 'Given Name', 'firstname']);
                const ln = parsed.lastname || getRowValue(row, ['Last Name', 'Lastname', 'Surname', 'lastname']);
                const mn = parsed.middlename || getRowValue(row, ['Middle Name', 'Middlename', 'Middle Initial', 'middlename']);
                const lrnVal = getRowValue(row, ['LRN', 'lrn']) || null;
                const sexRaw = getRowValue(row, ['Sex', 'Gender', 'sex', 'gender']);
                const sex = parseSexValue(sexRaw);
                const guardianContact = getRowValue(row, ['Guardian Contact', 'Guardian Phone', 'Contact Number', 'guardian_contact']) || null;

                if (!fn || !ln) {
                    const message = 'Student name is missing — check the Name column';
                    errors.push({ row: rowNum, message });
                    previewStudents.push({ row: rowNum, action: 'Skipped', status: 'error', message, lrn: lrnVal || '', firstname: fn || '', lastname: ln || '', middlename: mn || '', gender: sex || sexRaw || '', guardian_contact: guardianContact || '' });
                    continue;
                }
                if (sexRaw && !sex) {
                    const message = 'Invalid Sex/Gender value "' + sexRaw + '"';
                    errors.push({ row: rowNum, message });
                    previewStudents.push({ row: rowNum, action: 'Skipped', status: 'error', message, lrn: lrnVal || '', firstname: fn, lastname: ln, middlename: mn || '', gender: sexRaw || '', guardian_contact: guardianContact || '' });
                    continue;
                }

                let existingId = null;
                if (lrnVal) {
                    const [existing] = await db.query(
                        'SELECT id, section_id FROM students WHERE lrn = ? AND status != ?',
                        [lrnVal, 'deleted']
                    );
                    if (existing.length && Number(existing[0].section_id) !== Number(t.section_id)) {
                        errors.push({ row: rowNum, message: 'This student is already enrolled in a different section' });
                        previewStudents.push({ row: rowNum, action: 'Skipped', status: 'error', message: 'This student is already enrolled in a different section', lrn: lrnVal || '', firstname: fn || '', lastname: ln || '', middlename: mn || '', gender: sex || '', guardian_contact: guardianContact || '' });
                        continue;
                    }
                    if (existing.length) existingId = existing[0].id;
                }

                if (existingId) {
                    willUpdate++;
                    pendingRows.push({ rowNum, action: 'update', fn, ln, mn: mn || null, lrnVal, sex: sex || null, guardianContact, existingId });
                    previewStudents.push({ row: rowNum, action: 'Will Update', status: 'pending', lrn: lrnVal || '', firstname: fn, lastname: ln, middlename: mn || '', gender: sex || '', guardian_contact: guardianContact || '' });
                } else {
                    willImport++;
                    pendingRows.push({ rowNum, action: 'insert', fn, ln, mn: mn || null, lrnVal, sex: sex || null, guardianContact });
                    previewStudents.push({ row: rowNum, action: 'Will Import', status: 'pending', lrn: lrnVal || '', firstname: fn, lastname: ln, middlename: mn || '', gender: sex || '', guardian_contact: guardianContact || '' });
                }
            } catch (err) {
                const message = err.code === 'ER_DUP_ENTRY' ? 'Duplicate LRN or QR code' : err.message;
                errors.push({ row: rowNum, message });
                previewStudents.push({ row: rowNum, action: 'Skipped', status: 'error', message, lrn: getRowValue(row, ['LRN', 'lrn']) || '', firstname: '', lastname: '', middlename: '', gender: '', guardian_contact: '' });
            }
        }

        req.session.pendingAdviserImport = {
            teacherInfo: { section_id: t.section_id, school_id: t.school_id, grade_level_id: t.grade_level_id, category },
            pendingRows,
            fileName: req.file.originalname || 'Uploaded file',
            timestamp: Date.now()
        };

        return res.json({
            success: true,
            preview: true,
            willImport,
            willUpdate,
            errors,
            total: rawRows.length,
            file: { name: req.file.originalname || 'Uploaded file', size: req.file.size || 0 },
            students: previewStudents
        });
    } catch (err) {
        console.error('Adviser preview students error:', err);
        return res.status(400).json({ error: 'Failed to parse file: ' + err.message });
    }
});

// ---- Adviser: Confirm Import (write to DB) ----
router.post('/adviser-confirm-import', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const pending = req.session.pendingAdviserImport;
    if (!pending || !pending.pendingRows) return res.status(400).json({ error: 'No pending import found. Please upload your file again.' });
    if (Date.now() - (pending.timestamp || 0) > 15 * 60 * 1000) {
        delete req.session.pendingAdviserImport;
        return res.status(400).json({ error: 'Preview expired (15 min). Please upload your file again.' });
    }

    const { teacherInfo, pendingRows } = pending;
    const errors = [];
    const resultStudents = [];
    let imported = 0;
    let updated = 0;

    // Resolve the active school year once so each row's enrollment record is a
    // cheap insert rather than a repeated lookup.
    const enrollTeacherId = req.session.user.teacher_id;
    let activeSyId = null;
    try {
        const active = await schoolYears.getActiveSchoolYear();
        activeSyId = active ? active.id : null;
    } catch (e) {
        console.error('Import: could not resolve active school year:', e.message);
    }

    for (const pr of pendingRows) {
        try {
            if (pr.action === 'update') {
                await db.query(
                    `UPDATE students SET firstname=?, lastname=?, middlename=?, gender=?, school_id=?, grade_level_id=?, section_id=?,
                         guardian_contact=?, category=?, status='active', active_from=COALESCE(active_from, CURDATE()) WHERE id=?`,
                    [pr.fn, pr.ln, pr.mn, pr.sex, teacherInfo.school_id, teacherInfo.grade_level_id, teacherInfo.section_id, pr.guardianContact, teacherInfo.category, pr.existingId]
                );
                updated++;
                if (activeSyId) {
                    try {
                        await schoolYears.enrollStudentInActiveYear({ studentId: pr.existingId, schoolId: teacherInfo.school_id, gradeLevelId: teacherInfo.grade_level_id, sectionId: teacherInfo.section_id, enrolledBy: enrollTeacherId, schoolYearId: activeSyId });
                    } catch (e) { console.error('Import enrollment skipped (update):', e.message); }
                }
                resultStudents.push({ row: pr.rowNum, action: 'Updated', status: 'success', lrn: pr.lrnVal || '', firstname: pr.fn, lastname: pr.ln, middlename: pr.mn || '', gender: pr.sex || '', guardian_contact: pr.guardianContact || '' });
            } else {
                const qr_code = pr.lrnVal ? 'STU-' + pr.lrnVal : 'STU-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                const [ins] = await db.query(
                    `INSERT INTO students (lrn, firstname, lastname, middlename, gender, school_id, grade_level_id, section_id, guardian_contact, qr_code, category, active_from, status)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,CURDATE(),'active')`,
                    [pr.lrnVal, pr.fn, pr.ln, pr.mn, pr.sex, teacherInfo.school_id, teacherInfo.grade_level_id, teacherInfo.section_id, pr.guardianContact, qr_code, teacherInfo.category]
                );
                imported++;
                if (activeSyId) {
                    try {
                        await schoolYears.enrollStudentInActiveYear({ studentId: ins.insertId, schoolId: teacherInfo.school_id, gradeLevelId: teacherInfo.grade_level_id, sectionId: teacherInfo.section_id, enrolledBy: enrollTeacherId, schoolYearId: activeSyId });
                    } catch (e) { console.error('Import enrollment skipped (insert):', e.message); }
                }
                resultStudents.push({ row: pr.rowNum, action: 'Imported', status: 'success', id: ins.insertId, lrn: pr.lrnVal || '', firstname: pr.fn, lastname: pr.ln, middlename: pr.mn || '', gender: pr.sex || '', guardian_contact: pr.guardianContact || '' });
            }
        } catch (err) {
            const message = err.code === 'ER_DUP_ENTRY' ? 'Duplicate LRN or QR code' : err.message;
            errors.push({ row: pr.rowNum, message });
            resultStudents.push({ row: pr.rowNum, action: 'Skipped', status: 'error', message, lrn: pr.lrnVal || '', firstname: pr.fn || '', lastname: pr.ln || '', middlename: pr.mn || '', gender: pr.sex || '', guardian_contact: pr.guardianContact || '' });
        }
    }

    delete req.session.pendingAdviserImport;

    return res.json({
        success: true,
        imported,
        updated,
        errors,
        total: pendingRows.length,
        file: { name: pending.fileName },
        students: resultStudents
    });
});

// ---- Adviser: Delete Student ----
router.post('/adviser-delete-student', express.json(), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'No teacher record' });

    const sid = parseInt(req.body.student_id, 10);
    if (!sid || sid <= 0) return res.status(400).json({ error: 'Invalid student' });

    try {
        const [[t]] = await db.query(`SELECT section_id FROM teachers WHERE id = ?`, [teacherId]);
        if (!t) return res.status(403).json({ error: 'Teacher not found' });

        const [[s]] = await db.query(`SELECT id FROM students WHERE id = ? AND section_id = ? AND status != 'deleted'`, [sid, t.section_id]);
        if (!s) return res.status(403).json({ error: 'Student not in your section' });

        await db.query(`UPDATE students SET status = 'deleted' WHERE id = ?`, [sid]);
        res.json({ success: true });
    } catch (err) {
        console.error('Adviser delete student error:', err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// ---- Adviser: Profile (JSON for modal) ----
router.get('/adviser-profile-data', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    try {
        const [[t]] = await db.query(
            `SELECT t.id, t.firstname, t.lastname, t.middlename, t.email, t.contact, t.profile_photo,
                    sc.name as school_name, sc.logo as school_logo, gl.name as grade_name, sec.name as section_name
             FROM teachers t
             LEFT JOIN sections sec ON t.section_id = sec.id
             LEFT JOIN schools sc ON sc.id = COALESCE(sec.school_id, t.school_id)
             LEFT JOIN grade_levels gl ON gl.id = COALESCE(sec.grade_level_id, t.grade_level_id)
             WHERE t.id = ?`,
            [teacherId]
        );
        if (!t) return res.status(404).json({ error: 'Not found' });
        // include session fullname as fallback when DB name fields are empty
        t.session_fullname = req.session.user.fullname || '';
        res.json(t);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/adviser-update-profile', express.json(), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const teacherId = req.session.user.teacher_id;
    const { fullname, email, contact } = req.body;
    if (!fullname || !fullname.trim()) return res.status(400).json({ error: 'Name is required.' });
    try {
        // Split the single name field into first/last (last word = lastname) so we
        // don't blank out the structured name fields the rest of the app relies on.
        const nameParts = fullname.trim().split(/\s+/);
        const lname = nameParts.length > 1 ? nameParts.pop() : '';
        const fname = nameParts.join(' ') || fullname.trim();
        await db.query(
            `UPDATE teachers SET firstname=?, lastname=?, middlename='', email=?, contact=? WHERE id=?`,
            [fname, lname, (email||'').trim(), (contact||'').trim(), teacherId]
        );
        req.session.user.fullname = fullname.trim();
        res.json({ success: true, fullname: fullname.trim() });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update profile.' });
    }
});

router.post('/adviser-upload-photo', upload.single('photo'), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: 'Only image files are allowed.' });
    const teacherId = req.session.user.teacher_id;
    try {
        const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        await db.query(`UPDATE teachers SET profile_photo = ? WHERE id = ?`, [dataUrl, teacherId]);
        res.json({ success: true, photo: dataUrl });
    } catch (err) {
        console.error('Adviser photo upload error:', err);
        res.status(500).json({ error: 'Upload failed.' });
    }
});

router.post('/adviser-change-password', express.json(), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'adviser') return res.status(403).json({ error: 'Unauthorized' });
    const { current_password, new_password, confirm_password } = req.body;
    if (!current_password || !new_password || !confirm_password) return res.status(400).json({ error: 'All fields are required.' });
    if (new_password !== confirm_password) return res.status(400).json({ error: 'New passwords do not match.' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const teacherId = req.session.user.teacher_id;
    try {
        const [[t]] = await db.query(`SELECT password FROM teachers WHERE id = ?`, [teacherId]);
        if (!t) return res.status(404).json({ error: 'Teacher record not found.' });
        const match = await bcrypt.compare(current_password, t.password);
        if (!match) return res.status(400).json({ error: 'Current password is incorrect.' });
        const hashed = await bcrypt.hash(new_password, 10);
        await db.query(`UPDATE teachers SET password = ? WHERE id = ?`, [hashed, teacherId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Adviser change password error:', err);
        res.status(500).json({ error: 'A server error occurred.' });
    }
});

// ---- Account self-service for users-table roles (super_admin, principal, superintendent, asst_superintendent) ----
async function ensureUserProfileColumns() {
    // MySQL has no `ADD COLUMN IF NOT EXISTS` — probe INFORMATION_SCHEMA first so
    // the column is actually created (a swallowed syntax error leaves it missing).
    const [cols] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME IN ('profile_photo','contact')`
    );
    const names = cols.map((c) => c.COLUMN_NAME);
    if (!names.includes('profile_photo')) await db.query('ALTER TABLE users ADD COLUMN profile_photo MEDIUMTEXT DEFAULT NULL');
    if (!names.includes('contact')) await db.query('ALTER TABLE users ADD COLUMN contact VARCHAR(50) DEFAULT NULL');
}

router.get('/account-data', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
        await ensureUserProfileColumns();
        const [[u]] = await db.query('SELECT id, fullname, email, contact, profile_photo FROM users WHERE id = ?', [req.session.user.id]);
        if (!u) return res.status(404).json({ error: 'Not found' });
        u.session_fullname = req.session.user.fullname || '';
        res.json(u);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/account-update-profile', express.json(), async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const { fullname, email, contact } = req.body;
    if (!fullname || !fullname.trim()) return res.status(400).json({ error: 'Name is required.' });
    try {
        await ensureUserProfileColumns();
        await db.query(
            'UPDATE users SET fullname = ?, email = ?, contact = ? WHERE id = ?',
            [fullname.trim(), (email || '').trim() || null, (contact || '').trim() || null, req.session.user.id]
        );
        req.session.user.fullname = fullname.trim();
        req.session.user.email = (email || '').trim() || null;
        res.json({ success: true, fullname: fullname.trim() });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update profile.' });
    }
});

router.post('/account-upload-photo', upload.single('photo'), async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: 'Only image files are allowed.' });
    try {
        await ensureUserProfileColumns();
        const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        await db.query('UPDATE users SET profile_photo = ? WHERE id = ?', [dataUrl, req.session.user.id]);
        res.json({ success: true, photo: dataUrl });
    } catch (err) {
        console.error('Account photo upload error:', err);
        res.status(500).json({ error: 'Upload failed.' });
    }
});

router.post('/account-change-password', express.json(), async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const { current_password, new_password, confirm_password } = req.body;
    if (!current_password || !new_password || !confirm_password) return res.status(400).json({ error: 'All fields are required.' });
    if (new_password !== confirm_password) return res.status(400).json({ error: 'New passwords do not match.' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    try {
        const [[u]] = await db.query('SELECT password FROM users WHERE id = ?', [req.session.user.id]);
        if (!u) return res.status(404).json({ error: 'Account not found.' });
        const match = await bcrypt.compare(current_password, u.password);
        if (!match) return res.status(400).json({ error: 'Current password is incorrect.' });
        const hashed = await bcrypt.hash(new_password, 10);
        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.session.user.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Account change password error:', err);
        res.status(500).json({ error: 'A server error occurred.' });
    }
});

// Schools list scoped to the current user. Principals only ever see their own
// school; all other roles get every active school.
async function schoolsForUser(req) {
    const u = req.session.user;
    if (u && u.role === 'principal') {
        if (!u.school_id) return [];
        const [rows] = await db.query("SELECT * FROM schools WHERE id = ? AND status = 'active'", [u.school_id]);
        return rows;
    }
    if (u && u.role === 'adviser' && u.teacher_id) {
        const teacher = await loadAdviserTeacher(u.teacher_id);
        if (!teacher || !teacher.school_id) return [];
        const [rows] = await db.query("SELECT * FROM schools WHERE id = ? AND status = 'active'", [teacher.school_id]);
        return rows;
    }
    const [rows] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    return rows;
}

// ---- Attendance ----
router.get('/attendance', async (req, res) => {
    const schools = await schoolsForUser(req);
    res.render('attendance', { title: 'Attendance', page: 'attendance', schools });
});

// ---- Students ----
router.get('/students', async (req, res) => {
    const schools = await schoolsForUser(req);
    const [gradeLevels] = await db.query('SELECT * FROM grade_levels ORDER BY name');
    const [sections] = await db.query('SELECT * FROM sections ORDER BY name');
    res.render('students', { title: 'Students', page: 'students', schools, gradeLevels, sections });
});

// ---- Teachers ----
router.get('/teachers', async (req, res) => {
    const schools = await schoolsForUser(req);
    res.render('teachers', { title: 'Teachers', page: 'teachers', schools });
});

// ---- Schools ----
router.get('/schools', requireRole('super_admin'), async (req, res) => {
    res.render('schools', { title: 'Schools', page: 'schools' });
});

// ---- School Detail ----
router.get('/school/:id', async (req, res) => {
    res.render('school_detail', { title: 'School Details', page: 'schools', schoolId: parseInt(req.params.id, 10) });
});

// ---- Grade Detail (within school) ----
router.get('/school/:schoolId/grade/:gradeId', async (req, res) => {
    res.render('grade_detail', {
        title: 'Grade Details', page: 'schools',
        schoolId: parseInt(req.params.schoolId, 10),
        gradeId: parseInt(req.params.gradeId, 10)
    });
});

// ---- Section Detail (within school/grade) ----
router.get('/school/:schoolId/grade/:gradeId/section/:sectionId', async (req, res) => {
    res.render('section_detail', {
        title: 'Section Details', page: 'schools',
        schoolId: parseInt(req.params.schoolId, 10),
        gradeId: parseInt(req.params.gradeId, 10),
        sectionId: parseInt(req.params.sectionId, 10)
    });
});

// ---- Section Detail (legacy URL without grade) ----
router.get('/school/:schoolId/section/:sectionId', async (req, res) => {
    res.render('section_detail', {
        title: 'Section Details', page: 'schools',
        schoolId: parseInt(req.params.schoolId, 10),
        gradeId: 0,
        sectionId: parseInt(req.params.sectionId, 10)
    });
});

// ---- Manage Schools ----
router.get('/manage-schools', requireRole('super_admin'), async (req, res) => {
    res.render('manage_schools', { title: 'Manage Schools', page: 'manage_schools' });
});

// ---- SHS Students ----
router.get('/shs-students', async (req, res) => {
    const schools = await schoolsForUser(req);
    const [gradeLevels] = await db.query('SELECT * FROM grade_levels ORDER BY name');
    const [sections] = await db.query('SELECT * FROM sections ORDER BY name');
    res.render('shs_students', { title: 'SHS Students', page: 'shs_students', schools, gradeLevels, sections });
});

// ---- Sections ----
router.get('/sections', async (req, res) => {
    const schools = await schoolsForUser(req);
    const [gradeLevels] = await db.query('SELECT * FROM grade_levels ORDER BY name');
    res.render('sections', { title: 'Sections', page: 'sections', schools, gradeLevels });
});

// ---- Users ----
router.get('/users', requireRole('super_admin'), async (req, res) => {
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    res.render('users', { title: 'Users', page: 'users', schools });
});

router.get('/active-users', requireRole('super_admin'), async (req, res) => {
    res.render('active_users', { title: 'Active Users', page: 'active_users' });
});

// ---- Register User ----
router.get('/register-user', requireRole('super_admin'), async (req, res) => {
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    res.render('register_user', { title: 'Register User', page: 'register_user', schools, error: null, success: null });
});

router.post('/register-user', requireRole('super_admin'), async (req, res) => {
    const { username, password, fullname, email, role, school_id } = req.body;
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    if (!username || !password || !fullname || !role) {
        return res.render('register_user', { title: 'Register User', page: 'register_user', schools, error: 'All required fields must be filled.', success: null });
    }
    try {
        const hashed = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (username, password, fullname, email, role, school_id) VALUES (?, ?, ?, ?, ?, ?)',
            [username, hashed, fullname, email || null, role, school_id || null]
        );
        return res.render('register_user', { title: 'Register User', page: 'register_user', schools, error: null, success: 'User registered successfully.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.render('register_user', { title: 'Register User', page: 'register_user', schools, error: 'Username already exists.', success: null });
        }
        console.error('Register user error:', err);
        return res.render('register_user', { title: 'Register User', page: 'register_user', schools, error: 'Failed to register user.', success: null });
    }
});

// ---- Settings ----
router.get('/settings', requireRole('super_admin'), async (req, res) => {
    res.render('settings', { title: 'Settings', page: 'settings' });
});

// ---- User Logs ----
router.get('/user-logs', requireRole('super_admin'), async (req, res) => {
    res.render('user_logs', { title: 'User Logs', page: 'user_logs' });
});

// ---- Notifications ----
router.get('/notifications', async (req, res) => {
    res.render('notifications', { title: 'Notifications', page: 'notifications' });
});

// ---- Announcements (principal / adviser compose page) ----
router.get('/announcements', async (req, res) => {
    res.render('announcements', { title: 'Announcements', page: 'announcements' });
});

// ---- Backups ----
router.get('/backups', requireRole('super_admin'), async (req, res) => {
    res.render('backups', { title: 'Backups', page: 'backups' });
});

// ---- SMS Logs ----
router.get('/sms-logs', requireRole('super_admin'), async (req, res) => {
    res.render('sms_logs', { title: 'SMS Logs', page: 'sms_logs' });
});

// ---- Reports ----
router.get('/reports', async (req, res) => {
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    res.render('reports', { title: 'Reports', page: 'reports', schools });
});

// ---- Events ----
router.get('/events', async (req, res) => {
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    res.render('events', { title: 'Events', page: 'events', schools });
});

// ---- School Days ----
router.get('/school-days', requireRole('super_admin'), async (req, res) => {
    res.render('school_days', { title: 'School Days', page: 'school_days' });
});

// ---- School Years (super_admin) ----
// Admin-only management of the yearly cycle: create years, open one as active
// (closes the others), and close a year to archive its class lists.
router.get('/school-years', requireRole('super_admin'), async (req, res) => {
    try {
        const years = await schoolYears.listSchoolYears();
        res.render('school_years', { title: 'School Years', page: 'school_years', years });
    } catch (err) {
        console.error('School years page error:', err);
        res.render('error', { title: 'Error', message: 'Failed to load school years.', user: req.session.user });
    }
});

router.post('/school-years/create', requireRole('super_admin'), express.json(), async (req, res) => {
    try {
        const year = await schoolYears.createSchoolYear({
            label: req.body.label,
            startDate: req.body.start_date,
            endDate: req.body.end_date,
            makeActive: req.body.make_active === true || req.body.make_active === 'true'
        });
        return res.json({ success: true, year });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message || 'Failed to create school year.' });
    }
});

router.post('/school-years/:id/activate', requireRole('super_admin'), async (req, res) => {
    try {
        const year = await schoolYears.setActiveSchoolYear(req.params.id);
        return res.json({ success: true, year });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message || 'Failed to activate school year.' });
    }
});

router.post('/school-years/:id/close', requireRole('super_admin'), async (req, res) => {
    try {
        const year = await schoolYears.closeSchoolYear(req.params.id);
        return res.json({ success: true, year });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message || 'Failed to close school year.' });
    }
});

router.post('/school-years/:id/update-dates', requireRole('super_admin'), express.json(), async (req, res) => {
    try {
        const year = await schoolYears.updateSchoolYearDates(
            req.params.id,
            req.body.start_date,
            req.body.end_date
        );
        return res.json({ success: true, year });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message || 'Failed to update school year dates.' });
    }
});

// ---- Bulk Import ----
router.get('/bulk-import', requireRole('super_admin'), async (req, res) => {
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    res.render('bulk_import', { title: 'Bulk Import', page: 'bulk_import', schools });
});

// ---- Bulk Import Preview ----
router.post('/bulk-import-preview', requireRole('super_admin'), upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }
    const category = req.body.category || 'student';
    const parsedDefaultSchoolId = parseInt(req.body.school_id, 10);
    const defaultSchoolId = Number.isFinite(parsedDefaultSchoolId) ? parsedDefaultSchoolId : null;
    let rows = [];

    try {
        // Parse file
        const ext = (req.file.originalname || '').toLowerCase();
        if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(req.file.buffer);
            const sheet = workbook.getWorksheet('Template') || workbook.worksheets[0];
            const headerRow = sheet.getRow(1);
            const headers = [];
            headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                let val = '';
                if (cell.value && typeof cell.value === 'object' && cell.value.richText) {
                    val = cell.value.richText.map(rt => rt.text).join('').trim();
                } else {
                    val = String(cell.value || '').trim();
                }
                headers[colNumber] = val.split('\n')[0].trim();
            });
            sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
                if (rowNumber <= 1) return;
                const obj = {};
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    const key = headers[colNumber];
                    if (key) obj[key] = parseExcelCellValue(cell);
                });
                if (Object.values(obj).some(v => v !== '')) {
                    rows.push({ row: obj, rowNum: rowNumber });
                }
            });
        } else {
            const { Readable } = require('stream');
            const csvParser = require('csv-parser');
            await new Promise((resolve, reject) => {
                let rowNum = 0;
                const stream = Readable.from(req.file.buffer.toString());
                stream.pipe(csvParser())
                    .on('data', (row) => { rowNum++; rows.push({ row, rowNum }); })
                    .on('end', resolve)
                    .on('error', reject);
            });
        }

        function parseName(nameStr) {
            if (!nameStr) return { firstname: '', lastname: '', middlename: '' };
            const parts = nameStr.split(',').map(s => s.trim());
            if (parts.length >= 2) {
                return { lastname: parts[0], firstname: parts[1], middlename: parts[2] || '' };
            }
            const words = nameStr.trim().split(/\s+/);
            if (words.length === 1) return { firstname: words[0], lastname: '', middlename: '' };
            if (words.length === 2) return { firstname: words[0], lastname: words[1], middlename: '' };
            return { firstname: words[0], lastname: words[words.length - 1], middlename: words.slice(1, -1).join(' ') };
        }

        const [schools] = await db.query("SELECT id, name, school_id_code, school_code, status FROM schools WHERE status IS NULL OR status != 'deleted' ORDER BY name");
        const fallbackSchool = defaultSchoolId ? schools.find(s => Number(s.id) === Number(defaultSchoolId)) : null;
        const impliedDefaultSchool = fallbackSchool || (schools.length === 1 ? schools[0] : null);

        async function resolveSchoolPreview(schoolName, options = {}) {
            const { allowCreate = false } = options;
            const rawSchoolName = String(schoolName || '').trim();
            if (!rawSchoolName) {
                if (impliedDefaultSchool) return { id: impliedDefaultSchool.id, name: impliedDefaultSchool.name };
                return { id: null, name: '', error: 'School is required. Provide School value or choose a default school.' };
            }

            const matchedSchool = findSchoolMatch(schools, rawSchoolName);
            if (matchedSchool) return { id: matchedSchool.id, name: matchedSchool.name };

            if (!allowCreate) return { id: null, name: rawSchoolName, error: 'School not found' };
            return { id: null, name: rawSchoolName, willCreate: true };
        }

        async function checkGrade(gradeStr, schoolId) {
            if (!gradeStr) return { id: null, name: '' };
            const found = await findGradeByName(gradeStr, schoolId);
            if (found) return found;
            return { id: null, name: formatGradeLabel(gradeStr), willCreate: true };
        }

        async function checkSection(sectionName, schoolId, gradeLevelId) {
            if (!sectionName) return { id: null, name: '' };
            let query = 'SELECT id, name FROM sections WHERE name = ?';
            const params = [sectionName];
            if (schoolId) { query += ' AND school_id = ?'; params.push(schoolId); }
            if (gradeLevelId) { query += ' AND grade_level_id = ?'; params.push(gradeLevelId); }
            query += ' LIMIT 1';
            const [found] = await db.query(query, params);
            if (found.length > 0) return found[0];
            return { id: null, name: sectionName, willCreate: true };
        }

        function validateGradeForSchool(gradeStr, schoolName) {
            if (!gradeStr || !schoolName) return null;
            const g = parseGradeNumber(gradeStr);
            if (!Number.isFinite(g)) return null;
            const schoolLevel = detectSchoolLevel(schoolName);
            if (schoolLevel === 'integrated' || !schoolLevel) return null;
            if (schoolLevel === 'elementary' && g > 6) return 'Grade ' + g + ' is not valid for elementary school';
            if (schoolLevel === 'high' && g < 7) return 'Grade ' + g + ' is not valid for high school';
            return null;
        }

        const preview = [];
        for (const { row, rowNum: rn } of rows) {
            let entry = { row: rn, status: 'ready', error: null };

            if (category === 'teacher' || category === 'shs_teacher') {
                const empId = getRowValue(row, ['Employee ID', 'Teacher ID', 'Teacher/Adviser ID', 'employee_id']) || null;
                const rawName = getRowValue(row, ['Teacher/Adviser Name', 'Adviser Name', 'Teacher Name', 'Name', 'name']);
                const { firstname, lastname, middlename } = parseName(rawName);
                const fn = firstname || row.firstname || '';
                const ln = lastname || row.lastname || '';
                if (!fn && !ln) { entry.status = 'error'; entry.error = 'Missing name'; }

                const schoolName = getRowValue(row, ['School Name', 'School', 'school']);
                const school = await resolveSchoolPreview(schoolName, { allowCreate: true });
                const gradeStr = getRowValue(row, ['Grade Level', 'Grade', 'grade']);
                const categoryGradeErr = validateGradeForImportCategory(gradeStr, category);
                const gradeErr = categoryGradeErr || validateGradeForSchool(gradeStr, school.name || schoolName);
                if (gradeErr) { entry.status = 'error'; entry.error = gradeErr; }
                if (!gradeStr) { entry.status = 'error'; entry.error = 'Grade Level is required for adviser assignment'; }
                const grade = gradeStr && school.id ? await findGradeByName(gradeStr, school.id) : null;

                const trackStrand = category === 'shs_teacher'
                    ? String(getRowValue(row, ['Track/Strand', 'Track', 'Strand']) || '').trim()
                    : '';
                if (category === 'shs_teacher' && !trackStrand) { entry.status = 'error'; entry.error = 'Track/Strand is required for SHS teacher'; }

                const rawSection = String(getRowValue(row, ['Section Name', 'Section', 'section']) || '').trim();
                if (!rawSection) { entry.status = 'error'; entry.error = 'Section Name is required for adviser assignment'; }
                const sectionName = (category === 'shs_teacher' && trackStrand && rawSection)
                    ? trackStrand + ' - ' + rawSection
                    : rawSection;
                let section = null;
                if (sectionName && school.id && grade) {
                    section = await findSectionByName(sectionName, school.id, grade.id);
                    if (!section) section = await findSectionByNameInSchool(sectionName, school.id);
                }
                const contact = getRowValue(row, ['Contact Number', 'Contact', 'Phone', 'Mobile', 'contact_number']);
                const email = getRowValue(row, ['Email/DepEd Email', 'Email/Deped Email', 'DepEd Email', 'Deped Email', 'Email', 'Email Address', 'email']);
                if (!email) { entry.status = 'error'; entry.error = 'Email/DepEd Email is required'; }
                const qr_code = empId ? 'TCH-' + empId : 'TCH-auto';

                // Check if existing
                if (entry.status !== 'error') {
                    const existing = await findTeacherMatch(empId, fn, ln, middlename, school.id);
                    if (existing) entry.status = existing.status === 'deleted' ? 'restore' : 'update';
                }

                entry.empId = empId;
                entry.name = ln && fn ? ln + ', ' + fn : fn || ln;
                entry.school = school.name || '';
                if (school.willCreate) entry.school += ' (new)';
                entry.grade = grade ? grade.name : formatGradeLabel(gradeStr);
                if (gradeStr && !grade) entry.grade += ' (new)';
                entry.track = trackStrand;
                entry.section = section ? section.name : sectionName;
                if (rawSection && !section) entry.section += ' (new)';
                entry.contact = contact;
                entry.email = email;
                entry.qr_code = qr_code;
                if (school.error) { entry.status = 'error'; entry.error = school.error; }
            } else {
                const lrn = getRowValue(row, ['LRN', 'lrn']) || null;
                const rawName = getRowValue(row, ['Student Name', 'Learner Name', 'Name', 'student_name']);
                const { firstname, lastname, middlename } = parseName(rawName);
                const fn = firstname || row.firstname || '';
                const ln = lastname || row.lastname || '';
                if (!fn && !ln) { entry.status = 'error'; entry.error = 'Student name is missing — check the Name column'; }

                const sexRaw = getRowValue(row, ['Sex', 'Gender', 'sex', 'gender']);
                const sex = parseSexValue(sexRaw);
                if (sexRaw && !sex && entry.status !== 'error') {
                    entry.status = 'error';
                    entry.error = 'Invalid Sex value "' + sexRaw + '" (use Male or Female)';
                }

                const schoolName = getRowValue(row, ['School Name', 'School', 'school']);
                const school = await resolveSchoolPreview(schoolName);
                const gradeStr = getRowValue(row, ['Grade Level', 'Grade', 'grade']);
                const categoryGradeErr = validateGradeForImportCategory(gradeStr, category);
                const gradeErr = categoryGradeErr || validateGradeForSchool(gradeStr, school.name || schoolName);
                if (gradeErr) { entry.status = 'error'; entry.error = gradeErr; }
                const grade = gradeStr ? await checkGrade(gradeStr, school.id) : { id: null, name: '' };
                const trackStrand = String(getRowValue(row, ['Track/Strand', 'Track', 'Strand']) || '').trim();
                if (category === 'shs_student' && !trackStrand) { entry.status = 'error'; entry.error = 'Track/Strand is required for SHS'; }
                const rawSection = String(getRowValue(row, ['Section Name', 'Section', 'section']) || '').trim();
                const sectionName = (category === 'shs_student' && trackStrand && rawSection)
                    ? trackStrand + ' - ' + rawSection
                    : rawSection;
                const section = sectionName ? await checkSection(sectionName, school.id, grade.id) : { id: null, name: '' };
                const guardianContact = getRowValue(row, ['Guardian Contact', 'Guardian Phone', 'Contact Number', 'guardian_contact']) || '';
                const qr_code = lrn ? 'STU-' + lrn : 'STU-auto';

                // Check if existing
                if (lrn && entry.status !== 'error') {
                    const [existing] = await db.query('SELECT id, status FROM students WHERE lrn = ?', [lrn]);
                    if (existing.length > 0) {
                        entry.status = existing[0].status === 'deleted' ? 'restore' : 'update';
                    }
                }

                entry.lrn = lrn;
                entry.name = ln && fn ? ln + ', ' + fn : fn || ln;
                entry.sex = sex || '';
                entry.school = school.name || '';
                entry.grade = grade.name || '';
                entry.track = trackStrand;
                entry.section = section.name || '';
                entry.guardian = guardianContact;
                entry.qr_code = qr_code;
                if (school.error) { entry.status = 'error'; entry.error = school.error; }
            }

            preview.push(entry);
        }

        const validCount = preview.filter(p => p.status !== 'error').length;
        return res.json({ success: true, preview, validCount, total: rows.length, category });
    } catch (err) {
        console.error('Bulk import preview error:', err);
        return res.status(400).json({ error: 'Failed to parse file: ' + err.message });
    }
});

router.post('/bulk-import', requireRole('super_admin'), upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }
    const category = req.body.category || 'student'; // student, teacher, shs_student
    const parsedDefaultSchoolId = parseInt(req.body.school_id, 10);
    const defaultSchoolId = Number.isFinite(parsedDefaultSchoolId) ? parsedDefaultSchoolId : null;
    const requestedActiveFrom = String(req.body.active_from || '').trim();
    const importActiveFrom = /^\d{4}-\d{2}-\d{2}$/.test(requestedActiveFrom)
        ? requestedActiveFrom
        : todayDate();
    const errors = [];
    let imported = 0;
    let updated = 0;
    let rows = [];

    try {
        // Parse file — support both XLSX and CSV
        const ext = (req.file.originalname || '').toLowerCase();
        if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(req.file.buffer);
            const sheet = workbook.getWorksheet('Template') || workbook.worksheets[0];
            const headerRow = sheet.getRow(1);
            const headers = [];
            headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                let val = '';
                if (cell.value && typeof cell.value === 'object' && cell.value.richText) {
                    val = cell.value.richText.map(rt => rt.text).join('').trim();
                } else {
                    val = String(cell.value || '').trim();
                }
                headers[colNumber] = val.split('\n')[0].trim();
            });
            sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
                if (rowNumber <= 1) return;
                const obj = {};
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    const key = headers[colNumber];
                    if (key) obj[key] = parseExcelCellValue(cell);
                });
                if (Object.values(obj).some(v => v !== '')) {
                    rows.push({ row: obj, rowNum: rowNumber });
                }
            });
        } else {
            // CSV fallback
            const { Readable } = require('stream');
            const csvParser = require('csv-parser');
            await new Promise((resolve, reject) => {
                let rowNum = 0;
                const stream = Readable.from(req.file.buffer.toString());
                stream.pipe(csvParser())
                    .on('data', (row) => { rowNum++; rows.push({ row, rowNum }); })
                    .on('end', resolve)
                    .on('error', reject);
            });
        }

        // Helper: parse "Last Name, First Name, Middle Name" or "First Name Last Name"
        function parseName(nameStr) {
            if (!nameStr) return { firstname: '', lastname: '', middlename: '' };
            const parts = nameStr.split(',').map(s => s.trim());
            if (parts.length >= 2) {
                return { lastname: parts[0], firstname: parts[1], middlename: parts[2] || '' };
            }
            const words = nameStr.trim().split(/\s+/);
            if (words.length === 1) return { firstname: words[0], lastname: '', middlename: '' };
            if (words.length === 2) return { firstname: words[0], lastname: words[1], middlename: '' };
            return { firstname: words[0], lastname: words[words.length - 1], middlename: words.slice(1, -1).join(' ') };
        }

        const importedTeacherStatus = 'inactive';
        const defaultImportedStudentStatus = 'inactive';

        const [schools] = await db.query("SELECT id, name, school_id_code, school_code, status FROM schools WHERE status IS NULL OR status != 'deleted' ORDER BY name");
        const fallbackSchool = defaultSchoolId ? schools.find(s => Number(s.id) === Number(defaultSchoolId)) : null;
        const impliedDefaultSchool = fallbackSchool || (schools.length === 1 ? schools[0] : null);

        // Helper: resolve school_id by name
        async function resolveSchool(schoolName, options = {}) {
            const { allowCreate = false } = options;
            const rawSchoolName = String(schoolName || '').trim();
            if (!rawSchoolName) {
                if (impliedDefaultSchool) return { id: impliedDefaultSchool.id, name: impliedDefaultSchool.name };
                return { id: null, name: '', error: 'School is required. Provide School value or choose a default school.' };
            }

            const matchedSchool = findSchoolMatch(schools, rawSchoolName);
            if (matchedSchool) return { id: matchedSchool.id, name: matchedSchool.name };

            if (!allowCreate) return { id: null, name: rawSchoolName, error: 'School not found' };
            const createdSchool = await createSchoolRecord(rawSchoolName);
            schools.push(createdSchool);
            return { id: createdSchool.id, name: createdSchool.name, created: true };
        }

        // Helper: resolve grade_level_id by grade number (auto-creates if missing)
        async function resolveGrade(gradeStr, schoolId) {
            if (!gradeStr) return null;
            const g = String(gradeStr).trim();
            const found = await findGradeByName(g, schoolId);
            if (found) return found.id;
            const name = formatGradeLabel(g);
            const [result] = await db.query('INSERT INTO grade_levels (name, school_id) VALUES (?, ?)', [name, schoolId || null]);
            return result.insertId;
        }

        // Helper: resolve or create section
        async function resolveSection(sectionName, schoolId, gradeLevelId, options = {}) {
            const { allowSchoolWideFallback = false } = options;
            if (!sectionName) return null;
            const found = await findSectionByName(sectionName, schoolId, gradeLevelId);
            if (found) return found.id;
            if (allowSchoolWideFallback) {
                const sameSchoolSection = await findSectionByNameInSchool(sectionName, schoolId);
                if (sameSchoolSection) {
                    return sameSchoolSection.id;
                }
            }
            const [result] = await db.query('INSERT INTO sections (name, school_id, grade_level_id) VALUES (?, ?, ?)', [sectionName, schoolId || null, gradeLevelId || null]);
            return result.insertId;
        }

        // Helper: validate grade vs school type
        function validateGradeForSchool(gradeStr, schoolName) {
            if (!gradeStr || !schoolName) return null;
            const g = parseGradeNumber(gradeStr);
            if (!Number.isFinite(g)) return null;
            const schoolLevel = detectSchoolLevel(schoolName);
            if (schoolLevel === 'integrated' || !schoolLevel) return null;
            if (schoolLevel === 'elementary' && g > 6) return 'Grade ' + g + ' is not valid for elementary school "' + schoolName + '" (only Grades 1-6)';
            if (schoolLevel === 'high' && g < 7) return 'Grade ' + g + ' is not valid for high school "' + schoolName + '" (only Grades 7-12)';
            return null;
        }

        for (const { row, rowNum: rn } of rows) {
            try {
                if (category === 'teacher' || category === 'shs_teacher') {
                    // Format: Employee ID, Teacher/Adviser Name, School, Grade, [Track/Strand,] Section, Contact, Email
                    const empId = getRowValue(row, ['Employee ID', 'Teacher ID', 'Teacher/Adviser ID', 'employee_id']) || null;
                    const rawName = getRowValue(row, ['Teacher/Adviser Name', 'Adviser Name', 'Teacher Name', 'Name', 'name']);
                    const { firstname, lastname, middlename } = parseName(rawName);

                    if (!firstname && !lastname) {
                        // Fallback: try old format
                        if (!row.firstname && !row.lastname) {
                            errors.push({ row: rn, message: 'Missing name' });
                            continue;
                        }
                    }
                    const fn = firstname || row.firstname || '';
                    const ln = lastname || row.lastname || '';
                    const mn = middlename || row.middlename || '';
                    if (!fn && !ln) { errors.push({ row: rn, message: 'Missing name' }); continue; }

                    const schoolInfo = await resolveSchool(
                        getRowValue(row, ['School Name', 'School', 'school']),
                        { allowCreate: true }
                    );
                    if (schoolInfo.error) { errors.push({ row: rn, message: schoolInfo.error }); continue; }
                    const schoolId = schoolInfo.id;
                    const gradeStr = getRowValue(row, ['Grade Level', 'Grade', 'grade']);
                    if (!gradeStr) { errors.push({ row: rn, message: 'Grade Level is required for adviser assignment.' }); continue; }
                    // Validate grade vs school type
                    const schoolName = schoolInfo.name || getRowValue(row, ['School Name', 'School', 'school']);
                    const categoryGradeErr = validateGradeForImportCategory(gradeStr, category);
                    const gradeErr = categoryGradeErr || validateGradeForSchool(gradeStr, schoolName);
                    if (gradeErr) { errors.push({ row: rn, message: gradeErr }); continue; }
                    let gradeId = await resolveGrade(gradeStr, schoolId);

                    // SHS teacher: require Track/Strand and compose section name
                    const trackStrand = category === 'shs_teacher'
                        ? String(getRowValue(row, ['Track/Strand', 'Track', 'Strand']) || '').trim()
                        : '';
                    if (category === 'shs_teacher' && !trackStrand) { errors.push({ row: rn, message: 'Track/Strand is required for SHS teacher.' }); continue; }

                    const rawSection = String(getRowValue(row, ['Section Name', 'Section', 'section']) || '').trim();
                    if (!rawSection) { errors.push({ row: rn, message: 'Section Name is required for adviser assignment.' }); continue; }
                    const sectionName = (category === 'shs_teacher' && trackStrand && rawSection)
                        ? trackStrand + ' - ' + rawSection
                        : rawSection;
                    const sectionId = await resolveSection(sectionName, schoolId, gradeId, { allowSchoolWideFallback: true });
                    const [[sectionMeta]] = await db.query(
                        'SELECT grade_level_id FROM sections WHERE id = ? LIMIT 1',
                        [sectionId]
                    );
                    if (sectionMeta && sectionMeta.grade_level_id && Number(sectionMeta.grade_level_id) !== Number(gradeId)) {
                        gradeId = sectionMeta.grade_level_id;
                    }
                    const contact = getRowValue(row, ['Contact Number', 'Contact', 'Phone', 'Mobile', 'contact_number']) || null;
                    const email = getRowValue(row, ['Email/DepEd Email', 'Email/Deped Email', 'DepEd Email', 'Deped Email', 'Email', 'Email Address', 'email']) || null;
                    if (!email) { errors.push({ row: rn, message: 'Email/DepEd Email is required.' }); continue; }
                    const adviserName = displayName(fn, ln, mn);

                    const existing = await findTeacherMatch(empId, fn, ln, mn, schoolId);
                    if (existing) {
                        const existingStatus = existing.status || importedTeacherStatus;
                        const nextStatus = existingStatus === 'deleted' ? importedTeacherStatus : existingStatus;
                        const nextActiveFrom = nextStatus === 'active'
                            ? (existing.active_from || importActiveFrom)
                            : null;
                        if (existing.section_id && Number(existing.section_id) !== Number(sectionId)) {
                            await db.query(
                                'UPDATE sections SET adviser = NULL, adviser_teacher_id = NULL WHERE id = ? AND adviser_teacher_id = ?',
                                [existing.section_id, existing.id]
                            );
                        }
                        await db.query(
                            `UPDATE teachers
                             SET employee_id=?, firstname=?, lastname=?, middlename=?, contact=?, email=?,
                                 school_id=?, grade_level_id=?, section_id=?, active_from=?, status=?
                             WHERE id=?`,
                            [empId || null, fn, ln, mn || null, contact, email, schoolId, gradeId, sectionId, nextActiveFrom, nextStatus, existing.id]
                        );
                        await db.query(
                            'UPDATE sections SET adviser = ?, adviser_teacher_id = ? WHERE id = ?',
                            [adviserName, existing.id, sectionId]
                        );
                        updated++;
                        continue;
                    }

                    const qr_code = empId ? 'TCH-' + empId : 'TCH-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                    const teacherCategory = category === 'shs_teacher' ? 'shs_teacher' : 'teacher';
                    const [teacherResult] = await db.query(
                        `INSERT INTO teachers
                            (employee_id, firstname, lastname, middlename, contact, email, school_id, grade_level_id, section_id, qr_code, active_from, status, category)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                        [empId, fn, ln, mn || null, contact, email, schoolId, gradeId, sectionId, qr_code, null, importedTeacherStatus, teacherCategory]
                    );
                    await db.query(
                        'UPDATE sections SET adviser = ?, adviser_teacher_id = ? WHERE id = ?',
                        [adviserName, teacherResult.insertId, sectionId]
                    );
                    imported++;
                } else {
                    // student or shs_student
                    // New format: LRN, Student Name, School, Grade, [Track/Strand], Section, Guardian Contact
                    const lrn = getRowValue(row, ['LRN', 'lrn']) || null;
                    const rawName = getRowValue(row, ['Student Name', 'Learner Name', 'Name', 'student_name']);
                    const { firstname, lastname, middlename } = parseName(rawName);

                    if (!firstname && !lastname) {
                        if (!row.firstname && !row.lastname) {
                            errors.push({ row: rn, message: 'Missing student name' });
                            continue;
                        }
                    }
                    const fn = firstname || row.firstname || '';
                    const ln = lastname || row.lastname || '';
                    const mn = middlename || row.middlename || '';
                    if (!fn && !ln) { errors.push({ row: rn, message: 'Missing student name' }); continue; }

                    const schoolInfo = await resolveSchool(getRowValue(row, ['School Name', 'School', 'school']));
                    if (schoolInfo.error) { errors.push({ row: rn, message: schoolInfo.error }); continue; }
                    const schoolId = schoolInfo.id;
                    const gradeStr = getRowValue(row, ['Grade Level', 'Grade', 'grade']);
                    // Validate grade vs school type
                    const schoolName = schoolInfo.name || getRowValue(row, ['School Name', 'School', 'school']);
                    const categoryGradeErr = validateGradeForImportCategory(gradeStr, category);
                    const gradeErr = categoryGradeErr || validateGradeForSchool(gradeStr, schoolName);
                    if (gradeErr) { errors.push({ row: rn, message: gradeErr }); continue; }
                    const gradeId = await resolveGrade(gradeStr, schoolId);
                    const trackStrand = String(getRowValue(row, ['Track/Strand', 'Track', 'Strand']) || '').trim();
                    if (category === 'shs_student' && !trackStrand) { errors.push({ row: rn, message: 'Track/Strand is required for SHS' }); continue; }
                    const rawSection = String(getRowValue(row, ['Section Name', 'Section', 'section']) || '').trim();
                    const composedSection = (category === 'shs_student' && trackStrand && rawSection)
                        ? trackStrand + ' - ' + rawSection
                        : rawSection;
                    const sectionId = await resolveSection(composedSection, schoolId, gradeId);
                    const guardianContact = getRowValue(row, ['Guardian Contact', 'Guardian Phone', 'Contact Number', 'guardian_contact']) || null;
                    const sex = parseSexValue(getRowValue(row, ['Sex', 'Gender', 'sex', 'gender']));

                    if (lrn) {
                        const [existing] = await db.query('SELECT id, status, active_from, gender FROM students WHERE lrn = ?', [lrn]);
                        if (existing.length > 0) {
                            const existingStatus = existing[0].status || defaultImportedStudentStatus;
                            const nextStatus = existingStatus === 'deleted' ? defaultImportedStudentStatus : existingStatus;
                            const nextActiveFrom = nextStatus === 'active'
                                ? (existing[0].active_from || importActiveFrom)
                                : null;
                            // Keep the existing gender when the file omits Sex
                            const nextGender = sex || existing[0].gender || null;
                            await db.query(
                                'UPDATE students SET firstname=?, lastname=?, middlename=?, gender=?, school_id=?, grade_level_id=?, section_id=?, guardian_contact=?, category=?, active_from=?, status=? WHERE id=?',
                                [fn, ln, mn || null, nextGender, schoolId || null, gradeId || null, sectionId || null, guardianContact, category, nextActiveFrom, nextStatus, existing[0].id]
                            );
                            updated++;
                            continue;
                        }
                    }
                    const qr_code = lrn ? 'STU-' + lrn : 'STU-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                    await db.query(
                        'INSERT INTO students (lrn, firstname, lastname, middlename, gender, school_id, grade_level_id, section_id, guardian_contact, qr_code, category, active_from, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                        [lrn, fn, ln, mn || null, sex, schoolId || null, gradeId || null, sectionId || null, guardianContact, qr_code, category, null, defaultImportedStudentStatus]
                    );
                    imported++;
                }
            } catch (err) {
                errors.push({ row: rn, message: err.message });
            }
        }

        return res.json({ success: true, imported, updated, errors, total: rows.length });
    } catch (err) {
        console.error('Bulk import error:', err);
        return res.status(400).json({ error: 'Failed to parse file: ' + err.message });
    }
});

// ---- Print QR Codes ----
function getPrintQrFilters(query) {
    const schoolId = query.school_id;
    const gradeLevelId = query.grade_level_id;
    const sectionId = query.section_id;
    const layout = ['3', '4', '5'].includes(String(query.layout || '')) ? String(query.layout) : '4';
    const type = query.type === 'teacher' ? 'teacher' : 'student';

    return {
        type,
        schoolId,
        gradeLevelId,
        sectionId,
        layout,
        studentId: query.student_id ? parseInt(query.student_id, 10) : null,
        teacherId: query.teacher_id ? parseInt(query.teacher_id, 10) : null,
        viewFilters: {
            type,
            school_id: schoolId || '',
            grade_level_id: gradeLevelId || '',
            section_id: sectionId || '',
            layout
        }
    };
}

async function getPrintQrPeople(filters) {
    let people = [];

    if (filters.type === 'teacher') {
        let query = `SELECT t.id, t.firstname, t.lastname, t.employee_id, t.qr_code,
                    sc.name AS school_name, gl.name AS grade_name, sec.name AS section_name
                FROM teachers t
                LEFT JOIN schools sc ON t.school_id = sc.id
                LEFT JOIN grade_levels gl ON t.grade_level_id = gl.id
                LEFT JOIN sections sec ON t.section_id = sec.id
                WHERE t.status != 'deleted'`;
        const params = [];
        if (filters.teacherId) { query += ' AND t.id = ?'; params.push(filters.teacherId); }
        if (filters.schoolId) { query += ' AND t.school_id = ?'; params.push(filters.schoolId); }
        if (filters.gradeLevelId) { query += ' AND t.grade_level_id = ?'; params.push(filters.gradeLevelId); }
        if (filters.sectionId) { query += ' AND t.section_id = ?'; params.push(filters.sectionId); }
        query += ' ORDER BY t.lastname, t.firstname';
        [people] = await db.query(query, params);
    } else {
        let query = "SELECT s.id, s.firstname, s.lastname, s.lrn, s.qr_code, sc.name AS school_name, gl.name AS grade_name, sec.name AS section_name FROM students s LEFT JOIN schools sc ON s.school_id = sc.id LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id LEFT JOIN sections sec ON s.section_id = sec.id WHERE s.status != 'deleted'";
        const params = [];
        if (filters.studentId) { query += ' AND s.id = ?'; params.push(filters.studentId); }
        if (filters.schoolId) { query += ' AND s.school_id = ?'; params.push(filters.schoolId); }
        if (filters.gradeLevelId) { query += ' AND s.grade_level_id = ?'; params.push(filters.gradeLevelId); }
        if (filters.sectionId) { query += ' AND s.section_id = ?'; params.push(filters.sectionId); }
        query += ' ORDER BY s.lastname, s.firstname';
        [people] = await db.query(query, params);
    }

    const qrPromises = people.map(async (p) => {
        const qrDataUrl = await QRCode.toDataURL(p.qr_code, { width: 200, margin: 1 });
        return { ...p, qrDataUrl };
    });
    return Promise.all(qrPromises);
}

router.get('/print-qr/data', async (req, res) => {
    try {
        const user = req.session.user;
        if (user.role === 'adviser' && user.teacher_id) {
            const t = await loadAdviserTeacher(user.teacher_id);
            if (t && t.section_id) {
                req.query.type = 'student';
                req.query.school_id = String(t.school_id);
                req.query.grade_level_id = String(t.grade_level_id);
                req.query.section_id = String(t.section_id);
            }
        }
        const filters = getPrintQrFilters(req.query);
        const people = await getPrintQrPeople(filters);
        return res.json({ success: true, people, filters: filters.viewFilters });
    } catch (err) {
        console.error('Print QR data error:', err);
        return res.status(500).json({ success: false, error: 'Failed to load QR codes.' });
    }
});

router.get('/print-qr', async (req, res) => {
    try {
        const user = req.session.user;
        let adviserScope = null;
        let teacherQr = null;

        if (user.role === 'adviser' && user.teacher_id) {
            const t = await loadAdviserTeacher(user.teacher_id);
            if (t && t.section_id) {
                adviserScope = { school_id: t.school_id, grade_level_id: t.grade_level_id, section_id: t.section_id };
                req.query.type = 'student';
                req.query.school_id = String(t.school_id);
                req.query.grade_level_id = String(t.grade_level_id);
                req.query.section_id = String(t.section_id);
            }
            // fetch teacher's own QR card
            const [[tData]] = await db.query(
                `SELECT t.id, t.firstname, t.lastname, t.middlename, t.employee_id, t.qr_code,
                        sc.name AS school_name, gl.name AS grade_name, sec.name AS section_name
                 FROM teachers t
                 LEFT JOIN sections sec ON t.section_id = sec.id
                 LEFT JOIN schools sc ON sc.id = COALESCE(sec.school_id, t.school_id)
                 LEFT JOIN grade_levels gl ON gl.id = COALESCE(sec.grade_level_id, t.grade_level_id)
                 WHERE t.id = ?`,
                [user.teacher_id]
            );
            if (tData && tData.qr_code) {
                teacherQr = { ...tData, qrDataUrl: await QRCode.toDataURL(tData.qr_code, { width: 200, margin: 1 }) };
            }
        }

        const filters = getPrintQrFilters(req.query);
        const peopleWithQR = await getPrintQrPeople(filters);

        const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
        res.render('print_qr', {
            title: 'Print QR Codes',
            page: 'print_qr',
            people: peopleWithQR,
            type: filters.type,
            schools,
            filters: filters.viewFilters,
            adviserScope: adviserScope,
            teacherQr: teacherQr
        });
    } catch (err) {
        console.error('Print QR error:', err);
        res.render('error', { title: 'Error', message: 'Failed to generate QR codes.', user: req.session.user });
    }
});

module.exports = router;
