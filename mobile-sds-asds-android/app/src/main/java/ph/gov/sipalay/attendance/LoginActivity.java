package ph.gov.sipalay.attendance;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

public class LoginActivity extends Activity {
    private EditText username;
    private EditText password;
    private Button signIn;
    private ProgressBar progress;
    private TextView errorBox;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        requestNotificationPermission();
        buildUi();
    }

    private void buildUi() {
        Ui.setBars(getWindow(), Ui.GREEN_DARK, false, android.graphics.Color.WHITE);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        scroll.setSmoothScrollingEnabled(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(android.graphics.Color.rgb(245, 248, 246));
        scroll.addView(root, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));

        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setGravity(Gravity.CENTER);
        hero.setPadding(Ui.dp(this, 24), Ui.statusBarHeight(this) + Ui.dp(this, 18), Ui.dp(this, 24), Ui.dp(this, 46));
        hero.setBackground(Ui.verticalGradient(Ui.GREEN, Ui.GREEN_DARK, 0));
        root.addView(hero, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 246) + Math.min(Ui.statusBarHeight(this), Ui.dp(this, 26))));

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setAdjustViewBounds(true);
        logo.setBackground(Ui.strokeBg(android.graphics.Color.argb(40, 255, 255, 255), android.graphics.Color.argb(70, 255, 255, 255), Ui.dp(this, 22)));
        logo.setPadding(Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10), Ui.dp(this, 10));
        hero.addView(logo, Ui.lp(Ui.dp(this, 72), Ui.dp(this, 72)));

        TextView title = Ui.text(this, "EduTrack", 30, android.graphics.Color.WHITE, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        hero.addView(title, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 14), 0, 0));

        TextView subtitle = Ui.text(this, "Attendance Monitoring System", 14, android.graphics.Color.rgb(221, 255, 242), Typeface.NORMAL);
        subtitle.setGravity(Gravity.CENTER);
        hero.addView(subtitle, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, 0));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(Ui.dp(this, 22), Ui.dp(this, 22), Ui.dp(this, 22), Ui.dp(this, 22));
        card.setBackground(Ui.bg(android.graphics.Color.WHITE, Ui.dp(this, 24)));
        Ui.elevate(card, 16);
        LinearLayout.LayoutParams cardLp = Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, Ui.dp(this, 20), -Ui.dp(this, 42), Ui.dp(this, 20), 0);
        root.addView(card, cardLp);

        TextView welcome = Ui.text(this, "Welcome Back", 25, Ui.INK, Typeface.BOLD);
        card.addView(welcome);

        TextView continueText = Ui.text(this, "Sign in to your attendance dashboard", 14, android.graphics.Color.rgb(102, 116, 112), Typeface.NORMAL);
        card.addView(continueText, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 2), 0, Ui.dp(this, 18)));

        errorBox = Ui.text(this, "", 14, Ui.RED, Typeface.BOLD);
        errorBox.setPadding(Ui.dp(this, 14), Ui.dp(this, 12), Ui.dp(this, 14), Ui.dp(this, 12));
        errorBox.setBackground(Ui.strokeBg(android.graphics.Color.rgb(254, 242, 242), android.graphics.Color.rgb(252, 165, 165), Ui.dp(this, 14)));
        errorBox.setVisibility(View.GONE);
        card.addView(errorBox, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, Ui.dp(this, 18)));

        card.addView(label("Username"));
        username = field("Enter your username", false);
        card.addView(username, fieldParams());
        card.addView(label("Password"));
        password = field("Enter your password", true);
        card.addView(password, fieldParams());

        signIn = new Button(this);
        signIn.setText("Sign In");
        signIn.setTextColor(android.graphics.Color.WHITE);
        signIn.setTextSize(18);
        signIn.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        signIn.setAllCaps(false);
        signIn.setBackground(Ui.gradient(Ui.GREEN, Ui.GREEN_DARK, Ui.dp(this, 18)));
        card.addView(signIn, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 52), 0, Ui.dp(this, 8), 0, 0));

        progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);
        LinearLayout progressWrap = new LinearLayout(this);
        progressWrap.setGravity(Gravity.CENTER);
        progressWrap.addView(progress, Ui.lp(Ui.dp(this, 38), Ui.dp(this, 38)));
        card.addView(progressWrap, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 8), 0, 0));

        TextView footer = Ui.text(this, "Schools Division Office - Sipalay City\nv1.0.6", 13, android.graphics.Color.rgb(148, 163, 158), Typeface.NORMAL);
        footer.setGravity(Gravity.CENTER);
        root.addView(footer, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, Ui.dp(this, 24), 0, Ui.dp(this, 110)));

        signIn.setOnClickListener(v -> login());
        setContentView(scroll);
        Ui.reveal(hero, 0);
        Ui.reveal(card, 120);
    }

    private TextView label(String value) {
        TextView label = Ui.text(this, value, 14, android.graphics.Color.rgb(33, 33, 33), Typeface.BOLD);
        return label;
    }

    private EditText field(String hint, boolean secret) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setSingleLine(true);
        e.setTextSize(15);
        e.setPadding(Ui.dp(this, 16), 0, Ui.dp(this, 16), 0);
        e.setTextColor(android.graphics.Color.rgb(30, 30, 30));
        e.setHintTextColor(android.graphics.Color.rgb(181, 181, 181));
        e.setBackground(Ui.strokeBg(android.graphics.Color.rgb(247, 247, 246), android.graphics.Color.rgb(214, 214, 208), Ui.dp(this, 18)));
        if (secret) e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        return e;
    }

    private void login() {
        final String u = username.getText().toString().trim();
        final String p = password.getText().toString();
        if (u.isEmpty() || p.isEmpty()) {
            showError("Enter username and password.");
            return;
        }
        setLoading(true);
        new Thread(() -> {
            try {
                JSONObject result = ApiClient.login(this, u, p);
                JSONObject user = result.getJSONObject("user");
                String role = user.optString("role");
                SessionStore.saveLogin(this, result.getString("_cookie"), user.optString("fullname", u), role);
                AbsenceWorker.schedule(this);
                runOnUiThread(() -> {
                    startActivity(new Intent(this, DashboardActivity.class));
                    overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
                    finish();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    setLoading(false);
                    showError(e.getMessage());
                    Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private void showError(String message) {
        errorBox.setText(message == null || message.trim().isEmpty() ? "Login failed." : message);
        errorBox.setVisibility(View.VISIBLE);
    }

    private void setLoading(boolean loading) {
        progress.setVisibility(loading ? View.VISIBLE : View.GONE);
        signIn.setEnabled(!loading);
        signIn.setText(loading ? "Signing in..." : "Sign In");
        if (loading) Ui.pulse(signIn);
        if (loading) errorBox.setVisibility(View.GONE);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 20);
        }
    }

    private LinearLayout.LayoutParams fieldParams() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 50));
        lp.setMargins(0, Ui.dp(this, 7), 0, Ui.dp(this, 16));
        return lp;
    }
}
