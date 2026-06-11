const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const QRCode = require('qrcode');
const { Readable } = require('stream');
const router = express.Router();
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getScannerKioskToken } = require('../utils/scannerKiosk');
const { todayDate } = require('../utils/appTime');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

// Helper: get correct dashboard URL for a role
function getDashboardUrl(role) {
    switch (role) {
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

function formatGradeLabel(value) {
    const key = normalizeGradeKey(value);
    const numberMatch = key.match(/^grade\s+(\d+)$/);
    if (numberMatch) return `Grade ${parseInt(numberMatch[1], 10)}`;
    return String(value || '').trim().replace(/\s+/g, ' ');
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

    for (const school of schools) {
        const keys = [school.name, school.school_id_code, school.school_code];
        for (const rawKey of keys) {
            const key = normalizeSchoolKey(rawKey);
            if (key && key === target) return school;
            const meaningKey = normalizeSchoolMeaningKey(rawKey);
            if (meaningKey && targetMeaning && meaningKey === targetMeaning) return school;
        }
    }

    for (const school of schools) {
        const key = normalizeSchoolKey(school.name);
        if (!key) continue;
        if (key.includes(target) || target.includes(key)) return school;
    }

    // Token-based fuzzy fallback (handles extra middle tokens like "Agripino Alvarez" vs "Agripino").
    let best = null;
    const bestCandidates = [];
    let bestScore = 0;
    for (const school of schools) {
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
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    res.render('dashboard', { title: 'Dashboard', page: 'dashboard', schools });
});

router.get('/principal-dashboard', async (req, res) => {
    const role = req.session.user.role;
    if (role !== 'principal') {
        return res.redirect(getDashboardUrl(role));
    }
    const schoolId = req.session.user.school_id;
    const [schools] = schoolId
        ? await db.query("SELECT * FROM schools WHERE id = ? AND status = 'active'", [schoolId])
        : await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    res.render('principal_dashboard', { title: 'Principal Dashboard', page: 'principal_dashboard', schools });
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
        const [teacher] = await db.query(
            `SELECT t.*, sc.name as school_name, sc.logo as school_logo, gl.name as grade_name, sec.name as section_name, sec.id as section_id
             FROM teachers t
             LEFT JOIN schools sc ON t.school_id = sc.id
             LEFT JOIN grade_levels gl ON t.grade_level_id = gl.id
             LEFT JOIN sections sec ON t.section_id = sec.id
             WHERE t.id = ?`, [teacherId]
        );
        if (teacher.length === 0) {
            return res.render('error', { title: 'Teacher Not Found', message: 'The linked teacher record was not found.', user: req.session.user });
        }
        res.render('adviser_dashboard', { title: 'Adviser Dashboard', page: 'adviser_dashboard', teacher: teacher[0] });
    } catch (err) {
        console.error('Adviser dashboard error:', err);
        return res.render('error', { title: 'Error', message: 'Failed to load adviser dashboard.', user: req.session.user });
    }
});

// ---- Attendance ----
router.get('/attendance', async (req, res) => {
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    res.render('attendance', { title: 'Attendance', page: 'attendance', schools });
});

// ---- Students ----
router.get('/students', async (req, res) => {
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    const [gradeLevels] = await db.query('SELECT * FROM grade_levels ORDER BY name');
    const [sections] = await db.query('SELECT * FROM sections ORDER BY name');
    res.render('students', { title: 'Students', page: 'students', schools, gradeLevels, sections });
});

// ---- Teachers ----
router.get('/teachers', async (req, res) => {
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
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
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    const [gradeLevels] = await db.query('SELECT * FROM grade_levels ORDER BY name');
    const [sections] = await db.query('SELECT * FROM sections ORDER BY name');
    res.render('shs_students', { title: 'SHS Students', page: 'shs_students', schools, gradeLevels, sections });
});

// ---- Sections ----
router.get('/sections', async (req, res) => {
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    const [gradeLevels] = await db.query('SELECT * FROM grade_levels ORDER BY name');
    res.render('sections', { title: 'Sections', page: 'sections', schools, gradeLevels });
});

// ---- Users ----
router.get('/users', requireRole('super_admin'), async (req, res) => {
    const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
    res.render('users', { title: 'Users', page: 'users', schools });
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

        async function checkGrade(gradeStr) {
            if (!gradeStr) return { id: null, name: '' };
            const g = String(gradeStr).trim();
            const [found] = await db.query('SELECT id, name FROM grade_levels WHERE name LIKE ? OR name LIKE ? LIMIT 1', ['%' + g, 'Grade ' + g]);
            if (found.length > 0) return found[0];
            return { id: null, name: 'Grade ' + g, willCreate: true };
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
            const g = parseInt(gradeStr, 10);
            if (isNaN(g)) return null;
            const nameUpper = schoolName.toUpperCase();
            const isIntegrated = nameUpper.includes('INTEGRATED');
            if (isIntegrated) return null;
            const isHighSchool = nameUpper.includes('NATIONAL HIGH SCHOOL') || nameUpper.includes('FARM SCHOOL');
            const isElementary = nameUpper.includes('ELEMENTARY') || nameUpper.includes('PRIMARY');
            if (isElementary && g > 6) return 'Grade ' + g + ' is not valid for elementary school';
            if (isHighSchool && g < 7) return 'Grade ' + g + ' is not valid for high school';
            return null;
        }

        const preview = [];
        for (const { row, rowNum: rn } of rows) {
            let entry = { row: rn, status: 'ready', error: null };

            if (category === 'teacher') {
                const empId = getRowValue(row, ['Employee ID', 'Teacher ID', 'Teacher/Adviser ID', 'employee_id']) || null;
                const rawName = getRowValue(row, ['Teacher/Adviser Name', 'Adviser Name', 'Teacher Name', 'Name', 'name']);
                const { firstname, lastname, middlename } = parseName(rawName);
                const fn = firstname || row.firstname || '';
                const ln = lastname || row.lastname || '';
                if (!fn && !ln) { entry.status = 'error'; entry.error = 'Missing name'; }

                const schoolName = getRowValue(row, ['School Name', 'School', 'school']);
                const school = await resolveSchoolPreview(schoolName, { allowCreate: true });
                const gradeStr = getRowValue(row, ['Grade Level', 'Grade', 'grade']);
                const gradeErr = validateGradeForSchool(gradeStr, school.name || schoolName);
                if (gradeErr) { entry.status = 'error'; entry.error = gradeErr; }
                if (!gradeStr) { entry.status = 'error'; entry.error = 'Grade Level is required for adviser assignment'; }
                const grade = gradeStr && school.id ? await findGradeByName(gradeStr, school.id) : null;
                const sectionName = getRowValue(row, ['Section Name', 'Section', 'section']);
                if (!sectionName) { entry.status = 'error'; entry.error = 'Section Name is required for adviser assignment'; }
                let section = null;
                if (sectionName && school.id && grade) {
                    section = await findSectionByName(sectionName, school.id, grade.id);
                    if (!section) section = await findSectionByNameInSchool(sectionName, school.id);
                }
                const contact = getRowValue(row, ['Contact Number', 'Contact', 'Phone', 'Mobile', 'contact_number']);
                const email = getRowValue(row, ['Email', 'Email Address', 'email']);
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
                entry.section = section ? section.name : String(sectionName || '').trim();
                if (sectionName && !section) entry.section += ' (new)';
                entry.contact = email || contact;
                entry.qr_code = qr_code;
                if (school.error) { entry.status = 'error'; entry.error = school.error; }
            } else {
                const lrn = row['LRN'] || row['lrn'] || null;
                const rawName = row['Student Name'] || row['student_name'] || '';
                const { firstname, lastname, middlename } = parseName(rawName);
                const fn = firstname || row.firstname || '';
                const ln = lastname || row.lastname || '';
                if (!fn && !ln) { entry.status = 'error'; entry.error = 'Missing student name'; }

                const schoolName = row['School'] || row['school'] || '';
                const school = await resolveSchoolPreview(schoolName);
                const gradeStr = row['Grade'] || row['grade'];
                const gradeErr = validateGradeForSchool(gradeStr, school.name || schoolName);
                if (gradeErr) { entry.status = 'error'; entry.error = gradeErr; }
                const grade = gradeStr ? await checkGrade(gradeStr) : { id: null, name: '' };
                const trackStrand = String(row['Track/Strand'] || row['Track'] || row['Strand'] || '').trim();
                if (category === 'shs_student' && !trackStrand) { entry.status = 'error'; entry.error = 'Track/Strand is required for SHS'; }
                const rawSection = String(row['Section'] || row['section'] || '').trim();
                const sectionName = (category === 'shs_student' && trackStrand && rawSection)
                    ? trackStrand + ' - ' + rawSection
                    : rawSection;
                const section = sectionName ? await checkSection(sectionName, school.id, grade.id) : { id: null, name: '' };
                const guardianContact = row['Guardian Contact'] || row['guardian_contact'] || '';
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
            const g = parseInt(gradeStr, 10);
            if (isNaN(g)) return null;
            const nameUpper = schoolName.toUpperCase();
            const isIntegrated = nameUpper.includes('INTEGRATED');
            if (isIntegrated) return null; // integrated schools accept grades 1-12
            const isHighSchool = nameUpper.includes('NATIONAL HIGH SCHOOL') || nameUpper.includes('FARM SCHOOL');
            const isElementary = nameUpper.includes('ELEMENTARY') || nameUpper.includes('PRIMARY');
            if (isElementary && g > 6) return 'Grade ' + g + ' is not valid for elementary school "' + schoolName + '" (only Grades 1-6)';
            if (isHighSchool && g < 7) return 'Grade ' + g + ' is not valid for high school "' + schoolName + '" (only Grades 7-12)';
            return null;
        }

        for (const { row, rowNum: rn } of rows) {
            try {
                if (category === 'teacher') {
                    // New format: Employee ID, Teacher/Adviser Name, School, Grade, Section, Contact Number/Email
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
                    const gradeErr = validateGradeForSchool(gradeStr, schoolName);
                    if (gradeErr) { errors.push({ row: rn, message: gradeErr }); continue; }
                    let gradeId = await resolveGrade(gradeStr, schoolId);
                    const sectionName = getRowValue(row, ['Section Name', 'Section', 'section']);
                    if (!sectionName) { errors.push({ row: rn, message: 'Section Name is required for adviser assignment.' }); continue; }
                    const sectionId = await resolveSection(sectionName, schoolId, gradeId, { allowSchoolWideFallback: true });
                    const [[sectionMeta]] = await db.query(
                        'SELECT grade_level_id FROM sections WHERE id = ? LIMIT 1',
                        [sectionId]
                    );
                    if (sectionMeta && sectionMeta.grade_level_id && Number(sectionMeta.grade_level_id) !== Number(gradeId)) {
                        gradeId = sectionMeta.grade_level_id;
                    }
                    const contact = getRowValue(row, ['Contact Number', 'Contact', 'Phone', 'Mobile', 'contact_number']) || null;
                    const email = getRowValue(row, ['Email', 'Email Address', 'email']) || null;
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
                    const [teacherResult] = await db.query(
                        `INSERT INTO teachers
                            (employee_id, firstname, lastname, middlename, contact, email, school_id, grade_level_id, section_id, qr_code, active_from, status)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                        [empId, fn, ln, mn || null, contact, email, schoolId, gradeId, sectionId, qr_code, null, importedTeacherStatus]
                    );
                    await db.query(
                        'UPDATE sections SET adviser = ?, adviser_teacher_id = ? WHERE id = ?',
                        [adviserName, teacherResult.insertId, sectionId]
                    );
                    imported++;
                } else {
                    // student or shs_student
                    // New format: LRN, Student Name, School, Grade, [Track/Strand], Section, Guardian Contact
                    const lrn = row['LRN'] || row['lrn'] || null;
                    const rawName = row['Student Name'] || row['student_name'] || '';
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

                    const schoolInfo = await resolveSchool(row['School'] || row['school']);
                    if (schoolInfo.error) { errors.push({ row: rn, message: schoolInfo.error }); continue; }
                    const schoolId = schoolInfo.id;
                    const gradeStr = row['Grade'] || row['grade'];
                    // Validate grade vs school type
                    const schoolName = schoolInfo.name || row['School'] || row['school'] || '';
                    const gradeErr = validateGradeForSchool(gradeStr, schoolName);
                    if (gradeErr) { errors.push({ row: rn, message: gradeErr }); continue; }
                    const gradeId = await resolveGrade(gradeStr, schoolId);
                    const trackStrand = String(row['Track/Strand'] || row['Track'] || row['Strand'] || '').trim();
                    if (category === 'shs_student' && !trackStrand) { errors.push({ row: rn, message: 'Track/Strand is required for SHS' }); continue; }
                    const rawSection = String(row['Section'] || row['section'] || '').trim();
                    const composedSection = (category === 'shs_student' && trackStrand && rawSection)
                        ? trackStrand + ' - ' + rawSection
                        : rawSection;
                    const sectionId = await resolveSection(composedSection, schoolId, gradeId);
                    const guardianContact = row['Guardian Contact'] || row['guardian_contact'] || null;

                    if (lrn) {
                        const [existing] = await db.query('SELECT id, status, active_from FROM students WHERE lrn = ?', [lrn]);
                        if (existing.length > 0) {
                            const existingStatus = existing[0].status || defaultImportedStudentStatus;
                            const nextStatus = existingStatus === 'deleted' ? defaultImportedStudentStatus : existingStatus;
                            const nextActiveFrom = nextStatus === 'active'
                                ? (existing[0].active_from || importActiveFrom)
                                : null;
                            await db.query(
                                'UPDATE students SET firstname=?, lastname=?, middlename=?, school_id=?, grade_level_id=?, section_id=?, guardian_contact=?, category=?, active_from=?, status=? WHERE id=?',
                                [fn, ln, mn || null, schoolId || null, gradeId || null, sectionId || null, guardianContact, category, nextActiveFrom, nextStatus, existing[0].id]
                            );
                            updated++;
                            continue;
                        }
                    }
                    const qr_code = lrn ? 'STU-' + lrn : 'STU-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                    await db.query(
                        'INSERT INTO students (lrn, firstname, lastname, middlename, school_id, grade_level_id, section_id, guardian_contact, qr_code, category, active_from, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                        [lrn, fn, ln, mn || null, schoolId || null, gradeId || null, sectionId || null, guardianContact, qr_code, category, null, defaultImportedStudentStatus]
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
            const [t] = await db.query(
                'SELECT school_id, grade_level_id, section_id FROM teachers WHERE id = ?',
                [user.teacher_id]
            );
            if (t.length > 0 && t[0].section_id) {
                req.query.type = 'student';
                req.query.school_id = String(t[0].school_id);
                req.query.grade_level_id = String(t[0].grade_level_id);
                req.query.section_id = String(t[0].section_id);
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

        if (user.role === 'adviser' && user.teacher_id) {
            const [t] = await db.query(
                'SELECT school_id, grade_level_id, section_id FROM teachers WHERE id = ?',
                [user.teacher_id]
            );
            if (t.length > 0 && t[0].section_id) {
                adviserScope = { school_id: t[0].school_id, grade_level_id: t[0].grade_level_id, section_id: t[0].section_id };
                req.query.type = 'student';
                req.query.school_id = String(t[0].school_id);
                req.query.grade_level_id = String(t[0].grade_level_id);
                req.query.section_id = String(t[0].section_id);
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
            adviserScope: adviserScope
        });
    } catch (err) {
        console.error('Print QR error:', err);
        res.render('error', { title: 'Error', message: 'Failed to generate QR codes.', user: req.session.user });
    }
});

module.exports = router;
