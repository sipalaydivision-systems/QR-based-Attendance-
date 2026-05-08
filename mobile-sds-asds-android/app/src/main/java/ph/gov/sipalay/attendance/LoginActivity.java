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
    private TextView helper;

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
        root.setPadding(30, 36, 30, 36);
        root.setBackground(Ui.gradient(android.graphics.Color.rgb(226, 232, 240), android.graphics.Color.rgb(248, 250, 252), 0));
        scroll.addView(root, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(34, 34, 34, 34);
        card.setBackground(Ui.strokeBg(Ui.CARD, android.graphics.Color.rgb(219, 227, 239), 34));
        Ui.elevate(card, 8);
        root.addView(card, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setAdjustViewBounds(true);
        card.addView(logo, Ui.lp(96, 96));

        TextView title = Ui.text(this, "School Attendance QR based Systems", 24, Ui.INK, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        card.addView(title, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 0));

        TextView subtitle = Ui.text(this, "SDS / ASDS Native Dashboard", 15, Ui.MUTED, Typeface.NORMAL);
        subtitle.setGravity(Gravity.CENTER);
        card.addView(subtitle, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 8, 0, 18));

        username = field("Username", false);
        password = field("Password", true);
        card.addView(label("Username"));
        card.addView(username, fieldParams());
        card.addView(label("Password"));
        card.addView(password, fieldParams());

        signIn = new Button(this);
        signIn.setText("Sign In");
        signIn.setTextColor(android.graphics.Color.WHITE);
        signIn.setTextSize(16);
        signIn.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        signIn.setAllCaps(false);
        signIn.setBackground(Ui.bg(Ui.PRIMARY, 24));
        card.addView(signIn, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, 112, 0, 22, 0, 0));

        progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);
        card.addView(progress, Ui.marginLp(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 0));

        helper = Ui.text(this, "Use your SDS, ASDS, or admin account.", 13, Ui.MUTED, Typeface.NORMAL);
        helper.setGravity(Gravity.CENTER);
        card.addView(helper, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 0));

        signIn.setOnClickListener(v -> login());
        setContentView(scroll);
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
        e.setBackground(Ui.strokeBg(android.graphics.Color.rgb(248, 250, 252), android.graphics.Color.rgb(203, 213, 225), 18));
        if (secret) e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        return e;
    }

    private void login() {
        final String u = username.getText().toString().trim();
        final String p = password.getText().toString();
        if (u.isEmpty() || p.isEmpty()) {
            Toast.makeText(this, "Enter username and password.", Toast.LENGTH_SHORT).show();
            return;
        }
        setLoading(true);
        new Thread(() -> {
            try {
                JSONObject result = ApiClient.login(this, u, p);
                JSONObject user = result.getJSONObject("user");
                String role = user.optString("role");
                if (!"super_admin".equals(role) && !"superintendent".equals(role) && !"asst_superintendent".equals(role)) {
                    throw new IllegalArgumentException("This app is only for division SDS and ASDS dashboard accounts.");
                }
                SessionStore.saveLogin(this, result.getString("_cookie"), user.optString("fullname", u), role);
                AbsenceWorker.schedule(this);
                runOnUiThread(() -> {
                    startActivity(new Intent(this, DashboardActivity.class));
                    finish();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    setLoading(false);
                    helper.setText(e.getMessage());
                    helper.setTextColor(Ui.RED);
                    Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private void setLoading(boolean loading) {
        progress.setVisibility(loading ? View.VISIBLE : View.GONE);
        signIn.setEnabled(!loading);
        signIn.setText(loading ? "Signing in..." : "Sign In");
        helper.setText(loading ? "Connecting securely to Railway..." : "Use your SDS, ASDS, or admin account.");
        helper.setTextColor(Ui.MUTED);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 20);
        }
    }

    private LinearLayout.LayoutParams fieldParams() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 96);
        lp.setMargins(0, 8, 0, 18);
        return lp;
    }
}
