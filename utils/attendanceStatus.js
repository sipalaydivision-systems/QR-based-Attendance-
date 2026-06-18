const { compareDateTime, parseDateTime } = require('./appTime');

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

function secondsOfDay(parts) {
    if (!parts) return null;
    return parseInt(parts.hour, 10) * 3600 + parseInt(parts.minute, 10) * 60 + parseInt(parts.second, 10);
}

// True when a stored attendance row is a *late* half-day: the daily status is
// half_day and the (PM-only) time-in landed on/after the PM Late cutoff. Pure,
// date-independent (compares clock time only) so every dashboard reads the same
// answer from the same stored data — no schema change, no effect on any total.
function isLateHalfDay(status, timeIn, pmLateTime) {
    if (String(status || '').toLowerCase() !== 'half_day') return false;
    const arrival = secondsOfDay(parseDateTime(timeIn));
    const cutoff = secondsOfDay(parseDateTime(pmLateTime));
    if (arrival === null || cutoff === null) return false;
    return arrival >= cutoff;
}

// Tag each per-person attendance row with `late_half_day` so client renderers
// can label "Half-Day (Late)" consistently. Mutates in place and returns rows.
function decorateLateHalfDays(rows, pmLateTime) {
    if (Array.isArray(rows) && pmLateTime) {
        rows.forEach((r) => { if (r) r.late_half_day = isLateHalfDay(r.status || r.att_status, r.time_in, pmLateTime); });
    }
    return rows;
}

function normalizeSchedule(schedule) {
    return {
        lunchStart: schedule && schedule.lunchStart,
        pmInStart: schedule && schedule.pmInStart,
        pmLateStart: schedule && schedule.pmLateStart,
        pmOutStart: schedule && schedule.pmOutStart
    };
}

// Human label for a half-day, refined by its subtype. A "pm_late" half-day is a
// PM-only arrival that landed after the PM Late Start Time — still a half-day in
// every total, just flagged as late. Used across scanner + dashboards so the
// wording is identical everywhere.
function halfDayLabel(halfDayType) {
    return halfDayType === 'pm_late' ? 'Half-Day (Late)' : 'Half-Day';
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

    // A first arrival on/after the AM-end boundary (lunchStart, e.g. 11:00) missed
    // the morning session entirely, so it is a PM-only (half-day) attendance —
    // counted present for the afternoon. On/after the PM Late line it is a late
    // half-day. The lunch window (lunchStart → pmInStart) is the accepted PM
    // arrival window, so those arrivals are on-time half-days.
    if (schedule.lunchStart && compareDateTime(timeIn, schedule.lunchStart) >= 0) {
        const late = !!schedule.pmLateStart && compareDateTime(timeIn, schedule.pmLateStart) >= 0;
        return {
            status: 'half_day',
            label: late ? 'Half-Day (Late)' : 'Half-Day',
            halfDayType: late ? 'pm_late' : 'pm_only',
            lateHalfDay: late,
            remarks: late ? 'Afternoon Session Only (Late)' : 'Afternoon Session Only'
        };
    }

    // Left the premises and has not returned — classify by *when* they left.
    const leftAndDidNotReturn = timeOut && compareDateTime(lastTimeIn, timeOut) <= 0;
    if (leftAndDidNotReturn && schedule.pmOutStart && compareDateTime(timeOut, schedule.pmOutStart) < 0) {
        // Lunch window [lunchStart, pmInStart): a lunch-out is expected to return
        // for the PM session, so it is NOT an early dismissal — keep the status
        // they already earned this morning (present/late).
        if (schedule.lunchStart && schedule.pmInStart &&
            compareDateTime(timeOut, schedule.lunchStart) >= 0 &&
            compareDateTime(timeOut, schedule.pmInStart) < 0) {
            return { status: baseStatus, label: baseLabel, remarks: '' };
        }
        // Left during the AM session (before lunchStart) and never came back:
        // morning-only half-day.
        if (schedule.lunchStart && compareDateTime(timeOut, schedule.lunchStart) < 0) {
            return {
                status: 'half_day',
                label: 'Half-Day',
                halfDayType: 'am_only',
                remarks: 'Morning Session Only'
            };
        }
        // Otherwise left during the PM session (pmInStart → dismissal): early dismissal.
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
    isLateHalfDay,
    decorateLateHalfDays,
    statusLabel,
    halfDayLabel
};
