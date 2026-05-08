package ph.gov.sipalay.attendance;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

public class LoginActivity extends Activity {
    private EditText username;
    private EditText password;
    private Button signIn;
    private ProgressBar progress;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestNotificationPermission();
        buildUi();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(42, 42, 42, 42);
        root.setBackgroundColor(Color.rgb(248, 250, 252));

        TextView title = new TextView(this);
        title.setText("School Attendance QR based Systems");
        title.setTextColor(Color.rgb(15, 23, 42));
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        title.setTypeface(null, 1);
        root.addView(title, matchWrap());

        TextView subtitle = new TextView(this);
        subtitle.setText("SDS / ASDS Native Dashboard");
        subtitle.setTextColor(Color.rgb(71, 85, 105));
        subtitle.setTextSize(15);
        subtitle.setGravity(Gravity.CENTER);
        root.addView(subtitle, matchWrap());

        username = field("Username", false);
        password = field("Password", true);
        root.addView(username, fieldParams());
        root.addView(password, fieldParams());

        signIn = new Button(this);
        signIn.setText("Sign In");
        signIn.setTextColor(Color.WHITE);
        signIn.setBackgroundColor(Color.rgb(79, 70, 229));
        root.addView(signIn, fieldParams());

        progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);
        root.addView(progress, matchWrap());

        signIn.setOnClickListener(v -> login());
        setContentView(root);
    }

    private EditText field(String hint, boolean secret) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setSingleLine(true);
        e.setTextSize(16);
        e.setPadding(24, 8, 24, 8);
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
                if (!"superintendent".equals(role) && !"asst_superintendent".equals(role)) {
                    throw new IllegalArgumentException("This app is only for SDS and ASDS accounts.");
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
                    Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private void setLoading(boolean loading) {
        progress.setVisibility(loading ? View.VISIBLE : View.GONE);
        signIn.setEnabled(!loading);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 20);
        }
    }

    private LinearLayout.LayoutParams fieldParams() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 118);
        lp.setMargins(0, 26, 0, 0);
        return lp;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }
}
