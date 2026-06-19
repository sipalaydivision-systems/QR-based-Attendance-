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
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;

public class DailyReportWorker extends Worker {
    private static final String WORK_NAME = "daily_7pm_attendance_report";
    private static final String CHANNEL_ID = "daily_attendance_report";
    private static final int NOTIFICATION_ID = 7001;
    private static final TimeZone MANILA = TimeZone.getTimeZone("Asia/Manila");

    public DailyReportWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DailyReportWorker.class)
                .setConstraints(constraints)
                .setInitialDelay(millisUntilNextSevenPm(), TimeUnit.MILLISECONDS)
                .build();
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request);
    }

    static void cancel(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        try {
            if (!SessionStore.isLoggedIn(context)) {
                schedule(context);
                return Result.success();
            }

            String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            String sentKey = "daily_report_sent_" + today;
            if (!SessionStore.prefs(context).getBoolean(sentKey, false)) {
                JSONObject dashboard = ApiClient.getJson(context, "/api/dashboard-data?date=" + today);
                showReportNotification(context, dashboard);
                SessionStore.prefs(context).edit().putBoolean(sentKey, true).apply();
            }

            schedule(context);
            return Result.success();
        } catch (SecurityException e) {
            SessionStore.clear(context);
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }

    private static long millisUntilNextSevenPm() {
        Calendar now = Calendar.getInstance(MANILA);
        Calendar target = Calendar.getInstance(MANILA);
        target.set(Calendar.HOUR_OF_DAY, 19);
        target.set(Calendar.MINUTE, 0);
        target.set(Calendar.SECOND, 0);
        target.set(Calendar.MILLISECOND, 0);
        if (!target.after(now)) target.add(Calendar.DATE, 1);
        return Math.max(1000L, target.getTimeInMillis() - now.getTimeInMillis());
    }

    private void showReportNotification(Context context, JSONObject data) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Daily 7 PM Attendance Report", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Daily attendance report sent at 7:00 PM.");
            manager.createNotificationChannel(channel);
        }
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        int rate = data.optInt("attendance_rate", 0);
        int present = data.optInt("students_present", 0);
        int halfDay = data.optInt("students_half_day", 0);
        int absent = data.optInt("students_absent", 0);
        int late = data.optInt("students_late", 0);
        int teachersPresent = data.optInt("teachers_present", 0);
        int teachersAbsent = data.optInt("teachers_absent", 0);
        String date = new SimpleDateFormat("EEEE, MMMM d, yyyy", Locale.US).format(new Date());
        String title = "SDO Sipalay AI - Daily Report";
        String body = rate + "% attendance - " + present + " present, " + absent + " absent";
        String bigText = date
                + "\nStudents: " + present + " present, " + late + " late, " + halfDay + " half-day, " + absent + " absent"
                + "\nTeachers: " + teachersPresent + " present, " + teachersAbsent + " absent"
                + "\nAttendance Rate: " + rate + "%";

        Intent intent = new Intent(context, DashboardActivity.class);
        intent.putExtra("tab", "reports");
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                7001,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(bigText))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH);
        manager.notify(NOTIFICATION_ID, builder.build());
    }
}
