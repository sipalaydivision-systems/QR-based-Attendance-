package ph.gov.sipalay.attendance;

import android.content.Context;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class ApiClient {
    private ApiClient() {}

    static JSONObject login(Context context, String username, String password) throws Exception {
        refreshBaseUrl(context);
        if (!SessionStore.hasConfiguredBaseUrl(context)) {
            throw new IllegalStateException("Connect the app from the web download page first.");
        }
        String body = "username=" + enc(username) + "&password=" + enc(password);
        HttpURLConnection conn = open(context, "/app-login", "POST");
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        conn.setDoOutput(true);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(body.getBytes("UTF-8"));
        }
        String response = read(conn);
        JSONObject json = parseJson(response, friendlyServerError(response));
        if (conn.getResponseCode() >= 400 || !json.optBoolean("success")) {
            throw new IllegalArgumentException(json.optString("message", "Username or password is incorrect."));
        }
        String cookie = extractCookie(conn.getHeaderFields());
        if (cookie.isEmpty()) throw new IllegalStateException("Server did not return a session cookie.");
        json.put("_cookie", cookie);
        return json;
    }

    static JSONObject getJson(Context context, String path) throws Exception {
        HttpURLConnection conn = open(context, path, "GET");
        String cookie = SessionStore.getCookie(context);
        if (!cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
        String response = read(conn);
        if (conn.getResponseCode() == 401) throw new SecurityException("Session expired. Please sign in again.");
        if (conn.getResponseCode() >= 400) throw new IllegalStateException(response);
        return parseJson(response, "Server returned an invalid dashboard response.");
    }

    static String getRaw(Context context, String path) throws Exception {
        HttpURLConnection conn = open(context, path, "GET");
        String cookie = SessionStore.getCookie(context);
        if (!cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
        String response = read(conn);
        if (conn.getResponseCode() == 401) throw new SecurityException("Session expired.");
        if (conn.getResponseCode() >= 400) throw new IllegalStateException(response);
        return response;
    }

    static void refreshBaseUrl(Context context) {
        try {
            String current = SessionStore.getBaseUrl(context);
            String bundled = SessionStore.getBundledBaseUrl(context);

            Set<String> candidates = new LinkedHashSet<>();
            addCandidate(candidates, current);
            addCandidate(candidates, bundled);
            candidates.addAll(loadRemoteConfigCandidates(context));

            for (String candidate : candidates) {
                if (isAttendanceSystem(candidate)) {
                    SessionStore.saveBaseUrl(context, candidate);
                    return;
                }
            }
        } catch (Exception ignored) {}
    }

    static List<String> loadRemoteConfigCandidates(Context context) {
        List<String> candidates = new ArrayList<>();
        try {
            int configId = context.getResources().getIdentifier("config_url", "string", context.getPackageName());
            if (configId == 0) return candidates;
            String configUrl = context.getString(configId);
            if (!configUrl.startsWith("https://") && !configUrl.startsWith("http://")) return candidates;
            HttpURLConnection conn = (HttpURLConnection) new URL(configUrl).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4500);
            conn.setReadTimeout(4500);
            conn.setRequestProperty("Accept", "application/json");
            String response = read(conn);
            if (conn.getResponseCode() >= 400) return candidates;
            JSONObject config = new JSONObject(response);
            addCandidate(candidates, config.optString("base_url", ""));
            if (config.has("fallback_urls")) {
                for (int i = 0; i < config.getJSONArray("fallback_urls").length(); i++) {
                    addCandidate(candidates, config.getJSONArray("fallback_urls").optString(i, ""));
                }
            }
        } catch (Exception ignored) {}
        return candidates;
    }

    private static void addCandidate(Set<String> candidates, String baseUrl) {
        String normalized = SessionStore.normalizeBaseUrl(baseUrl);
        if (normalized.startsWith("https://") || normalized.startsWith("http://")) {
            candidates.add(normalized);
        }
    }

    private static void addCandidate(List<String> candidates, String baseUrl) {
        String normalized = SessionStore.normalizeBaseUrl(baseUrl);
        if ((normalized.startsWith("https://") || normalized.startsWith("http://")) && !candidates.contains(normalized)) {
            candidates.add(normalized);
        }
    }

    static boolean isAttendanceSystem(String baseUrl) {
        String normalized = baseUrl.replaceAll("/+$", "");
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(normalized + "/api/app-info").openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4500);
            conn.setReadTimeout(4500);
            conn.setRequestProperty("Accept", "application/json");
            String response = read(conn);
            if (conn.getResponseCode() >= 400) return false;
            JSONObject info = new JSONObject(response);
            return "school-attendance-qr-based-systems".equals(info.optString("app"));
        } catch (Exception e) {
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(normalized + "/login").openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(4500);
                conn.setReadTimeout(4500);
                conn.setRequestProperty("Accept", "text/html");
                String response = read(conn);
                String body = response == null ? "" : response.toLowerCase();
                return conn.getResponseCode() < 400
                        && (body.contains("school attendance qr based systems") || body.contains("qr attendance system"));
            } catch (Exception ignored) {
                return false;
            }
        }
    }

    private static HttpURLConnection open(Context context, String path, String method) throws Exception {
        if (!SessionStore.hasConfiguredBaseUrl(context)) {
            throw new IllegalStateException("The attendance server is not configured in this APK yet.");
        }
        URL url = new URL(SessionStore.getBaseUrl(context) + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(30000);
        conn.setReadTimeout(30000);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("X-Requested-With", "SchoolAttendanceAndroid");
        conn.setRequestProperty("User-Agent", "SchoolAttendanceDivisionAndroid/1.0");
        return conn;
    }

    private static String read(HttpURLConnection conn) throws Exception {
        InputStream is = conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (is == null) return "";
        try (BufferedReader br = new BufferedReader(new InputStreamReader(is))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            return sb.toString();
        }
    }

    private static String extractCookie(Map<String, List<String>> headers) {
        List<String> cookies = null;
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            if (entry.getKey() != null && "set-cookie".equalsIgnoreCase(entry.getKey())) {
                cookies = entry.getValue();
                break;
            }
        }
        if (cookies == null || cookies.isEmpty()) return "";
        StringBuilder out = new StringBuilder();
        for (String c : cookies) {
            if (out.length() > 0) out.append("; ");
            out.append(c.split(";", 2)[0]);
        }
        return out.toString();
    }

    private static String enc(String value) throws Exception {
        return URLEncoder.encode(value, "UTF-8");
    }

    private static JSONObject parseJson(String response, String fallback) throws Exception {
        try {
            return new JSONObject(response);
        } catch (Exception e) {
            throw new IllegalStateException(fallback);
        }
    }

    private static String friendlyServerError(String response) {
        String raw = response == null ? "" : response.toLowerCase();
        if (raw.contains("application not found") || raw.contains("railway")) {
            return "The mobile app is not connected to the current Railway server yet. Please download the latest APK from the web system.";
        }
        if (raw.trim().startsWith("<!doctype") || raw.trim().startsWith("<html")) {
            return "The attendance server did not return a login response. Please install the latest APK.";
        }
        return "Cannot connect to the attendance server. Please check internet and install the latest APK.";
    }
}
