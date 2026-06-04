package ph.gov.sipalay.attendance;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.GridLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

public class DashboardActivity extends Activity {
    private static final String CHANNEL_ID = "mobile_app_alerts";
    private static final long POLL_MS = 5000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, TextView> navItems = new LinkedHashMap<>();

    private LinearLayout content;
    private ProgressBar progress;
    private TextView liveStatus;
    private TextView dateChip;
    private Button refreshButton;

    private JSONObject dashboard = new JSONObject();
    private JSONArray absenceFlags = new JSONArray();
    private JSONArray currentSchools = new JSONArray();
    private String currentTab = "dashboard";
    private String lastHash = "";
    private String selectedDate = "";
    private int selectedSchoolId = -1;
    private int selectedGradeId = -1;
    private int selectedSectionId = -1;
    private boolean fetching = false;
    private boolean dashboardReady = false;

    private final Runnable poller = new Runnable() {
        @Override
        public void run() {
            pollServerChanges();
            handler.postDelayed(this, POLL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Ui.setBars(getWindow(), Ui.GREEN_DARK, false, Color.WHITE);
        selectedDate = today();
        String requestedTab = getIntent() == null ? "" : getIntent().getStringExtra("tab");
        if ("alerts".equals(requestedTab) || "schools".equals(requestedTab) || "reports".equals(requestedTab) || "attendance".equals(requestedTab) || (isSuperAdmin() && "admin".equals(requestedTab))) {
            currentTab = requestedTab;
        }
        AbsenceWorker.schedule(this);
        buildShell();
        renderLoading("Syncing live records...");
        handler.postDelayed(this::sendWelcomeNotification, 900);
        loadDashboard(true);
        handler.postDelayed(poller, POLL_MS);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void buildShell() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(244, 248, 246));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setPadding(Ui.dp(this, 16), Ui.statusBarHeight(this) + Ui.dp(this, 8), Ui.dp(this, 16), Ui.dp(this, 10));
        header.setBackground(Ui.verticalGradient(Ui.GREEN, Ui.GREEN_DARK, 0));
        Ui.elevate(header, 8);

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setBackground(Ui.strokeBg(Color.argb(38, 255, 255, 255), Color.argb(72, 255, 255, 255), Ui.dp(this, 16)));
        logo.setPadding(Ui.dp(this, 5), Ui.dp(this, 5), Ui.dp(this, 5), Ui.dp(this, 5));
        top.addView(logo, Ui.lp(Ui.dp(this, 38), Ui.dp(this, 38)));

        LinearLayout titleBox = new LinearLayout(this);
        titleBox.setOrientation(LinearLayout.VERTICAL);
        TextView app = Ui.text(this, "Edutrack", 17, Color.WHITE, Typeface.BOLD);
        TextView user = Ui.text(this, compactName(SessionStore.getFullname(this)), 11, Color.rgb(222, 255, 242), Typeface.NORMAL);
        titleBox.addView(app);
        titleBox.addView(user);
        LinearLayout.LayoutParams titleLp = Ui.marginLp(0, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 10), 0, Ui.dp(this, 8), 0);
        titleLp.weight = 1;
        top.addView(titleBox, titleLp);

        Button logout = headerButton("Out");
        logout.setOnClickListener(v -> logout());
        top.addView(logout, Ui.lp(Ui.dp(this, 58), Ui.dp(this, 36)));
        header.addView(top);

        LinearLayout chips = new LinearLayout(this);
        chips.setGravity(Gravity.CENTER_VERTICAL);
        chips.addView(liveChip());
        chips.addView(chip(readableDate()), Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 28), Ui.dp(this, 8), 0, 0, 0));
        dateChip = chip(selectedDate);
        chips.addView(dateChip, Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 28), Ui.dp(this, 8), 0, 0, 0));
        header.addView(chips, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 32), 0, Ui.dp(this, 8), 0, 0));
        root.addView(header);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setVisibility(View.GONE);
        root.addView(progress, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 3)));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(false);
        scroll.setClipToPadding(false);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(Ui.dp(this, 14), Ui.dp(this, 10), Ui.dp(this, 14), Ui.dp(this, 20));
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));

        root.addView(bottomNav());
        setContentView(root);
    }

    private LinearLayout bottomNav() {
        LinearLayout nav = new LinearLayout(this);
        nav.setGravity(Gravity.CENTER);
        nav.setPadding(Ui.dp(this, 6), Ui.dp(this, 5), Ui.dp(this, 6), Ui.dp(this, 6) + Math.min(Ui.navigationBarHeight(this), Ui.dp(this, 22)));
        nav.setBackgroundColor(Color.WHITE);
        Ui.elevate(nav, 12);
        addNav(nav, "dashboard", "Home", R.drawable.ic_nav_home);
        addNav(nav, "attendance", "Attendance", R.drawable.ic_nav_attendance);
        addNav(nav, "schools", "Schools", R.drawable.ic_nav_school);
        addNav(nav, "reports", "Report", R.drawable.ic_nav_report);
        addNav(nav, "alerts", "Alerts", R.drawable.ic_nav_alert);
        if (isSuperAdmin()) {
            addNav(nav, "admin", "Control", R.drawable.ic_nav_report);
        }
        updateNav();
        return nav;
    }

    private void addNav(LinearLayout nav, String tab, String label, int icon) {
        TextView item = Ui.text(this, label, 10, Color.rgb(70, 86, 82), Typeface.BOLD);
        item.setGravity(Gravity.CENTER);
        item.setPadding(Ui.dp(this, 2), Ui.dp(this, 3), Ui.dp(this, 2), Ui.dp(this, 3));
        item.setCompoundDrawablesWithIntrinsicBounds(0, icon, 0, 0);
        item.setCompoundDrawablePadding(Ui.dp(this, 2));
        item.setOnClickListener(v -> switchTab(tab));
        navItems.put(tab, item);
        nav.addView(item, new LinearLayout.LayoutParams(0, Ui.dp(this, 58), 1));
    }

    private void switchTab(String tab) {
        if (tab.equals(currentTab) && dashboardReady) return;
        if ("schools".equals(tab) && !"schools".equals(currentTab)) {
            selectedSchoolId = -1;
            selectedGradeId = -1;
            selectedSectionId = -1;
        }
        currentTab = tab;
        updateNav();
        if (!dashboardReady) {
            renderLoading("Loading " + tab + "...");
            return;
        }
        renderCurrentTab(true);
    }

    private void updateNav() {
        for (Map.Entry<String, TextView> entry : navItems.entrySet()) {
            boolean active = entry.getKey().equals(currentTab);
            TextView item = entry.getValue();
            item.setTextColor(active ? Ui.GREEN_DARK : Color.rgb(82, 96, 92));
            if (item.getCompoundDrawables()[1] != null) {
                item.getCompoundDrawables()[1].setTint(active ? Ui.GREEN_DARK : Color.rgb(82, 96, 92));
            }
            item.setBackground(active ? Ui.bg(Ui.GREEN_SOFT, Ui.dp(this, 14)) : Ui.bg(Color.TRANSPARENT, Ui.dp(this, 14)));
        }
    }

    private void loadDashboard(boolean visible) {
        if (fetching) return;
        final boolean firstLoad = !dashboardReady;
        fetching = true;
        setLoading(firstLoad);
        new Thread(() -> {
            try {
                String date = today();
                JSONObject freshDashboard = ApiClient.getJson(this, "/api/dashboard-data?date=" + date);
                JSONArray freshFlags = new JSONArray(ApiClient.getRaw(this, "/api/absence-flags?days=2"));
                JSONObject poll = lastHash.isEmpty() ? ApiClient.getJson(this, "/api/realtime-poll?hash=") : null;
                runOnUiThread(() -> {
                    selectedDate = date;
                    dashboard = freshDashboard;
                    absenceFlags = freshFlags;
                    if (poll != null) lastHash = poll.optString("hash", lastHash);
                    dashboardReady = true;
                    setLoading(false);
                    if (dateChip != null) dateChip.setText(selectedDate);
                    renderCurrentTab(firstLoad);
                    notifyAbsenceFlags(absenceFlags);
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception e) {
                runOnUiThread(() -> {
                    setLoading(false);
                    if (!dashboardReady) renderError("Cannot load live data", e.getMessage());
                    updateLiveText("Offline. Retrying...");
                });
            } finally {
                runOnUiThread(() -> fetching = false);
            }
        }).start();
    }

    private void pollServerChanges() {
        if (fetching || !dashboardReady) return;
        new Thread(() -> {
            try {
                JSONObject poll = ApiClient.getJson(this, "/api/realtime-poll?hash=" + lastHash);
                boolean changed = poll.optBoolean("changed", false);
                String hash = poll.optString("hash", lastHash);
                runOnUiThread(() -> {
                    if (changed) {
                        lastHash = hash;
                        loadDashboard(false);
                    } else {
                        updateLiveText("LIVE");
                    }
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception ignored) {
                runOnUiThread(() -> updateLiveText("LIVE"));
            }
        }).start();
    }

    private void renderCurrentTab(boolean animate) {
        content.removeAllViews();
        if ("attendance".equals(currentTab)) {
            renderAttendance(animate);
        } else if ("schools".equals(currentTab)) {
            renderSchools(animate);
        } else if ("reports".equals(currentTab)) {
            renderReports(animate);
        } else if ("alerts".equals(currentTab)) {
            renderAlerts(animate);
        } else if ("admin".equals(currentTab) && isSuperAdmin()) {
            renderAdminControl(animate);
        } else {
            renderDashboard(animate);
        }
    }

    private void renderDashboard(boolean animate) {
        content.addView(greetingPanel(), Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));

        LinearLayout ringPanel = panel();
        ringPanel.setGravity(Gravity.CENTER);
        ringPanel.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
        ringPanel.setBackground(Ui.strokeBg(Color.WHITE, Ui.GREEN, Ui.dp(this, 18)));
        AttendanceRingView ring = new AttendanceRingView(this);
        ringPanel.addView(ring, Ui.lp(Ui.dp(this, 184), Ui.dp(this, 152)));
        int active = activeStudents();
        int present = dashboard.optInt("students_present");
        TextView summary = Ui.text(this, present + " of " + active + " students present", 14, Color.rgb(46, 58, 55), Typeface.BOLD);
        summary.setGravity(Gravity.CENTER);
        ringPanel.addView(summary);
        content.addView(ringPanel, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
        ring.setPercent(dashboard.optInt("attendance_rate"));
        if (animate) Ui.reveal(ringPanel, 40);

        if (!dashboard.optBoolean("is_school_day", true)) {
            TextView note = Ui.text(this, nonSchoolDayAlertText(), 13, Color.rgb(141, 71, 0), Typeface.BOLD);
            note.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
            note.setLineSpacing(Ui.dp(this, 2), 1.0f);
            note.setBackground(Ui.strokeBg(Color.rgb(255, 248, 232), Color.rgb(252, 190, 93), Ui.dp(this, 14)));
            content.addView(note, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
        }

        GridLayout grid = metricGrid();
        addMetric(grid, "Students", activeStudents(), "active", Ui.GREEN_SOFT, Ui.GREEN_DARK);
        addMetric(grid, "Present", dashboard.optInt("students_present"), "today", Ui.GREEN_SOFT, Ui.GREEN_DARK);
        addMetric(grid, "Absent", dashboard.optInt("students_absent"), "now", Color.rgb(255, 239, 239), Ui.RED);
        addMetric(grid, "2-Day", absenceFlags.length(), "flagged", Color.rgb(255, 248, 231), Ui.AMBER);
        addMetric(grid, "Teachers", dashboard.optInt("total_teachers"), "active", Color.rgb(234, 250, 255), Ui.GREEN_DARK);
        addMetric(grid, "T. Present", dashboard.optInt("teachers_present"), "today", Ui.GREEN_SOFT, Ui.GREEN_DARK);
        content.addView(grid);
        if (animate) Ui.reveal(grid, 90);

        addAnalyticsPanel(animate);
        addLiveFooter();
    }

    private LinearLayout greetingPanel() {
        LinearLayout card = panel();
        card.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
        card.setBackground(Ui.gradient(Color.WHITE, Color.rgb(242, 255, 248), Ui.dp(this, 18)));
        TextView small = Ui.text(this, greeting() + " - " + readableDate(), 12, Color.rgb(91, 106, 101), Typeface.NORMAL);
        TextView name = Ui.text(this, compactName(SessionStore.getFullname(this)), 20, Ui.INK, Typeface.BOLD);
        TextView role = Ui.text(this, roleLabel() + " monitoring", 12, Ui.GREEN_DARK, Typeface.BOLD);
        card.addView(small);
        card.addView(name, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 2), 0, 0));
        card.addView(role, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 2), 0, 0));
        return card;
    }

    private void addCompactActions(boolean animate) {
        LinearLayout card = panel();
        card.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 14));
        TextView title = Ui.text(this, "Quick Checks", 16, Ui.INK, Typeface.BOLD);
        TextView helper = Ui.text(this, "Use this to verify alerts on this phone.", 12, Color.rgb(103, 116, 112), Typeface.NORMAL);
        Button test = compactButton("Send test notification", Ui.GREEN_DARK);
        test.setOnClickListener(v -> sendNotification("Edutrack test alert", "Notifications are working on this phone."));
        card.addView(title);
        card.addView(helper, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 2), 0, Ui.dp(this, 10)));
        card.addView(test, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 44)));
        content.addView(card, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 2), 0, Ui.dp(this, 10)));
        if (animate) Ui.reveal(card, 130);
    }

    private void addSchoolPreview(boolean animate) {
        JSONArray schools = dashboard.optJSONArray("schools");
        LinearLayout card = sectionCard("Top School Records", "Live per-school attendance rates");
        if (schools == null || schools.length() == 0) {
            card.addView(emptyText("No school records available."));
        } else {
            for (int i = 0; i < Math.min(schools.length(), 6); i++) {
                JSONObject school = schools.optJSONObject(i);
                if (school != null) card.addView(compactSchoolRow(school));
            }
        }
        content.addView(card, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
        if (animate) Ui.reveal(card, 180);
    }

    private void addAnalyticsPanel(boolean animate) {
        JSONArray schools = dashboard.optJSONArray("schools");
        LinearLayout card = sectionCard("Attendance Analytics", "Live school rate snapshot");
        int totalRate = 0;
        int count = 0;
        String bestName = "No records";
        int bestRate = -1;
        if (schools != null) {
            for (int i = 0; i < schools.length(); i++) {
                JSONObject school = schools.optJSONObject(i);
                if (school == null) continue;
                int rate = school.optInt("rate");
                totalRate += rate;
                count++;
                if (rate > bestRate) {
                    bestRate = rate;
                    bestName = school.optString("name", "School");
                }
            }
        }
        int average = count == 0 ? 0 : Math.round(totalRate / (float) count);
        card.addView(summaryPill("Average rate", average + "%", Ui.GREEN_DARK));
        card.addView(summaryPill("Top school", bestRate < 0 ? "0%" : bestRate + "% - " + compactLabel(bestName, 20), Ui.AMBER));
        if (schools == null || schools.length() == 0) {
            card.addView(emptyText("No school analytics available yet."));
        } else {
            for (int i = 0; i < Math.min(schools.length(), 5); i++) {
                JSONObject school = schools.optJSONObject(i);
                if (school != null) card.addView(rateBarRow(school.optString("name", "School"), school.optInt("rate")));
            }
        }
        content.addView(card, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 2), 0, Ui.dp(this, 10)));
        if (animate) Ui.reveal(card, 140);
    }

    private LinearLayout summaryPill(String label, String value, int accent) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(Ui.dp(this, 10), Ui.dp(this, 8), Ui.dp(this, 10), Ui.dp(this, 8));
        row.setBackground(Ui.bg(Color.rgb(248, 251, 249), Ui.dp(this, 12)));
        TextView left = Ui.text(this, label, 11, Color.rgb(86, 101, 97), Typeface.BOLD);
        TextView right = Ui.text(this, value, 12, accent, Typeface.BOLD);
        row.addView(left, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        row.addView(right);
        row.setLayoutParams(Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 7)));
        return row;
    }

    private LinearLayout rateBarRow(String name, int rate) {
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setPadding(0, Ui.dp(this, 5), 0, Ui.dp(this, 5));
        LinearLayout line = new LinearLayout(this);
        line.setGravity(Gravity.CENTER_VERTICAL);
        TextView label = Ui.text(this, compactLabel(name, 24), 11, Ui.INK, Typeface.BOLD);
        TextView value = Ui.text(this, Math.max(0, Math.min(100, rate)) + "%", 11, Ui.GREEN_DARK, Typeface.BOLD);
        line.addView(label, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        line.addView(value);
        wrap.addView(line);

        LinearLayout track = new LinearLayout(this);
        track.setOrientation(LinearLayout.HORIZONTAL);
        track.setBackground(Ui.bg(Color.rgb(229, 238, 234), Ui.dp(this, 8)));
        TextView fill = new TextView(this);
        fill.setBackground(Ui.bg(rate >= 75 ? Ui.GREEN_DARK : Ui.AMBER, Ui.dp(this, 8)));
        int safeRate = Math.max(0, Math.min(100, rate));
        track.addView(fill, new LinearLayout.LayoutParams(0, Ui.dp(this, 8), safeRate));
        TextView rest = new TextView(this);
        track.addView(rest, new LinearLayout.LayoutParams(0, Ui.dp(this, 8), 100 - safeRate));
        wrap.addView(track, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 8), 0, Ui.dp(this, 4), 0, 0));
        return wrap;
    }

    private void renderAttendance(boolean animate) {
        content.addView(sectionHeader("Attendance", "Live time-in and time-out records for today."));
        renderRemoteArray("/api/attendance?date=" + selectedDate, rows -> {
            LinearLayout card = sectionCard("Today Records", rows.length() + " synced record(s)");
            if (rows.length() == 0) {
                card.addView(emptyText("No attendance records yet today."));
            } else {
                for (int i = 0; i < Math.min(rows.length(), 80); i++) {
                    JSONObject row = rows.optJSONObject(i);
                    if (row == null) continue;
                    String title = row.optString("person_name", "Unknown");
                    String school = row.optString("school_name", row.optString("school_id", ""));
                    String details = row.optString("person_type", "person") + " - In: " + shortTime(row.optString("time_in", "--")) + " - Out: " + shortTime(row.optString("time_out", "--"));
                    card.addView(recordRow(title, school, details, Ui.GREEN_DARK));
                }
            }
            content.addView(card);
            addLiveFooter();
            if (animate) Ui.reveal(card, 80);
        }, animate);
    }

    private void renderSchools(boolean animate) {
        String sub = "Tap a school to view grade levels.";
        if (selectedSchoolId >= 0 && selectedGradeId < 0) sub = "Tap a grade level to view sections.";
        if (selectedGradeId >= 0 && selectedSectionId < 0) sub = "Tap a section to view adviser and students.";
        if (selectedSectionId >= 0) sub = "Students assigned to this section.";
        content.addView(sectionHeader("Schools", sub));
        renderRemoteObject("/api/mobile-school-structure", data -> {
            JSONArray schools = data.optJSONArray("schools");
            currentSchools = schools == null ? new JSONArray() : schools;
            if (selectedSchoolId < 0) {
                renderSchoolList(currentSchools, animate);
            } else {
                renderSchoolDetail(findSchool(currentSchools, selectedSchoolId), animate);
            }
        }, animate);
    }

    private void renderSchoolList(JSONArray schools, boolean animate) {
        LinearLayout card = sectionCard("School List", schools.length() + " school(s)");
        if (schools.length() == 0) {
            card.addView(emptyText("No schools found in the live database."));
        } else {
            for (int i = 0; i < schools.length(); i++) {
                JSONObject school = schools.optJSONObject(i);
                if (school == null) continue;
                LinearLayout row = schoolRecordRow(
                        school,
                        school.optString("name", "School"),
                        school.optString("address", "No address saved"),
                        school.optInt("student_count") + " students - " + school.optInt("teacher_count") + " teachers",
                        Ui.GREEN_DARK
                );
                row.setOnClickListener(v -> {
                    selectedSchoolId = school.optInt("id", -1);
                    selectedGradeId = -1;
                    selectedSectionId = -1;
                    renderCurrentTab(true);
                });
                card.addView(row);
            }
        }
        content.addView(card);
        addLiveFooter();
        if (animate) Ui.reveal(card, 80);
    }

    private void renderSchoolDetail(JSONObject school, boolean animate) {
        if (school == null) {
            selectedSchoolId = -1;
            selectedGradeId = -1;
            selectedSectionId = -1;
            renderSchoolList(currentSchools, animate);
            return;
        }
        JSONArray grades = school.optJSONArray("grade_levels");
        if (selectedGradeId >= 0) {
            JSONObject grade = findGrade(grades, selectedGradeId);
            if (grade != null) {
                if (selectedSectionId >= 0) {
                    JSONObject section = findSection(grade.optJSONArray("sections"), selectedSectionId);
                    renderSectionDetail(school, grade, section, animate);
                    return;
                }
                renderGradeDetail(school, grade, animate);
                return;
            }
            selectedGradeId = -1;
            selectedSectionId = -1;
        }

        LinearLayout card = sectionCard(school.optString("name", "School"), school.optInt("student_count") + " students - " + school.optInt("teacher_count") + " teachers");
        card.addView(schoolHeaderRow(school), Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
        Button back = compactButton("Back", Ui.GREEN_DARK);
        back.setOnClickListener(v -> {
            selectedSchoolId = -1;
            selectedGradeId = -1;
            selectedSectionId = -1;
            renderCurrentTab(true);
        });
        card.addView(back, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 42), 0, 0, 0, Ui.dp(this, 10)));
        String contact = school.optString("contact", "").trim();
        if (!contact.isEmpty()) card.addView(Ui.text(this, "Contact: " + contact, 11, Color.rgb(84, 98, 94), Typeface.BOLD));

        if (grades == null || grades.length() == 0) {
            card.addView(emptyText("No grade levels assigned."));
        } else {
            for (int g = 0; g < grades.length(); g++) {
                JSONObject grade = grades.optJSONObject(g);
                if (grade == null) continue;
                JSONArray sections = grade.optJSONArray("sections");
                int sectionCount = sections == null ? 0 : sections.length();
                int studentCount = countStudentsInGrade(grade);
                LinearLayout row = recordRow(
                        grade.optString("name", "Grade Level"),
                        sectionCount + " section(s)",
                        studentCount + " students",
                        Ui.GREEN_DARK
                );
                row.setOnClickListener(v -> {
                    selectedGradeId = grade.optInt("id", -1);
                    selectedSectionId = -1;
                    renderCurrentTab(true);
                });
                card.addView(row);
            }
        }
        content.addView(card);
        addLiveFooter();
        if (animate) Ui.reveal(card, 80);
    }

    private void renderGradeDetail(JSONObject school, JSONObject grade, boolean animate) {
        JSONArray sections = grade.optJSONArray("sections");
        LinearLayout card = sectionCard(grade.optString("name", "Grade Level"), school.optString("name", "School"));
        card.addView(schoolHeaderRow(school), Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
        Button back = compactButton("Back", Ui.GREEN_DARK);
        back.setOnClickListener(v -> {
            selectedGradeId = -1;
            selectedSectionId = -1;
            renderCurrentTab(true);
        });
        card.addView(back, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 42), 0, 0, 0, Ui.dp(this, 10)));
        if (sections == null || sections.length() == 0) {
            card.addView(emptyText("No sections assigned to this grade."));
        } else {
            for (int i = 0; i < sections.length(); i++) {
                JSONObject section = sections.optJSONObject(i);
                if (section == null) continue;
                JSONArray students = section.optJSONArray("students");
                int studentCount = students == null ? 0 : students.length();
                String adviser = section.optString("adviser", "").trim();
                LinearLayout row = recordRow(
                        section.optString("name", "Section"),
                        adviser.isEmpty() ? "No adviser assigned" : "Adviser: " + adviser,
                        studentCount + " students",
                        adviser.isEmpty() ? Ui.AMBER : Ui.GREEN_DARK
                );
                row.setOnClickListener(v -> {
                    selectedSectionId = section.optInt("id", -1);
                    renderCurrentTab(true);
                });
                card.addView(row);
            }
        }
        content.addView(card);
        addLiveFooter();
        if (animate) Ui.reveal(card, 80);
    }

    private void renderSectionDetail(JSONObject school, JSONObject grade, JSONObject section, boolean animate) {
        if (section == null) {
            selectedSectionId = -1;
            renderGradeDetail(school, grade, animate);
            return;
        }
        LinearLayout card = sectionCard(section.optString("name", "Section"), grade.optString("name", "Grade Level") + " - " + school.optString("name", "School"));
        card.addView(schoolHeaderRow(school), Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
        Button back = compactButton("Back", Ui.GREEN_DARK);
        back.setOnClickListener(v -> {
            selectedSectionId = -1;
            renderCurrentTab(true);
        });
        card.addView(back, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 42), 0, 0, 0, Ui.dp(this, 10)));

        String adviser = section.optString("adviser", "").trim();
        card.addView(summaryPill("Adviser", adviser.isEmpty() ? "No adviser assigned" : adviser, adviser.isEmpty() ? Ui.AMBER : Ui.GREEN_DARK));
        JSONArray students = section.optJSONArray("students");
        if (students == null || students.length() == 0) {
            card.addView(emptyText("No students assigned to this section."));
        } else {
            for (int i = 0; i < Math.min(students.length(), 120); i++) {
                JSONObject student = students.optJSONObject(i);
                if (student == null) continue;
                String meta = "LRN: " + firstNonEmpty(student.optString("lrn", ""), "-")
                        + " - Adviser: " + (adviser.isEmpty() ? "No adviser assigned" : adviser);
                card.addView(recordRow(studentName(student), meta, formatStatusLabel(student.optString("status", "inactive")), Ui.GREEN_DARK));
            }
            if (students.length() > 120) {
                card.addView(Ui.text(this, "+" + (students.length() - 120) + " more students", 11, Ui.GREEN_DARK, Typeface.BOLD));
            }
        }
        content.addView(card);
        addLiveFooter();
        if (animate) Ui.reveal(card, 80);
    }

    private LinearLayout nestedBlock(int color) {
        LinearLayout block = new LinearLayout(this);
        block.setOrientation(LinearLayout.VERTICAL);
        block.setPadding(Ui.dp(this, 10), Ui.dp(this, 9), Ui.dp(this, 10), Ui.dp(this, 9));
        block.setBackground(Ui.strokeBg(color, Color.rgb(229, 238, 234), Ui.dp(this, 12)));
        block.setLayoutParams(Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, 0));
        return block;
    }

    private JSONObject findSchool(JSONArray schools, int id) {
        for (int i = 0; i < schools.length(); i++) {
            JSONObject school = schools.optJSONObject(i);
            if (school != null && school.optInt("id", -1) == id) return school;
        }
        return null;
    }

    private JSONObject findGrade(JSONArray grades, int id) {
        if (grades == null) return null;
        for (int i = 0; i < grades.length(); i++) {
            JSONObject grade = grades.optJSONObject(i);
            if (grade != null && grade.optInt("id", -1) == id) return grade;
        }
        return null;
    }

    private JSONObject findSection(JSONArray sections, int id) {
        if (sections == null) return null;
        for (int i = 0; i < sections.length(); i++) {
            JSONObject section = sections.optJSONObject(i);
            if (section != null && section.optInt("id", -1) == id) return section;
        }
        return null;
    }

    private int countStudentsInGrade(JSONObject grade) {
        int count = 0;
        JSONArray sections = grade.optJSONArray("sections");
        if (sections == null) return 0;
        for (int i = 0; i < sections.length(); i++) {
            JSONObject section = sections.optJSONObject(i);
            if (section == null) continue;
            JSONArray students = section.optJSONArray("students");
            if (students != null) count += students.length();
        }
        return count;
    }

    private void renderReports(boolean animate) {
        content.addView(sectionHeader("Reports", "Daily summary, absentee list, and school rates."));
        renderRemoteObject("/api/reports/daily-summary?date=" + selectedDate, summary -> {
            JSONObject totals = summary.optJSONObject("totals");
            JSONArray schools = summary.optJSONArray("schools");
            if (totals == null) totals = new JSONObject();

            LinearLayout totalsCard = sectionCard("Daily Summary", "Updated " + timeNow());
            GridLayout grid = metricGrid();
            addMetric(grid, "Students", totals.optInt("enrolled"), "total", Ui.GREEN_SOFT, Ui.GREEN_DARK);
            addMetric(grid, "Present", totals.optInt("present"), "today", Ui.GREEN_SOFT, Ui.GREEN_DARK);
            addMetric(grid, "Absent", totals.optInt("absent"), "today", Color.rgb(255, 239, 239), Ui.RED);
            addMetric(grid, "Rate", totals.optInt("rate"), "percent", Color.rgb(255, 248, 231), Ui.AMBER);
            totalsCard.addView(grid);
            content.addView(totalsCard, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));

            LinearLayout schoolCard = sectionCard("School Rates", schools == null ? "0 school records" : schools.length() + " school records");
            if (schools == null || schools.length() == 0) {
                schoolCard.addView(emptyText("No report rows available."));
            } else {
                for (int i = 0; i < Math.min(schools.length(), 60); i++) {
                    JSONObject school = schools.optJSONObject(i);
                    if (school != null) schoolCard.addView(compactSchoolRow(school));
                }
            }
            content.addView(schoolCard);
            loadAbsenteeCount(animate);
            if (animate) {
                Ui.reveal(totalsCard, 80);
                Ui.reveal(schoolCard, 130);
            }
        }, animate);
    }

    private void loadAbsenteeCount(boolean animate) {
        renderRemoteArray("/api/reports/absentees?date=" + selectedDate, rows -> {
            LinearLayout card = sectionCard("Absentee List", rows.length() + " absent student(s)");
            if (rows.length() == 0) {
                card.addView(emptyText("No absentees detected for today."));
            } else {
                for (int i = 0; i < Math.min(rows.length(), 30); i++) {
                    JSONObject row = rows.optJSONObject(i);
                    if (row == null) continue;
                    String name = row.optString("firstname", "") + " " + row.optString("lastname", "");
                    String section = row.optString("grade_name", "") + " " + row.optString("section_name", "");
                    card.addView(recordRow(name.trim(), row.optString("school_name", ""), section.trim(), Ui.RED));
                }
            }
            content.addView(card, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 10), 0, 0));
            addLiveFooter();
            if (animate) Ui.reveal(card, 180);
        }, animate);
    }

    private void renderAdminControl(boolean animate) {
        content.addView(sectionHeader("Super Admin Control", "System controls for administrator accounts."));

        GridLayout grid = metricGrid();
        addMetric(grid, "Schools", dashboard.optInt("total_schools"), "managed", Ui.GREEN_SOFT, Ui.GREEN_DARK);
        addMetric(grid, "Students", dashboard.optInt("total_students"), "records", Ui.GREEN_SOFT, Ui.GREEN_DARK);
        addMetric(grid, "Teachers", dashboard.optInt("total_teachers"), "advisers", Ui.GREEN_SOFT, Ui.GREEN_DARK);
        addMetric(grid, "2-Day", dashboard.optInt("two_day_absentees", absenceFlags.length()), "alerts", Color.rgb(255, 248, 231), Ui.AMBER);
        content.addView(grid, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 8)));
        if (animate) Ui.reveal(grid, 60);

        LinearLayout modules = sectionCard("Control Modules", "Super Admin-only access areas.");
        Button createAccount = compactButton("Create Admin Account", Ui.GREEN_DARK);
        createAccount.setOnClickListener(v -> showCreateAdminAccountDialog());
        modules.addView(createAccount, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 44), 0, 0, 0, Ui.dp(this, 8)));
        Button addHoliday = compactButton("Add Holiday", Ui.AMBER);
        addHoliday.setOnClickListener(v -> showHolidayDialog());
        modules.addView(addHoliday, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 44), 0, 0, 0, Ui.dp(this, 12)));
        modules.addView(recordRow("User Management", "Accounts, roles, activation, and passwords", "Tap an account below to activate or deactivate.", Ui.GREEN_DARK));
        modules.addView(recordRow("School Management", "Schools, grades, sections, logos, and advisers", "Synced with the web-based system.", Ui.GREEN_DARK));
        modules.addView(recordRow("Holiday and Attendance Rules", "Holidays, non-school days, grace periods, and alerts", "Applied to reports, dashboard, and notifications.", Ui.AMBER));
        modules.addView(recordRow("Reports and Audit Logs", "Reports, analytics, exports, and activity history", "Live secure data from the Railway server.", Ui.GREEN_DARK));
        content.addView(modules, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
        if (animate) Ui.reveal(modules, 100);

        LinearLayout loading = inlineLoading("Loading Super Admin controls...");
        content.addView(loading, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 2), 0, 0));
        String tabAtRequest = currentTab;
        new Thread(() -> {
            try {
                JSONArray users = new JSONArray(ApiClient.getRaw(this, "/api/users"));
                JSONArray holidays = new JSONArray(ApiClient.getRaw(this, "/api/holidays"));
                JSONArray logs = new JSONArray(ApiClient.getRaw(this, "/api/user-logs"));
                runOnUiThread(() -> {
                    if (!tabAtRequest.equals(currentTab)) return;
                    content.removeView(loading);
                    content.addView(adminUsersCard(users), Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
                    content.addView(adminHolidayCard(holidays), Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
                    content.addView(adminActivityCard(logs), Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
                    addLiveFooter();
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception e) {
                runOnUiThread(() -> {
                    if (!tabAtRequest.equals(currentTab)) return;
                    content.removeView(loading);
                    renderInlineError("Unable to load Super Admin controls", e.getMessage());
                    addLiveFooter();
                });
            }
        }).start();
    }

    private LinearLayout adminUsersCard(JSONArray users) {
        int active = 0;
        for (int i = 0; i < users.length(); i++) {
            JSONObject user = users.optJSONObject(i);
            if (user != null && "active".equalsIgnoreCase(user.optString("status", "active"))) active++;
        }
        LinearLayout card = sectionCard("Account Controls", active + " active of " + users.length() + " account(s)");
        Button create = compactButton("Create Admin Account", Ui.GREEN_DARK);
        create.setOnClickListener(v -> showCreateAdminAccountDialog());
        card.addView(create, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 44), 0, 0, 0, Ui.dp(this, 10)));
        if (users.length() == 0) {
            card.addView(emptyText("No user accounts found."));
        } else {
            for (int i = 0; i < Math.min(users.length(), 12); i++) {
                JSONObject user = users.optJSONObject(i);
                if (user == null) continue;
                card.addView(adminUserRow(user));
            }
        }
        return card;
    }

    private LinearLayout adminUserRow(JSONObject user) {
        boolean active = "active".equalsIgnoreCase(user.optString("status", "active"));
        LinearLayout row = recordRow(
                user.optString("fullname", user.optString("username", "User")),
                roleDisplay(user.optString("role", "principal")) + " - " + (active ? "Active" : "Inactive"),
                firstNonEmpty(user.optString("school_name", ""), user.optString("email", "")),
                active ? Ui.GREEN_DARK : Ui.RED
        );
        row.setOnClickListener(v -> confirmToggleUser(user));
        return row;
    }

    private LinearLayout adminHolidayCard(JSONArray holidays) {
        LinearLayout card = sectionCard("Holiday Schedule", "Dates excluded from attendance calculations.");
        Button add = compactButton("Add Holiday", Ui.AMBER);
        add.setOnClickListener(v -> showHolidayDialog());
        card.addView(add, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 44), 0, 0, 0, Ui.dp(this, 10)));
        if (holidays.length() == 0) {
            card.addView(emptyText("No holidays configured."));
        } else {
            for (int i = 0; i < Math.min(holidays.length(), 8); i++) {
                JSONObject row = holidays.optJSONObject(i);
                if (row == null) continue;
                LinearLayout holidayRow = recordRow(
                        row.optString("name", "Holiday"),
                        row.optString("holiday_date", ""),
                        firstNonEmpty(row.optString("school_name", ""), "All schools"),
                        Ui.AMBER
                );
                holidayRow.setOnClickListener(v -> confirmDeleteHoliday(row));
                card.addView(holidayRow);
            }
        }
        return card;
    }

    private LinearLayout adminActivityCard(JSONArray logs) {
        LinearLayout card = sectionCard("Recent Activities", "Latest account and system activity.");
        if (logs.length() == 0) {
            card.addView(emptyText("No recent activity found."));
        } else {
            for (int i = 0; i < Math.min(logs.length(), 8); i++) {
                JSONObject row = logs.optJSONObject(i);
                if (row == null) continue;
                card.addView(recordRow(
                        row.optString("fullname", row.optString("username", "System user")),
                        row.optString("action", row.optString("activity", "Activity recorded")),
                        row.optString("created_at", ""),
                        Ui.GREEN_DARK
                ));
            }
        }
        return card;
    }

    private void confirmToggleUser(JSONObject user) {
        boolean active = "active".equalsIgnoreCase(user.optString("status", "active"));
        String action = active ? "Deactivate" : "Activate";
        new AlertDialog.Builder(this)
                .setTitle(action + " account")
                .setMessage(action + " " + user.optString("fullname", user.optString("username", "this account")) + "?")
                .setNegativeButton("Cancel", null)
                .setPositiveButton(action, (dialog, which) -> toggleUserStatus(user, active ? "inactive" : "active"))
                .show();
    }

    private void toggleUserStatus(JSONObject user, String status) {
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("username", user.optString("username", ""));
                body.put("fullname", user.optString("fullname", ""));
                body.put("email", user.optString("email", ""));
                body.put("role", user.optString("role", "principal"));
                if (user.isNull("school_id")) body.put("school_id", JSONObject.NULL);
                else body.put("school_id", user.opt("school_id"));
                body.put("status", status);
                ApiClient.putJson(this, "/api/users/" + user.optInt("id"), body);
                runOnUiThread(() -> {
                    Toast.makeText(this, "Account " + ("active".equals(status) ? "activated" : "deactivated") + ".", Toast.LENGTH_SHORT).show();
                    if ("admin".equals(currentTab)) renderCurrentTab(false);
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "Unable to update account: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void showCreateAdminAccountDialog() {
        LinearLayout form = dialogForm();
        EditText username = dialogInput("Username");
        EditText fullname = dialogInput("Full name");
        EditText email = dialogInput("Email address (optional)");
        EditText password = dialogInput("Temporary password");
        password.setInputType(0x00000081);

        String[] roleLabels = {"School Administrator", "Super Administrator", "SDS View Only", "ASDS View Only"};
        String[] roleCodes = {"principal", "super_admin", "superintendent", "asst_superintendent"};
        Spinner role = dialogSpinner(roleLabels);

        JSONArray schools = dashboard.optJSONArray("schools");
        ArrayList<String> schoolNames = new ArrayList<>();
        ArrayList<Integer> schoolIds = new ArrayList<>();
        if (schools != null) {
            for (int i = 0; i < schools.length(); i++) {
                JSONObject school = schools.optJSONObject(i);
                if (school == null) continue;
                schoolNames.add(school.optString("name", "School"));
                schoolIds.add(school.optInt("id", -1));
            }
        }
        if (schoolNames.isEmpty()) {
            schoolNames.add("No schools available");
            schoolIds.add(-1);
        }
        Spinner school = dialogSpinner(schoolNames.toArray(new String[0]));

        form.addView(username);
        form.addView(fullname);
        form.addView(email);
        form.addView(password);
        form.addView(labeledView("Role", role));
        form.addView(labeledView("Assigned school for School Administrator", school));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Create Admin Account")
                .setMessage("Create a role-based mobile and web login account.")
                .setView(form)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Create", null)
                .create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String u = username.getText().toString().trim();
            String n = fullname.getText().toString().trim();
            String p = password.getText().toString().trim();
            if (u.isEmpty() || n.isEmpty() || p.isEmpty()) {
                Toast.makeText(this, "Username, full name, and password are required.", Toast.LENGTH_LONG).show();
                return;
            }
            int roleIndex = role.getSelectedItemPosition();
            String selectedRole = roleCodes[Math.max(0, roleIndex)];
            int selectedSchoolId = schoolIds.get(Math.max(0, school.getSelectedItemPosition()));
            if ("principal".equals(selectedRole) && selectedSchoolId < 1) {
                Toast.makeText(this, "School Administrator accounts must be assigned to a school.", Toast.LENGTH_LONG).show();
                return;
            }
            try {
                JSONObject body = new JSONObject();
                body.put("username", u);
                body.put("fullname", n);
                body.put("email", email.getText().toString().trim());
                body.put("password", p);
                body.put("role", selectedRole);
                body.put("school_id", "principal".equals(selectedRole) ? selectedSchoolId : JSONObject.NULL);
                body.put("status", "active");
                dialog.dismiss();
                createAdminAccount(body);
            } catch (Exception e) {
                Toast.makeText(this, "Unable to prepare account data.", Toast.LENGTH_LONG).show();
            }
        }));
        dialog.show();
    }

    private void createAdminAccount(JSONObject body) {
        new Thread(() -> {
            try {
                ApiClient.postJson(this, "/api/users", body);
                runOnUiThread(() -> {
                    Toast.makeText(this, "Admin account created.", Toast.LENGTH_SHORT).show();
                    if ("admin".equals(currentTab)) renderCurrentTab(false);
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "Unable to create account: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void showHolidayDialog() {
        LinearLayout form = dialogForm();
        EditText name = dialogInput("Holiday name");
        EditText holidayDate = dialogInput("Holiday date (YYYY-MM-DD)");
        holidayDate.setText(selectedDate == null || selectedDate.isEmpty() ? today() : selectedDate);
        String[] typeLabels = {"National Holiday", "Local Holiday", "School Holiday"};
        int[] typeCodes = {1, 0, 2};
        Spinner type = dialogSpinner(typeLabels);

        JSONArray schools = dashboard.optJSONArray("schools");
        ArrayList<String> schoolNames = new ArrayList<>();
        ArrayList<Integer> schoolIds = new ArrayList<>();
        if (schools != null) {
            for (int i = 0; i < schools.length(); i++) {
                JSONObject school = schools.optJSONObject(i);
                if (school == null) continue;
                schoolNames.add(school.optString("name", "School"));
                schoolIds.add(school.optInt("id", -1));
            }
        }
        if (schoolNames.isEmpty()) {
            schoolNames.add("No schools available");
            schoolIds.add(-1);
        }
        Spinner school = dialogSpinner(schoolNames.toArray(new String[0]));

        form.addView(name);
        form.addView(holidayDate);
        form.addView(labeledView("Holiday type", type));
        form.addView(labeledView("School for School Holiday", school));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Add Holiday")
                .setMessage("Holiday dates are excluded from attendance calculations.")
                .setView(form)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Save", null)
                .create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String cleanName = name.getText().toString().trim();
            String cleanDate = holidayDate.getText().toString().trim();
            if (cleanName.isEmpty() || cleanDate.isEmpty()) {
                Toast.makeText(this, "Holiday name and date are required.", Toast.LENGTH_LONG).show();
                return;
            }
            if (!cleanDate.matches("\\d{4}-\\d{2}-\\d{2}")) {
                Toast.makeText(this, "Use date format YYYY-MM-DD.", Toast.LENGTH_LONG).show();
                return;
            }
            int typeIndex = Math.max(0, type.getSelectedItemPosition());
            int selectedType = typeCodes[typeIndex];
            int selectedSchoolId = schoolIds.get(Math.max(0, school.getSelectedItemPosition()));
            if (selectedType == 2 && selectedSchoolId < 1) {
                Toast.makeText(this, "School Holiday must be assigned to a school.", Toast.LENGTH_LONG).show();
                return;
            }
            try {
                JSONObject body = new JSONObject();
                body.put("name", cleanName);
                body.put("holiday_date", cleanDate);
                body.put("is_national", selectedType);
                body.put("school_id", selectedType == 2 ? selectedSchoolId : JSONObject.NULL);
                dialog.dismiss();
                createHoliday(body);
            } catch (Exception e) {
                Toast.makeText(this, "Unable to prepare holiday data.", Toast.LENGTH_LONG).show();
            }
        }));
        dialog.show();
    }

    private void createHoliday(JSONObject body) {
        new Thread(() -> {
            try {
                ApiClient.postJson(this, "/api/holidays", body);
                runOnUiThread(() -> {
                    Toast.makeText(this, "Holiday saved.", Toast.LENGTH_SHORT).show();
                    if ("admin".equals(currentTab)) renderCurrentTab(false);
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "Unable to save holiday: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void confirmDeleteHoliday(JSONObject holiday) {
        new AlertDialog.Builder(this)
                .setTitle("Remove holiday")
                .setMessage("Remove " + holiday.optString("name", "this holiday") + "?")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Remove", (dialog, which) -> deleteHoliday(holiday))
                .show();
    }

    private void deleteHoliday(JSONObject holiday) {
        int id = holiday.optInt("id", -1);
        if (id < 1) return;
        new Thread(() -> {
            try {
                ApiClient.deleteJson(this, "/api/holidays/" + id);
                runOnUiThread(() -> {
                    Toast.makeText(this, "Holiday removed.", Toast.LENGTH_SHORT).show();
                    if ("admin".equals(currentTab)) renderCurrentTab(false);
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "Unable to remove holiday: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private LinearLayout dialogForm() {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int pad = Ui.dp(this, 4);
        form.setPadding(pad, Ui.dp(this, 6), pad, 0);
        return form;
    }

    private EditText dialogInput(String hint) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setSingleLine(true);
        input.setTextSize(14);
        input.setPadding(Ui.dp(this, 10), 0, Ui.dp(this, 10), 0);
        input.setLayoutParams(Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 50), 0, 0, 0, Ui.dp(this, 8)));
        return input;
    }

    private Spinner dialogSpinner(String[] values) {
        Spinner spinner = new Spinner(this);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, values);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinner.setAdapter(adapter);
        return spinner;
    }

    private LinearLayout labeledView(String label, View child) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        TextView text = Ui.text(this, label, 12, Color.rgb(82, 96, 92), Typeface.BOLD);
        box.addView(text);
        box.addView(child, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 48)));
        box.setLayoutParams(Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 8)));
        return box;
    }

    private void renderAlerts(boolean animate) {
        content.addView(sectionHeader("Alerts", "Absence flags and system notifications."));

        LinearLayout quick = sectionCard("Notification Test", "Verify the 2-day flagged student alert on this phone.");
        Button test = compactButton("Send 2-day flagged alert", Ui.GREEN_DARK);
        test.setOnClickListener(v -> sendFlaggedNotificationTest());
        quick.addView(test, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 44)));
        content.addView(quick, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));

        LinearLayout flags = sectionCard("2-Day Absence Alerts", absenceFlags.length() + " active flag(s)");
        if (absenceFlags.length() == 0) {
            flags.addView(emptyText("No 2-day absentees detected."));
        } else {
            for (int i = 0; i < Math.min(absenceFlags.length(), 60); i++) {
                JSONObject row = absenceFlags.optJSONObject(i);
                if (row == null) continue;
                flags.addView(flaggedRow(row));
            }
        }
        content.addView(flags, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));

        renderRemoteArray("/api/notifications", rows -> {
            LinearLayout card = sectionCard("System Notifications", rows.length() + " latest item(s)");
            if (rows.length() == 0) {
                card.addView(emptyText("No notifications posted yet."));
            } else {
                for (int i = 0; i < Math.min(rows.length(), 40); i++) {
                    JSONObject row = rows.optJSONObject(i);
                    if (row == null) continue;
                    card.addView(recordRow(row.optString("title", "Notification"), row.optString("message", ""), row.optString("school_name", "All schools"), Ui.GREEN_DARK));
                }
            }
            content.addView(card);
            addLiveFooter();
            if (animate) Ui.reveal(card, 150);
        }, animate);

        if (animate) {
            Ui.reveal(quick, 60);
            Ui.reveal(flags, 100);
        }
    }

    private LinearLayout flaggedRow(JSONObject row) {
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setPadding(Ui.dp(this, 12), Ui.dp(this, 12), Ui.dp(this, 12), Ui.dp(this, 12));
        item.setBackground(Ui.strokeBg(Color.rgb(249, 251, 250), Color.rgb(224, 236, 231), Ui.dp(this, 18)));
        item.setLayoutParams(Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView icon = Ui.text(this, "!", 18, Ui.AMBER, Typeface.BOLD);
        icon.setGravity(Gravity.CENTER);
        icon.setBackground(Ui.bg(Color.rgb(255, 239, 223), Ui.dp(this, 14)));
        top.addView(icon, Ui.lp(Ui.dp(this, 46), Ui.dp(this, 46)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(Ui.text(this, row.optString("name", "Student"), 15, Ui.INK, Typeface.BOLD));
        copy.addView(Ui.text(this, row.optString("school_name", "School"), 12, Color.rgb(82, 96, 92), Typeface.NORMAL));
        TextView detail = Ui.text(this, absenceFlagSummary(row), 11, Color.rgb(106, 120, 116), Typeface.BOLD);
        detail.setLineSpacing(Ui.dp(this, 1), 1.0f);
        copy.addView(detail);
        top.addView(copy, Ui.marginLp(0, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 10), 0, 0, 0));
        ((LinearLayout.LayoutParams) copy.getLayoutParams()).weight = 1;
        item.addView(top);

        Button contact = compactButton("Please contact adviser", Ui.AMBER);
        contact.setTextSize(12);
        contact.setOnClickListener(v -> contactAdviser(row));
        item.addView(contact, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 40), 0, Ui.dp(this, 10), 0, 0));
        item.setOnClickListener(v -> contactAdviser(row));
        return item;
    }

    private void sendFlaggedNotificationTest() {
        if (absenceFlags.length() > 0) {
            JSONObject first = absenceFlags.optJSONObject(0);
            sendNotification(absenceTitle(absenceFlags.length()), first == null ? "Flagged student details unavailable." : absenceNotificationBody(first));
            return;
        }
        Toast.makeText(this, "No live 2-day flagged students found.", Toast.LENGTH_LONG).show();
    }

    private void contactAdviser(JSONObject row) {
        String adviser = row.optString("adviser", "").trim();
        String phone = firstNonEmpty(row.optString("adviser_contact", ""), row.optString("school_contact", ""));
        String student = row.optString("name", "flagged student");
        String school = row.optString("school_name", "");
        String message = "Please contact adviser about this 2-day absence flag."
                + "\n\nStudent: " + student
                + "\nGrade: " + valueOrDash(row.optString("grade_name", ""))
                + "\nSection: " + valueOrDash(row.optString("section_name", ""))
                + "\nLRN: " + valueOrDash(row.optString("lrn", ""))
                + "\nDays absent: " + row.optInt("absent_days", 2)
                + "\nSchool: " + school
                + "\nAdviser: " + (adviser.isEmpty() ? "Not assigned" : adviser);

        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle("Please contact adviser")
                .setMessage(message)
                .setNegativeButton("Close", null);
        if (!phone.isEmpty()) {
            builder.setPositiveButton("Call", (dialog, which) -> startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + phone))));
        } else {
            builder.setPositiveButton("OK", null);
        }
        builder.setNeutralButton("Share", (dialog, which) -> {
            Intent share = new Intent(Intent.ACTION_SEND);
            share.setType("text/plain");
            share.putExtra(Intent.EXTRA_TEXT, message);
            startActivity(Intent.createChooser(share, "Contact adviser"));
        });
        builder.show();
    }

    private String absenceFlagSummary(JSONObject row) {
        String grade = valueOrDash(row.optString("grade_name", ""));
        String section = valueOrDash(row.optString("section_name", ""));
        String lrn = valueOrDash(row.optString("lrn", ""));
        return readableSelectedDateFull() + " - " + grade + " - " + section + " - LRN " + lrn
                + " - " + row.optInt("absent_days", 2) + " days absent"
                + " - Adviser: " + valueOrDash(row.optString("adviser", ""));
    }

    private String absenceNotificationBody(JSONObject row) {
        return row.optString("name", "Student")
                + " | " + readableSelectedDateFull()
                + " | " + valueOrDash(row.optString("grade_name", ""))
                + " - " + valueOrDash(row.optString("section_name", ""))
                + " | LRN: " + valueOrDash(row.optString("lrn", ""))
                + " | " + row.optInt("absent_days", 2) + " days absent"
                + " | Adviser: " + valueOrDash(row.optString("adviser", ""));
    }

    private String valueOrDash(String value) {
        return value == null || value.trim().isEmpty() ? "-" : value.trim();
    }

    private void renderRemoteArray(String path, ArrayRenderer renderer) {
        renderRemoteArray(path, renderer, true);
    }

    private void renderRemoteArray(String path, ArrayRenderer renderer, boolean showLoading) {
        String tabAtRequest = currentTab;
        LinearLayout loading = showLoading ? inlineLoading("Fetching latest records...") : null;
        if (loading != null) {
            content.addView(loading, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, 0));
        }
        new Thread(() -> {
            try {
                JSONArray rows = new JSONArray(ApiClient.getRaw(this, path));
                runOnUiThread(() -> {
                    if (!tabAtRequest.equals(currentTab)) return;
                    if (loading != null) content.removeView(loading);
                    renderer.render(rows);
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception e) {
                runOnUiThread(() -> {
                    if (!tabAtRequest.equals(currentTab)) return;
                    if (loading != null) content.removeView(loading);
                    renderInlineError("Unable to fetch records", e.getMessage());
                    addLiveFooter();
                });
            }
        }).start();
    }

    private void renderRemoteObject(String path, ObjectRenderer renderer) {
        renderRemoteObject(path, renderer, true);
    }

    private void renderRemoteObject(String path, ObjectRenderer renderer, boolean showLoading) {
        String tabAtRequest = currentTab;
        LinearLayout loading = showLoading ? inlineLoading("Generating live report...") : null;
        if (loading != null) {
            content.addView(loading, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, 0));
        }
        new Thread(() -> {
            try {
                JSONObject json = ApiClient.getJson(this, path);
                runOnUiThread(() -> {
                    if (!tabAtRequest.equals(currentTab)) return;
                    if (loading != null) content.removeView(loading);
                    renderer.render(json);
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception e) {
                runOnUiThread(() -> {
                    if (!tabAtRequest.equals(currentTab)) return;
                    if (loading != null) content.removeView(loading);
                    renderInlineError("Unable to fetch report", e.getMessage());
                    addLiveFooter();
                });
            }
        }).start();
    }

    private LinearLayout sectionHeader(String title, String subtitle) {
        LinearLayout card = panel();
        card.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 12));
        card.setMinimumHeight(Ui.dp(this, 74));
        card.setLayoutParams(Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 12)));
        card.setBackground(Ui.gradient(Color.WHITE, Color.rgb(241, 253, 247), Ui.dp(this, 18)));
        card.addView(Ui.text(this, title, 21, Ui.INK, Typeface.BOLD));
        card.addView(Ui.text(this, subtitle, 12, Color.rgb(101, 116, 112), Typeface.NORMAL), Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 2), 0, 0));
        Ui.reveal(card, 20);
        return card;
    }

    private LinearLayout sectionCard(String title, String subtitle) {
        LinearLayout card = panel();
        card.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
        card.setMinimumHeight(Ui.dp(this, 92));
        card.setLayoutParams(Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 12)));
        TextView titleView = Ui.text(this, title, 16, Ui.INK, Typeface.BOLD);
        TextView subtitleView = Ui.text(this, subtitle, 11, Color.rgb(102, 116, 112), Typeface.NORMAL);
        card.addView(titleView);
        card.addView(subtitleView, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 1), 0, Ui.dp(this, 10)));
        return card;
    }

    private TextView emptyText(String value) {
        TextView empty = Ui.text(this, value, 13, Color.rgb(103, 116, 112), Typeface.NORMAL);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(0, Ui.dp(this, 16), 0, Ui.dp(this, 14));
        return empty;
    }

    private LinearLayout schoolHeaderRow(JSONObject school) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(Ui.dp(this, 10), Ui.dp(this, 9), Ui.dp(this, 10), Ui.dp(this, 9));
        row.setBackground(Ui.bg(Color.rgb(248, 251, 249), Ui.dp(this, 14)));

        ImageView logo = schoolLogoView(Ui.dp(this, 50));
        loadLogoInto(logo, school);
        row.addView(logo, Ui.lp(Ui.dp(this, 50), Ui.dp(this, 50)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(Ui.text(this, school.optString("name", "School"), 14, Ui.INK, Typeface.BOLD));
        copy.addView(Ui.text(this, school.optString("address", "No address saved"), 11, Color.rgb(82, 96, 92), Typeface.NORMAL));
        row.addView(copy, Ui.marginLp(0, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 10), 0, 0, 0));
        ((LinearLayout.LayoutParams) copy.getLayoutParams()).weight = 1;
        return row;
    }

    private LinearLayout compactSchoolRow(JSONObject school) {
        int enrolled = school.optInt("enrolled", school.optInt("enrollment", school.optInt("student_count")));
        int present = school.optInt("present");
        int rate = school.optInt("rate", enrolled > 0 ? Math.round((present * 100f) / enrolled) : 0);
        String detail = present + " of " + enrolled + " present - " + rate + "%";
        LinearLayout row = schoolRecordRow(school, school.optString("name", "School"), detail, school.optInt("teachers_present") + "/" + school.optInt("teachers_total") + " teachers", rate >= 75 ? Ui.GREEN_DARK : Ui.AMBER);
        row.setOnClickListener(v -> {
            selectedSchoolId = school.optInt("id", -1);
            selectedGradeId = -1;
            selectedSectionId = -1;
            currentTab = "schools";
            updateNav();
            renderCurrentTab(true);
        });
        return row;
    }

    private LinearLayout schoolRecordRow(JSONObject school, String title, String subtitle, String meta, int accent) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(Ui.dp(this, 74));
        row.setPadding(Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10));
        row.setBackground(Ui.bg(Color.rgb(248, 251, 249), Ui.dp(this, 14)));

        ImageView logo = schoolLogoView(Ui.dp(this, 44));
        loadLogoInto(logo, school);
        row.addView(logo, Ui.lp(Ui.dp(this, 44), Ui.dp(this, 44)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        TextView titleView = Ui.text(this, title == null || title.trim().isEmpty() ? "School" : title.trim(), 14, Ui.INK, Typeface.BOLD);
        TextView subView = Ui.text(this, subtitle == null ? "" : subtitle.trim(), 12, Color.rgb(82, 96, 92), Typeface.NORMAL);
        TextView metaView = Ui.text(this, meta == null ? "" : meta.trim(), 11, accent, Typeface.BOLD);
        copy.addView(titleView);
        if (!subView.getText().toString().isEmpty()) copy.addView(subView);
        if (!metaView.getText().toString().isEmpty()) copy.addView(metaView);
        row.addView(copy, Ui.marginLp(0, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 10), 0, 0, 0));
        ((LinearLayout.LayoutParams) copy.getLayoutParams()).weight = 1;

        TextView arrow = Ui.text(this, ">", 16, accent, Typeface.BOLD);
        row.addView(arrow, Ui.lp(Ui.dp(this, 18), LinearLayout.LayoutParams.WRAP_CONTENT));
        row.setLayoutParams(Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
        return row;
    }

    private ImageView schoolLogoView(int sizePx) {
        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        logo.setPadding(Ui.dp(this, 4), Ui.dp(this, 4), Ui.dp(this, 4), Ui.dp(this, 4));
        logo.setBackground(Ui.strokeBg(Color.WHITE, Color.rgb(217, 236, 226), Ui.dp(this, 13)));
        logo.setMinimumWidth(sizePx);
        logo.setMinimumHeight(sizePx);
        return logo;
    }

    private void loadLogoInto(ImageView image, JSONObject school) {
        String logo = school == null ? "" : school.optString("logo", "").trim();
        if (logo.isEmpty()) return;
        if (logo.startsWith("data:image/")) {
            int comma = logo.indexOf(',');
            if (comma > 0) {
                try {
                    byte[] bytes = Base64.decode(logo.substring(comma + 1), Base64.DEFAULT);
                    Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                    if (bitmap != null) image.setImageBitmap(bitmap);
                } catch (Exception ignored) {}
            }
            return;
        }
        if (logo.startsWith("/") || logo.startsWith("http://") || logo.startsWith("https://")) {
            new Thread(() -> {
                try {
                    byte[] bytes = ApiClient.getBytes(this, logo);
                    Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                    if (bitmap != null) runOnUiThread(() -> image.setImageBitmap(bitmap));
                } catch (Exception ignored) {}
            }).start();
        }
    }

    private String studentName(JSONObject student) {
        String first = student.optString("firstname", "").trim();
        String last = student.optString("lastname", "").trim();
        String full = (first + " " + last).trim();
        return full.isEmpty() ? "Student" : full;
    }

    private String studentMeta(JSONObject student) {
        String lrn = student.optString("lrn", "").trim();
        String status = formatStatusLabel(student.optString("status", "").trim());
        String meta = "";
        if (!lrn.isEmpty()) meta += " - " + lrn;
        if (!status.isEmpty() && !"-".equals(status)) meta += " - " + status;
        return meta;
    }

    private String formatStatusLabel(String value) {
        String raw = value == null ? "" : value.trim();
        if (raw.isEmpty() || "null".equalsIgnoreCase(raw)) return "-";
        String key = raw.replace('_', ' ').toLowerCase(Locale.US);
        switch (key) {
            case "present": return "Present";
            case "absent": return "Absent";
            case "late": return "Late";
            case "inactive": return "Inactive";
            case "active": return "Active";
            case "flagged": return "Flagged";
            case "pending time out": return "Pending Time Out";
            case "no time out": return "No Time Out";
            case "no time in": return "No Time In";
            case "complete": return "Complete";
            default:
                String[] parts = key.split("\\s+");
                StringBuilder out = new StringBuilder();
                for (String part : parts) {
                    if (part.isEmpty()) continue;
                    if (out.length() > 0) out.append(' ');
                    out.append(part.substring(0, 1).toUpperCase(Locale.US)).append(part.substring(1));
                }
                return out.length() == 0 ? raw : out.toString();
        }
    }

    private LinearLayout recordRow(String title, String subtitle, String meta, int accent) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(Ui.dp(this, 68));
        row.setPadding(Ui.dp(this, 10), Ui.dp(this, 11), Ui.dp(this, 10), Ui.dp(this, 11));
        row.setBackground(Ui.bg(Color.rgb(248, 251, 249), Ui.dp(this, 12)));

        TextView marker = Ui.text(this, "", 1, accent, Typeface.BOLD);
        marker.setBackground(Ui.bg(accent, Ui.dp(this, 4)));
        row.addView(marker, Ui.lp(Ui.dp(this, 4), Ui.dp(this, 42)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        TextView titleView = Ui.text(this, title == null || title.trim().isEmpty() ? "Untitled" : title.trim(), 14, Ui.INK, Typeface.BOLD);
        TextView subView = Ui.text(this, subtitle == null ? "" : subtitle.trim(), 12, Color.rgb(82, 96, 92), Typeface.NORMAL);
        TextView metaView = Ui.text(this, meta == null ? "" : meta.trim(), 11, Color.rgb(106, 120, 116), Typeface.BOLD);
        copy.addView(titleView);
        if (!subView.getText().toString().isEmpty()) copy.addView(subView);
        if (!metaView.getText().toString().isEmpty()) copy.addView(metaView);
        row.addView(copy, Ui.marginLp(0, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 10), 0, 0, 0));
        ((LinearLayout.LayoutParams) copy.getLayoutParams()).weight = 1;
        LinearLayout.LayoutParams lp = Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10));
        row.setLayoutParams(lp);
        return row;
    }

    private GridLayout metricGrid() {
        GridLayout grid = new GridLayout(this);
        grid.setColumnCount(2);
        grid.setUseDefaultMargins(false);
        return grid;
    }

    private void addMetric(GridLayout grid, String label, int value, String caption, int iconBg, int accent) {
        LinearLayout card = panel();
        card.setPadding(Ui.dp(this, 12), Ui.dp(this, 11), Ui.dp(this, 12), Ui.dp(this, 11));
        card.setMinimumHeight(Ui.dp(this, 86));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView dot = Ui.text(this, label.substring(0, 1), 13, accent, Typeface.BOLD);
        dot.setGravity(Gravity.CENTER);
        dot.setBackground(Ui.bg(iconBg, Ui.dp(this, 12)));
        row.addView(dot, Ui.lp(Ui.dp(this, 38), Ui.dp(this, 38)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        TextView num = Ui.text(this, String.valueOf(value), 23, Ui.INK, Typeface.BOLD);
        TextView lab = Ui.text(this, label, 11, Color.rgb(79, 90, 90), Typeface.BOLD);
        TextView cap = Ui.text(this, caption, 9, Color.rgb(116, 130, 126), Typeface.NORMAL);
        copy.addView(num);
        copy.addView(lab);
        copy.addView(cap);
        row.addView(copy, Ui.marginLp(0, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 10), 0, 0, 0));
        ((LinearLayout.LayoutParams) copy.getLayoutParams()).weight = 1;
        card.addView(row);

        GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
        lp.width = 0;
        lp.height = GridLayout.LayoutParams.WRAP_CONTENT;
        lp.columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f);
        lp.setMargins(0, 0, Ui.dp(this, 8), Ui.dp(this, 8));
        grid.addView(card, lp);
    }

    private LinearLayout panel() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setBackground(Ui.strokeBg(Color.WHITE, Color.rgb(227, 235, 231), Ui.dp(this, 18)));
        Ui.elevate(view, 4);
        return view;
    }

    private LinearLayout inlineLoading(String text) {
        LinearLayout row = panel();
        row.setGravity(Gravity.CENTER);
        row.setPadding(Ui.dp(this, 14), Ui.dp(this, 24), Ui.dp(this, 14), Ui.dp(this, 24));
        ProgressBar spinner = new ProgressBar(this);
        row.addView(spinner, Ui.lp(Ui.dp(this, 36), Ui.dp(this, 36)));
        TextView label = Ui.text(this, text, 13, Ui.GREEN_DARK, Typeface.BOLD);
        row.addView(label, Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 10), 0, 0, 0));
        Ui.reveal(row, 10);
        return row;
    }

    private void renderLoading(String message) {
        content.removeAllViews();
        LinearLayout card = inlineLoading(message);
        content.addView(card);
    }

    private void renderError(String title, String message) {
        content.removeAllViews();
        renderInlineError(title, message);
    }

    private void renderInlineError(String title, String message) {
        LinearLayout card = panel();
        card.setPadding(Ui.dp(this, 16), Ui.dp(this, 16), Ui.dp(this, 16), Ui.dp(this, 16));
        card.setBackground(Ui.strokeBg(Color.rgb(255, 245, 245), Color.rgb(252, 165, 165), Ui.dp(this, 18)));
        card.addView(Ui.text(this, title, 16, Ui.RED, Typeface.BOLD));
        card.addView(Ui.text(this, message == null || message.trim().isEmpty() ? "Please check the connection and try again." : message, 12, Color.rgb(115, 61, 61), Typeface.NORMAL), Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 4), 0, 0));
        content.addView(card, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, Ui.dp(this, 8)));
    }

    private void addLiveFooter() {
        liveStatus = Ui.text(this, "LIVE", 11, Ui.GREEN_DARK, Typeface.BOLD);
        liveStatus.setGravity(Gravity.CENTER);
        content.addView(liveStatus, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 10), 0, 0));
    }

    private Button headerButton(String text) {
        Button button = compactButton(text, Color.argb(42, 255, 255, 255));
        button.setTextSize(12);
        button.setTextColor(Color.WHITE);
        button.setBackground(Ui.strokeBg(Color.argb(42, 255, 255, 255), Color.argb(64, 255, 255, 255), Ui.dp(this, 15)));
        return button;
    }

    private Button compactButton(String text, int color) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextColor(Color.WHITE);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setAllCaps(false);
        button.setTextSize(13);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setPadding(Ui.dp(this, 8), 0, Ui.dp(this, 8), 0);
        button.setBackground(Ui.bg(color, Ui.dp(this, 14)));
        return button;
    }

    private TextView chip(String text) {
        TextView chip = Ui.text(this, text, 11, Color.WHITE, Typeface.BOLD);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(Ui.dp(this, 10), 0, Ui.dp(this, 10), 0);
        chip.setMinWidth(Ui.dp(this, text != null && text.matches("\\d{4}-\\d{2}-\\d{2}") ? 104 : 74));
        chip.setBackground(Ui.bg(Color.argb(34, 255, 255, 255), Ui.dp(this, 12)));
        return chip;
    }

    private LinearLayout liveChip() {
        LinearLayout chip = new LinearLayout(this);
        chip.setGravity(Gravity.CENTER);
        chip.setOrientation(LinearLayout.HORIZONTAL);
        chip.setPadding(Ui.dp(this, 10), 0, Ui.dp(this, 10), 0);
        chip.setBackground(Ui.bg(Color.argb(34, 255, 255, 255), Ui.dp(this, 12)));
        TextView dot = new TextView(this);
        dot.setBackground(Ui.bg(Ui.RED, Ui.dp(this, 4)));
        chip.addView(dot, Ui.lp(Ui.dp(this, 7), Ui.dp(this, 7)));
        TextView label = Ui.text(this, "LIVE", 11, Color.WHITE, Typeface.BOLD);
        chip.addView(label, Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 6), 0, 0, 0));
        chip.setLayoutParams(Ui.lp(LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 28)));
        return chip;
    }

    private void setLoading(boolean loading) {
        if (progress != null) progress.setVisibility(loading && !dashboardReady ? View.VISIBLE : View.GONE);
        if (refreshButton != null) {
            refreshButton.setEnabled(true);
            refreshButton.setText("");
        }
    }

    private void updateLiveText(String text) {
        if (liveStatus != null) liveStatus.setText("LIVE");
    }

    private void logout() {
        handler.removeCallbacksAndMessages(null);
        SessionStore.clear(this);
        AbsenceWorker.cancel(this);
        startActivity(new Intent(this, LoginActivity.class));
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
        finish();
    }

    private void goToLogin() {
        SessionStore.clear(this);
        startActivity(new Intent(this, LoginActivity.class));
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
        finish();
    }

    private int activeStudents() {
        int active = dashboard.optInt("attendance_eligible_students", dashboard.optInt("active_students", dashboard.optInt("total_students")));
        return Math.max(0, active);
    }

    private String greeting() {
        int hour = Integer.parseInt(new SimpleDateFormat("H", Locale.US).format(new Date()));
        if (hour < 12) return "Good morning";
        if (hour < 18) return "Good afternoon";
        return "Good evening";
    }

    private String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    private String readableDate() {
        return new SimpleDateFormat("EEE, MMM d", Locale.US).format(new Date());
    }

    private String readableSelectedDateFull() {
        try {
            Date date = new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(selectedDate);
            return new SimpleDateFormat("EEEE, MMMM d, yyyy", Locale.US).format(date);
        } catch (Exception e) {
            return new SimpleDateFormat("EEEE, MMMM d, yyyy", Locale.US).format(new Date());
        }
    }

    private String nonSchoolDayAlertText() {
        String reason = dashboard.optString("non_school_day_reason", "").trim();
        if (reason.isEmpty() || reason.matches("^[A-Za-z]+$")) {
            reason = "No classes today. Attendance data is shown for reference only.";
        }
        return readableSelectedDateFull() + ": " + reason;
    }

    private String timeNow() {
        return new SimpleDateFormat("h:mm:ss a", Locale.US).format(new Date());
    }

    private String shortTime(String value) {
        if (value == null || value.trim().isEmpty() || "null".equalsIgnoreCase(value)) return "--";
        String clean = value.trim();
        return clean.length() >= 5 ? clean.substring(0, 5) : clean;
    }

    private String firstNonEmpty(String first, String second) {
        String a = first == null ? "" : first.trim();
        if (!a.isEmpty()) return a;
        return second == null ? "" : second.trim();
    }

    private String compactName(String name) {
        String clean = name == null || name.trim().isEmpty() ? "Division User" : name.trim();
        return clean.length() > 34 ? clean.substring(0, 31) + "..." : clean;
    }

    private String compactLabel(String value, int limit) {
        String clean = value == null || value.trim().isEmpty() ? "" : value.trim();
        if (clean.length() <= limit) return clean;
        return clean.substring(0, Math.max(0, limit - 3)) + "...";
    }

    private String roleLabel() {
        String role = SessionStore.prefs(this).getString("role", "division");
        if ("super_admin".equals(role)) return "System admin";
        if ("superintendent".equals(role)) return "Superintendent";
        if ("asst_superintendent".equals(role)) return "Assistant superintendent";
        if ("principal".equals(role)) return "School";
        return "Division";
    }

    private boolean isSuperAdmin() {
        return "super_admin".equals(SessionStore.prefs(this).getString("role", "division"));
    }

    private String roleDisplay(String role) {
        if ("super_admin".equals(role)) return "Super Administrator";
        if ("superintendent".equals(role)) return "SDS";
        if ("asst_superintendent".equals(role)) return "ASDS";
        if ("principal".equals(role)) return "School Administrator";
        return role == null || role.trim().isEmpty() ? "User" : role.replace("_", " ");
    }

    private void notifyAbsenceFlags(JSONArray flags) {
        if (flags == null || flags.length() == 0) return;
        String key = today() + ":" + flags.length();
        String last = SessionStore.prefs(this).getString("last_native_absence_notification", "");
        if (key.equals(last)) return;
        JSONObject first = flags.optJSONObject(0);
        sendNotification(absenceTitle(flags.length()), first == null ? "Flagged student details unavailable." : absenceNotificationBody(first), false);
        SessionStore.prefs(this).edit().putString("last_native_absence_notification", key).apply();
    }

    private void sendNotification(String title, String body) {
        sendNotification(title, body, true);
    }

    private void sendNotification(String title, String body, boolean showToast) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 42);
            if (showToast) Toast.makeText(this, "Allow notifications, then try again.", Toast.LENGTH_LONG).show();
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Edutrack Alerts", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Attendance monitoring alerts and notification tests.");
            manager.createNotificationChannel(channel);
        }
        Intent intent = new Intent(this, DashboardActivity.class);
        intent.putExtra("tab", "alerts");
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 3001, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH);
        manager.notify(3001, builder.build());
        if (showToast) Toast.makeText(this, "Notification sent.", Toast.LENGTH_SHORT).show();
    }

    private String absenceTitle(int count) {
        return count == 1 ? "1 student absent 2+ days" : count + " students absent 2+ days";
    }

    private void sendWelcomeNotification() {
        String name = compactName(SessionStore.getFullname(this));
        sendNotification("WELCOME", greeting() + ", " + name, false);
    }

    private interface ArrayRenderer {
        void render(JSONArray rows);
    }

    private interface ObjectRenderer {
        void render(JSONObject json);
    }
}
