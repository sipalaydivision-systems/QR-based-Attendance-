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

  var SHS_STUDENT = {
    name: 'Wesley Hans Platil',
    type: 'student',
    category: 'shs_student',
    school: 'Sipalay City National High School',
    lrn: '117359',
    grade: 'Grade 11',
    section: 'STEM - Rizal',
    grade_section: 'Grade 11 - STEM - Rizal'
  };

  var TEACHER = {
    name: 'Maria Santos',
    type: 'teacher',
    school: 'Agripino Elementary School',
    employee_id: 'T-0042',
    grade: 'Grade 6',
    section: 'Sampaguita'
  };

  var SHS_TEACHER = {
    name: 'Ricardo Dalisay',
    type: 'teacher',
    category: 'shs_teacher',
    school: 'Sipalay City National High School',
    employee_id: 'T-0088',
    grade: 'Grade 11',
    section: 'STEM - Rizal'
  };

  var SAMPLE_SCANS = [
    { name: 'Juan Dela Cruz',        personType: 'student', category: '',            gradeLevel: 'Grade 3',  sectionName: 'Apple',       schoolName: 'Agripino Elementary School',      scanTime: new Date().toISOString(), eventAction: 'TIME_IN',  attendanceStatus: 'present', displayStatus: 'TIME IN' },
    { name: 'Wesley Hans Platil',    personType: 'student', category: 'shs_student', gradeLevel: 'Grade 11', sectionName: 'STEM - Rizal',schoolName: 'Sipalay City National High School',scanTime: new Date().toISOString(), eventAction: 'TIME_IN',  attendanceStatus: 'late',    displayStatus: 'LATE TIME IN' },
    { name: 'Mark Anthony Villamor', personType: 'student', category: '',            gradeLevel: 'Grade 4',  sectionName: 'Narra',       schoolName: 'Agripino Elementary School',      scanTime: new Date().toISOString(), eventAction: 'TIME_IN',  attendanceStatus: 'half_day', displayStatus: 'PM LATE TIME IN' },
    { name: 'Ana Liza Buenaventura', personType: 'teacher', category: '',            gradeLevel: 'Grade 6',  sectionName: 'Sampaguita',  schoolName: 'Agripino Elementary School',      scanTime: new Date().toISOString(), eventAction: 'TIME_IN',  attendanceStatus: 'present', displayStatus: 'PM TIME IN' },
    { name: 'Grace Padayhag',        personType: 'student', category: '',            gradeLevel: 'Grade 5',  sectionName: 'Mango',       schoolName: 'Agripino Elementary School',      scanTime: new Date().toISOString(), eventAction: 'TIME_OUT', attendanceStatus: 'half_day', displayStatus: 'EARLY OUT' },
    { name: 'Ricardo Dalisay',       personType: 'teacher', category: 'shs_teacher', gradeLevel: 'Grade 11', sectionName: 'STEM - Rizal',schoolName: 'Sipalay City National High School',scanTime: new Date().toISOString(), eventAction: 'TIME_IN',  attendanceStatus: 'present', displayStatus: 'RETURNED' },
    { name: 'Maria Santos',          personType: 'teacher', category: '',            gradeLevel: 'Grade 6',  sectionName: 'Sampaguita',  schoolName: 'Agripino Elementary School',      scanTime: new Date().toISOString(), eventAction: 'TIME_OUT', attendanceStatus: 'present', displayStatus: 'LUNCH OUT' },
    { name: 'Pedro Reyes',           personType: 'student', category: '',            gradeLevel: 'Grade 5',  sectionName: 'Mango',       schoolName: 'Agripino Elementary School',      scanTime: new Date().toISOString(), eventAction: 'TIME_OUT', attendanceStatus: 'present', displayStatus: 'COMPLETED' }
  ];

  var SETTINGS = {
    serverUrl:                 'https://sdo-sipalay-edutrack.up.railway.app',
    scannerMode:               'usb',
    selectedSchoolId:          '1',
    duplicateIntervalSeconds:  5,
    autoStart:                 false,
    startFullscreen:           false,
    minimizeToTray:            false,
    offlineSync:               true,
    divisionName:              'Schools Division of Sipalay City',
    schools:                   [
      { id: 1, name: 'Agripino Elementary School', logo: null },
      { id: 2, name: 'Canturay Elementary School', logo: null },
      { id: 3, name: 'Sipalay City National High School', logo: null }
    ]
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
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', status: 'present', display_status: 'TIME IN', message: 'Time in recorded.', person: STUDENT, time: now, time_in: now });
    },
    function () {
      var now = _time();
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', status: 'present', display_status: 'TIME IN', message: 'Time in recorded.', person: SHS_STUDENT, time: now, time_in: now });
    },
    function () {
      var now = _time();
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', status: 'present', display_status: 'TIME IN', message: 'Time in recorded.', person: TEACHER, time: now, time_in: now });
    },
    function () {
      var now = _time();
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', status: 'present', display_status: 'TIME IN', message: 'Time in recorded.', person: SHS_TEACHER, time: now, time_in: now });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', status: 'late', display_status: 'LATE TIME IN', message: 'Late time in recorded.', person: STUDENT, time: _time(), time_in: _time() });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_OUT', status: 'present', display_status: 'EARLY OUT', message: 'Early out recorded. Scan again if you return before the session ends.', person: STUDENT, time: _time(), time_in: '07:30 AM', time_out: _time() });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', status: 'present', display_status: 'RETURNED', message: 'Return time in recorded. Welcome back!', person: STUDENT, time: _time(), time_in: _time(), time_out: '09:15 AM' });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_OUT', status: 'present', display_status: 'LUNCH OUT', message: 'Lunch time out recorded. Scan again when you return.', person: STUDENT, time: _time(), time_in: '07:30 AM', time_out: _time() });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_OUT', status: 'half_day', attendance_status: 'Half-Day', half_day_type: 'am_only', remarks: 'Morning Session Only', display_status: 'LUNCH OUT', message: 'Time out recorded - marked as HALF-DAY (Morning Session Only).', person: STUDENT, time: _time(), time_in: '07:00 AM', time_out: '11:30 AM' });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', status: 'present', display_status: 'PM TIME IN', message: 'PM time in recorded.', person: TEACHER, time: _time(), time_in: _time(), time_out: '11:35 AM' });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_OUT', status: 'half_day', attendance_status: 'Half-Day', half_day_type: 'pm_only', remarks: 'Afternoon Session Only', display_status: 'COMPLETED', message: 'PM time out recorded - marked as HALF-DAY (Afternoon Session Only).', person: SHS_STUDENT, time: _time(), time_in: '01:00 PM', time_out: '04:00 PM' });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_OUT', status: 'half_day', attendance_status: 'Half-Day PM Early Dismissal', half_day_type: 'pm_early_out', remarks: 'Early Dismissal During PM Session', display_status: 'EARLY OUT', message: 'Half-Day PM Early Dismissal recorded.', person: SHS_TEACHER, time: _time(), time_in: '07:20 AM', time_out: '02:00 PM' });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_OUT', status: 'present', display_status: 'COMPLETED', completed: true, message: 'Time out recorded - attendance for today is complete.', person: TEACHER, time: _time(), time_in: '01:00 PM', time_out: _time() });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: false, error: 'QR code not found in the system. Make sure the student or teacher record is active.', person: null });
    },
    function () {
      return Object.assign({}, BASE_STATUS, { success: true, action: 'TIME_IN', offline: true, status: 'present', display_status: 'PRESENT', message: 'Saved offline — will sync when connected.', person: STUDENT, time: _time(), time_in: _time() });
    }
  ];

  var _demoIdx = 0;

  function _time() {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  function _halfDayDemo(kind) {
    if (kind === 'half-day-pm') {
      return Object.assign({}, BASE_STATUS, {
        success: true,
        action: 'TIME_OUT',
        status: 'half_day',
        attendance_status: 'Half-Day',
        half_day_type: 'pm_only',
        remarks: 'Afternoon Session Only',
        display_status: 'COMPLETED',
        message: 'PM time out recorded - marked as HALF-DAY (Afternoon Session Only).',
        person: SHS_STUDENT,
        time: '04:00 PM',
        time_in: '01:00 PM',
        time_out: '04:00 PM'
      });
    }
    if (kind === 'half-day-early') {
      return Object.assign({}, BASE_STATUS, {
        success: true,
        action: 'TIME_OUT',
        status: 'half_day',
        attendance_status: 'Half-Day',
        half_day_type: 'early_dismissal',
        remarks: 'Official Early Dismissal',
        display_status: 'OUT',
        message: 'Time out recorded - marked as HALF-DAY (Official Early Dismissal).',
        person: SHS_TEACHER,
        time: '02:00 PM',
        time_in: '07:20 AM',
        time_out: '02:00 PM'
      });
    }
    return Object.assign({}, BASE_STATUS, {
      success: true,
      action: 'TIME_OUT',
      status: 'half_day',
      attendance_status: 'Half-Day',
      half_day_type: 'am_only',
      remarks: 'Morning Session Only',
      display_status: 'LUNCH OUT',
      message: 'Time out recorded - marked as HALF-DAY (Morning Session Only).',
      person: STUDENT,
      time: '11:30 AM',
      time_in: '07:00 AM',
      time_out: '11:30 AM'
    });
  }

  function _autoShowDemoFromUrl() {
    var params = new URLSearchParams(window.location.search || '');
    var demo = params.get('demo');
    if (!/^half-day-(am|pm|early)$/.test(demo || '')) return;

    var attempts = 0;
    function showWhenReady() {
      attempts++;
      if (typeof window.showScanFeedback === 'function') {
        var result = _halfDayDemo(demo);
        result.preview_sticky = params.get('sticky') !== '0';
        window.showScanFeedback('Half-day attendance recorded', result.message, 'warning', result);
        return;
      }
      if (attempts < 40) setTimeout(showWhenReady, 150);
    }
    setTimeout(showWhenReady, 500);
  }

  /* ── Mock API ── */
  window.edutrack = {
    adminLogin: async function (creds) {
      if (!creds.username || !creds.password) return { success: false, error: 'Username and password are required.' };
      if (creds.username === 'admin' && creds.password === 'admin') {
        return { success: true, admin: { id: 1, username: 'admin', fullname: 'Preview Administrator', role: 'super_admin', school_id: null } };
      }
      return { success: false, error: 'Invalid username or password.' };
    },
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
  window.addEventListener('load', _autoShowDemoFromUrl);
})();
