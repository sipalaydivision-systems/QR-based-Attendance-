package ph.gov.sipalay.attendance;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        AbsenceWorker.schedule(this);
        buildShell();
        loadDashboard();
    }

    private void buildShell() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(241, 245, 249));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(24, 22, 24, 18);
        header.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("Dashboard\n" + SessionStore.getFullname(this));
        title.setTextColor(Color.rgb(15, 23, 42));
        title.setTextSize(18);
        title.setTypeface(null, 1);
        header.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        Button refresh = smallButton("Refresh");
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

        progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);
        root.addView(progress, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 8));

        ScrollView scroll = new ScrollView(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(22, 22, 22, 42);
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    private void loadDashboard() {
        progress.setVisibility(View.VISIBLE);
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
                    progress.setVisibility(View.GONE);
                    Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private void render(JSONObject d, JSONArray flags) {
        progress.setVisibility(View.GONE);
        content.removeAllViews();

        TextView greeting = new TextView(this);
        greeting.setText("Good day, " + SessionStore.getFullname(this));
        greeting.setTextColor(Color.WHITE);
        greeting.setTextSize(21);
        greeting.setTypeface(null, 1);
        greeting.setPadding(26, 24, 26, 8);
        greeting.setBackgroundColor(Color.rgb(22, 163, 74));
        content.addView(greeting, fillWrap());

        TextView rate = new TextView(this);
        rate.setText("Today's attendance rate: " + d.optInt("attendance_rate") + "%");
        rate.setTextColor(Color.WHITE);
        rate.setTextSize(15);
        rate.setPadding(26, 0, 26, 24);
        rate.setBackgroundColor(Color.rgb(22, 163, 74));
        content.addView(rate, fillWrap());

        String reason = d.optString("non_school_day_reason", "");
        if (!d.optBoolean("is_school_day", true) && !reason.isEmpty()) {
            TextView banner = new TextView(this);
            banner.setText("No classes due to " + reason.toLowerCase(Locale.US) + ".");
            banner.setTextColor(Color.rgb(153, 27, 27));
            banner.setTextSize(15);
            banner.setTypeface(null, 1);
            banner.setPadding(22, 18, 22, 18);
            banner.setBackgroundColor(Color.rgb(254, 242, 242));
            LinearLayout.LayoutParams lp = fillWrap();
            lp.setMargins(0, 22, 0, 6);
            content.addView(banner, lp);
        }

        addCard("Total Schools", d.optInt("total_schools"));
        addCard("Total Students", d.optInt("total_students"));
        addCard("Present Today", d.optInt("students_present"));
        addCard("Absent Today", d.optInt("students_absent"));
        addCard("2-Day Absentees", flags.length());
        addCard("Total Teachers", d.optInt("total_teachers"));
        addCard("Teachers Present", d.optInt("teachers_present"));
        addCard("Teachers Absent", d.optInt("teachers_absent"));

        TextView section = new TextView(this);
        section.setText("2-Day Absence Alerts");
        section.setTextColor(Color.rgb(15, 23, 42));
        section.setTextSize(18);
        section.setTypeface(null, 1);
        LinearLayout.LayoutParams sectionLp = fillWrap();
        sectionLp.setMargins(0, 28, 0, 8);
        content.addView(section, sectionLp);

        if (flags.length() == 0) {
            TextView empty = new TextView(this);
            empty.setText("No 2-day absentees detected.");
            empty.setTextColor(Color.rgb(71, 85, 105));
            empty.setTextSize(15);
            empty.setPadding(20, 20, 20, 20);
            content.addView(empty, fillWrap());
            return;
        }

        int limit = Math.min(flags.length(), 25);
        for (int i = 0; i < limit; i++) {
            JSONObject st = flags.optJSONObject(i);
            if (st == null) continue;
            TextView row = new TextView(this);
            row.setText(st.optString("name", "Student") + "\n" + st.optString("school_name", "") + " - " + st.optString("grade_name", ""));
            row.setTextColor(Color.rgb(15, 23, 42));
            row.setTextSize(15);
            row.setPadding(22, 18, 22, 18);
            row.setBackgroundColor(Color.WHITE);
            LinearLayout.LayoutParams lp = fillWrap();
            lp.setMargins(0, 8, 0, 0);
            content.addView(row, lp);
        }
    }

    private void addCard(String label, int value) {
        TextView card = new TextView(this);
        card.setText(value + "\n" + label);
        card.setTextColor(Color.rgb(15, 23, 42));
        card.setTextSize(17);
        card.setTypeface(null, 1);
        card.setPadding(24, 20, 24, 20);
        card.setBackgroundColor(Color.WHITE);
        LinearLayout.LayoutParams lp = fillWrap();
        lp.setMargins(0, 12, 0, 0);
        content.addView(card, lp);
    }

    private Button smallButton(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(12);
        return b;
    }

    private LinearLayout.LayoutParams fillWrap() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }
}
