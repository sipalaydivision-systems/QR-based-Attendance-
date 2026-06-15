(function () {
  var STORAGE_KEY = 'qr_absence_notified_v1';
  var CHECK_MS = 60000;
  var permissionAsked = false;

  if (new URLSearchParams(window.location.search).get('app') === '1' ||
      /SchoolAttendanceAndroidWebView/i.test(navigator.userAgent)) {
    document.body.classList.add('edutrack-mobile-app');
  }

  function localDateString(date) {
    var d = date || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function getTodayKey() {
    return localDateString();
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

  async function notify(title, body, extra) {
    extra = extra || {};
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
          tag: extra.tag || 'absence-2day-alert',
          renotify: true,
          data: extra.data || {},
          actions: extra.actions || []
        });
        return;
      }
    }
    new Notification(title, {
      body: body,
      icon: '/uploads/logos/system-logo.png'
    });
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

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getMobileUserName() {
    var el = document.querySelector('.topbar-user-details strong') ||
      document.querySelector('.sidebar-footer .user-details strong') ||
      document.querySelector('.user-details strong');
    return el ? el.textContent.trim() : 'hans';
  }

  function brandInfo() {
    var logo = document.querySelector('.sidebar-brand img');
    var title = document.querySelector('.brand-title');
    var subtitle = document.querySelector('.brand-subtitle');
    return {
      logo: logo ? logo.getAttribute('src') : '/uploads/logos/system-logo.png',
      title: title ? title.textContent.trim() : 'Edutrack',
      subtitle: subtitle ? subtitle.textContent.trim() : 'Schools Division of Sipalay City'
    };
  }

  function pageKey() {
    var path = window.location.pathname;
    if (/\/admin\/attendance/.test(path)) return 'attendance';
    if (/\/admin\/schools|\/admin\/school\//.test(path)) return 'schools';
    if (/\/admin\/reports/.test(path)) return 'reports';
    if (/\/admin\/notifications/.test(path)) return 'alerts';
    return 'home';
  }

  function dashboardHref() {
    var link = document.querySelector('.nav-links a[href*="dashboard"]');
    return link ? link.getAttribute('href') : '/admin/dashboard';
  }

  function mobileDateParts() {
    var d = new Date();
    return {
      chip: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      iso: localDateString(d),
      long: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    };
  }

  function liveParams(base) {
    var params = base || new URLSearchParams();
    params.set('_', String(Date.now()));
    return params;
  }

  function installBottomNavigation() {
    if (!isMobileAppShell() || document.querySelector('.mobile-bottom-nav')) return;

    var active = pageKey();
    var reportsHref = document.querySelector('.nav-links a[href="/admin/reports"]')
      ? '/admin/reports'
      : '/admin/sf2-report';
    function item(key, href, icon, label, hasDot) {
      return '<a href="' + appPath(href) + '" class="' + (active === key ? 'active' : '') + '">' +
        '<span class="mobile-nav-icon"><i class="fa-solid ' + icon + '"></i>' + (hasDot ? '<b id="mobileAlertDot"></b>' : '') + '</span>' +
        '<span>' + label + '</span></a>';
    }

    var nav = document.createElement('nav');
    nav.className = 'mobile-bottom-nav';
    nav.innerHTML =
      item('home', dashboardHref(), 'fa-house', 'Home') +
      item('attendance', '/admin/attendance', 'fa-calendar-check', 'Attendance') +
      item('schools', '/admin/schools', 'fa-building-columns', 'Schools') +
      item('reports', reportsHref, 'fa-chart-simple', 'Report') +
      item('alerts', '/admin/notifications', 'fa-bell', 'Alerts', true);
    document.body.appendChild(nav);
  }

  function ensureMobileTopChrome() {
    if (!isMobileAppShell() || document.querySelector('.mobile-app-top')) return;
    var content = document.querySelector('.content');
    var page = document.querySelector('.page-content');
    if (!content || !page) return;

    var brand = brandInfo();
    var dates = mobileDateParts();
    var top = document.createElement('section');
    top.className = 'mobile-app-top';
    top.innerHTML =
      '<div class="mobile-brand-row">' +
        '<div class="mobile-brand-logo"><img src="' + escapeHtml(brand.logo) + '" alt=""></div>' +
        '<div class="mobile-brand-copy"><strong>' + escapeHtml(brand.title || 'Edutrack') + '</strong><span>' + escapeHtml(brand.subtitle || 'Schools Division of Sipalay City') + '</span></div>' +
        '<a href="' + appPath('/admin/notifications') + '" class="mobile-bell" aria-label="Alerts"><i class="fa-regular fa-bell"></i><b></b></a>' +
      '</div>' +
      '<div class="mobile-chip-row">' +
        '<span class="mobile-chip live"><i></i> LIVE</span>' +
        '<span class="mobile-chip"><i class="fa-regular fa-calendar-days"></i> <b id="mobileTopDate">' + escapeHtml(dates.chip) + '</b></span>' +
        '<span class="mobile-chip"><i class="fa-regular fa-calendar"></i> <b id="mobileTopIso">' + escapeHtml(dates.iso) + '</b></span>' +
      '</div>';
    content.insertBefore(top, page);
  }

  function ensureMobilePageIntro() {
    if (!isMobileAppShell() || isDashboardPage() || document.querySelector('.mobile-page-intro')) return;
    var page = document.querySelector('.page-content');
    if (!page) return;
    var meta = {
      attendance: ['Attendance', 'Live daily scan records', 'fa-calendar-check'],
      schools: ['Schools', 'School profiles and counts', 'fa-building-columns'],
      reports: ['Report', 'Attendance summaries and trends', 'fa-chart-simple'],
      alerts: ['Alerts', '2-day absence flags and activity', 'fa-bell'],
      home: ['EduTrack', 'Mobile monitoring dashboard', 'fa-house']
    }[pageKey()];

    var intro = document.createElement('section');
    intro.className = 'mobile-page-intro';
    intro.innerHTML =
      '<div class="mobile-page-intro-icon"><i class="fa-solid ' + meta[2] + '"></i></div>' +
      '<div><span>' + escapeHtml(meta[1]) + '</span><strong>' + escapeHtml(meta[0]) + '</strong></div>';
    page.insertBefore(intro, page.firstChild);
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
      '<div class="mobile-greeting-card">' +
        '<div class="mobile-greeting-copy">' +
          '<span id="mobileGreeting">Good afternoon</span>' +
          '<strong id="mobileUserName">Dashboard</strong>' +
          '<small id="mobileLongDate">Monday, June 8, 2026</small>' +
        '</div>' +
        '<div class="mobile-school-art" aria-hidden="true"><i class="fa-solid fa-school"></i><b></b><em></em></div>' +
        '<div class="mobile-kpi-row">' +
          '<div class="mobile-kpi green"><i class="fa-solid fa-users"></i><strong id="mobileMetricStudents">0</strong><span>Students</span></div>' +
          '<div class="mobile-kpi blue"><i class="fa-solid fa-graduation-cap"></i><strong id="mobileMetricTeachers">0</strong><span>Teachers</span></div>' +
          '<div class="mobile-kpi red"><i class="fa-solid fa-triangle-exclamation"></i><strong id="mobileMetricFlagged">0</strong><span>2-Day<br>Flagged Students</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="mobile-analytics-card">' +
        '<div class="mobile-card-title"><span><i class="fa-solid fa-chart-line"></i></span><strong>Today Analytics</strong></div>' +
        '<div class="mobile-analytics-body">' +
          '<div class="mobile-ring" style="--p:0"><div><strong id="mobileRate">0%</strong><span>ATTENDANCE</span></div></div>' +
          '<div class="mobile-analytics-copy">' +
            '<div class="mobile-excellent"><i class="fa-regular fa-star"></i><span id="mobileRateBadge">Excellent Attendance</span></div>' +
            '<div class="mobile-ana-line"><i class="fa-solid fa-user-group"></i><p><strong id="mobilePresentSummary">0 of 0 students</strong><span>present</span></p></div>' +
            '<div class="mobile-live-meter"><div><span>Live Attendance</span><strong id="mobileRateInline">0%</strong></div><b><i id="mobileRateBar"></i></b></div>' +
            '<div class="mobile-ana-line muted"><i class="fa-solid fa-user"></i><p><strong id="mobileAbsentSummary">0 students absent</strong></p></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mobile-status-row">' +
        '<a href="' + appPath('/admin/attendance') + '" class="mobile-status-card present"><i class="fa-solid fa-user"></i><p><strong id="mobilePresentQuick">0</strong><span>Present</span></p><em class="fa-solid fa-chevron-right"></em></a>' +
        '<a href="' + appPath('/admin/notifications') + '" class="mobile-status-card absent"><i class="fa-solid fa-user"></i><p><strong id="mobileAbsentQuick">0</strong><span>Absent</span></p><em class="fa-solid fa-chevron-right"></em></a>' +
      '</div>';
    toolbar.parentNode.insertBefore(shell, toolbar);
    updateMobileDashboardShell();
  }

  function updateMobileDashboardShell() {
    if (!isMobileAppShell() || !isDashboardPage()) return;
    var rate = numberFromText(text('statRate'));
    var present = text('statPresent');
    var students = text('statStudents');
    var absent = text('statAbsent');
    var teachers = text('statTeachers');
    var flagged = text('statFlagged');
    var displayName = getMobileUserName();
    var hour = new Date().getHours();
    var greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    var dates = mobileDateParts();

    var ring = document.querySelector('.mobile-ring');
    if (ring) ring.style.setProperty('--p', Math.max(0, Math.min(100, rate)));
    var rateEl = document.getElementById('mobileRate');
    if (rateEl) rateEl.textContent = rate + '%';
    set('mobileRateInline', rate + '%');
    set('mobileRateBadge', rate >= 95 ? 'Excellent Attendance' : rate >= 80 ? 'Strong Attendance' : rate >= 50 ? 'Needs Monitoring' : 'Attendance Alert');
    var rateBar = document.getElementById('mobileRateBar');
    if (rateBar) rateBar.style.width = Math.max(0, Math.min(100, rate)) + '%';
    var presentEl = document.getElementById('mobilePresentSummary');
    if (presentEl) presentEl.textContent = present + ' of ' + students + ' students';
    set('mobileAbsentSummary', absent + ' students absent');
    set('mobileMetricStudents', students);
    set('mobileMetricTeachers', teachers);
    set('mobileMetricFlagged', flagged);
    set('mobilePresentQuick', present);
    set('mobileAbsentQuick', absent);
    var gEl = document.getElementById('mobileGreeting');
    if (gEl) gEl.textContent = greeting;
    var uEl = document.getElementById('mobileUserName');
    if (uEl) uEl.textContent = displayName;
    set('mobileLongDate', dates.long);
    set('mobileTopDate', dates.chip);
    set('mobileTopIso', dates.iso);
    var dot = document.getElementById('mobileAlertDot');
    if (dot) dot.style.display = numberFromText(flagged) > 0 ? 'block' : 'none';
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
        var params = liveParams(new URLSearchParams({ date: dateEl ? dateEl.value : localDateString() }));
        if (schoolEl && schoolEl.value) params.append('school', schoolEl.value);
        var res = await fetch('/api/dashboard-data?' + params, { credentials: 'same-origin', cache: 'no-store' });
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
        var params = liveParams(new URLSearchParams({ hash: currentHash }));
        if (schoolEl && schoolEl.value) params.append('school', schoolEl.value);
        var res = await fetch('/api/realtime-poll?' + params, { credentials: 'same-origin', cache: 'no-store' });
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
    set('statHalfDay', data.students_half_day || 0);
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
        return '<tr><td><strong>' + s.name + '</strong></td><td>' + s.enrollment + '</td><td>' + s.present + '</td><td>' + (s.late || 0) + '</td><td>' + (s.half_day || 0) + '</td><td>' + s.absent + '</td><td>' + s.rate + '%</td><td>' + s.teachers_present + '/' + s.teachers_total + '</td><td>' + s.teacher_rate + '%</td></tr>';
      }).join('');
    }
  }

  function enhanceMobileApp() {
    if (!isMobileAppShell()) return;
    document.body.classList.add('mobile-route-' + pageKey());
    ensureMobileTopChrome();
    installBottomNavigation();
    ensureMobilePageIntro();
    ensureMobileDashboardShell();
    watchMobileDashboardValues();
    startMobileRealtimePoll();
    updateMobileDashboardShell();
  }

  async function checkAbsenceFlagsAndNotify() {
    try {
      var schoolEl = document.getElementById('dashSchool');
      var dateEl = document.getElementById('dashDate');
      var params = liveParams(new URLSearchParams({ days: '2', date: dateEl ? dateEl.value : localDateString() }));
      if (schoolEl && schoolEl.value) params.append('school', schoolEl.value);
      var res = await fetch('/api/absence-flags?' + params, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      var flags = await res.json();
      if (!Array.isArray(flags) || !flags.length) return;

      var today = getTodayKey();
      var notifiedMap = loadNotifiedMap();
      if (!notifiedMap[today]) notifiedMap[today] = {};

      var newlyFlagged = [];
      for (var i = 0; i < flags.length; i++) {
        var st = flags[i];
        var fingerprint = [
          st.name,
          st.firstname,
          st.lastname,
          st.lrn,
          st.grade_name,
          st.section_name,
          st.school_name,
          st.adviser,
          st.adviser_contact,
          st.adviser_email,
          st.school_contact,
          st.absent_days || 2
        ].map(function(v) { return String(v || '').trim(); }).join('|');
        var key = String(st.person_type || 'student') + '|' + String(st.id || '') + '|' + fingerprint;
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
        var gradeSection = (sample.grade_name || '-') + ' / ' + (sample.section_name || '-');
        var lrn = sample.lrn || '-';
        var days = sample.absent_days || 2;
        var adviser = sample.adviser || 'Assigned adviser';
        var detail = studentName + ' | ' + gradeSection + ' | LRN ' + lrn + ' | ' + days + ' days absent';
        var msg = newlyFlagged.length === 1
          ? detail
          : (newlyFlagged.length + ' students flagged. First: ' + detail);
        var contact = (sample.adviser_contact || sample.adviser_email || sample.school_contact || '').trim();
        var contactUrl = '';
        if (contact && /@/.test(contact)) {
          contactUrl = 'mailto:' + encodeURIComponent(contact) + '?subject=' + encodeURIComponent('Absence Alert - ' + studentName) + '&body=' + encodeURIComponent('Please check absence alert for ' + studentName + ' (' + gradeSection + ', LRN: ' + lrn + ', ' + days + ' days absent). Adviser: ' + adviser + '.');
        } else if (contact) {
          var digits = contact.replace(/[^0-9+]/g, '');
          if (digits) {
            contactUrl = 'sms:' + encodeURIComponent(digits) + '?body=' + encodeURIComponent('Please check absence alert for ' + studentName + ' (' + gradeSection + ', LRN: ' + lrn + ', ' + days + ' days absent). Adviser: ' + adviser + '.');
          }
        }
        notify('2-Day Absence Alert', msg, {
          tag: 'absence-2day-alert',
          data: { url: '/admin/notifications?app=1', contactUrl: contactUrl },
          actions: [{ action: 'contact-adviser', title: 'Please contact adviser' }]
        });
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
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', function (event) {
        var payload = event && event.data ? event.data : {};
        if (payload.type === 'edutrack-open-url' && payload.url) {
          window.location.href = payload.url;
        }
      });
    }
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
