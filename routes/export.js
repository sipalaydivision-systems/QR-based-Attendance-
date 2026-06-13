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

const HEADER_STYLE = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166534' } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    border: { bottom: { style: 'thin', color: { argb: 'FF14532D' } } }
};

const NOTE_STYLE = {
    font: { italic: true, color: { argb: 'FF6B7280' }, size: 10 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }
};

function applyHeaderRow(row, noteRow, columns) {
    columns.forEach((col, i) => {
        const hCell = row.getCell(i + 1);
        hCell.value = col.header;
        Object.assign(hCell, HEADER_STYLE);
        hCell.font = { ...HEADER_STYLE.font };
        hCell.fill = { ...HEADER_STYLE.fill };
        hCell.alignment = { ...HEADER_STYLE.alignment };

        const nCell = noteRow.getCell(i + 1);
        nCell.value = col.note || '';
        nCell.font = { ...NOTE_STYLE.font };
        nCell.fill = { ...NOTE_STYLE.fill };
        nCell.alignment = { ...NOTE_STYLE.alignment };
    });
}

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

router.get('/template/:type', async (req, res) => {
    const type = req.params.type;
    const DATA_ROWS = 200;
    const START = 3;
    const END = START + DATA_ROWS - 1;

    try {
        const wb = new ExcelJS.Workbook();
        wb.creator = 'Edutrack';

        if (type === 'student') {
            // Load original static file, inject Sex dropdown only
            const filePath = path.join(__dirname, '..', 'public', 'templates', 'student_import_template.xlsx');
            await wb.xlsx.readFile(filePath);
            const ws = wb.worksheets[0];
            // Find which column is Sex/Gender by reading header row
            const headerRow = ws.getRow(1);
            let sexCol = null;
            headerRow.eachCell((cell, colNum) => {
                const v = String(cell.value || '').toLowerCase();
                if (v === 'sex' || v === 'gender') sexCol = colNum;
            });
            if (sexCol) {
                const letter = ws.getColumn(sexCol).letter;
                addDropdown(ws, letter, START, END, '"Male,Female"', 'Select Male or Female');
            }
            res.setHeader('Content-Disposition', 'attachment; filename="student_import_template.xlsx"');

        } else if (type === 'shs_student') {
            // Load original static file, inject Sex and Grade dropdowns only
            const filePath = path.join(__dirname, '..', 'public', 'templates', 'shs_student_import_template.xlsx');
            await wb.xlsx.readFile(filePath);
            const ws = wb.worksheets[0];
            const headerRow = ws.getRow(1);
            let sexCol = null, gradeCol = null;
            headerRow.eachCell((cell, colNum) => {
                const v = String(cell.value || '').toLowerCase();
                if (v === 'sex' || v === 'gender') sexCol = colNum;
                if (v === 'grade' || v === 'grade level') gradeCol = colNum;
            });
            if (sexCol) addDropdown(ws, ws.getColumn(sexCol).letter, START, END, '"Male,Female"', 'Select Male or Female');
            if (gradeCol) addDropdown(ws, ws.getColumn(gradeCol).letter, START, END, '"11,12"', 'Select Grade 11 or Grade 12');
            res.setHeader('Content-Disposition', 'attachment; filename="shs_student_import_template.xlsx"');

        } else if (type === 'teacher') {
            const ws = wb.addWorksheet('Teachers');
            ws.getRow(1).height = 28;
            ws.getRow(2).height = 22;
            const cols = [
                { header: 'Employee ID',          note: 'Teacher or employee ID',           width: 18 },
                { header: 'Teacher/Adviser Name', note: 'Last Name, First Name Middle Name', width: 32 },
                { header: 'School Name',          note: 'Full school name',                  width: 30 },
                { header: 'Grade Level',          note: 'Grade 1 to Grade 6 / 7–10',         width: 14 },
                { header: 'Section Name',         note: 'Advisory section name',             width: 20 },
                { header: 'Contact Number',       note: 'Mobile or landline',                width: 18 },
                { header: 'Email',                note: 'Used as adviser login username',     width: 26 }
            ];
            cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
            applyHeaderRow(ws.getRow(1), ws.getRow(2), cols);
            addDropdown(ws, 'D', START, END, '"Grade 1,Grade 2,Grade 3,Grade 4,Grade 5,Grade 6,Grade 7,Grade 8,Grade 9,Grade 10"', 'Select a grade level');
            res.setHeader('Content-Disposition', 'attachment; filename="teacher_import_template.xlsx"');

        } else if (type === 'shs_teacher') {
            const ws = wb.addWorksheet('SHS Teachers');
            ws.getRow(1).height = 28;
            ws.getRow(2).height = 22;
            const cols = [
                { header: 'Employee ID',          note: 'Teacher or employee ID',           width: 18 },
                { header: 'Teacher/Adviser Name', note: 'Last Name, First Name Middle Name', width: 32 },
                { header: 'School Name',          note: 'Full school name',                  width: 30 },
                { header: 'Grade Level',          note: '11 or 12',                          width: 10 },
                { header: 'Track/Strand',         note: 'e.g. STEM, ABM, HUMSS',            width: 18 },
                { header: 'Section Name',         note: 'Advisory section name',             width: 20 },
                { header: 'Contact Number',       note: 'Mobile or landline',                width: 18 },
                { header: 'Email',                note: 'Used as adviser login username',     width: 26 }
            ];
            cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
            applyHeaderRow(ws.getRow(1), ws.getRow(2), cols);
            addDropdown(ws, 'D', START, END, '"11,12"', 'Select Grade 11 or Grade 12');
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
