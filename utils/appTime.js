const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Manila';

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
});

const monthFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit'
});

function partsFromDate(date = new Date()) {
    const parts = Object.fromEntries(
        dateTimeFormatter.formatToParts(date)
            .filter(part => part.type !== 'literal')
            .map(part => [part.type, part.value])
    );
    return {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour === '24' ? '00' : parts.hour,
        minute: parts.minute,
        second: parts.second
    };
}

function todayDate(date = new Date()) {
    const p = partsFromDate(date);
    return `${p.year}-${p.month}-${p.day}`;
}

function currentMonth(date = new Date()) {
    const parts = Object.fromEntries(
        monthFormatter.formatToParts(date)
            .filter(part => part.type !== 'literal')
            .map(part => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}`;
}

function nowDateTime(date = new Date()) {
    const p = partsFromDate(date);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function nowIso(date = new Date()) {
    return nowDateTime(date).replace(' ', 'T') + '+08:00';
}

function timestampForFilename(date = new Date()) {
    return nowDateTime(date).replace(/[ :]/g, '-');
}

function normalizeTime(value, fallback = '00:00:00') {
    const raw = String(value || fallback).trim();
    if (/^\d{1,2}:\d{2}$/.test(raw)) return raw.padStart(5, '0') + ':00';
    if (/^\d{1,2}:\d{2}:\d{2}$/.test(raw)) {
        const [h, m, s] = raw.split(':');
        return `${h.padStart(2, '0')}:${m}:${s}`;
    }
    return fallback;
}

function sqlDateTime(dateStr, timeStr) {
    return `${dateStr} ${normalizeTime(timeStr)}`;
}

function parseDateTime(value) {
    if (!value) return null;
    if (value instanceof Date) return partsFromDate(value);
    const raw = String(value).trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (match) {
        return {
            year: match[1],
            month: match[2],
            day: match[3],
            hour: match[4].padStart(2, '0'),
            minute: match[5],
            second: match[6] || '00'
        };
    }
    const timeOnly = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (timeOnly) {
        const today = partsFromDate();
        return {
            ...today,
            hour: timeOnly[1].padStart(2, '0'),
            minute: timeOnly[2],
            second: timeOnly[3] || '00'
        };
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return partsFromDate(parsed);
}

function dateTimeToEpochMs(value) {
    const p = parseDateTime(value);
    if (!p) return 0;
    return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`).getTime();
}

function compareDateTime(a, b) {
    return dateTimeToEpochMs(a) - dateTimeToEpochMs(b);
}

function secondsBetween(a, b) {
    return (dateTimeToEpochMs(b) - dateTimeToEpochMs(a)) / 1000;
}

function formatTime12(value) {
    const p = parseDateTime(value);
    if (!p) return '--:--';
    let hour = parseInt(p.hour, 10);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return `${String(hour).padStart(2, '0')}:${p.minute} ${suffix}`;
}

module.exports = {
    APP_TIME_ZONE,
    todayDate,
    currentMonth,
    nowDateTime,
    nowIso,
    timestampForFilename,
    normalizeTime,
    sqlDateTime,
    compareDateTime,
    secondsBetween,
    formatTime12
};
