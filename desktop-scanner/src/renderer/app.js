const api = window.edutrack;

const state = {
  settings: {},
  scannerMode: 'webcam',
  html5QrCode: null,
  cameraRunning: false,
  recentScans: new Map(),
  pendingTimeoutQr: '',
  usbBuffer: '',
  lastUsbKeyAt: 0,
  busy: false
};

const $ = (id) => document.getElementById(id);

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatLocalSqlDateTime(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDateLong(date = new Date()) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function updateClock() {
  const now = new Date();
  $('clockTime').textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  $('clockDate').textContent = formatDateLong(now);
}

function setStatusLine(message) {
  $('statusLine').textContent = message;
}

function setConnection(online, message) {
  const pill = $('connectionPill');
  pill.classList.toggle('online', !!online);
  pill.classList.toggle('offline', !online);
  pill.querySelector('b').textContent = online ? 'Online' : 'Offline';
  if (message) setStatusLine(message);
}

function initials(name) {
  const parts = String(name || 'Edutrack').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return String(name || 'ED').slice(0, 2).toUpperCase();
}

function updateQueue(count) {
  $('queueChip').textContent = `${Number(count) || 0} offline`;
}

function applyBrand(settings) {
  $('brandName').textContent = settings.brandName || 'Edutrack';
  $('divisionName').textContent = settings.divisionName || 'Schools Division of Sipalay City';
  const logo = $('brandLogo');
  if (settings.systemLogo) {
    logo.innerHTML = `<img src="${settings.systemLogo}" alt="Edutrack logo">`;
  } else {
    logo.innerHTML = '<span>ES</span>';
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

function applySettings(settings) {
  state.settings = settings;
  state.scannerMode = settings.scannerMode || 'webcam';
  applyBrand(settings);
  populateSchools(settings);

  $('serverUrlInput').value = settings.serverUrl || '';
  $('scannerModeInput').value = state.scannerMode;
  $('timeInInput').value = settings.timeInStart || '07:00';
  $('timeOutInput').value = settings.timeOutOpen || '17:00';
  $('duplicateInput').value = settings.duplicateIntervalSeconds || 5;
  $('autoStartInput').checked = !!settings.autoStart;
  $('fullscreenInput').checked = !!settings.startFullscreen;
  $('trayInput').checked = !!settings.minimizeToTray;
  $('offlineSyncInput').checked = settings.offlineSync !== false;

  setMode(state.scannerMode, false);
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
  if (data.offline) return 'warning';
  if (['PENDING_TIME_OUT', 'CONFIRM_TIME_OUT'].includes(data.action) || data.status === 'late') return 'warning';
  return 'success';
}

function titleForResult(data) {
  if (data.offline) return 'Offline Mode: Saved Locally';
  if (!data.success) return data.person ? 'Scan Needs Attention' : 'Invalid QR Code';
  if (data.action === 'TIME_IN' && data.status === 'late') return 'Late Time In Recorded';
  if (data.action === 'TIME_IN') return 'Time In Recorded';
  if (data.action === 'TIME_OUT') return 'Time Out Recorded';
  if (data.action === 'PENDING_TIME_OUT') return 'Already Timed In';
  if (data.action === 'CONFIRM_TIME_OUT') return 'Confirm Time Out';
  return 'Scan Recorded';
}

function statusIconForTone(tone) {
  if (tone === 'error') return '!';
  if (tone === 'warning') return '!';
  return '✓';
}

function detailItem(label, value, full = false) {
  return `<div class="detail-item ${full ? 'full' : ''}"><span>${label}</span><strong>${value || 'N/A'}</strong></div>`;
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
  return `<div class="time-item"><span>${label}</span><strong>${value || '--:--'}</strong></div>`;
}

function renderTimes(data) {
  if (data.time_in || data.time_out) {
    return `${timeItem('Time In', data.time_in)}${timeItem('Time Out', data.time_out || 'Pending')}`;
  }
  if (data.time) {
    return timeItem(data.action === 'TIME_OUT' ? 'Time Out' : 'Time In', data.time);
  }
  return '';
}

function renderResult(data) {
  const tone = resultTone(data);
  const status = $('resultStatus');
  status.className = `result-status ${tone === 'success' ? '' : tone}`.trim();
  $('statusIcon').textContent = statusIconForTone(tone);
  $('statusTitle').textContent = titleForResult(data);
  $('statusMessage').textContent = data.message || data.error || 'Scan processed.';

  $('emptyResult').classList.add('hidden');
  $('resultContent').classList.remove('hidden');

  const person = data.person || null;
  $('personName').textContent = person?.name || 'Unknown QR Code';
  $('personType').textContent = person?.type || 'Scanner Result';
  $('personAvatar').textContent = initials(person?.name || 'QR');
  $('detailGrid').innerHTML = person ? renderPersonDetails(person) : detailItem('QR Status', data.error || data.message || 'Unknown scan', true);
  $('timeGrid').innerHTML = renderTimes(data);

  const needsConfirm = data.action === 'CONFIRM_TIME_OUT';
  $('confirmBox').classList.toggle('hidden', !needsConfirm);
  if (needsConfirm) state.pendingTimeoutQr = data.qrCode || state.pendingTimeoutQr;

  if (data.queuedCount !== undefined) updateQueue(data.queuedCount);
}

async function submitQrCode(qrCode, options = {}) {
  const trimmed = String(qrCode || '').trim();
  if (!trimmed || state.busy) return;
  if (!options.confirmTimeOut && isDuplicate(trimmed)) return;

  state.busy = true;
  state.pendingTimeoutQr = trimmed;
  setStatusLine('Processing scan...');

  const result = await api.submitScan({
    qrCode: trimmed,
    scanTime: formatLocalSqlDateTime(),
    allowQueue: options.allowQueue !== false,
    requireTimeOutConfirmation: options.requireTimeOutConfirmation !== false,
    confirmTimeOut: !!options.confirmTimeOut
  });

  result.qrCode = trimmed;
  renderResult(result);
  if (result.offline) setConnection(false, result.message || "Can't connect to server due to no internet connection.");
  else setConnection(true, 'Scan processed through the Railway server.');

  state.busy = false;
  if ($('usbInput')) $('usbInput').value = '';
}

async function confirmTimeout() {
  if (!state.pendingTimeoutQr) return;
  await submitQrCode(state.pendingTimeoutQr, { confirmTimeOut: true, allowQueue: false, requireTimeOutConfirmation: true });
}

async function startCamera() {
  if (state.cameraRunning) return;
  if (!window.Html5Qrcode) {
    $('cameraFallback').classList.remove('hidden');
    setStatusLine('Camera scanner library is unavailable. Use USB Scanner mode.');
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
  } catch (firstErr) {
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
    } catch (err) {
      $('cameraFallback').classList.remove('hidden');
      setStatusLine('Camera is unavailable. Switch to USB Scanner mode or allow camera permission.');
    }
  }
}

async function stopCamera() {
  if (state.html5QrCode && state.cameraRunning) {
    try { await state.html5QrCode.stop(); } catch (_err) {}
  }
  state.cameraRunning = false;
}

async function setMode(mode, persist = true) {
  state.scannerMode = mode;
  document.querySelectorAll('.mode-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  $('webcamStage').classList.toggle('hidden', mode !== 'webcam');
  $('usbStage').classList.toggle('hidden', mode !== 'usb');
  $('scannerModeInput').value = mode;

  if (mode === 'webcam') {
    await startCamera();
  } else {
    await stopCamera();
    setTimeout(() => $('usbInput')?.focus(), 80);
    setStatusLine('USB scanner mode is active. Scan a QR code or paste it into the input.');
  }

  if (persist) {
    state.settings = await api.saveSettings({ scannerMode: mode });
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
  applySettings(settings);
  $('settingsNote').textContent = 'Settings saved successfully.';
  closeSettings();
  checkConnection();
}

async function testConnection() {
  $('settingsNote').textContent = 'Testing connection...';
  const result = await api.checkConnection();
  $('settingsNote').textContent = result.online ? 'Connected to Railway server.' : result.message;
  if (result.config?.settings) applySettings(result.config.settings);
  updateQueue(result.queuedCount || 0);
  setConnection(result.online, result.message);
}

async function checkConnection() {
  const result = await api.checkConnection();
  if (result.config?.settings) applySettings(result.config.settings);
  updateQueue(result.queuedCount || 0);
  setConnection(result.online, result.message);
  return result;
}

async function syncQueue() {
  setStatusLine('Syncing offline queue...');
  const result = await api.syncQueue();
  updateQueue(result.remaining || 0);
  setStatusLine(result.remaining ? `${result.synced || 0} scans synced. ${result.remaining} still waiting for internet.` : 'Offline queue is synced.');
}

function isEditable(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
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
  $('startCameraBtn').addEventListener('click', startCamera);
  $('manualScanBtn').addEventListener('click', () => submitQrCode($('usbInput').value));
  $('usbInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitQrCode($('usbInput').value);
  });
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettingsBtn').addEventListener('click', closeSettings);
  $('drawerBackdrop').addEventListener('click', closeSettings);
  $('saveSettingsBtn').addEventListener('click', saveSettingsFromForm);
  $('testServerBtn').addEventListener('click', testConnection);
  $('syncBtn').addEventListener('click', syncQueue);
  $('fullscreenBtn').addEventListener('click', () => api.toggleFullscreen());
  $('confirmTimeoutBtn').addEventListener('click', confirmTimeout);
  $('cancelTimeoutBtn').addEventListener('click', () => {
    $('confirmBox').classList.add('hidden');
    setStatusLine('Time Out was not recorded. Ready for the next scan.');
  });
  $('scannerModeInput').addEventListener('change', () => setMode($('scannerModeInput').value));
  window.addEventListener('keydown', handleUsbKeydown);
  api.onQueueStatus((payload) => updateQueue(payload.queuedCount || 0));
}

async function init() {
  updateClock();
  setInterval(updateClock, 1000);
  bindEvents();

  const initial = await api.getSettings();
  applySettings(initial.settings);
  updateQueue(initial.queuedCount || 0);

  await checkConnection();
  setInterval(checkConnection, 30000);
  setInterval(syncQueue, 20000);
}

init().catch((err) => {
  setConnection(false, err.message || "Can't connect to server due to no internet connection.");
});
