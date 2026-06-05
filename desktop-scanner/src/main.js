const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_SERVER_URL = 'https://school-attendance-qrbased.up.railway.app';
const NO_INTERNET_MESSAGE = "Can't connect to server due to no internet connection.";

let mainWindow = null;
let tray = null;
let isQuitting = false;

function defaultSettings() {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    scannerMode: 'webcam',
    selectedSchoolId: '',
    duplicateIntervalSeconds: 5,
    offlineSync: true,
    autoStart: true,
    startFullscreen: true,
    minimizeToTray: true,
    kioskToken: '',
    brandName: 'Edutrack',
    divisionName: 'Schools Division of Sipalay City',
    systemLogo: '',
    timeInStart: '07:00',
    timeOutOpen: '17:00',
    schools: []
  };
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

function loadSettings() {
  return { ...defaultSettings(), ...readJson(settingsPath(), {}) };
}

function saveSettings(nextSettings) {
  const settings = { ...loadSettings(), ...nextSettings };
  settings.serverUrl = normalizeServerUrl(settings.serverUrl || DEFAULT_SERVER_URL);
  settings.duplicateIntervalSeconds = Math.max(1, Math.min(60, Number(settings.duplicateIntervalSeconds) || 5));
  writeJson(settingsPath(), settings);
  configureAutoStart(settings.autoStart);
  return settings;
}

function readQueue() {
  const queue = readJson(queuePath(), []);
  return Array.isArray(queue) ? queue : [];
}

function writeQueue(queue) {
  writeJson(queuePath(), queue);
  broadcastQueueStatus();
}

function normalizeServerUrl(value) {
  const raw = String(value || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_SERVER_URL;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function createIcon(size = 256) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0f8f68"/><path d="M17 27V17h10M37 17h10v10M47 37v10H37M27 47H17V37" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 32h28" stroke="#bbf7d0" stroke-width="5" stroke-linecap="round"/><circle cx="32" cy="32" r="5" fill="white"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: size, height: size });
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

function createWindow() {
  const settings = loadSettings();
  const shouldFullscreen = !!settings.startFullscreen || process.argv.includes('--autostart');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    fullscreen: shouldFullscreen,
    show: false,
    title: 'Attendance Scanner - Edutrack',
    icon: createIcon(256),
    autoHideMenuBar: true,
    backgroundColor: '#f7fbf8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (shouldFullscreen) mainWindow.setFullScreen(true);
  });

  mainWindow.on('close', (event) => {
    const currentSettings = loadSettings();
    if (!isQuitting && currentSettings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      if (tray) tray.displayBalloon({
        title: 'Edutrack Scanner is still running',
        content: 'The scanner is minimized to the system tray for fast attendance scanning.'
      });
    }
  });
}

function createTray() {
  const icon = createIcon(16);
  if (icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip('Edutrack Attendance Scanner');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Scanner', click: () => showWindow() },
    { label: 'Toggle Full Screen', click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
    { type: 'separator' },
    { label: 'Sync Offline Queue', click: () => syncOfflineQueue() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', showWindow);
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function toLocalSqlDateTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

async function refreshDesktopConfig() {
  const settings = loadSettings();
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const res = await fetchWithTimeout(`${serverUrl}/api/scanner-desktop-config`, { cache: 'no-store' }, 8000);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    throw new Error('The server returned an invalid scanner configuration response.');
  }
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Unable to load scanner configuration.');
  }

  const nextSettings = saveSettings({
    serverUrl,
    kioskToken: data.kioskToken || settings.kioskToken,
    brandName: data.settings?.system_name || settings.brandName,
    divisionName: data.settings?.division_name || settings.divisionName,
    systemLogo: data.settings?.system_logo || settings.systemLogo,
    timeInStart: String(data.settings?.am_time_in_end || settings.timeInStart || '07:00').slice(0, 5),
    timeOutOpen: String(data.settings?.pm_time_out_end || settings.timeOutOpen || '17:00').slice(0, 5),
    schools: Array.isArray(data.schools) ? data.schools : settings.schools
  });

  return { ...data, settings: nextSettings };
}

async function ensureKioskToken() {
  const settings = loadSettings();
  if (settings.kioskToken) return settings;
  const config = await refreshDesktopConfig();
  return config.settings;
}

async function postScan(payload) {
  const settings = await ensureKioskToken();
  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const body = {
    qr_code: payload.qrCode,
    require_time_out_confirmation: !!payload.requireTimeOutConfirmation,
    confirm_time_out: !!payload.confirmTimeOut
  };
  if (payload.scanTime) body.scan_time = payload.scanTime;

  const res = await fetchWithTimeout(`${serverUrl}/api/scan-attendance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Scanner-Kiosk-Token': settings.kioskToken
    },
    body: JSON.stringify(body)
  }, 12000);

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    throw new Error('The scanner server returned an invalid response.');
  }

  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

function addOfflineScan(qrCode, scanTime) {
  const queue = readQueue();
  const trimmed = String(qrCode || '').trim();
  if (!trimmed) return queue.length;
  const duplicate = queue.some(item => item.qrCode === trimmed && Math.abs(new Date(item.scanTime).getTime() - new Date(scanTime).getTime()) < 5000);
  if (!duplicate) {
    queue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      qrCode: trimmed,
      scanTime: scanTime || toLocalSqlDateTime(),
      createdAt: toLocalSqlDateTime()
    });
    writeQueue(queue);
  }
  return readQueue().length;
}

async function submitScan(payload) {
  const qrCode = String(payload?.qrCode || '').trim();
  if (!qrCode) return { success: false, error: 'Invalid QR Code' };

  try {
    const data = await postScan({
      qrCode,
      requireTimeOutConfirmation: payload?.requireTimeOutConfirmation !== false,
      confirmTimeOut: !!payload?.confirmTimeOut
    });
    return { ...data, online: true, queuedCount: readQueue().length };
  } catch (err) {
    if (isNetworkError(err) && loadSettings().offlineSync && payload?.allowQueue !== false) {
      const scanTime = payload?.scanTime || toLocalSqlDateTime();
      const queuedCount = addOfflineScan(qrCode, scanTime);
      return {
        success: false,
        offline: true,
        queued: true,
        error: 'Offline Mode: Saved Locally',
        message: NO_INTERNET_MESSAGE,
        queuedCount
      };
    }
    return { success: false, error: err.message || 'Scanner request failed.', queuedCount: readQueue().length };
  }
}

async function syncOfflineQueue() {
  const queue = readQueue();
  if (queue.length === 0) return { success: true, synced: 0, remaining: 0 };

  let synced = 0;
  const remaining = [];

  for (const item of queue) {
    try {
      await postScan({
        qrCode: item.qrCode,
        scanTime: item.scanTime,
        requireTimeOutConfirmation: false,
        confirmTimeOut: false
      });
      synced += 1;
    } catch (err) {
      if (isNetworkError(err)) {
        remaining.push(item, ...queue.slice(queue.indexOf(item) + 1));
        break;
      }
      // Invalid QR codes or completed attendance responses should not block the queue forever.
      synced += 1;
    }
  }

  writeQueue(remaining);
  return { success: true, synced, remaining: remaining.length };
}

function broadcastQueueStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('queue:status', { queuedCount: readQueue().length });
  }
}

ipcMain.handle('settings:get', async () => {
  const settings = loadSettings();
  const loginSettings = app.getLoginItemSettings();
  return { settings, queuedCount: readQueue().length, autoStartEnabled: !!loginSettings.openAtLogin };
});

ipcMain.handle('settings:save', async (_event, nextSettings) => {
  return saveSettings(nextSettings || {});
});

ipcMain.handle('connection:check', async () => {
  try {
    const data = await refreshDesktopConfig();
    return { online: true, message: 'Connected to Railway server.', config: data, queuedCount: readQueue().length };
  } catch (err) {
    return { online: false, message: isNetworkError(err) ? NO_INTERNET_MESSAGE : err.message, queuedCount: readQueue().length };
  }
});

ipcMain.handle('scan:submit', async (_event, payload) => submitScan(payload));
ipcMain.handle('queue:sync', async () => syncOfflineQueue());
ipcMain.handle('queue:get', async () => readQueue());
ipcMain.handle('app:fullscreen', async () => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});
ipcMain.handle('app:minimize', async () => { if (mainWindow) mainWindow.hide(); });
ipcMain.handle('app:open-external', async (_event, url) => shell.openExternal(url));
ipcMain.handle('app:show-error', async (_event, message) => dialog.showErrorBox('Edutrack Scanner', String(message || 'Unknown error')));

app.whenReady().then(() => {
  app.setAppUserModelId('ph.gov.sipalay.edutrack.scanner');
  ensureUserDataDir();
  const settings = loadSettings();
  configureAutoStart(settings.autoStart);
  createWindow();
  createTray();
  setInterval(() => syncOfflineQueue().catch(() => {}), 20000);
  setInterval(() => broadcastQueueStatus(), 5000);
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  showWindow();
});
