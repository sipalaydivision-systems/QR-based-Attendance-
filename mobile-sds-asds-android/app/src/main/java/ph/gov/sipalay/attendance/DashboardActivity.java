package ph.gov.sipalay.attendance;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
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
import java.util.Locale;

public class DashboardActivity extends Activity {
    private static final String CHANNEL_ID = "mobile_app_alerts";
    private static final long POLL_MS = 3000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private LinearLayout content;
    private ProgressBar progress;
    private TextView liveStatus;
    private Button refresh;
    private boolean fetching = false;
    private boolean hasRendered = false;
    private String lastHash = "";

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
        Ui.setBars(getWindow(), Ui.GREEN_DARK, false, android.graphics.Color.WHITE);
        AbsenceWorker.schedule(this);
        buildShell();
        renderLoading();
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
        root.setBackgroundColor(android.graphics.Color.rgb(246, 248, 247));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setPadding(Ui.dp(this, 16), Ui.dp(this, 12), Ui.dp(this, 16), Ui.dp(this, 12));
        header.setBackground(Ui.gradient(Ui.GREEN, Ui.GREEN_DARK, 0));
        Ui.elevate(header, 8);

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        top.addView(logo, Ui.lp(Ui.dp(this, 42), Ui.dp(this, 42)));

        LinearLayout titleBox = new LinearLayout(this);
        titleBox.setOrientation(LinearLayout.VERTICAL);
        TextView app = Ui.text(this, "EduTrack", 18, android.graphics.Color.WHITE, Typeface.BOLD);
        TextView user = Ui.text(this, SessionStore.getFullname(this), 12, android.graphics.Color.rgb(222, 255, 242), Typeface.NORMAL);
        titleBox.addView(app);
        titleBox.addView(user);
        LinearLayout.LayoutParams titleLp = Ui.marginLp(0, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 10), 0, Ui.dp(this, 8), 0);
        titleLp.weight = 1;
        top.addView(titleBox, titleLp);

        refresh = headerButton("Refresh");
        refresh.setOnClickListener(v -> loadDashboard(true));
        top.addView(refresh);

        Button logout = headerButton("Logout");
        logout.setOnClickListener(v -> {
            handler.removeCallbacksAndMessages(null);
            SessionStore.clear(this);
            AbsenceWorker.cancel(this);
            startActivity(new Intent(this, LoginActivity.class));
            overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
            finish();
        });
        top.addView(logout, Ui.marginLp(Ui.dp(this, 72), Ui.dp(this, 44), Ui.dp(this, 8), 0, 0, 0));
        header.addView(top);

        LinearLayout chips = new LinearLayout(this);
        chips.setGravity(Gravity.CENTER_VERTICAL);
        chips.addView(chip("Real-time"));
        chips.addView(chip(new SimpleDateFormat("EEE, MMM d", Locale.US).format(new Date())), Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 32), Ui.dp(this, 8), 0, 0, 0));
        chips.addView(chip(new SimpleDateFormat("MM/dd/yyyy", Locale.US).format(new Date())), Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 32), Ui.dp(this, 8), 0, 0, 0));
        header.addView(chips, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 36), 0, Ui.dp(this, 10), 0, 0));
        root.addView(header);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setVisibility(View.GONE);
        root.addView(progress, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 3)));

        ScrollView scroll = new ScrollView(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 18));
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        root.addView(bottomNav());
        setContentView(root);
    }

    private void loadDashboard(boolean visible) {
        if (fetching) return;
        fetching = true;
        setLoading(visible || !hasRendered);
        new Thread(() -> {
            try {
                String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
                JSONObject dashboard = ApiClient.getJson(this, "/api/dashboard-data?date=" + today);
                JSONArray flags = new JSONArray(ApiClient.getRaw(this, "/api/absence-flags?days=2"));
                JSONObject poll = ApiClient.getJson(this, "/api/realtime-poll?hash=" + lastHash);
                runOnUiThread(() -> {
                    lastHash = poll.optString("hash", lastHash);
                    render(dashboard, flags);
                    notifyAbsenceFlags(flags);
                });
            } catch (SecurityException e) {
                runOnUiThread(() -> {
                    SessionStore.clear(this);
                    startActivity(new Intent(this, LoginActivity.class));
                    overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
                    finish();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    setLoading(false);
                    if (liveStatus != null) liveStatus.setText("Offline. Retrying...");
                    if (!hasRendered) Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
                });
            } finally {
                runOnUiThread(() -> fetching = false);
            }
        }).start();
    }

    private void pollServerChanges() {
        if (fetching || !hasRendered) return;
        new Thread(() -> {
            try {
                JSONObject poll = ApiClient.getJson(this, "/api/realtime-poll?hash=" + lastHash);
                boolean changed = poll.optBoolean("changed", false);
                String hash = poll.optString("hash", lastHash);
                runOnUiThread(() -> {
                    if (changed) {
                        lastHash = hash;
                        loadDashboard(false);
                    } else if (liveStatus != null) {
                        liveStatus.setText("Live. Checked " + new SimpleDateFormat("h:mm:ss a", Locale.US).format(new Date()));
                    }
                });
            } catch (Exception ignored) {
                runOnUiThread(() -> {
                    if (liveStatus != null) liveStatus.setText("Live check failed. Retrying...");
                });
            }
        }).start();
    }

    private void render(JSONObject d, JSONArray flags) {
        boolean animate = !hasRendered;
        hasRendered = true;
        setLoading(false);
        content.removeAllViews();

        TextView greeting = Ui.text(this, greeting(), 13, android.graphics.Color.rgb(96, 108, 105), Typeface.NORMAL);
        TextView name = Ui.text(this, SessionStore.getFullname(this), 20, android.graphics.Color.rgb(27, 34, 34), Typeface.BOLD);
        TextView role = Ui.text(this, "Division-Level Monitoring", 12, android.graphics.Color.rgb(96, 108, 105), Typeface.BOLD);
        content.addView(greeting);
        content.addView(name);
        content.addView(role);

        LinearLayout ringPanel = panel();
        ringPanel.setGravity(Gravity.CENTER);
        ringPanel.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
        ringPanel.setBackground(Ui.strokeBg(android.graphics.Color.WHITE, Ui.GREEN, Ui.dp(this, 12)));
        AttendanceRingView ring = new AttendanceRingView(this);
        ringPanel.addView(ring, Ui.lp(Ui.dp(this, 180), Ui.dp(this, 150)));
        TextView summary = Ui.text(this, d.optInt("students_present") + " of " + Math.max(1, d.optInt("active_students", d.optInt("total_students"))) + " students present", 14, android.graphics.Color.rgb(54, 64, 64), Typeface.BOLD);
        summary.setGravity(Gravity.CENTER);
        ringPanel.addView(summary);
        content.addView(ringPanel, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 12), 0, Ui.dp(this, 10)));
        ring.setPercent(d.optInt("attendance_rate"));
        if (animate) Ui.reveal(ringPanel, 40);

        GridLayout grid = new GridLayout(this);
        grid.setColumnCount(2);
        content.addView(grid);
        addMetric(grid, "TOTAL STUDENTS", d.optInt("total_students"), Ui.GREEN_SOFT, Ui.GREEN_DARK);
        addMetric(grid, "PRESENT", d.optInt("students_present"), Ui.GREEN_SOFT, Ui.GREEN_DARK);
        addMetric(grid, "ABSENT", d.optInt("students_absent"), android.graphics.Color.rgb(255, 239, 239), Ui.RED);
        addMetric(grid, "2-DAY FLAGGED", flags.length(), android.graphics.Color.rgb(255, 248, 231), Ui.AMBER);
        addMetric(grid, "TOTAL TEACHERS", d.optInt("total_teachers"), android.graphics.Color.rgb(234, 250, 255), Ui.GREEN_DARK);
        addMetric(grid, "TEACHERS PRESENT", d.optInt("teachers_present"), Ui.GREEN_SOFT, Ui.GREEN_DARK);
        if (animate) Ui.reveal(grid, 100);

        addNotificationTest(animate);
        addAbsenceSection(flags, animate);
        addSchools(d.optJSONArray("schools"), animate);

        liveStatus = Ui.text(this, "Live. Updated " + new SimpleDateFormat("h:mm:ss a", Locale.US).format(new Date()), 12, android.graphics.Color.rgb(90, 103, 99), Typeface.NORMAL);
        liveStatus.setGravity(Gravity.CENTER);
        content.addView(liveStatus, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 12), 0, 0));
    }

    private void renderLoading() {
        content.removeAllViews();
        LinearLayout panel = panel();
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(Ui.dp(this, 20), Ui.dp(this, 44), Ui.dp(this, 20), Ui.dp(this, 44));
        ProgressBar bar = new ProgressBar(this);
        TextView text = Ui.text(this, "Fetching live dashboard...", 15, Ui.GREEN_DARK, Typeface.BOLD);
        text.setGravity(Gravity.CENTER);
        panel.addView(bar, Ui.lp(Ui.dp(this, 42), Ui.dp(this, 42)));
        panel.addView(text, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 12), 0, 0));
        content.addView(panel);
        Ui.reveal(panel, 0);
    }

    private LinearLayout panel() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setBackground(Ui.strokeBg(android.graphics.Color.WHITE, android.graphics.Color.rgb(232, 238, 236), Ui.dp(this, 12)));
        Ui.elevate(view, 4);
        return view;
    }

    private void addMetric(GridLayout grid, String label, int value, int iconBg, int accent) {
        LinearLayout card = panel();
        card.setPadding(Ui.dp(this, 12), Ui.dp(this, 12), Ui.dp(this, 12), Ui.dp(this, 12));
        card.setMinimumHeight(Ui.dp(this, 76));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView dot = new TextView(this);
        dot.setText("•");
        dot.setTextSize(24);
        dot.setGravity(Gravity.CENTER);
        dot.setTextColor(accent);
        dot.setBackground(Ui.bg(iconBg, Ui.dp(this, 10)));
        row.addView(dot, Ui.lp(Ui.dp(this, 38), Ui.dp(this, 38)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        TextView num = Ui.text(this, String.valueOf(value), 24, android.graphics.Color.rgb(25, 30, 30), Typeface.BOLD);
        TextView lab = Ui.text(this, label, 10, android.graphics.Color.rgb(74, 83, 83), Typeface.BOLD);
        copy.addView(num);
        copy.addView(lab);
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

    private void addNotificationTest(boolean animate) {
        LinearLayout section = panel();
        section.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
        TextView title = Ui.text(this, "Notification Test", 16, android.graphics.Color.rgb(25, 30, 30), Typeface.BOLD);
        Button test = compactButton("Send Test Notification", Ui.GREEN_DARK);
        test.setOnClickListener(v -> sendTestNotification("Notification test successful", "EduTrack notifications are working on this phone."));
        section.addView(title);
        section.addView(test, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 46), 0, Ui.dp(this, 10), 0, 0));
        content.addView(section, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 4), 0, Ui.dp(this, 10)));
        if (animate) Ui.reveal(section, 160);
    }

    private void addAbsenceSection(JSONArray flags, boolean animate) {
        LinearLayout section = panel();
        section.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
        TextView title = Ui.text(this, "2-Day Absence Alerts", 16, android.graphics.Color.rgb(25, 30, 30), Typeface.BOLD);
        section.addView(title);
        if (flags.length() == 0) {
            TextView empty = Ui.text(this, "No 2-day absentees detected.", 14, android.graphics.Color.rgb(96, 108, 105), Typeface.NORMAL);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(0, Ui.dp(this, 18), 0, Ui.dp(this, 12));
            section.addView(empty);
        } else {
            for (int i = 0; i < Math.min(flags.length(), 5); i++) {
                JSONObject st = flags.optJSONObject(i);
                if (st == null) continue;
                TextView row = Ui.text(this, st.optString("name", "Student") + " - " + st.optString("school_name", ""), 13, Ui.INK, Typeface.BOLD);
                row.setPadding(Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10));
                row.setBackground(Ui.bg(android.graphics.Color.rgb(255, 248, 231), Ui.dp(this, 8)));
                section.addView(row, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, 0));
            }
        }
        content.addView(section, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 10)));
        if (animate) Ui.reveal(section, 220);
    }

    private void addSchools(JSONArray schools, boolean animate) {
        if (schools == null || schools.length() == 0) return;
        LinearLayout section = panel();
        section.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
        TextView title = Ui.text(this, "Schools", 16, android.graphics.Color.rgb(25, 30, 30), Typeface.BOLD);
        section.addView(title);
        for (int i = 0; i < Math.min(schools.length(), 5); i++) {
            JSONObject school = schools.optJSONObject(i);
            if (school == null) continue;
            TextView row = Ui.text(this, school.optString("name") + "\n" + school.optInt("present") + "/" + school.optInt("enrollment") + " present - " + school.optInt("rate") + "%", 13, Ui.INK, Typeface.BOLD);
            row.setPadding(Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10));
            row.setBackground(Ui.bg(android.graphics.Color.rgb(247, 250, 249), Ui.dp(this, 8)));
            section.addView(row, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, 0));
        }
        content.addView(section);
        if (animate) Ui.reveal(section, 280);
    }

    private LinearLayout bottomNav() {
        LinearLayout nav = new LinearLayout(this);
        nav.setGravity(Gravity.CENTER);
        nav.setPadding(Ui.dp(this, 4), Ui.dp(this, 4), Ui.dp(this, 4), Ui.dp(this, 4));
        nav.setBackgroundColor(android.graphics.Color.WHITE);
        Ui.elevate(nav, 10);
        nav.addView(navItem("Dashboard", null), new LinearLayout.LayoutParams(0, Ui.dp(this, 58), 1));
        nav.addView(navItem("Attendance", "/admin/attendance"), new LinearLayout.LayoutParams(0, Ui.dp(this, 58), 1));
        nav.addView(navItem("Schools", "/admin/schools"), new LinearLayout.LayoutParams(0, Ui.dp(this, 58), 1));
        nav.addView(navItem("Reports", "/admin/reports"), new LinearLayout.LayoutParams(0, Ui.dp(this, 58), 1));
        return nav;
    }

    private TextView navItem(String label, String path) {
        TextView item = Ui.text(this, label, 11, path == null ? Ui.GREEN_DARK : android.graphics.Color.rgb(72, 82, 80), Typeface.BOLD);
        item.setGravity(Gravity.CENTER);
        item.setOnClickListener(v -> {
            if (path == null) return;
            Intent intent = new Intent(this, WebAppActivity.class);
            intent.putExtra("path", path);
            startActivity(intent);
            overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
        });
        return item;
    }

    private Button headerButton(String text) {
        Button button = compactButton(text, Ui.GREEN_DARK);
        button.setTextSize(12);
        button.setLayoutParams(Ui.lp(Ui.dp(this, 72), Ui.dp(this, 44)));
        return button;
    }

    private Button compactButton(String text, int color) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextColor(android.graphics.Color.WHITE);
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
        TextView chip = Ui.text(this, text, 12, android.graphics.Color.WHITE, Typeface.BOLD);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(Ui.dp(this, 10), 0, Ui.dp(this, 10), 0);
        chip.setBackground(Ui.bg(android.graphics.Color.argb(36, 255, 255, 255), Ui.dp(this, 12)));
        return chip;
    }

    private String greeting() {
        int hour = Integer.parseInt(new SimpleDateFormat("H", Locale.US).format(new Date()));
        if (hour < 12) return "Good Morning";
        if (hour < 18) return "Good Afternoon";
        return "Good Evening";
    }

    private void setLoading(boolean loading) {
        progress.setVisibility(loading ? View.VISIBLE : View.GONE);
        refresh.setEnabled(!loading);
        refresh.setText(loading ? "..." : "Refresh");
    }

    private void notifyAbsenceFlags(JSONArray flags) {
        if (flags == null || flags.length() == 0) return;
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String key = today + ":" + flags.length();
        String last = SessionStore.prefs(this).getString("last_native_absence_notification", "");
        if (key.equals(last)) return;
        JSONObject first = flags.optJSONObject(0);
        String name = first == null ? "student" : first.optString("name", "student");
        sendTestNotification(flags.length() + " Students Absent 2+ Days", "Flagged students: " + name);
        SessionStore.prefs(this).edit().putString("last_native_absence_notification", key).apply();
    }

    private void sendTestNotification(String title, String body) {
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
}
