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

    function statusLabel(value) {
        var normalized = normalizeStatus(value);
        if (!normalized) return '-';
        var underscoreKey = normalized.replace(/\s+/g, '_');
        return STATUS_LABELS[normalized] || STATUS_LABELS[underscoreKey] || titleCase(value);
    }

    global.EduTrackStatus = { label: statusLabel };
    global.formatStatusLabel = statusLabel;
})(window);
