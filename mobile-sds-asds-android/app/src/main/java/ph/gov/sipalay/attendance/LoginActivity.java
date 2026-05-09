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
        requestNotificationPermission();
        buildUi();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(28, 28, 28, 28);
        root.setBackground(Ui.verticalGradient(android.graphics.Color.rgb(214, 219, 238), android.graphics.Color.rgb(246, 247, 252), 0));
        scroll.addView(root, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));

        LinearLayout phone = new LinearLayout(this);
        phone.setOrientation(LinearLayout.VERTICAL);
        phone.setGravity(Gravity.CENTER_HORIZONTAL);
        phone.setBackground(Ui.strokeBg(Ui.CARD, Ui.LINE, 34));
        Ui.elevate(phone, 14);
        root.addView(phone, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setGravity(Gravity.CENTER);
        hero.setPadding(28, 34, 28, 34);
        hero.setBackground(Ui.verticalGradient(Ui.PRIMARY, android.graphics.Color.rgb(255, 130, 36), 34));
        phone.addView(hero, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, 300));

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setAdjustViewBounds(true);
        hero.addView(logo, Ui.lp(96, 96));

        TextView title = Ui.text(this, "School Attendance", 25, android.graphics.Color.WHITE, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        hero.addView(title, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 0));

        TextView subtitle = Ui.text(this, "QR based mobile dashboard", 14, android.graphics.Color.WHITE, Typeface.NORMAL);
        subtitle.setGravity(Gravity.CENTER);
        hero.addView(subtitle, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 8, 0, 0));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(34, 28, 34, 32);
        phone.addView(card, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        errorBox = Ui.text(this, "", 14, Ui.RED, Typeface.BOLD);
        errorBox.setGravity(Gravity.CENTER);
        errorBox.setPadding(18, 14, 18, 14);
        errorBox.setBackground(Ui.strokeBg(android.graphics.Color.rgb(254, 242, 242), android.graphics.Color.rgb(252, 165, 165), 18));
        errorBox.setVisibility(View.GONE);
        card.addView(errorBox, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 0, 0, 18));

        username = field("Username", false);
        password = field("Password", true);
        card.addView(username, fieldParams());
        card.addView(password, fieldParams());

        signIn = new Button(this);
        signIn.setText("LOGIN");
        signIn.setTextColor(android.graphics.Color.WHITE);
        signIn.setTextSize(14);
        signIn.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        signIn.setAllCaps(false);
        signIn.setBackground(Ui.gradient(Ui.PLUM, android.graphics.Color.rgb(105, 48, 105), 44));
        card.addView(signIn, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, 86, 0, 8, 0, 0));

        progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);
        card.addView(progress, Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 0));

        signIn.setOnClickListener(v -> login());
        setContentView(scroll);
        Ui.reveal(phone, 80);
    }

    private TextView label(String value) {
        TextView label = Ui.text(this, value, 12, Ui.MUTED, Typeface.BOLD);
        label.setAllCaps(true);
        return label;
    }

    private EditText field(String hint, boolean secret) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setSingleLine(true);
        e.setTextSize(16);
        e.setPadding(22, 0, 22, 0);
        e.setTextColor(Ui.PLUM);
        e.setHintTextColor(android.graphics.Color.rgb(155, 125, 158));
        e.setBackground(Ui.strokeBg(android.graphics.Color.WHITE, Ui.PLUM, 44));
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
                if (!"super_admin".equals(role) && !"superintendent".equals(role) && !"asst_superintendent".equals(role)) {
                    throw new IllegalArgumentException("This app is only for SDS and ASDS dashboard accounts.");
                }
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
        signIn.setText(loading ? "Signing in..." : "LOGIN");
        if (loading) Ui.pulse(signIn);
        if (loading) errorBox.setVisibility(View.GONE);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 20);
        }
    }

    private LinearLayout.LayoutParams fieldParams() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 96);
        lp.setMargins(0, 0, 0, 18);
        return lp;
    }
}
