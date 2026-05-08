(function () {
  var STORAGE_KEY = 'qr_absence_notified_v1';
  var CHECK_MS = 60000;
  var permissionAsked = false;

  function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function loadNotifiedMap() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function saveNotifiedMap(map) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  async function ensureNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    if (permissionAsked) return false;
    permissionAsked = true;
    var result = await Notification.requestPermission();
    return result === 'granted';
  }

  async function notify(title, body) {
    var canNotify = await ensureNotificationPermission();
    if (!canNotify) return;

    if ('serviceWorker' in navigator) {
      var reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.showNotification(title, {
          body: body,
          icon: '/uploads/logos/system-logo.png',
          badge: '/uploads/logos/system-logo.png',
          tag: 'absence-2day-alert',
          renotify: true
        });
        return;
      }
    }

    new Notification(title, {
      body: body,
      icon: '/uploads/logos/system-logo.png'
    });
  }

  async function checkAbsenceFlagsAndNotify() {
    try {
      var res = await fetch('/api/absence-flags?days=2', { credentials: 'same-origin' });
      if (!res.ok) return;
      var flags = await res.json();
      if (!Array.isArray(flags) || !flags.length) return;

      var today = getTodayKey();
      var notifiedMap = loadNotifiedMap();
      if (!notifiedMap[today]) notifiedMap[today] = {};

      var newlyFlagged = [];
      for (var i = 0; i < flags.length; i++) {
        var st = flags[i];
        var key = String(st.id || '') + '|' + String(st.lrn || '') + '|' + String(st.absent_days || 2);
        if (!notifiedMap[today][key]) {
          notifiedMap[today][key] = 1;
          newlyFlagged.push(st);
        }
      }

      saveNotifiedMap(notifiedMap);

      if (newlyFlagged.length > 0) {
        var sample = newlyFlagged[0];
        var studentName = (sample.firstname && sample.lastname)
          ? (sample.lastname + ', ' + sample.firstname)
          : (sample.name || 'Student');
        var msg = newlyFlagged.length === 1
          ? (studentName + ' has reached 2-day absence.')
          : (newlyFlagged.length + ' students reached 2-day absence. First: ' + studentName + '.');
        notify('2-Day Absence Alert', msg);
      }
    } catch (_) {}
  }

  function cleanupOldDays() {
    var map = loadNotifiedMap();
    var today = getTodayKey();
    var keep = {};
    keep[today] = map[today] || {};
    saveNotifiedMap(keep);
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (_) {}
  }

  async function initMobileAppFeatures() {
    cleanupOldDays();
    await registerServiceWorker();

    setTimeout(function () {
      ensureNotificationPermission();
      checkAbsenceFlagsAndNotify();
    }, 1500);

    setInterval(checkAbsenceFlagsAndNotify, CHECK_MS);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkAbsenceFlagsAndNotify();
    });
    window.addEventListener('focus', checkAbsenceFlagsAndNotify);
  }

  initMobileAppFeatures();
})();
