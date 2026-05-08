package ph.gov.sipalay.attendance;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showSplash();
        applyConfigurationIntent(getIntent());
        new Thread(() -> {
            ApiClient.refreshBaseUrl(this);
            boolean hasServer = SessionStore.hasConfiguredBaseUrl(this);
            try {
                Thread.sleep(650);
            } catch (InterruptedException ignored) {}
            runOnUiThread(() -> {
                if (!SessionStore.hasConfiguredBaseUrl(this)) {
                    showServerUnavailable();
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
            if (ApiClient.isAttendanceSystem(baseUrl)) {
                SessionStore.clear(this);
                SessionStore.saveBaseUrl(this, baseUrl);
                return true;
            }
        }
        return false;
    }

    private void showServerUnavailable() {
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

        TextView title = Ui.text(this, "Set Railway URL", 24, Ui.INK, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        card.addView(title, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 8));

        TextView message = Ui.text(this, "Enter the Railway link where the web dashboard opens. The app will use the same login, dashboard, and MySQL database.", 15, Ui.MUTED, Typeface.NORMAL);
        message.setGravity(Gravity.CENTER);
        card.addView(message, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        EditText urlInput = new EditText(this);
        urlInput.setHint("https://your-app.up.railway.app");
        urlInput.setSingleLine(true);
        urlInput.setText(SessionStore.getBaseUrl(this));
        urlInput.setTextSize(15);
        urlInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setPadding(22, 0, 22, 0);
        urlInput.setBackground(Ui.strokeBg(android.graphics.Color.rgb(248, 250, 252), android.graphics.Color.rgb(203, 213, 225), 18));
        card.addView(urlInput, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, 96, 0, 22, 0, 0));

        TextView error = Ui.text(this, "", 13, Ui.RED, Typeface.BOLD);
        error.setGravity(Gravity.CENTER);
        error.setVisibility(TextView.GONE);
        card.addView(error, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, 12));

        Button retry = new Button(this);
        retry.setText("Open Dashboard");
        retry.setAllCaps(false);
        retry.setTextColor(android.graphics.Color.WHITE);
        retry.setTextSize(16);
        retry.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        retry.setBackground(Ui.gradient(Ui.PRIMARY, android.graphics.Color.rgb(67, 56, 202), 24));
        retry.setOnClickListener(v -> {
            String baseUrl = SessionStore.normalizeBaseUrl(urlInput.getText().toString());
            if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://")) {
                error.setText("Enter a valid Railway URL starting with https://");
                error.setVisibility(TextView.VISIBLE);
                return;
            }
            retry.setEnabled(false);
            retry.setText("Checking...");
            error.setVisibility(TextView.GONE);
            new Thread(() -> {
                boolean ok = ApiClient.isAttendanceSystem(baseUrl);
                runOnUiThread(() -> {
                    retry.setEnabled(true);
                    retry.setText("Open Dashboard");
                    if (!ok) {
                        error.setText("That URL is not this QR attendance system. Open the web dashboard in browser and copy its Railway URL.");
                        error.setVisibility(TextView.VISIBLE);
                        Toast.makeText(this, "Invalid attendance system URL.", Toast.LENGTH_LONG).show();
                        return;
                    }
                    SessionStore.clearServer(this);
                    SessionStore.saveBaseUrl(this, baseUrl);
                    startActivity(new Intent(this, WebAppActivity.class));
                    finish();
                });
            }).start();
        });
        card.addView(retry, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, 112, 0, 8, 0, 0));

        setContentView(root);
    }
}
