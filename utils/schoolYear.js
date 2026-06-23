// School Year helpers — the system supports many school years but exactly ONE
// may be "active" at a time. Enrollment, scanning, and current-year reports all
// resolve against the active year. History (archived years) stays queryable.
const db = require('../config/database');

const LABEL_RE = /^\d{4}-\d{4}$/;

function isValidLabel(label) {
    const raw = String(label || '').trim();
    if (!LABEL_RE.test(raw)) return false;
    const [start, end] = raw.split('-').map(Number);
    return end === start + 1;
}

// The single active school year, or null if none has been opened yet.
async function getActiveSchoolYear() {
    const [[row]] = await db.query(
        "SELECT * FROM school_years WHERE status = 'active' ORDER BY id DESC LIMIT 1"
    );
    return row || null;
}

async function getSchoolYearById(id) {
    const [[row]] = await db.query('SELECT * FROM school_years WHERE id = ?', [Number(id)]);
    return row || null;
}

// All years, newest first, each with how many students are enrolled in it.
async function listSchoolYears() {
    const [rows] = await db.query(`
        SELECT sy.*,
               (SELECT COUNT(*) FROM student_enrollments e
                 WHERE e.school_year_id = sy.id
                   AND e.status IN ('enrolled', 'graduated', 'transferred_out')) AS enrollment_count
        FROM school_years sy
        ORDER BY sy.label DESC, sy.id DESC
    `);
    return rows;
}

// Resolve the school year whose date range contains the given YYYY-MM-DD date.
// Falls back to the active year when no range matches (e.g. dates outside any
// configured range). Used to stamp historical attendance with a year.
async function getSchoolYearForDate(dateStr) {
    if (dateStr) {
        const [[row]] = await db.query(
            `SELECT * FROM school_years
             WHERE start_date IS NOT NULL AND end_date IS NOT NULL
               AND ? BETWEEN start_date AND end_date
             ORDER BY id DESC LIMIT 1`,
            [dateStr]
        );
        if (row) return row;
    }
    return getActiveSchoolYear();
}

// Create a new school year. Optionally make it the active one immediately.
async function createSchoolYear({ label, startDate, endDate, makeActive }) {
    const clean = String(label || '').trim();
    if (!isValidLabel(clean)) {
        throw new Error('School year must look like "2026-2027" (consecutive years).');
    }
    const start = startDate ? String(startDate).trim() : null;
    const end = endDate ? String(endDate).trim() : null;
    if (start && end && start > end) {
        throw new Error('Start date must be on or before the end date.');
    }
    const [existing] = await db.query('SELECT id FROM school_years WHERE label = ?', [clean]);
    if (existing.length) {
        throw new Error(`School year ${clean} already exists.`);
    }
    const [result] = await db.query(
        "INSERT INTO school_years (label, start_date, end_date, status) VALUES (?, ?, ?, 'upcoming')",
        [clean, start, end]
    );
    if (makeActive) {
        await setActiveSchoolYear(result.insertId);
    }
    return getSchoolYearById(result.insertId);
}

// Make a single year active, closing any other currently-active year. Atomic so
// the one-active-year invariant can never be violated by concurrent requests.
async function setActiveSchoolYear(id) {
    const yearId = Number(id);
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [[target]] = await conn.query('SELECT id FROM school_years WHERE id = ?', [yearId]);
        if (!target) {
            throw new Error('School year not found.');
        }
        await conn.query(
            "UPDATE school_years SET status = 'closed' WHERE status = 'active' AND id <> ?",
            [yearId]
        );
        await conn.query("UPDATE school_years SET status = 'active' WHERE id = ?", [yearId]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
    return getSchoolYearById(yearId);
}

// Close a year: mark it closed and archive its enrollment records so they drop
// out of active class lists while remaining available for history and reports.
// NOTE: this intentionally does not yet touch the students cache columns — that
// (and graduation handling) is layered on in a later phase.
async function closeSchoolYear(id) {
    const yearId = Number(id);
    const year = await getSchoolYearById(yearId);
    if (!year) {
        throw new Error('School year not found.');
    }
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query("UPDATE school_years SET status = 'closed' WHERE id = ?", [yearId]);
        await conn.query(
            "UPDATE student_enrollments SET status = 'archived' WHERE school_year_id = ? AND status = 'enrolled'",
            [yearId]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
    return getSchoolYearById(yearId);
}

// Enroll a student into the active school year for a given section. Upserts the
// per-year enrollment record (so a student can have one enrollment per year) and
// syncs the students cache columns (section/grade/school + attendance-eligible)
// so the live scanner, dashboards, and current-year SF2 keep working unchanged.
// Pass schoolYearId to avoid re-looking-up the active year in tight loops (import).
async function enrollStudentInActiveYear({ studentId, schoolId, gradeLevelId, sectionId, enrolledBy = null, schoolYearId = null }) {
    let syId = schoolYearId;
    if (!syId) {
        const active = await getActiveSchoolYear();
        if (!active) {
            throw new Error('There is no active school year yet. Ask the admin to open one first.');
        }
        syId = active.id;
    }
    await db.query(
        `INSERT INTO student_enrollments
            (student_id, school_year_id, school_id, grade_level_id, section_id, status, enrolled_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'enrolled', ?, NOW())
         ON DUPLICATE KEY UPDATE
            school_id = VALUES(school_id),
            grade_level_id = VALUES(grade_level_id),
            section_id = VALUES(section_id),
            status = 'enrolled',
            enrolled_by = VALUES(enrolled_by),
            updated_at = NOW()`,
        [studentId, syId, schoolId, gradeLevelId, sectionId, enrolledBy]
    );
    // Keep the denormalized cache in sync so the student appears in the active
    // section and is attendance-eligible. active_from is preserved if already set.
    await db.query(
        `UPDATE students
            SET school_id = ?, grade_level_id = ?, section_id = ?,
                status = 'active', active_from = COALESCE(active_from, CURDATE())
          WHERE id = ?`,
        [schoolId, gradeLevelId, sectionId, studentId]
    );
    return syId;
}

module.exports = {
    isValidLabel,
    getActiveSchoolYear,
    getSchoolYearById,
    listSchoolYears,
    getSchoolYearForDate,
    createSchoolYear,
    setActiveSchoolYear,
    closeSchoolYear,
    enrollStudentInActiveYear
};
