(function (global) {
    var STATUS_LABELS = {
        active: 'Active',
        inactive: 'Inactive',
        deleted: 'Deleted',
        present: 'Present',
        absent: 'Absent',
        late: 'Late',
        half_day: 'Half-Day',
        'half day': 'Half-Day',
        // Professional final statuses computed from full scan history
        completed: 'Completed',
        returned: 'Returned',
        lunch_out: 'Lunch Out',
        'lunch out': 'Lunch Out',
        half_day_pm: 'Half-Day PM',
        'half day pm': 'Half-Day PM',
        half_day_pm_late: 'Half-Day PM Late',
        'half day pm late': 'Half-Day PM Late',
        half_day_am: 'Half-Day AM',
        'half day am': 'Half-Day AM',
        half_day_am_early_dismissal: 'Half-Day AM Early Dismissal',
        'half day am early dismissal': 'Half-Day AM Early Dismissal',
        half_day_pm_early_dismissal: 'Half-Day PM Early Dismissal',
        'half day pm early dismissal': 'Half-Day PM Early Dismissal',
        attendance_closed: 'Attendance Closed',
        'attendance closed': 'Attendance Closed',
        flagged: 'Flagged',
        pending: 'Pending',
        sent: 'Sent',
        failed: 'Failed',
        complete: 'Complete',
        no_time_in: 'No Time In',
        no_time_out: 'No Time Out',
        pending_time_out: 'Pending Time Out',
        'no time in': 'No Time In',
        'no time out': 'No Time Out',
        'pending time out': 'Pending Time Out'
    };

    function normalizeStatus(value) {
        return String(value || '')
            .trim()
            .replace(/[-_]+/g, ' ')
            .replace(/\s+/g, ' ')
            .toLowerCase();
    }

    function titleCase(value) {
        return String(value || '')
            .trim()
            .replace(/[-_]+/g, ' ')
            .replace(/\s+/g, ' ')
            .split(' ')
            .filter(Boolean)
            .map(function (part) { return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(); })
            .join(' ');
    }

    // `lateHalfDay` (boolean, or an options object { lateHalfDay }) refines a
    // half-day into "Half-Day (Late)". It stays a half-day everywhere else —
    // this is a label-only distinction, so totals/filters are unaffected.
    function statusLabel(value, lateHalfDay) {
        var normalized = normalizeStatus(value);
        if (!normalized) return '-';
        var isLate = lateHalfDay === true || (lateHalfDay && lateHalfDay.lateHalfDay);
        if (isLate && (normalized === 'half day' || normalized === 'half_day')) return 'Half-Day (Late)';
        var underscoreKey = normalized.replace(/\s+/g, '_');
        return STATUS_LABELS[normalized] || STATUS_LABELS[underscoreKey] || titleCase(value);
    }

    global.EduTrackStatus = { label: statusLabel };
    global.formatStatusLabel = statusLabel;
})(window);
