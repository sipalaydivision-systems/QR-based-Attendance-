package ph.gov.sipalay.attendance;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showSplash();
        new Thread(() -> {
            boolean valid = SessionStore.isLoggedIn(this);
            if (valid) {
                try {
                    ApiClient.getJson(this, "/api/dashboard-data");
                } catch (Exception e) {
                    SessionStore.clear(this);
                    valid = false;
                }
            }
            boolean routeToDashboard = valid;
            try {
                Thread.sleep(650);
            } catch (InterruptedException ignored) {}
            runOnUiThread(() -> {
                startActivity(new Intent(this, routeToDashboard ? DashboardActivity.class : LoginActivity.class));
                finish();
            });
        }).start();
    }

    private void showSplash() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(48, 48, 48, 48);
        root.setBackground(Ui.gradient(android.graphics.Color.rgb(239, 246, 255), android.graphics.Color.rgb(248, 250, 252), 0));

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setAdjustViewBounds(true);
        root.addView(logo, new LinearLayout.LayoutParams(132, 132));

        TextView title = Ui.text(this, "School Attendance QR based Systems", 22, Ui.INK, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleLp = Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 8);
        root.addView(title, titleLp);

        TextView subtitle = Ui.text(this, "Loading division dashboard", 14, Ui.MUTED, Typeface.NORMAL);
        subtitle.setGravity(Gravity.CENTER);
        root.addView(subtitle, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ProgressBar bar = new ProgressBar(this);
        root.addView(bar, Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 26, 0, 0));
        setContentView(root);
    }
}
