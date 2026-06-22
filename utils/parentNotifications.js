const db = require('../config/database');
const { nowDateTime, formatTime12 } = require('./appTime');
const { ATTENDANCE_SCAN_LABELS, normalizeEventLabel } = require('./attendanceStatus');
const { sendPushToParent } = require('./firebasePush');

function normalizeContact(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('63') && digits.length === 12) digits = `0${digits.slice(2)}`;
    if (digits.length === 10 && digits.startsWith('9')) digits = `0${digits}`;
    return digits;
}

function displayStudentName(student) {
    return [student.firstname, student.middlename ? `${student.middlename.charAt(0).toUpperCase()}.` : '', student.lastname]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeAnnouncementType(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const aliases = {
        general: 'announcement_general',
        announcement: 'announcement_general',
        general_announcement: 'announcement_general',
        parent_meeting: 'announcement_parent_meeting',
        meeting: 'announcement_parent_meeting',
        class_meeting: 'announcement_class_meeting',
        holiday: 'announcement_holiday',
        no_class: 'announcement_holiday',
        no_classes: 'announcement_holiday',
        school_event: 'announcement_school_event',
        event: 'announcement_school_event',
        emergency: 'announcement_emergency',
        emergency_announcement: 'announcement_emergency',
        reminder: 'announcement_reminder'
    };
    return aliases[raw] || raw || 'announcement_general';
}

function notificationTypeLabel(type) {
    const labels = {
        attendance_time_in: 'Attendance',
        attendance_late_time_in: 'Late',
        attendance_pm_time_in: 'PM Time In',
        attendance_pm_late_time_in: 'PM Late',
        attendance_lunch_out: 'Lunch Out',
        attendance_returned: 'Returned',
        attendance_early_out: 'Early Dismissal',
        attendance_completed: 'Completed',
        attendance_absent: 'Absent',
        attendance_flagged: '2-Day Flag',
        announcement_general: 'Announcement',
        announcement_parent_meeting: 'Parent Meeting',
        announcement_class_meeting: 'Class Meeting',
        announcement_holiday: 'Holiday / No Classes',
        announcement_school_event: 'School Event',
        announcement_emergency: 'Emergency',
        announcement_reminder: 'Reminder'
    };
    const normalized = normalizeAnnouncementType(type);
    return labels[type] || labels[normalized] || String(type || 'Notification').replace(/[_-]+/g, ' ');
}

function notificationCategory(type) {
    const value = String(type || '');
    if (value.startsWith('attendance_')) return 'attendance';
    if (value.includes('meeting')) return 'meetings';
    if (value.includes('holiday') || value.includes('no_class')) return 'holidays';
    if (value.includes('emergency') || value.includes('absent') || value.includes('flagged') || value.includes('early')) return 'alerts';
    return 'announcements';
}

function notificationTone(type) {
    const value = String(type || '');
    if (value.includes('emergency') || value.includes('absent') || value.includes('flagged') || value.includes('early')) return 'alert';
    if (value.includes('late') || value.includes('holiday') || value.includes('meeting') || value.includes('lunch')) return 'warning';
    if (value.includes('completed') || value.includes('returned') || value.includes('time_in')) return 'success';
    return 'info';
}

function normalizeCreatedAt(value) {
    if (!value) return nowDateTime();
    if (value instanceof Date) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        const h = String(value.getHours()).padStart(2, '0');
        const min = String(value.getMinutes()).padStart(2, '0');
        const s = String(value.getSeconds()).padStart(2, '0');
        return `${y}-${m}-${d} ${h}:${min}:${s}`;
    }
    return String(value).replace('T', ' ').slice(0, 19);
}

function attendanceCopy(label, studentName, eventTime) {
    const normalized = normalizeEventLabel(label);
    const time = formatTime12(eventTime);
    const copy = {
        [ATTENDANCE_SCAN_LABELS.TIME_IN]: {
            type: 'attendance_time_in',
            title: 'Student Time In',
            message: `Your child ${studentName} has timed in at ${time}.`
        },
        [ATTENDANCE_SCAN_LABELS.LATE_TIME_IN]: {
            type: 'attendance_late_time_in',
            title: 'Student Late',
            message: `Your child ${studentName} arrived late at ${time}.`
        },
        [ATTENDANCE_SCAN_LABELS.PM_TIME_IN]: {
            type: 'attendance_pm_time_in',
            title: 'PM Time In',
            message: `Your child ${studentName} has entered for the PM session at ${time}.`
        },
        [ATTENDANCE_SCAN_LABELS.PM_LATE_TIME_IN]: {
            type: 'attendance_pm_late_time_in',
            title: 'PM Late Time In',
            message: `Your child ${studentName} arrived late for the PM session at ${time}.`
        },
        [ATTENDANCE_SCAN_LABELS.LUNCH_OUT]: {
            type: 'attendance_lunch_out',
            title: 'Lunch Out',
            message: `Your child ${studentName} went out for lunch at ${time}.`
        },
        [ATTENDANCE_SCAN_LABELS.WELCOME_BACK]: {
            type: 'attendance_returned',
            title: 'Student Returned',
            message: `Your child ${studentName} returned to school at ${time}.`
        },
        [ATTENDANCE_SCAN_LABELS.RETURNED]: {
            type: 'attendance_returned',
            title: 'Student Returned',
            message: `Your child ${studentName} returned to school at ${time}.`
        },
        [ATTENDANCE_SCAN_LABELS.EARLY_OUT]: {
            type: 'attendance_early_out',
            title: 'Early Dismissal Alert',
            message: `Your child ${studentName} left school early at ${time}. Please contact the adviser if needed.`
        },
        [ATTENDANCE_SCAN_LABELS.COMPLETED]: {
            type: 'attendance_completed',
            title: 'Attendance Completed',
            message: `Your child ${studentName} completed attendance at ${time}.`
        }
    };
    return copy[normalized] || null;
}

async function getStudentContext(studentId) {
    const [[student]] = await db.query(
        `SELECT
            s.id, s.firstname, s.lastname, s.middlename, s.guardian_contact,
            s.school_id, s.grade_level_id, s.section_id,
            sc.name AS school_name,
            gl.name AS grade_name,
            sec.name AS section_name
         FROM students s
         LEFT JOIN schools sc ON s.school_id = sc.id
         LEFT JOIN grade_levels gl ON s.grade_level_id = gl.id
         LEFT JOIN sections sec ON s.section_id = sec.id
         WHERE s.id = ?
         LIMIT 1`,
        [studentId]
    );
    if (!student) return null;
    return { ...student, name: displayStudentName(student) };
}

async function getLinkedParentsForContact(contact) {
    const normalized = normalizeContact(contact);
    if (!normalized) return [];
    const [parents] = await db.query(
        `SELECT id, guardian_name, contact_number, normalized_contact
         FROM parents
         WHERE status = 'active' AND normalized_contact = ?`,
        [normalized]
    );
    return parents;
}

async function insertParentNotification(payload) {
    if (!payload || !payload.parentId || !payload.sourceKey || !payload.title || !payload.message) return false;
    const [result] = await db.query(
        `INSERT INTO parent_notifications
            (parent_id, student_id, school_id, grade_level_id, section_id, type, title, message,
             source_key, source_notification_id, created_by, created_by_role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            title = VALUES(title),
            message = VALUES(message),
            type = VALUES(type),
            student_id = VALUES(student_id),
            school_id = VALUES(school_id),
            grade_level_id = VALUES(grade_level_id),
            section_id = VALUES(section_id),
            source_notification_id = VALUES(source_notification_id),
            created_by = VALUES(created_by),
            created_by_role = VALUES(created_by_role)`,
        [
            payload.parentId,
            payload.studentId || null,
            payload.schoolId || null,
            payload.gradeLevelId || null,
            payload.sectionId || null,
            payload.type || 'announcement_general',
            payload.title,
            payload.message,
            payload.sourceKey,
            payload.sourceNotificationId || null,
            payload.createdBy || null,
            payload.createdByRole || null,
            normalizeCreatedAt(payload.createdAt)
        ]
    );
    // Only a genuinely new inbox row should create a device push. Existing rows
    // are refreshed during app sync and must not notify the guardian again.
    if (result.affectedRows === 1) {
        sendPushToParent(payload.parentId, {
            notificationId: result.insertId,
            studentId: payload.studentId,
            type: payload.type,
            title: payload.title,
            message: payload.message
        }).catch(error => console.error('Parent FCM send error:', error.message));
    }
    return true;
}

async function notifyParentsForStudentScan({ personType, personId, label, eventTime }) {
    if (personType !== 'student') return 0;
    const child = await getStudentContext(personId);
    if (!child) return 0;
    const copy = attendanceCopy(label, child.name, eventTime);
    if (!copy) return 0;
    const parents = await getLinkedParentsForContact(child.guardian_contact);
    let count = 0;
    for (const parent of parents) {
        await insertParentNotification({
            parentId: parent.id,
            studentId: child.id,
            schoolId: child.school_id,
            gradeLevelId: child.grade_level_id,
            sectionId: child.section_id,
            type: copy.type,
            title: copy.title,
            message: copy.message,
            sourceKey: `attendance:${child.id}:${normalizeCreatedAt(eventTime)}:${copy.type}`,
            createdBy: 'Desktop Scanner',
            createdByRole: 'scanner',
            createdAt: eventTime
        });
        count++;
    }
    return count;
}

async function syncAttendanceNotificationsForParent(parent, children, date) {
    const parentId = parent.parent_id || parent.id;
    if (!parentId) return;
    for (const child of children || []) {
        for (const entry of child.timeline || []) {
            const copy = attendanceCopy(entry.label || entry.label_display, child.name, entry.time);
            if (!copy) continue;
            await insertParentNotification({
                parentId,
                studentId: child.id,
                schoolId: child.school_id,
                gradeLevelId: child.grade_level_id,
                sectionId: child.section_id,
                type: copy.type,
                title: copy.title,
                message: copy.message,
                sourceKey: `attendance:${child.id}:${normalizeCreatedAt(entry.time)}:${copy.type}`,
                createdBy: 'Desktop Scanner',
                createdByRole: 'scanner',
                createdAt: entry.time
            });
        }
        if (child.absence_final && !child.timeline?.length && child.today_status === 'Absent') {
            await insertParentNotification({
                parentId,
                studentId: child.id,
                schoolId: child.school_id,
                gradeLevelId: child.grade_level_id,
                sectionId: child.section_id,
                type: 'attendance_absent',
                title: 'Student Absent',
                message: `Your child ${child.name} has no attendance record today.`,
                sourceKey: `absent:${child.id}:${date}`,
                createdBy: 'EduTrack',
                createdByRole: 'system',
                createdAt: `${date} 16:00:00`
            });
        }
        if (Number(child.consecutive_absences || 0) >= 2) {
            await insertParentNotification({
                parentId,
                studentId: child.id,
                schoolId: child.school_id,
                gradeLevelId: child.grade_level_id,
                sectionId: child.section_id,
                type: 'attendance_flagged',
                title: 'Attendance Alert',
                message: `Your child ${child.name} has been absent for 2 consecutive school days.`,
                sourceKey: `flagged:${child.id}:${date}`,
                createdBy: 'EduTrack',
                createdByRole: 'system',
                createdAt: `${date} 16:01:00`
            });
        }
    }
}

async function getTargetedAnnouncementRows(children) {
    const schoolIds = [...new Set((children || []).map(child => child.school_id).filter(Boolean))];
    const gradeIds = [...new Set((children || []).map(child => child.grade_level_id).filter(Boolean))];
    const sectionIds = [...new Set((children || []).map(child => child.section_id).filter(Boolean))];
    const studentIds = [...new Set((children || []).map(child => child.id).filter(Boolean))];
    const clauses = ['(n.target_audience IS NULL AND n.school_id IS NULL AND n.grade_level_id IS NULL AND n.section_id IS NULL AND n.student_id IS NULL)'];
    const params = [];
    if (schoolIds.length) {
        clauses.push('(n.school_id IN (?) AND n.grade_level_id IS NULL AND n.section_id IS NULL AND n.student_id IS NULL)');
        params.push(schoolIds);
    }
    if (gradeIds.length) {
        clauses.push('(n.grade_level_id IN (?) AND n.section_id IS NULL AND n.student_id IS NULL)');
        params.push(gradeIds);
    }
    if (sectionIds.length) {
        clauses.push('(n.section_id IN (?) AND n.student_id IS NULL)');
        params.push(sectionIds);
    }
    if (studentIds.length) {
        clauses.push('n.student_id IN (?)');
        params.push(studentIds);
    }
    const [rows] = await db.query(
        `SELECT n.*, s.name AS school_name, gl.name AS grade_name, sec.name AS section_name
         FROM notifications n
         LEFT JOIN schools s ON n.school_id = s.id
         LEFT JOIN grade_levels gl ON n.grade_level_id = gl.id
         LEFT JOIN sections sec ON n.section_id = sec.id
         WHERE ${clauses.join(' OR ')}
         ORDER BY n.created_at DESC
         LIMIT 100`,
        params
    );
    return rows;
}

async function syncAnnouncementNotificationsForParent(parent, children) {
    const parentId = parent.parent_id || parent.id;
    if (!parentId) return;
    const rows = await getTargetedAnnouncementRows(children || []);
    for (const row of rows) {
        const type = normalizeAnnouncementType(row.type);
        const matchedChild = row.student_id
            ? (children || []).find(child => Number(child.id) === Number(row.student_id))
            : null;
        await insertParentNotification({
            parentId,
            studentId: row.student_id || null,
            schoolId: row.school_id || (matchedChild && matchedChild.school_id) || null,
            gradeLevelId: row.grade_level_id || (matchedChild && matchedChild.grade_level_id) || null,
            sectionId: row.section_id || (matchedChild && matchedChild.section_id) || null,
            type,
            title: row.title || notificationTypeLabel(type),
            message: row.message || '',
            sourceKey: `announcement:${row.id}`,
            sourceNotificationId: row.id,
            createdBy: row.created_by_name || row.created_by || null,
            createdByRole: row.created_by_role || null,
            createdAt: row.created_at
        });
    }
}

async function createNoClassNotificationForParent(parent, schoolId, date, day) {
    const parentId = parent.parent_id || parent.id;
    if (!parentId || !day || day.is_school_day) return;
    await insertParentNotification({
        parentId,
        schoolId: schoolId || null,
        type: 'announcement_holiday',
        title: day.type || 'No Classes',
        message: day.reason || 'No classes are scheduled today.',
        sourceKey: `no-class:${schoolId || 'all'}:${date}`,
        createdBy: 'EduTrack',
        createdByRole: 'system',
        createdAt: `${date} 06:00:00`
    });
}

async function getParentInbox(parentId, options = {}) {
    const params = [parentId];
    let where = 'pn.parent_id = ?';
    if (options.unreadOnly) where += ' AND pn.is_read = 0';
    if (options.category && options.category !== 'all') {
        if (options.category === 'attendance') where += " AND pn.type LIKE 'attendance_%'";
        else if (options.category === 'announcements') where += " AND pn.type LIKE 'announcement_%'";
        else if (options.category === 'meetings') where += " AND pn.type LIKE '%meeting%'";
        else if (options.category === 'holidays') where += " AND (pn.type LIKE '%holiday%' OR pn.type LIKE '%no_class%')";
        else if (options.category === 'alerts') where += " AND (pn.type LIKE '%emergency%' OR pn.type LIKE '%absent%' OR pn.type LIKE '%flagged%' OR pn.type LIKE '%early%')";
    }
    const [rows] = await db.query(
        `SELECT
            pn.id AS notification_id,
            pn.parent_id,
            pn.student_id,
            pn.school_id,
            pn.grade_level_id,
            pn.section_id,
            pn.type,
            pn.title,
            pn.message,
            pn.source_notification_id,
            pn.created_by,
            pn.created_by_role,
            pn.is_read,
            pn.created_at,
            pn.read_at,
            st.firstname,
            st.lastname,
            st.middlename,
            sc.name AS school_name,
            gl.name AS grade_level,
            sec.name AS section
         FROM parent_notifications pn
         LEFT JOIN students st ON pn.student_id = st.id
         LEFT JOIN schools sc ON pn.school_id = sc.id
         LEFT JOIN grade_levels gl ON pn.grade_level_id = gl.id
         LEFT JOIN sections sec ON pn.section_id = sec.id
         WHERE ${where}
         ORDER BY pn.created_at DESC, pn.id DESC
         LIMIT ?`,
        [...params, Number(options.limit || 100)]
    );
    return rows.map(row => {
        const studentName = row.student_id ? displayStudentName(row) : '';
        return {
            ...row,
            key: `parent-${row.notification_id}`,
            child_id: row.student_id,
            child_name: studentName,
            student_name: studentName,
            type_label: notificationTypeLabel(row.type),
            category: notificationCategory(row.type),
            tone: notificationTone(row.type),
            time_display: formatTime12(row.created_at),
            is_read: Number(row.is_read) === 1
        };
    });
}

async function getParentUnreadCount(parentId) {
    const [[row]] = await db.query('SELECT COUNT(*) AS count FROM parent_notifications WHERE parent_id = ? AND is_read = 0', [parentId]);
    return Number(row && row.count || 0);
}

async function markParentNotificationsRead(parentId, ids) {
    if (!parentId) return 0;
    if (Array.isArray(ids) && ids.length) {
        const cleanIds = ids.map(id => parseInt(id, 10)).filter(id => Number.isInteger(id) && id > 0);
        if (!cleanIds.length) return 0;
        const [result] = await db.query(
            'UPDATE parent_notifications SET is_read = 1, read_at = COALESCE(read_at, ?) WHERE parent_id = ? AND id IN (?)',
            [nowDateTime(), parentId, cleanIds]
        );
        return result.affectedRows || 0;
    }
    const [result] = await db.query(
        'UPDATE parent_notifications SET is_read = 1, read_at = COALESCE(read_at, ?) WHERE parent_id = ? AND is_read = 0',
        [nowDateTime(), parentId]
    );
    return result.affectedRows || 0;
}

async function registerParentDevice({ parentId, contactNumber, normalizedContact, deviceToken, pushToken, platform, appVersion, userAgent }) {
    if (!parentId || !deviceToken) return false;
    await db.query(
        `INSERT INTO parent_devices
            (parent_id, contact_number, normalized_contact, device_token, push_token, platform, app_version, user_agent, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            parent_id = VALUES(parent_id),
            contact_number = VALUES(contact_number),
            normalized_contact = VALUES(normalized_contact),
            push_token = COALESCE(VALUES(push_token), push_token),
            platform = VALUES(platform),
            app_version = VALUES(app_version),
            user_agent = VALUES(user_agent),
            last_seen_at = VALUES(last_seen_at),
            updated_at = CURRENT_TIMESTAMP`,
        [
            parentId,
            contactNumber || '',
            normalizedContact || normalizeContact(contactNumber),
            deviceToken,
            pushToken || null,
            platform || 'android',
            appVersion || '',
            userAgent || '',
            nowDateTime()
        ]
    );
    return true;
}

async function findAnnouncementTargets(filters) {
    const where = ["s.status != 'deleted'", "s.guardian_contact IS NOT NULL", "s.guardian_contact <> ''"];
    const params = [];
    if (filters.schoolId) {
        where.push('s.school_id = ?');
        params.push(filters.schoolId);
    }
    if (filters.gradeLevelId) {
        where.push('s.grade_level_id = ?');
        params.push(filters.gradeLevelId);
    }
    if (filters.sectionId) {
        where.push('s.section_id = ?');
        params.push(filters.sectionId);
    }
    if (filters.studentId) {
        where.push('s.id = ?');
        params.push(filters.studentId);
    }
    const [students] = await db.query(
        `SELECT
            s.id, s.guardian_contact, s.school_id, s.grade_level_id, s.section_id
         FROM students s
         WHERE ${where.join(' AND ')}`,
        params
    );
    const parentRows = [];
    for (const student of students) {
        const parents = await getLinkedParentsForContact(student.guardian_contact);
        parents.forEach(parent => parentRows.push({ parent, student }));
    }
    return parentRows;
}

async function fanOutAnnouncement(notificationId) {
    const [[row]] = await db.query('SELECT * FROM notifications WHERE id = ? LIMIT 1', [notificationId]);
    if (!row) return 0;
    const targets = await findAnnouncementTargets({
        schoolId: row.school_id,
        gradeLevelId: row.grade_level_id,
        sectionId: row.section_id,
        studentId: row.student_id
    });
    const type = normalizeAnnouncementType(row.type);
    const seenParents = new Set();
    let count = 0;
    for (const target of targets) {
        const oneStudent = row.student_id ? target.student.id : null;
        const key = `${target.parent.id}:${oneStudent || 'all'}`;
        if (!row.student_id && seenParents.has(key)) continue;
        seenParents.add(key);
        await insertParentNotification({
            parentId: target.parent.id,
            studentId: oneStudent,
            schoolId: row.school_id || target.student.school_id,
            gradeLevelId: row.grade_level_id || target.student.grade_level_id,
            sectionId: row.section_id || target.student.section_id,
            type,
            title: row.title || notificationTypeLabel(type),
            message: row.message || '',
            sourceKey: `announcement:${row.id}`,
            sourceNotificationId: row.id,
            createdBy: row.created_by_name || row.created_by || null,
            createdByRole: row.created_by_role || null,
            createdAt: row.created_at
        });
        count++;
    }
    return count;
}

module.exports = {
    normalizeContact,
    normalizeAnnouncementType,
    notificationTypeLabel,
    notificationCategory,
    notificationTone,
    notifyParentsForStudentScan,
    syncAttendanceNotificationsForParent,
    syncAnnouncementNotificationsForParent,
    createNoClassNotificationForParent,
    getParentInbox,
    getParentUnreadCount,
    markParentNotificationsRead,
    registerParentDevice,
    fanOutAnnouncement
};
