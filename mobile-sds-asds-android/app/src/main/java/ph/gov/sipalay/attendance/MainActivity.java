package ph.gov.sipalay.attendance;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean serverUnavailableShown = false;
    private boolean openingDashboard = false;
    private ProgressBar splashProgressBar;
    private TextView splashPercent;
    private int splashProgress = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showSplash();
        startSplashProgress();
        applyConfigurationIntent(getIntent());
        handler.postDelayed(() -> {
            if (!openingDashboard && !serverUnavailableShown && !SessionStore.hasConfiguredBaseUrl(this)) {
                showServerUnavailable();
            }
        }, 2800);
        handler.postDelayed(this::checkServerAndOpen, 2300);
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
                    Class<?> next = SessionStore.isLoggedIn(this) ? DashboardActivity.class : LoginActivity.class;
                    startActivity(new Intent(this, next));
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
        Ui.setBars(getWindow(), Ui.GREEN_DARK, false, Ui.GREEN_DARK);
        FrameLayout stage = new FrameLayout(this);
        stage.setBackground(Ui.verticalGradient(Ui.GREEN, Ui.GREEN_DARK, 0));
        addMovingBand(stage, 0, 70, 9000);
        addMovingBand(stage, 170, -85, 11000);
        addMovingBand(stage, 340, 55, 10000);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(Ui.dp(this, 34), Ui.dp(this, 42), Ui.dp(this, 34), Ui.dp(this, 42));
        stage.addView(root, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER);
        card.setPadding(0, 0, 0, 0);
        root.addView(card, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setAdjustViewBounds(true);
        logo.setBackground(Ui.strokeBg(android.graphics.Color.argb(42, 255, 255, 255), android.graphics.Color.argb(60, 255, 255, 255), Ui.dp(this, 26)));
        logo.setPadding(Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10));
        card.addView(logo, new LinearLayout.LayoutParams(Ui.dp(this, 92), Ui.dp(this, 92)));

        TextView title = Ui.text(this, "Edutrack", 36, android.graphics.Color.WHITE, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleLp = Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 34), 0, Ui.dp(this, 8));
        card.addView(title, titleLp);

        TextView subtitle = Ui.text(this, "Schools Division of Sipalay City", 17, android.graphics.Color.rgb(222, 255, 242), Typeface.NORMAL);
        subtitle.setGravity(Gravity.CENTER);
        card.addView(subtitle, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView division = Ui.text(this, "Attendance Monitoring System", 13, android.graphics.Color.argb(190, 255, 255, 255), Typeface.NORMAL);
        division.setGravity(Gravity.CENTER);
        card.addView(division, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 50), 0, 0));

        LinearLayout loadingWrap = new LinearLayout(this);
        loadingWrap.setGravity(Gravity.CENTER);
        loadingWrap.setOrientation(LinearLayout.VERTICAL);
        loadingWrap.setPadding(Ui.dp(this, 18), Ui.dp(this, 10), Ui.dp(this, 18), Ui.dp(this, 10));

        splashProgressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        splashProgressBar.setIndeterminate(false);
        splashProgressBar.setMax(100);
        splashProgressBar.setProgress(0);
        loadingWrap.addView(splashProgressBar, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 8)));

        splashPercent = Ui.text(this, "Opening 0%", 14, android.graphics.Color.argb(220, 255, 255, 255), Typeface.BOLD);
        splashPercent.setGravity(Gravity.CENTER);
        loadingWrap.addView(splashPercent, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 12), 0, 0));
        root.addView(loadingWrap, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 76)));
        setContentView(stage);
        Ui.reveal(card, 10);
    }

    private void addMovingBand(FrameLayout stage, int topDp, int driftDp, long duration) {
        View band = new View(this);
        band.setAlpha(0.16f);
        band.setBackground(Ui.gradient(android.graphics.Color.argb(90, 255, 255, 255), android.graphics.Color.argb(10, 255, 255, 255), Ui.dp(this, 18)));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 88));
        lp.topMargin = Ui.dp(this, topDp);
        lp.leftMargin = -Ui.dp(this, 80);
        lp.rightMargin = -Ui.dp(this, 80);
        stage.addView(band, lp);
        band.animate()
                .translationX(Ui.dp(this, driftDp))
                .alpha(0.28f)
                .setDuration(duration)
                .withEndAction(() -> band.animate().translationX(0).alpha(0.16f).setDuration(duration).start())
                .start();
    }

    private void startSplashProgress() {
        splashProgress = 0;
        handler.post(new Runnable() {
            @Override
            public void run() {
                if (isFinishing() || splashProgressBar == null) return;
                splashProgress = Math.min(100, splashProgress + 2);
                splashProgressBar.setProgress(splashProgress);
                if (splashPercent != null) splashPercent.setText("Opening " + splashProgress + "%");
                if (splashProgress >= 100) {
                    checkServerAndOpen();
                    return;
                }
                handler.postDelayed(this, 36);
            }
        });
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
