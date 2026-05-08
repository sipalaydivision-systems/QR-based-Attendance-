package ph.gov.sipalay.attendance;

import android.content.Context;
import android.content.SharedPreferences;

final class SessionStore {
    private static final String PREFS = "division_app_session";

    private SessionStore() {}

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String getBaseUrl(Context context) {
        String configured = context.getString(context.getResources().getIdentifier("base_url", "string", context.getPackageName()));
        return prefs(context).getString("base_url", configured).replaceAll("/+$", "");
    }

    static void saveBaseUrl(Context context, String baseUrl) {
        prefs(context).edit()
                .putString("base_url", normalizeBaseUrl(baseUrl))
                .apply();
    }

    static String normalizeBaseUrl(String baseUrl) {
        String value = baseUrl == null ? "" : baseUrl.trim();
        if (value.endsWith("/")) value = value.replaceAll("/+$", "");
        return value;
    }

    static String getCookie(Context context) {
        return prefs(context).getString("cookie", "");
    }

    static void saveLogin(Context context, String cookie, String fullname, String role) {
        prefs(context).edit()
                .putString("cookie", cookie)
                .putString("fullname", fullname)
                .putString("role", role)
                .apply();
    }

    static String getFullname(Context context) {
        return prefs(context).getString("fullname", "Division User");
    }

    static boolean isLoggedIn(Context context) {
        return !getCookie(context).isEmpty();
    }

    static void clear(Context context) {
        String baseUrl = getBaseUrl(context);
        prefs(context).edit()
                .remove("cookie")
                .remove("fullname")
                .remove("role")
                .remove("last_absence_notification")
                .putString("base_url", baseUrl)
                .apply();
    }
}
