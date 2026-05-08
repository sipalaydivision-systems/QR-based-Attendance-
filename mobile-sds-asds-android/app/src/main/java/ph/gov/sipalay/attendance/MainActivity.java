package ph.gov.sipalay.attendance;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showSplash();
        applyConfigurationIntent(getIntent());
        new Thread(() -> {
            boolean hasServer = SessionStore.hasConfiguredBaseUrl(this);
            try {
                Thread.sleep(650);
            } catch (InterruptedException ignored) {}
            runOnUiThread(() -> {
                if (!SessionStore.hasConfiguredBaseUrl(this)) {
                    showConnectRequired();
                    return;
                }
                startActivity(new Intent(this, WebAppActivity.class));
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

    private boolean applyConfigurationIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return false;
        Uri uri = intent.getData();
        String baseUrl = uri.getQueryParameter("base_url");
        if (baseUrl != null && (baseUrl.startsWith("https://") || baseUrl.startsWith("http://"))) {
            SessionStore.clear(this);
            SessionStore.saveBaseUrl(this, baseUrl);
            return true;
        }
        return false;
    }

    private void showConnectRequired() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(38, 38, 38, 38);
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

        TextView title = Ui.text(this, "Connect Mobile App", 24, Ui.INK, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        card.addView(title, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 8));

        TextView message = Ui.text(this, "Open the web system on this phone, go to /mobile-app, then tap Connect App. This links mobile login to the same MySQL database as the website.", 15, Ui.MUTED, Typeface.NORMAL);
        message.setGravity(Gravity.CENTER);
        card.addView(message, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        Button retry = new Button(this);
        retry.setText("I tapped Connect App");
        retry.setAllCaps(false);
        retry.setTextColor(android.graphics.Color.WHITE);
        retry.setTextSize(16);
        retry.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        retry.setBackground(Ui.gradient(Ui.PRIMARY, android.graphics.Color.rgb(67, 56, 202), 24));
        retry.setOnClickListener(v -> {
            if (SessionStore.hasConfiguredBaseUrl(this)) {
                startActivity(new Intent(this, WebAppActivity.class));
                finish();
            }
        });
        card.addView(retry, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, 112, 0, 24, 0, 0));

        setContentView(root);
    }
}
