(function () {
  var STORAGE_KEY = 'qr_absence_notified_v1';
  var SCHOOL_ART_KEY = 'edutrack_mobile_dashboard_school_art';
  var SCHOOL_ART_VERSION_KEY = 'edutrack_mobile_dashboard_school_art_version';
  var CHECK_MS = 60000;
  var permissionAsked = false;
  var mobileSchoolArtData = '';
  var mobileSchoolArtVersion = '';

  try {
    mobileSchoolArtData = localStorage.getItem(SCHOOL_ART_KEY) || '';
    mobileSchoolArtVersion = localStorage.getItem(SCHOOL_ART_VERSION_KEY) || '';
  } catch (_) {}

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
      return true;
    }

    var canNotify = await ensureNotificationPermission();
    if (!canNotify) return false;

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
        return true;
      }
    }
    new Notification(title, {
      body: body,
      icon: '/uploads/logos/system-logo.png'
    });
    return true;
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

  function liveParams(base) {
    var params = base || new URLSearchParams();
    params.set('_', String(Date.now()));
    return params;
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
      '<div><span id="mobileGreetingTop">Good Day</span><strong id="mobileUserNameTop">Dashboard</strong><small>Division-Level Monitoring</small></div>' +
      '<button type="button" id="mobileRefreshButton"><i class="fa-solid fa-rotate"></i></button>' +
      '</div>' +
      '<div class="mobile-live-row"><span><i class="fa-solid fa-bolt"></i> Real-time</span><span id="mobileLiveDate"></span><button type="button" id="mobileTestNotify"><i class="fa-solid fa-bell"></i> Test</button></div>' +
      '<div class="mobile-greeting-card">' +
      '<div class="mobile-greeting-copy"><span id="mobileGreeting">Good day</span><strong id="mobileUserName">Dashboard</strong><small id="mobileFullDate"></small></div>' +
      '<div class="mobile-school-art" id="mobileSchoolArtBox"></div>' +
      '<div class="mobile-kpi-row">' +
      '<div class="mobile-kpi-pill students"><i class="fa-solid fa-users"></i><strong id="mobileStudentCount">0</strong><span>Students</span></div>' +
      '<div class="mobile-kpi-pill teachers"><i class="fa-solid fa-graduation-cap"></i><strong id="mobileTeacherCount">0</strong><span>Teachers</span></div>' +
      '<button type="button" class="mobile-kpi-pill flagged" id="mobileFlaggedButton"><i class="fa-solid fa-triangle-exclamation"></i><strong id="mobileFlaggedCount">0</strong><span>2-Day Flagged Students</span></button>' +
      '</div>' +
      '</div>' +
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
    var flaggedButton = document.getElementById('mobileFlaggedButton');
    if (flaggedButton) {
      flaggedButton.addEventListener('click', function() {
        window.location.href = appPath('/admin/notifications');
      });
    }
    applyMobileSchoolArt();
    updateMobileDashboardShell();
  }

  function mobileDefaultSchoolArtSvg() {
    return '<svg viewBox="0 0 210 132" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="School illustration">' +
      '<ellipse cx="110" cy="118" rx="78" ry="9" fill="#e7f7ed"/>' +
      '<path d="M19 92c9-13 21-18 36-14 7-17 26-28 45-22 9-16 32-21 49-9 9 6 14 15 15 25 12-2 23 3 29 12 6 9 6 20 0 30H24c-9-5-11-14-5-22z" fill="#eff9f5"/>' +
      '<circle cx="44" cy="84" r="20" fill="#66b77f"/>' +
      '<rect x="39" y="84" width="9" height="34" rx="4" fill="#1c7b5a"/>' +
      '<rect x="77" y="54" width="92" height="61" rx="6" fill="#7bc98d"/>' +
      '<path d="M68 57l56-33 56 33H68z" fill="#126d51"/>' +
      '<rect x="111" y="82" width="24" height="34" rx="4" fill="#126d51"/>' +
      '<rect x="88" y="74" width="19" height="21" rx="3" fill="#f7fff9"/>' +
      '<rect x="143" y="74" width="19" height="21" rx="3" fill="#f7fff9"/>' +
      '<circle cx="124" cy="51" r="15" fill="#f7fff9"/>' +
      '<path d="M124 42v9l7 4" fill="none" stroke="#7bc98d" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M124 25V6" stroke="#126d51" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="M127 7l24 8-24 9V7z" fill="#2fa760"/>' +
      '<ellipse cx="53" cy="18" rx="24" ry="8" fill="#e8f7ff"/>' +
      '<ellipse cx="177" cy="30" rx="21" ry="7" fill="#e8f7ff"/>' +
      '</svg>';
  }

  function applyMobileSchoolArt(src) {
    if (typeof src === 'string') mobileSchoolArtData = src;
    var box = document.getElementById('mobileSchoolArtBox');
    if (!box) return;
    var art = (mobileSchoolArtData || '').trim();
    if (art) {
      box.innerHTML = '<img src="' + art.replace(/"/g, '&quot;') + '" alt="School illustration">';
    } else {
      box.innerHTML = mobileDefaultSchoolArtSvg();
    }
  }

  async function syncMobileSchoolArt(dashboardData) {
    if (!isMobileAppShell() || !isDashboardPage()) return;
    var version = String((dashboardData && dashboardData.school_art_version) || '').trim();
    if (!version) {
      mobileSchoolArtData = '';
      mobileSchoolArtVersion = '';
      try {
        localStorage.removeItem(SCHOOL_ART_KEY);
        localStorage.removeItem(SCHOOL_ART_VERSION_KEY);
      } catch (_) {}
      applyMobileSchoolArt('');
      return;
    }
    if (version === mobileSchoolArtVersion && mobileSchoolArtData) {
      applyMobileSchoolArt(mobileSchoolArtData);
      return;
    }
    try {
      var res = await fetch('/api/mobile-branding?_=' + Date.now(), { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      var branding = await res.json();
      var art = String(branding.mobile_dashboard_school_art || '').trim();
      mobileSchoolArtData = art;
      mobileSchoolArtVersion = String(branding.school_art_version || version).trim();
      try {
        if (art) {
          localStorage.setItem(SCHOOL_ART_KEY, art);
          localStorage.setItem(SCHOOL_ART_VERSION_KEY, mobileSchoolArtVersion);
        } else {
          localStorage.removeItem(SCHOOL_ART_KEY);
          localStorage.removeItem(SCHOOL_ART_VERSION_KEY);
        }
      } catch (_) {}
      applyMobileSchoolArt(art);
    } catch (_) {}
  }

  function updateMobileDashboardShell() {
    if (!isMobileAppShell() || !isDashboardPage()) return;
    var rate = numberFromText(text('statRate'));
    var data = window.__mobileDashboardData || {};
    var present = text('statPresent');
    var students = data.active_students || data.total_students || text('statStudents');
    var teachers = data.active_teachers || data.total_teachers || text('statTeachers');
    var flagged = data.flagged_absent_2day || text('statFlagged');
    var nameEl = document.querySelector('.topbar-user-details strong') || document.querySelector('.user-details strong');
    var userName = nameEl ? nameEl.textContent.trim() : 'Dashboard';
    var hour = new Date().getHours();
    var greeting = hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening';
    var fullDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    var ring = document.querySelector('.mobile-ring');
    if (ring) ring.style.setProperty('--p', Math.max(0, Math.min(100, rate)));
    var rateEl = document.getElementById('mobileRate');
    if (rateEl) rateEl.textContent = rate + '%';
    var presentEl = document.getElementById('mobilePresentSummary');
    if (presentEl) presentEl.textContent = present + ' of ' + students + ' students present';
    var gEl = document.getElementById('mobileGreeting');
    if (gEl) gEl.textContent = greeting;
    var gTopEl = document.getElementById('mobileGreetingTop');
    if (gTopEl) gTopEl.textContent = greeting;
    var uEl = document.getElementById('mobileUserName');
    if (uEl) uEl.textContent = userName;
    var uTopEl = document.getElementById('mobileUserNameTop');
    if (uTopEl) uTopEl.textContent = userName;
    var fullDateEl = document.getElementById('mobileFullDate');
    if (fullDateEl) fullDateEl.textContent = fullDate;
    var studentEl = document.getElementById('mobileStudentCount');
    if (studentEl) studentEl.textContent = students;
    var teacherEl = document.getElementById('mobileTeacherCount');
    if (teacherEl) teacherEl.textContent = teachers;
    var flaggedEl = document.getElementById('mobileFlaggedCount');
    if (flaggedEl) flaggedEl.textContent = flagged;
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
        var params = liveParams(new URLSearchParams({ date: dateEl ? dateEl.value : localDateString() }));
        if (schoolEl && schoolEl.value) params.append('school', schoolEl.value);
        var res = await fetch('/api/dashboard-data?' + params, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return;
        var data = await res.json();
        applyDashboardData(data);
        await syncMobileSchoolArt(data);
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
    window.__mobileDashboardData = data || {};
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
    installBottomNavigation();
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
          st.__notifyKey = key;
          newlyFlagged.push(st);
        }
      }

      if (newlyFlagged.length > 0) {
        var deliveredAny = false;
        for (var n = 0; n < newlyFlagged.length; n++) {
          var sample = newlyFlagged[n];
          var notifyKey = sample.__notifyKey || String(n);
          var studentName = (sample.firstname && sample.lastname)
            ? (sample.lastname + ', ' + sample.firstname)
            : (sample.name || 'Student');
          var gradeSection = (sample.grade_name || '-') + ' / ' + (sample.section_name || '-');
          var lrn = sample.lrn || '-';
          var days = sample.absent_days || 2;
          var adviser = sample.adviser || 'Assigned adviser';
          var msg = studentName + ' | ' + gradeSection + ' | LRN ' + lrn + ' | ' + days + ' days absent';
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
          var delivered = await notify('2-Day Absence Alert', msg, {
            tag: 'absence-2day-alert-' + notifyKey,
            data: { url: '/admin/notifications?app=1', contactUrl: contactUrl },
            actions: [{ action: 'contact-adviser', title: 'Please contact adviser' }]
          });
          if (delivered) {
            notifiedMap[today][notifyKey] = 1;
            deliveredAny = true;
          }
        }
        if (deliveredAny) saveNotifiedMap(notifiedMap);
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
