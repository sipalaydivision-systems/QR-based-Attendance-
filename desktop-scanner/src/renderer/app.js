const api = window.edutrack;

const OFFLINE_NOTIFICATION = 'Offline Mode Enabled - Attendance records are being stored locally.';
const CONNECTION_RESTORED_NOTIFICATION = 'Connection Restored - Synchronizing attendance records.';
const SYNC_COMPLETE_NOTIFICATION = 'Synchronization Completed Successfully.';
const LOCAL_LOGO_URL = '../assets/edutrack-scanner.png';

const state = {
  settings: {},
  scannerMode: 'webcam',
  html5QrCode: null,
  cameraRunning: false,
  recentScans: new Map(),
  pendingTimeoutQr: '',
  usbBuffer: '',
  lastUsbKeyAt: 0,
  busy: false,
  todayKey: currentDayKey(),
  serverTodayScanCount: 0,
  localTodayScanCount: 0,
  queuedTodayCount: 0,
  connectionOnline: false,
  hasLiveResult: false,
  lastSyncAt: null,
  syncInProgress: false,
  lastHistoryId: '',
  initialized: false,
  scanModalTimer: null
};

const $ = (id) => document.getElementById(id);

function pad(value) {
  return String(value).padStart(2, '0');
}

function currentDayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalSqlDateTime(date = new Date()) {
  return `${currentDayKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

function formatDateLong(date = new Date()) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatShortTime(date = new Date()) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatHistoryTime(value) {
  const date = parseSqlDateTime(value);
  if (!date) return 'Pending';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateClock() {
  const now = new Date();
  $('clockTime').textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  $('clockDate').textContent = formatDateLong(now);
}

function setStatusLine(message) {
  $('statusLine').textContent = message;
}

function setCardTone(id, tone) {
  const card = $(id);
  if (!card) return;
  if (tone) card.dataset.tone = tone;
  else delete card.dataset.tone;
}

function showToast(message, tone = 'info') {
  const stack = $('toastStack');
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`.trim();
  toast.textContent = message;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 220);
  }, 3600);
}

function setConnection(online, message) {
  state.connectionOnline = !!online;

  const pill = $('connectionPill');
  pill.classList.toggle('online', !!online);
  pill.classList.toggle('offline', !online);
  pill.querySelector('b').textContent = online ? 'Online' : 'Offline';
  $('connectionDetail').textContent = online ? 'Connected to Server' : 'Offline scanner mode';
  $('connectionCardValue').textContent = online ? 'Online' : 'Offline';
  $('connectionCardDetail').textContent = message || (online ? 'Attendance records are reaching the server.' : 'Scans can still be saved on this computer.');
  $('syncConnectionValue').textContent = online ? 'Online' : 'Offline';
  $('syncConnectionDetail').textContent = message || (online ? 'The server is reachable and ready to receive scans.' : 'Offline mode is active and saving attendance locally.');
  $('offlineBadge').classList.toggle('hidden', !!online);
  setCardTone('connectionSummaryCard', online ? 'success' : 'danger');
}

function initials(name) {
  const parts = String(name || 'Edutrack').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return String(name || 'ET').slice(0, 2).toUpperCase();
}

function selectedSchoolName() {
  const selected = String(state.settings.selectedSchoolId || '').trim();
  const school = (state.settings.schools || []).find((item) => String(item.id) === selected);
  return school ? school.name : '';
}

function refreshAssignedSchool() {
  const schoolName = selectedSchoolName();
  $('assignedSchoolValue').textContent = schoolName || 'Division kiosk';
  $('assignedSchoolDetail').textContent = schoolName
    ? 'Desktop scanner is assigned to this school.'
    : 'Configured for division-wide attendance scanning.';
}

function updateQueue(count) {
  const queued = Number(count) || 0;
  $('queueChip').textContent = `${queued} queued`;
}

function updatePendingSummary(payload) {
  const queued = Number(payload.queuedCount) || 0;
  $('pendingSummaryValue').textContent = String(queued);
  $('pendingRecordsValue').textContent = String(queued);

  const detail = queued
    ? `${queued} offline attendance record(s) are waiting to upload.`
    : 'No offline attendance records are waiting.';

  $('pendingSummaryDetail').textContent = detail;
  $('pendingRecordsDetail').textContent = detail;
  $('historySummary').textContent = queued
    ? `${queued} record(s) are still pending synchronization.`
    : 'Recent background and manual sync activity.';
  setCardTone('pendingSummaryCard', queued ? 'warning' : 'success');
}

function updateTodayScansCard() {
  const total = Math.max(0, Number(state.localTodayScanCount) || 0);
  $('todayScansValue').textContent = String(total);
  $('todayScansDetail').textContent = state.queuedTodayCount
    ? `${state.queuedTodayCount} scan(s) from this PC are waiting to sync.`
    : "Today's attendance records.";
}

function updateScannerStatus(title, detail, tone = 'neutral') {
  $('scannerStatusValue').textContent = title;
  $('scannerStatusDetail').textContent = detail;
  setCardTone('scannerSummaryCard', tone === 'neutral' ? '' : tone);
}

function updateSyncStatus(title, detail, tone = 'neutral') {
  $('syncStatusValue').textContent = title;
  $('syncStatusDetail').textContent = detail;
  setCardTone('syncSummaryCard', tone === 'neutral' ? '' : tone);
}

function updateLastSyncFromPayload(value, detail) {
  const date = parseSqlDateTime(value);
  if (date) state.lastSyncAt = date;

  if (state.lastSyncAt) {
    $('lastSyncValue').textContent = formatShortTime(state.lastSyncAt);
    $('lastSyncDetail').textContent = detail || 'Latest successful synchronization with the server.';
    return;
  }

  $('lastSyncValue').textContent = 'Not yet synced';
  $('lastSyncDetail').textContent = detail || 'Queued scans will upload automatically when internet returns.';
}

function updateScannerModeDetail(mode = state.scannerMode) {
  if (mode === 'usb') {
    $('scannerModeValue').textContent = 'USB QR Scanner';
    $('scannerModeDetail').textContent = 'Keyboard-style USB scanners can submit codes instantly after Enter.';
    $('modeHint').textContent = 'USB scanner mode is active.';
    return;
  }
  $('scannerModeValue').textContent = 'Webcam Scanner';
  $('scannerModeDetail').textContent = 'The camera dashboard can scan student and teacher QR codes live.';
  $('modeHint').textContent = 'Webcam scanner mode is active.';
}

function updateTotalSynced(value, failedCount = 0) {
  $('totalSyncedValue').textContent = String(Number(value) || 0);
  $('totalSyncedDetail').textContent = failedCount
    ? `${failedCount} record(s) still need another retry or review.`
    : 'Attendance records that already reached the server.';
}

function resolveAssetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^(https?:|data:|file:|blob:)/i.test(raw)) return raw;

  const serverUrl = String(state.settings.serverUrl || '').trim().replace(/\/+$/, '');
  if (raw.startsWith('/') && serverUrl) return `${serverUrl}${raw}`;
  return raw;
}

function updateSyncProgress(payload) {
  const total = Number(payload.syncProgress?.total) || 0;
  const completed = Number(payload.syncProgress?.completed) || 0;
  const synced = Number(payload.syncProgress?.synced) || 0;
  const skipped = Number(payload.syncProgress?.skipped) || 0;
  const failed = Number(payload.syncProgress?.failed) || 0;
  const remaining = Number(payload.syncProgress?.remaining) || 0;

  let value = 'Idle';
  let detail = 'No synchronization is running right now.';
  let percent = payload.queuedCount ? 0 : 100;

  if (payload.syncInProgress && total > 0) {
    value = `${Math.min(completed, total)} / ${total}`;
    detail = `Synced ${synced}, skipped ${skipped}, failed ${failed}, remaining ${remaining}.`;
    percent = Math.max(8, Math.round((completed / total) * 100));
  } else if (payload.queuedCount) {
    value = `${payload.queuedCount} queued`;
    detail = 'Pending records are ready to upload as soon as the server is reachable.';
    percent = 0;
  } else if (payload.online) {
    value = 'Ready';
    detail = 'All pending records are synchronized.';
    percent = 100;
  } else {
    value = 'Offline';
    detail = 'Offline mode is saving attendance records locally.';
    percent = 0;
  }

  $('syncProgressValue').textContent = value;
  $('syncProgressDetail').textContent = detail;
  $('syncProgressFill').style.width = `${percent}%`;
}

function applyBrand(settings) {
  $('divisionName').textContent = settings.divisionName || 'Schools Division of Sipalay City';
  $('brandName').textContent = '';
  document.title = 'Edutrack Scanner';

  const logo = $('brandLogo');
  const logoUrl = resolveAssetUrl(settings.systemLogo);
  if (logoUrl) {
    logo.innerHTML = `<img src="${escapeHtml(logoUrl)}" alt="Edutrack logo" onerror="this.onerror=null;this.src='${LOCAL_LOGO_URL}';">`;
  } else {
    logo.innerHTML = `<img src="${LOCAL_LOGO_URL}" alt="Edutrack logo">`;
  }
}

function populateSchools(settings) {
  const select = $('schoolInput');
  const selected = settings.selectedSchoolId || '';
  select.innerHTML = '<option value="">All schools / division kiosk</option>';
  (settings.schools || []).forEach((school) => {
    const option = document.createElement('option');
    option.value = String(school.id);
    option.textContent = school.name;
    select.appendChild(option);
  });
  select.value = selected;
}

function reflectModeSelection(mode) {
  document.querySelectorAll('.mode-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  $('webcamStage').classList.toggle('hidden', mode !== 'webcam');
  $('usbStage').classList.toggle('hidden', mode !== 'usb');
  $('scannerModeInput').value = mode;
}

function applySettings(settings, options = {}) {
  state.settings = { ...state.settings, ...settings };
  state.scannerMode = state.settings.scannerMode || 'webcam';

  applyBrand(state.settings);
  populateSchools(state.settings);
  refreshAssignedSchool();

  $('serverUrlInput').value = state.settings.serverUrl || '';
  $('timeInInput').value = state.settings.timeInStart || '07:00';
  $('timeOutInput').value = state.settings.timeOutOpen || '17:00';
  $('duplicateInput').value = state.settings.duplicateIntervalSeconds || 5;
  $('offlineSyncInput').checked = state.settings.offlineSync !== false;
  $('fullscreenInput').checked = !!state.settings.startFullscreen;
  $('trayInput').checked = !!state.settings.minimizeToTray;
  $('autoStartInput').checked = typeof options.autoStartEnabled === 'boolean'
    ? options.autoStartEnabled
    : !!state.settings.autoStart;

  reflectModeSelection(state.scannerMode);
  updateScannerModeDetail(state.scannerMode);
}

function scanCooldownMs() {
  return Math.max(1, Number(state.settings.duplicateIntervalSeconds) || 5) * 1000;
}

function isDuplicate(qrCode) {
  const key = String(qrCode || '').trim();
  if (!key) return true;
  const now = Date.now();
  const last = state.recentScans.get(key) || 0;
  if (now - last < scanCooldownMs()) return true;
  state.recentScans.set(key, now);
  for (const [code, timestamp] of state.recentScans.entries()) {
    if (now - timestamp > scanCooldownMs() * 3) state.recentScans.delete(code);
  }
  return false;
}

function resultTone(data) {
  if (!data.success && !data.offline) return 'error';
  if (data.offline && !data.success) return 'warning';
  if (data.offline) return 'warning';
  if (['PENDING_TIME_OUT', 'CONFIRM_TIME_OUT'].includes(data.action) || data.status === 'late') return 'warning';
  return 'success';
}

function titleForResult(data) {
  if (data.offline && data.success && data.action === 'TIME_IN') return 'Saved locally';
  if (data.offline && data.success && data.action === 'TIME_OUT') return 'Time out saved locally';
  if (data.offline && !data.success) return 'Offline review';
  if (!data.success) return data.person ? 'Scan needs attention' : 'QR code not recognized';
  if (data.action === 'TIME_IN' && data.status === 'late') return 'Late time in recorded';
  if (data.action === 'TIME_IN') return 'Time in recorded';
  if (data.action === 'TIME_OUT') return 'Time out recorded';
  if (data.action === 'PENDING_TIME_OUT') return 'Already timed in';
  if (data.action === 'CONFIRM_TIME_OUT') return 'Confirm time out';
  return 'Attendance recorded';
}

function statusIconForTone(tone) {
  if (tone === 'error') return 'X';
  if (tone === 'warning') return '!';
  return 'OK';
}

function detailItem(label, value, full = false) {
  return `<div class="detail-item ${full ? 'full' : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || 'N/A')}</strong></div>`;
}

function renderPersonDetails(person) {
  if (!person) return '';
  const idLabel = person.type === 'teacher' ? 'Employee ID' : 'LRN';
  const idValue = person.type === 'teacher' ? person.employee_id : person.lrn;
  return [
    detailItem('School', person.school, true),
    detailItem(idLabel, idValue),
    detailItem('Grade and Section', `${person.grade || 'N/A'} - ${person.section || 'N/A'}`),
    detailItem('Adviser', person.adviser || 'N/A', true),
    person.adviser_contact ? detailItem('Adviser Contact', person.adviser_contact) : '',
    person.adviser_email ? detailItem('Adviser Email', person.adviser_email) : ''
  ].join('');
}

function timeItem(label, value) {
  return `<div class="time-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '--:--')}</strong></div>`;
}

function renderTimes(data) {
  if (data.time_in || data.time_out) {
    return `${timeItem('Time In', data.time_in)}${timeItem('Time Out', data.time_out || 'Pending')}`;
  }
  if (data.time) {
    return timeItem(data.action === 'TIME_OUT' ? 'Time Out' : 'Time In', data.time);
  }
  return `${timeItem('Attendance Event', 'Recorded')}${timeItem('Storage Mode', state.connectionOnline ? 'Server' : 'Local Queue')}`;
}

function humanizeAction(value) {
  const action = String(value || '').toUpperCase();
  if (action === 'TIME_IN') return 'Time In';
  if (action === 'TIME_OUT') return 'Time Out';
  if (action === 'PENDING_TIME_OUT') return 'Pending';
  if (action === 'CONFIRM_TIME_OUT') return 'Confirm';
  return 'Scan';
}

function humanizeSync(value) {
  const status = String(value || '').toLowerCase();
  if (status === 'synced') return 'Synced';
  if (status === 'pending') return 'Queued';
  if (status === 'failed') return 'Retry';
  if (status === 'skipped') return 'Skipped';
  return 'Local';
}

function cleanCell(value) {
  const text = String(value || '').trim();
  if (!text || /^n\/a$/i.test(text)) return '-';
  return text;
}

function modalTimeForResult(data) {
  if (data.action === 'TIME_OUT') return data.time_out || data.time || 'Recorded';
  if (data.action === 'TIME_IN') return data.time_in || data.time || 'Recorded';
  if (data.action === 'PENDING_TIME_OUT' || data.action === 'CONFIRM_TIME_OUT') return data.time_out || 'Pending Time Out';
  if (data.time_in || data.time_out) return data.time_out || data.time_in;
  return data.time || 'Recorded';
}

function modalMetaForPerson(person) {
  if (!person) return 'Attendance record';
  const grade = cleanCell(person.grade);
  const section = cleanCell(person.section);
  const school = cleanCell(person.school);
  const classText = [grade, section].filter((item) => item !== '-').join(' - ');
  return [classText, school].filter((item) => item && item !== '-').join(' | ') || 'Attendance record';
}

function friendlyKioskMessage(data) {
  const raw = String(data?.message || data?.error || '').trim();
  const lower = raw.toLowerCase();
  if (/class suspension|classes suspended|suspended/.test(lower)) {
    return {
      title: 'Classes Suspended',
      message: raw || 'Attendance scanning is not required while classes are suspended.'
    };
  }
  if (/holiday|regular holiday|special non-working/.test(lower)) {
    return {
      title: 'Holiday',
      message: raw || 'Attendance scanning is not required today because it is marked as a holiday.'
    };
  }
  if (/no class|no classes|non-school|weekend|saturday|sunday/.test(lower)) {
    return {
      title: 'No Classes Today',
      message: raw || 'Attendance scanning is not required today.'
    };
  }
  return {
    title: titleForResult(data || {}),
    message: raw || 'Attendance record processed.'
  };
}

function closeScanModal() {
  if (state.scanModalTimer) {
    clearTimeout(state.scanModalTimer);
    state.scanModalTimer = null;
  }
  $('scanModal').classList.add('hidden');
}

function showScanFeedback(title, message, tone = 'success', data = {}) {
  const modal = $('scanModal');
  const card = $('scanModalCard');
  const person = data.person || null;
  const actionLabel = humanizeAction(data.action);
  const isOffline = !!data.offline;

  card.className = `scan-modal-card ${tone}`.trim();
  $('scanModalLabel').textContent = isOffline ? 'Saved offline' : 'Attendance recorded';
  $('scanModalTitle').textContent = title;
  $('scanModalMessage').textContent = message;
  $('scanModalName').textContent = person?.name || 'Attendance record';
  $('scanModalMeta').textContent = modalMetaForPerson(person);
  $('scanModalTime').textContent = `${actionLabel}: ${modalTimeForResult(data)}`;

  modal.classList.remove('hidden');

  if (state.scanModalTimer) clearTimeout(state.scanModalTimer);
  if (data.action !== 'CONFIRM_TIME_OUT') {
    state.scanModalTimer = setTimeout(closeScanModal, tone === 'error' ? 5200 : 3600);
  }
}

function renderLocalScans(scans = []) {
  const rows = $('localScanRows');
  const empty = $('localScanEmpty');
  rows.innerHTML = '';

  const localScans = Array.isArray(scans) ? scans : [];
  empty.classList.toggle('hidden', localScans.length > 0);

  localScans.forEach((scan) => {
    const tr = document.createElement('tr');
    const scanDate = parseSqlDateTime(scan.scanTime);
    const time = scanDate ? formatShortTime(scanDate) : '--:--';
    const name = scan.name || 'Attendance Record';
    const grade = cleanCell(scan.gradeLevel);
    const section = cleanCell(scan.sectionName);
    const school = cleanCell(scan.schoolName);
    const action = humanizeAction(scan.eventAction);

    tr.innerHTML = `
      <td>${escapeHtml(name)}</td>
      <td>${escapeHtml(grade)}</td>
      <td>${escapeHtml(section)}</td>
      <td>${escapeHtml(school)}</td>
      <td><span class="time-badge"><b>${escapeHtml(action)}</b><small>${escapeHtml(time)}</small></span></td>
    `;
    rows.appendChild(tr);
  });
}

function schoolDayText(status) {
  if (!status || status.isSchoolDay !== false) {
    return null;
  }

  const reason = String(status.reason || '').trim();
  const type = String(status.type || '').trim();
  const combined = `${type} ${reason}`.toLowerCase();

  if (/class suspension|suspended/.test(combined)) {
    return {
      title: 'Classes Suspended',
      message: reason
        ? `Classes are suspended today: ${reason}. Attendance scanning is not required.`
        : 'Classes are suspended today. Attendance scanning is not required.'
    };
  }

  if (/holiday|regular|special non-working/.test(combined)) {
    return {
      title: 'Holiday',
      message: reason
        ? `Today is marked as a holiday: ${reason}. Attendance scanning is not required.`
        : 'Today is marked as a holiday. Attendance scanning is not required.'
    };
  }

  if (/saturday|sunday|weekend/.test(combined)) {
    return {
      title: 'Weekend',
      message: 'Classes are not scheduled today. Attendance scanning is not required.'
    };
  }

  return {
    title: 'No Classes Today',
    message: reason
      ? `No classes today: ${reason}. Attendance scanning is not required.`
      : 'No classes today. Attendance scanning is not required.'
  };
}

function applySchoolDayStatus(status) {
  const text = schoolDayText(status);
  $('dayNotice').classList.toggle('hidden', !text);
  if (!text) return;
  $('dayNoticeTitle').textContent = text.title;
  $('dayNoticeText').textContent = text.message;
}

function renderResult(data) {
  const tone = resultTone(data);
  const friendly = friendlyKioskMessage(data);
  showScanFeedback(friendly.title, friendly.message, tone, data);
  $('confirmBox').classList.toggle('hidden', data.action !== 'CONFIRM_TIME_OUT');

  if (data.action === 'CONFIRM_TIME_OUT') state.pendingTimeoutQr = data.qrCode || state.pendingTimeoutQr;
  state.hasLiveResult = true;
}

function renderServerRecord(record) {
  return record;
}

function resetForNewDayIfNeeded() {
  const today = currentDayKey();
  if (state.todayKey === today) return;
  state.todayKey = today;
  state.serverTodayScanCount = 0;
  state.localTodayScanCount = 0;
  state.queuedTodayCount = 0;
  state.hasLiveResult = false;
  renderLocalScans([]);
  closeScanModal();
  updateTodayScansCard();
}

function applyServerSummary(summary, queuedTodayCount = 0) {
  resetForNewDayIfNeeded();
  state.serverTodayScanCount = Number(summary?.todayScanCount) || 0;
  state.queuedTodayCount = Number(queuedTodayCount) || 0;
  updateTodayScansCard();
}

function triggerLabel(triggerSource) {
  const value = String(triggerSource || '').toLowerCase();
  if (value === 'manual' || value === 'tray') return 'Manual sync';
  if (value === 'startup') return 'Startup sync';
  if (value === 'background' || value === 'manual-check') return 'Background sync';
  if (value === 'pre-submit') return 'Pre-scan sync';
  return 'Synchronization';
}

function renderHistory(entries = []) {
  const list = $('syncHistoryList');
  list.innerHTML = '';

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No synchronization history yet.';
    list.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const item = document.createElement('article');
    item.className = `history-item ${String(entry.status || '').toLowerCase()}`.trim();

    const head = document.createElement('div');
    head.className = 'history-item-head';

    const title = document.createElement('strong');
    title.textContent = triggerLabel(entry.triggerSource);

    const stamp = document.createElement('span');
    stamp.textContent = formatHistoryTime(entry.finishedAt || entry.startedAt);
    head.appendChild(title);
    head.appendChild(stamp);

    const status = document.createElement('p');
    status.textContent = entry.detailMessage || 'Synchronization activity recorded.';

    const meta = document.createElement('small');
    meta.textContent = `Status: ${String(entry.status || 'running').toUpperCase()} | Total ${entry.totalEvents || 0} | Synced ${entry.syncedEvents || 0} | Skipped ${entry.skippedEvents || 0} | Failed ${entry.failedEvents || 0} | Remaining ${entry.remainingEvents || 0}`;

    item.appendChild(head);
    item.appendChild(status);
    item.appendChild(meta);
    list.appendChild(item);
  });
}

function handleStateNotifications(previous, payload, options = {}) {
  if (!state.initialized || options.silentNotifications) return;

  if (previous.online !== null && previous.online !== payload.online) {
    if (!payload.online) {
      showToast(OFFLINE_NOTIFICATION, 'warning');
    } else if (payload.online && Number(payload.queuedCount || 0) > 0) {
      showToast(CONNECTION_RESTORED_NOTIFICATION, 'success');
    }
  }

  if (previous.syncInProgress && !payload.syncInProgress) {
    const latest = Array.isArray(payload.recentSyncHistory) ? payload.recentSyncHistory[0] : null;
    if (latest && latest.syncHistoryId !== previous.lastHistoryId && latest.status === 'success') {
      showToast(SYNC_COMPLETE_NOTIFICATION, 'success');
    }
  }
}

function applyScannerStatusPayload(payload, options = {}) {
  const previous = {
    online: state.initialized ? state.connectionOnline : null,
    syncInProgress: state.syncInProgress,
    lastHistoryId: state.lastHistoryId
  };

  if (payload.config?.settings) {
    applySettings(payload.config.settings, { autoStartEnabled: state.settings.autoStart });
  }

  updateQueue(payload.queuedCount || 0);
  state.queuedTodayCount = Number(payload.queuedTodayCount) || 0;
  state.localTodayScanCount = Number(payload.localTodayScanCount) || 0;
  applyServerSummary(payload.config?.summary || null, state.queuedTodayCount);
  applySchoolDayStatus(payload.schoolDayStatus || null);
  setConnection(payload.online, payload.message);
  updatePendingSummary(payload);
  updateTodayScansCard();
  updateSyncProgress(payload);
  updateTotalSynced(payload.totalSyncedRecords || 0, payload.failedRecordsCount || 0);
  renderLocalScans(payload.recentLocalScans || []);
  renderHistory(payload.recentSyncHistory || []);

  if (payload.lastSuccessfulSyncAt) {
    updateLastSyncFromPayload(payload.lastSuccessfulSyncAt, Number(payload.queuedCount)
      ? 'A connection is available, but some offline scans are still queued.'
      : 'Latest successful synchronization completed.');
  } else if (payload.online && Number(payload.queuedCount || 0) === 0) {
    updateLastSyncFromPayload(null, 'Live attendance scans are reaching the server successfully.');
  } else {
    updateLastSyncFromPayload(null, 'Queued scans will upload automatically when internet returns.');
  }

  if (payload.syncInProgress) {
      updateSyncStatus('Synchronizing', payload.syncProgress?.currentLabel
        ? `Uploading ${payload.syncProgress.currentLabel} and other pending attendance records.`
      : 'Synchronizing queued attendance records with the server.', 'warning');
    updateScannerStatus('Synchronizing records', 'Offline attendance records are being uploaded in the background.', 'warning');
  } else if (payload.online) {
    if (Number(payload.queuedCount || 0) > 0) {
      updateSyncStatus('Queue waiting', `${payload.queuedCount} offline attendance record(s) are still waiting to sync.`, 'warning');
    } else if (Number(payload.failedRecordsCount || 0) > 0) {
      updateSyncStatus('Needs retry', `${payload.failedRecordsCount} record(s) still need another synchronization attempt.`, 'warning');
    } else {
      updateSyncStatus('Up to date', 'Desktop attendance records are synced with the server.', 'success');
    }
  } else {
    updateSyncStatus(Number(payload.queuedCount || 0) > 0 ? 'Queued locally' : 'Offline', payload.message || 'The desktop scanner is waiting for internet connectivity.', Number(payload.queuedCount || 0) > 0 ? 'warning' : 'danger');
  }

  state.syncInProgress = !!payload.syncInProgress;
  state.lastHistoryId = payload.recentSyncHistory?.[0]?.syncHistoryId || state.lastHistoryId;

  handleStateNotifications(previous, payload, options);
  if (payload.message && !options.quietStatusLine) setStatusLine(payload.message);
}

async function submitQrCode(qrCode, options = {}) {
  const trimmed = String(qrCode || '').trim();
  if (!trimmed || state.busy) return;
  if (!options.confirmTimeOut && isDuplicate(trimmed)) {
    setStatusLine('Duplicate scan ignored to protect attendance accuracy.');
    updateScannerStatus('Duplicate blocked', 'The same QR code was scanned again too quickly.', 'warning');
    return;
  }

  state.busy = true;
  state.pendingTimeoutQr = trimmed;
  setStatusLine('Processing attendance scan...');
  updateScannerStatus('Processing scan', 'Preparing the attendance record for server or offline storage.', 'warning');

  const result = await api.submitScan({
    qrCode: trimmed,
    scanTime: formatLocalSqlDateTime(),
    allowQueue: options.allowQueue !== false,
    requireTimeOutConfirmation: options.requireTimeOutConfirmation !== false,
    confirmTimeOut: !!options.confirmTimeOut
  });

  result.qrCode = trimmed;
  renderResult(result);
  applyScannerStatusPayload(result, { quietStatusLine: true });

  if (result.offline) {
    if (result.success && ['TIME_IN', 'TIME_OUT'].includes(result.action)) {
      updateScannerStatus('Offline record saved', 'Attendance has been saved locally and will upload automatically.', 'warning');
      setStatusLine(OFFLINE_NOTIFICATION);
    } else {
      updateScannerStatus('Offline review', result.error || 'Please review the latest offline attendance response.', result.success ? 'warning' : 'danger');
      setStatusLine(result.message || OFFLINE_NOTIFICATION);
    }
  } else if (result.action === 'TIME_IN' || result.action === 'TIME_OUT') {
    state.lastSyncAt = new Date();
    updateLastSyncFromPayload(formatLocalSqlDateTime(state.lastSyncAt), 'Latest attendance update reached the server successfully.');
    updateScannerStatus('Ready for next scan', 'Student and teacher QR codes can be scanned again.', 'success');
    setStatusLine(result.message || 'Attendance recorded successfully.');
  } else if (result.action === 'CONFIRM_TIME_OUT') {
    updateScannerStatus('Awaiting confirmation', 'Confirm this end-of-day time out to finish the attendance record.', 'warning');
    setStatusLine(result.message || 'Please confirm before recording time out.');
  } else if (result.action === 'PENDING_TIME_OUT') {
    updateScannerStatus('Already timed in', 'Time out will be available at the scheduled end-of-day time.', 'warning');
    setStatusLine(result.message || 'This person is already timed in for today.');
  } else if (!result.success) {
    updateScannerStatus('Scan needs attention', result.error || 'Please review the latest attendance response.', 'danger');
    setStatusLine(result.error || 'The scan needs attention.');
  } else {
    updateScannerStatus('Ready for next scan', 'The scanner is connected and ready for another QR code.', 'success');
    setStatusLine(result.message || 'Attendance request completed.');
  }

  updateTodayScansCard();
  state.busy = false;
  $('usbInput').value = '';
}

async function confirmTimeout() {
  if (!state.pendingTimeoutQr) return;
  await submitQrCode(state.pendingTimeoutQr, { confirmTimeOut: true, allowQueue: true, requireTimeOutConfirmation: true });
}

async function startCamera() {
  if (state.cameraRunning) return;
  if (!window.Html5Qrcode) {
    $('cameraFallback').classList.remove('hidden');
    setStatusLine('Camera scanner library is unavailable. Switch to USB Scanner mode.');
    updateScannerStatus('Camera unavailable', 'The desktop app can still scan through a USB QR scanner.', 'danger');
    return;
  }

  try {
    if (!state.html5QrCode) state.html5QrCode = new Html5Qrcode('reader');
    await state.html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: { width: 360, height: 360 }, aspectRatio: 1.0, disableFlip: false },
      (decodedText) => submitQrCode(decodedText),
      () => {}
    );
    state.cameraRunning = true;
    $('cameraFallback').classList.add('hidden');
    setStatusLine('Camera scanner is active. Position a QR code inside the frame.');
    updateScannerStatus('Webcam ready', 'The live camera scanner is ready for student and teacher QR codes.', 'success');
  } catch (_firstErr) {
    try {
      await state.html5QrCode.start(
        { facingMode: 'user' },
        { fps: 12, qrbox: { width: 360, height: 360 }, aspectRatio: 1.0, disableFlip: false },
        (decodedText) => submitQrCode(decodedText),
        () => {}
      );
      state.cameraRunning = true;
      $('cameraFallback').classList.add('hidden');
      setStatusLine('Camera scanner is active using the available camera.');
      updateScannerStatus('Webcam ready', 'The available camera is active and ready for attendance scans.', 'success');
    } catch (_err) {
      $('cameraFallback').classList.remove('hidden');
      setStatusLine('Camera is unavailable. Switch to USB Scanner mode or allow camera permission.');
      updateScannerStatus('Camera permission needed', 'Allow Windows camera access or use a USB QR scanner instead.', 'warning');
    }
  }
}

async function stopCamera() {
  if (state.html5QrCode && state.cameraRunning) {
    try {
      await state.html5QrCode.stop();
    } catch (_err) {
      // Ignore stop failures so the next start attempt can still recover.
    }
  }
  state.cameraRunning = false;
}

async function setMode(mode, persist = true) {
  state.scannerMode = mode === 'usb' ? 'usb' : 'webcam';
  reflectModeSelection(state.scannerMode);
  updateScannerModeDetail(state.scannerMode);

  if (state.scannerMode === 'webcam') {
    await startCamera();
  } else {
    await stopCamera();
    setTimeout(() => $('usbInput')?.focus(), 80);
    setStatusLine('USB scanner mode is active. Scan a QR code or paste it into the input.');
    updateScannerStatus('USB scanner ready', 'This desktop station is listening for keyboard-style QR scanners.', 'success');
  }

  if (persist) {
    state.settings = await api.saveSettings({ scannerMode: state.scannerMode });
  }
}

function openSettings() {
  $('settingsDrawer').classList.add('open');
  $('settingsDrawer').setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  $('settingsDrawer').classList.remove('open');
  $('settingsDrawer').setAttribute('aria-hidden', 'true');
}

async function saveSettingsFromForm() {
  const settings = await api.saveSettings({
    serverUrl: $('serverUrlInput').value,
    scannerMode: $('scannerModeInput').value,
    selectedSchoolId: $('schoolInput').value,
    timeInStart: $('timeInInput').value,
    timeOutOpen: $('timeOutInput').value,
    duplicateIntervalSeconds: $('duplicateInput').value,
    autoStart: $('autoStartInput').checked,
    startFullscreen: $('fullscreenInput').checked,
    minimizeToTray: $('trayInput').checked,
    offlineSync: $('offlineSyncInput').checked
  });

  applySettings(settings, { autoStartEnabled: settings.autoStart });
  await setMode(settings.scannerMode || state.scannerMode, false);
  $('settingsNote').textContent = 'Edutrack Scanner settings saved successfully.';
  closeSettings();
  await checkConnection({ silentNotifications: true });
}

async function testConnection() {
  $('settingsNote').textContent = 'Refreshing student and teacher records...';
  const result = await api.checkConnection();
  applyScannerStatusPayload(result, { silentNotifications: true, quietStatusLine: true });
  $('settingsNote').textContent = result.online
    ? 'Connected to Server. Local student and teacher records are updated.'
    : result.message;
}

async function checkConnection(options = {}) {
  const result = await api.checkConnection();
  applyScannerStatusPayload(result, options);
  return result;
}

async function syncQueue() {
  setStatusLine('Syncing queued attendance records...');
  const result = await api.syncQueue();
  applyScannerStatusPayload(result, { quietStatusLine: true });

  if ((result.remaining || 0) === 0 && (result.synced || result.skipped || result.failed)) {
    setStatusLine(SYNC_COMPLETE_NOTIFICATION);
  } else if (result.remaining || result.failed) {
    setStatusLine('Some queued records still need the server before they can finish syncing.');
  } else {
    setStatusLine('No queued attendance records need synchronization right now.');
  }
}

function isEditable(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function bindClick(id, handler) {
  const element = $(id);
  if (element) element.addEventListener('click', handler);
}

function handleUsbKeydown(event) {
  if (state.scannerMode !== 'usb') return;
  if (isEditable(event.target) && event.target.id !== 'usbInput') return;

  const now = Date.now();
  if (now - state.lastUsbKeyAt > 120) state.usbBuffer = '';
  state.lastUsbKeyAt = now;

  if (event.key === 'Enter') {
    const code = state.usbBuffer || $('usbInput').value;
    state.usbBuffer = '';
    submitQrCode(code);
    event.preventDefault();
    return;
  }

  if (event.key && event.key.length === 1) {
    state.usbBuffer += event.key;
  }
}

function bindEvents() {
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  });

  bindClick('startCameraBtn', startCamera);
  bindClick('manualScanBtn', () => submitQrCode($('usbInput').value));
  $('usbInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitQrCode($('usbInput').value);
  });
  bindClick('focusUsbBtn', async () => {
    await setMode('usb');
    $('usbInput').focus();
  });
  bindClick('settingsBtn', openSettings);
  bindClick('closeSettingsBtn', closeSettings);
  bindClick('drawerBackdrop', closeSettings);
  bindClick('saveSettingsBtn', saveSettingsFromForm);
  bindClick('testServerBtn', testConnection);
  bindClick('syncBtn', syncQueue);
  bindClick('syncNowBtn', syncQueue);
  bindClick('fullscreenBtn', () => api.toggleFullscreen());
  bindClick('minimizeBtn', () => api.minimize());
  bindClick('closeScanModalBtn', closeScanModal);
  $('scanModal').addEventListener('click', (event) => {
    if (event.target.id === 'scanModal') closeScanModal();
  });
  bindClick('confirmTimeoutBtn', confirmTimeout);
  bindClick('cancelTimeoutBtn', () => {
    $('confirmBox').classList.add('hidden');
    setStatusLine('Time out was not recorded. The scanner is ready for the next attendance scan.');
    updateScannerStatus('Ready for next scan', 'The previous time out request was cancelled.', 'success');
  });
  $('scannerModeInput').addEventListener('change', () => setMode($('scannerModeInput').value));
  window.addEventListener('keydown', handleUsbKeydown);

  api.onQueueStatus((payload) => {
    updateQueue(payload.queuedCount || 0);
    state.queuedTodayCount = Number(payload.queuedTodayCount) || 0;
    updateTodayScansCard();
  });

  api.onScannerStatus((payload) => {
    applyScannerStatusPayload(payload, { quietStatusLine: true });
  });
}

async function init() {
  updateClock();
  setInterval(updateClock, 1000);
  bindEvents();
  updateTodayScansCard();
  updateScannerStatus('Preparing scanner', 'Loading scanner settings and desktop branding.', 'warning');

  const initial = await api.getSettings();
  applySettings(initial.settings, { autoStartEnabled: initial.autoStartEnabled });
  applyScannerStatusPayload(initial, { silentNotifications: true, quietStatusLine: true });
  await setMode(state.scannerMode, false);

  await checkConnection({ silentNotifications: true, quietStatusLine: true });
  state.initialized = true;
  setStatusLine('Edutrack Scanner is ready for attendance scanning.');
}

init().catch((err) => {
  setConnection(false, err.message || "Can't connect to server due to no internet connection.");
  updateSyncStatus('Offline', err.message || 'The desktop scanner could not reach the server during startup.', 'danger');
  updateScannerStatus('Startup needs attention', 'The scanner opened, but the first connectivity check did not finish cleanly.', 'danger');
  setStatusLine(err.message || 'The desktop scanner started with limited connectivity.');
});
