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
                        val cookie = call.argument<String>("cookie").orEmpty()
                        val baseUrl = call.argument<String>("baseUrl").orEmpty()
                        val fullname = call.argument<String>("fullname").orEmpty()
                        BackgroundNotificationStore.save(this, baseUrl, cookie, fullname)
                        EdutrackBackgroundWorkers.schedule(this)
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
