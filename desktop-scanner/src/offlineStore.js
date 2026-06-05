const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js/dist/sql-asm.js');

const MAX_SYNC_ATTEMPTS = 5;
const DEFAULT_PENDING_LIMIT = 8;
const DEFAULT_HISTORY_LIMIT = 8;
const DEFAULT_RECENT_SCAN_LIMIT = 12;

let SQL = null;
let db = null;
let databaseFile = '';

function nowSql() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  ].join(' ');
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function saveDatabase() {
  if (!db || !databaseFile) return;
  ensureParentDir(databaseFile);
  const data = db.export();
  fs.writeFileSync(databaseFile, Buffer.from(data));
}

function run(sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    statement.step();
  } finally {
    statement.free();
  }
}

function all(sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function transaction(work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    saveDatabase();
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS people_cache (
      qr_code TEXT PRIMARY KEY,
      server_person_id INTEGER NOT NULL,
      person_type TEXT NOT NULL,
      person_code TEXT,
      name TEXT NOT NULL,
      school_id INTEGER,
      school_name TEXT,
      grade_level TEXT,
      section_name TEXT,
      adviser TEXT,
      adviser_contact TEXT,
      adviser_email TEXT,
      person_status TEXT,
      updated_at TEXT,
      cached_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attendance_events (
      local_event_id TEXT PRIMARY KEY,
      sync_event_id TEXT UNIQUE NOT NULL,
      qr_code TEXT NOT NULL,
      server_person_id INTEGER,
      person_type TEXT,
      person_code TEXT,
      name TEXT,
      school_id INTEGER,
      school_name TEXT,
      grade_level TEXT,
      section_name TEXT,
      attendance_date TEXT NOT NULL,
      scan_time TEXT NOT NULL,
      event_action TEXT NOT NULL DEFAULT 'UNKNOWN',
      attendance_status TEXT,
      time_in TEXT,
      time_out TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      server_message TEXT,
      last_error TEXT,
      sync_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_events_person_day
      ON attendance_events (person_type, server_person_id, attendance_date, scan_time);

    CREATE INDEX IF NOT EXISTS idx_attendance_events_sync
      ON attendance_events (sync_status, sync_attempts, scan_time);

    CREATE TABLE IF NOT EXISTS sync_history (
      sync_history_id TEXT PRIMARY KEY,
      trigger_source TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      total_events INTEGER NOT NULL DEFAULT 0,
      synced_events INTEGER NOT NULL DEFAULT 0,
      skipped_events INTEGER NOT NULL DEFAULT 0,
      failed_events INTEGER NOT NULL DEFAULT 0,
      remaining_events INTEGER NOT NULL DEFAULT 0,
      detail_message TEXT
    );

    CREATE TABLE IF NOT EXISTS scanner_meta (
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT
    );
  `);
  saveDatabase();
}

function normalizePerson(person) {
  if (!person) return null;
  return {
    qrCode: String(person.qrCode || person.qr_code || '').trim(),
    serverPersonId: Number(person.serverPersonId || person.personId || person.server_person_id || person.person_id || 0),
    personType: String(person.personType || person.person_type || '').trim().toLowerCase(),
    personCode: String(person.personCode || person.person_code || '').trim(),
    name: String(person.name || person.person_name || '').trim(),
    schoolId: Number(person.schoolId || person.school_id || 0) || null,
    schoolName: String(person.schoolName || person.school || person.school_name || '').trim(),
    gradeLevel: String(person.gradeLevel || person.grade || person.grade_name || '').trim(),
    sectionName: String(person.sectionName || person.section || person.section_name || '').trim(),
    adviser: String(person.adviser || '').trim(),
    adviserContact: String(person.adviserContact || person.adviser_contact || '').trim(),
    adviserEmail: String(person.adviserEmail || person.adviser_email || '').trim(),
    personStatus: String(person.personStatus || person.person_status || 'active').trim().toLowerCase(),
    updatedAt: String(person.updatedAt || person.updated_at || nowSql()).trim() || nowSql()
  };
}

function normalizeEvent(event) {
  return {
    localEventId: String(event.localEventId || event.local_event_id || '').trim(),
    syncEventId: String(event.syncEventId || event.sync_event_id || '').trim(),
    qrCode: String(event.qrCode || event.qr_code || '').trim(),
    serverPersonId: Number(event.serverPersonId || event.server_person_id || 0) || null,
    personType: String(event.personType || event.person_type || '').trim().toLowerCase() || null,
    personCode: String(event.personCode || event.person_code || '').trim() || null,
    name: String(event.name || '').trim() || null,
    schoolId: Number(event.schoolId || event.school_id || 0) || null,
    schoolName: String(event.schoolName || event.school_name || '').trim() || null,
    gradeLevel: String(event.gradeLevel || event.grade_level || '').trim() || null,
    sectionName: String(event.sectionName || event.section_name || '').trim() || null,
    attendanceDate: String(event.attendanceDate || event.attendance_date || '').trim(),
    scanTime: String(event.scanTime || event.scan_time || '').trim(),
    eventAction: String(event.eventAction || event.event_action || 'UNKNOWN').trim().toUpperCase(),
    attendanceStatus: String(event.attendanceStatus || event.attendance_status || '').trim() || null,
    timeIn: String(event.timeIn || event.time_in || '').trim() || null,
    timeOut: String(event.timeOut || event.time_out || '').trim() || null,
    syncStatus: String(event.syncStatus || event.sync_status || 'pending').trim().toLowerCase(),
    serverMessage: String(event.serverMessage || event.server_message || '').trim() || null,
    lastError: String(event.lastError || event.last_error || '').trim() || null,
    syncAttempts: Number(event.syncAttempts || event.sync_attempts || 0) || 0,
    createdAt: String(event.createdAt || event.created_at || nowSql()).trim(),
    updatedAt: String(event.updatedAt || event.updated_at || nowSql()).trim(),
    syncedAt: String(event.syncedAt || event.synced_at || '').trim() || null
  };
}

function hydrateEvent(row) {
  if (!row) return null;
  return {
    localEventId: row.local_event_id,
    syncEventId: row.sync_event_id,
    qrCode: row.qr_code,
    serverPersonId: row.server_person_id ? Number(row.server_person_id) : null,
    personType: row.person_type || null,
    personCode: row.person_code || null,
    name: row.name || null,
    schoolId: row.school_id ? Number(row.school_id) : null,
    schoolName: row.school_name || null,
    gradeLevel: row.grade_level || null,
    sectionName: row.section_name || null,
    attendanceDate: row.attendance_date,
    scanTime: row.scan_time,
    eventAction: row.event_action,
    attendanceStatus: row.attendance_status || null,
    timeIn: row.time_in || null,
    timeOut: row.time_out || null,
    syncStatus: row.sync_status,
    serverMessage: row.server_message || null,
    lastError: row.last_error || null,
    syncAttempts: Number(row.sync_attempts || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at || null
  };
}

function hydrateHistory(row) {
  if (!row) return null;
  return {
    syncHistoryId: row.sync_history_id,
    triggerSource: row.trigger_source,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    status: row.status,
    totalEvents: Number(row.total_events || 0),
    syncedEvents: Number(row.synced_events || 0),
    skippedEvents: Number(row.skipped_events || 0),
    failedEvents: Number(row.failed_events || 0),
    remainingEvents: Number(row.remaining_events || 0),
    detailMessage: row.detail_message || ''
  };
}

async function initOfflineStore(userDataPath) {
  if (db) return;
  SQL = await initSqlJs();
  databaseFile = path.join(userDataPath, 'edutrack-offline.sqlite');

  if (fs.existsSync(databaseFile)) {
    db = new SQL.Database(fs.readFileSync(databaseFile));
  } else {
    db = new SQL.Database();
  }

  migrate();
}

function getMeta(metaKey) {
  const row = get('SELECT meta_value FROM scanner_meta WHERE meta_key = ?', [metaKey]);
  return row ? row.meta_value : null;
}

function setMeta(metaKey, metaValue) {
  transaction(() => {
    run(`
      INSERT INTO scanner_meta (meta_key, meta_value)
      VALUES (?, ?)
      ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value
    `, [metaKey, metaValue == null ? null : String(metaValue)]);
  });
}

function upsertPeople(people, cachedAt = nowSql()) {
  if (!Array.isArray(people) || people.length === 0) return 0;
  return transaction(() => {
    let count = 0;
    for (const rawPerson of people) {
      const person = normalizePerson(rawPerson);
      if (!person.qrCode || !person.serverPersonId || !person.personType || !person.name) continue;
      run(`
        INSERT INTO people_cache (
          qr_code, server_person_id, person_type, person_code, name,
          school_id, school_name, grade_level, section_name,
          adviser, adviser_contact, adviser_email, person_status, updated_at, cached_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(qr_code) DO UPDATE SET
          server_person_id = excluded.server_person_id,
          person_type = excluded.person_type,
          person_code = excluded.person_code,
          name = excluded.name,
          school_id = excluded.school_id,
          school_name = excluded.school_name,
          grade_level = excluded.grade_level,
          section_name = excluded.section_name,
          adviser = excluded.adviser,
          adviser_contact = excluded.adviser_contact,
          adviser_email = excluded.adviser_email,
          person_status = excluded.person_status,
          updated_at = excluded.updated_at,
          cached_at = excluded.cached_at
      `, [
        person.qrCode,
        person.serverPersonId,
        person.personType,
        person.personCode || null,
        person.name,
        person.schoolId,
        person.schoolName || null,
        person.gradeLevel || null,
        person.sectionName || null,
        person.adviser || null,
        person.adviserContact || null,
        person.adviserEmail || null,
        person.personStatus || 'active',
        person.updatedAt,
        cachedAt
      ]);
      count += 1;
    }
    return count;
  });
}

function getPersonByQrCode(qrCode) {
  const trimmed = String(qrCode || '').trim();
  if (!trimmed) return null;
  const row = get('SELECT * FROM people_cache WHERE qr_code = ?', [trimmed]);
  if (!row) return null;
  return {
    qrCode: row.qr_code,
    serverPersonId: Number(row.server_person_id),
    personType: row.person_type,
    personCode: row.person_code || null,
    name: row.name,
    schoolId: row.school_id ? Number(row.school_id) : null,
    schoolName: row.school_name || null,
    gradeLevel: row.grade_level || null,
    sectionName: row.section_name || null,
    adviser: row.adviser || null,
    adviserContact: row.adviser_contact || null,
    adviserEmail: row.adviser_email || null,
    personStatus: row.person_status || 'active',
    updatedAt: row.updated_at || null
  };
}

function insertAttendanceEvent(eventInput) {
  const event = normalizeEvent(eventInput);
  if (!event.localEventId || !event.syncEventId || !event.qrCode || !event.attendanceDate || !event.scanTime) {
    throw new Error('Attendance event is missing required fields.');
  }

  transaction(() => {
    run(`
      INSERT INTO attendance_events (
        local_event_id, sync_event_id, qr_code, server_person_id, person_type, person_code,
        name, school_id, school_name, grade_level, section_name,
        attendance_date, scan_time, event_action, attendance_status,
        time_in, time_out, sync_status, server_message, last_error,
        sync_attempts, created_at, updated_at, synced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      event.localEventId,
      event.syncEventId,
      event.qrCode,
      event.serverPersonId,
      event.personType,
      event.personCode,
      event.name,
      event.schoolId,
      event.schoolName,
      event.gradeLevel,
      event.sectionName,
      event.attendanceDate,
      event.scanTime,
      event.eventAction,
      event.attendanceStatus,
      event.timeIn,
      event.timeOut,
      event.syncStatus,
      event.serverMessage,
      event.lastError,
      event.syncAttempts,
      event.createdAt,
      event.updatedAt,
      event.syncedAt
    ]);
  });

  return getAttendanceEventById(event.localEventId);
}

function getAttendanceEventById(localEventId) {
  const row = get('SELECT * FROM attendance_events WHERE local_event_id = ?', [localEventId]);
  return hydrateEvent(row);
}

function getAttendanceEventsForPersonDate(personType, serverPersonId, attendanceDate) {
  return all(`
    SELECT *
    FROM attendance_events
    WHERE person_type = ?
      AND server_person_id = ?
      AND attendance_date = ?
      AND sync_status != 'skipped'
    ORDER BY scan_time ASC, created_at ASC
  `, [personType, serverPersonId, attendanceDate]).map(hydrateEvent);
}

function updateAttendanceEvent(localEventId, patch) {
  const existing = getAttendanceEventById(localEventId);
  if (!existing) return null;

  const next = {
    ...existing,
    ...patch,
    localEventId: existing.localEventId,
    updatedAt: patch.updatedAt || nowSql()
  };

  transaction(() => {
    run(`
      UPDATE attendance_events
      SET
        sync_event_id = ?,
        qr_code = ?,
        server_person_id = ?,
        person_type = ?,
        person_code = ?,
        name = ?,
        school_id = ?,
        school_name = ?,
        grade_level = ?,
        section_name = ?,
        attendance_date = ?,
        scan_time = ?,
        event_action = ?,
        attendance_status = ?,
        time_in = ?,
        time_out = ?,
        sync_status = ?,
        server_message = ?,
        last_error = ?,
        sync_attempts = ?,
        updated_at = ?,
        synced_at = ?
      WHERE local_event_id = ?
    `, [
      next.syncEventId,
      next.qrCode,
      next.serverPersonId,
      next.personType,
      next.personCode,
      next.name,
      next.schoolId,
      next.schoolName,
      next.gradeLevel,
      next.sectionName,
      next.attendanceDate,
      next.scanTime,
      next.eventAction,
      next.attendanceStatus,
      next.timeIn,
      next.timeOut,
      next.syncStatus,
      next.serverMessage,
      next.lastError,
      next.syncAttempts,
      next.updatedAt,
      next.syncedAt,
      localEventId
    ]);
  });

  return getAttendanceEventById(localEventId);
}

function getSyncableEvents(limit = 250) {
  return all(`
    SELECT *
    FROM attendance_events
    WHERE sync_status IN ('pending', 'failed')
      AND sync_attempts < ?
    ORDER BY scan_time ASC, created_at ASC
    LIMIT ?
  `, [MAX_SYNC_ATTEMPTS, limit]).map(hydrateEvent);
}

function recordSyncHistoryStart({ syncHistoryId, triggerSource, totalEvents, detailMessage }) {
  transaction(() => {
    run(`
      INSERT INTO sync_history (
        sync_history_id, trigger_source, started_at, status,
        total_events, synced_events, skipped_events, failed_events,
        remaining_events, detail_message
      )
      VALUES (?, ?, ?, 'running', ?, 0, 0, 0, ?, ?)
    `, [
      syncHistoryId,
      triggerSource,
      nowSql(),
      Number(totalEvents || 0),
      Number(totalEvents || 0),
      detailMessage || 'Synchronization started.'
    ]);
  });
}

function recordSyncHistoryFinish(syncHistoryId, patch = {}) {
  const existing = get('SELECT * FROM sync_history WHERE sync_history_id = ?', [syncHistoryId]);
  if (!existing) return null;

  const next = {
    finishedAt: patch.finishedAt || nowSql(),
    status: patch.status || existing.status || 'success',
    syncedEvents: Number(patch.syncedEvents ?? existing.synced_events ?? 0),
    skippedEvents: Number(patch.skippedEvents ?? existing.skipped_events ?? 0),
    failedEvents: Number(patch.failedEvents ?? existing.failed_events ?? 0),
    remainingEvents: Number(patch.remainingEvents ?? existing.remaining_events ?? 0),
    detailMessage: patch.detailMessage || existing.detail_message || ''
  };

  transaction(() => {
    run(`
      UPDATE sync_history
      SET
        finished_at = ?,
        status = ?,
        synced_events = ?,
        skipped_events = ?,
        failed_events = ?,
        remaining_events = ?,
        detail_message = ?
      WHERE sync_history_id = ?
    `, [
      next.finishedAt,
      next.status,
      next.syncedEvents,
      next.skippedEvents,
      next.failedEvents,
      next.remainingEvents,
      next.detailMessage,
      syncHistoryId
    ]);
  });

  return getRecentSyncHistory(1)[0] || null;
}

function getRecentSyncHistory(limit = DEFAULT_HISTORY_LIMIT) {
  return all(`
    SELECT *
    FROM sync_history
    ORDER BY started_at DESC
    LIMIT ?
  `, [limit]).map(hydrateHistory);
}

function getDashboard(options = {}) {
  const pendingLimit = Number(options.pendingLimit || DEFAULT_PENDING_LIMIT);
  const historyLimit = Number(options.historyLimit || DEFAULT_HISTORY_LIMIT);
  const recentScanLimit = Number(options.recentScanLimit || DEFAULT_RECENT_SCAN_LIMIT);
  const today = String(options.today || nowSql().slice(0, 10));

  const [[counts], [todayCounts], [localTodayCounts], [syncedCount], [failedCount], [reviewCount], [lastSuccessRow]] = [
    all(`
      SELECT COUNT(*) AS count
      FROM attendance_events
      WHERE sync_status IN ('pending', 'failed')
        AND sync_attempts < ?
    `, [MAX_SYNC_ATTEMPTS]),
    all(`
      SELECT COUNT(*) AS count
      FROM attendance_events
      WHERE sync_status IN ('pending', 'failed')
        AND sync_attempts < ?
        AND attendance_date = ?
    `, [MAX_SYNC_ATTEMPTS, today]),
    all(`
      SELECT COUNT(*) AS count
      FROM attendance_events
      WHERE attendance_date = ?
        AND person_type IN ('student', 'teacher')
        AND event_action IN ('TIME_IN', 'TIME_OUT')
    `, [today]),
    all(`
      SELECT COUNT(*) AS count
      FROM attendance_events
      WHERE sync_status = 'synced'
    `),
    all(`
      SELECT COUNT(*) AS count
      FROM attendance_events
      WHERE sync_status = 'failed'
    `),
    all(`
      SELECT COUNT(*) AS count
      FROM attendance_events
      WHERE sync_status = 'failed'
        AND sync_attempts >= ?
    `, [MAX_SYNC_ATTEMPTS]),
    all(`
      SELECT finished_at
      FROM sync_history
      WHERE status = 'success'
      ORDER BY finished_at DESC
      LIMIT 1
    `)
  ];

  const pendingRecords = all(`
    SELECT *
    FROM attendance_events
    WHERE sync_status IN ('pending', 'failed')
      AND sync_attempts < ?
    ORDER BY scan_time ASC, created_at ASC
    LIMIT ?
  `, [MAX_SYNC_ATTEMPTS, pendingLimit]).map(hydrateEvent);

  const recentLocalScans = all(`
    SELECT *
    FROM attendance_events
    WHERE attendance_date = ?
      AND person_type IN ('student', 'teacher')
      AND event_action IN ('TIME_IN', 'TIME_OUT')
    ORDER BY scan_time DESC, created_at DESC
    LIMIT ?
  `, [today, recentScanLimit]).map(hydrateEvent);

  return {
    queuedCount: Number(counts?.count || 0),
    queuedTodayCount: Number(todayCounts?.count || 0),
    localTodayScanCount: Number(localTodayCounts?.count || 0),
    totalSyncedRecords: Number(syncedCount?.count || 0),
    failedRecordsCount: Number(failedCount?.count || 0),
    reviewRecordsCount: Number(reviewCount?.count || 0),
    lastSuccessfulSyncAt: lastSuccessRow?.finished_at || null,
    pendingRecords,
    recentLocalScans,
    recentSyncHistory: getRecentSyncHistory(historyLimit)
  };
}

function importLegacyQueue(queueItems = []) {
  if (!Array.isArray(queueItems) || queueItems.length === 0) return 0;
  return transaction(() => {
    let imported = 0;
    for (const item of queueItems) {
      const qrCode = String(item.qrCode || item.qr_code || '').trim();
      const scanTime = String(item.scanTime || item.scan_time || item.createdAt || item.created_at || '').trim();
      if (!qrCode || !scanTime) continue;
      const existing = get(`
        SELECT local_event_id
        FROM attendance_events
        WHERE qr_code = ?
          AND scan_time = ?
          AND sync_status IN ('pending', 'failed', 'synced')
        LIMIT 1
      `, [qrCode, scanTime]);
      if (existing) continue;

      run(`
        INSERT INTO attendance_events (
          local_event_id, sync_event_id, qr_code, attendance_date, scan_time,
          event_action, sync_status, created_at, updated_at, last_error
        )
        VALUES (?, ?, ?, ?, ?, 'UNKNOWN', 'pending', ?, ?, ?)
      `, [
        String(item.id || `${Date.now()}-${imported}`),
        String(item.id || `${Date.now()}-${imported}`),
        qrCode,
        scanTime.slice(0, 10),
        scanTime,
        String(item.createdAt || item.created_at || scanTime).slice(0, 19).replace('T', ' '),
        nowSql(),
        'Imported from the legacy offline queue.'
      ]);
      imported += 1;
    }
    return imported;
  });
}

module.exports = {
  MAX_SYNC_ATTEMPTS,
  initOfflineStore,
  getMeta,
  setMeta,
  upsertPeople,
  getPersonByQrCode,
  insertAttendanceEvent,
  getAttendanceEventById,
  getAttendanceEventsForPersonDate,
  updateAttendanceEvent,
  getSyncableEvents,
  recordSyncHistoryStart,
  recordSyncHistoryFinish,
  getRecentSyncHistory,
  getDashboard,
  importLegacyQueue
};
