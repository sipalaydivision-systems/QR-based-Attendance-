package ph.gov.sipalay.attendance;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

public class AbsenceWorker extends Worker {
    private static final String WORK_NAME = "two_day_absence_poll";
    private static final String CHANNEL_ID = "two_day_absence_alerts";

    public AbsenceWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(AbsenceWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    static void cancel(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        if (!SessionStore.isLoggedIn(context)) return Result.success();
        try {
            JSONArray flags = new JSONArray(ApiClient.getRaw(context, "/api/absence-flags?days=2"));
            if (flags.length() == 0) return Result.success();

            String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            String key = today + ":" + flags.length();
            String last = SessionStore.prefs(context).getString("last_absence_notification", "");
            if (key.equals(last)) return Result.success();

            JSONObject first = flags.optJSONObject(0);
            String body = flags.length() == 1
                    ? absenceNotificationBody(first)
                    : flags.length() + " flagged. First: " + absenceNotificationBody(first);
            notify(context, absenceTitle(flags.length()), body);
            SessionStore.prefs(context).edit().putString("last_absence_notification", key).apply();
            return Result.success();
        } catch (SecurityException e) {
            SessionStore.clear(context);
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }

    private void notify(Context context, String title, String body) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "2-Day Absence Alerts", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Alerts SDS and ASDS users when students reach 2-day absence.");
            manager.createNotificationChannel(channel);
        }

        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        Intent intent = new Intent(context, DashboardActivity.class);
        intent.putExtra("tab", "alerts");
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                100,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH);

        manager.notify(2001, builder.build());
    }

    private String absenceNotificationBody(JSONObject row) {
        if (row == null) return "Flagged student details unavailable.";
        return row.optString("name", "Student")
                + " | " + new SimpleDateFormat("EEEE, MMMM d, yyyy", Locale.US).format(new Date())
                + " | " + valueOrDash(row.optString("grade_name", ""))
                + " - " + valueOrDash(row.optString("section_name", ""))
                + " | LRN: " + valueOrDash(row.optString("lrn", ""))
                + " | " + row.optInt("absent_days", 2) + " days absent"
                + " | Adviser: " + valueOrDash(row.optString("adviser", ""));
    }

    private String valueOrDash(String value) {
        return value == null || value.trim().isEmpty() ? "-" : value.trim();
    }

    private String absenceTitle(int count) {
        return count == 1 ? "1 student absent 2+ days" : count + " students absent 2+ days";
    }
}
