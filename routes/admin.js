const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const QRCode = require('qrcode');
const { Readable } = require('stream');
const router = express.Router();
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// All admin routes require authentication
router.use(requireAuth);

// Helper: get correct dashboard URL for a role
function getDashboardUrl(role) {
    switch (role) {
        case 'superintendent': return '/admin/sds-dashboard';
        case 'asst_superintendent': return '/admin/asds-dashboard';
        case 'principal': return '/admin/principal-dashboard';
        default: return '/admin/dashboard';
    }
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

// ---- Scanner ----
router.get('/scanner', async (req, res) => {
    res.render('scanner', { title: 'QR Scanner', page: 'scanner' });
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
    const defaultSchoolId = req.body.school_id || null;
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
                    if (key) obj[key] = cell.value != null ? String(cell.value).trim() : '';
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

        async function resolveSchoolPreview(schoolName, fallbackId) {
            if (!schoolName) {
                if (!fallbackId) return { id: null, name: '' };
                const [s] = await db.query('SELECT id, name FROM schools WHERE id = ?', [fallbackId]);
                return s.length > 0 ? s[0] : { id: fallbackId, name: '' };
            }
            const [found] = await db.query('SELECT id, name FROM schools WHERE name = ? LIMIT 1', [schoolName]);
            return found.length > 0 ? found[0] : { id: null, name: schoolName, error: 'School not found' };
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
                const empId = row['Employee ID'] || row['employee_id'] || null;
                const rawName = row['Name'] || row['name'] || '';
                const { firstname, lastname, middlename } = parseName(rawName);
                const fn = firstname || row.firstname || '';
                const ln = lastname || row.lastname || '';
                if (!fn && !ln) { entry.status = 'error'; entry.error = 'Missing name'; }

                const schoolName = row['School'] || row['school'] || '';
                const school = await resolveSchoolPreview(schoolName, defaultSchoolId);
                const gradeStr = row['Grade'] || row['grade'];
                const gradeErr = validateGradeForSchool(gradeStr, school.name || schoolName);
                if (gradeErr) { entry.status = 'error'; entry.error = gradeErr; }
                const grade = gradeStr ? await checkGrade(gradeStr) : { id: null, name: '' };
                const sectionName = row['Section'] || row['section'] || '';
                const section = sectionName ? await checkSection(sectionName, school.id, grade.id) : { id: null, name: '' };
                const contact = row['Contact Number'] || row['contact_number'] || '';
                const qr_code = empId ? 'TCH-' + empId : 'TCH-auto';

                // Check if existing
                if (empId && entry.status !== 'error') {
                    const [existing] = await db.query('SELECT id, status FROM teachers WHERE employee_id = ?', [empId]);
                    if (existing.length > 0) {
                        entry.status = existing[0].status === 'deleted' ? 'restore' : 'update';
                    }
                }

                entry.empId = empId;
                entry.name = ln && fn ? ln + ', ' + fn : fn || ln;
                entry.school = school.name || '';
                entry.grade = grade.name || '';
                entry.section = section.name || '';
                entry.contact = contact;
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
                const school = await resolveSchoolPreview(schoolName, defaultSchoolId);
                const gradeStr = row['Grade'] || row['grade'];
                const gradeErr = validateGradeForSchool(gradeStr, school.name || schoolName);
                if (gradeErr) { entry.status = 'error'; entry.error = gradeErr; }
                const grade = gradeStr ? await checkGrade(gradeStr) : { id: null, name: '' };
                const sectionName = row['Section'] || row['section'] || '';
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
    const defaultSchoolId = req.body.school_id || null;
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
                    if (key) obj[key] = cell.value != null ? String(cell.value).trim() : '';
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

        // Helper: resolve school_id by name
        async function resolveSchool(schoolName, fallbackId) {
            if (!schoolName) return fallbackId;
            const [found] = await db.query('SELECT id FROM schools WHERE name = ? LIMIT 1', [schoolName]);
            return found.length > 0 ? found[0].id : fallbackId;
        }

        // Helper: resolve grade_level_id by grade number (auto-creates if missing)
        async function resolveGrade(gradeStr, schoolId) {
            if (!gradeStr) return null;
            const g = String(gradeStr).trim();
            const [found] = await db.query('SELECT id FROM grade_levels WHERE name LIKE ? OR name LIKE ? LIMIT 1', ['%' + g, 'Grade ' + g]);
            if (found.length > 0) return found[0].id;
            // Auto-create grade level
            const name = /^\d+$/.test(g) ? 'Grade ' + g : g;
            const [result] = await db.query('INSERT INTO grade_levels (name, school_id) VALUES (?, ?)', [name, schoolId || null]);
            return result.insertId;
        }

        // Helper: resolve or create section
        async function resolveSection(sectionName, schoolId, gradeLevelId) {
            if (!sectionName) return null;
            let query = 'SELECT id FROM sections WHERE name = ?';
            const params = [sectionName];
            if (schoolId) { query += ' AND school_id = ?'; params.push(schoolId); }
            if (gradeLevelId) { query += ' AND grade_level_id = ?'; params.push(gradeLevelId); }
            query += ' LIMIT 1';
            const [found] = await db.query(query, params);
            if (found.length > 0) return found[0].id;
            // Auto-create section
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
                    // New format: Employee ID, Name, School, Grade, Section, Contact Number
                    const empId = row['Employee ID'] || row['employee_id'] || null;
                    const rawName = row['Name'] || row['name'] || '';
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

                    const schoolId = await resolveSchool(row['School'] || row['school'], defaultSchoolId);
                    const gradeStr = row['Grade'] || row['grade'];
                    // Validate grade vs school type
                    const schoolName = row['School'] || row['school'] || '';
                    const gradeErr = validateGradeForSchool(gradeStr, schoolName);
                    if (gradeErr) { errors.push({ row: rn, message: gradeErr }); continue; }
                    const gradeId = await resolveGrade(gradeStr, schoolId);
                    const sectionId = await resolveSection(row['Section'] || row['section'], schoolId, gradeId);
                    const contact = row['Contact Number'] || row['contact_number'] || null;

                    if (empId) {
                        const [existing] = await db.query('SELECT id FROM teachers WHERE employee_id = ?', [empId]);
                        if (existing.length > 0) {
                            await db.query(
                                'UPDATE teachers SET firstname=?, lastname=?, middlename=?, school_id=?, status=? WHERE id=?',
                                [fn, ln, mn || null, schoolId || null, 'inactive', existing[0].id]
                            );
                            updated++;
                            continue;
                        }
                    }
                    const qr_code = empId ? 'TCH-' + empId : 'TCH-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                    await db.query(
                        'INSERT INTO teachers (employee_id, firstname, lastname, middlename, school_id, qr_code, status) VALUES (?,?,?,?,?,?,?)',
                        [empId, fn, ln, mn || null, schoolId || null, qr_code, 'inactive']
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

                    const schoolId = await resolveSchool(row['School'] || row['school'], defaultSchoolId);
                    const gradeStr = row['Grade'] || row['grade'];
                    // Validate grade vs school type
                    const schoolName = row['School'] || row['school'] || '';
                    const gradeErr = validateGradeForSchool(gradeStr, schoolName);
                    if (gradeErr) { errors.push({ row: rn, message: gradeErr }); continue; }
                    const gradeId = await resolveGrade(gradeStr, schoolId);
                    const sectionId = await resolveSection(row['Section'] || row['section'], schoolId, gradeId);
                    const guardianContact = row['Guardian Contact'] || row['guardian_contact'] || null;

                    if (lrn) {
                        const [existing] = await db.query('SELECT id FROM students WHERE lrn = ?', [lrn]);
                        if (existing.length > 0) {
                            await db.query(
                                'UPDATE students SET firstname=?, lastname=?, middlename=?, school_id=?, grade_level_id=?, section_id=?, guardian_contact=?, category=?, status=? WHERE id=?',
                                [fn, ln, mn || null, schoolId || null, gradeId || null, sectionId || null, guardianContact, category, 'inactive', existing[0].id]
                            );
                            updated++;
                            continue;
                        }
                    }
                    const qr_code = lrn ? 'STU-' + lrn : 'STU-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
                    await db.query(
                        'INSERT INTO students (lrn, firstname, lastname, middlename, school_id, grade_level_id, section_id, guardian_contact, qr_code, category, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                        [lrn, fn, ln, mn || null, schoolId || null, gradeId || null, sectionId || null, guardianContact, qr_code, category, 'inactive']
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
router.get('/print-qr', async (req, res) => {
    const schoolId = req.query.school_id;
    const type = req.query.type || 'student';
    let people = [];

    try {
        if (type === 'teacher') {
            let query = "SELECT t.id, t.firstname, t.lastname, t.employee_id, t.qr_code, sc.name AS school_name FROM teachers t LEFT JOIN schools sc ON t.school_id = sc.id WHERE t.status != 'deleted'";
            const params = [];
            if (req.query.teacher_id) { query += ' AND t.id = ?'; params.push(parseInt(req.query.teacher_id, 10)); }
            if (schoolId) { query += ' AND t.school_id = ?'; params.push(schoolId); }
            query += ' ORDER BY t.lastname, t.firstname';
            [people] = await db.query(query, params);
        } else {
            let query = "SELECT s.id, s.firstname, s.lastname, s.lrn, s.qr_code, sc.name AS school_name, gl.name AS grade_name, sec.name AS section_name FROM students s LEFT JOIN schools sc ON s.school_id = sc.id LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id LEFT JOIN sections sec ON s.section_id = sec.id WHERE s.status != 'deleted'";
            const params = [];
            if (req.query.student_id) { query += ' AND s.id = ?'; params.push(parseInt(req.query.student_id, 10)); }
            if (schoolId) { query += ' AND s.school_id = ?'; params.push(schoolId); }
            query += ' ORDER BY s.lastname, s.firstname';
            [people] = await db.query(query, params);
        }

        // Generate QR code data URLs
        const qrPromises = people.map(async (p) => {
            const qrDataUrl = await QRCode.toDataURL(p.qr_code, { width: 200, margin: 1 });
            return { ...p, qrDataUrl };
        });
        const peopleWithQR = await Promise.all(qrPromises);

        const [schools] = await db.query("SELECT * FROM schools WHERE status = 'active' ORDER BY name");
        res.render('print_qr', { title: 'Print QR Codes', page: 'print_qr', people: peopleWithQR, type, schools });
    } catch (err) {
        console.error('Print QR error:', err);
        res.render('error', { title: 'Error', message: 'Failed to generate QR codes.', user: req.session.user });
    }
});

module.exports = router;
