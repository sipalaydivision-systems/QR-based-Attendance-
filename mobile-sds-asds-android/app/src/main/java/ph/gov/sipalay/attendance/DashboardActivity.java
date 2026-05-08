package ph.gov.sipalay.attendance;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
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

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class DashboardActivity extends Activity {
    private LinearLayout content;
    private ProgressBar progress;
    private TextView status;
    private Button refresh;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        AbsenceWorker.schedule(this);
        buildShell();
        renderLoadingCards();
        loadDashboard();
    }

    private void buildShell() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Ui.BG);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(24, 20, 24, 18);
        header.setBackgroundColor(android.graphics.Color.WHITE);
        Ui.elevate(header, 5);

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setAdjustViewBounds(true);
        header.addView(logo, Ui.lp(58, 58));

        LinearLayout titleBox = new LinearLayout(this);
        titleBox.setOrientation(LinearLayout.VERTICAL);
        TextView title = Ui.text(this, "Division Dashboard", 18, Ui.INK, Typeface.BOLD);
        TextView name = Ui.text(this, SessionStore.getFullname(this), 13, Ui.MUTED, Typeface.NORMAL);
        titleBox.addView(title);
        titleBox.addView(name);
        header.addView(titleBox, Ui.marginLp(0, LinearLayout.LayoutParams.WRAP_CONTENT, 14, 0, 0, 0));
        ((LinearLayout.LayoutParams) titleBox.getLayoutParams()).weight = 1;

        refresh = smallButton("Refresh");
        refresh.setOnClickListener(v -> loadDashboard());
        header.addView(refresh);

        Button logout = smallButton("Logout");
        logout.setOnClickListener(v -> {
            SessionStore.clear(this);
            AbsenceWorker.cancel(this);
            startActivity(new Intent(this, LoginActivity.class));
            finish();
        });
        header.addView(logout);
        root.addView(header);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setVisibility(View.GONE);
        root.addView(progress, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, 8));

        ScrollView scroll = new ScrollView(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(22, 24, 22, 42);
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    private void loadDashboard() {
        setLoading(true);
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
                    finish();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    setLoading(false);
                    Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
                    if (status != null) status.setText("Unable to refresh. Check connection.");
                });
            }
        }).start();
    }

    private void render(JSONObject d, JSONArray flags) {
        setLoading(false);
        content.removeAllViews();

        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setPadding(26, 24, 26, 24);
        hero.setBackground(Ui.gradient(android.graphics.Color.rgb(22, 163, 74), android.graphics.Color.rgb(21, 128, 61), 28));
        Ui.elevate(hero, 5);

        TextView greeting = Ui.text(this, greeting() + ", " + SessionStore.getFullname(this), 21, android.graphics.Color.WHITE, Typeface.BOLD);
        hero.addView(greeting);
        TextView date = Ui.text(this, new SimpleDateFormat("EEEE, MMMM d, yyyy", Locale.US).format(new Date()), 14, android.graphics.Color.rgb(220, 252, 231), Typeface.NORMAL);
        hero.addView(date, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 8, 0, 0));
        TextView rate = Ui.text(this, d.optInt("attendance_rate") + "% today's attendance rate", 17, android.graphics.Color.WHITE, Typeface.BOLD);
        hero.addView(rate, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 0));
        content.addView(hero, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        String reason = d.optString("non_school_day_reason", "");
        if (!d.optBoolean("is_school_day", true) && !reason.isEmpty()) {
            TextView banner = Ui.text(this, "No classes due to " + reason.toLowerCase(Locale.US) + ".", 15, android.graphics.Color.rgb(153, 27, 27), Typeface.BOLD);
            banner.setPadding(22, 18, 22, 18);
            banner.setBackground(Ui.strokeBg(android.graphics.Color.rgb(254, 242, 242), android.graphics.Color.rgb(248, 113, 113), 18));
            content.addView(banner, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 0));
        }

        GridLayout grid = new GridLayout(this);
        grid.setColumnCount(2);
        content.addView(grid, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 0));

        addMetric(grid, "Schools", d.optInt("total_schools"), Ui.PRIMARY);
        addMetric(grid, "Students", d.optInt("total_students"), Ui.PRIMARY);
        addMetric(grid, "Present", d.optInt("students_present"), Ui.GREEN);
        addMetric(grid, "Absent", d.optInt("students_absent"), Ui.RED);
        addMetric(grid, "2-Day", flags.length(), Ui.AMBER);
        addMetric(grid, "Teachers", d.optInt("total_teachers"), Ui.PRIMARY);
        addMetric(grid, "T. Present", d.optInt("teachers_present"), Ui.GREEN);
        addMetric(grid, "T. Absent", d.optInt("teachers_absent"), Ui.RED);

        addAbsenceSection(flags);
        addSchoolRates(d.optJSONArray("schools"));

        status = Ui.text(this, "Last refreshed " + new SimpleDateFormat("h:mm a", Locale.US).format(new Date()), 12, Ui.MUTED, Typeface.NORMAL);
        status.setGravity(Gravity.CENTER);
        content.addView(status, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 0));
    }

    private void renderLoadingCards() {
        content.removeAllViews();
        TextView loading = Ui.text(this, "Loading dashboard...", 18, Ui.INK, Typeface.BOLD);
        loading.setGravity(Gravity.CENTER);
        loading.setPadding(20, 70, 20, 70);
        loading.setBackground(Ui.strokeBg(android.graphics.Color.WHITE, android.graphics.Color.rgb(219, 227, 239), 24));
        content.addView(loading, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
    }

    private void addMetric(GridLayout grid, String label, int value, int accent) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(18, 18, 18, 18);
        card.setBackground(Ui.strokeBg(Ui.CARD, android.graphics.Color.rgb(219, 227, 239), 22));
        Ui.elevate(card, 3);

        TextView number = Ui.text(this, String.valueOf(value), 27, Ui.INK, Typeface.BOLD);
        TextView text = Ui.text(this, label, 12, Ui.MUTED, Typeface.BOLD);
        TextView bar = new TextView(this);
        bar.setBackground(Ui.bg(accent, 8));
        card.addView(number);
        card.addView(text);
        card.addView(bar, Ui.marginLp(72, 8, 0, 12, 0, 0));

        GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
        lp.width = 0;
        lp.height = GridLayout.LayoutParams.WRAP_CONTENT;
        lp.columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f);
        lp.setMargins(0, 0, 12, 12);
        grid.addView(card, lp);
    }

    private void addAbsenceSection(JSONArray flags) {
        LinearLayout section = new LinearLayout(this);
        section.setOrientation(LinearLayout.VERTICAL);
        section.setPadding(22, 20, 22, 22);
        section.setBackground(Ui.strokeBg(Ui.CARD, android.graphics.Color.rgb(219, 227, 239), 22));
        Ui.elevate(section, 3);
        content.addView(section, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 10, 0, 0));

        TextView title = Ui.text(this, "2-Day Absence Alerts", 18, Ui.INK, Typeface.BOLD);
        section.addView(title);

        if (flags.length() == 0) {
            TextView empty = Ui.text(this, "No 2-day absentees detected.", 15, Ui.MUTED, Typeface.NORMAL);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(10, 30, 10, 20);
            section.addView(empty);
            return;
        }

        int limit = Math.min(flags.length(), 12);
        for (int i = 0; i < limit; i++) {
            JSONObject st = flags.optJSONObject(i);
            if (st == null) continue;
            TextView row = Ui.text(this, st.optString("name", "Student") + "\n" + st.optString("school_name", "") + " - " + st.optString("grade_name", ""), 14, Ui.INK, Typeface.BOLD);
            row.setPadding(18, 14, 18, 14);
            row.setBackground(Ui.bg(android.graphics.Color.rgb(248, 250, 252), 16));
            section.addView(row, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 10, 0, 0));
        }
    }

    private void addSchoolRates(JSONArray schools) {
        if (schools == null || schools.length() == 0) return;
        LinearLayout section = new LinearLayout(this);
        section.setOrientation(LinearLayout.VERTICAL);
        section.setPadding(22, 20, 22, 22);
        section.setBackground(Ui.strokeBg(Ui.CARD, android.graphics.Color.rgb(219, 227, 239), 22));
        Ui.elevate(section, 3);
        content.addView(section, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 16, 0, 0));

        TextView title = Ui.text(this, "Schools by Attendance Rate", 18, Ui.INK, Typeface.BOLD);
        section.addView(title);

        int limit = Math.min(schools.length(), 8);
        for (int i = 0; i < limit; i++) {
            JSONObject school = schools.optJSONObject(i);
            if (school == null) continue;
            TextView row = Ui.text(this, school.optString("name") + "\n" + school.optInt("present") + " present of " + school.optInt("enrollment") + " - " + school.optInt("rate") + "%", 14, Ui.INK, Typeface.BOLD);
            row.setPadding(18, 14, 18, 14);
            row.setBackground(Ui.bg(android.graphics.Color.rgb(248, 250, 252), 16));
            section.addView(row, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 10, 0, 0));
        }
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
        refresh.setText(loading ? "Loading" : "Refresh");
    }

    private Button smallButton(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(12);
        b.setAllCaps(false);
        return b;
    }
}
