const { compareDateTime } = require('./appTime');

function statusLabel(value) {
    const status = String(value || '').toLowerCase();
    if (status === 'half_day') return 'Half-Day';
    if (status === 'late') return 'Late';
    if (status === 'absent') return 'Absent';
    if (status === 'present') return 'Present';
    return status ? status.replace(/_/g, ' ') : '';
}

function isHalfDayStatus(value) {
    return String(value || '').toLowerCase() === 'half_day';
}

function normalizeSchedule(schedule) {
    return {
        lunchStart: schedule && schedule.lunchStart,
        pmInStart: schedule && schedule.pmInStart,
        pmOutStart: schedule && schedule.pmOutStart
    };
}

function computeDailyAttendanceStatus(input) {
    const timeIn = input && input.timeIn;
    if (!timeIn) {
        return { status: 'absent', label: 'Absent', remarks: 'No attendance recorded for the entire day' };
    }

    const schedule = normalizeSchedule(input.schedule || {});
    const baseStatus = input.baseStatus || 'present';
    const baseLabel = statusLabel(baseStatus);
    const lastTimeIn = (input.lastTimeIn || timeIn);
    const timeOut = input.timeOut || null;

    if (schedule.pmInStart && compareDateTime(timeIn, schedule.pmInStart) >= 0) {
        return {
            status: 'half_day',
            label: 'Half-Day',
            halfDayType: 'pm_only',
            remarks: 'Afternoon Session Only'
        };
    }

    const leftAndDidNotReturn = timeOut && compareDateTime(lastTimeIn, timeOut) <= 0;
    if (leftAndDidNotReturn && schedule.pmOutStart && compareDateTime(timeOut, schedule.pmOutStart) < 0) {
        if (schedule.pmInStart && compareDateTime(timeOut, schedule.pmInStart) < 0) {
            return {
                status: 'half_day',
                label: 'Half-Day',
                halfDayType: 'am_only',
                remarks: 'Morning Session Only'
            };
        }
        return {
            status: 'half_day',
            label: 'Half-Day',
            halfDayType: 'early_dismissal',
            remarks: 'Official Early Dismissal'
        };
    }

    return { status: baseStatus, label: baseLabel, remarks: '' };
}

module.exports = {
    computeDailyAttendanceStatus,
    isHalfDayStatus,
    statusLabel
};
