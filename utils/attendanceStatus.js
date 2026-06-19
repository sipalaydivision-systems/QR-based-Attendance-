const { compareDateTime, parseDateTime } = require('./appTime');

const ATTENDANCE_SCAN_LABELS = Object.freeze({
    TIME_IN: 'TIME IN',
    LATE_TIME_IN: 'LATE TIME IN',
    PM_TIME_IN: 'PM TIME IN',
    PM_LATE_TIME_IN: 'PM LATE TIME IN',
    LUNCH_OUT: 'LUNCH OUT',
    WELCOME_BACK: 'WELCOME BACK',
    RETURNED: 'RETURNED',
    EARLY_OUT: 'EARLY OUT',
    COMPLETED: 'COMPLETED',
    ALREADY_RECORDED: 'ALREADY RECORDED',
    ALREADY_COMPLETED: 'ALREADY COMPLETED',
    PENDING_TIME_OUT: 'PENDING TIME OUT',
    ATTENDANCE_CLOSED: 'ATTENDANCE CLOSED'
});

const LEGACY_LABELS = Object.freeze({
    PRESENT: ATTENDANCE_SCAN_LABELS.TIME_IN,
    LATE: ATTENDANCE_SCAN_LABELS.LATE_TIME_IN,
    'PM PRESENT': ATTENDANCE_SCAN_LABELS.PM_TIME_IN,
    'PM LATE': ATTENDANCE_SCAN_LABELS.PM_LATE_TIME_IN,
    OUT: ATTENDANCE_SCAN_LABELS.EARLY_OUT,
    COMPLETE: ATTENDANCE_SCAN_LABELS.COMPLETED,
    'PENDING TIME OUT': ATTENDANCE_SCAN_LABELS.PENDING_TIME_OUT,
    'ALREADY RECORDED': ATTENDANCE_SCAN_LABELS.ALREADY_RECORDED,
    'ALREADY_RECORDED': ATTENDANCE_SCAN_LABELS.ALREADY_RECORDED,
    'ALREADY COMPLETED': ATTENDANCE_SCAN_LABELS.ALREADY_COMPLETED,
    'ALREADY_COMPLETED': ATTENDANCE_SCAN_LABELS.ALREADY_COMPLETED,
    'ATTENDANCE CLOSED': ATTENDANCE_SCAN_LABELS.ATTENDANCE_CLOSED,
    'ATTENDANCE_CLOSED': ATTENDANCE_SCAN_LABELS.ATTENDANCE_CLOSED
});

function titleCaseWords(value) {
    return String(value || '')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .split(' ')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function statusLabel(value) {
    const raw = String(value || '').trim();
    const status = raw.toLowerCase().replace(/[-\s]+/g, '_');
    const labels = {
        half_day: 'Half-Day',
        late: 'Late',
        absent: 'Absent',
        present: 'Present',
        inactive: 'Inactive',
        completed: 'Completed',
        returned: 'Returned',
        lunch_out: 'Lunch Out',
        half_day_pm: 'Half-Day PM',
        half_day_pm_late: 'Half-Day PM Late',
        half_day_am: 'Half-Day AM',
        half_day_am_early_out: 'Half-Day AM Early Out',
        half_day_pm_early_out: 'Half-Day PM Early Out',
        attendance_closed: 'Attendance Closed',
        already_recorded: 'Already Recorded',
        already_completed: 'Already Completed',
        pending_time_out: 'Pending Time Out'
    };
    if (labels[status]) return labels[status];
    if (LEGACY_LABELS[raw.toUpperCase()]) return titleCaseWords(LEGACY_LABELS[raw.toUpperCase()]);
    return raw ? titleCaseWords(raw) : '';
}

function scanLabelToDisplay(value) {
    return titleCaseWords(normalizeEventLabel(value));
}

function isHalfDayStatus(value) {
    return String(value || '').toLowerCase() === 'half_day';
}

function secondsOfDay(parts) {
    if (!parts) return null;
    return parseInt(parts.hour, 10) * 3600 + parseInt(parts.minute, 10) * 60 + parseInt(parts.second, 10);
}

// True when a stored attendance row is a late PM half-day. It is intentionally
// date-independent so old rows can still be labelled consistently.
function isLateHalfDay(status, timeIn, pmLateTime) {
    if (String(status || '').toLowerCase() !== 'half_day') return false;
    const arrival = secondsOfDay(parseDateTime(timeIn));
    const cutoff = secondsOfDay(parseDateTime(pmLateTime));
    if (arrival === null || cutoff === null) return false;
    return arrival >= cutoff;
}

function decorateLateHalfDays(rows, pmLateTime) {
    if (Array.isArray(rows) && pmLateTime) {
        rows.forEach((r) => { if (r) r.late_half_day = isLateHalfDay(r.status || r.att_status, r.time_in, pmLateTime); });
    }
    return rows;
}

function normalizeSchedule(schedule) {
    return {
        amLateStart: schedule && schedule.amLateStart,
        lunchStart: schedule && schedule.lunchStart,
        pmInStart: schedule && schedule.pmInStart,
        pmLateStart: schedule && schedule.pmLateStart,
        pmOutStart: schedule && schedule.pmOutStart
    };
}

function isAtOrAfter(value, boundary) {
    return !!(value && boundary && compareDateTime(value, boundary) >= 0);
}

function isBefore(value, boundary) {
    return !!(value && boundary && compareDateTime(value, boundary) < 0);
}

function halfDayResult(label, type, remarks, lateHalfDay = false) {
    return {
        status: 'half_day',
        label,
        halfDayType: type,
        lateHalfDay,
        remarks
    };
}

function baseResult(baseStatus, label, remarks = '') {
    const normalized = baseStatus || 'present';
    return {
        status: normalized,
        label: label || statusLabel(normalized),
        remarks
    };
}

function firstScanDecision(scanTime, scheduleInput = {}, baseStatus = 'present') {
    const schedule = normalizeSchedule(scheduleInput);
    if (isAtOrAfter(scanTime, schedule.pmOutStart)) {
        return {
            allowed: false,
            label: ATTENDANCE_SCAN_LABELS.ATTENDANCE_CLOSED,
            status: 'absent',
            finalStatusLabel: 'Attendance Closed',
            remarks: 'Attendance scanning is closed for today'
        };
    }
    if (isAtOrAfter(scanTime, schedule.pmLateStart)) {
        return {
            allowed: true,
            label: ATTENDANCE_SCAN_LABELS.PM_LATE_TIME_IN,
            status: 'half_day',
            finalStatusLabel: 'Half-Day PM Late',
            halfDayType: 'pm_late',
            lateHalfDay: true,
            remarks: 'Afternoon Session Only (Late)'
        };
    }
    if (isAtOrAfter(scanTime, schedule.lunchStart)) {
        return {
            allowed: true,
            label: ATTENDANCE_SCAN_LABELS.PM_TIME_IN,
            status: 'half_day',
            finalStatusLabel: 'Half-Day PM',
            halfDayType: 'pm_only',
            lateHalfDay: false,
            remarks: 'Afternoon Session Only'
        };
    }
    const late = baseStatus === 'late' || isAtOrAfter(scanTime, schedule.amLateStart);
    return {
        allowed: true,
        label: late ? ATTENDANCE_SCAN_LABELS.LATE_TIME_IN : ATTENDANCE_SCAN_LABELS.TIME_IN,
        status: late ? 'late' : 'present',
        finalStatusLabel: late ? 'Late' : 'Present',
        remarks: ''
    };
}

function timeOutScanLabel(scanTime, scheduleInput = {}) {
    const schedule = normalizeSchedule(scheduleInput);
    if (isAtOrAfter(scanTime, schedule.pmOutStart)) return ATTENDANCE_SCAN_LABELS.COMPLETED;
    if (isAtOrAfter(scanTime, schedule.lunchStart) && isBefore(scanTime, schedule.pmInStart)) {
        return ATTENDANCE_SCAN_LABELS.LUNCH_OUT;
    }
    return ATTENDANCE_SCAN_LABELS.EARLY_OUT;
}

function returnScanLabel(previousLabel, scanTime, scheduleInput = {}) {
    const schedule = normalizeSchedule(scheduleInput);
    const previous = normalizeEventLabel(previousLabel);
    if (previous === ATTENDANCE_SCAN_LABELS.COMPLETED) return ATTENDANCE_SCAN_LABELS.ALREADY_COMPLETED;
    if (isAtOrAfter(scanTime, schedule.pmOutStart)) return ATTENDANCE_SCAN_LABELS.ATTENDANCE_CLOSED;
    if (previous === ATTENDANCE_SCAN_LABELS.LUNCH_OUT) {
        if (isBefore(scanTime, schedule.pmInStart)) return ATTENDANCE_SCAN_LABELS.WELCOME_BACK;
        if (isBefore(scanTime, schedule.pmLateStart)) return ATTENDANCE_SCAN_LABELS.PM_TIME_IN;
        return ATTENDANCE_SCAN_LABELS.PM_LATE_TIME_IN;
    }
    return ATTENDANCE_SCAN_LABELS.RETURNED;
}

function normalizeEventLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const upper = raw.toUpperCase().replace(/\s+/g, ' ');
    return LEGACY_LABELS[upper] || upper;
}

function normalizeEventAction(value) {
    const raw = String(value || '').trim().toUpperCase();
    if (raw === 'TIME_IN' || raw === 'TIME IN' || raw === 'time_in'.toUpperCase()) return 'TIME_IN';
    if (raw === 'TIME_OUT' || raw === 'TIME OUT' || raw === 'time_out'.toUpperCase()) return 'TIME_OUT';
    return raw;
}

function eventTimeOf(event) {
    return event && (event.event_time || event.scanTime || event.scan_time || event.time || event.timeIn || event.timeOut);
}

function labelForEvent(event, schedule) {
    const action = normalizeEventAction(event && (event.event || event.eventAction));
    const explicit = normalizeEventLabel(event && (event.event_label || event.displayStatus || event.display_status));
    if (explicit) return explicit;
    if (action === 'TIME_OUT') return timeOutScanLabel(eventTimeOf(event), schedule);
    if (action === 'TIME_IN') return ATTENDANCE_SCAN_LABELS.TIME_IN;
    return '';
}

function firstTimeInEvent(events) {
    return events.find(event => normalizeEventAction(event.event || event.eventAction) === 'TIME_IN');
}

function sortAttendanceEvents(events) {
    return [...(events || [])]
        .filter(Boolean)
        .filter(event => eventTimeOf(event))
        .sort((a, b) => compareDateTime(eventTimeOf(a), eventTimeOf(b)));
}

function computeDailyAttendanceStatusFromEvents(input = {}) {
    const schedule = normalizeSchedule(input.schedule || {});
    const events = sortAttendanceEvents(input.events || []);
    const firstIn = firstTimeInEvent(events);
    if (!firstIn) {
        return { status: 'absent', label: 'Absent', remarks: 'No attendance recorded for the entire day' };
    }

    const firstTime = eventTimeOf(firstIn);
    const firstBaseStatus = input.baseStatus || 'present';
    const firstDecision = firstScanDecision(firstTime, schedule, firstBaseStatus);
    if (!firstDecision.allowed) {
        return {
            status: 'absent',
            label: 'Absent',
            remarks: firstDecision.remarks || 'No attendance recorded for the entire day'
        };
    }

    let broadStatus = firstDecision.status;
    let finalLabel = firstDecision.finalStatusLabel || statusLabel(firstDecision.status);
    let halfDayType = firstDecision.halfDayType || null;
    let lateHalfDay = !!firstDecision.lateHalfDay;
    let remarks = firstDecision.remarks || '';
    let inside = true;
    let lastOut = null;
    let returnedFromEarlyOut = false;
    let returnedFromLunch = false;
    let completed = false;

    events.forEach((event) => {
        const action = normalizeEventAction(event.event || event.eventAction);
        const eventTime = eventTimeOf(event);
        const label = labelForEvent(event, schedule);
        if (!eventTime || !action) return;

        if (action === 'TIME_OUT') {
            inside = false;
            if (label === ATTENDANCE_SCAN_LABELS.COMPLETED) {
                completed = true;
                lastOut = null;
                return;
            }
            if (label === ATTENDANCE_SCAN_LABELS.LUNCH_OUT) {
                lastOut = { kind: 'lunch', time: eventTime };
                return;
            }
            lastOut = {
                kind: isBefore(eventTime, schedule.lunchStart) ? 'early_am' : 'early_pm',
                time: eventTime
            };
            return;
        }

        if (action === 'TIME_IN') {
            inside = true;
            if (lastOut) {
                if (lastOut.kind === 'lunch') returnedFromLunch = true;
                else returnedFromEarlyOut = true;
                lastOut = null;
            }
        }
    });

    // Early-out / lunch reclassification only applies to full-day (AM) attendees.
    // Someone whose FIRST scan was already a PM half-day never attended the
    // morning, so leaving must not relabel them "Half-Day AM" — keep their
    // PM half-day status.
    if (!inside && lastOut && broadStatus !== 'half_day') {
        if (lastOut.kind === 'lunch') {
            return halfDayResult('Half-Day AM', 'am_only', 'Morning Session Only');
        }
        if (lastOut.kind === 'early_am') {
            return halfDayResult('Half-Day AM Early Out', 'am_early_out', 'Early Out During AM Session');
        }
        return halfDayResult('Half-Day PM Early Out', 'pm_early_out', 'Early Out During PM Session');
    }

    if (completed && broadStatus !== 'half_day') {
        return baseResult(broadStatus, 'Completed', 'Attendance completed for the day');
    }

    if (returnedFromEarlyOut && broadStatus !== 'half_day') {
        return baseResult(broadStatus, 'Returned', 'Returned after Early Out');
    }

    if (returnedFromLunch && broadStatus !== 'half_day') {
        return baseResult(broadStatus, 'Returned', 'Returned from Lunch Out');
    }

    return {
        status: broadStatus,
        label: finalLabel,
        halfDayType,
        lateHalfDay,
        remarks
    };
}

// Row-state fallback for legacy code paths. Full event history is preferred, but
// this still applies the official no-return rules when only the daily row exists.
function computeDailyAttendanceStatus(input = {}) {
    const timeIn = input.timeIn;
    if (!timeIn) {
        return { status: 'absent', label: 'Absent', remarks: 'No attendance recorded for the entire day' };
    }

    const schedule = normalizeSchedule(input.schedule || {});
    const firstDecision = firstScanDecision(timeIn, schedule, input.baseStatus || 'present');
    if (!firstDecision.allowed) {
        return { status: 'absent', label: 'Absent', remarks: firstDecision.remarks };
    }

    const lastTimeIn = input.lastTimeIn || timeIn;
    const timeOut = input.timeOut || null;
    const returnedAfterOut = timeOut && compareDateTime(lastTimeIn, timeOut) > 0;

    if (timeOut && isAtOrAfter(timeOut, schedule.pmOutStart)) {
        if (firstDecision.status === 'half_day') {
            return {
                status: firstDecision.status,
                label: firstDecision.finalStatusLabel,
                halfDayType: firstDecision.halfDayType || null,
                lateHalfDay: !!firstDecision.lateHalfDay,
                remarks: firstDecision.remarks || ''
            };
        }
        return baseResult(firstDecision.status, 'Completed', 'Attendance completed for the day');
    }

    // Only full-day (AM) attendees can be reclassified by an early-out/lunch-out.
    // A PM-only first scan stays a PM half-day even if they leave.
    if (timeOut && !returnedAfterOut && firstDecision.status !== 'half_day') {
        if (isAtOrAfter(timeOut, schedule.lunchStart) && isBefore(timeOut, schedule.pmInStart)) {
            return halfDayResult('Half-Day AM', 'am_only', 'Morning Session Only');
        }
        if (isBefore(timeOut, schedule.lunchStart)) {
            return halfDayResult('Half-Day AM Early Out', 'am_early_out', 'Early Out During AM Session');
        }
        return halfDayResult('Half-Day PM Early Out', 'pm_early_out', 'Early Out During PM Session');
    }

    if (returnedAfterOut && firstDecision.status !== 'half_day') {
        return baseResult(firstDecision.status, 'Returned', 'Returned after Time Out');
    }

    return {
        status: firstDecision.status,
        label: firstDecision.finalStatusLabel || statusLabel(firstDecision.status),
        halfDayType: firstDecision.halfDayType || null,
        lateHalfDay: !!firstDecision.lateHalfDay,
        remarks: firstDecision.remarks || ''
    };
}

function halfDayLabel(halfDayType) {
    const labels = {
        pm_late: 'Half-Day PM Late',
        pm_only: 'Half-Day PM',
        am_only: 'Half-Day AM',
        am_early_out: 'Half-Day AM Early Out',
        pm_early_out: 'Half-Day PM Early Out',
        early_dismissal: 'Half-Day Early Out'
    };
    return labels[halfDayType] || 'Half-Day';
}

module.exports = {
    ATTENDANCE_SCAN_LABELS,
    computeDailyAttendanceStatus,
    computeDailyAttendanceStatusFromEvents,
    decorateLateHalfDays,
    firstScanDecision,
    halfDayLabel,
    isHalfDayStatus,
    isLateHalfDay,
    normalizeEventLabel,
    returnScanLabel,
    scanLabelToDisplay,
    statusLabel,
    timeOutScanLabel
};
