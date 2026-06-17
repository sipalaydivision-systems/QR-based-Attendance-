const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  MAX_SYNC_ATTEMPTS,
  initOfflineStore,
  getMeta,
  setMeta,
  upsertPeople,
  replacePeopleCache,
  getPersonByQrCode,
  getPersonByCode,
  insertAttendanceEvent,
  getAttendanceEventById,
  getAttendanceEventsForPersonDate,
  updateAttendanceEvent,
  getSyncableEvents,
  recordSyncHistoryStart,
  recordSyncHistoryFinish,
  getDashboard,
  importLegacyQueue,
  flushPendingSave
} = require('./offlineStore');

const APP_TITLE = 'EduTrack Scanner';
const APP_USER_MODEL_ID = 'ph.gov.sipalay.edutrack.scanner';
const APP_ICON_PNG = path.join(__dirname, 'assets', 'edutrack-scanner.png');
const DEFAULT_SERVER_URL = 'https://sdo-sipalay-edutrack.up.railway.app';
// Retired server domains. Any saved serverUrl pointing at one of these is
// auto-migrated to DEFAULT_SERVER_URL on load, so existing installs (whose
// serverUrl persists in settings.json across reinstalls) connect to the live
// server without the user editing anything.
const LEGACY_SERVER_HOSTS = ['school-attendance-qrbased.up.railway.app'];
const NO_INTERNET_MESSAGE = "Can't connect to server due to no internet connection.";
const OFFLINE_MODE_MESSAGE = 'Offline Mode Enabled - Attendance records are being stored locally.';
const CONNECTION_RESTORED_MESSAGE = 'Connection Restored - Synchronizing attendance records.';
const SYNC_COMPLETED_MESSAGE = 'Synchronization Completed Successfully.';
const DIRECTORY_REFRESH_INTERVAL_MS = 60 * 1000;
const CONNECTION_CHECK_INTERVAL_MS = 20000;
const ADMIN_SYNCED_SETTING_KEYS = new Set([
  'kioskToken',
  'brandName',
  'divisionName',
  'systemLogo',
  'timeInStart',
  'amLateTime',
  'timeOutOpen',
  'lunchBreakStart',
  'pmTimeInStart',
  'pmLateTime',
  'lateGraceMinutes',
  'teacherDutyStart',
  'teacherDutyEnd',
  'teacherLateGraceMinutes',
  'studentAttendanceRule',
  'teacherAttendanceRule',
  'teacherTimeOutRule',
  'absenceCutoffTime',
  'attendancePolicy',
  'schools'
]);

let mainWindow = null;
let tray = null;
let isQuitting = false;

const runtimeState = {
  online: false,
  internetAvailable: false,
  serverAvailable: false,
  connectionMessage: 'Connecting to Server.',
  schoolDayStatus: {
    isSchoolDay: true,
    reason: null,
    type: null
  },
  lastConnectionCheckAt: null,
  syncInProgress: false,
  syncProgress: {
    total: 0,
    completed: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
    trigger: 'idle',
    startedAt: null,
    currentLabel: ''
  },
  directoryLastRefreshedAt: null,
  lastSuccessfulSyncAt: null,
  // When the scanner recovers from a same-day power/app outage, this holds
  // { anchor, graceUntil } — the window during which a person's first scan is
  // credited to the moment the outage began (so an on-time arrival who could
  // not scan during the blackout is not wrongly marked LATE / HALF-DAY).
  outageRecovery: null
};

function defaultSettings() {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    scannerMode: 'webcam',
    selectedSchoolId: '',
    duplicateIntervalSeconds: 5,
    offlineSync: true,
    autoStart: true,
    startFullscreen: false,
    minimizeToTray: true,
    kioskToken: '',
    brandName: 'EduTrack',
    divisionName: 'Schools Division of Sipalay City',
    systemLogo: '',
    timeInStart: '07:00',
    amLateTime: '',
    timeOutOpen: '17:00',
    lunchBreakStart: '11:30',
    pmTimeInStart: '13:00',
    pmLateTime: '',
    lateGraceMinutes: 0,
    teacherDutyStart: '07:00',
    teacherDutyEnd: '17:00',
    teacherLateGraceMinutes: 0,
    studentAttendanceRule: 'scan_once_time_in',
    teacherAttendanceRule: 'time_in_and_time_out',
    teacherTimeOutRule: 'required',
    absenceCutoffTime: '17:00',
    attendancePolicy: '',
    schools: []
  };
}

function createId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureUserDataDir() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function queuePath() {
  return path.join(app.getPath('userData'), 'offline-queue.json');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureUserDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function normalizeServerUrl(value) {
  let raw = String(value || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_SERVER_URL;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  // Migrate any retired domain to the current server.
  const lower = raw.toLowerCase();
  if (LEGACY_SERVER_HOSTS.some((host) => lower.includes(host))) {
    return DEFAULT_SERVER_URL;
  }
  return raw;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toLocalSqlDateTime(date = new Date()) {
  return `${localDateString(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseSqlDateTime(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0)
  );
}

function compareSqlDateTimes(left, right) {
  return String(left || '').localeCompare(String(right || ''));
}

function secondsBetween(left, right) {
  const start = parseSqlDateTime(left);
  const end = parseSqlDateTime(right);
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

function cleanScannedQrValue(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

function addQrCandidate(candidates, value) {
  const cleaned = cleanScannedQrValue(value);
  if (!cleaned) return;
  candidates.add(cleaned);
  try {
    const decoded = cleanScannedQrValue(decodeURIComponent(cleaned));
    if (decoded) candidates.add(decoded);
  } catch (_err) {
    // Not URI encoded; keep the original candidate only.
  }
}

function getQrLookupCandidates(value) {
  const candidates = new Set();
  addQrCandidate(candidates, value);

  const cleaned = cleanScannedQrValue(value);
  try {
    const parsed = new URL(cleaned);
    ['qr_code', 'qr', 'code', 'q'].forEach((key) => addQrCandidate(candidates, parsed.searchParams.get(key)));
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    addQrCandidate(candidates, pathParts[pathParts.length - 1]);
  } catch (_err) {
    // Plain QR payloads are expected; URLs are supported as a convenience.
  }

  Array.from(candidates).forEach((candidate) => {
    if (!/^(STU|TCH)-/i.test(candidate)) {
      addQrCandidate(candidates, `STU-${candidate}`);
      addQrCandidate(candidates, `TCH-${candidate}`);
    }
  });

  return Array.from(candidates).slice(0, 12);
}

function formatTime12(value) {
  const date = parseSqlDateTime(value);
  if (!date) return '--:--';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function combineDateAndTime(dateKey, timeValue, fallback = '00:00') {
  const safeTime = String(timeValue || fallback).slice(0, 5) || fallback;
  return `${dateKey} ${safeTime}:00`;
}

function statusLabel(value) {
  const status = String(value || '').toLowerCase();
  if (status === 'half_day') return 'Half-Day';
  if (status === 'late') return 'Late';
  if (status === 'absent') return 'Absent';
  if (status === 'present') return 'Present';
  return status ? status.replace(/_/g, ' ') : '';
}

function offlineScheduleForDate(attendanceDate, settings) {
  return {
    lunchStart: combineDateAndTime(attendanceDate, settings.lunchBreakStart, '11:30'),
    pmInStart: combineDateAndTime(attendanceDate, settings.pmTimeInStart, '13:00'),
    // PM Late Start Time is opt-in: null unless explicitly configured.
    pmLateStart: combineDateAndTime(attendanceDate, settings.pmLateTime, '13:15'),
    pmOutStart: combineDateAndTime(attendanceDate, settings.timeOutOpen, '16:00')
  };
}

// A PM time-in at/after the PM Late Start Time is shown as "PM LATE" instead of
// "PM PRESENT". Display-only — the stored daily status is unchanged.
function offlinePmLabelFor(label, scanTime, schedule) {
  if (label !== 'PM PRESENT') return label;
  if (schedule.pmLateStart && compareSqlDateTimes(scanTime, schedule.pmLateStart) >= 0) return 'PM LATE';
  return label;
}

function baseAttendanceStatusFor(person, attendanceDate, timeIn, settings) {
  const isTeacher = person.personType === 'teacher';
  // An explicit AM Late Start Time is the exact late line (no extra grace) for
  // students; teachers and unset students fall back to "start + grace".
  if (!isTeacher && settings.amLateTime) {
    const amLine = combineDateAndTime(attendanceDate, settings.amLateTime, '07:15');
    return compareSqlDateTimes(timeIn, amLine) >= 0 ? 'late' : 'present';
  }
  const lateThreshold = combineDateAndTime(
    attendanceDate,
    isTeacher ? settings.teacherDutyStart : settings.timeInStart,
    '07:00'
  );
  const graceMinutes = Math.max(
    0,
    Number(isTeacher ? settings.teacherLateGraceMinutes : settings.lateGraceMinutes) || 0
  );
  const lateBoundary = parseSqlDateTime(lateThreshold);
  const lateCutoff = lateBoundary ? toLocalSqlDateTime(new Date(lateBoundary.getTime() + graceMinutes * 60000)) : lateThreshold;
  return compareSqlDateTimes(timeIn, lateCutoff) >= 0 ? 'late' : 'present';
}

// ── Power / outage recovery ────────────────────────────────────────────────
// A school power interruption takes the scanner computer down. When power and
// the app come back, anyone who arrived ON TIME but could not scan during the
// blackout would otherwise be wrongly marked LATE / HALF-DAY at their first
// post-recovery scan. We persist a heartbeat (the last moment the app was
// alive) and, on startup, detect a same-day gap. For a bounded recovery window
// we anchor each person's FIRST scan status to the moment the outage began —
// the last time they actually could have scanned.
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const OUTAGE_DETECT_THRESHOLD_MS = 3 * 60 * 1000;   // gap > 3 min ⇒ treat as an outage
const OUTAGE_GRACE_MIN_MS = 30 * 60 * 1000;          // forgive ≥ 30 min after recovery
const OUTAGE_GRACE_MAX_MS = 120 * 60 * 1000;         // …but never more than 2 hours

let _heartbeatTimer = null;

function heartbeatFilePath() {
  return path.join(app.getPath('userData'), 'scanner-heartbeat');
}

// Marker written on a graceful quit. Its presence on next startup means the app
// was closed deliberately (not a power cut), so the gap is NOT an outage. A real
// power interruption never reaches the quit handler, so the marker is absent.
function cleanExitFilePath() {
  return path.join(app.getPath('userData'), 'scanner-clean-exit');
}

function markCleanExit() {
  try { fs.writeFileSync(cleanExitFilePath(), toLocalSqlDateTime()); } catch (_) {}
}

function writeHeartbeat() {
  // Best-effort, tiny, durable write so a power cut leaves a usable last-alive
  // marker without re-serializing the whole offline database.
  try { fs.writeFileSync(heartbeatFilePath(), toLocalSqlDateTime()); } catch (_) {}
}

function readLastHeartbeat() {
  try { return parseSqlDateTime(fs.readFileSync(heartbeatFilePath(), 'utf8')); }
  catch (_) { return null; }
}

function startHeartbeat() {
  writeHeartbeat();
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  if (_heartbeatTimer.unref) _heartbeatTimer.unref();
}

// Detect a same-day outage on startup and, if found, arm a bounded forgiveness
// window. A still-active window persisted from a prior boot (e.g. power flickers
// twice) is carried over so recovery survives repeated restarts.
function initOutageRecovery() {
  const now = new Date();
  const settings = loadSettings();
  const today = localDateString(now);
  const schoolStart = parseSqlDateTime(combineDateAndTime(today, settings.timeInStart, '07:00'));

  let anchor = null;
  let graceUntil = null;

  // A clean-exit marker means the previous stop was a deliberate quit, not a
  // power cut — consume it and skip fresh outage detection for this boot.
  const wasCleanExit = fs.existsSync(cleanExitFilePath());
  try { fs.unlinkSync(cleanExitFilePath()); } catch (_) {}

  const lastAlive = readLastHeartbeat();
  if (!wasCleanExit && lastAlive && localDateString(lastAlive) === today) {
    const gapMs = now.getTime() - lastAlive.getTime();
    if (gapMs > OUTAGE_DETECT_THRESHOLD_MS) {
      // Anchor to the later of (last alive) and (school-day start) so an outage
      // that began before classes does not credit a pre-school arrival time.
      const anchorDate = (schoolStart && schoolStart.getTime() > lastAlive.getTime()) ? schoolStart : lastAlive;
      anchor = toLocalSqlDateTime(anchorDate);
      const graceMs = Math.max(OUTAGE_GRACE_MIN_MS, Math.min(OUTAGE_GRACE_MAX_MS, gapMs));
      graceUntil = toLocalSqlDateTime(new Date(now.getTime() + graceMs));
    }
  }

  // Carry over a recovery window still active from a previous boot.
  const savedUntil = getMeta('outageGraceUntil');
  const savedAnchor = getMeta('outageAnchor');
  if (savedUntil && savedAnchor && compareSqlDateTimes(toLocalSqlDateTime(now), savedUntil) < 0) {
    if (!anchor || compareSqlDateTimes(savedAnchor, anchor) < 0) anchor = savedAnchor;
    if (!graceUntil || compareSqlDateTimes(savedUntil, graceUntil) > 0) graceUntil = savedUntil;
  }

  if (anchor && graceUntil) {
    runtimeState.outageRecovery = { anchor, graceUntil };
    setMeta('outageAnchor', anchor);
    setMeta('outageGraceUntil', graceUntil);
    console.warn(`Outage recovery armed: first-scans credited to ${anchor} until ${graceUntil}.`);
  } else {
    runtimeState.outageRecovery = null;
  }
}

// Returns the grace-anchor datetime to apply to a first-scan happening at
// `scanTime`, or null when we are not in an active recovery window.
function activeGraceAnchor(scanTime) {
  const recovery = runtimeState.outageRecovery;
  if (!recovery || !recovery.anchor || !recovery.graceUntil) return null;
  const when = scanTime || toLocalSqlDateTime();
  if (compareSqlDateTimes(when, recovery.graceUntil) >= 0) {
    // Window has elapsed — disarm so normal rules resume.
    runtimeState.outageRecovery = null;
    return null;
  }
  // Only meaningful when the anchor is genuinely earlier than the scan time.
  if (compareSqlDateTimes(recovery.anchor, when) >= 0) return null;
  return recovery.anchor;
}

function computeOfflineDailyAttendanceStatus(input = {}) {
  const timeIn = input.timeIn;
  if (!timeIn) {
    return { status: 'absent', label: 'Absent', remarks: 'No attendance recorded for the entire day' };
  }

  const schedule = input.schedule || {};
  const baseStatus = input.baseStatus || 'present';
  const lastTimeIn = input.lastTimeIn || timeIn;
  const timeOut = input.timeOut || null;

  if (schedule.pmInStart && compareSqlDateTimes(timeIn, schedule.pmInStart) >= 0) {
    const late = !!schedule.pmLateStart && compareSqlDateTimes(timeIn, schedule.pmLateStart) >= 0;
    return {
      status: 'half_day',
      label: late ? 'Half-Day (Late)' : 'Half-Day',
      halfDayType: late ? 'pm_late' : 'pm_only',
      lateHalfDay: late,
      remarks: late ? 'Afternoon Session Only (Late)' : 'Afternoon Session Only'
    };
  }

  const leftAndDidNotReturn = timeOut && compareSqlDateTimes(lastTimeIn, timeOut) <= 0;
  if (leftAndDidNotReturn && schedule.pmOutStart && compareSqlDateTimes(timeOut, schedule.pmOutStart) < 0) {
    if (schedule.pmInStart && compareSqlDateTimes(timeOut, schedule.pmInStart) < 0) {
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

  return { status: baseStatus, label: statusLabel(baseStatus), remarks: '' };
}

function responseAttendanceMeta(status) {
  return {
    attendance_status: status.label || statusLabel(status.status),
    half_day_type: status.halfDayType || null,
    late_half_day: !!status.lateHalfDay,
    remarks: status.remarks || ''
  };
}

function localNonSchoolDayStatus(dateKey) {
  const day = new Date(`${dateKey}T00:00:00`).getDay();
  if (day === 0 || day === 6) {
    return {
      isSchoolDay: false,
      reason: day === 0 ? 'Sunday' : 'Saturday',
      type: 'Weekend'
    };
  }
  return { isSchoolDay: true, reason: null, type: null };
}

function scanBlockedSchoolDayStatus(dateKey) {
  const localStatus = localNonSchoolDayStatus(dateKey);
  if (!localStatus.isSchoolDay) return localStatus;
  if (dateKey === localDateString() && runtimeState.schoolDayStatus && runtimeState.schoolDayStatus.isSchoolDay === false) {
    return runtimeState.schoolDayStatus;
  }
  return localStatus;
}

function nonSchoolDayScanMessage(schoolDay) {
  const type = schoolDay?.type || 'Non-school Day';
  const reason = schoolDay?.reason;
  return `No attendance scanning today: ${type}${reason ? ` - ${reason}` : ''}.`;
}

function loadSettings() {
  const merged = { ...defaultSettings(), ...readJson(settingsPath(), {}) };
  // Auto-migrate a retired serverUrl to the live server and persist it once,
  // so reinstalls and updates connect without any manual settings edit.
  const migratedUrl = normalizeServerUrl(merged.serverUrl);
  if (migratedUrl !== merged.serverUrl) {
    merged.serverUrl = migratedUrl;
    try {
      writeJson(settingsPath(), merged);
    } catch (err) {
      console.warn('Unable to persist serverUrl migration:', err.message);
    }
  }
  return merged;
}

function saveSettings(nextSettings, options = {}) {
  const incomingSettings = { ...(nextSettings || {}) };
  if (!options.allowAdminSyncedSettings) {
    for (const key of ADMIN_SYNCED_SETTING_KEYS) delete incomingSettings[key];
  }

  const settings = { ...loadSettings(), ...incomingSettings };
  settings.serverUrl = normalizeServerUrl(settings.serverUrl || DEFAULT_SERVER_URL);
  settings.duplicateIntervalSeconds = Math.max(1, Math.min(60, Number(settings.duplicateIntervalSeconds) || 5));
  settings.lateGraceMinutes = Math.max(0, Math.min(180, Number(settings.lateGraceMinutes) || 0));
  settings.teacherLateGraceMinutes = Math.max(0, Math.min(180, Number(settings.teacherLateGraceMinutes) || settings.lateGraceMinutes || 0));
  writeJson(settingsPath(), settings);
  configureAutoStart(settings.autoStart);
  return settings;
}

function loadNativeImage(size = 256) {
  const fromFile = nativeImage.createFromPath(APP_ICON_PNG);
  if (!fromFile.isEmpty()) return fromFile.resize({ width: size, height: size });

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0f8f68"/><path d="M17 27V17h10M37 17h10v10M47 37v10H37M27 47H17V37" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 32h28" stroke="#bbf7d0" stroke-width="5" stroke-linecap="round"/><circle cx="32" cy="32" r="5" fill="white"/></svg>';
  const fallback = nativeImage.createFromDataURL(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  return fallback.isEmpty() ? nativeImage.createEmpty() : fallback.resize({ width: size, height: size });
}

function configureAutoStart(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: app.getPath('exe'),
      args: ['--autostart']
    });
  } catch (err) {
    console.warn('Unable to configure autostart:', err.message);
  }
}

function showWindow() {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createWindow() {
  const settings = loadSettings();
  const launchedFromAutoStart = process.argv.includes('--autostart');
  const shouldFullscreen = !!settings.startFullscreen;
  const shouldStartHidden = launchedFromAutoStart && !!settings.minimizeToTray;

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1180,
    minHeight: 760,
    fullscreen: shouldFullscreen,
    show: !shouldStartHidden,
    title: APP_TITLE,
    icon: loadNativeImage(256),
    autoHideMenuBar: true,
    backgroundColor: '#eef5f1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (shouldStartHidden) {
      mainWindow.hide();
      return;
    }
    mainWindow.show();
    if (shouldFullscreen) mainWindow.setFullScreen(true);
  });

  mainWindow.on('close', (event) => {
    const currentSettings = loadSettings();
    if (!isQuitting && currentSettings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      if (tray) {
        tray.displayBalloon({
          title: `${APP_TITLE} is still running`,
          content: 'The scanner stays active in the system tray for faster attendance scanning.'
        });
      }
    }
  });
}

function createTray() {
  const icon = loadNativeImage(18);
  if (icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open EduTrack Scanner', click: () => showWindow() },
    { label: 'Toggle Full Screen', click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
    { type: 'separator' },
    { label: 'Sync Attendance Queue', click: () => syncOfflineQueue({ trigger: 'tray' }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function isNetworkError(err) {
  const message = String(err && err.message || err || '');
  return err?.name === 'AbortError' || /fetch failed|network|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|socket|timeout/i.test(message);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function selectedSchoolQueryValue(selectedSchoolId) {
  const trimmed = String(selectedSchoolId || '').trim();
  return trimmed ? `?school_id=${encodeURIComponent(trimmed)}` : '';
}

function selectedSchoolAmpValue(selectedSchoolId) {
  const trimmed = String(selectedSchoolId || '').trim();
  return trimmed ? `&school_id=${encodeURIComponent(trimmed)}` : '';
}

async function fetchScannerDirectoryVersion(settings) {
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const schoolSuffix = selectedSchoolQueryValue(settings.selectedSchoolId);
  const res = await fetchWithTimeout(`${serverUrl}/api/scanner-desktop-directory-version${schoolSuffix}`, {
    cache: 'no-store',
    headers: {
      'X-Scanner-Kiosk-Token': settings.kioskToken
    }
  }, 8000);

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    throw new Error('The server returned an invalid scanner directory version response.');
  }

  if (!res.ok || !data.success || !data.directoryVersion) {
    throw new Error(data.error || 'Unable to check scanner directory updates.');
  }

  return data;
}

function buildPersonCacheRecord(qrCode, person) {
  if (!person) return null;
  return {
    qrCode: cleanScannedQrValue(person.qr_code || person.qrCode || qrCode),
    serverPersonId: person.id || person.personId || person.person_id || null,
    personType: person.type,
    category: person.category || null,
    personCode: person.type === 'teacher' ? person.employee_id : person.lrn,
    name: person.name,
    school: person.school,
    schoolName: person.school,
    grade: person.grade,
    gradeLevel: person.grade,
    section: person.section,
    sectionName: person.section,
    adviser: person.adviser,
    adviserContact: person.adviser_contact,
    adviserEmail: person.adviser_email,
    personStatus: person.person_status || 'active'
  };
}

function personResponseFromCache(person) {
  if (!person) return null;
  const response = {
    id: person.serverPersonId,
    name: person.name,
    type: person.personType,
    category: person.category || null,
    school: person.schoolName || 'N/A',
    grade: person.gradeLevel || 'N/A',
    section: person.sectionName || 'N/A',
    adviser: person.adviser || 'N/A',
    adviser_contact: person.adviserContact || '',
    adviser_email: person.adviserEmail || ''
  };
  if (person.personType === 'teacher') response.employee_id = person.personCode || 'N/A';
  else response.lrn = person.personCode || 'N/A';
  return response;
}

function currentDashboard(extra = {}) {
  const dashboard = getDashboard({ today: localDateString() });
  const payload = {
    online: runtimeState.online,
    internetAvailable: runtimeState.internetAvailable,
    serverAvailable: runtimeState.serverAvailable,
    message: runtimeState.connectionMessage,
    schoolDayStatus: runtimeState.schoolDayStatus,
    lastConnectionCheckAt: runtimeState.lastConnectionCheckAt,
    syncInProgress: runtimeState.syncInProgress,
    syncProgress: runtimeState.syncProgress,
    directoryLastRefreshedAt: runtimeState.directoryLastRefreshedAt,
    lastSuccessfulSyncAt: dashboard.lastSuccessfulSyncAt || runtimeState.lastSuccessfulSyncAt,
    maxSyncAttempts: MAX_SYNC_ATTEMPTS,
    ...dashboard,
    ...extra
  };
  runtimeState.lastSuccessfulSyncAt = payload.lastSuccessfulSyncAt || runtimeState.lastSuccessfulSyncAt;
  return payload;
}

function broadcastScannerStatus(extra = {}) {
  const payload = currentDashboard(extra);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('queue:status', {
      queuedCount: payload.queuedCount,
      queuedTodayCount: payload.queuedTodayCount
    });
    mainWindow.webContents.send('scanner:status', payload);
  }
  return payload;
}

async function refreshDesktopConfig() {
  const settings = loadSettings();
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const schoolSuffix = selectedSchoolQueryValue(settings.selectedSchoolId);
  const res = await fetchWithTimeout(`${serverUrl}/api/scanner-desktop-config${schoolSuffix}`, { cache: 'no-store' }, 15000);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    throw new Error('The server returned an invalid scanner configuration response.');
  }

  if (!res.ok || !data.success) {
    const error = new Error(data.error || 'Unable to load scanner configuration.');
    error.serverRejected = true;
    throw error;
  }

  const nextSettings = saveSettings({
    serverUrl,
    kioskToken: data.kioskToken || settings.kioskToken,
    brandName: data.settings?.system_name || settings.brandName,
    divisionName: data.settings?.division_name || settings.divisionName,
    systemLogo: data.settings?.system_logo || settings.systemLogo,
    timeInStart: String(data.settings?.am_time_in_end || settings.timeInStart || '07:00').slice(0, 5),
    amLateTime: String(data.settings?.am_late_time ?? settings.amLateTime ?? '').slice(0, 5),
    timeOutOpen: String(data.settings?.pm_time_out_end || settings.timeOutOpen || '17:00').slice(0, 5),
    lunchBreakStart: String(data.settings?.lunch_break_start || settings.lunchBreakStart || '11:30').slice(0, 5),
    pmTimeInStart: String(data.settings?.pm_time_in_start || settings.pmTimeInStart || '13:00').slice(0, 5),
    pmLateTime: String(data.settings?.pm_late_time ?? settings.pmLateTime ?? '').slice(0, 5),
    lateGraceMinutes: Number(data.settings?.late_threshold || settings.lateGraceMinutes || 0) || 0,
    teacherDutyStart: String(data.settings?.teacher_duty_start_time || data.settings?.am_time_in_end || settings.teacherDutyStart || '07:00').slice(0, 5),
    teacherDutyEnd: String(data.settings?.teacher_duty_end_time || data.settings?.pm_time_out_end || settings.teacherDutyEnd || '17:00').slice(0, 5),
    teacherLateGraceMinutes: Number(data.settings?.teacher_late_threshold ?? data.settings?.late_threshold ?? settings.teacherLateGraceMinutes ?? 0) || 0,
    studentAttendanceRule: data.settings?.student_attendance_rule || settings.studentAttendanceRule || 'scan_once_time_in',
    teacherAttendanceRule: data.settings?.teacher_attendance_rule || settings.teacherAttendanceRule || 'time_in_and_time_out',
    teacherTimeOutRule: data.settings?.teacher_time_out_rule || settings.teacherTimeOutRule || 'required',
    absenceCutoffTime: String(data.settings?.absence_cutoff_time || data.settings?.pm_time_out_end || settings.absenceCutoffTime || '17:00').slice(0, 5),
    attendancePolicy: data.settings?.attendance_policy || settings.attendancePolicy || '',
    schools: Array.isArray(data.schools) ? data.schools : settings.schools
  }, { allowAdminSyncedSettings: true });

  return { ...data, settings: nextSettings };
}

async function ensureKioskToken() {
  const settings = loadSettings();
  if (settings.kioskToken) return settings;
  const config = await refreshDesktopConfig();
  return config.settings;
}

async function refreshScannerDirectory(options = {}) {
  const force = !!options.force;
  const settings = await ensureKioskToken();
  const lastRefreshEpoch = Number(getMeta('directoryRefreshEpoch') || 0);
  let remoteDirectory = null;

  if (!force) {
    try {
      remoteDirectory = await fetchScannerDirectoryVersion(settings);
      const cachedVersion = getMeta('directoryVersion');
      if (cachedVersion && remoteDirectory.directoryVersion === cachedVersion) {
        runtimeState.directoryLastRefreshedAt = getMeta('directoryRefreshedAt') || runtimeState.directoryLastRefreshedAt;
        setMeta('directoryVersionCheckedAt', toLocalSqlDateTime());
        setMeta('directoryRefreshEpoch', String(Date.now()));
        return { refreshed: false, count: Number(remoteDirectory.peopleCount || 0) };
      }
    } catch (versionError) {
      if (lastRefreshEpoch && Date.now() - lastRefreshEpoch < DIRECTORY_REFRESH_INTERVAL_MS) {
        runtimeState.directoryLastRefreshedAt = getMeta('directoryRefreshedAt') || runtimeState.directoryLastRefreshedAt;
        return { refreshed: false, count: 0 };
      }
      console.warn('Scanner directory version check skipped:', versionError.message);
    }
  }

  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const schoolSuffix = selectedSchoolQueryValue(settings.selectedSchoolId);

  const res = await fetchWithTimeout(`${serverUrl}/api/scanner-desktop-directory${schoolSuffix}`, {
    cache: 'no-store',
    headers: {
      'X-Scanner-Kiosk-Token': settings.kioskToken
    }
  }, 15000);

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    throw new Error('The server returned an invalid scanner directory response.');
  }

  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Unable to refresh the offline scanner directory.');
  }

  const refreshedAt = toLocalSqlDateTime();
  const count = replacePeopleCache(data.people || [], refreshedAt, {
    schoolId: settings.selectedSchoolId
  });
  const directoryVersion = data.directoryVersion || remoteDirectory?.directoryVersion || '';
  setMeta('directoryRefreshEpoch', String(Date.now()));
  setMeta('directoryRefreshedAt', refreshedAt);
  if (directoryVersion) setMeta('directoryVersion', directoryVersion);
  if (data.latestUpdate || remoteDirectory?.latestUpdate) setMeta('directoryLatestUpdate', data.latestUpdate || remoteDirectory.latestUpdate);
  if (data.peopleCount != null || remoteDirectory?.peopleCount != null) setMeta('directoryPeopleCount', data.peopleCount ?? remoteDirectory.peopleCount);
  runtimeState.directoryLastRefreshedAt = refreshedAt;
  return { refreshed: true, count };
}

async function refreshSchoolDayStatus(dateKey = localDateString()) {
  const settings = await ensureKioskToken();
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const schoolSuffix = selectedSchoolAmpValue(settings.selectedSchoolId);

  const res = await fetchWithTimeout(`${serverUrl}/api/is-school-day?date=${encodeURIComponent(dateKey)}${schoolSuffix}`, {
    cache: 'no-store',
    headers: {
      'X-Scanner-Kiosk-Token': settings.kioskToken
    }
  }, 8000);

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    throw new Error('The server returned an invalid school-day response.');
  }

  if (!res.ok) {
    throw new Error(data.error || 'Unable to check the school-day schedule.');
  }

  runtimeState.schoolDayStatus = {
    isSchoolDay: data.isSchoolDay !== undefined ? !!data.isSchoolDay : data.is_school_day !== false,
    reason: data.reason || data.non_school_day_reason || null,
    type: data.type || data.non_school_day_type || null
  };

  return runtimeState.schoolDayStatus;
}

async function postScan(payload, timeoutMs = 6000) {
  const settings = await ensureKioskToken();
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const assignedSchoolId = String(settings.selectedSchoolId || '').trim();
  const body = {
    qr_code: payload.qrCode,
    scanner_school_id: assignedSchoolId || null,
    require_time_out_confirmation: !!payload.requireTimeOutConfirmation,
    confirm_time_out: !!payload.confirmTimeOut
  };
  if (payload.scanTime) body.scan_time = payload.scanTime;
  // Outage forgiveness: the server applies this only to a person's first scan.
  if (payload.graceAnchor) body.grace_anchor_time = payload.graceAnchor;

  const res = await fetchWithTimeout(`${serverUrl}/api/scan-attendance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Scanner-Kiosk-Token': settings.kioskToken
    },
    body: JSON.stringify(body)
  }, timeoutMs);

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    throw new Error('The scanner server returned an invalid response.');
  }

  if (!res.ok) {
    const error = new Error(data.error || `Server error ${res.status}`);
    error.serverData = data;
    throw error;
  }
  return data;
}

function findExistingEvent(events, scanTime, action) {
  return events.find((item) => item.scanTime === scanTime && item.eventAction === action) || null;
}

function cachePersonIfPossible(qrCode, person) {
  if (!person) return;
  const record = buildPersonCacheRecord(qrCode, person);
  if (record && record.serverPersonId) upsertPeople([record], toLocalSqlDateTime());
}

function persistServerScanResult(qrCode, scanTime, data) {
  cachePersonIfPossible(qrCode, data.person);

  if (!['TIME_IN', 'TIME_OUT'].includes(data.action)) return null;
  const personRecord = data.person ? buildPersonCacheRecord(qrCode, data.person) : getPersonByQrCode(qrCode);
  const attendanceDate = String(scanTime || '').slice(0, 10) || localDateString();
  const events = personRecord?.serverPersonId
    ? getAttendanceEventsForPersonDate(personRecord.personType, personRecord.serverPersonId, attendanceDate)
    : [];

  const existing = findExistingEvent(events, scanTime, data.action);
  const patch = {
    qrCode,
    serverPersonId: personRecord?.serverPersonId || null,
    personType: personRecord?.personType || data.person?.type || null,
    personCode: personRecord?.personCode || (data.person?.type === 'teacher' ? data.person?.employee_id : data.person?.lrn) || null,
    name: personRecord?.name || data.person?.name || 'Attendance Record',
    schoolId: personRecord?.schoolId || null,
    schoolName: personRecord?.schoolName || data.person?.school || 'N/A',
    gradeLevel: personRecord?.gradeLevel || data.person?.grade || 'N/A',
    sectionName: personRecord?.sectionName || data.person?.section || 'N/A',
    attendanceDate,
    scanTime,
    eventAction: data.action,
    attendanceStatus: data.status || null,
    timeIn: data.action === 'TIME_IN' ? scanTime : existing?.timeIn || null,
    timeOut: data.action === 'TIME_OUT' ? scanTime : existing?.timeOut || null,
    category: personRecord?.category || data.person?.category || null,
    displayStatus: data.display_status || data.monitoring_status || null,
    syncStatus: 'synced',
    serverMessage: data.message || null,
    lastError: null,
    syncedAt: toLocalSqlDateTime()
  };

  if (existing) {
    return updateAttendanceEvent(existing.localEventId, patch);
  }

  return insertAttendanceEvent({
    localEventId: createId(),
    syncEventId: createId(),
    createdAt: toLocalSqlDateTime(),
    updatedAt: toLocalSqlDateTime(),
    syncAttempts: 0,
    ...patch
  });
}

function needsNonRetriableSkip(resultOrError) {
  const message = String(resultOrError?.error || resultOrError?.message || resultOrError || '');
  return /already has complete attendance|scanned too quickly|QR code not recognized|removed from the system|inactive|no attendance scanning|non-school day|weekend|no classes/i.test(message);
}

function resolveOfflineAttendance(qrCode, scanTime, options = {}) {
  let matchedQrCode = cleanScannedQrValue(qrCode);
  let person = null;
  for (const candidate of getQrLookupCandidates(qrCode)) {
    person = getPersonByQrCode(candidate);
    if (!person) person = getPersonByCode(candidate);
    if (person) {
      matchedQrCode = person.qrCode || candidate;
      break;
    }
  }

  if (!person) {
    return {
      success: false,
      offline: true,
      error: 'QR code is not available in the offline scanner directory yet. Reconnect to refresh local records.'
    };
  }

  if (person.personStatus === 'deleted') {
    return {
      success: false,
      offline: true,
      error: 'This person has been removed from the system.',
      person: personResponseFromCache(person)
    };
  }

  // Enforce scanner school assignment for offline scans
  const offlineSettings = loadSettings();
  const assignedSchoolId = String(offlineSettings.selectedSchoolId || '').trim();
  if (assignedSchoolId && String(person.schoolId || '') !== assignedSchoolId) {
    return {
      success: false,
      offline: true,
      error: `This scanner is assigned to a different school. "${person.name || 'This person'}" belongs to another school and cannot be scanned here.`,
      wrong_school: true,
      person: personResponseFromCache(person)
    };
  }

  const attendanceDate = String(scanTime || '').slice(0, 10);
  const schoolDay = scanBlockedSchoolDayStatus(attendanceDate);
  if (!schoolDay.isSchoolDay) {
    return {
      success: false,
      offline: true,
      non_school_day: true,
      error: nonSchoolDayScanMessage(schoolDay),
      message: nonSchoolDayScanMessage(schoolDay),
      person: personResponseFromCache(person)
    };
  }

  const events = getAttendanceEventsForPersonDate(person.personType, person.serverPersonId, attendanceDate);
  let lastEvent = null;
  events.forEach((item) => {
    if (!['TIME_IN', 'TIME_OUT'].includes(item.eventAction)) return;
    if (!lastEvent || compareSqlDateTimes(item.scanTime, lastEvent.scanTime) > 0) lastEvent = item;
  });

  if (!lastEvent) {
    const settings = loadSettings();
    const schedule = offlineScheduleForDate(attendanceDate, settings);
    // Outage forgiveness: if we are recovering from a same-day blackout, judge
    // late/half-day against the moment the outage began (the last time this
    // person could have scanned) instead of the actual catch-up scan time.
    const graceAnchor = activeGraceAnchor(scanTime);
    const outageForgiven = !!graceAnchor;
    const effectiveTime = outageForgiven ? graceAnchor : scanTime;
    const baseStatus = baseAttendanceStatusFor(person, attendanceDate, effectiveTime, settings);
    const computed = computeOfflineDailyAttendanceStatus({
      timeIn: effectiveTime,
      lastTimeIn: effectiveTime,
      schedule,
      baseStatus
    });
    const resolvedStatus = outageForgiven && !computed.remarks
      ? { ...computed, remarks: 'Credited on-time — scanner power interruption' }
      : computed;
    const attendanceStatus = resolvedStatus.status;
    const displayStatus = attendanceStatus === 'half_day'
      ? offlinePmLabelFor('PM PRESENT', scanTime, schedule)
      : (attendanceStatus === 'late' ? 'LATE' : 'PRESENT');

    insertAttendanceEvent({
      localEventId: createId(),
      syncEventId: createId(),
      qrCode: matchedQrCode,
      serverPersonId: person.serverPersonId,
      personType: person.personType,
      personCode: person.personCode,
      name: person.name,
      schoolId: person.schoolId,
      schoolName: person.schoolName,
      gradeLevel: person.gradeLevel,
      sectionName: person.sectionName,
      attendanceDate,
      scanTime,
      eventAction: 'TIME_IN',
      attendanceStatus,
      timeIn: scanTime,
      graceAnchor: outageForgiven ? graceAnchor : null,
      category: person.category || null,
      displayStatus: displayStatus,
      syncStatus: 'pending',
      serverMessage: resolvedStatus.remarks || OFFLINE_MODE_MESSAGE,
      lastError: null,
      syncAttempts: 0,
      createdAt: toLocalSqlDateTime(),
      updatedAt: toLocalSqlDateTime()
    });

    return {
      success: true,
      offline: true,
      queued: true,
      action: 'TIME_IN',
      status: attendanceStatus,
      display_status: displayStatus,
      monitoring_status: displayStatus,
      ...responseAttendanceMeta(resolvedStatus),
      message: attendanceStatus === 'half_day'
        ? `PM time in recorded offline - marked as HALF-DAY (${resolvedStatus.remarks}).`
        : attendanceStatus === 'late'
          ? 'Attendance recorded offline - marked as LATE.'
          : 'Attendance recorded offline.',
      person: personResponseFromCache(person),
      time: formatTime12(scanTime),
      time_in: formatTime12(scanTime)
    };
  }

  // ── Subsequent scans toggle Time Out / Time In (multiple allowed per day) ──
  const elapsedSec = secondsBetween(lastEvent.scanTime, scanTime);
  if (elapsedSec < 60) {
    return {
      success: false,
      offline: true,
      error: `Scan rejected - too soon after the previous scan (${Math.round(elapsedSec)}s). Please wait at least 1 minute.`,
      person: personResponseFromCache(person)
    };
  }

  const scheduleSettings = loadSettings();
  const schedule = offlineScheduleForDate(attendanceDate, scheduleSettings);
  const lunchStart = schedule.lunchStart;
  const pmInStart = schedule.pmInStart;
  const pmOutStart = schedule.pmOutStart;
  const firstTimeInEvent = events
    .filter((item) => item.eventAction === 'TIME_IN' && item.scanTime)
    .reduce((first, item) => {
      if (!first || compareSqlDateTimes(item.scanTime, first.scanTime) < 0) return item;
      return first;
    }, null);
  const firstTimeIn = firstTimeInEvent?.timeIn || firstTimeInEvent?.scanTime || lastEvent.timeIn || lastEvent.scanTime;
  const baseStatus = baseAttendanceStatusFor(person, attendanceDate, firstTimeIn, scheduleSettings);

  if (lastEvent.eventAction === 'TIME_IN') {
    // ── Time Out (leave premises / lunch out / end of day) ──
    let label = 'OUT';
    if (compareSqlDateTimes(scanTime, pmOutStart) >= 0) label = 'COMPLETED';
    else if (compareSqlDateTimes(scanTime, lunchStart) >= 0 && compareSqlDateTimes(scanTime, pmInStart) < 0) label = 'LUNCH OUT';
    const resolvedStatus = computeOfflineDailyAttendanceStatus({
      timeIn: firstTimeIn,
      lastTimeIn: lastEvent.timeIn || lastEvent.scanTime,
      timeOut: scanTime,
      schedule,
      baseStatus
    });
    const dailyStatus = resolvedStatus.status;

    insertAttendanceEvent({
      localEventId: createId(),
      syncEventId: createId(),
      qrCode: matchedQrCode,
      serverPersonId: person.serverPersonId,
      personType: person.personType,
      personCode: person.personCode,
      name: person.name,
      schoolId: person.schoolId,
      schoolName: person.schoolName,
      gradeLevel: person.gradeLevel,
      sectionName: person.sectionName,
      attendanceDate,
      scanTime,
      eventAction: 'TIME_OUT',
      attendanceStatus: dailyStatus,
      timeOut: scanTime,
      category: person.category || null,
      displayStatus: label,
      syncStatus: 'pending',
      serverMessage: resolvedStatus.remarks || OFFLINE_MODE_MESSAGE,
      lastError: null,
      syncAttempts: 0,
      createdAt: toLocalSqlDateTime(),
      updatedAt: toLocalSqlDateTime()
    });

    const outMessages = {
      'COMPLETED': 'Time out recorded offline - attendance for today is complete.',
      'LUNCH OUT': 'Lunch time out recorded offline. Scan again when you return.',
      'OUT': 'Time out recorded offline. Scan again when you return to school.'
    };
    return {
      success: true,
      offline: true,
      queued: true,
      action: 'TIME_OUT',
      status: dailyStatus,
      display_status: label,
      monitoring_status: label,
      ...responseAttendanceMeta(resolvedStatus),
      completed: label === 'COMPLETED',
      message: dailyStatus === 'half_day'
        ? `Time out recorded offline - marked as HALF-DAY (${resolvedStatus.remarks}).`
        : outMessages[label],
      person: personResponseFromCache(person),
      time: formatTime12(scanTime),
      time_in: formatTime12(lastEvent.timeIn || lastEvent.scanTime),
      time_out: formatTime12(scanTime)
    };
  }

  // ── Time In again after a Time Out (return from outside / PM session) ──
  // Returning from a lunch-out always counts as the afternoon session, so it is
  // labeled PM PRESENT even when scanned before the PM start time.
  const wasLunchOut = String(lastEvent.displayStatus || '').toUpperCase() === 'LUNCH OUT';
  const label = offlinePmLabelFor(
    wasLunchOut
      ? 'PM PRESENT'
      : (compareSqlDateTimes(scanTime, pmInStart) >= 0 ? 'PM PRESENT' : 'RETURNED'),
    scanTime,
    schedule
  );
  const resolvedStatus = computeOfflineDailyAttendanceStatus({
    timeIn: firstTimeIn,
    lastTimeIn: scanTime,
    timeOut: lastEvent.timeOut || lastEvent.scanTime,
    schedule,
    baseStatus
  });
  const dailyStatus = resolvedStatus.status;

  insertAttendanceEvent({
    localEventId: createId(),
    syncEventId: createId(),
    qrCode: matchedQrCode,
    serverPersonId: person.serverPersonId,
    personType: person.personType,
    personCode: person.personCode,
    name: person.name,
    schoolId: person.schoolId,
    schoolName: person.schoolName,
    gradeLevel: person.gradeLevel,
    sectionName: person.sectionName,
    attendanceDate,
    scanTime,
    eventAction: 'TIME_IN',
    attendanceStatus: dailyStatus,
    timeIn: scanTime,
    category: person.category || null,
    displayStatus: label,
    syncStatus: 'pending',
    serverMessage: resolvedStatus.remarks || OFFLINE_MODE_MESSAGE,
    lastError: null,
    syncAttempts: 0,
    createdAt: toLocalSqlDateTime(),
    updatedAt: toLocalSqlDateTime()
  });

  return {
    success: true,
    offline: true,
    queued: true,
    action: 'TIME_IN',
    status: dailyStatus,
    display_status: label,
    monitoring_status: label,
    ...responseAttendanceMeta(resolvedStatus),
    message: label === 'PM PRESENT'
      ? 'PM time in recorded offline. Welcome back!'
      : 'Return time in recorded offline. Welcome back!',
    person: personResponseFromCache(person),
    time: formatTime12(scanTime),
    time_in: formatTime12(scanTime),
    time_out: formatTime12(lastEvent.timeOut || lastEvent.scanTime)
  };
}

function updateRuntimeConnectionState(online, message) {
  runtimeState.online = !!online;
  runtimeState.internetAvailable = !!online;
  runtimeState.serverAvailable = !!online;
  runtimeState.connectionMessage = message;
  runtimeState.lastConnectionCheckAt = toLocalSqlDateTime();
}

function buildOfflineScanResponse(qrCode, scanTime, payload) {
  const localResult = resolveOfflineAttendance(qrCode, scanTime, {
    requireTimeOutConfirmation: payload?.requireTimeOutConfirmation !== false,
    confirmTimeOut: !!payload?.confirmTimeOut
  });
  const response = {
    ...localResult,
    error: localResult.error || 'Offline Mode: Saved Locally',
    message: localResult.success ? (localResult.message || OFFLINE_MODE_MESSAGE) : (localResult.error || NO_INTERNET_MESSAGE),
    ...currentDashboard()
  };
  broadcastScannerStatus();
  return response;
}

// Debounced, non-blocking reconnect probe. Lets the app flip back to "online"
// quickly after an offline scan without making the scan itself wait.
let _reconnectTimer = null;
function scheduleBackgroundReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    refreshConnectionState({ trigger: 'post-offline-scan', forceDirectory: false, syncIfPossible: true })
      .catch(() => {});
  }, 1500);
}

async function submitScan(payload) {
  const qrCode = cleanScannedQrValue(payload?.qrCode);
  if (!qrCode) return { success: false, error: 'Invalid QR Code', ...currentDashboard() };

  const scanTime = payload?.scanTime || toLocalSqlDateTime();
  const settings = loadSettings();

  if (runtimeState.online && settings.offlineSync && getDashboard({ today: localDateString() }).queuedCount > 0 && !runtimeState.syncInProgress) {
    await syncOfflineQueue({ trigger: 'pre-submit', silent: true });
  }

  // If we already know we're offline (or have no kiosk token), resolve the
  // scan from the local directory INSTANTLY and probe for reconnection in the
  // background. The user never waits on a dead/slow network. Once the probe
  // restores the connection, subsequent scans go straight to the server.
  const canTryServer = !!settings.kioskToken && runtimeState.online;
  if (settings.offlineSync && !canTryServer && payload?.allowQueue !== false) {
    scheduleBackgroundReconnect();
    return buildOfflineScanResponse(qrCode, scanTime, payload);
  }

  try {
    // Capped wait so a freshly-dropped connection can't stall the modal.
    const data = await postScan({
      qrCode,
      scanTime,
      graceAnchor: activeGraceAnchor(scanTime),
      requireTimeOutConfirmation: payload?.requireTimeOutConfirmation !== false,
      confirmTimeOut: !!payload?.confirmTimeOut
    }, 6000);
    updateRuntimeConnectionState(true, 'Connected to Server.');
    persistServerScanResult(qrCode, scanTime, data);
    const result = { ...data, online: true, ...currentDashboard() };
    broadcastScannerStatus();
    return result;
  } catch (err) {
    if (isNetworkError(err) && settings.offlineSync && payload?.allowQueue !== false) {
      updateRuntimeConnectionState(false, NO_INTERNET_MESSAGE);
      scheduleBackgroundReconnect();
      return buildOfflineScanResponse(qrCode, scanTime, payload);
    }

    return { success: false, error: err.message || 'Scanner request failed.', ...currentDashboard() };
  }
}

async function syncOfflineQueue(options = {}) {
  const trigger = options.trigger || 'manual';
  const silent = !!options.silent;

  if (runtimeState.syncInProgress) {
    return { success: true, skippedBecauseBusy: true, ...currentDashboard() };
  }

  const queue = getSyncableEvents();
  if (queue.length === 0) {
    if (!silent) broadcastScannerStatus();
    return { success: true, synced: 0, skipped: 0, failed: 0, remaining: 0, ...currentDashboard() };
  }

  const syncHistoryId = createId();
  let synced = 0;
  let skipped = 0;
  let failed = 0;
  let remaining = queue.length;
  let networkInterrupted = false;

  recordSyncHistoryStart({
    syncHistoryId,
    triggerSource: trigger,
    totalEvents: queue.length,
    detailMessage: trigger === 'manual' || trigger === 'tray'
      ? 'Manual synchronization started.'
      : CONNECTION_RESTORED_MESSAGE
  });

  runtimeState.syncInProgress = true;
  runtimeState.syncProgress = {
    total: queue.length,
    completed: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    remaining: queue.length,
    trigger,
    startedAt: toLocalSqlDateTime(),
    currentLabel: queue[0]?.name || queue[0]?.qrCode || 'Queued attendance record'
  };

  broadcastScannerStatus();

  for (let index = 0; index < queue.length; index += 1) {
    const event = queue[index];
    runtimeState.syncProgress.currentLabel = event.name || event.qrCode;
    broadcastScannerStatus();

    try {
      const result = await postScan({
        qrCode: event.qrCode,
        scanTime: event.scanTime,
        graceAnchor: event.graceAnchor || null,
        requireTimeOutConfirmation: false,
        confirmTimeOut: false
      });

      cachePersonIfPossible(event.qrCode, result.person);
      const cachedPerson = getPersonByQrCode(event.qrCode);
      const nextPatch = {
        qrCode: event.qrCode,
        serverPersonId: cachedPerson?.serverPersonId || event.serverPersonId,
        personType: cachedPerson?.personType || event.personType,
        personCode: cachedPerson?.personCode || event.personCode,
        name: cachedPerson?.name || event.name,
        schoolId: cachedPerson?.schoolId || event.schoolId,
        schoolName: cachedPerson?.schoolName || event.schoolName,
        gradeLevel: cachedPerson?.gradeLevel || event.gradeLevel,
        sectionName: cachedPerson?.sectionName || event.sectionName,
        category: cachedPerson?.category || result.person?.category || event.category,
        attendanceStatus: result.status || event.attendanceStatus,
        displayStatus: result.display_status || result.monitoring_status || event.displayStatus,
        serverMessage: result.message || event.serverMessage,
        lastError: null
      };

      if (['TIME_IN', 'TIME_OUT'].includes(result.action)) {
        updateAttendanceEvent(event.localEventId, {
          ...nextPatch,
          eventAction: result.action,
          timeIn: result.action === 'TIME_IN' ? event.scanTime : event.timeIn,
          timeOut: result.action === 'TIME_OUT' ? event.scanTime : event.timeOut,
          syncStatus: 'synced',
          syncAttempts: Number(event.syncAttempts || 0),
          syncedAt: toLocalSqlDateTime()
        });
        synced += 1;
      } else {
        updateAttendanceEvent(event.localEventId, {
          ...nextPatch,
          syncStatus: 'skipped',
          syncAttempts: Number(event.syncAttempts || 0),
          syncedAt: toLocalSqlDateTime()
        });
        skipped += 1;
      }
    } catch (err) {
      if (isNetworkError(err)) {
        networkInterrupted = true;
        runtimeState.online = false;
        runtimeState.internetAvailable = false;
        runtimeState.serverAvailable = false;
        runtimeState.connectionMessage = NO_INTERNET_MESSAGE;
        runtimeState.lastConnectionCheckAt = toLocalSqlDateTime();
        break;
      }

      const serverData = err.serverData || null;
      if (serverData && needsNonRetriableSkip(serverData)) {
        updateAttendanceEvent(event.localEventId, {
          syncStatus: 'skipped',
          serverMessage: serverData.error || serverData.message || err.message,
          lastError: null,
          syncAttempts: Number(event.syncAttempts || 0),
          syncedAt: toLocalSqlDateTime()
        });
        skipped += 1;
      } else if (needsNonRetriableSkip(err)) {
        updateAttendanceEvent(event.localEventId, {
          syncStatus: 'skipped',
          serverMessage: err.message,
          lastError: null,
          syncAttempts: Number(event.syncAttempts || 0),
          syncedAt: toLocalSqlDateTime()
        });
        skipped += 1;
      } else {
        updateAttendanceEvent(event.localEventId, {
          syncStatus: 'failed',
          lastError: err.message || 'Unexpected synchronization error.',
          syncAttempts: Number(event.syncAttempts || 0) + 1
        });
        failed += 1;
      }
    }

    remaining = Math.max(0, queue.length - (index + 1));
    runtimeState.syncProgress.completed = index + 1;
    runtimeState.syncProgress.synced = synced;
    runtimeState.syncProgress.skipped = skipped;
    runtimeState.syncProgress.failed = failed;
    runtimeState.syncProgress.remaining = remaining;
    broadcastScannerStatus();
  }

  const dashboardAfterSync = getDashboard({ today: localDateString() });
  const finalRemaining = dashboardAfterSync.queuedCount;
  const historyStatus = networkInterrupted
    ? (synced || skipped || failed ? 'partial' : 'error')
    : failed > 0
      ? 'partial'
      : 'success';
  const historyMessage = historyStatus === 'success'
    ? SYNC_COMPLETED_MESSAGE
    : networkInterrupted
      ? 'Synchronization paused because the connection dropped before all records were uploaded.'
      : 'Synchronization finished with records that need another retry.';

  recordSyncHistoryFinish(syncHistoryId, {
    status: historyStatus,
    syncedEvents: synced,
    skippedEvents: skipped,
    failedEvents: failed,
    remainingEvents: finalRemaining,
    detailMessage: historyMessage
  });

  runtimeState.syncInProgress = false;
  runtimeState.syncProgress = {
    total: queue.length,
    completed: synced + skipped + failed,
    synced,
    skipped,
    failed,
    remaining: finalRemaining,
    trigger,
    startedAt: runtimeState.syncProgress.startedAt,
    currentLabel: ''
  };

  if (!networkInterrupted) {
    updateRuntimeConnectionState(true, 'Connected to Server.');
  }
  if (historyStatus === 'success') {
    runtimeState.lastSuccessfulSyncAt = toLocalSqlDateTime();
  }

  const payload = {
    success: historyStatus !== 'error',
    synced,
    skipped,
    failed,
    remaining: finalRemaining,
    lastHistoryStatus: historyStatus,
    ...currentDashboard()
  };
  broadcastScannerStatus();
  return payload;
}

async function refreshConnectionState(options = {}) {
  const trigger = options.trigger || 'manual-check';
  const forceDirectory = !!options.forceDirectory;
  const syncIfPossible = options.syncIfPossible !== false;
  let config = null;

  try {
    config = await refreshDesktopConfig();
    updateRuntimeConnectionState(true, 'Connected to Server.');

    try {
      await refreshSchoolDayStatus(localDateString());
    } catch (schoolDayError) {
      console.warn('School-day status refresh skipped:', schoolDayError.message);
    }

    try {
      await refreshScannerDirectory({ force: forceDirectory });
    } catch (directoryError) {
      console.warn('Scanner directory refresh skipped:', directoryError.message);
    }

    if (syncIfPossible && loadSettings().offlineSync && getDashboard({ today: localDateString() }).queuedCount > 0 && !runtimeState.syncInProgress) {
      runtimeState.connectionMessage = CONNECTION_RESTORED_MESSAGE;
      broadcastScannerStatus({ config });
      await syncOfflineQueue({ trigger });
    }

    return { config, ...currentDashboard() };
  } catch (err) {
    runtimeState.online = false;
    runtimeState.internetAvailable = !isNetworkError(err);
    runtimeState.serverAvailable = !isNetworkError(err);
    runtimeState.connectionMessage = isNetworkError(err) ? NO_INTERNET_MESSAGE : err.message;
    runtimeState.lastConnectionCheckAt = toLocalSqlDateTime();
    return currentDashboard();
  } finally {
    broadcastScannerStatus(config ? { config } : {});
  }
}

async function migrateLegacyOfflineQueue() {
  const legacyQueue = readJson(queuePath(), []);
  if (!Array.isArray(legacyQueue) || legacyQueue.length === 0) return 0;
  const imported = importLegacyQueue(legacyQueue);
  writeJson(queuePath(), []);
  return imported;
}

ipcMain.handle('settings:get', async () => {
  const settings = loadSettings();
  const loginSettings = app.getLoginItemSettings();
  return { settings, autoStartEnabled: !!loginSettings.openAtLogin, ...currentDashboard() };
});

ipcMain.handle('settings:save', async (_event, nextSettings) => {
  const settings = saveSettings(nextSettings || {});
  broadcastScannerStatus();
  return settings;
});

ipcMain.handle('connection:check', async () => refreshConnectionState({ trigger: 'manual-check', forceDirectory: true, syncIfPossible: true }));
ipcMain.handle('scan:submit', async (_event, payload) => {
  // Guard the IPC boundary: an unexpected throw here would reject in the
  // renderer and (without renderer-side recovery) freeze the scanner. Always
  // resolve with a usable object.
  try {
    return await submitScan(payload);
  } catch (err) {
    console.error('submitScan failed unexpectedly:', err);
    return { success: false, error: 'The scan could not be processed. Please try again.', ...currentDashboard() };
  }
});
ipcMain.handle('admin:login', async (_event, { username, password }) => {
  try {
    const settings = loadSettings();
    const serverUrl = normalizeServerUrl(settings.serverUrl);
    const res = await fetchWithTimeout(`${serverUrl}/api/scanner-admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: String(username || ''), password: String(password || '') })
    }, 10000);
    const data = await res.json();
    return data;
  } catch (err) {
    return { success: false, error: err.message || 'Unable to connect to server. Check your internet connection and server URL.' };
  }
});
ipcMain.handle('queue:sync', async () => syncOfflineQueue({ trigger: 'manual' }));
ipcMain.handle('queue:get', async () => currentDashboard());
ipcMain.handle('app:fullscreen', async () => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});
ipcMain.handle('app:minimize', async () => {
  if (mainWindow) mainWindow.hide();
});
ipcMain.handle('app:open-external', async (_event, url) => shell.openExternal(url));
ipcMain.handle('app:show-error', async (_event, message) => dialog.showErrorBox(APP_TITLE, String(message || 'Unknown error')));

const skipSingleInstanceLock = process.env.EDUTRACK_SKIP_SINGLE_INSTANCE === '1';
const hasSingleInstanceLock = skipSingleInstanceLock || app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  if (!skipSingleInstanceLock) {
    app.on('second-instance', () => {
      showWindow();
    });
  }

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    ensureUserDataDir();
    await initOfflineStore(app.getPath('userData'));
    runtimeState.directoryLastRefreshedAt = getMeta('directoryRefreshedAt') || null;
    runtimeState.lastSuccessfulSyncAt = getDashboard({ today: localDateString() }).lastSuccessfulSyncAt || null;
    // Detect a same-day power/app outage from the last heartbeat, then begin
    // heartbeating so the next interruption is detectable too. Must run before
    // the first scans so the recovery window is armed in time.
    try { initOutageRecovery(); } catch (outageError) {
      console.warn('Outage recovery init skipped:', outageError.message);
    }
    startHeartbeat();
    try {
      await migrateLegacyOfflineQueue();
    } catch (migrationError) {
      console.warn('Legacy queue migration skipped:', migrationError.message);
    }

    const settings = loadSettings();
    configureAutoStart(settings.autoStart);
    createWindow();
    createTray();

    // Defer the first connection/directory sync briefly so the window paints
    // and stays responsive. Use version-checking (forceDirectory:false) so we
    // skip the heavy full directory rewrite when nothing changed on the server.
    setTimeout(() => {
      refreshConnectionState({ trigger: 'startup', forceDirectory: false, syncIfPossible: true }).catch((err) => {
        console.warn('Initial scanner connection check failed:', err.message);
        broadcastScannerStatus();
      });
    }, 600);

    setInterval(() => {
      refreshConnectionState({ trigger: 'background', syncIfPossible: true }).catch(() => {});
    }, CONNECTION_CHECK_INTERVAL_MS);
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  // Flush any deferred cache writes to disk so nothing is lost on exit
  try {
    flushPendingSave();
  } catch (err) {
    console.warn('Flush on quit failed:', err.message);
  }
  // Record that this was a graceful shutdown so the next startup does not
  // mistake a deliberate quit for a power interruption.
  markCleanExit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  showWindow();
});
