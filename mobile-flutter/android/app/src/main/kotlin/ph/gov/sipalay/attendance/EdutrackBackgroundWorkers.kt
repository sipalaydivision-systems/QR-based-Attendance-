package ph.gov.sipalay.attendance

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlin.math.abs

private const val PREFS = "edutrack_native_background"
private const val ABSENCE_WORK = "edutrack_absence_background_poll"
private const val DAILY_WORK = "edutrack_daily_7pm_report"
private const val LEGACY_ABSENCE_WORK = "two_day_absence_poll"
private const val LEGACY_DAILY_WORK = "daily_7pm_attendance_report"
private const val ABSENCE_CHANNEL = "edutrack_absence_background"
private const val DAILY_CHANNEL = "edutrack_daily_report_background"
private const val BASE_URL = "https://sdo-sipalay-edutrack.up.railway.app"

object BackgroundNotificationStore {
    fun save(context: Context, baseUrl: String, cookie: String, fullname: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("base_url", normalizeBaseUrl(baseUrl.ifBlank { BASE_URL }))
            .putString("cookie", cookie)
            .putString("fullname", fullname)
            .apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }

    fun baseUrl(context: Context): String {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString("base_url", BASE_URL)
            .orEmpty()
        return normalizeBaseUrl(raw.ifBlank { BASE_URL })
    }

    fun cookie(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString("cookie", "")
            .orEmpty()

    fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun normalizeBaseUrl(value: String): String = value.trim().trimEnd('/')
}

object EdutrackBackgroundWorkers {
    fun schedule(context: Context) {
        // Railway FCM is the sole notification producer. Never recreate the
        // legacy polling jobs, even if an older Flutter caller reaches here.
        cancel(context)
        BackgroundNotificationStore.clear(context)
    }

    fun cancel(context: Context) {
        val workManager = WorkManager.getInstance(context)
        workManager.cancelUniqueWork(ABSENCE_WORK)
        workManager.cancelUniqueWork(DAILY_WORK)
        // These names were used by the original native EduTrack application.
        // The Flutter app has the same package ID, so its WorkManager database
        // can survive an upgrade and continue producing duplicate alerts.
        workManager.cancelUniqueWork(LEGACY_ABSENCE_WORK)
        workManager.cancelUniqueWork(LEGACY_DAILY_WORK)

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        manager?.cancel(7001)
        if (Build.VERSION.SDK_INT >= 26) {
            manager?.deleteNotificationChannel(ABSENCE_CHANNEL)
            manager?.deleteNotificationChannel(DAILY_CHANNEL)
            manager?.deleteNotificationChannel("two_day_absence_alerts")
            manager?.deleteNotificationChannel("daily_attendance_report")
        }
    }
}

class AbsenceFlagWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {
    override fun doWork(): Result {
        // A WorkRequest queued by an older APK may start before asynchronous
        // cancellation completes. Make the worker itself inert so it can never
        // post a second legacy 2-day absence notification.
        val context = applicationContext
        EdutrackBackgroundWorkers.cancel(context)
        BackgroundNotificationStore.clear(context)
        return Result.success()
    }
}

class DailyReportWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {
    override fun doWork(): Result {
        // The 7 PM report now comes only from Railway FCM. A persisted native
        // job must finish silently rather than showing a duplicate report.
        val context = applicationContext
        EdutrackBackgroundWorkers.cancel(context)
        BackgroundNotificationStore.clear(context)
        return Result.success()
    }

    companion object {
        fun schedule(context: Context, replaceExisting: Boolean = false) {
            EdutrackBackgroundWorkers.cancel(context)
            BackgroundNotificationStore.clear(context)
        }
    }
}

private fun getRaw(context: Context, path: String): String {
    val url = URL(BackgroundNotificationStore.baseUrl(context) + path)
    val conn = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = 30000
        readTimeout = 30000
        setRequestProperty("Accept", "application/json")
        setRequestProperty("Cookie", BackgroundNotificationStore.cookie(context))
        setRequestProperty("X-Requested-With", "SchoolAttendanceAndroid")
    }
    val stream = if (conn.responseCode >= 400) conn.errorStream else conn.inputStream
    val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
    if (conn.responseCode == 401) {
        BackgroundNotificationStore.clear(context)
        throw IllegalStateException("Session expired")
    }
    if (conn.responseCode >= 400) throw IllegalStateException(body)
    return body
}

private fun showNotification(
    context: Context,
    channelId: String,
    channelName: String,
    notificationId: Int,
    title: String,
    body: String,
    tab: String,
) {
    if (
        Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
    ) {
        return
    }
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    if (Build.VERSION.SDK_INT >= 26) {
        manager.createNotificationChannel(
            NotificationChannel(channelId, channelName, NotificationManager.IMPORTANCE_HIGH),
        )
    }
    val intent = Intent(context, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        putExtra("tab", tab)
    }
    val pendingIntent = PendingIntent.getActivity(
        context,
        notificationId,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(context, channelId)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setLargeIcon(BitmapFactory.decodeResource(context.resources, R.mipmap.ic_launcher))
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setContentIntent(pendingIntent)
        .setAutoCancel(true)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .build()
    manager.notify(notificationId, notification)
}

private fun absenceKey(row: JSONObject, day: String): String =
    listOf(
        day,
        row.optString("person_type", "student"),
        row.optString("id", row.optString("lrn", row.optString("name", ""))),
        row.optString("school_name", ""),
        row.optInt("absent_days", 2).toString(),
    ).joinToString("|") { it.trim().ifEmpty { "-" } }

private fun absenceBody(row: JSONObject): String {
    val name = row.optString("name", "Student")
    val grade = row.optString("grade_name", "-")
    val section = row.optString("section_name", "-")
    val school = row.optString("school_name", "-")
    val lrn = row.optString("lrn", "-")
    val adviser = row.optString("adviser", "Not assigned")
    val days = row.optInt("absent_days", 2)
    return "$name\n$grade - $section | $school\nLRN: $lrn | $days days absent\nAdviser: $adviser"
}

private fun dailyReportBody(data: JSONObject): String {
    val rate = data.optInt("attendance_rate", 0)
    val present = data.optInt("students_present", 0)
    val late = data.optInt("students_late", 0)
    val halfDay = data.optInt("students_half_day", 0)
    val absent = data.optInt("students_absent", 0)
    val teachersPresent = data.optInt("teachers_present", 0)
    val teachersAbsent = data.optInt("teachers_absent", 0)
    return "Attendance Rate: $rate%\n" +
        "Students: $present present, $late late, $halfDay half-day, $absent absent\n" +
        "Teachers: $teachersPresent present, $teachersAbsent absent"
}

private fun stableId(value: String, base: Int): Int {
    var hash = 17
    value.forEach { hash = 31 * hash + it.code }
    return base + abs(hash % 700000)
}

private fun todayKey(): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Calendar.getInstance(manila()).time)

private fun millisUntilNextSevenPm(): Long {
    val now = Calendar.getInstance(manila())
    val target = Calendar.getInstance(manila()).apply {
        set(Calendar.HOUR_OF_DAY, 19)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
        if (!after(now)) add(Calendar.DATE, 1)
    }
    return (target.timeInMillis - now.timeInMillis).coerceAtLeast(1000L)
}

private fun manila(): TimeZone = TimeZone.getTimeZone("Asia/Manila")
