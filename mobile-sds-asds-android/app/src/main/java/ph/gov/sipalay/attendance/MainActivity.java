package ph.gov.sipalay.attendance;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean serverUnavailableShown = false;
    private boolean openingDashboard = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showSplash();
        applyConfigurationIntent(getIntent());
        handler.postDelayed(() -> {
            if (!openingDashboard && !serverUnavailableShown && !SessionStore.hasConfiguredBaseUrl(this)) {
                showServerUnavailable();
            }
        }, 1200);
        handler.postDelayed(this::checkServerAndOpen, 250);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void checkServerAndOpen() {
        if (openingDashboard || isFinishing()) return;
        new Thread(() -> {
            ApiClient.refreshBaseUrl(this);
            runOnUiThread(() -> {
                if (isFinishing()) return;
                if (SessionStore.hasConfiguredBaseUrl(this)) {
                    openingDashboard = true;
                    startActivity(new Intent(this, SessionStore.isLoggedIn(this) ? DashboardActivity.class : LoginActivity.class));
                    overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
                    finish();
                    return;
                }
                if (!serverUnavailableShown) showServerUnavailable();
                handler.postDelayed(this::checkServerAndOpen, 3500);
            });
        }).start();
    }

    private void showSplash() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(48, 48, 48, 48);
        root.setBackground(Ui.verticalGradient(android.graphics.Color.rgb(214, 219, 238), android.graphics.Color.rgb(246, 247, 252), 0));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER);
        card.setPadding(34, 40, 34, 40);
        card.setBackground(Ui.verticalGradient(Ui.PRIMARY, android.graphics.Color.rgb(255, 132, 36), 36));
        Ui.elevate(card, 14);
        root.addView(card, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setAdjustViewBounds(true);
        card.addView(logo, new LinearLayout.LayoutParams(132, 132));

        TextView title = Ui.text(this, "School Attendance", 24, android.graphics.Color.WHITE, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleLp = Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 8);
        card.addView(title, titleLp);

        TextView subtitle = Ui.text(this, "Loading mobile dashboard", 14, android.graphics.Color.rgb(255, 237, 222), Typeface.NORMAL);
        subtitle.setGravity(Gravity.CENTER);
        card.addView(subtitle, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ProgressBar bar = new ProgressBar(this);
        card.addView(bar, Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 26, 0, 0));
        setContentView(root);
        Ui.reveal(card, 50);
    }

    private boolean applyConfigurationIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return false;
        Uri uri = intent.getData();
        String baseUrl = uri.getQueryParameter("base_url");
        if (baseUrl != null && (baseUrl.startsWith("https://") || baseUrl.startsWith("http://"))) {
            if (ApiClient.isAttendanceSystem(baseUrl)) {
                SessionStore.clear(this);
                SessionStore.saveBaseUrl(this, baseUrl);
                return true;
            }
        }
        return false;
    }

    private void showServerUnavailable() {
        serverUnavailableShown = true;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(30, 34, 30, 34);
        root.setBackground(Ui.gradient(android.graphics.Color.rgb(230, 244, 255), android.graphics.Color.rgb(248, 250, 252), 0));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(34, 34, 34, 34);
        card.setBackground(Ui.strokeBg(android.graphics.Color.WHITE, android.graphics.Color.rgb(226, 232, 240), 34));
        Ui.elevate(card, 10);
        root.addView(card, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setAdjustViewBounds(true);
        card.addView(logo, Ui.lp(96, 96));

        TextView title = Ui.text(this, "Connecting to Attendance System", 24, Ui.INK, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        card.addView(title, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 8));

        TextView message = Ui.text(this, "The app is waiting for the live QR attendance server configuration. It will open the dashboard automatically when the server is available.", 15, Ui.MUTED, Typeface.NORMAL);
        message.setGravity(Gravity.CENTER);
        card.addView(message, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ProgressBar bar = new ProgressBar(this);
        card.addView(bar, Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 24, 0, 10));

        TextView status = Ui.text(this, "Checking automatically...", 13, Ui.PRIMARY, Typeface.BOLD);
        status.setGravity(Gravity.CENTER);
        card.addView(status, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(root);
    }
}
