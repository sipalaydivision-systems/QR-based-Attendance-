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
    private static final String TEST_CHANNEL_ID = "mobile_app_test_notifications";
    private static final long LIVE_REFRESH_MS = 10000L;

    private final Handler liveHandler = new Handler(Looper.getMainLooper());
    private LinearLayout content;
    private ProgressBar progress;
    private TextView status;
    private Button refresh;
    private boolean fetching = false;
    private boolean hasRendered = false;

    private final Runnable liveRefresh = new Runnable() {
        @Override
        public void run() {
            loadDashboard(false);
            liveHandler.postDelayed(this, LIVE_REFRESH_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Ui.setBars(getWindow(), Ui.PRIMARY_DARK, false, android.graphics.Color.WHITE);
        AbsenceWorker.schedule(this);
        buildShell();
        renderLoadingCards();
        loadDashboard(true);
        liveHandler.postDelayed(liveRefresh, LIVE_REFRESH_MS);
    }

    @Override
    protected void onDestroy() {
        liveHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void buildShell() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(android.graphics.Color.rgb(246, 247, 252));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(Ui.dp(this, 18), Ui.dp(this, 16), Ui.dp(this, 18), Ui.dp(this, 16));
        header.setBackground(Ui.gradient(Ui.PRIMARY, Ui.PRIMARY_DARK, 0));
        Ui.elevate(header, 8);

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setAdjustViewBounds(true);
        header.addView(logo, Ui.lp(Ui.dp(this, 42), Ui.dp(this, 42)));

        LinearLayout titleBox = new LinearLayout(this);
        titleBox.setOrientation(LinearLayout.VERTICAL);
        TextView title = Ui.text(this, "Dashboard", 24, android.graphics.Color.WHITE, Typeface.BOLD);
        TextView name = Ui.text(this, SessionStore.getFullname(this), 14, android.graphics.Color.rgb(255, 236, 220), Typeface.NORMAL);
        titleBox.addView(title);
        titleBox.addView(name);
        LinearLayout.LayoutParams titleLp = Ui.marginLp(0, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 12), 0, Ui.dp(this, 8), 0);
        titleLp.weight = 1;
        header.addView(titleBox, titleLp);

        refresh = actionButton("Refresh");
        refresh.setOnClickListener(v -> loadDashboard(true));
        header.addView(refresh);

        Button logout = actionButton("Logout");
        logout.setOnClickListener(v -> {
            liveHandler.removeCallbacksAndMessages(null);
            SessionStore.clear(this);
            AbsenceWorker.cancel(this);
            startActivity(new Intent(this, LoginActivity.class));
            overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
            finish();
        });
        header.addView(logout, Ui.marginLp(Ui.dp(this, 86), Ui.dp(this, 52), Ui.dp(this, 8), 0, 0, 0));
        root.addView(header);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setVisibility(View.GONE);
        root.addView(progress, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 4)));

        ScrollView scroll = new ScrollView(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(Ui.dp(this, 16), Ui.dp(this, 18), Ui.dp(this, 16), Ui.dp(this, 36));
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
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
                runOnUiThread(() -> render(dashboard, flags));
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
                    if (status != null) status.setText("Live update failed. Retrying automatically...");
                    if (!hasRendered) Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
                });
            } finally {
                runOnUiThread(() -> fetching = false);
            }
        }).start();
    }

    private void render(JSONObject d, JSONArray flags) {
        boolean firstRender = !hasRendered;
        hasRendered = true;
        setLoading(false);
        content.removeAllViews();

        LinearLayout hero = panel();
        hero.setPadding(Ui.dp(this, 22), Ui.dp(this, 22), Ui.dp(this, 22), Ui.dp(this, 22));
        hero.setBackground(Ui.gradient(Ui.PRIMARY, Ui.PRIMARY_DARK, Ui.dp(this, 16)));
        TextView greeting = Ui.text(this, greeting() + ", " + SessionStore.getFullname(this), 22, android.graphics.Color.WHITE, Typeface.BOLD);
        TextView date = Ui.text(this, new SimpleDateFormat("EEEE, MMMM d, yyyy", Locale.US).format(new Date()), 15, android.graphics.Color.rgb(255, 237, 222), Typeface.NORMAL);
        TextView rate = Ui.text(this, d.optInt("attendance_rate") + "% today's attendance rate", 19, android.graphics.Color.WHITE, Typeface.BOLD);
        hero.addView(greeting);
        hero.addView(date, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, 0));
        hero.addView(rate, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 16), 0, 0));
        content.addView(hero);
        if (firstRender) Ui.reveal(hero, 0);

        String reason = d.optString("non_school_day_reason", "");
        if (!d.optBoolean("is_school_day", true) && !reason.isEmpty()) {
            TextView banner = Ui.text(this, "No classes due to " + reason.toLowerCase(Locale.US) + ".", 16, android.graphics.Color.rgb(153, 27, 27), Typeface.BOLD);
            banner.setPadding(Ui.dp(this, 16), Ui.dp(this, 14), Ui.dp(this, 16), Ui.dp(this, 14));
            banner.setBackground(Ui.strokeBg(android.graphics.Color.rgb(255, 246, 246), android.graphics.Color.rgb(248, 113, 113), Ui.dp(this, 12)));
            content.addView(banner, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 14), 0, 0));
            if (firstRender) Ui.reveal(banner, 60);
        }

        GridLayout grid = new GridLayout(this);
        grid.setColumnCount(2);
        content.addView(grid, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 14), 0, 0));
        addMetric(grid, "Schools", d.optInt("total_schools"), Ui.PLUM);
        addMetric(grid, "Students", d.optInt("total_students"), Ui.PLUM);
        addMetric(grid, "Present", d.optInt("students_present"), Ui.GREEN);
        addMetric(grid, "Absent", d.optInt("students_absent"), Ui.RED);
        addMetric(grid, "2-Day", flags.length(), Ui.AMBER);
        addMetric(grid, "Teachers", d.optInt("total_teachers"), Ui.PLUM);
        addMetric(grid, "T. Present", d.optInt("teachers_present"), Ui.GREEN);
        addMetric(grid, "T. Absent", d.optInt("teachers_absent"), Ui.RED);
        if (firstRender) Ui.reveal(grid, 100);

        addNotificationTestSection(firstRender);
        addAbsenceSection(flags, firstRender);
        addSchoolRates(d.optJSONArray("schools"), firstRender);

        status = Ui.text(this, "Live. Updated " + new SimpleDateFormat("h:mm:ss a", Locale.US).format(new Date()), 13, Ui.MUTED, Typeface.NORMAL);
        status.setGravity(Gravity.CENTER);
        content.addView(status, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 16), 0, 0));
    }

    private void renderLoadingCards() {
        content.removeAllViews();
        LinearLayout loading = panel();
        loading.setGravity(Gravity.CENTER);
        loading.setPadding(Ui.dp(this, 24), Ui.dp(this, 54), Ui.dp(this, 24), Ui.dp(this, 54));
        loading.setBackground(Ui.gradient(Ui.PRIMARY, Ui.PRIMARY_DARK, Ui.dp(this, 18)));
        TextView title = Ui.text(this, "Loading dashboard", 22, android.graphics.Color.WHITE, Typeface.BOLD);
        TextView body = Ui.text(this, "Fetching live attendance data...", 15, android.graphics.Color.rgb(255, 237, 222), Typeface.NORMAL);
        body.setGravity(Gravity.CENTER);
        loading.addView(title);
        loading.addView(body, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 10), 0, 0));
        content.addView(loading);
        Ui.reveal(loading, 0);
        Ui.pulse(loading);
    }

    private LinearLayout panel() {
        LinearLayout section = new LinearLayout(this);
        section.setOrientation(LinearLayout.VERTICAL);
        section.setBackground(Ui.strokeBg(Ui.CARD, Ui.LINE, Ui.dp(this, 14)));
        Ui.elevate(section, 5);
        return section;
    }

    private void addMetric(GridLayout grid, String label, int value, int accent) {
        LinearLayout card = panel();
        card.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
        card.setMinimumHeight(Ui.dp(this, 104));
        TextView number = Ui.text(this, String.valueOf(value), 32, Ui.PLUM, Typeface.BOLD);
        TextView text = Ui.text(this, label, 15, Ui.MUTED, Typeface.BOLD);
        TextView bar = new TextView(this);
        bar.setBackground(Ui.bg(accent, Ui.dp(this, 4)));
        card.addView(number);
        card.addView(text);
        card.addView(bar, Ui.marginLp(Ui.dp(this, 46), Ui.dp(this, 4), 0, Ui.dp(this, 8), 0, 0));

        GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
        lp.width = 0;
        lp.height = GridLayout.LayoutParams.WRAP_CONTENT;
        lp.columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f);
        lp.setMargins(0, 0, Ui.dp(this, 10), Ui.dp(this, 10));
        grid.addView(card, lp);
    }

    private void addNotificationTestSection(boolean animate) {
        LinearLayout section = panel();
        section.setPadding(Ui.dp(this, 18), Ui.dp(this, 18), Ui.dp(this, 18), Ui.dp(this, 18));
        content.addView(section, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 4), 0, Ui.dp(this, 12)));

        TextView title = Ui.text(this, "Notification Test", 22, Ui.PLUM, Typeface.BOLD);
        TextView body = Ui.text(this, "Send a test alert to this phone.", 16, Ui.MUTED, Typeface.NORMAL);
        Button test = new Button(this);
        test.setText("Send Test Notification");
        test.setTextColor(android.graphics.Color.WHITE);
        test.setTextSize(16);
        test.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        test.setAllCaps(false);
        test.setBackground(Ui.gradient(Ui.PRIMARY, Ui.PRIMARY_DARK, Ui.dp(this, 18)));
        test.setOnClickListener(v -> sendTestNotification());
        section.addView(title);
        section.addView(body, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 6), 0, Ui.dp(this, 14)));
        section.addView(test, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 56)));
        if (animate) Ui.reveal(section, 160);
    }

    private void addAbsenceSection(JSONArray flags, boolean animate) {
        LinearLayout section = panel();
        section.setPadding(Ui.dp(this, 18), Ui.dp(this, 18), Ui.dp(this, 18), Ui.dp(this, 18));
        content.addView(section, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 12)));

        TextView title = Ui.text(this, "2-Day Absence Alerts", 22, Ui.PLUM, Typeface.BOLD);
        section.addView(title);
        if (flags.length() == 0) {
            TextView empty = Ui.text(this, "No 2-day absentees detected.", 18, Ui.MUTED, Typeface.NORMAL);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(0, Ui.dp(this, 24), 0, Ui.dp(this, 18));
            section.addView(empty);
        } else {
            int limit = Math.min(flags.length(), 10);
            for (int i = 0; i < limit; i++) {
                JSONObject st = flags.optJSONObject(i);
                if (st == null) continue;
                TextView row = Ui.text(this, st.optString("name", "Student") + "\n" + st.optString("school_name", "") + " - " + st.optString("grade_name", ""), 15, Ui.INK, Typeface.BOLD);
                row.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 12));
                row.setBackground(Ui.bg(Ui.PLUM_SOFT, Ui.dp(this, 10)));
                section.addView(row, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 10), 0, 0));
            }
        }
        if (animate) Ui.reveal(section, 220);
    }

    private void addSchoolRates(JSONArray schools, boolean animate) {
        if (schools == null || schools.length() == 0) return;
        LinearLayout section = panel();
        section.setPadding(Ui.dp(this, 18), Ui.dp(this, 18), Ui.dp(this, 18), Ui.dp(this, 18));
        content.addView(section, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, 0));

        TextView title = Ui.text(this, "Schools by Attendance Rate", 22, Ui.PLUM, Typeface.BOLD);
        section.addView(title);
        int limit = Math.min(schools.length(), 8);
        for (int i = 0; i < limit; i++) {
            JSONObject school = schools.optJSONObject(i);
            if (school == null) continue;
            TextView row = Ui.text(this, school.optString("name") + "\n" + school.optInt("present") + " present of " + school.optInt("enrollment") + " - " + school.optInt("rate") + "%", 15, Ui.INK, Typeface.BOLD);
            row.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 12));
            row.setBackground(Ui.bg(Ui.PLUM_SOFT, Ui.dp(this, 10)));
            section.addView(row, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 10), 0, 0));
        }
        if (animate) Ui.reveal(section, 280);
    }

    private String greeting() {
        int hour = Integer.parseInt(new SimpleDateFormat("H", Locale.US).format(new Date()));
        if (hour < 12) return "Good morning";
        if (hour < 18) return "Good afternoon";
        return "Good evening";
    }

    private void setLoading(boolean loading) {
        progress.setVisibility(loading ? View.VISIBLE : View.GONE);
        refresh.setEnabled(!loading);
        refresh.setText(loading ? "..." : "Refresh");
    }

    private Button actionButton(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(13);
        b.setTextColor(Ui.PLUM);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setAllCaps(false);
        b.setBackground(Ui.bg(android.graphics.Color.WHITE, Ui.dp(this, 16)));
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setPadding(0, 0, 0, 0);
        LinearLayout.LayoutParams lp = Ui.lp(Ui.dp(this, 86), Ui.dp(this, 52));
        b.setLayoutParams(lp);
        return b;
    }

    private void sendTestNotification() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 42);
            Toast.makeText(this, "Allow notifications, then tap Test again.", Toast.LENGTH_LONG).show();
            return;
        }

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(TEST_CHANNEL_ID, "Mobile App Test Notifications", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Used to verify that mobile app notifications are working.");
            manager.createNotificationChannel(channel);
        }

        Intent intent = new Intent(this, DashboardActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 3001, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, TEST_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Notification test successful")
                .setContentText("Your attendance mobile app can send phone notifications.")
                .setStyle(new NotificationCompat.BigTextStyle().bigText("Your attendance mobile app can send phone notifications."))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH);
        manager.notify(3001, builder.build());
        Toast.makeText(this, "Test notification sent.", Toast.LENGTH_SHORT).show();
    }
}
