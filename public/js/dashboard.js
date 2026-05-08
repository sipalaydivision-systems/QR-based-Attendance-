// Dashboard real-time polling logic — 3-second interval, no page reload
(function () {
    let currentHash = '';
    let pollTimer = null;

    function getFilters() {
        const dateEl = document.getElementById('dashDate');
        const schoolEl = document.getElementById('dashSchool');
        return {
            date: dateEl ? dateEl.value : new Date().toISOString().slice(0, 10),
            school: schoolEl ? schoolEl.value : ''
        };
    }

    async function fetchDashboard() {
        const { date, school } = getFilters();
        const params = new URLSearchParams({ date });
        if (school) params.append('school', school);

        try {
            const res = await fetch('/api/dashboard-data?' + params);
            if (!res.ok) return;
            const data = await res.json();
            updateUI(data);
        } catch (err) {
            console.error('Dashboard fetch error:', err);
        }
    }

    function updateUI(data) {
        document.getElementById('statSchools').textContent = data.total_schools;
        document.getElementById('statStudents').textContent = data.active_students;
        document.getElementById('statPresent').textContent = data.students_present;
        document.getElementById('statAbsent').textContent = data.students_absent;
        document.getElementById('statTeachers').textContent = data.teachers_present + '/' + data.total_teachers;
        document.getElementById('statRate').textContent = data.attendance_rate + '%';

        // New stats
        var timedOutEl = document.getElementById('statTimedOut');
        if (timedOutEl) timedOutEl.textContent = data.students_timed_out || 0;

        var flaggedEl = document.getElementById('statFlagged');
        if (flaggedEl) flaggedEl.textContent = data.flagged_absent_2day || 0;

        var inactiveEl = document.getElementById('statInactive');
        if (inactiveEl) inactiveEl.textContent = data.inactive_students || 0;

        // Non-school day banner
        var banner = document.getElementById('nonSchoolDayBanner');
        var bannerText = document.getElementById('nonSchoolDayText');
        if (banner && bannerText) {
            if (!data.is_school_day) {
                banner.style.display = 'block';
                bannerText.textContent = 'Today is not a school day: ' + (data.non_school_day_reason || 'N/A');
            } else {
                banner.style.display = 'none';
            }
        }

        // School breakdown with teacher rates
        const tbody = document.getElementById('schoolBreakdownBody');
        if (tbody && data.schools) {
            tbody.innerHTML = data.schools.map(function(s) {
                return '<tr><td>' + s.name + '</td><td>' + s.enrollment + '</td><td>' + s.present +
                '</td><td>' + s.absent + '</td><td>' + s.rate + '%</td>' +
                '<td>' + s.teachers_present + '/' + s.teachers_total + '</td>' +
                '<td>' + s.teacher_rate + '%</td></tr>';
            }).join('') || '<tr><td colspan="7" class="text-center">No schools</td></tr>';
        }

        // Load 2-day absence flagged students
        if (data.flagged_absent_2day > 0) {
            loadFlaggedStudents();
        } else {
            var flaggedCard = document.getElementById('flaggedCard');
            if (flaggedCard) flaggedCard.style.display = 'none';
        }
    }

    async function loadFlaggedStudents() {
        var flaggedCard = document.getElementById('flaggedCard');
        if (!flaggedCard) return;
        try {
            var res = await fetch('/api/absence-flags?days=2');
            var data = await res.json();
            if (data.length > 0) {
                flaggedCard.style.display = 'block';
                document.getElementById('flaggedBody').innerHTML = data.map(function(s) {
                    return '<tr><td>' + s.name + '</td><td>' + (s.lrn || '-') + '</td>' +
                        '<td>' + (s.school_name || '-') + '</td><td>' + (s.grade_name || '-') + '</td>' +
                        '<td>' + (s.section_name || '-') + '</td></tr>';
                }).join('');
            } else {
                flaggedCard.style.display = 'none';
            }
        } catch(e) { console.error(e); }
    }

    async function poll() {
        const { date, school } = getFilters();
        const params = new URLSearchParams({ hash: currentHash });
        if (school) params.append('school', school);

        try {
            const controller = new AbortController();
            const timeout = setTimeout(function() { controller.abort(); }, 8000);
            const res = await fetch('/api/realtime-poll?' + params, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) { schedulePoll(); return; }
            const data = await res.json();
            if (data.changed) {
                currentHash = data.hash;
                await fetchDashboard();
            } else {
                currentHash = data.hash;
            }
        } catch (err) {
            if (err.name !== 'AbortError') console.error('Poll error:', err);
        }
        schedulePoll();
    }

    function schedulePoll() {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, 3000);
    }

    // Event listeners for filters
    const dateEl = document.getElementById('dashDate');
    const schoolEl = document.getElementById('dashSchool');
    if (dateEl) dateEl.addEventListener('change', function() { currentHash = ''; fetchDashboard(); });
    if (schoolEl) schoolEl.addEventListener('change', function() { currentHash = ''; fetchDashboard(); });

    // Initial load
    fetchDashboard();
    schedulePoll();
})();
