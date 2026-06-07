/**
 * preview-stub.js
 * Mocks the window.edutrack Electron preload bridge so the renderer
 * can be previewed directly in a browser (without Electron running).
 * This file is loaded ONLY when window.edutrack is absent.
 */
(function () {
  if (window.edutrack) return; // Real Electron preload already present

  /* ── Sample data ── */
  var STUDENT = {
    name: 'Juan Dela Cruz',
    type: 'student',
    school: 'Agripino Elementary School',
    lrn: '117212',
    grade: 'Grade 3',
    section: 'Apple',
    grade_section: 'Grade 3 - Apple'
  };

  var TEACHER = {
    name: 'Maria Santos',
    type: 'teacher',
    school: 'Agripino Elementary School',
    employee_id: 'T-0042'
  };

  var SAMPLE_SCANS = [
    { name: 'Juan Dela Cruz',       gradeLevel: 'Grade 3', sectionName: 'Apple',    schoolName: 'Agripino Elementary School', scanTime: new Date().toISOString(), eventAction: 'TIME_IN'  },
    { name: 'Maria Santos',         gradeLevel: '',         sectionName: '',          schoolName: 'Agripino Elementary School', scanTime: new Date().toISOString(), eventAction: 'TIME_IN'  },
    { name: 'Pedro Reyes',          gradeLevel: 'Grade 5', sectionName: 'Mango',    schoolName: 'Agripino Elementary School', scanTime: new Date().toISOString(), eventAction: 'TIME_OUT' },
    { name: 'Ana Liza Buenaventura',gradeLevel: 'Grade 6', sectionName: 'Sampaguita',schoolName: 'Agripino Elementary School', scanTime: new Date().toISOString(), eventAction: 'TIME_IN'  },
    { name: 'Carlo Villanueva',     gradeLevel: 'Grade 4', sectionName: 'Rose',     schoolName: 'Agripino Elementary School', scanTime: new Date().toISOString(), eventAction: 'TIME_IN'  },
    { name: 'Rosa Fernandez',       gradeLevel: 'Grade 2', sectionName: 'Lily',     schoolName: 'Agripino Elementary School', scanTime: new Date().toISOString(), eventAction: 'TIME_IN'  }
  ];

  var SETTINGS = {
    serverUrl:                 'https://school-attendance-qrbased.up.railway.app',
    scannerMode:               'usb',
    selectedSchoolId:          '',
    duplicateIntervalSeconds:  5,
    autoStart:                 false,
    startFullscreen:           false,
    minimizeToTray:            false,
    offlineSync:               true,
    divisionName:              'Schools Division of Sipalay City',
    schools:                   []
  };

  var BASE_STATUS = {
    online:                 true,
    message:                'Connected — Preview Mode',
    settings:               SETTINGS,
    config:                 { settings: SETTINGS, summary: { todayScanCount: 3 } },
    queuedCount:            0,
    queuedTodayCount:       0,
    localTodayScanCount:    3,
    recentLocalScans:       SAMPLE_SCANS,
    recentSyncHistory:      [],
    totalSyncedRecords:     14,
    failedRecordsCount:     0,
    syncInProgress:         false,
    schoolDayStatus:        { isSchoolDay: true },
    autoStartEnabled:       false
  };

  /* Rotate through all possible result types for demo */
  var DEMO_ACTIONS = [
    function () {
      var now = _time();
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', status: 'present', message: 'Time in recorded successfully.', person: STUDENT, time: now, time_in: now });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', status: 'late', message: 'Time in recorded — student arrived late.', person: STUDENT, time: _time(), time_in: _time() });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_OUT', message: 'Time out recorded.', person: TEACHER, time: _time(), time_in: '07:30 AM', time_out: _time() });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'ALREADY_RECORDED', message: 'Already recorded for today.', person: STUDENT, time_in: '07:28 AM' });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'PENDING_TIME_OUT', message: 'Already timed in. End-of-day time out opens at 05:00:00 PM.', person: STUDENT, time_in: '07:30 AM' });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: false, error: 'QR code not found in the system. Make sure the student or teacher record is active.', person: null });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', offline: true, message: 'Saved offline — will sync when connected.', person: STUDENT, time: _time(), time_in: _time() });
    }
  ];

  var _demoIdx = 0;

  function _time() {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  }

  /* ── Mock API ── */
  window.edutrack = {
    submitScan: async function () {
      var result = DEMO_ACTIONS[_demoIdx % DEMO_ACTIONS.length]();
      _demoIdx++;
      return result;
    },
    checkConnection: async function () { return BASE_STATUS; },
    getSettings:     async function () { return BASE_STATUS; },
    saveSettings:    async function (s) { return Object.assign({}, SETTINGS, s); },
    syncQueue:       async function () { return BASE_STATUS; },
    onQueueStatus:   function ()       {},
    onScannerStatus: function ()       {},
    toggleFullscreen: function ()      {},
    minimize:         function ()      {}
  };

  /* Demo helper: press Space (when not in an input) to fire the next mock scan */
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space') return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    /* Directly trigger submitQrCode via the USB buffer mechanism */
    var fake = 'DEMO-QR-' + Date.now();
    var ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    /* Inject characters then Enter to go through the normal flow */
    fake.split('').forEach(function (ch) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

  /* Visual notice */
  var hint = document.createElement('div');
  hint.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:rgba(10,60,42,.88);color:#fff;font:700 12px/1.4 Segoe UI,sans-serif;padding:8px 18px;border-radius:20px;z-index:9999;pointer-events:none;letter-spacing:.4px;';
  hint.textContent = '⌨ PREVIEW MODE — press Space to demo a scan result';
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(hint); });
})();
