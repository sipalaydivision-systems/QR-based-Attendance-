const express = require('express');
const { Parser } = require('json2csv');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const router = express.Router();
const db = require('../config/database');
const { requireAuth, requireRole, applySchoolFilter } = require('../middleware/auth');
const { todayDate } = require('../utils/appTime');

router.use(requireAuth);

function formatStatusLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
    const labels = {
        active: 'Active',
        inactive: 'Inactive',
        deleted: 'Deleted',
        present: 'Present',
        absent: 'Absent',
        late: 'Late',
        flagged: 'Flagged',
        pending: 'Pending',
        sent: 'Sent',
        failed: 'Failed',
        complete: 'Complete',
        'no time in': 'No Time In',
        'no time out': 'No Time Out',
        'pending time out': 'Pending Time Out'
    };
    if (labels[normalized]) return labels[normalized];
    return normalized.split(' ').filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function labelRowStatuses(rows) {
    return rows.map(row => ({ ...row, status: formatStatusLabel(row.status) }));
}

async function isAttendanceDay(dateStr, schoolId) {
    const [schoolDays] = await db.query('SELECT is_school_day FROM school_days WHERE date = ? LIMIT 1', [dateStr]);
    if (schoolDays.length > 0) return !!schoolDays[0].is_school_day;

    const dayOfWeek = new Date(dateStr + 'T00:00:00').getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return false;

    let holidayQuery = 'SELECT id FROM holidays WHERE holiday_date = ? AND (school_id IS NULL';
    const holidayParams = [dateStr];
    if (schoolId) { holidayQuery += ' OR school_id = ?'; holidayParams.push(schoolId); }
    holidayQuery += ') LIMIT 1';
    const [holidays] = await db.query(holidayQuery, holidayParams);
    return holidays.length === 0;
}

// ---- Export Attendance Report (CSV) ----
router.get('/report', async (req, res) => {
    try {
        const date = req.query.date || todayDate();
        const endDate = req.query.end_date || date;
        const schoolId = applySchoolFilter(req);
        const type = req.query.type || 'student';

        let query = `SELECT a.date, a.person_type, a.time_in, a.time_out, a.status,
            CASE WHEN a.person_type = 'student'
                THEN (SELECT CONCAT(lastname, ', ', firstname) FROM students WHERE id = a.person_id)
                ELSE (SELECT CONCAT(lastname, ', ', firstname) FROM teachers WHERE id = a.person_id)
            END as name,
            s.name as school_name
            FROM attendance a
            LEFT JOIN schools s ON a.school_id = s.id
            WHERE a.date BETWEEN ? AND ? AND a.person_type = ?`;
        const params = [date, endDate, type];
        if (schoolId) { query += ' AND a.school_id = ?'; params.push(schoolId); }
        query += ' ORDER BY a.date, name';

        const [rows] = await db.query(query, params);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No records found for the selected criteria.' });
        }

        const fields = ['date', 'name', 'person_type', 'school_name', 'time_in', 'time_out', 'status'];
        const parser = new Parser({ fields });
        const csvData = parser.parse(labelRowStatuses(rows));

        res.header('Content-Type', 'text/csv');
        res.attachment(`attendance_report_${date}_to_${endDate}.csv`);
        return res.send(csvData);
    } catch (err) {
        console.error('Export report error:', err);
        return res.status(500).json({ error: 'Failed to generate report.' });
    }
});

// ---- Export Students (CSV) ----
router.get('/students', async (req, res) => {
    try {
        const schoolId = applySchoolFilter(req);
        let query = `SELECT s.lrn, s.lastname, s.firstname, s.middlename, s.gender, s.birthdate,
            s.status, s.category, s.guardian_name, s.guardian_contact, s.qr_code,
            sc.name as school_name, gl.name as grade_level, sec.name as section
            FROM students s
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id WHERE 1=1`;
        const params = [];
        if (schoolId) { query += ' AND s.school_id = ?'; params.push(schoolId); }
        query += ' ORDER BY s.lastname, s.firstname';

        const [rows] = await db.query(query, params);
        const fields = ['lrn', 'lastname', 'firstname', 'middlename', 'gender', 'birthdate', 'school_name', 'grade_level', 'section', 'status', 'category', 'guardian_name', 'guardian_contact', 'qr_code'];
        const parser = new Parser({ fields });
        const csvData = parser.parse(labelRowStatuses(rows));

        res.header('Content-Type', 'text/csv');
        res.attachment('students_export.csv');
        return res.send(csvData);
    } catch (err) {
        console.error('Export students error:', err);
        return res.status(500).json({ error: 'Failed to export students.' });
    }
});

// ---- Export Not Scanned Today ----
router.get('/not-scanned-today', async (req, res) => {
    try {
        const today = todayDate();
        const schoolId = applySchoolFilter(req);
        const fields = ['lrn', 'lastname', 'firstname', 'school_name', 'grade_level', 'section'];
        const parser = new Parser({ fields });
        if (!(await isAttendanceDay(today, schoolId))) {
            res.header('Content-Type', 'text/csv');
            res.attachment(`not_scanned_${today}.csv`);
            return res.send(parser.parse([]));
        }

        let query = `SELECT s.lrn, s.lastname, s.firstname, sc.name as school_name, gl.name as grade_level, sec.name as section
            FROM students s
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            WHERE s.status = 'active'
            AND COALESCE(s.active_from, DATE(s.created_at)) < ?
            AND s.id NOT IN (SELECT person_id FROM attendance WHERE person_type = 'student' AND date = ?)`;
        const params = [today, today];
        if (schoolId) { query += ' AND s.school_id = ?'; params.push(schoolId); }
        query += ' ORDER BY s.lastname, s.firstname';

        const [rows] = await db.query(query, params);
        const csvData = parser.parse(labelRowStatuses(rows));

        res.header('Content-Type', 'text/csv');
        res.attachment(`not_scanned_${today}.csv`);
        return res.send(csvData);
    } catch (err) {
        console.error('Export not scanned error:', err);
        return res.status(500).json({ error: 'Failed to export data.' });
    }
});

// ---- Download XLSX Templates (generated on-the-fly with dropdown validation) ----

function addDropdown(sheet, colLetter, fromRow, toRow, formulaList, prompt) {
    for (let r = fromRow; r <= toRow; r++) {
        sheet.getCell(`${colLetter}${r}`).dataValidation = {
            type: 'list',
            allowBlank: true,
            formulae: [formulaList],
            showErrorMessage: true,
            errorStyle: 'warning',
            errorTitle: 'Invalid value',
            error: `Please select from the dropdown. ${prompt || ''}`,
            showInputMessage: true,
            promptTitle: 'Select value',
            prompt: prompt || 'Choose from the list'
        };
    }
}

function formatTextColumns(sheet, cols, fromRow, toRow) {
    cols.forEach(col => {
        sheet.getColumn(col).numFmt = '@';
        for (let r = fromRow; r <= toRow; r++) {
            sheet.getCell(`${col}${r}`).numFmt = '@';
        }
    });
}

router.get('/template/:type', async (req, res) => {
    const type = req.params.type;
    const DATA_ROWS = 200;
    const START = 3;
    const END = START + DATA_ROWS - 1;

    try {
        const wb = new ExcelJS.Workbook();
        wb.creator = 'Edutrack';

        if (type === 'student') {
            const filePath = path.join(__dirname, '..', 'public', 'templates', 'student_import_template.xlsx');
            await wb.xlsx.readFile(filePath);
            const ws = wb.worksheets[0];
            const drops = wb.getWorksheet('Dropdowns');
            if (drops) {
                // Keep Grade 1-10 only — clear 11 and 12
                drops.getCell('B11').value = null;
                drops.getCell('B12').value = null;
            }
            // Narrow the validation range to $B$1:$B$10 so no blanks appear
            formatTextColumns(ws, ['A', 'G'], 2, END);
            addDropdown(ws, 'E', 2, END, "Dropdowns!$B$1:$B$10", 'Select Grade 1 to 10');
            res.setHeader('Content-Disposition', 'attachment; filename="student_import_template.xlsx"');

        } else if (type === 'shs_student') {
            const filePath = path.join(__dirname, '..', 'public', 'templates', 'shs_student_import_template.xlsx');
            await wb.xlsx.readFile(filePath);
            const ws = wb.worksheets[0];
            const drops = wb.getWorksheet('Dropdowns');
            if (drops) {
                // Replace col B with only 11 and 12
                drops.getCell('B1').value = 11;
                drops.getCell('B2').value = 12;
                for (let r = 3; r <= 12; r++) drops.getCell(`B${r}`).value = null;
            }
            // Narrow the validation range to $B$1:$B$2 — exactly 11 and 12, no blanks
            formatTextColumns(ws, ['A', 'H'], 2, END);
            addDropdown(ws, 'E', 2, END, "Dropdowns!$B$1:$B$2", 'Select Grade 11 or Grade 12');
            res.setHeader('Content-Disposition', 'attachment; filename="shs_student_import_template.xlsx"');

        } else if (type === 'teacher') {
            const filePath = path.join(__dirname, '..', 'public', 'templates', 'teacher_import_template.xlsx');
            await wb.xlsx.readFile(filePath);
            const ws = wb.worksheets[0];
            const drops = wb.getWorksheet('Dropdowns');
            if (drops) {
                drops.getCell('B11').value = null;
                drops.getCell('B12').value = null;
            }
            formatTextColumns(ws, ['A', 'F'], 2, END);
            addDropdown(ws, 'D', 2, END, "Dropdowns!$B$1:$B$10", 'Select Grade 1 to 10');
            res.setHeader('Content-Disposition', 'attachment; filename="teacher_import_template.xlsx"');

        } else if (type === 'shs_teacher') {
            const filePath = path.join(__dirname, '..', 'public', 'templates', 'shs_teacher_import_template.xlsx');
            await wb.xlsx.readFile(filePath);
            const ws = wb.worksheets[0];
            const drops = wb.getWorksheet('Dropdowns');
            if (drops) {
                drops.getCell('B1').value = 11;
                drops.getCell('B2').value = 12;
                for (let r = 3; r <= 12; r++) drops.getCell(`B${r}`).value = null;
            }
            formatTextColumns(ws, ['A', 'G'], 2, END);
            addDropdown(ws, 'D', 2, END, "Dropdowns!$B$1:$B$2", 'Select Grade 11 or Grade 12');
            res.setHeader('Content-Disposition', 'attachment; filename="shs_teacher_import_template.xlsx"');

        } else {
            return res.status(404).json({ error: 'Template not found.' });
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        await wb.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('Template generation error:', err);
        return res.status(500).json({ error: 'Failed to generate template.' });
    }
});

// ---- Export Users (Admin Accounts) ----
router.get('/users', requireRole('super_admin'), async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT u.username, u.fullname, u.email, u.role, u.status,
            s.name as school_name, u.created_at
            FROM users u LEFT JOIN schools s ON u.school_id = s.id
            ORDER BY u.fullname`);
        const fields = ['username', 'fullname', 'email', 'role', 'school_name', 'status', 'created_at'];
        const parser = new Parser({ fields });
        const csvData = parser.parse(labelRowStatuses(rows));

        res.header('Content-Type', 'text/csv');
        res.attachment('users_export.csv');
        return res.send(csvData);
    } catch (err) {
        console.error('Export users error:', err);
        return res.status(500).json({ error: 'Failed to export users.' });
    }
});

// ---- Export Outside Report (Timed-out / left school today) ----
router.get('/outside-report', async (req, res) => {
    try {
        const date = req.query.date || todayDate();
        const schoolId = applySchoolFilter(req);

        let query = `SELECT a.person_type, a.time_in, a.time_out, a.status, a.date,
            CASE WHEN a.person_type = 'student'
                THEN (SELECT CONCAT(lastname, ', ', firstname) FROM students WHERE id = a.person_id)
                ELSE (SELECT CONCAT(lastname, ', ', firstname) FROM teachers WHERE id = a.person_id)
            END as name,
            s.name as school_name
            FROM attendance a
            LEFT JOIN schools s ON a.school_id = s.id
            WHERE a.date = ? AND a.time_out IS NOT NULL`;
        const params = [date];
        if (schoolId) { query += ' AND a.school_id = ?'; params.push(schoolId); }
        query += ' ORDER BY a.time_out DESC';

        const [rows] = await db.query(query, params);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No timed-out records found.' });
        }

        const fields = ['date', 'name', 'person_type', 'school_name', 'time_in', 'time_out', 'status'];
        const parser = new Parser({ fields });
        const csvData = parser.parse(rows);

        res.header('Content-Type', 'text/csv');
        res.attachment(`outside_report_${date}.csv`);
        return res.send(csvData);
    } catch (err) {
        console.error('Export outside report error:', err);
        return res.status(500).json({ error: 'Failed to generate outside report.' });
    }
});

module.exports = router;
