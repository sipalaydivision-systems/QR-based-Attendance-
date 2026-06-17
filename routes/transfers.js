const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { nowDateTime } = require('../utils/appTime');

const ADMIN_ROLES = ['principal', 'super_admin', 'superintendent', 'asst_superintendent'];

function sessionUser(req) { return req.session && req.session.user; }
function isAdviser(u) { return !!u && u.role === 'adviser'; }
function isAdminRole(u) { return !!u && ADMIN_ROLES.includes(u.role); }

function studentName(s) {
    if (s.lastname && s.firstname) {
        return s.lastname + ', ' + s.firstname + (s.middlename ? ' ' + s.middlename.charAt(0) + '.' : '');
    }
    return s.firstname || s.lastname || 'Student';
}
function sectionLabel(sec) {
    if (!sec) return '';
    return (sec.grade_name ? sec.grade_name + ' — ' : '') + sec.name;
}

async function loadStudent(id) {
    const [[s]] = await db.query(
        `SELECT id, firstname, lastname, middlename, lrn, section_id, grade_level_id, school_id
         FROM students WHERE id = ? AND status != 'deleted'`, [id]
    );
    return s || null;
}
async function loadSection(id) {
    const [[sec]] = await db.query(
        `SELECT sec.id, sec.name, sec.school_id, sec.grade_level_id, sec.adviser_teacher_id, gl.name AS grade_name
         FROM sections sec LEFT JOIN grade_levels gl ON sec.grade_level_id = gl.id
         WHERE sec.id = ? AND (sec.status IS NULL OR sec.status != 'deleted')`, [id]
    );
    return sec || null;
}

async function applyStudentMove(studentId, toSectionId, toGradeLevelId) {
    await db.query('UPDATE students SET section_id = ?, grade_level_id = ? WHERE id = ?',
        [toSectionId, toGradeLevelId || null, studentId]);
}
// Move a teacher's advisory section and keep sections.adviser_teacher_id in sync.
async function applyTeacherMove(teacherId, toSectionId, toGradeLevelId, teacherName) {
    await db.query('UPDATE sections SET adviser = NULL, adviser_teacher_id = NULL WHERE adviser_teacher_id = ?', [teacherId]);
    await db.query('UPDATE teachers SET section_id = ?, grade_level_id = ? WHERE id = ?',
        [toSectionId, toGradeLevelId || null, teacherId]);
    if (toSectionId) {
        await db.query('UPDATE sections SET adviser = ?, adviser_teacher_id = ? WHERE id = ?',
            [teacherName || null, teacherId, toSectionId]);
    }
}
// Supersede any still-pending request for the same subject so only one is live.
async function cancelExistingPending(type, subjectId) {
    await db.query(
        "UPDATE transfer_requests SET status = 'cancelled', resolved_at = ? WHERE request_type = ? AND subject_id = ? AND status = 'pending'",
        [nowDateTime(), type, subjectId]
    );
}
async function sectionNameLabel(sectionId) {
    if (!sectionId) return '';
    const [[row]] = await db.query(
        `SELECT sec.name, gl.name AS grade_name FROM sections sec
         LEFT JOIN grade_levels gl ON sec.grade_level_id = gl.id WHERE sec.id = ?`, [sectionId]
    );
    return sectionLabel(row);
}

// POST /api/transfers/student  { student_id, section_id }
// Adviser -> request to the destination section's adviser (or immediate if that
// section has no adviser / is the same adviser). Principal/admin -> immediate.
router.post('/student', requireAuth, async (req, res) => {
    const u = sessionUser(req);
    const studentId = parseInt(req.body.student_id, 10);
    const toSectionId = parseInt(req.body.section_id, 10);
    if (!studentId || !toSectionId) return res.status(400).json({ error: 'Student and destination section are required.' });
    try {
        const student = await loadStudent(studentId);
        if (!student) return res.status(404).json({ error: 'Student not found.' });
        const dest = await loadSection(toSectionId);
        if (!dest) return res.status(404).json({ error: 'Destination section was not found.' });
        if (Number(dest.school_id) !== Number(student.school_id)) return res.status(400).json({ error: 'That section belongs to a different school.' });
        if (Number(dest.id) === Number(student.section_id)) return res.status(400).json({ error: 'The student is already in that section.' });

        if (isAdminRole(u)) {
            if (u.role === 'principal' && Number(u.school_id) !== Number(student.school_id)) {
                return res.status(403).json({ error: 'You can only move students within your school.' });
            }
            await cancelExistingPending('student_section', studentId);
            await applyStudentMove(studentId, dest.id, dest.grade_level_id);
            return res.json({ success: true, applied: true });
        }

        if (isAdviser(u)) {
            const [[me]] = await db.query('SELECT section_id, school_id FROM teachers WHERE id = ?', [u.teacher_id]);
            if (!me || Number(student.section_id) !== Number(me.section_id)) {
                return res.status(403).json({ error: 'You can only transfer students from your own section.' });
            }
            if (Number(dest.school_id) !== Number(me.school_id)) {
                return res.status(403).json({ error: 'You can only transfer within your own school.' });
            }
            const destAdviser = dest.adviser_teacher_id ? Number(dest.adviser_teacher_id) : null;
            await cancelExistingPending('student_section', studentId);
            if (!destAdviser || destAdviser === Number(u.teacher_id)) {
                await applyStudentMove(studentId, dest.id, dest.grade_level_id);
                return res.json({ success: true, applied: true });
            }
            await db.query(
                `INSERT INTO transfer_requests
                    (request_type, school_id, subject_id, subject_name, subject_lrn, from_section_id, from_section_name,
                     to_section_id, to_section_name, to_grade_level_id, requester_role, requester_id, requester_name, approver_teacher_id, status)
                 VALUES ('student_section', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'adviser', ?, ?, ?, 'pending')`,
                [student.school_id, studentId, studentName(student), student.lrn || null,
                 student.section_id || null, await sectionNameLabel(student.section_id),
                 dest.id, sectionLabel(dest), dest.grade_level_id || null,
                 u.teacher_id, u.fullname || 'Adviser', destAdviser]
            );
            return res.json({ success: true, requested: true });
        }

        return res.status(403).json({ error: 'You are not allowed to transfer students.' });
    } catch (err) {
        console.error('Transfer student error:', err);
        return res.status(500).json({ error: 'Failed to process the transfer.' });
    }
});

// POST /api/transfers/teacher  { teacher_id, section_id }
// Principal/admin reassigns a teacher -> the teacher confirms (Accept/Decline).
router.post('/teacher', requireAuth, async (req, res) => {
    const u = sessionUser(req);
    if (!isAdminRole(u)) return res.status(403).json({ error: 'Only an administrator can reassign teachers.' });
    const teacherId = parseInt(req.body.teacher_id, 10);
    const toSectionId = parseInt(req.body.section_id, 10);
    if (!teacherId || !toSectionId) return res.status(400).json({ error: 'Teacher and destination section are required.' });
    try {
        const [[t]] = await db.query("SELECT id, firstname, lastname, section_id, school_id FROM teachers WHERE id = ? AND status != 'deleted'", [teacherId]);
        if (!t) return res.status(404).json({ error: 'Teacher not found.' });
        if (u.role === 'principal' && Number(u.school_id) !== Number(t.school_id)) {
            return res.status(403).json({ error: 'You can only reassign teachers in your school.' });
        }
        const dest = await loadSection(toSectionId);
        if (!dest) return res.status(404).json({ error: 'Destination section was not found.' });
        if (Number(dest.school_id) !== Number(t.school_id)) return res.status(400).json({ error: 'That section belongs to a different school.' });
        if (Number(dest.id) === Number(t.section_id)) return res.status(400).json({ error: 'The teacher already advises that section.' });

        await cancelExistingPending('teacher_section', teacherId);
        await db.query(
            `INSERT INTO transfer_requests
                (request_type, school_id, subject_id, subject_name, from_section_id, from_section_name,
                 to_section_id, to_section_name, to_grade_level_id, requester_role, requester_id, requester_name, approver_teacher_id, status)
             VALUES ('teacher_section', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [t.school_id, teacherId, (t.firstname + ' ' + t.lastname).trim(),
             t.section_id || null, await sectionNameLabel(t.section_id),
             dest.id, sectionLabel(dest), dest.grade_level_id || null,
             u.role, u.id, u.fullname || 'Principal', teacherId]
        );
        return res.json({ success: true, requested: true });
    } catch (err) {
        console.error('Transfer teacher error:', err);
        return res.status(500).json({ error: 'Failed to create the reassignment request.' });
    }
});

// GET /api/transfers/pending — pending approvals for me + resolved-unseen updates I requested.
router.get('/pending', requireAuth, async (req, res) => {
    const u = sessionUser(req);
    try {
        let pending = [];
        if (isAdviser(u) && u.teacher_id) {
            const [rows] = await db.query(
                "SELECT * FROM transfer_requests WHERE approver_teacher_id = ? AND status = 'pending' ORDER BY created_at DESC",
                [u.teacher_id]
            );
            pending = rows;
        }
        const rRole = isAdviser(u) ? 'adviser' : u.role;
        const rId = isAdviser(u) ? u.teacher_id : u.id;
        let updates = [];
        if (rId) {
            const [rows] = await db.query(
                "SELECT * FROM transfer_requests WHERE requester_role = ? AND requester_id = ? AND status IN ('accepted','declined') AND requester_seen = 0 ORDER BY resolved_at DESC LIMIT 20",
                [rRole, rId]
            );
            updates = rows;
        }
        return res.json({ pending, updates });
    } catch (err) {
        console.error('Transfer pending error:', err);
        return res.status(500).json({ error: 'Failed to load requests.' });
    }
});

async function resolveRequest(req, res, accept) {
    const u = sessionUser(req);
    if (!isAdviser(u) || !u.teacher_id) return res.status(403).json({ error: 'Only the assigned teacher can respond.' });
    const id = parseInt(req.params.id, 10);
    try {
        const [[r]] = await db.query('SELECT * FROM transfer_requests WHERE id = ?', [id]);
        if (!r) return res.status(404).json({ error: 'Request not found.' });
        if (Number(r.approver_teacher_id) !== Number(u.teacher_id)) return res.status(403).json({ error: 'This request is not assigned to you.' });
        if (r.status !== 'pending') return res.status(400).json({ error: 'This request was already handled.' });
        if (accept) {
            if (r.request_type === 'student_section') {
                await applyStudentMove(r.subject_id, r.to_section_id, r.to_grade_level_id);
            } else if (r.request_type === 'teacher_section') {
                await applyTeacherMove(r.subject_id, r.to_section_id, r.to_grade_level_id, r.subject_name);
            }
        }
        await db.query('UPDATE transfer_requests SET status = ?, resolved_at = ? WHERE id = ?',
            [accept ? 'accepted' : 'declined', nowDateTime(), id]);
        return res.json({ success: true });
    } catch (err) {
        console.error('Transfer resolve error:', err);
        return res.status(500).json({ error: 'Failed to update the request.' });
    }
}
router.post('/:id/accept', requireAuth, (req, res) => resolveRequest(req, res, true));
router.post('/:id/decline', requireAuth, (req, res) => resolveRequest(req, res, false));

// POST /api/transfers/seen — mark my resolved requests as seen (clears the outcome toasts).
router.post('/seen', requireAuth, async (req, res) => {
    const u = sessionUser(req);
    const rRole = isAdviser(u) ? 'adviser' : u.role;
    const rId = isAdviser(u) ? u.teacher_id : u.id;
    if (!rId) return res.json({ success: true });
    try {
        await db.query(
            "UPDATE transfer_requests SET requester_seen = 1 WHERE requester_role = ? AND requester_id = ? AND status IN ('accepted','declined')",
            [rRole, rId]
        );
        return res.json({ success: true });
    } catch (err) {
        console.error('Transfer seen error:', err);
        return res.status(500).json({ error: 'Failed.' });
    }
});

module.exports = router;
