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
    if (window.EduTrackNative && typeof window.EduTrackNative.notify === 'function') {
      window.EduTrackNative.notify(title, body);
      return;
    }

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

  function isMobileAppShell() {
    return document.body.classList.contains('android-app-webview') ||
      document.body.classList.contains('edutrack-mobile-app') ||
      /SchoolAttendanceAndroidWebView/i.test(navigator.userAgent);
  }

  function isDashboardPage() {
    return !!document.getElementById('statsGrid') && !!document.getElementById('schoolBreakdownBody');
  }

  function text(id) {
    var el = document.getElementById(id);
    return el ? el.textContent.trim() : '0';
  }

  function numberFromText(value) {
    var n = parseFloat(String(value || '0').replace(/[^0-9.]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  function appPath(path) {
    return path + (path.indexOf('?') === -1 ? '?app=1' : '&app=1');
  }

  function installBottomNavigation() {
    if (!isMobileAppShell() || document.querySelector('.mobile-bottom-nav')) return;

    var nav = document.createElement('nav');
    nav.className = 'mobile-bottom-nav';
    nav.innerHTML =
      '<a href="' + appPath('/admin/dashboard') + '" class="active"><i class="fa-solid fa-chart-pie"></i><span>Dashboard</span></a>' +
      '<a href="' + appPath('/admin/attendance') + '"><i class="fa-solid fa-clipboard-list"></i><span>Attendance</span></a>' +
      '<a href="' + appPath('/admin/schools') + '"><i class="fa-solid fa-building-columns"></i><span>Schools</span></a>' +
      '<a href="' + appPath('/admin/reports') + '"><i class="fa-solid fa-file-lines"></i><span>Reports</span></a>' +
      '<button type="button" id="mobileMenuButton"><i class="fa-solid fa-grip"></i><span>Menu</span></button>';
    document.body.appendChild(nav);

    var menu = document.createElement('div');
    menu.className = 'mobile-menu-panel';
    var links = Array.prototype.slice.call(document.querySelectorAll('.sidebar .nav-links a'));
    menu.innerHTML =
      '<div class="mobile-menu-head"><strong>EduTrack Menu</strong><button type="button" id="mobileMenuClose"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<div class="mobile-menu-links">' +
      links.map(function(a) {
        return '<a href="' + appPath(a.getAttribute('href')) + '">' + a.innerHTML + '</a>';
      }).join('') +
      '<a href="/change-password?app=1"><i class="fa-solid fa-key"></i> Password</a>' +
      '<a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>' +
      '</div>';
    document.body.appendChild(menu);

    document.getElementById('mobileMenuButton').addEventListener('click', function() {
      menu.classList.add('open');
    });
    document.getElementById('mobileMenuClose').addEventListener('click', function() {
      menu.classList.remove('open');
    });
  }

  function ensureMobileDashboardShell() {
    if (!isMobileAppShell() || !isDashboardPage()) return;
    document.body.classList.add('mobile-dashboard-mode');
    if (document.querySelector('.mobile-dashboard-shell')) return;

    var page = document.querySelector('.page-content');
    var toolbar = document.querySelector('.dashboard-toolbar');
    if (!page || !toolbar) return;

    var shell = document.createElement('section');
    shell.className = 'mobile-dashboard-shell';
    shell.innerHTML =
      '<div class="mobile-dash-profile">' +
      '<div><span id="mobileGreeting">Good Day</span><strong id="mobileUserName">Dashboard</strong><small>Division-Level Monitoring</small></div>' +
      '<button type="button" id="mobileRefreshButton"><i class="fa-solid fa-rotate"></i></button>' +
      '</div>' +
      '<div class="mobile-live-row"><span><i class="fa-solid fa-bolt"></i> Real-time</span><span id="mobileLiveDate"></span><button type="button" id="mobileTestNotify"><i class="fa-solid fa-bell"></i> Test</button></div>' +
      '<div class="mobile-attendance-card">' +
      '<div class="mobile-ring" style="--p:0"><div><strong id="mobileRate">0%</strong><span>ATTENDANCE</span></div></div>' +
      '<p id="mobilePresentSummary">Loading attendance...</p>' +
      '</div>';
    toolbar.parentNode.insertBefore(shell, toolbar);

    document.getElementById('mobileRefreshButton').addEventListener('click', function() {
      window.dispatchEvent(new Event('edutrack-force-refresh'));
    });
    document.getElementById('mobileTestNotify').addEventListener('click', function() {
      notify('Notification test successful', 'EduTrack mobile notifications are working on this phone.');
    });
    updateMobileDashboardShell();
  }

  function updateMobileDashboardShell() {
    if (!isMobileAppShell() || !isDashboardPage()) return;
    var rate = numberFromText(text('statRate'));
    var present = text('statPresent');
    var students = text('statStudents');
    var nameEl = document.querySelector('.topbar-user-details strong') || document.querySelector('.user-details strong');
    var userName = nameEl ? nameEl.textContent.trim() : 'Dashboard';
    var hour = new Date().getHours();
    var greeting = hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening';

    var ring = document.querySelector('.mobile-ring');
    if (ring) ring.style.setProperty('--p', Math.max(0, Math.min(100, rate)));
    var rateEl = document.getElementById('mobileRate');
    if (rateEl) rateEl.textContent = rate + '%';
    var presentEl = document.getElementById('mobilePresentSummary');
    if (presentEl) presentEl.textContent = present + ' of ' + students + ' students present';
    var gEl = document.getElementById('mobileGreeting');
    if (gEl) gEl.textContent = greeting;
    var uEl = document.getElementById('mobileUserName');
    if (uEl) uEl.textContent = userName;
    var dEl = document.getElementById('mobileLiveDate');
    if (dEl) dEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function watchMobileDashboardValues() {
    if (!isMobileAppShell() || !isDashboardPage() || window.__mobileDashboardObserver) return;
    var target = document.getElementById('statsGrid');
    if (!target) return;
    window.__mobileDashboardObserver = new MutationObserver(updateMobileDashboardShell);
    window.__mobileDashboardObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }

  function startMobileRealtimePoll() {
    if (!isMobileAppShell() || !isDashboardPage() || window.__mobileRealtimeStarted) return;
    window.__mobileRealtimeStarted = true;
    var currentHash = '';
    var refreshing = false;

    async function refreshDashboard() {
      if (refreshing) return;
      refreshing = true;
      try {
        var dateEl = document.getElementById('dashDate');
        var schoolEl = document.getElementById('dashSchool');
        var params = new URLSearchParams({ date: dateEl ? dateEl.value : new Date().toISOString().slice(0, 10) });
        if (schoolEl && schoolEl.value) params.append('school', schoolEl.value);
        var res = await fetch('/api/dashboard-data?' + params, { credentials: 'same-origin' });
        if (!res.ok) return;
        var data = await res.json();
        applyDashboardData(data);
        updateMobileDashboardShell();
      } finally {
        refreshing = false;
      }
    }

    async function poll() {
      try {
        var schoolEl = document.getElementById('dashSchool');
        var params = new URLSearchParams({ hash: currentHash });
        if (schoolEl && schoolEl.value) params.append('school', schoolEl.value);
        var res = await fetch('/api/realtime-poll?' + params, { credentials: 'same-origin' });
        if (res.ok) {
          var data = await res.json();
          if (data.changed || !currentHash) {
            currentHash = data.hash || currentHash;
            await refreshDashboard();
            checkAbsenceFlagsAndNotify();
          } else {
            currentHash = data.hash || currentHash;
          }
        }
      } catch (_) {}
      setTimeout(poll, 3000);
    }

    window.addEventListener('edutrack-force-refresh', refreshDashboard);
    refreshDashboard();
    poll();
  }

  function set(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function applyDashboardData(data) {
    set('statSchools', data.total_schools);
    set('statStudents', data.active_students || data.total_students || 0);
    set('statPresent', data.students_present);
    set('statAbsent', data.students_absent);
    set('statRate', data.attendance_rate + '%');
    set('saWbRate', data.attendance_rate + '%');
    set('statTeachers', data.teachers_present);
    set('statTimedOut', data.students_timed_out || 0);
    set('statFlagged', data.flagged_absent_2day || 0);
    set('statInactive', data.inactive_students || 0);

    var banner = document.getElementById('nonSchoolDayBanner');
    var bannerText = document.getElementById('nonSchoolDayText');
    if (banner && bannerText) {
      if (!data.is_school_day) {
        bannerText.textContent = 'No classes due to ' + ((data.non_school_day_reason || data.non_school_day_type || 'non-school day') + '.').toLowerCase();
        banner.style.display = 'flex';
      } else {
        banner.style.display = 'none';
      }
    }

    var tbody = document.getElementById('schoolBreakdownBody');
    if (tbody && Array.isArray(data.schools)) {
      tbody.innerHTML = data.schools.map(function(s) {
        return '<tr><td><strong>' + s.name + '</strong></td><td>' + s.enrollment + '</td><td>' + s.present + '</td><td>' + s.absent + '</td><td>' + s.rate + '%</td><td>' + s.teachers_present + '/' + s.teachers_total + '</td><td>' + s.teacher_rate + '%</td></tr>';
      }).join('');
    }
  }

  function enhanceMobileApp() {
    if (!isMobileAppShell()) return;
    installBottomNavigation();
    ensureMobileDashboardShell();
    watchMobileDashboardValues();
    startMobileRealtimePoll();
    updateMobileDashboardShell();
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
    enhanceMobileApp();

    setTimeout(function () {
      ensureNotificationPermission();
      checkAbsenceFlagsAndNotify();
      enhanceMobileApp();
    }, 1500);

    setInterval(checkAbsenceFlagsAndNotify, CHECK_MS);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkAbsenceFlagsAndNotify();
    });
    window.addEventListener('focus', checkAbsenceFlagsAndNotify);
    window.addEventListener('edutrack-mobile-ready', enhanceMobileApp);
    window.addEventListener('pageshow', enhanceMobileApp);
  }

  initMobileAppFeatures();
})();
