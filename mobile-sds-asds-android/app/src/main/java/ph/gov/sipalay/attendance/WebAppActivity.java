package ph.gov.sipalay.attendance;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;

public class WebAppActivity extends Activity {
    private static final String CHANNEL_ID = "edutrack_mobile_alerts";
    private WebView webView;
    private ProgressBar progress;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestNotificationPermission();
        buildWebShell();
        loadApp();
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 21);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void buildWebShell() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(248, 250, 252));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(false);
        root.addView(progress, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, 6));

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUserAgentString(settings.getUserAgentString() + " SchoolAttendanceAndroidWebView");
        webView.addJavascriptInterface(new NativeBridge(), "EduTrackNative");

        CookieManager.getInstance().setAcceptCookie(true);
        if (android.os.Build.VERSION.SDK_INT >= 21) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
                progress.setProgress(newProgress);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) {
                    return false;
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectAppMode();
                syncCookies(url);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (request.isForMainFrame() && errorResponse != null && errorResponse.getStatusCode() >= 400) {
                    SessionStore.clearServer(WebAppActivity.this);
                    runOnUiThread(() -> showConnectRequired());
                }
            }
        });

        root.addView(webView, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    private void showConnectRequired() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(android.view.Gravity.CENTER);
        root.setPadding(38, 38, 38, 38);
        root.setBackground(Ui.gradient(Color.rgb(230, 244, 255), Color.rgb(248, 250, 252), 0));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(android.view.Gravity.CENTER_HORIZONTAL);
        card.setPadding(34, 34, 34, 34);
        card.setBackground(Ui.strokeBg(Color.WHITE, Color.rgb(226, 232, 240), 34));
        Ui.elevate(card, 10);
        root.addView(card, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("system_logo", "drawable", getPackageName()));
        logo.setAdjustViewBounds(true);
        card.addView(logo, Ui.lp(92, 92));

        TextView title = Ui.text(this, "Attendance Server Unavailable", 24, Ui.INK, android.graphics.Typeface.BOLD);
        title.setGravity(android.view.Gravity.CENTER);
        card.addView(title, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 0, 18, 0, 8));

        TextView message = Ui.text(this, "The saved server is not opening the QR attendance system. Install the latest APK from the attendance system download page, then reopen the app.", 15, Ui.MUTED, android.graphics.Typeface.NORMAL);
        message.setGravity(android.view.Gravity.CENTER);
        card.addView(message, Ui.lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        Button close = new Button(this);
        close.setText("Close");
        close.setAllCaps(false);
        close.setTextColor(Color.WHITE);
        close.setTextSize(16);
        close.setTypeface(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD);
        close.setBackground(Ui.gradient(Ui.PRIMARY, Color.rgb(67, 56, 202), 24));
        close.setOnClickListener(v -> finish());
        card.addView(close, Ui.marginLp(LinearLayout.LayoutParams.MATCH_PARENT, 112, 0, 24, 0, 0));

        setContentView(root);
    }

    private void loadApp() {
        ApiClient.refreshBaseUrl(this);
        if (!SessionStore.hasConfiguredBaseUrl(this)) {
            Toast.makeText(this, "Live Railway URL is not configured.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        String path = getIntent().getStringExtra("path");
        if (path == null || path.trim().isEmpty()) path = "/app?app=1";
        if (!path.startsWith("/")) path = "/" + path;
        webView.loadUrl(SessionStore.getBaseUrl(this) + path);
    }

    private void injectAppMode() {
        String script = "(function(){"
                + "document.documentElement.classList.add('android-app-webview');"
                + "document.body.classList.add('android-app-webview');"
                + "document.body.classList.add('edutrack-mobile-app');"
                + "var m=document.querySelector('meta[name=viewport]');"
                + "if(m){m.setAttribute('content','width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover');}"
                + "window.dispatchEvent(new Event('edutrack-mobile-ready'));"
                + "})();";
        webView.evaluateJavascript(script, null);
    }

    private void sendNativeNotification(String title, String body) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Edutrack Mobile Alerts", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Mobile attendance alerts and notification tests.");
            manager.createNotificationChannel(channel);
        }
        Intent intent = new Intent(this, WebAppActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 4100, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title == null || title.trim().isEmpty() ? "Edutrack Alert" : title)
                .setContentText(body == null || body.trim().isEmpty() ? "Attendance mobile notification." : body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body == null ? "" : body))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH);
        manager.notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE), builder.build());
    }

    private final class NativeBridge {
        @JavascriptInterface
        public void notify(String title, String body) {
            runOnUiThread(() -> sendNativeNotification(title, body));
        }

        @JavascriptInterface
        public void toast(String message) {
            runOnUiThread(() -> Toast.makeText(WebAppActivity.this, message, Toast.LENGTH_SHORT).show());
        }
    }

    private void syncCookies(String url) {
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null && cookies.contains("connect.sid")) {
            SessionStore.saveCookieOnly(this, cookies);
            AbsenceWorker.schedule(this);
        }
        if (url.contains("/logout") || url.endsWith("/login")) {
            SessionStore.clearLogin(this);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }
}
