package ph.gov.sipalay.attendance;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.GridLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
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
    private static final long POLL_MS = 3000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, TextView> navItems = new LinkedHashMap<>();

    private LinearLayout content;
    private ProgressBar progress;
    private TextView liveStatus;
    private TextView dateChip;
    private Button refreshButton;

    private JSONObject dashboard = new JSONObject();
    private JSONArray absenceFlags = new JSONArray();
    private String currentTab = "dashboard";
    private String lastHash = "";
    private String selectedDate = "";
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
        AbsenceWorker.schedule(this);
        buildShell();
        renderLoading("Syncing live records...");
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
        header.setPadding(Ui.dp(this, 16), Ui.dp(this, 12), Ui.dp(this, 16), Ui.dp(this, 12));
        header.setBackground(Ui.verticalGradient(Ui.GREEN, Ui.GREEN_DARK, 0));
        Ui.elevate(header, 8);

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setBackground(Ui.strokeBg(Color.argb(38, 255, 255, 255), Color.argb(72, 255, 255, 255), Ui.dp(this, 16)));
        logo.setPadding(Ui.dp(this, 5), Ui.dp(this, 5), Ui.dp(this, 5), Ui.dp(this, 5));
        top.addView(logo, Ui.lp(Ui.dp(this, 44), Ui.dp(this, 44)));

        LinearLayout titleBox = new LinearLayout(this);
        titleBox.setOrientation(LinearLayout.VERTICAL);
        TextView app = Ui.text(this, "EduTrack", 18, Color.WHITE, Typeface.BOLD);
        TextView user = Ui.text(this, compactName(SessionStore.getFullname(this)), 12, Color.rgb(222, 255, 242), Typeface.NORMAL);
        titleBox.addView(app);
        titleBox.addView(user);
        LinearLayout.LayoutParams titleLp = Ui.marginLp(0, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 10), 0, Ui.dp(this, 8), 0);
        titleLp.weight = 1;
        top.addView(titleBox, titleLp);

        refreshButton = headerButton("Sync");
        refreshButton.setOnClickListener(v -> loadDashboard(true));
        top.addView(refreshButton, Ui.marginLp(Ui.dp(this, 68), Ui.dp(this, 42), 0, 0, Ui.dp(this, 8), 0));

        Button logout = headerButton("Out");
        logout.setOnClickListener(v -> logout());
        top.addView(logout, Ui.lp(Ui.dp(this, 58), Ui.dp(this, 42)));
        header.addView(top);

        LinearLayout chips = new LinearLayout(this);
        chips.setGravity(Gravity.CENTER_VERTICAL);
        chips.addView(chip("Live data"));
        chips.addView(chip(readableDate()), Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 30), Ui.dp(this, 8), 0, 0, 0));
        dateChip = chip(selectedDate);
        chips.addView(dateChip, Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 30), Ui.dp(this, 8), 0, 0, 0));
        header.addView(chips, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 34), 0, Ui.dp(this, 10), 0, 0));
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
        content.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 18));
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));

        root.addView(bottomNav());
        setContentView(root);
    }

    private LinearLayout bottomNav() {
        LinearLayout nav = new LinearLayout(this);
        nav.setGravity(Gravity.CENTER);
        nav.setPadding(Ui.dp(this, 6), Ui.dp(this, 6), Ui.dp(this, 6), Ui.dp(this, 6));
        nav.setBackgroundColor(Color.WHITE);
        Ui.elevate(nav, 12);
        addNav(nav, "dashboard", "Home");
        addNav(nav, "attendance", "Attendance");
        addNav(nav, "schools", "Schools");
        addNav(nav, "reports", "Reports");
        addNav(nav, "alerts", "Alerts");
        updateNav();
        return nav;
    }

    private void addNav(LinearLayout nav, String tab, String label) {
        TextView item = Ui.text(this, label, 10, Color.rgb(70, 86, 82), Typeface.BOLD);
        item.setGravity(Gravity.CENTER);
        item.setPadding(Ui.dp(this, 2), 0, Ui.dp(this, 2), 0);
        item.setOnClickListener(v -> switchTab(tab));
        navItems.put(tab, item);
        nav.addView(item, new LinearLayout.LayoutParams(0, Ui.dp(this, 56), 1));
    }

    private void switchTab(String tab) {
        if (tab.equals(currentTab) && dashboardReady) return;
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
            item.setBackground(active ? Ui.bg(Ui.GREEN_SOFT, Ui.dp(this, 14)) : Ui.bg(Color.TRANSPARENT, Ui.dp(this, 14)));
        }
    }

    private void loadDashboard(boolean visible) {
        if (fetching) return;
        fetching = true;
        setLoading(visible);
        new Thread(() -> {
            try {
                String date = today();
                JSONObject freshDashboard = ApiClient.getJson(this, "/api/dashboard-data?date=" + date);
                JSONArray freshFlags = new JSONArray(ApiClient.getRaw(this, "/api/absence-flags?days=2"));
                JSONObject poll = ApiClient.getJson(this, "/api/realtime-poll?hash=" + lastHash);
                runOnUiThread(() -> {
                    selectedDate = date;
                    dashboard = freshDashboard;
                    absenceFlags = freshFlags;
                    lastHash = poll.optString("hash", lastHash);
                    dashboardReady = true;
                    setLoading(false);
                    if (dateChip != null) dateChip.setText(selectedDate);
                    renderCurrentTab(true);
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
                        updateLiveText("Live. Checked " + timeNow());
                    }
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception ignored) {
                runOnUiThread(() -> updateLiveText("Live check failed. Retrying..."));
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
            TextView note = Ui.text(this, dashboard.optString("non_school_day_reason", "No classes today."), 13, Color.rgb(141, 71, 0), Typeface.BOLD);
            note.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
            note.setBackground(Ui.strokeBg(Color.rgb(255, 248, 232), Color.rgb(252, 190, 93), Ui.dp(this, 14)));
            content.addView(note, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
        }

        GridLayout grid = metricGrid();
        addMetric(grid, "Students", dashboard.optInt("total_students"), "total", Ui.GREEN_SOFT, Ui.GREEN_DARK);
        addMetric(grid, "Present", dashboard.optInt("students_present"), "today", Ui.GREEN_SOFT, Ui.GREEN_DARK);
        addMetric(grid, "Absent", dashboard.optInt("students_absent"), "now", Color.rgb(255, 239, 239), Ui.RED);
        addMetric(grid, "2-Day", absenceFlags.length(), "flagged", Color.rgb(255, 248, 231), Ui.AMBER);
        addMetric(grid, "Teachers", dashboard.optInt("total_teachers"), "active", Color.rgb(234, 250, 255), Ui.GREEN_DARK);
        addMetric(grid, "T. Present", dashboard.optInt("teachers_present"), "today", Ui.GREEN_SOFT, Ui.GREEN_DARK);
        content.addView(grid);
        if (animate) Ui.reveal(grid, 90);

        addCompactActions(animate);
        addSchoolPreview(animate);
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
        test.setOnClickListener(v -> sendNotification("EduTrack test alert", "Notifications are working on this phone."));
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
        });
    }

    private void renderSchools(boolean animate) {
        content.addView(sectionHeader("Schools", "Native list synced from the web-based system."));
        renderRemoteArray("/api/schools", rows -> {
            LinearLayout card = sectionCard("School Directory", rows.length() + " school(s)");
            if (rows.length() == 0) {
                card.addView(emptyText("No schools available."));
            } else {
                for (int i = 0; i < rows.length(); i++) {
                    JSONObject school = rows.optJSONObject(i);
                    if (school == null) continue;
                    String detail = school.optInt("student_count") + " students - " + school.optInt("teacher_count") + " teachers";
                    String sub = school.optString("address", "No address saved");
                    card.addView(recordRow(school.optString("name", "School"), sub, detail, Ui.GREEN_DARK));
                }
            }
            content.addView(card);
            addLiveFooter();
            if (animate) Ui.reveal(card, 80);
        });
    }

    private void renderReports(boolean animate) {
        content.addView(sectionHeader("Reports", "Daily summary, absentee list, and school rates."));
        renderRemoteObject("/api/reports/daily-summary?date=" + selectedDate, summary -> {
            JSONObject totals = summary.optJSONObject("totals");
            JSONArray schools = summary.optJSONArray("schools");
            if (totals == null) totals = new JSONObject();

            LinearLayout totalsCard = sectionCard("Daily Summary", "Updated " + timeNow());
            GridLayout grid = metricGrid();
            addMetric(grid, "Enrolled", totals.optInt("enrolled"), "students", Ui.GREEN_SOFT, Ui.GREEN_DARK);
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
        });
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
        });
    }

    private void renderAlerts(boolean animate) {
        content.addView(sectionHeader("Alerts", "Absence flags and system notifications."));

        LinearLayout quick = sectionCard("Notification Test", "Send a sample alert to this phone.");
        Button test = compactButton("Send sample notification", Ui.GREEN_DARK);
        test.setOnClickListener(v -> sendNotification("1 Student Absent 2+ Days", "Flagged student: Sample Learner (SCH-001)"));
        quick.addView(test, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 44)));
        content.addView(quick, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));

        LinearLayout flags = sectionCard("2-Day Absence Alerts", absenceFlags.length() + " active flag(s)");
        if (absenceFlags.length() == 0) {
            flags.addView(emptyText("No 2-day absentees detected."));
        } else {
            for (int i = 0; i < Math.min(absenceFlags.length(), 60); i++) {
                JSONObject row = absenceFlags.optJSONObject(i);
                if (row == null) continue;
                flags.addView(recordRow(row.optString("name", "Student"), row.optString("school_name", ""), row.optString("absent_days", "2") + " consecutive days", Ui.AMBER));
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
        });

        if (animate) {
            Ui.reveal(quick, 60);
            Ui.reveal(flags, 100);
        }
    }

    private void renderRemoteArray(String path, ArrayRenderer renderer) {
        String tabAtRequest = currentTab;
        LinearLayout loading = inlineLoading("Fetching latest records...");
        content.addView(loading, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, 0));
        new Thread(() -> {
            try {
                JSONArray rows = new JSONArray(ApiClient.getRaw(this, path));
                runOnUiThread(() -> {
                    if (!tabAtRequest.equals(currentTab)) return;
                    content.removeView(loading);
                    renderer.render(rows);
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception e) {
                runOnUiThread(() -> {
                    if (!tabAtRequest.equals(currentTab)) return;
                    content.removeView(loading);
                    renderInlineError("Unable to fetch records", e.getMessage());
                    addLiveFooter();
                });
            }
        }).start();
    }

    private void renderRemoteObject(String path, ObjectRenderer renderer) {
        String tabAtRequest = currentTab;
        LinearLayout loading = inlineLoading("Generating live report...");
        content.addView(loading, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, 0));
        new Thread(() -> {
            try {
                JSONObject json = ApiClient.getJson(this, path);
                runOnUiThread(() -> {
                    if (!tabAtRequest.equals(currentTab)) return;
                    content.removeView(loading);
                    renderer.render(json);
                });
            } catch (SecurityException e) {
                runOnUiThread(this::goToLogin);
            } catch (Exception e) {
                runOnUiThread(() -> {
                    if (!tabAtRequest.equals(currentTab)) return;
                    content.removeView(loading);
                    renderInlineError("Unable to fetch report", e.getMessage());
                    addLiveFooter();
                });
            }
        }).start();
    }

    private LinearLayout sectionHeader(String title, String subtitle) {
        LinearLayout card = panel();
        card.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 12));
        card.setBackground(Ui.gradient(Color.WHITE, Color.rgb(241, 253, 247), Ui.dp(this, 18)));
        card.addView(Ui.text(this, title, 21, Ui.INK, Typeface.BOLD));
        card.addView(Ui.text(this, subtitle, 12, Color.rgb(101, 116, 112), Typeface.NORMAL), Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 2), 0, 0));
        Ui.reveal(card, 20);
        return card;
    }

    private LinearLayout sectionCard(String title, String subtitle) {
        LinearLayout card = panel();
        card.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
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

    private LinearLayout compactSchoolRow(JSONObject school) {
        int enrolled = school.optInt("enrolled", school.optInt("enrollment", school.optInt("student_count")));
        int present = school.optInt("present");
        int rate = school.optInt("rate", enrolled > 0 ? Math.round((present * 100f) / enrolled) : 0);
        String detail = present + " of " + enrolled + " present - " + rate + "%";
        return recordRow(school.optString("name", "School"), detail, school.optInt("teachers_present") + "/" + school.optInt("teachers_total") + " teachers", rate >= 75 ? Ui.GREEN_DARK : Ui.AMBER);
    }

    private LinearLayout recordRow(String title, String subtitle, String meta, int accent) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10));
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
        LinearLayout.LayoutParams lp = Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 8));
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
        card.setMinimumHeight(Ui.dp(this, 78));

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
        liveStatus = Ui.text(this, "Live. Updated " + timeNow(), 11, Color.rgb(93, 108, 104), Typeface.NORMAL);
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
        chip.setBackground(Ui.bg(Color.argb(34, 255, 255, 255), Ui.dp(this, 12)));
        return chip;
    }

    private void setLoading(boolean loading) {
        if (progress != null) progress.setVisibility(loading ? View.VISIBLE : View.GONE);
        if (refreshButton != null) {
            refreshButton.setEnabled(!loading);
            refreshButton.setText(loading ? "..." : "Sync");
        }
    }

    private void updateLiveText(String text) {
        if (liveStatus != null) liveStatus.setText(text);
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
        int active = dashboard.optInt("active_students", dashboard.optInt("total_students"));
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

    private String timeNow() {
        return new SimpleDateFormat("h:mm:ss a", Locale.US).format(new Date());
    }

    private String shortTime(String value) {
        if (value == null || value.trim().isEmpty() || "null".equalsIgnoreCase(value)) return "--";
        String clean = value.trim();
        return clean.length() >= 5 ? clean.substring(0, 5) : clean;
    }

    private String compactName(String name) {
        String clean = name == null || name.trim().isEmpty() ? "Division User" : name.trim();
        return clean.length() > 34 ? clean.substring(0, 31) + "..." : clean;
    }

    private String roleLabel() {
        String role = SessionStore.prefs(this).getString("role", "division");
        if ("super_admin".equals(role)) return "System admin";
        if ("superintendent".equals(role)) return "Superintendent";
        if ("asst_superintendent".equals(role)) return "Assistant superintendent";
        if ("principal".equals(role)) return "School";
        return "Division";
    }

    private void notifyAbsenceFlags(JSONArray flags) {
        if (flags == null || flags.length() == 0) return;
        String key = today() + ":" + flags.length();
        String last = SessionStore.prefs(this).getString("last_native_absence_notification", "");
        if (key.equals(last)) return;
        JSONObject first = flags.optJSONObject(0);
        String name = first == null ? "student" : first.optString("name", "student");
        sendNotification(flags.length() + " Students Absent 2+ Days", "Flagged students: " + name);
        SessionStore.prefs(this).edit().putString("last_native_absence_notification", key).apply();
    }

    private void sendNotification(String title, String body) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 42);
            Toast.makeText(this, "Allow notifications, then try again.", Toast.LENGTH_LONG).show();
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "EduTrack Alerts", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Attendance monitoring alerts and notification tests.");
            manager.createNotificationChannel(channel);
        }
        Intent intent = new Intent(this, DashboardActivity.class);
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
        Toast.makeText(this, "Notification sent.", Toast.LENGTH_SHORT).show();
    }

    private interface ArrayRenderer {
        void render(JSONArray rows);
    }

    private interface ObjectRenderer {
        void render(JSONObject json);
    }
}
