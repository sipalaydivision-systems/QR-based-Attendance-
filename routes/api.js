const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const db = require('../config/database');
const { requireAuth, requireRole, applySchoolFilter } = require('../middleware/auth');

// Logo upload config
const logoStorage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, path.join(__dirname, '..', 'public', 'uploads', 'logos')); },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, 'school-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8) + ext);
    }
});
const logoUpload = multer({
    storage: logoStorage,
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
    const schoolDates = await getRecentSchoolDates(baseDate, schoolId, scanLimit);
    if (schoolDates.length < threshold) return [];

    let studentQuery = `SELECT s.id, s.firstname, s.lastname, s.lrn, s.school_id, s.section_id, sc.name as school_name,
            sc.contact as school_contact, gl.name as grade_name, sec.name as section_name, sec.adviser
        FROM students s
        LEFT JOIN schools sc ON s.school_id = sc.id
        LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
        LEFT JOIN sections sec ON s.section_id = sec.id
        WHERE s.status = 'active'`;
    const studentParams = [];
    if (schoolId) { studentQuery += ' AND s.school_id = ?'; studentParams.push(schoolId); }

    let teacherQuery = `SELECT t.id, t.firstname, t.lastname, t.employee_id, t.school_id, sc.name as school_name, sc.contact as school_contact
        FROM teachers t
        LEFT JOIN schools sc ON t.school_id = sc.id
        WHERE t.status = 'active'`;
    const teacherParams = [];
    if (schoolId) { teacherQuery += ' AND t.school_id = ?'; teacherParams.push(schoolId); }

    const [students, teachers] = await Promise.all([
        db.query(studentQuery, studentParams).then(r => r[0]),
        includeTeachers ? db.query(teacherQuery, teacherParams).then(r => r[0]) : Promise.resolve([])
    ]);

    const allDatesSql = schoolDates.map(() => '?').join(',');
    const attendanceParams = [...schoolDates];
    let attendanceQuery = `SELECT person_type, person_id, date
        FROM attendance
        WHERE date IN (${allDatesSql}) AND time_in IS NOT NULL AND person_type IN ('student', 'teacher')`;
    if (schoolId) {
        attendanceQuery += ' AND school_id = ?';
        attendanceParams.push(schoolId);
    }
    const [attendanceRows] = await db.query(attendanceQuery, attendanceParams);
    const presentSet = new Set(attendanceRows.map(r => {
        const d = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
        return `${r.person_type}-${r.person_id}-${d}`;
    }));

    function consecutiveDaysAbsent(type, id) {
        let count = 0;
        for (const d of schoolDates) {
            if (presentSet.has(`${type}-${id}-${d}`)) break;
            count++;
        }
        return count;
    }

    const flaggedStudents = students
        .map(student => ({ student, absentDays: consecutiveDaysAbsent('student', student.id) }))
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
        .map(teacher => ({ teacher, absentDays: consecutiveDaysAbsent('teacher', teacher.id) }))
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
router.get('/is-school-day', requireAuth, async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().slice(0, 10);
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
router.post('/scan-attendance', requireAuth, async (req, res) => {
    const { qr_code } = req.body;
    if (!qr_code) {
        return res.status(400).json({ success: false, error: 'No QR code provided.' });
    }

    function fmtTime(d) {
        if (!d) return '--:--';
        const dt = new Date(d);
        return dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    }

    try {
        const today = new Date().toISOString().slice(0, 10);
        const now = new Date();

        // Check student first (with joins for school, grade, section)
        let [rows] = await db.query(
            `SELECT s.id, s.firstname, s.lastname, s.lrn, s.school_id, s.status AS person_status,
                    sc.name AS school_name, gl.name AS grade_name, sec.name AS section_name
             FROM students s
             LEFT JOIN schools sc ON s.school_id = sc.id
             LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
             LEFT JOIN sections sec ON s.section_id = sec.id
             WHERE s.qr_code = ?`,
            [qr_code]
        );
        let personType = 'student';
        let person = rows[0];

        // If not a student, check teacher
        if (!person) {
            [rows] = await db.query(
                `SELECT t.id, t.firstname, t.lastname, t.employee_id, t.school_id, t.status AS person_status,
                        sc.name AS school_name
                 FROM teachers t
                 LEFT JOIN schools sc ON t.school_id = sc.id
                 WHERE t.qr_code = ?`,
                [qr_code]
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

        // Auto-activate inactive person on first scan (if setting enabled)
        if (person.person_status === 'inactive') {
            const [[autoSetting]] = await db.query("SELECT setting_value FROM settings WHERE setting_key='auto_activate_on_scan'");
            const autoActivate = !autoSetting || autoSetting.setting_value !== '0'; // default: enabled
            if (autoActivate) {
                const table = personType === 'student' ? 'students' : 'teachers';
                await db.query('UPDATE ' + table + ' SET status = ? WHERE id = ?', ['active', person.id]);
                person.person_status = 'active';
            } else {
                return res.json({ success: false, error: 'This person is inactive. Please contact the admin to activate.' });
            }
        }

        const personInfo = {
            name: person.firstname + ' ' + person.lastname,
            type: personType,
            school: person.school_name || 'N/A'
        };
        if (personType === 'student') {
            personInfo.lrn = person.lrn || 'N/A';
            personInfo.grade = person.grade_name || 'N/A';
            personInfo.section = person.section_name || 'N/A';
        } else {
            personInfo.employee_id = person.employee_id || 'N/A';
        }

        // Check existing attendance for today
        const [existing] = await db.query(
            'SELECT * FROM attendance WHERE person_type = ? AND person_id = ? AND date = ?',
            [personType, person.id, today]
        );

        if (existing.length === 0) {
            // Determine status: present or late based on late_time setting
            const [[lateSetting]] = await db.query("SELECT setting_value FROM settings WHERE setting_key='late_time'");
            const lateTimeStr = (lateSetting && lateSetting.setting_value) || '08:00:00';
            const lateThreshold = new Date(today + 'T' + lateTimeStr);
            const attendanceStatus = now >= lateThreshold ? 'late' : 'present';

            // Record time-in
            await db.query(
                'INSERT INTO attendance (person_type, person_id, school_id, date, time_in, status) VALUES (?, ?, ?, ?, ?, ?)',
                [personType, person.id, person.school_id, today, now, attendanceStatus]
            );
            return res.json({
                success: true,
                action: 'TIME_IN',
                status: attendanceStatus,
                message: attendanceStatus === 'late' ? 'Attendance recorded — marked as LATE' : 'Attendance recorded successfully',
                person: personInfo,
                time: fmtTime(now)
            });
        } else if (!existing[0].time_out) {
            // Anti-cheat: reject time_out if scanned too quickly after time_in (< 60 seconds)
            const timeInMs = new Date(existing[0].time_in).getTime();
            const elapsedSec = (now.getTime() - timeInMs) / 1000;
            if (elapsedSec < 60) {
                return res.json({
                    success: false,
                    error: 'Time out rejected — scanned too quickly after time in (' + Math.round(elapsedSec) + 's). Please wait at least 1 minute.',
                    person: personInfo
                });
            }
            // Record time-out
            await db.query(
                'UPDATE attendance SET time_out = ?, updated_at = NOW() WHERE id = ?',
                [now, existing[0].id]
            );
            return res.json({
                success: true,
                action: 'TIME_OUT',
                message: 'Time out recorded successfully',
                person: personInfo,
                time: fmtTime(now),
                time_in: fmtTime(existing[0].time_in),
                time_out: fmtTime(now)
            });
        } else {
            return res.json({
                success: false,
                error: person.firstname + ' ' + person.lastname + ' already has complete attendance for today.',
                person: personInfo,
                completed: true,
                time_in: fmtTime(existing[0].time_in),
                time_out: fmtTime(existing[0].time_out)
            });
        }
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
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        const schoolId = applySchoolFilter(req);
        const cacheKey = `${date}-${schoolId || 'all'}`;

        // Return cached if fresh (3 seconds)
        if (dashboardCache.key === cacheKey && (Date.now() - dashboardCache.timestamp) < 3000) {
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

        // Students present today (only active students)
        const [presentStudents] = await db.query(
            `SELECT COUNT(DISTINCT a.person_id) as count FROM attendance a
             INNER JOIN students s ON a.person_id = s.id
             WHERE a.person_type = 'student' AND s.status = 'active' AND a.date = ? AND a.time_in IS NOT NULL` + (schoolId ? ' AND a.school_id = ?' : ''),
            [date, ...schoolParams]
        );

        // Teachers present today (only active teachers)
        const [presentTeachers] = await db.query(
            `SELECT COUNT(DISTINCT a.person_id) as count FROM attendance a
             INNER JOIN teachers t ON a.person_id = t.id
             WHERE a.person_type = 'teacher' AND t.status = 'active' AND a.date = ? AND a.time_in IS NOT NULL` + (schoolId ? ' AND a.school_id = ?' : ''),
            [date, ...schoolParams]
        );

        // School-by-school breakdown (join on active status)
        let schoolBreakdownQuery = `
            SELECT s.id, s.name,
                (SELECT COUNT(*) FROM students st WHERE st.school_id = s.id AND st.status = 'active') as enrollment,
                (SELECT COUNT(DISTINCT a.person_id) FROM attendance a INNER JOIN students st ON a.person_id = st.id AND st.status = 'active' WHERE a.school_id = s.id AND a.person_type = 'student' AND a.date = ? AND a.time_in IS NOT NULL) as present,
                (SELECT COUNT(*) FROM teachers t WHERE t.school_id = s.id AND t.status = 'active') as teachers_total,
                (SELECT COUNT(DISTINCT a.person_id) FROM attendance a INNER JOIN teachers t ON a.person_id = t.id AND t.status = 'active' WHERE a.school_id = s.id AND a.person_type = 'teacher' AND a.date = ? AND a.time_in IS NOT NULL) as teachers_present
            FROM schools s WHERE s.status = 'active'`;
        const breakdownParams = [date, date];
        if (schoolId) {
            schoolBreakdownQuery += ' AND s.id = ?';
            breakdownParams.push(schoolId);
        }
        const [schoolBreakdown] = await db.query(schoolBreakdownQuery, breakdownParams);

        const breakdown = schoolBreakdown.map(s => ({
            id: s.id,
            name: s.name,
            enrollment: s.enrollment,
            present: s.present,
            absent: Math.max(0, s.enrollment - s.present),
            rate: s.enrollment > 0 ? Math.min(100, Math.round((s.present / s.enrollment) * 100)) : 0,
            teachers_total: s.teachers_total || 0,
            teachers_present: s.teachers_present || 0,
            teacher_rate: s.teachers_total > 0 ? Math.min(100, Math.round((s.teachers_present / s.teachers_total) * 100)) : 0
        }));

        const totalActive = activeStudents[0].count;
        const totalPresent = presentStudents[0].count;

        // Students timed out today (only active students)
        const [timedOutStudents] = await db.query(
            `SELECT COUNT(DISTINCT a.person_id) as count FROM attendance a
             INNER JOIN students s ON a.person_id = s.id
             WHERE a.person_type = 'student' AND s.status = 'active' AND a.date = ? AND a.time_out IS NOT NULL` + (schoolId ? ' AND a.school_id = ?' : ''),
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

        const data = {
            date,
            total_schools: schoolRows[0].count,
            total_students: allStudents[0].count,
            active_students: totalActive,
            total_teachers: teacherRows[0].count,
            students_present: totalPresent,
            students_absent: Math.max(0, totalActive - totalPresent),
            students_timed_out: timedOutStudents[0].count,
            teachers_present: presentTeachers[0].count,
            teachers_absent: Math.max(0, teacherRows[0].count - presentTeachers[0].count),
            attendance_rate: totalActive > 0 ? Math.min(100, Math.round((totalPresent / totalActive) * 100)) : 0,
            inactive_students: inactiveStudents[0].count,
            flagged_absent_2day: flaggedAbsent.length,
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
// GET /api/division-weekly-trend
// =============================================
router.get('/division-weekly-trend', requireAuth, async (req, res) => {
    try {
        const endDate = req.query.date || new Date().toISOString().slice(0, 10);
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

        for (const w of weeks) {
            const [pRow] = await db.query(
                `SELECT COUNT(DISTINCT a.person_id, a.date) as cnt FROM attendance a
                 INNER JOIN students s ON a.person_id = s.id AND s.status = 'active'
                 WHERE a.person_type = 'student' AND a.date BETWEEN ? AND ? AND a.time_in IS NOT NULL`,
                [w.start, w.end]
            );
            const [eRow] = await db.query(
                `SELECT COUNT(*) as cnt FROM students WHERE status = 'active'`
            );
            // School days in this week (weekdays)
            let schoolDays = 0;
            let cur = new Date(w.start + 'T00:00:00');
            let endW = new Date(w.end + 'T00:00:00');
            while (cur <= endW) {
                let dow = cur.getDay();
                if (dow >= 1 && dow <= 5) schoolDays++;
                cur.setDate(cur.getDate() + 1);
            }
            let totalExpected = eRow[0].cnt * schoolDays;
            let pCount = pRow[0].cnt;
            let aCount = Math.max(0, totalExpected - pCount);
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
    const clientHash = req.query.hash || '';
    const schoolId = applySchoolFilter(req);

    try {
        const today = new Date().toISOString().slice(0, 10);
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
                    COALESCE(SUM(CRC32(CONCAT_WS('|', id, firstname, lastname, COALESCE(lrn, ''), COALESCE(status, ''), COALESCE(grade_level_id, ''), COALESCE(section_id, ''), COALESCE(school_id, '')))), 0) as checksum
             FROM students WHERE status != 'deleted'` + schoolWhere,
            schoolParams
        );
        const [teacherRows] = await db.query(
            `SELECT COUNT(*) as cnt,
                    COALESCE(SUM(CRC32(CONCAT_WS('|', id, firstname, lastname, COALESCE(employee_id, ''), COALESCE(status, ''), COALESCE(school_id, '')))), 0) as checksum
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

        const raw = `${countRows[0].cnt}-${latestRows[0].latest || ''}-${studentRows[0].cnt}-${studentRows[0].active}-${studentRows[0].inactive}-${studentRows[0].checksum}-${teacherRows[0].cnt}-${teacherRows[0].checksum}-${schoolRows[0].cnt}-${schoolRows[0].checksum}-${gradeRows[0].cnt}-${gradeRows[0].checksum}-${sectionRows[0].cnt}-${sectionRows[0].checksum}-${notificationRows[0].cnt}-${notificationRows[0].latest || ''}`;
        const hash = crypto.createHash('md5').update(raw).digest('hex').substring(0, 12);
        const changed = hash !== clientHash;

        return res.json({
            changed,
            hash,
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
        if (!schoolId && req.query.school_id) schoolId = parseInt(req.query.school_id, 10);
        let query = `SELECT s.*, sc.name as school_name, gl.name as grade_name, sec.name as section_name
            FROM students s
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            WHERE s.status != 'deleted'`;
        const params = [];
        if (schoolId) { query += ' AND s.school_id = ?'; params.push(schoolId); }
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
        return res.json(rows);
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
            `INSERT INTO students (lrn, firstname, lastname, middlename, gender, birthdate, grade_level_id, section_id, school_id, guardian_name, guardian_contact, qr_code, category)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [lrn || null, firstname, lastname, middlename || null, gender || null, birthdate || null,
             grade_level_id || null, section_id || null, school_id, guardian_name || null, guardian_contact || null,
             qr_code, category || 'student']
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
        await db.query(
            `UPDATE students SET firstname=?, lastname=?, middlename=?, gender=?, birthdate=?, grade_level_id=?, section_id=?, school_id=?, guardian_name=?, guardian_contact=?, status=?, lrn=?, category=? WHERE id=?`,
            [firstname, lastname, middlename || null, gender || null, birthdate || null,
             grade_level_id || null, section_id || null, school_id, guardian_name || null,
             guardian_contact || null, status || 'active', lrn || null, category || 'student',
             req.params.id]
        );
        return res.json({ success: true });
    } catch (err) {
        console.error('Update student error:', err);
        return res.status(500).json({ error: 'Failed to update student.' });
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
        let query = `SELECT t.*, s.name as school_name FROM teachers t LEFT JOIN schools s ON t.school_id = s.id WHERE t.status != 'deleted'`;
        const params = [];
        if (schoolId) { query += ' AND t.school_id = ?'; params.push(schoolId); }
        if (req.query.status) { query += ' AND t.status = ?'; params.push(req.query.status); }
        if (req.query.search) {
            query += ' AND (t.firstname LIKE ? OR t.lastname LIKE ? OR t.employee_id LIKE ?)';
            const s = `%${req.query.search}%`;
            params.push(s, s, s);
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
    const { employee_id, firstname, lastname, middlename, department, subject, school_id } = req.body;
    if (!firstname || !lastname || !school_id) {
        return res.status(400).json({ error: 'First name, last name, and school are required.' });
    }
    try {
        const qr_code = 'TCH-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
        const [result] = await db.query(
            `INSERT INTO teachers (employee_id, firstname, lastname, middlename, department, subject, school_id, qr_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [employee_id || null, firstname, lastname, middlename || null, department || null, subject || null, school_id, qr_code]
        );
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
    const { employee_id, firstname, lastname, middlename, department, subject, school_id, status } = req.body;
    try {
        await db.query(
            `UPDATE teachers SET employee_id=?, firstname=?, lastname=?, middlename=?, department=?, subject=?, school_id=?, status=? WHERE id=?`,
            [employee_id || null, firstname, lastname, middlename || null, department || null, subject || null, school_id, status || 'active', req.params.id]
        );
        return res.json({ success: true });
    } catch (err) {
        console.error('Update teacher error:', err);
        return res.status(500).json({ error: 'Failed to update teacher.' });
    }
});

// DELETE /api/teachers/:id
router.delete('/teachers/:id', requireAuth, async (req, res) => {
    try {
        await db.query('UPDATE teachers SET status = ? WHERE id = ?', ['deleted', req.params.id]);
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
        let query = `SELECT sec.*, gl.name as grade_name, s.name as school_name
            FROM sections sec
            LEFT JOIN grade_levels gl ON sec.grade_level_id = gl.id
            LEFT JOIN schools s ON sec.school_id = s.id WHERE 1=1`;
        const params = [];
        if (req.query.school_id) { query += ' AND sec.school_id = ?'; params.push(req.query.school_id); }
        if (req.query.grade_level_id) { query += ' AND sec.grade_level_id = ?'; params.push(req.query.grade_level_id); }
        query += ' ORDER BY sec.name';
        const [rows] = await db.query(query, params);
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch sections.' });
    }
});

router.post('/sections', requireAuth, async (req, res) => {
    const { name, grade_level_id, school_id, adviser } = req.body;
    if (!name) return res.status(400).json({ error: 'Section name is required.' });
    try {
        const [result] = await db.query(
            'INSERT INTO sections (name, grade_level_id, school_id, adviser) VALUES (?, ?, ?, ?)',
            [name, grade_level_id || null, school_id || null, adviser || null]
        );
        return res.json({ success: true, id: result.insertId });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to create section.' });
    }
});

router.put('/sections/:id', requireAuth, async (req, res) => {
    const { name, grade_level_id, school_id, adviser, status } = req.body;
    if (!name) return res.status(400).json({ error: 'Section name is required.' });
    try {
        const fields = ['name = ?', 'grade_level_id = ?', 'school_id = ?', 'adviser = ?'];
        const params = [name, grade_level_id || null, school_id || null, adviser || null];
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
    try {
        await db.query('UPDATE sections SET status = ? WHERE id = ?', [status, req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update status.' });
    }
});

router.delete('/sections/:id', requireAuth, async (req, res) => {
    try {
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
            `SELECT sec.* FROM sections sec WHERE 1=1${schoolId ? ' AND sec.school_id = ?' : ''} ORDER BY sec.name`,
            schoolId ? [schoolId] : []
        );
        const [students] = await db.query(
            `SELECT id, lrn, firstname, lastname, middlename, grade_level_id, section_id, school_id, status, category
             FROM students WHERE status != 'deleted'${schoolId ? ' AND school_id = ?' : ''} ORDER BY lastname, firstname`,
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
router.get('/users', requireAuth, async (req, res) => {
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
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        const schoolId = applySchoolFilter(req);
        let query = `SELECT a.*,
            CASE WHEN a.person_type = 'student' THEN (SELECT CONCAT(firstname, ' ', lastname) FROM students WHERE id = a.person_id)
                 ELSE (SELECT CONCAT(firstname, ' ', lastname) FROM teachers WHERE id = a.person_id)
            END as person_name
            FROM attendance a WHERE a.date = ?`;
        const params = [date];
        if (schoolId) { query += ' AND a.school_id = ?'; params.push(schoolId); }
        if (req.query.type) { query += ' AND a.person_type = ?'; params.push(req.query.type); }
        query += ' ORDER BY a.time_in DESC';
        const [rows] = await db.query(query, params);
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

router.post('/settings', requireAuth, async (req, res) => {
    try {
        const entries = Object.entries(req.body);
        for (const [key, value] of entries) {
            await db.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [key, value, value]
            );
        }
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to save settings.' });
    }
});

router.put('/settings', requireAuth, async (req, res) => {
    try {
        const entries = Object.entries(req.body);
        for (const [key, value] of entries) {
            await db.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [key, value, value]
            );
        }
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to save settings.' });
    }
});

// ---- System Logo Upload ----
router.post('/settings/logo', requireAuth, (req, res) => {
    const systemLogoUpload = multer({
        storage: multer.diskStorage({
            destination: function (req, file, cb) { cb(null, path.join(__dirname, '..', 'public', 'uploads', 'logos')); },
            filename: function (req, file, cb) {
                const ext = path.extname(file.originalname).toLowerCase();
                cb(null, 'system-logo' + ext);
            }
        }),
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
            const logoPath = '/uploads/logos/' + req.file.filename;
            await db.query(
                "INSERT INTO settings (setting_key, setting_value) VALUES ('system_logo', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
                [logoPath, logoPath]
            );
            return res.json({ success: true, logo: logoPath });
        } catch (e) {
            return res.status(500).json({ error: 'Failed to save logo.' });
        }
    });
});

router.delete('/settings/logo', requireAuth, async (req, res) => {
    try {
        const [[row]] = await db.query("SELECT setting_value FROM settings WHERE setting_key='system_logo'");
        if (row && row.setting_value) {
            const filePath = path.join(__dirname, '..', 'public', row.setting_value);
            const fs = require('fs');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        await db.query("DELETE FROM settings WHERE setting_key='system_logo'");
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to remove logo.' });
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
router.post('/bulk-activate', requireAuth, async (req, res) => {
    try {
        const [sr] = await db.query("UPDATE students SET status='active' WHERE status='inactive'");
        const [tr] = await db.query("UPDATE teachers SET status='active' WHERE status='inactive'");
        return res.json({ success: true, students: sr.affectedRows, teachers: tr.affectedRows });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to activate.' });
    }
});

// ---- Permanently Remove Deleted Records ----
router.post('/bulk-purge-deleted', requireAuth, async (req, res) => {
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

router.post('/holidays', requireAuth, async (req, res) => {
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

router.delete('/holidays/:id', requireAuth, async (req, res) => {
    try {
        await db.query('DELETE FROM holidays WHERE id = ?', [req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete holiday.' });
    }
});

// ---- Admin Users CRUD ----
router.post('/users', requireRole('super_admin'), async (req, res) => {
    const { username, fullname, email, password, role, school_id } = req.body;
    if (!username || !fullname || !password) return res.status(400).json({ error: 'Username, full name, and password are required.' });
    try {
        const bcrypt = require('bcrypt');
        const hash = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (username, password, fullname, email, role, school_id) VALUES (?, ?, ?, ?, ?, ?)',
            [username, hash, fullname, email || null, role || 'principal', school_id || null]
        );
        return res.json({ success: true });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already exists.' });
        return res.status(500).json({ error: 'Failed to create admin.' });
    }
});

router.put('/users/:id', requireRole('super_admin'), async (req, res) => {
    const { username, fullname, email, password, role, school_id } = req.body;
    if (!username || !fullname) return res.status(400).json({ error: 'Username and full name are required.' });
    try {
        if (password) {
            const bcrypt = require('bcrypt');
            const hash = await bcrypt.hash(password, 10);
            await db.query(
                'UPDATE users SET username=?, fullname=?, email=?, password=?, role=?, school_id=? WHERE id=?',
                [username, fullname, email || null, hash, role || 'principal', school_id || null, req.params.id]
            );
        } else {
            await db.query(
                'UPDATE users SET username=?, fullname=?, email=?, role=?, school_id=? WHERE id=?',
                [username, fullname, email || null, role || 'principal', school_id || null, req.params.id]
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
        await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete admin.' });
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

router.post('/events', requireAuth, async (req, res) => {
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

router.put('/events/:id', requireAuth, async (req, res) => {
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

router.delete('/events/:id', requireAuth, async (req, res) => {
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

router.post('/school-days', requireAuth, async (req, res) => {
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

router.delete('/school-days/:id', requireAuth, async (req, res) => {
    try {
        await db.query('DELETE FROM school_days WHERE id = ?', [req.params.id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete school day.' });
    }
});

// ---- Reports Data ----
router.get('/reports', requireAuth, async (req, res) => {
    const startDate = req.query.start_date || new Date().toISOString().slice(0, 10);
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

        // Stats summary
        const totalDays = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
        const uniquePersons = new Set(rows.map(r => r.person_name)).size;
        const presentCount = rows.filter(r => r.time_in).length;
        const lateCount = rows.filter(r => r.status === 'late').length;

        return res.json({
            records: rows,
            summary: { total_days: totalDays, unique_persons: uniquePersons, present_count: presentCount, late_count: lateCount, total_records: rows.length }
        });
    } catch (err) {
        console.error('Reports error:', err);
        return res.status(500).json({ error: 'Failed to generate report.' });
    }
});

// ---- Reports: Daily Summary (per-school) ----
router.get('/reports/daily-summary', requireAuth, async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const schoolId = applySchoolFilter(req);
    try {
        let query = `
            SELECT s.id, s.name,
                (SELECT COUNT(*) FROM students st WHERE st.school_id = s.id AND st.status = 'active') as enrolled,
                (SELECT COUNT(DISTINCT a.person_id) FROM attendance a INNER JOIN students st ON a.person_id = st.id AND st.status = 'active' WHERE a.school_id = s.id AND a.person_type = 'student' AND a.date = ? AND a.time_in IS NOT NULL) as present,
                (SELECT COUNT(DISTINCT a.person_id) FROM attendance a INNER JOIN students st ON a.person_id = st.id AND st.status = 'active' WHERE a.school_id = s.id AND a.person_type = 'student' AND a.date = ? AND a.status = 'late') as late_count,
                (SELECT COUNT(*) FROM teachers t WHERE t.school_id = s.id AND t.status = 'active') as teachers_total,
                (SELECT COUNT(DISTINCT a.person_id) FROM attendance a INNER JOIN teachers t ON a.person_id = t.id AND t.status = 'active' WHERE a.school_id = s.id AND a.person_type = 'teacher' AND a.date = ? AND a.time_in IS NOT NULL) as teachers_present
            FROM schools s WHERE s.status = 'active'`;
        const params = [date, date, date];
        if (schoolId) { query += ' AND s.id = ?'; params.push(schoolId); }
        query += ' ORDER BY s.name';
        const [rows] = await db.query(query, params);

        const schools = rows.map(s => ({
            id: s.id,
            name: s.name,
            enrolled: s.enrolled,
            present: s.present,
            late: s.late_count,
            absent: Math.max(0, s.enrolled - s.present),
            rate: s.enrolled > 0 ? Math.min(100, Math.round((s.present / s.enrolled) * 100)) : 0,
            teachers_present: s.teachers_present || 0,
            teachers_total: s.teachers_total || 0
        }));

        // Totals
        const totals = schools.reduce((acc, s) => {
            acc.enrolled += s.enrolled;
            acc.present += s.present;
            acc.late += s.late;
            acc.absent += s.absent;
            acc.teachers_present += s.teachers_present;
            acc.teachers_total += s.teachers_total;
            return acc;
        }, { enrolled: 0, present: 0, late: 0, absent: 0, teachers_present: 0, teachers_total: 0 });
        totals.rate = totals.enrolled > 0 ? Math.min(100, Math.round((totals.present / totals.enrolled) * 100)) : 0;

        return res.json({ schools, totals });
    } catch (err) {
        console.error('Daily summary error:', err);
        return res.status(500).json({ error: 'Failed to generate daily summary.' });
    }
});

// ---- Reports: Absentee List ----
router.get('/reports/absentees', requireAuth, async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const schoolId = applySchoolFilter(req);
    try {
        let query = `SELECT s.id, s.firstname, s.lastname, s.lrn, s.section_id, sc.name as school_name,
                sc.contact as school_contact, gl.name as grade_name, sec.name as section_name, sec.adviser
            FROM students s
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            WHERE s.status = 'active'
              AND s.id NOT IN (SELECT person_id FROM attendance WHERE person_type='student' AND date = ? AND time_in IS NOT NULL)`;
        const params = [date];
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
    const targetDate = req.query.date || new Date().toISOString().slice(0, 10);
    const schoolId = applySchoolFilter(req);
    try {
        const schoolFilter = schoolId ? ' AND s.school_id = ?' : '';
        const schoolParams = schoolId ? [schoolId] : [];
        const schoolDay = await checkSchoolDay(targetDate, schoolId);

        const [[totalRow]] = await db.query(
            `SELECT COUNT(*) as cnt FROM students s WHERE s.status = 'active'` + schoolFilter,
            schoolParams
        );

        let presentQuery = `SELECT s.id, s.firstname, s.lastname, s.lrn,
                gl.name as grade_name, sec.name as section_name, sec.adviser,
                sc.name as school_name,
                CASE WHEN SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) > 0 THEN 'Late' ELSE 'Present' END as attendance_status
            FROM attendance a
            INNER JOIN students s ON a.person_id = s.id
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            WHERE a.person_type = 'student'
              AND s.status = 'active'
              AND a.date = ?
              AND a.time_in IS NOT NULL`;
        const presentParams = [targetDate];
        if (schoolId) { presentQuery += ' AND a.school_id = ?'; presentParams.push(schoolId); }
        presentQuery += ` GROUP BY s.id, s.firstname, s.lastname, s.lrn, gl.name, sec.name, sec.adviser, sc.name
                          ORDER BY s.lastname, s.firstname`;

        let absentQuery = `SELECT s.id, s.firstname, s.lastname, s.lrn,
                gl.name as grade_name, sec.name as section_name, sec.adviser,
                sc.name as school_name
            FROM students s
            LEFT JOIN schools sc ON s.school_id = sc.id
            LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
            LEFT JOIN sections sec ON s.section_id = sec.id
            WHERE s.status = 'active'
              AND s.id NOT IN (
                  SELECT person_id FROM attendance
                  WHERE person_type='student' AND date = ? AND time_in IS NOT NULL
              )`;
        const absentParams = [targetDate];
        if (schoolId) { absentQuery += ' AND s.school_id = ?'; absentParams.push(schoolId); }
        absentQuery += ' ORDER BY s.lastname, s.firstname';

        const [presentRows, absentRows] = await Promise.all([
            db.query(presentQuery, presentParams).then(r => r[0]),
            db.query(absentQuery, absentParams).then(r => r[0]),
        ]);

        const presentStudents = presentRows.map(row => ({
            ...row,
            name: `${row.firstname || ''} ${row.lastname || ''}`.trim() || 'Student',
            attendance_status: row.attendance_status || 'Present',
            attendance_date: targetDate
        }));
        const absentStudents = absentRows.map(row => ({
            ...row,
            name: `${row.firstname || ''} ${row.lastname || ''}`.trim() || 'Student',
            attendance_status: 'Absent',
            attendance_date: targetDate
        }));

        return res.json({
            date: targetDate,
            is_school_day: schoolDay.isSchoolDay,
            non_school_day_reason: schoolDay.reason,
            totals: {
                students_total: totalRow.cnt,
                present: presentStudents.length,
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
    const days = parseInt(req.query.days) || 2;
    let schoolId = applySchoolFilter(req);
    if (!schoolId && req.query.school_id) schoolId = parseInt(req.query.school_id, 10);
    try {
        const baseDate = req.query.date || new Date().toISOString().slice(0, 10);
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
    const today = req.query.date || new Date().toISOString().slice(0, 10);
    const type = req.query.type || 'student';
    const schoolId = applySchoolFilter(req);
    try {
        let query, params;
        if (type === 'student') {
            query = `SELECT s.id, s.firstname, s.lastname, s.lrn, sc.name as school_name,
                gl.name as grade_name, sec.name as section_name
                FROM students s
                LEFT JOIN schools sc ON s.school_id = sc.id
                LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
                LEFT JOIN sections sec ON s.section_id = sec.id
                WHERE s.status = 'active'
                AND s.id NOT IN (SELECT person_id FROM attendance WHERE person_type = 'student' AND date = ?)`;
            params = [today];
            if (schoolId) { query += ' AND s.school_id = ?'; params.push(schoolId); }
        } else {
            query = `SELECT t.id, t.firstname, t.lastname, t.employee_id, sc.name as school_name
                FROM teachers t
                LEFT JOIN schools sc ON t.school_id = sc.id
                WHERE t.status = 'active'
                AND t.id NOT IN (SELECT person_id FROM attendance WHERE person_type = 'teacher' AND date = ?)`;
            params = [today];
            if (schoolId) { query += ' AND t.school_id = ?'; params.push(schoolId); }
        }
        query += ' ORDER BY lastname, firstname';
        const [rows] = await db.query(query, params);
        return res.json(rows);
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
router.get('/is-school-day', requireAuth, async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    try {
        const [rows] = await db.query('SELECT * FROM school_days WHERE date = ?', [date]);
        if (rows.length > 0 && !rows[0].is_school_day) {
            return res.json({ is_school_day: false, reason: rows[0].reason || 'Non-school day' });
        }
        // If weekend (Sat or Sun), not a school day
        const dayOfWeek = new Date(date + 'T00:00:00').getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return res.json({ is_school_day: false, reason: dayOfWeek === 0 ? 'Sunday' : 'Saturday' });
        }
        return res.json({ is_school_day: true, reason: null });
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
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
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
    const today = new Date().toISOString().slice(0, 10);
    try {
        const [totalStudents] = await db.query(
            "SELECT COUNT(*) as cnt FROM students WHERE school_id = ? AND status = 'active'", [schoolId]);
        const [presentStudents] = await db.query(
            "SELECT COUNT(DISTINCT a.person_id) as cnt FROM attendance a INNER JOIN students s ON a.person_id = s.id AND a.person_type = 'student' WHERE s.school_id = ? AND a.date = ? AND a.status IN ('present','late')", [schoolId, today]);
        const [lateStudents] = await db.query(
            "SELECT COUNT(DISTINCT a.person_id) as cnt FROM attendance a INNER JOIN students s ON a.person_id = s.id AND a.person_type = 'student' WHERE s.school_id = ? AND a.date = ? AND a.status = 'late'", [schoolId, today]);
        const [totalTeachers] = await db.query(
            "SELECT COUNT(*) as cnt FROM teachers WHERE school_id = ? AND status = 'active'", [schoolId]);
        const [presentTeachers] = await db.query(
            "SELECT COUNT(DISTINCT a.person_id) as cnt FROM attendance a INNER JOIN teachers t ON a.person_id = t.id AND a.person_type = 'teacher' WHERE t.school_id = ? AND a.date = ?", [schoolId, today]);

        const total = totalStudents[0].cnt;
        const present = presentStudents[0].cnt;
        return res.json({
            students_total: total,
            students_present: present,
            students_absent: Math.max(0, total - present),
            students_late: lateStudents[0].cnt,
            teachers_total: totalTeachers[0].cnt,
            teachers_present: presentTeachers[0].cnt
        });
    } catch (err) {
        console.error('School KPI error:', err);
        return res.status(500).json({ error: 'Failed to get KPI.' });
    }
});

// Section KPI (today's attendance stats for a section)
router.get('/section-kpi/:id', requireAuth, async (req, res) => {
    const sectionId = parseInt(req.params.id, 10);
    const today = new Date().toISOString().slice(0, 10);
    try {
        const [totalStudents] = await db.query(
            "SELECT COUNT(*) as cnt FROM students WHERE section_id = ? AND status = 'active'", [sectionId]);
        const [presentStudents] = await db.query(
            "SELECT COUNT(DISTINCT a.person_id) as cnt FROM attendance a INNER JOIN students s ON a.person_id = s.id AND a.person_type = 'student' WHERE s.section_id = ? AND a.date = ? AND a.status IN ('present','late')", [sectionId, today]);

        const total = totalStudents[0].cnt;
        const present = presentStudents[0].cnt;
        return res.json({
            total: total,
            present: present,
            absent: Math.max(0, total - present)
        });
    } catch (err) {
        console.error('Section KPI error:', err);
        return res.status(500).json({ error: 'Failed to get KPI.' });
    }
});

// ---- School Logo Upload ----
router.post('/schools/:id/logo', requireAuth, function(req, res) {
    logoUpload.single('logo')(req, res, async function(err) {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        try {
            const logoPath = '/uploads/logos/' + req.file.filename;
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

        // Total active students
        const schoolWhere = schoolId ? ' AND school_id = ?' : '';
        const schoolParams = schoolId ? [schoolId] : [];
        const [[totalRow]] = await db.query(
            `SELECT COUNT(*) as cnt FROM students WHERE status='active'` + schoolWhere,
            schoolParams
        );
        const totalStudents = totalRow.cnt;

        // Present counts per day
        let pQuery = `SELECT DATE(a.date) as day, COUNT(DISTINCT a.person_id) as present
                      FROM attendance a
                      INNER JOIN students s ON a.person_id = s.id AND s.status = 'active'
                      WHERE a.person_type = 'student' AND a.date BETWEEN ? AND ? AND a.time_in IS NOT NULL`;
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
            const absent  = isWeekend ? 0 : Math.max(0, totalStudents - present);
            days.push({ date: ds, present, absent, total: totalStudents, isWeekend });
            cur.setDate(cur.getDate() + 1);
        }

        return res.json({ year, month, totalStudents, days });
    } catch (err) {
        console.error('Monthly attendance error:', err);
        return res.status(500).json({ error: 'Failed to load monthly attendance.' });
    }
});

module.exports = router;
