package ph.gov.sipalay.attendance

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "edutrack/native")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "scheduleBackgroundNotifications" -> {
                        // Kept as a migration-safe no-op for older Flutter
                        // callers. Railway FCM is now the only system-alert
                        // producer; native polling would duplicate it.
                        EdutrackBackgroundWorkers.cancel(this)
                        BackgroundNotificationStore.clear(this)
                        result.success(true)
                    }
                    "cancelBackgroundNotifications" -> {
                        EdutrackBackgroundWorkers.cancel(this)
                        BackgroundNotificationStore.clear(this)
                        result.success(true)
                    }
                    else -> result.notImplemented()
                }
            }
    }
}
