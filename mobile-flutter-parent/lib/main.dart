import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:workmanager/workmanager.dart';

final FlutterLocalNotificationsPlugin _notifications = FlutterLocalNotificationsPlugin();
const AndroidNotificationChannel _channel = AndroidNotificationChannel(
  'edutrack_parent',
  'EduTrack Guardian',
  description: 'Attendance alerts for your child',
  importance: Importance.high,
);

// Use the launcher icon for the notification — it is the only icon guaranteed to
// resolve on every device (a custom drawable that a device rejects makes show()
// throw and no notification appears at all).
Future<void> _initNotifications({bool requestPermission = true}) async {
  const android = AndroidInitializationSettings('@mipmap/ic_launcher');
  await _notifications.initialize(const InitializationSettings(android: android));
  final impl = _notifications.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
  await impl?.createNotificationChannel(_channel);
  if (requestPermission) await impl?.requestNotificationsPermission();
}

// Ensure POST_NOTIFICATIONS is granted (Android 13+). Safe to call repeatedly.
Future<bool> ensureParentNotificationPermission() async {
  try {
    final impl = _notifications.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    if (impl == null) return true;
    final enabled = await impl.areNotificationsEnabled() ?? false;
    if (enabled) return true;
    return await impl.requestNotificationsPermission() ?? false;
  } catch (_) {
    return false;
  }
}

// Per-type monochrome status-bar icon (vector drawable). Unknown types use the
// launcher icon. Delivery is still guaranteed by the launcher fallback below.
String _androidNotificationIcon(String type) {
  switch (type.toLowerCase()) {
    case 'attendance_time_in':
      return 'ic_n_in';
    case 'attendance_late_time_in':
      return 'ic_n_late';
    case 'attendance_pm_time_in':
      return 'ic_n_pm';
    case 'attendance_pm_late_time_in':
      return 'ic_n_pm_late';
    case 'attendance_lunch_out':
      return 'ic_n_lunch';
    case 'attendance_returned':
      return 'ic_n_returned';
    case 'attendance_early_out':
      return 'ic_n_out';
    case 'attendance_completed':
      return 'ic_n_done';
    case 'attendance_absent':
      return 'ic_n_absent';
    case 'attendance_flagged':
      return 'ic_n_flag';
    case 'announcement_emergency':
      return 'ic_n_alert';
    case 'announcement_parent_meeting':
    case 'announcement_class_meeting':
      return 'ic_n_meeting';
    case 'announcement_holiday':
      return 'ic_n_holiday';
    case 'announcement_general':
      return 'ic_n_announce';
    case 'announcement_school_event':
      return 'ic_n_event';
    case 'announcement_reminder':
      return 'ic_n_reminder';
  }
  // A proper monochrome status drawable — NEVER the color launcher, which Android
  // renders as a blank white blob in the status bar ("no icon").
  return 'ic_stat_edutrack';
}

// Accent color that tints the small icon + app name per type.
Color _androidNotificationColor(String type) {
  final t = type.toLowerCase();
  if (t.contains('emergency') || t.contains('absent') || t.contains('flagged') || t.contains('early')) {
    return const Color(0xFFDC2626);
  }
  if (t.contains('late') || t.contains('holiday') || t.contains('meeting') || t.contains('lunch')) {
    return const Color(0xFFEA580C);
  }
  if (t.contains('completed') || t.contains('returned') || t.contains('time_in')) {
    return kGreen;
  }
  return const Color(0xFF2563EB);
}

// Render the per-type Material icon (white on a colored circle) to a PNG bitmap
// for the large notification icon. A raster PNG is the only large-icon form every
// device accepts (vector drawables decode to null). Foreground only — see richIcon.
Future<ByteArrayAndroidBitmap?> _renderTypeLargeIcon(String type) async {
  if (type.trim().isEmpty) return null;
  try {
    final note = <String, dynamic>{'type': type};
    final icon = parentNotificationIcon(note);
    final color = parentNotificationColor(note);
    const size = 128.0;
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    canvas.drawCircle(const ui.Offset(size / 2, size / 2), size / 2, ui.Paint()..color = color);
    final painter = TextPainter(
      text: TextSpan(
        text: String.fromCharCode(icon.codePoint),
        style: TextStyle(color: Colors.white, fontSize: 74, fontFamily: icon.fontFamily, package: icon.fontPackage),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    painter.paint(canvas, ui.Offset((size - painter.width) / 2, (size - painter.height) / 2));
    final image = await recorder.endRecording().toImage(size.toInt(), size.toInt());
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    if (bytes == null) return null;
    return ByteArrayAndroidBitmap(bytes.buffer.asUint8List());
  } catch (_) {
    return null;
  }
}

// richIcon=true (foreground) renders the per-type large icon; the background
// isolate passes false (no render surface there — rendering can hang), but it
// can still ask Android to use the packaged per-type drawable as the large icon.
Future<bool> showParentNotification(String title, String body, {int? id, String type = '', bool richIcon = true}) async {
  final nid = id ?? DateTime.now().millisecondsSinceEpoch.remainder(100000);
  final color = _androidNotificationColor(type);
  final largeIconsToTry = <AndroidBitmap<Object>>[];
  if (richIcon && type.trim().isNotEmpty) {
    try {
      final rendered = await _renderTypeLargeIcon(type).timeout(const Duration(seconds: 3));
      if (rendered != null) largeIconsToTry.add(rendered);
    } catch (_) {/* keep the seal */}
  } else if (!richIcon && type.trim().isNotEmpty) {
    largeIconsToTry.add(DrawableResourceAndroidBitmap(_androidNotificationIcon(type)));
  }
  // Large/right icon fallback: the Guardian launcher/logo.
  largeIconsToTry.add(const DrawableResourceAndroidBitmap('@mipmap/ic_launcher'));

  // Small/left icon must identify the app/channel. Android requires a
  // monochrome drawable here, so use the Guardian status icon instead of the
  // per-event icon. The event icon belongs on the large/right side.
  for (final largeIcon in largeIconsToTry) {
    try {
      await _notifications.show(
        nid,
        '<b>$title</b>',
        '<b>$body</b>',
        NotificationDetails(
          android: AndroidNotificationDetails(
            'edutrack_parent',
            'EduTrack Guardian',
            channelDescription: 'Attendance alerts for your child',
            importance: Importance.high,
            priority: Priority.high,
            icon: 'ic_stat_edutrack',
            color: color,
            largeIcon: largeIcon,
            styleInformation: const DefaultStyleInformation(true, true),
          ),
        ),
      );
      return true;
    } catch (error) {
      debugPrint('Guardian notification display failed: $error');
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Firebase Cloud Messaging — instant push even when the app is fully closed.
// ---------------------------------------------------------------------------
String gFcmToken = '';

// Runs in a separate isolate when a push arrives with the app closed/background.
// Parent pushes are data-only so Android does not auto-render a duplicate/wrong
// icon notification; this handler renders the single Guardian notification.
@pragma('vm:entry-point')
Future<void> _fcmBackgroundHandler(RemoteMessage message) async {
  try {
    WidgetsFlutterBinding.ensureInitialized();
  } catch (_) {/* already initialised */}
  try {
    ui.DartPluginRegistrant.ensureInitialized();
  } catch (_) {/* plugin registrant is best-effort */}
  try {
    await Firebase.initializeApp();
  } catch (_) {/* already initialised */}
  try {
    await _initNotifications(requestPermission: false);
    final title = '${message.data['title'] ?? message.notification?.title ?? 'EduTrack Guardian'}';
    final body = '${message.data['body'] ?? message.notification?.body ?? ''}';
    if (body.trim().isEmpty) return;

    final notificationId =
        '${message.data['notification_id'] ?? message.messageId ?? ''}'.trim();
    if (notificationId.isNotEmpty) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.reload();
      final fcmDelivered =
          (prefs.getStringList(_fcmDeliveredPreference) ?? const <String>[])
              .toSet();
      if (fcmDelivered.contains(notificationId)) return;
      fcmDelivered.add(notificationId);
      await prefs.setStringList(
        _fcmDeliveredPreference,
        fcmDelivered.toList().reversed.take(200).toList(),
      );
      final delivered =
          (prefs.getStringList(_notifiedPreference) ?? const <String>[])
              .toSet();
      delivered.add(notificationId);
      await prefs.setStringList(
        _notifiedPreference,
        delivered.toList().reversed.take(200).toList(),
      );
      await prefs.setBool(_workerReadyPreference, true);
    }

    await showParentNotification(
      title,
      body,
      id: _latestFcmNotificationId,
      type: '${message.data['type'] ?? ''}',
      richIcon: false,
    );
  } catch (e) {
    debugPrint('Guardian background notification failed: $e');
  }
}

// Initialise FCM, request permission, capture the token, and show foreground
// pushes via the local-notification path. Best-effort — never throws upward.
Future<void> _setupFirebaseMessaging(ParentApi api) async {
  try {
    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission(alert: true, badge: true, sound: true);
    await messaging.setForegroundNotificationPresentationOptions(alert: true, badge: true, sound: true);
    // One-time migration: invalidate the token that may still have historical
    // FCM messages queued against it, then register a clean token with the server.
    if (api.prefs.getBool(_fcmQueueResetPreference) != true) {
      await messaging.deleteToken();
      await _notifications.cancelAll();
      await api.prefs.remove('parent_fcm_token');
      await api.prefs.setBool(_fcmQueueResetPreference, true);
    }
    final token = await messaging.getToken();
    if (token != null && token.isNotEmpty) {
      gFcmToken = token;
      await api.prefs.setString('parent_fcm_token', token);
      unawaited(api.registerDeviceToken(force: true));
    }
    messaging.onTokenRefresh.listen((t) {
      gFcmToken = t;
      api.prefs.setString('parent_fcm_token', t);
      unawaited(api.registerDeviceToken(force: true));
    });
    // Foreground messages don't auto-display — show them ourselves.
    FirebaseMessaging.onMessage.listen((message) async {
      final n = message.notification;
      final title = n?.title ?? '${message.data['title'] ?? 'EduTrack Guardian'}';
      final body = n?.body ?? '${message.data['body'] ?? ''}';
      // Mark the inbox row as delivered before displaying it. This prevents the
      // dashboard refresh from treating the same FCM event as a new local alert.
      final notificationId =
          '${message.data['notification_id'] ?? message.messageId ?? ''}'.trim();
      if (notificationId.isNotEmpty) {
        final fcmDelivered =
            (api.prefs.getStringList(_fcmDeliveredPreference) ??
                    const <String>[])
                .toSet();
        if (fcmDelivered.contains(notificationId)) return;
        fcmDelivered.add(notificationId);
        await api.prefs.setStringList(
          _fcmDeliveredPreference,
          fcmDelivered.toList().reversed.take(200).toList(),
        );
        final delivered =
            (api.prefs.getStringList(_notifiedPreference) ?? const <String>[])
                .toSet();
        delivered.add(notificationId);
        await api.prefs.setStringList(
          _notifiedPreference,
          delivered.toList().reversed.take(200).toList(),
        );
        await api.prefs.setBool(_workerReadyPreference, true);
      }
      await showParentNotification(
        title,
        body,
        // One stable Android ID means the newest update replaces the previous
        // visible alert instead of building a stack of notification history.
        id: _latestFcmNotificationId,
        type: '${message.data['type'] ?? ''}',
      );
    });
  } catch (e) {
    debugPrint('FCM setup failed: $e');
  }
}

const String _guardianBackgroundTask = 'guardianNotificationSync';
const String _guardianPeriodicWork = 'edutrack-guardian-notifications-periodic';
const String _guardianImmediateWork = 'edutrack-guardian-notifications-immediate';
const String _notifiedPreference = 'parent_notified_notifications';
const String _fcmDeliveredPreference = 'parent_fcm_delivered_notifications';
const String _fcmQueueResetPreference = 'parent_fcm_queue_reset_v1';
const String _workerReadyPreference = 'parent_notification_worker_ready';
const int _latestFcmNotificationId = 731002;

String _notificationKey(Map<String, dynamic> note) =>
    '${note['notification_id'] ?? note['key'] ?? note['created_at'] ?? note['title']}';

bool _isUnreadNotification(Map<String, dynamic> note) =>
    note['is_read'] != true && note['is_read'] != 1 && '${note['is_read']}' != '1';

int _systemNotificationId(Map<String, dynamic> note) {
  final value = int.tryParse('${note['notification_id'] ?? ''}');
  return value != null && value > 0
      ? value.remainder(2147483647)
      : _notificationKey(note).hashCode.abs().remainder(2147483647);
}

Future<bool> _syncGuardianNotificationsInBackground() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.reload();
    final deviceToken = (prefs.getString('parent_device_token') ?? '').trim();
    if (deviceToken.isEmpty) return true;

    final response = await http
        .post(
          Uri.parse('$kBaseUrl/api/parent/device-notifications'),
          headers: const {'Accept': 'application/json', 'Content-Type': 'application/json'},
          body: jsonEncode({'device_token': deviceToken}),
        )
        .timeout(const Duration(seconds: 25));
    if (response.statusCode == 401 || response.statusCode == 403) return true;
    if (response.statusCode != 200) return false;

    final decoded = jsonDecode(response.body);
    if (decoded is! Map) return false;
    final notes = ((decoded['notifications'] as List?) ?? const [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
    final notified = (prefs.getStringList(_notifiedPreference) ?? const <String>[]).toSet();

    // The first background run establishes a baseline so an existing inbox does
    // not produce a burst of old alerts immediately after an update or login.
    if (prefs.getBool(_workerReadyPreference) != true) {
      notified.addAll(notes.map(_notificationKey));
      await prefs.setStringList(_notifiedPreference, notified.take(200).toList());
      await prefs.setBool(_workerReadyPreference, true);
      return true;
    }

    final fresh = notes
        .where((note) => _isUnreadNotification(note) && !notified.contains(_notificationKey(note)))
        .toList()
      ..sort((a, b) {
        final left = int.tryParse('${a['notification_id'] ?? 0}') ?? 0;
        final right = int.tryParse('${b['notification_id'] ?? 0}') ?? 0;
        return left.compareTo(right);
      });
    if (fresh.isNotEmpty) await _initNotifications(requestPermission: false);
    for (final note in fresh.take(8)) {
      await showParentNotification(
        '${note['title'] ?? 'EduTrack Guardian'}',
        '${note['message'] ?? ''}',
        id: _systemNotificationId(note),
        type: '${note['type'] ?? ''}',
        richIcon: false, // background isolate: no render surface
      );
      notified.add(_notificationKey(note));
    }
    await prefs.setStringList(_notifiedPreference, notified.toList().reversed.take(200).toList());
    await prefs.setString('parent_notification_worker_last_run', DateTime.now().toIso8601String());
    return true;
  } catch (_) {
    return false;
  }
}

@pragma('vm:entry-point')
void guardianNotificationCallbackDispatcher() {
  Workmanager().executeTask((taskName, inputData) async {
    if (taskName != _guardianBackgroundTask) return true;
    return _syncGuardianNotificationsInBackground();
  });
}

Future<void> _initializeGuardianBackgroundSync() async {
  if (!Platform.isAndroid) return;
  await Workmanager().initialize(guardianNotificationCallbackDispatcher);
}

Future<void> scheduleGuardianBackgroundSync() async {
  // FCM now owns closed-app delivery. Cancel tasks created by older Guardian
  // builds so polling cannot display the same inbox item a second time.
  await cancelGuardianBackgroundSync();
}

Future<void> cancelGuardianBackgroundSync() async {
  if (!Platform.isAndroid) return;
  try {
    await Workmanager().cancelByUniqueName(_guardianPeriodicWork);
    await Workmanager().cancelByUniqueName(_guardianImmediateWork);
  } catch (_) {/* best effort */}
}

// Representative sample of every Guardian notification type — used by the
// "Preview notifications" action so guardians can see each design and alert.
List<Map<String, dynamic>> sampleParentNotifications() {
  final now = DateTime.now();
  String at(int minutesAgo) => now.subtract(Duration(minutes: minutesAgo)).toIso8601String();
  const student = 'Juan Dela Cruz';
  const school = 'Sipalay City NHS';
  Map<String, dynamic> n(String type, String title, String message, int minutesAgo) => {
        'notification_id': -(1000 + minutesAgo),
        'type': type,
        'title': title,
        'message': message,
        'student_name': type.startsWith('attendance_') ? student : '',
        'school_name': school,
        'created_at': at(minutesAgo).replaceFirst('T', ' '),
        'is_read': false,
      };
  return [
    n('attendance_time_in', 'Student Time In', 'Your child $student has timed in at 7:28 AM.', 1),
    n('attendance_late_time_in', 'Student Late', 'Your child $student arrived late at 8:05 AM.', 3),
    n('attendance_pm_time_in', 'PM Time In', 'Your child $student has entered for the PM session at 1:02 PM.', 8),
    n('attendance_pm_late_time_in', 'PM Late Time In', 'Your child $student arrived late for the PM session at 1:20 PM.', 12),
    n('attendance_lunch_out', 'Lunch Out', 'Your child $student went out for lunch at 11:31 AM.', 20),
    n('attendance_returned', 'Student Returned', 'Your child $student returned to school at 12:55 PM.', 25),
    n('attendance_early_out', 'Early Dismissal Alert', 'Your child $student left school early at 10:14 AM. Please contact the adviser if needed.', 40),
    n('attendance_completed', 'Attendance Completed', 'Your child $student completed attendance at 4:02 PM.', 60),
    n('attendance_absent', 'Student Absent', 'Your child $student has no attendance record today.', 90),
    n('attendance_flagged', '2-Day Absence Flag', 'Your child $student has been absent for 2 consecutive school days.', 120),
    n('announcement_general', 'School Announcement', 'Classes will follow the regular schedule this week.', 180),
    n('announcement_parent_meeting', 'Parent Meeting', 'A parent meeting is scheduled this Friday at 9:00 AM.', 240),
    n('announcement_class_meeting', 'Class Meeting', 'Section meeting for Grade 7 parents on Wednesday afternoon.', 300),
    n('announcement_holiday', 'Holiday / No Classes', 'No classes on Monday in observance of a local holiday.', 360),
    n('announcement_school_event', 'School Event', 'Foundation Day celebration this Saturday. All are welcome.', 420),
    n('announcement_emergency', 'Emergency Notice', 'Classes are suspended this afternoon due to severe weather.', 480),
    n('announcement_reminder', 'Reminder', 'Please remind your child to bring their ID and QR code daily.', 540),
  ];
}

const String kBaseUrl = 'https://sdo-sipalay-edutrack.up.railway.app';
const String kAppName = 'EduTrack';
const String kSubtitle = 'Schools Division of Sipalay City';
// User-facing Guardian wording is separate from the existing parent API routes.
const String kMonitoringLabel = 'Guardian Attendance Monitor';
const String kNoNet = 'No internet connection. Please check your network.';

const Color kGreen = Color(0xFF16A34A);
const Color kGreenDark = Color(0xFF15803D);
const Color kSeal = Color(0xFF0F6E52);
const Color kInk = Color(0xFF111827);
const Color kMuted = Color(0xFF6B7280);

const List<String> _weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const List<String> _wdShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const List<String> _months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const List<String> _moShort = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

String greeting() {
  final h = DateTime.now().hour;
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

String fullDateString([DateTime? d]) {
  final n = d ?? DateTime.now();
  return '${_weekdays[n.weekday % 7]}, ${_months[n.month - 1]} ${n.day}, ${n.year}';
}

String shortDateString([DateTime? d]) {
  final n = d ?? DateTime.now();
  return '${_wdShort[n.weekday % 7]}, ${_moShort[n.month - 1]} ${n.day}';
}

String isoDateString([DateTime? d]) {
  final n = d ?? DateTime.now();
  return '${n.year}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
}

String attendanceScoreLabel(int pct) {
  final c = pct.clamp(0, 100);
  if (c >= 90) return 'Excellent Attendance';
  if (c >= 75) return 'Good Attendance';
  if (c >= 50) return 'Fair Attendance';
  return 'Needs Attention';
}

// Admin-uploaded school/system logo (cached across launches). Shown on the
// splash, login card, header seal, and home greeting instead of the bundled art.
String gSchoolLogo = '';
// Admin-uploaded home-screen school illustration, cached so the real artwork
// shows instantly instead of the painted placeholder.
String gSchoolArt = '';

// Render a logo value that may be a data URL, an absolute URL, or a server path.
Widget brandLogoImage(String value, {BoxFit fit = BoxFit.contain, Widget Function()? fallback}) {
  final v = value.trim();
  Widget fb() => fallback != null ? fallback() : Image.asset('assets/images/app_logo.png', fit: fit);
  if (v.isEmpty) return fb();
  if (v.startsWith('data:')) {
    try {
      final i = v.indexOf(',');
      final bytes = base64Decode(i != -1 ? v.substring(i + 1) : v);
      return Image.memory(bytes, fit: fit, gaplessPlayback: true, errorBuilder: (_, __, ___) => fb());
    } catch (_) {
      return fb();
    }
  }
  final url = v.startsWith('http') ? v : (v.startsWith('/') ? '$kBaseUrl$v' : '$kBaseUrl/$v');
  // Show the bundled logo instantly while the network logo loads (no blank box).
  return Image.network(
    url,
    fit: fit,
    gaplessPlayback: true,
    loadingBuilder: (ctx, child, progress) => progress == null ? child : fb(),
    errorBuilder: (_, __, ___) => fb(),
  );
}

// Splash/login logo — NEVER waits on the network, so it can never show a blank
// box. Uses a cached data-URL logo if available, otherwise the bundled seal.
Widget instantBrandLogo({BoxFit fit = BoxFit.contain}) {
  final v = gSchoolLogo.trim();
  if (v.startsWith('data:')) {
    try {
      final i = v.indexOf(',');
      final bytes = base64Decode(i != -1 ? v.substring(i + 1) : v);
      return Image.memory(bytes, fit: fit, gaplessPlayback: true,
          errorBuilder: (_, __, ___) => Image.asset('assets/images/app_logo.png', fit: fit));
    } catch (_) {/* fall through to the bundled asset */}
  }
  return Image.asset('assets/images/app_logo.png', fit: fit);
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(_fcmBackgroundHandler);
  } catch (e) {
    debugPrint('Firebase init failed: $e');
  }
  try {
    await _initNotifications();
    await _initializeGuardianBackgroundSync();
  } catch (_) {/* notifications are best-effort */}
  final prefs = await SharedPreferences.getInstance();
  gSchoolLogo = prefs.getString('parent_school_logo') ?? '';
  gSchoolArt = prefs.getString('parent_school_art') ?? '';
  gFcmToken = prefs.getString('parent_fcm_token') ?? '';
  final api = ParentApi(prefs);
  unawaited(_setupFirebaseMessaging(api));
  unawaited(cancelGuardianBackgroundSync());
  runApp(ParentApp(api: api));
}

// ---------------------------------------------------------------------------
// API — cookie-based session auth against the EduTrack parent endpoints.
// ---------------------------------------------------------------------------
class ParentApi {
  ParentApi(this.prefs);
  final SharedPreferences prefs;
  DateTime? _lastDeviceRegistration;
  bool _registeringDevice = false;

  String get cookie => prefs.getString('cookie') ?? '';
  bool get isLoggedIn => cookie.isNotEmpty;
  String get parentName => prefs.getString('parent_name') ?? 'Parent';
  String get parentContact => prefs.getString('parent_contact') ?? '';
  String get parentUsername => prefs.getString('parent_username') ?? '';
  String get deviceToken => prefs.getString('parent_device_token') ?? '';

  Map<String, String> get _headers => {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
        if (cookie.isNotEmpty) 'Cookie': cookie,
      };

  void _captureCookie(http.Response res) {
    final raw = res.headers['set-cookie'];
    if (raw == null || raw.isEmpty) return;
    final first = raw.split(';').first.trim();
    if (first.contains('=')) prefs.setString('cookie', first);
  }

  Future<void> _saveParent(Map<String, dynamic>? p) async {
    if (p == null) return;
    await prefs.setString('parent_name', '${p['guardian_name'] ?? 'Parent'}');
    await prefs.setString('parent_contact', '${p['contact_number'] ?? ''}');
    await prefs.setString('parent_username', '${p['username'] ?? ''}');
  }

  String _netError(Object e) {
    if (e is SocketException || e is TimeoutException) return kNoNet;
    return 'Unable to connect to the server right now.';
  }

  Future<Map<String, dynamic>> login(String identifier, String password) async {
    try {
      final res = await http
          .post(Uri.parse('$kBaseUrl/api/parent/login'),
              headers: const {'Accept': 'application/json'},
              body: {'identifier': identifier, 'password': password})
          .timeout(const Duration(seconds: 20));
      _captureCookie(res);
      final data = _decode(res.body);
      if (res.statusCode == 200 && data['success'] == true) {
        await _saveParent(data['parent'] as Map<String, dynamic>?);
        return {'success': true};
      }
      return {'success': false, 'error': data['error'] ?? 'Login failed.'};
    } catch (e) {
      return {'success': false, 'error': _netError(e)};
    }
  }

  Future<Map<String, dynamic>> register(Map<String, String> body) async {
    try {
      final res = await http
          .post(Uri.parse('$kBaseUrl/api/parent/register'),
              headers: const {'Accept': 'application/json'}, body: body)
          .timeout(const Duration(seconds: 20));
      _captureCookie(res);
      final data = _decode(res.body);
      if (res.statusCode == 200 && data['success'] == true) {
        await _saveParent(data['parent'] as Map<String, dynamic>?);
        return {'success': true};
      }
      return {'success': false, 'error': data['error'] ?? 'Registration failed.'};
    } catch (e) {
      return {'success': false, 'error': _netError(e)};
    }
  }

  Future<Map<String, dynamic>> dashboard() async {
    final res = await http
        .get(Uri.parse('$kBaseUrl/api/parent/dashboard'), headers: _headers)
        .timeout(const Duration(seconds: 20));
    if (res.statusCode == 401) throw Exception('SESSION_EXPIRED');
    return _decode(res.body);
  }

  Future<String> ensureDeviceToken() async {
    final existing = prefs.getString('parent_device_token');
    if (existing != null && existing.isNotEmpty) return existing;
    final random = math.Random.secure();
    final salt = List<int>.generate(12, (_) => random.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final token = 'parent-${DateTime.now().microsecondsSinceEpoch}-$salt';
    await prefs.setString('parent_device_token', token);
    return token;
  }

  Future<void> registerDeviceToken({bool force = false}) async {
    if (!isLoggedIn || gFcmToken.trim().isEmpty || _registeringDevice) return;
    final now = DateTime.now();
    if (!force &&
        _lastDeviceRegistration != null &&
        now.difference(_lastDeviceRegistration!) < const Duration(minutes: 5)) {
      return;
    }
    _registeringDevice = true;
    try {
      final info = await PackageInfo.fromPlatform();
      final token = await ensureDeviceToken();
      final response = await http
          .post(Uri.parse('$kBaseUrl/api/parent/device-token'), headers: _headers, body: {
            'device_token': token,
            'push_token': gFcmToken,
            'platform': Platform.isAndroid ? 'android' : Platform.operatingSystem,
            'app_version': info.version,
          })
          .timeout(const Duration(seconds: 15));
      if (response.statusCode == 200) _lastDeviceRegistration = now;
    } catch (_) {
      // Device registration is retried on the next dashboard refresh.
    } finally {
      _registeringDevice = false;
    }
  }

  Future<int> markNotificationsRead([List<int>? ids]) async {
    try {
      final payload = ids == null ? <String, dynamic>{} : {'notification_ids': ids};
      final res = await http
          .post(
            Uri.parse('$kBaseUrl/api/parent/notifications/read'),
            headers: {..._headers, 'Content-Type': 'application/json'},
            body: jsonEncode(payload),
          )
          .timeout(const Duration(seconds: 15));
      final data = _decode(res.body);
      return ((data['unread_count'] as num?) ?? 0).toInt();
    } catch (_) {
      return 0;
    }
  }

  Future<Map<String, dynamic>> branding() async {
    try {
      final res = await http
          .get(Uri.parse('$kBaseUrl/api/parent/branding'), headers: _headers)
          .timeout(const Duration(seconds: 15));
      return _decode(res.body);
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  // Pre-login branding so the splash/login can show the admin-uploaded logo.
  Future<void> refreshPublicBranding() async {
    try {
      final res = await http
          .get(Uri.parse('$kBaseUrl/api/parent/public-branding'))
          .timeout(const Duration(seconds: 10));
      final data = _decode(res.body);
      final logo = '${data['system_logo'] ?? ''}'.trim();
      if (logo.isNotEmpty) {
        gSchoolLogo = logo;
        await prefs.setString('parent_school_logo', logo);
      }
    } catch (_) {/* best-effort branding refresh */}
  }

  Future<Map<String, dynamic>> appVersion() async {
    try {
      final res = await http
          .get(Uri.parse('$kBaseUrl/api/parent/app-version'), headers: _headers)
          .timeout(const Duration(seconds: 15));
      return _decode(res.body);
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  Future<Map<String, dynamic>> changePassword(String current, String next, String confirm) async {
    try {
      final res = await http
          .post(Uri.parse('$kBaseUrl/api/parent/change-password'),
              headers: _headers, body: {'current_password': current, 'new_password': next, 'confirm_password': confirm})
          .timeout(const Duration(seconds: 20));
      final data = _decode(res.body);
      if (res.statusCode == 200 && data['success'] == true) return {'success': true};
      return {'success': false, 'error': data['error'] ?? 'Could not change password.'};
    } catch (e) {
      return {'success': false, 'error': _netError(e)};
    }
  }

  Future<Map<String, dynamic>> updateProfile(String name, String contact, String username) async {
    try {
      final res = await http
          .post(Uri.parse('$kBaseUrl/api/parent/profile'),
              headers: _headers,
              body: {'guardian_name': name, 'contact_number': contact, 'username': username})
          .timeout(const Duration(seconds: 20));
      final data = _decode(res.body);
      if (res.statusCode == 200 && data['success'] == true) {
        await _saveParent(data['parent'] as Map<String, dynamic>?);
        return {'success': true, 'linked_students': data['linked_students'] ?? 0};
      }
      return {'success': false, 'error': data['error'] ?? 'Could not update your profile.'};
    } catch (e) {
      return {'success': false, 'error': _netError(e)};
    }
  }

  Future<void> logout() async {
    try {
      await http
          .post(Uri.parse('$kBaseUrl/api/parent/logout'), headers: _headers, body: {
            'device_token': deviceToken,
          })
          .timeout(const Duration(seconds: 10));
    } catch (_) {/* ignore */}
    await cancelGuardianBackgroundSync();
    await prefs.remove('cookie');
    await prefs.remove('parent_name');
    await prefs.remove('parent_contact');
    await prefs.remove('parent_username');
    await prefs.remove('parent_notified_notifications');
    await prefs.remove(_fcmDeliveredPreference);
    await prefs.remove(_workerReadyPreference);
  }

  Map<String, dynamic> _decode(String body) {
    try {
      final decoded = jsonDecode(body);
      return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
class ParentApp extends StatelessWidget {
  const ParentApp({super.key, required this.api});
  final ParentApi api;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'EduTrack Guardian',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFEFF4F1),
        colorScheme: ColorScheme.fromSeed(seedColor: kGreen, primary: kGreen),
        fontFamily: 'Roboto',
      ),
      home: SplashGate(api: api),
    );
  }
}

// ---------------------------------------------------------------------------
// Splash / loading screen
// ---------------------------------------------------------------------------
class SplashGate extends StatefulWidget {
  const SplashGate({super.key, required this.api});
  final ParentApi api;
  @override
  State<SplashGate> createState() => _SplashGateState();
}

class _SplashGateState extends State<SplashGate> with SingleTickerProviderStateMixin {
  late final AnimationController controller;
  double progress = 0;

  @override
  void initState() {
    super.initState();
    controller = AnimationController(vsync: this, duration: const Duration(seconds: 4))..repeat(reverse: true);
    // Refresh the admin-uploaded logo before navigating (best-effort, non-blocking).
    widget.api.refreshPublicBranding().then((_) {
      if (mounted) setState(() {});
    });
    Timer.periodic(const Duration(milliseconds: 30), (timer) {
      if (!mounted) return timer.cancel();
      setState(() => progress = math.min(1, progress + .02));
      if (progress >= 1) {
        timer.cancel();
        if (!mounted) return;
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(
            builder: (_) => widget.api.isLoggedIn ? HomeShell(api: widget.api) : LoginScreen(api: widget.api),
          ),
        );
      }
    });
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: AnimatedBuilder(
        animation: controller,
        builder: (context, child) => Container(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [Color(0xFF073B2B), Color(0xFF0B7A55), Color(0xFF12A16F)],
            ),
          ),
          child: Stack(
            children: [
              Positioned.fill(child: CustomPaint(painter: _HeaderPatternPainter())),
              Positioned(top: -80, right: -70, child: _splashOrb(210, Colors.white.withValues(alpha: .11))),
              Positioned(bottom: -90, left: -60, child: _splashOrb(190, Colors.white.withValues(alpha: .08))),
              SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(26),
                  child: Column(
                    children: [
                      const Spacer(),
                      Stack(
                        alignment: Alignment.center,
                        children: [
                          PulseRing(value: controller.value, size: 170),
                          Container(
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: Colors.white.withValues(alpha: .15),
                              borderRadius: BorderRadius.circular(34),
                              border: Border.all(color: Colors.white.withValues(alpha: .24)),
                            ),
                            child: const AppLogo(size: 96),
                          ),
                        ],
                      ),
                      const SizedBox(height: 26),
                      const Text(kAppName, style: TextStyle(fontSize: 40, color: Colors.white, fontWeight: FontWeight.w900, letterSpacing: -.7)),
                      const SizedBox(height: 6),
                      const Text(kSubtitle, textAlign: TextAlign.center, style: TextStyle(color: Colors.white70, fontSize: 15.5, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 24),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: .14),
                          borderRadius: BorderRadius.circular(99),
                          border: Border.all(color: Colors.white.withValues(alpha: .22)),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: const [
                            LiveDot(color: Color(0xFFFF3B30), size: 9),
                            SizedBox(width: 8),
                            Text('Initializing Guardian Access', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 12.5)),
                          ],
                        ),
                      ),
                      const Spacer(),
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(24),
                          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: .18), blurRadius: 28, offset: const Offset(0, 12))],
                        ),
                        child: Column(
                          children: [
                            Row(
                              children: [
                                const Icon(Icons.verified_user_rounded, color: kGreen, size: 20),
                                const SizedBox(width: 8),
                                const Expanded(child: Text('Loading Real-Time Records', style: TextStyle(color: kInk, fontWeight: FontWeight.w900))),
                                Text('${(progress * 100).round()}%', style: const TextStyle(color: kGreenDark, fontWeight: FontWeight.w900)),
                              ],
                            ),
                            const SizedBox(height: 12),
                            ClipRRect(
                              borderRadius: BorderRadius.circular(99),
                              child: LinearProgressIndicator(
                                value: progress,
                                minHeight: 9,
                                backgroundColor: const Color(0xFFE5EFEA),
                                color: kGreen,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _splashOrb(double size, Color color) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(shape: BoxShape.circle, color: color),
      );
}

class AppLogo extends StatelessWidget {
  const AppLogo({super.key, required this.size});
  final double size;
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        padding: EdgeInsets.all(size * .12),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: .82),
          borderRadius: BorderRadius.circular(size * .28),
          border: Border.all(color: const Color(0xFFDCEBE4)),
          boxShadow: [BoxShadow(color: kSeal.withValues(alpha: .10), blurRadius: size * .18, offset: Offset(0, size * .06))],
        ),
        child: instantBrandLogo(),
      );
}

class PulseRing extends StatelessWidget {
  const PulseRing({super.key, required this.value, required this.size});
  final double value;
  final double size;
  @override
  Widget build(BuildContext context) {
    final pulse = .6 + (math.sin(value * math.pi * 2) + 1) / 2;
    return SizedBox(width: size, height: size, child: CustomPaint(painter: PulseRingPainter(pulse)));
  }
}

class PulseRingPainter extends CustomPainter {
  PulseRingPainter(this.pulse);
  final double pulse;
  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    for (var i = 0; i < 3; i++) {
      final radius = (size.shortestSide * (.28 + i * .13)) + pulse * 8;
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.6
        ..color = const Color(0xFF138A64).withValues(alpha: (.22 - i * .045) * pulse);
      canvas.drawCircle(center, radius, paint);
    }
  }

  @override
  bool shouldRepaint(PulseRingPainter oldDelegate) => oldDelegate.pulse != pulse;
}

class LiveDot extends StatefulWidget {
  const LiveDot({super.key, this.color = Colors.white, this.size = 8});
  final Color color;
  final double size;
  @override
  State<LiveDot> createState() => _LiveDotState();
}

class _LiveDotState extends State<LiveDot> with SingleTickerProviderStateMixin {
  late final AnimationController controller;
  @override
  void initState() {
    super.initState();
    controller = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat(reverse: true);
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hostSize = widget.size + 12;
    return AnimatedBuilder(
      animation: controller,
      builder: (context, child) {
        final pulse = .72 + controller.value * .28;
        return SizedBox(
          width: hostSize,
          height: hostSize,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Transform.scale(
                scale: pulse,
                child: Container(
                  width: hostSize,
                  height: hostSize,
                  decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color.withValues(alpha: .12)),
                ),
              ),
              Container(
                width: widget.size,
                height: widget.size,
                decoration: BoxDecoration(
                  color: widget.color,
                  shape: BoxShape.circle,
                  boxShadow: [BoxShadow(color: widget.color.withValues(alpha: .55), blurRadius: 10)],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class LiveMeshPainter extends CustomPainter {
  LiveMeshPainter(this.value, {this.intensity = .5, this.focusY});
  final double value;
  final double intensity;
  final double? focusY;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    canvas.drawRect(rect, Paint()..color = const Color(0xFFEDF7F1));

    void blob(Color color, Offset center, double radius) {
      final paint = Paint()
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 42)
        ..color = color.withValues(alpha: intensity);
      canvas.drawCircle(center, radius, paint);
    }

    final t = value * math.pi * 2;
    blob(Colors.white, Offset(size.width * (.08 + .025 * math.sin(t)), size.height * .17), size.width * .36);
    blob(const Color(0xFFF3FBF7), Offset(size.width * (.88 + .025 * math.cos(t)), size.height * .34), size.width * .40);
    blob(const Color(0xFFD4F2E5), Offset(size.width * (.48 + .02 * math.sin(t * 1.2)), size.height * .90), size.width * .34);
    blob(const Color(0xFFE8F8F1), Offset(size.width * (.66 + .02 * math.cos(t * 1.6)), size.height * .08), size.width * .28);

    final ringPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = const Color(0xFF138A64).withValues(alpha: .045 + intensity * .04);
    final radarCenter = Offset(size.width * .50, size.height * (focusY ?? .30));
    for (var i = 0; i < 5; i++) {
      final radius = size.width * (.12 + i * .055) + math.sin(t) * 2;
      canvas.drawCircle(radarCenter, radius, ringPaint);
    }
  }

  @override
  bool shouldRepaint(LiveMeshPainter oldDelegate) =>
      oldDelegate.value != value || oldDelegate.intensity != intensity || oldDelegate.focusY != focusY;
}

// ---------------------------------------------------------------------------
// Login — mirrors the adviser login design.
// ---------------------------------------------------------------------------
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.api});
  final ParentApi api;
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _id = TextEditingController();
  final _pw = TextEditingController();
  bool _obscure = true;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _id.dispose();
    _pw.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final id = _id.text.trim();
    final pw = _pw.text;
    if (id.isEmpty || pw.isEmpty) {
      setState(() => _error = 'Please enter your mobile number or username and password.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final res = await widget.api.login(id, pw);
    if (!mounted) return;
    if (res['success'] == true) {
      try {
        await _initNotifications();
        await widget.api.registerDeviceToken();
        await scheduleGuardianBackgroundSync();
      } catch (_) {}
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => HomeShell(api: widget.api)));
    } else {
      setState(() {
        _busy = false;
        _error = '${res['error']}';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFFF0FDF4), Color(0xFFECFDF5), Color(0xFFF0F9FF)],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: AuthCard(
                subtitle: 'Guardian Portal',
                children: [
                  if (_error != null) AuthAlert(message: _error!),
                  AuthField(controller: _id, label: 'Mobile Number or Username', hint: 'e.g. 09171234567', icon: Icons.person_outline),
                  const SizedBox(height: 14),
                  AuthField(
                    controller: _pw,
                    label: 'Password',
                    hint: 'Enter your password',
                    icon: Icons.lock_outline,
                    obscure: _obscure,
                    onToggleObscure: () => setState(() => _obscure = !_obscure),
                  ),
                  const SizedBox(height: 18),
                  AuthButton(label: 'Sign In', busy: _busy, onPressed: _busy ? null : _submit),
                  const SizedBox(height: 12),
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => RegisterScreen(api: widget.api))),
                    child: const Text.rich(
                      TextSpan(
                        text: "Don't have an account?  ",
                        style: TextStyle(color: kMuted, fontSize: 13),
                        children: [TextSpan(text: 'Register', style: TextStyle(color: kGreen, fontWeight: FontWeight.w800))],
                      ),
                    ),
                  ),
                  const Text('For registered guardians only', style: TextStyle(color: Color(0xFF9CA3AF), fontSize: 11.5)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key, required this.api});
  final ParentApi api;
  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _name = TextEditingController();
  final _contact = TextEditingController();
  final _username = TextEditingController();
  final _pw = TextEditingController();
  final _confirm = TextEditingController();
  bool _obscure = true;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _contact.dispose();
    _username.dispose();
    _pw.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final res = await widget.api.register({
      'guardian_name': _name.text.trim(),
      'contact_number': _contact.text.trim(),
      'username': _username.text.trim(),
      'password': _pw.text,
      'confirm_password': _confirm.text,
    });
    if (!mounted) return;
    if (res['success'] == true) {
      try {
        await _initNotifications();
        await widget.api.registerDeviceToken();
        await scheduleGuardianBackgroundSync();
      } catch (_) {}
      Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => HomeShell(api: widget.api)), (r) => false);
    } else {
      setState(() {
        _busy = false;
        _error = '${res['error']}';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFFF0FDF4), Color(0xFFECFDF5), Color(0xFFF0F9FF)],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: AuthCard(
                subtitle: 'Create Parent Account',
                children: [
                  if (_error != null) AuthAlert(message: _error!),
                  AuthField(controller: _name, label: 'Parent / Guardian Name', hint: 'Full name', icon: Icons.badge_outlined),
                  const SizedBox(height: 12),
                  AuthField(controller: _contact, label: 'Registered Contact Number', hint: 'e.g. 09171234567', icon: Icons.phone_outlined, keyboardType: TextInputType.phone),
                  const SizedBox(height: 12),
                  AuthField(controller: _username, label: 'Username (optional)', hint: 'Choose a username', icon: Icons.alternate_email),
                  const SizedBox(height: 12),
                  AuthField(controller: _pw, label: 'Password', hint: 'At least 6 characters', icon: Icons.lock_outline, obscure: _obscure, onToggleObscure: () => setState(() => _obscure = !_obscure)),
                  const SizedBox(height: 12),
                  AuthField(controller: _confirm, label: 'Confirm Password', hint: 'Re-enter password', icon: Icons.lock_outline, obscure: _obscure),
                  const SizedBox(height: 18),
                  AuthButton(label: 'Create Account', busy: _busy, onPressed: _busy ? null : _submit),
                  TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: const Text('Back to Sign In', style: TextStyle(color: kGreen, fontWeight: FontWeight.w700))),
                  const Text('Use the contact number registered with your child’s school.', textAlign: TextAlign.center, style: TextStyle(color: Color(0xFF9CA3AF), fontSize: 11.5)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class AuthCard extends StatelessWidget {
  const AuthCard({super.key, required this.subtitle, required this.children});
  final String subtitle;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    return Container(
      width: 420,
      constraints: const BoxConstraints(maxWidth: 420),
      padding: const EdgeInsets.fromLTRB(28, 34, 28, 26),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(22),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 40, offset: const Offset(0, 8))],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const AppLogo(size: 76),
          const SizedBox(height: 14),
          const Text(kAppName, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: kInk)),
          const SizedBox(height: 2),
          Text(subtitle, style: const TextStyle(fontSize: 13, color: kMuted, fontWeight: FontWeight.w600)),
          const SizedBox(height: 22),
          ...children,
        ],
      ),
    );
  }
}

class AuthAlert extends StatelessWidget {
  const AuthAlert({super.key, required this.message});
  final String message;
  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: BoxDecoration(color: const Color(0xFFFEF2F2), border: Border.all(color: const Color(0xFFFECACA)), borderRadius: BorderRadius.circular(10)),
      child: Row(children: [
        const Icon(Icons.error_outline, color: Color(0xFFDC2626), size: 18),
        const SizedBox(width: 8),
        Expanded(child: Text(message, style: const TextStyle(color: Color(0xFFDC2626), fontSize: 12.5))),
      ]),
    );
  }
}

class AuthField extends StatelessWidget {
  const AuthField({super.key, required this.controller, required this.label, required this.icon, this.hint, this.obscure = false, this.keyboardType, this.onToggleObscure});
  final TextEditingController controller;
  final String label;
  final IconData icon;
  final String? hint;
  final bool obscure;
  final TextInputType? keyboardType;
  final VoidCallback? onToggleObscure;
  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label.toUpperCase(), style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: kMuted, letterSpacing: 0.4)),
        const SizedBox(height: 6),
        TextField(
          controller: controller,
          obscureText: obscure,
          keyboardType: keyboardType,
          style: const TextStyle(fontSize: 14, color: kInk),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: const TextStyle(color: Color(0xFF9CA3AF), fontSize: 13),
            prefixIcon: Icon(icon, size: 19, color: kMuted),
            suffixIcon: onToggleObscure == null
                ? null
                : IconButton(onPressed: onToggleObscure, icon: Icon(obscure ? Icons.visibility_off : Icons.visibility, size: 19, color: kMuted)),
            isDense: true,
            contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
            filled: true,
            fillColor: Colors.white,
            enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: Color(0xFFD1D5DB), width: 1.5)),
            focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: kGreen, width: 1.6)),
          ),
        ),
      ],
    );
  }
}

class AuthButton extends StatelessWidget {
  const AuthButton({super.key, required this.label, required this.busy, required this.onPressed});
  final String label;
  final bool busy;
  final VoidCallback? onPressed;
  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 48,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: const LinearGradient(colors: [kGreen, kGreenDark]),
          borderRadius: BorderRadius.circular(10),
          boxShadow: [BoxShadow(color: kGreen.withValues(alpha: 0.3), blurRadius: 12, offset: const Offset(0, 4))],
        ),
        child: ElevatedButton(
          onPressed: onPressed,
          style: ElevatedButton.styleFrom(backgroundColor: Colors.transparent, shadowColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
          child: busy
              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 15)),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Home shell — SDS/ASDS styled header + 5 tabs
// ---------------------------------------------------------------------------
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.api});
  final ParentApi api;
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _tab = 0;
  int _child = 0;
  bool _loading = true;
  bool _firstDashboardLoad = true;
  bool _headerCompact = false;
  String? _error;
  String? _schoolArt = gSchoolArt.isNotEmpty ? gSchoolArt : null;
  String? _schoolLogo = gSchoolLogo.isNotEmpty ? gSchoolLogo : null;
  int _unreadCount = 0;
  Map<String, dynamic> _data = {};
  Timer? _timer;
  // In-app banner is reserved for announcements only (attendance alerts rely on
  // the system push notification instead).
  Map<String, dynamic>? _bannerNote;
  Timer? _bannerTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    ensureParentNotificationPermission();
    widget.api.registerDeviceToken();
    _load();
    _loadBranding();
    _timer = Timer.periodic(const Duration(seconds: 15), (_) => _load(silent: true));
  }

  Future<void> _loadBranding() async {
    final b = await widget.api.branding();
    if (!mounted) return;
    final art = '${b['mobile_dashboard_school_art'] ?? ''}';
    final logo = '${b['system_logo'] ?? ''}';
    setState(() {
      if (art.isNotEmpty) _schoolArt = art;
      if (logo.isNotEmpty) _schoolLogo = logo;
    });
    if (logo.isNotEmpty) {
      gSchoolLogo = logo;
      await widget.api.prefs.setString('parent_school_logo', logo);
    }
    if (art.isNotEmpty) {
      gSchoolArt = art;
      await widget.api.prefs.setString('parent_school_art', art);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _bannerTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      widget.api.registerDeviceToken();
      _load(silent: true);
    }
  }

  List<dynamic> get _children => (_data['children'] as List?) ?? const [];
  List<dynamic> get _notifications => (_data['notifications'] as List?) ?? const [];
  Map<String, dynamic>? get _selectedChild {
    if (_children.isEmpty) return null;
    return _children[_child.clamp(0, _children.length - 1)] as Map<String, dynamic>;
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() => _loading = true);
    try {
      final data = await widget.api.dashboard();
      if (!mounted) return;
      final unread = ((data['unread_count'] as num?) ?? _countUnread(data['notifications'] as List?)).toInt();
      setState(() {
        _data = data;
        _unreadCount = unread;
        _loading = false;
        _error = null;
      });
      await _processNotificationUpdates(data, showPopups: !_firstDashboardLoad);
      unawaited(widget.api.registerDeviceToken());
      _firstDashboardLoad = false;
    } catch (e) {
      if (!mounted) return;
      if ('$e'.contains('SESSION_EXPIRED')) {
        await _logout();
        return;
      }
      setState(() {
        _loading = false;
        if (!silent) _error = 'Unable to load right now. Pull down to retry.';
      });
    }
  }

  void _onScroll(ScrollNotification notification) {
    if (notification.depth != 0) return;
    final compact = notification.metrics.pixels > 24;
    if (compact != _headerCompact) setState(() => _headerCompact = compact);
  }

  int _countUnread(List? notes) => (notes ?? const []).where((n) {
        final item = n as Map<String, dynamic>;
        return item['is_read'] != true && item['is_read'] != 1;
      }).length;

  String _noteId(Map<String, dynamic> note) => '${note['notification_id'] ?? note['key'] ?? note['created_at'] ?? note['title']}';

  Future<void> _processNotificationUpdates(Map<String, dynamic> data, {required bool showPopups}) async {
    final notes = ((data['notifications'] as List?) ?? const [])
        .whereType<Map>()
        .map((n) => Map<String, dynamic>.from(n))
        .toList();
    final notified = (widget.api.prefs.getStringList(_notifiedPreference) ?? const <String>[]).toSet();
    final fresh = notes.where((note) {
      final unread = note['is_read'] != true && note['is_read'] != 1;
      return unread && !notified.contains(_noteId(note));
    }).toList();
    if (showPopups) {
      for (final note in fresh.take(4)) {
        await _showNotificationPopup(note);
      }
    }
    for (final note in notes.take(120)) {
      notified.add(_noteId(note));
    }
    await widget.api.prefs.setStringList(_notifiedPreference, notified.take(200).toList());
    await widget.api.prefs.setBool(_workerReadyPreference, true);
  }

  bool _isAnnouncement(Map<String, dynamic> note) {
    final type = '${note['type'] ?? ''}'.toLowerCase();
    final category = '${note['category'] ?? ''}'.toLowerCase();
    return type.startsWith('announcement_') || category == 'announcements' || category == 'meetings' || category == 'holidays';
  }

  Future<void> _showNotificationPopup(Map<String, dynamic> note) async {
    if (!mounted) return;
    // FCM is the sole Android system-notification path. Dashboard polling only
    // supplies the in-app banner for announcements.
    if (!_isAnnouncement(note)) return;
    setState(() => _bannerNote = note);
    _bannerTimer?.cancel();
    _bannerTimer = Timer(const Duration(seconds: 8), () {
      if (mounted) setState(() => _bannerNote = null);
    });
  }

  Future<void> _markAllNotificationsRead() async {
    final unread = await widget.api.markNotificationsRead();
    if (!mounted) return;
    final updated = Map<String, dynamic>.from(_data);
    final notes = ((_data['notifications'] as List?) ?? const []).map((n) {
      final item = Map<String, dynamic>.from(n as Map);
      item['is_read'] = true;
      return item;
    }).toList();
    updated['notifications'] = notes;
    updated['unread_count'] = unread;
    setState(() {
      _data = updated;
      _unreadCount = unread;
    });
  }

  Future<void> _markNotificationRead(int id) async {
    if (id <= 0) return;
    // Optimistic local update, then reconcile with the server's unread count.
    final updated = Map<String, dynamic>.from(_data);
    final notes = ((_data['notifications'] as List?) ?? const []).map((n) {
      final item = Map<String, dynamic>.from(n as Map);
      if ('${item['notification_id']}' == '$id') item['is_read'] = true;
      return item;
    }).toList();
    updated['notifications'] = notes;
    setState(() => _data = updated);
    final unread = await widget.api.markNotificationsRead([id]);
    if (!mounted) return;
    setState(() => _unreadCount = unread);
  }

  Future<void> _logout() async {
    await widget.api.logout();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => LoginScreen(api: widget.api)), (r) => false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          Column(
            children: [
              ParentHeader(
                onLogout: _confirmLogout,
                compact: _headerCompact,
                unreadCount: _unreadCount,
                onBell: () => setState(() => _tab = 2),
                logoData: _schoolLogo,
              ),
              Expanded(
                child: _loading
                    ? const Center(child: CircularProgressIndicator(color: kGreen))
                    : NotificationListener<ScrollNotification>(
                        onNotification: (notification) {
                          _onScroll(notification);
                          return false;
                        },
                        child: RefreshIndicator(color: kGreen, onRefresh: _load, child: _buildTab()),
                      ),
              ),
            ],
          ),
          if (_bannerNote != null)
            Positioned(
              left: 14,
              right: 14,
              top: MediaQuery.paddingOf(context).top + 10,
              child: ParentNotificationBanner(
                note: _bannerNote!,
                onTap: () {
                  setState(() {
                    _tab = 2;
                    _bannerNote = null;
                  });
                  _markAllNotificationsRead();
                },
                onClose: () => setState(() => _bannerNote = null),
              ),
            ),
        ],
      ),
      bottomNavigationBar: NavigationBarTheme(
        data: NavigationBarThemeData(
          labelTextStyle: WidgetStateProperty.all(const TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
        ),
        child: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (i) {
            setState(() => _tab = i);
            if (i == 2) _markAllNotificationsRead();
          },
          height: 66,
          backgroundColor: Colors.white,
          indicatorColor: const Color(0xFFDCFCE7),
          destinations: [
            const NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home, color: kGreen), label: 'Home'),
            const NavigationDestination(icon: Icon(Icons.assignment_outlined), selectedIcon: Icon(Icons.assignment, color: kGreen), label: 'Attendance'),
            NavigationDestination(
              icon: BadgeIcon(icon: Icons.notifications_outlined, count: _unreadCount),
              selectedIcon: BadgeIcon(icon: Icons.notifications, count: _unreadCount, selected: true),
              label: 'Alerts',
            ),
            const NavigationDestination(icon: Icon(Icons.phone_outlined), selectedIcon: Icon(Icons.phone, color: kGreen), label: 'Adviser'),
            const NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person, color: kGreen), label: 'Profile'),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmLogout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Log out?'),
        content: const Text('You will need to sign in again to view your child’s attendance.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Log out', style: TextStyle(color: Color(0xFFDC2626)))),
        ],
      ),
    );
    if (ok == true) _logout();
  }

  Widget _buildTab() {
    if (_children.isEmpty) {
      return ListView(children: [
        Padding(
          padding: const EdgeInsets.all(40),
          child: _emptyState(_error != null ? Icons.wifi_off : Icons.person_rounded,
              _error ?? 'No linked students found for your contact number. Please contact the school adviser.'),
        ),
      ]);
    }
    switch (_tab) {
      case 1:
        return AttendanceTab(child: _selectedChild!, picker: _childPicker());
      case 2:
        return NotificationsTab(
          notifications: _notifications,
          child: _selectedChild,
          onMarkRead: _markNotificationRead,
          onMarkAllRead: _markAllNotificationsRead,
        );
      case 3:
        return AdviserTab(child: _selectedChild!, picker: _childPicker());
      case 4:
        return ProfileTab(api: widget.api, childCount: _children.length, onLogout: _confirmLogout);
      default:
        return HomeTab(parentName: widget.api.parentName, children: _children, selected: _child, picker: _childPicker(), schoolArt: _schoolArt, schoolLogo: _schoolLogo);
    }
  }

  Widget? _childPicker() {
    if (_children.length < 2) return null;
    return SizedBox(
      height: 42,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: _children.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (_, i) {
          final c = _children[i] as Map<String, dynamic>;
          final selected = i == _child;
          return ChoiceChip(
            selected: selected,
            onSelected: (_) => setState(() => _child = i),
            label: Text('${c['name']}'.split(',').first),
            labelStyle: TextStyle(color: selected ? Colors.white : kInk, fontWeight: FontWeight.w700, fontSize: 12.5),
            selectedColor: kGreen,
            backgroundColor: Colors.white,
            shape: StadiumBorder(side: BorderSide(color: selected ? kGreen : const Color(0xFFE5E7EB))),
          );
        },
      ),
    );
  }

  Widget _emptyState(IconData icon, String text) => Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 46, color: const Color(0xFFCBD5E1)),
          const SizedBox(height: 12),
          Text(text, textAlign: TextAlign.center, style: const TextStyle(color: kMuted, fontSize: 13.5)),
        ],
      );
}

class BadgeIcon extends StatelessWidget {
  const BadgeIcon({super.key, required this.icon, required this.count, this.selected = false});
  final IconData icon;
  final int count;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final label = count > 99 ? '99+' : '$count';
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Icon(icon, color: selected ? kGreen : null),
        if (count > 0)
          Positioned(
            right: -10,
            top: -8,
            child: Container(
              constraints: const BoxConstraints(minWidth: 18, minHeight: 18),
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
              decoration: BoxDecoration(
                color: const Color(0xFFEF4444),
                borderRadius: BorderRadius.circular(99),
                border: Border.all(color: Colors.white, width: 1.4),
              ),
              child: Text(label, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 9, fontWeight: FontWeight.w900)),
            ),
          ),
      ],
    );
  }
}

// In-app announcement banner — clean card design with pill type badge.
class ParentNotificationBanner extends StatelessWidget {
  const ParentNotificationBanner({super.key, required this.note, required this.onTap, required this.onClose});
  final Map<String, dynamic> note;
  final VoidCallback onTap;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final color = parentNotificationColor(note);
    final label = parentNotificationTypeLabel(note);
    final icon = parentNotificationIcon(note);
    final time = parentNotificationTime(note);
    return Material(
      elevation: 18,
      borderRadius: BorderRadius.circular(20),
      shadowColor: Colors.black.withValues(alpha: .18),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(20),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Thin accent bar at top
              Container(height: 4, color: color),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 10, 10, 12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // Row 1: type pill + time + close
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                          decoration: BoxDecoration(
                            color: color.withValues(alpha: .1),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(icon, color: color, size: 11),
                              const SizedBox(width: 4),
                              Text(
                                label.toUpperCase(),
                                style: TextStyle(color: color, fontSize: 9.5, fontWeight: FontWeight.w900, letterSpacing: .5),
                              ),
                            ],
                          ),
                        ),
                        const Spacer(),
                        Text(time, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: kMuted)),
                        const SizedBox(width: 4),
                        GestureDetector(
                          onTap: onClose,
                          child: Container(
                            width: 26, height: 26,
                            decoration: BoxDecoration(color: const Color(0xFFF1F5F9), borderRadius: BorderRadius.circular(13)),
                            child: const Icon(Icons.close_rounded, size: 15, color: kMuted),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    // Row 2: content
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          width: 42, height: 42,
                          decoration: BoxDecoration(
                            gradient: LinearGradient(
                              begin: Alignment.topLeft,
                              end: Alignment.bottomRight,
                              colors: [color.withValues(alpha: .15), color.withValues(alpha: .06)],
                            ),
                            borderRadius: BorderRadius.circular(13),
                          ),
                          child: Icon(icon, color: color, size: 20),
                        ),
                        const SizedBox(width: 11),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                '${note['title'] ?? 'EduTrack Guardian'}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800, color: kInk, height: 1.2),
                              ),
                              const SizedBox(height: 3),
                              Text(
                                '${note['message'] ?? ''}',
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: kMuted, height: 1.35),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    // Row 3: CTA
                    Container(
                      decoration: BoxDecoration(
                        color: color.withValues(alpha: .07),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(
                            'Tap to open full details',
                            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: color),
                          ),
                          const SizedBox(width: 5),
                          Icon(Icons.arrow_forward_rounded, size: 13, color: color),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Green gradient header (same as SDS/ASDS dashboard)
// ---------------------------------------------------------------------------
class ParentHeader extends StatelessWidget {
  const ParentHeader({
    super.key,
    required this.onLogout,
    required this.compact,
    this.unreadCount = 0,
    this.onBell,
    this.logoData,
  });
  final VoidCallback onLogout;
  final bool compact;
  final int unreadCount;
  final VoidCallback? onBell;
  final String? logoData;

  @override
  Widget build(BuildContext context) {
    final sealSize = compact ? 42.0 : 52.0;
    final actionSize = compact ? 40.0 : 44.0;
    final radius = compact ? 20.0 : 26.0;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      width: double.infinity,
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF0C5A3C), Color(0xFF14855A), Color(0xFF0D6347)],
          stops: [0.0, 0.52, 1.0],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.vertical(bottom: Radius.circular(radius)),
        boxShadow: const [BoxShadow(color: Color(0x330C5A3C), blurRadius: 16, offset: Offset(0, 6))],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.vertical(bottom: Radius.circular(radius)),
        child: Stack(
          children: [
            Positioned.fill(child: CustomPaint(painter: _HeaderPatternPainter())),
            Positioned(
              right: 14,
              bottom: compact ? -34 : -18,
              child: Icon(Icons.school_rounded, size: compact ? 88 : 104, color: Colors.white.withValues(alpha: .06)),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(16, MediaQuery.paddingOf(context).top + (compact ? 7 : 10), 16, compact ? 10 : 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      _seal(sealSize),
                      SizedBox(width: compact ? 10 : 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(kAppName,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(color: Colors.white, fontSize: compact ? 18 : 20, fontWeight: FontWeight.w900, letterSpacing: -.2)),
                            SizedBox(height: compact ? 1 : 2),
                            Text(kSubtitle,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(color: Colors.white70, fontSize: compact ? 10.5 : 11.5, fontWeight: FontWeight.w600)),
                          ],
                        ),
                      ),
                      const SizedBox(width: 10),
                      _bellAction(actionSize),
                      const SizedBox(width: 8),
                      _headerAction(Icons.logout_rounded, onLogout, actionSize),
                    ],
                  ),
                  AnimatedSize(
                    duration: const Duration(milliseconds: 220),
                    curve: Curves.easeOutCubic,
                    alignment: Alignment.topCenter,
                    child: compact
                        ? const SizedBox.shrink()
                        : Column(
                            children: [
                              const SizedBox(height: 14),
                              Row(
                                children: [
                                  _chip(Row(mainAxisSize: MainAxisSize.min, children: const [
                                    LiveDot(color: Color(0xFFFF3B30), size: 9),
                                    SizedBox(width: 6),
                                    Text('LIVE', style: TextStyle(color: Color(0xFFE5403A), fontWeight: FontWeight.w900, fontSize: 11.5)),
                                  ])),
                                  const SizedBox(width: 8),
                                  _chip(Text(shortDateString()), dense: true),
                                  const SizedBox(width: 8),
                                  Flexible(child: _chip(Text(isoDateString()), dense: true)),
                                ],
                              ),
                            ],
                          ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _seal(double size) => AnimatedContainer(
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOutCubic,
        width: size,
        height: size,
        padding: EdgeInsets.all(size * .115),
        decoration: BoxDecoration(
          color: Colors.white,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white.withValues(alpha: .45), width: 3),
          boxShadow: [BoxShadow(color: const Color(0xFF06301F).withValues(alpha: .28), blurRadius: 12, offset: const Offset(0, 4))],
        ),
        child: ClipOval(child: brandLogoImage(logoData ?? gSchoolLogo, fit: BoxFit.cover)),
      );

  Widget _headerAction(IconData icon, VoidCallback onTap, double size) => Material(
        color: Colors.white.withValues(alpha: .14),
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: SizedBox(width: size, height: size, child: Icon(icon, size: 20, color: Colors.white)),
        ),
      );

  // Notification bell with a live unread badge — stays visible when minimized.
  Widget _bellAction(double size) => Material(
        color: Colors.white.withValues(alpha: .14),
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onBell,
          child: SizedBox(
            width: size,
            height: size,
            child: Stack(
              alignment: Alignment.center,
              clipBehavior: Clip.none,
              children: [
                const Icon(Icons.notifications_rounded, size: 20, color: Colors.white),
                if (unreadCount > 0)
                  Positioned(
                    top: 7,
                    right: 7,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                      constraints: const BoxConstraints(minWidth: 15, minHeight: 15),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEF4444),
                        borderRadius: BorderRadius.circular(99),
                        border: Border.all(color: const Color(0xFF0D6347), width: 1.5),
                      ),
                      child: Text(
                        unreadCount > 99 ? '99+' : '$unreadCount',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.white, fontSize: 8.5, fontWeight: FontWeight.w900, height: 1.1),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      );

  Widget _chip(Widget child, {bool dense = false, double fontSize = 11.5}) => Container(
        padding: EdgeInsets.symmetric(horizontal: dense ? 11 : 13, vertical: dense ? 8 : 9),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(13),
          boxShadow: [BoxShadow(color: const Color(0xFF06301F).withValues(alpha: .14), blurRadius: 10, offset: const Offset(0, 4))],
        ),
        child: DefaultTextStyle(style: TextStyle(color: kSeal, fontWeight: FontWeight.w900, fontSize: fontSize), child: child),
      );
}

class _HeaderPatternPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    const gap = 15.0;
    final paint = Paint();
    for (double y = 10; y < size.height; y += gap) {
      final fade = (1 - (y / size.height)).clamp(0.0, 1.0);
      paint.color = Colors.white.withValues(alpha: 0.14 * fade);
      for (double x = 10; x < size.width; x += gap) {
        canvas.drawCircle(Offset(x, y), 1.15, paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _HeaderPatternPainter oldDelegate) => false;
}

// ---------------------------------------------------------------------------
// Home tab — greeting card + stat tiles + Today Analytics donut
// ---------------------------------------------------------------------------
class HomeTab extends StatelessWidget {
  const HomeTab({super.key, required this.parentName, required this.children, required this.selected, this.picker, this.schoolArt, this.schoolLogo});
  final String parentName;
  final List<dynamic> children;
  final int selected;
  final Widget? picker;
  final String? schoolArt;
  final String? schoolLogo;

  int _count(bool Function(Map<String, dynamic>) test) =>
      children.where((c) => test(c as Map<String, dynamic>)).length;

  @override
  Widget build(BuildContext context) {
    final total = children.length;
    final present = _count((c) => '${c['status_key']}' != 'absent' && '${c['today_status']}' != 'Absent');
    final absent = total - present;
    final pct = total == 0 ? 0 : ((present / total) * 100).round();

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      children: [
        if (picker != null) ...[picker!, const SizedBox(height: 14)],
        // Greeting and counters are grouped in one parent card.
        Container(
          padding: const EdgeInsets.all(18),
          decoration: _cardDecoration(),
          child: Column(
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(greeting(), style: const TextStyle(color: kMuted, fontSize: 13.5, fontWeight: FontWeight.w700)),
                        const SizedBox(height: 2),
                        Text(parentName, maxLines: 2, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: kInk, fontSize: 26, fontWeight: FontWeight.w900, height: 1.02)),
                        const SizedBox(height: 8),
                        Text(fullDateString(), maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: kMuted, fontSize: 12.5, fontWeight: FontWeight.w700)),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(width: 124, height: 92, child: SchoolArt(data: schoolArt, logo: schoolLogo)),
                ],
              ),
              const SizedBox(height: 18),
              Row(
                children: [
                  Expanded(child: _dashboardStatTile(const Color(0xFFE8FAF0), kGreen, Icons.groups_rounded, '$total', total == 1 ? 'Child' : 'Children')),
                  const SizedBox(width: 12),
                  Expanded(child: _dashboardStatTile(const Color(0xFFEEF2FF), const Color(0xFF4F46E5), Icons.school_rounded, '$present', 'Present')),
                  const SizedBox(width: 12),
                  Expanded(child: _dashboardStatTile(const Color(0xFFFDF2F2), const Color(0xFFDC2626), Icons.person_off_rounded, '$absent', 'Absent')),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        // Today Analytics donut
        Container(
          padding: const EdgeInsets.all(18),
          decoration: _cardDecoration(),
          child: Row(
            children: [
              SizedBox(
                width: 120,
                height: 120,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    CustomPaint(size: const Size(120, 120), painter: RingPainter(total == 0 ? 0.0 : present / total, color: kGreen)),
                    Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text('$pct%', style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w900, color: kInk)),
                        const Text('ATTENDANCE', style: TextStyle(fontSize: 9, fontWeight: FontWeight.w700, color: kMuted, letterSpacing: 0.5)),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Today Analytics', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: kInk)),
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(color: const Color(0xFFE8FAF0), borderRadius: BorderRadius.circular(20)),
                      child: Text(attendanceScoreLabel(pct), style: const TextStyle(color: kGreenDark, fontWeight: FontWeight.w800, fontSize: 11.5)),
                    ),
                    const SizedBox(height: 10),
                    Text('$present of $total ${total == 1 ? 'child' : 'children'} present today',
                        style: const TextStyle(fontSize: 13, color: kInk, fontWeight: FontWeight.w600)),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        // Child status cards
        ...children.map((c) => _childRow(c as Map<String, dynamic>)),
      ],
    );
  }

  Widget _childRow(Map<String, dynamic> child) {
    final status = '${child['current_status'] ?? 'Absent'}';
    final today = '${child['today_status'] ?? 'Absent'}';
    final flagged = ((child['consecutive_absences'] as num?)?.toInt() ?? 0) >= 2;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: _cardDecoration(),
      child: Column(
        children: [
          Row(
            children: [
              CircleAvatar(radius: 22, backgroundColor: const Color(0xFFEEF2FF), child: Text(_initials('${child['name']}'), style: const TextStyle(color: Color(0xFF4F46E5), fontWeight: FontWeight.w800))),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${child['name']}', style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: kInk)),
                    const SizedBox(height: 2),
                    Text('${child['grade_level']} • ${child['section']} • ${child['school_name']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5, color: kMuted)),
                  ],
                ),
              ),
              StatusPill(label: status),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              _miniInfo('Today', today, statusColor(today)),
              const SizedBox(width: 8),
              _miniInfo('Latest Scan', '${child['latest_scan_time'] ?? '—'}', kInk),
              const SizedBox(width: 8),
              _miniInfo('Adviser', '${child['adviser_name']}'.split(' ').first, kInk),
            ],
          ),
          if (flagged) ...[
            const SizedBox(height: 10),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: const Color(0xFFFEF2F2), border: Border.all(color: const Color(0xFFFECACA)), borderRadius: BorderRadius.circular(10)),
              child: Row(children: [
                const Icon(Icons.warning_amber_rounded, color: Color(0xFFDC2626), size: 18),
                const SizedBox(width: 8),
                Expanded(child: Text('${child['consecutive_absences']} consecutive absences — please contact the adviser.', style: const TextStyle(color: Color(0xFF991B1B), fontSize: 11.5, fontWeight: FontWeight.w600))),
              ]),
            ),
          ],
        ],
      ),
    );
  }

  Widget _miniInfo(String label, String value, Color color) => Expanded(
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 8),
          decoration: BoxDecoration(color: const Color(0xFFF8FAFC), borderRadius: BorderRadius.circular(9)),
          child: Column(
            children: [
              Text(value, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: color)),
              const SizedBox(height: 1),
              Text(label, style: const TextStyle(fontSize: 9.5, color: kMuted, fontWeight: FontWeight.w600)),
            ],
          ),
        ),
      );

  Widget _dashboardStatTile(Color bg, Color fg, IconData icon, String value, String label) => Container(
        constraints: const BoxConstraints(minHeight: 102),
        padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 10),
        decoration: BoxDecoration(
          color: bg.withValues(alpha: .72),
          borderRadius: BorderRadius.circular(17),
          border: Border.all(color: fg.withValues(alpha: .13)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(color: Colors.white.withValues(alpha: .72), borderRadius: BorderRadius.circular(12)),
              child: Icon(icon, color: fg, size: 18),
            ),
            const Spacer(),
            Text(value, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900, color: kInk)),
            const SizedBox(height: 3),
            Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 10.5, color: kMuted, fontWeight: FontWeight.w800)),
          ],
        ),
      );
}

BoxDecoration _cardDecoration() => BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(18),
      boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 18, offset: const Offset(0, 6))],
    );

String _initials(String name) {
  final parts = name.replaceAll(',', ' ').trim().split(RegExp(r'\s+'));
  if (parts.isEmpty || parts.first.isEmpty) return 'S';
  if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
  return (parts.first.substring(0, 1) + parts[1].substring(0, 1)).toUpperCase();
}

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label});
  final String label;
  @override
  Widget build(BuildContext context) {
    final color = statusColor(label);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
      child: Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w800, fontSize: 10.5)),
    );
  }
}

// ---------------------------------------------------------------------------
// Attendance timeline tab
// ---------------------------------------------------------------------------
class AttendanceTab extends StatelessWidget {
  const AttendanceTab({super.key, required this.child, this.picker});
  final Map<String, dynamic> child;
  final Widget? picker;
  @override
  Widget build(BuildContext context) {
    final timeline = (child['timeline'] as List?) ?? const [];
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      children: [
        if (picker != null) ...[picker!, const SizedBox(height: 8)],
        Padding(
          padding: const EdgeInsets.fromLTRB(2, 8, 2, 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              const Icon(Icons.assignment_rounded, color: kGreen, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  "Today’s Scan History",
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w900, color: kInk),
                ),
              ),
              Flexible(
                child: Text(
                  '${child['name']}'.split(',').first,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.right,
                  style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: kMuted),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        if (timeline.isEmpty)
          Container(padding: const EdgeInsets.all(28), decoration: _cardDecoration(), child: const Center(child: Text('No scans recorded yet today.', style: TextStyle(color: kMuted))))
        else
          ...timeline.map((e) {
            final entry = e as Map<String, dynamic>;
            final tone = '${entry['tone'] ?? 'in'}';
            final label = '${entry['label_display'] ?? entry['label'] ?? ''}';
            final studentName = '${child['name'] ?? ''}'.trim();
            return Container(
              margin: const EdgeInsets.only(bottom: 10),
              decoration: _cardDecoration(),
              child: ListTile(
                leading: CircleAvatar(backgroundColor: toneColor(tone).withValues(alpha: 0.12), child: Icon(scanTypeIcon(label, tone), color: toneColor(tone), size: 20)),
                title: Text(label, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5, color: kInk)),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (studentName.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2, bottom: 1),
                        child: Text(studentName, maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: kInk)),
                      ),
                    Text('${entry['time_display'] ?? ''}', style: const TextStyle(fontSize: 12, color: kMuted)),
                  ],
                ),
              ),
            );
          }),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Notifications tab
// ---------------------------------------------------------------------------
String parentNotificationTypeLabel(Map<String, dynamic> note) {
  final provided = '${note['type_label'] ?? ''}'.trim();
  if (provided.isNotEmpty && provided != 'null') return provided;
  final type = '${note['type'] ?? ''}';
  const labels = {
    'attendance_time_in': 'Attendance',
    'attendance_late_time_in': 'Late',
    'attendance_pm_time_in': 'PM Time In',
    'attendance_pm_late_time_in': 'PM Late',
    'attendance_lunch_out': 'Lunch Out',
    'attendance_returned': 'Returned',
    'attendance_early_out': 'Early Dismissal',
    'attendance_completed': 'Completed',
    'attendance_absent': 'Absent',
    'attendance_flagged': '2-Day Flag',
    'announcement_general': 'Announcement',
    'announcement_parent_meeting': 'Parent Meeting',
    'announcement_class_meeting': 'Class Meeting',
    'announcement_holiday': 'Holiday / No Classes',
    'announcement_school_event': 'School Event',
    'announcement_emergency': 'Emergency',
    'announcement_reminder': 'Reminder',
  };
  return labels[type] ?? type.replaceAll('_', ' ');
}

String parentNotificationCategory(Map<String, dynamic> note) {
  final provided = '${note['category'] ?? ''}'.trim();
  if (provided.isNotEmpty && provided != 'null') return provided;
  final type = '${note['type'] ?? ''}';
  if (type.startsWith('attendance_')) return 'attendance';
  if (type.contains('meeting')) return 'meetings';
  if (type.contains('holiday') || type.contains('no_class')) return 'holidays';
  if (type.contains('emergency') || type.contains('absent') || type.contains('flagged') || type.contains('early')) return 'alerts';
  return 'announcements';
}

Color parentNotificationColor(Map<String, dynamic> note) {
  final type = '${note['type'] ?? ''}'.toLowerCase();
  if (type.contains('emergency') || type.contains('early') || type.contains('absent') || type.contains('flagged')) return const Color(0xFFDC2626);
  if (type.contains('late') || type.contains('holiday') || type.contains('meeting') || type.contains('lunch')) return const Color(0xFFEA580C);
  if (type.contains('completed') || type.contains('returned') || type.contains('time_in')) return kGreen;
  return const Color(0xFF2563EB);
}

IconData parentNotificationIcon(Map<String, dynamic> note) {
  final type = '${note['type'] ?? ''}'.toLowerCase();
  // Distinct icon per exact type so every notification reads at a glance.
  switch (type) {
    case 'attendance_time_in':
      return Icons.login_rounded;
    case 'attendance_late_time_in':
      return Icons.running_with_errors_rounded;
    case 'attendance_pm_time_in':
      return Icons.wb_sunny_rounded;
    case 'attendance_pm_late_time_in':
      return Icons.history_toggle_off_rounded;
    case 'attendance_lunch_out':
      return Icons.restaurant_rounded;
    case 'attendance_returned':
      return Icons.assignment_return_rounded;
    case 'attendance_early_out':
      return Icons.logout_rounded;
    case 'attendance_completed':
      return Icons.task_alt_rounded;
    case 'attendance_absent':
      return Icons.person_off_rounded;
    case 'attendance_flagged':
      return Icons.flag_rounded;
    case 'announcement_general':
      return Icons.campaign_rounded;
    case 'announcement_parent_meeting':
      return Icons.groups_rounded;
    case 'announcement_class_meeting':
      return Icons.meeting_room_rounded;
    case 'announcement_holiday':
      return Icons.event_busy_rounded;
    case 'announcement_school_event':
      return Icons.celebration_rounded;
    case 'announcement_emergency':
      return Icons.warning_amber_rounded;
    case 'announcement_reminder':
      return Icons.notifications_active_rounded;
  }
  // Fallback for any legacy/unknown types.
  if (type.contains('meeting')) return Icons.groups_rounded;
  if (type.contains('holiday')) return Icons.event_busy_rounded;
  if (type.contains('emergency')) return Icons.warning_amber_rounded;
  if (type.contains('absent') || type.contains('flagged')) return Icons.report_problem_rounded;
  if (type.contains('early')) return Icons.logout_rounded;
  if (type.contains('lunch')) return Icons.restaurant_rounded;
  if (type.contains('completed')) return Icons.task_alt_rounded;
  if (type.contains('late')) return Icons.running_with_errors_rounded;
  if (type.contains('announcement') || type.contains('reminder') || type.contains('event')) return Icons.campaign_rounded;
  return Icons.login_rounded;
}

bool _isSameDay(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;

String _clockLabel(DateTime t) {
  final hour = t.hour == 0 ? 12 : (t.hour > 12 ? t.hour - 12 : t.hour);
  final minute = t.minute.toString().padLeft(2, '0');
  final suffix = t.hour >= 12 ? 'PM' : 'AM';
  return '$hour:$minute $suffix';
}

// Accurate "received" time from the stored timestamp (Manila wall-clock).
// Recent → relative ("Just now", "5m ago"); else dated/absolute.
String parentNotificationTime(Map<String, dynamic> note) {
  final raw = '${note['created_at'] ?? ''}'.trim();
  final parsed = (raw.isEmpty || raw == 'null') ? null : DateTime.tryParse(raw.replaceFirst(' ', 'T'));
  if (parsed != null) {
    final now = DateTime.now();
    final diff = now.difference(parsed);
    if (!diff.isNegative) {
      if (diff.inMinutes < 1) return 'Just now';
      if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
      if (diff.inHours < 6 && _isSameDay(parsed, now)) return '${diff.inHours}h ago';
    }
    final time = _clockLabel(parsed);
    if (_isSameDay(parsed, now)) return 'Today $time';
    if (_isSameDay(parsed, now.subtract(const Duration(days: 1)))) return 'Yesterday $time';
    return '${_moShort[parsed.month - 1]} ${parsed.day}, $time';
  }
  final display = '${note['time_display'] ?? ''}'.trim();
  return (display.isNotEmpty && display != 'null') ? display : '';
}

// Gallery of every notification design — opened from the "Preview notifications"
// action so guardians can see each type and its alert styling.
class _NotificationPreviewSheet extends StatelessWidget {
  const _NotificationPreviewSheet({required this.samples});
  final List<Map<String, dynamic>> samples;

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: .88,
      minChildSize: .5,
      maxChildSize: .96,
      builder: (context, controller) => Column(
        children: [
          const SizedBox(height: 10),
          Container(width: 44, height: 5, decoration: BoxDecoration(color: const Color(0xFFD7DEE7), borderRadius: BorderRadius.circular(99))),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 6),
            child: Row(
              children: [
                const CircleAvatar(radius: 18, backgroundColor: Color(0xFFDCFCE7), child: Icon(Icons.notifications_active_rounded, color: kGreen, size: 18)),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('All notification types', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w900, color: kInk)),
                      Text('Tap any alert to send it to your tray • ${samples.length} types', style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: kMuted)),
                    ],
                  ),
                ),
                IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close_rounded, color: kMuted)),
              ],
            ),
          ),
          Expanded(
            child: ListView.builder(
              controller: controller,
              padding: const EdgeInsets.fromLTRB(14, 4, 14, 24),
              itemCount: samples.length,
              itemBuilder: (ctx, i) => _previewCard(context, samples[i], i),
            ),
          ),
        ],
      ),
    );
  }

  Widget _previewCard(BuildContext context, Map<String, dynamic> n, int index) {
    final color = parentNotificationColor(n);
    final isAlert = parentNotificationCategory(n) == 'alerts';
    final student = '${n['student_name'] ?? ''}'.trim();
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: isAlert ? color.withValues(alpha: .05) : Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: isAlert ? color.withValues(alpha: .35) : const Color(0xFFE9EEF4)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () async {
            final sent = await showParentNotification(
              '${n['title']}',
              '${n['message']}',
              id: 42000 + index,
              type: '${n['type'] ?? ''}',
            );
            if (!context.mounted) return;
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(
                  sent
                      ? 'Sent "${n['title']}" to your notification tray.'
                      : 'Could not send the test alert. Check Guardian notification permission in Android Settings.',
                ),
                duration: const Duration(seconds: 3),
              ),
            );
          },
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CircleAvatar(radius: 21, backgroundColor: color.withValues(alpha: .12), child: Icon(parentNotificationIcon(n), color: color, size: 19)),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            decoration: BoxDecoration(color: color.withValues(alpha: .1), borderRadius: BorderRadius.circular(99)),
                            child: Text(parentNotificationTypeLabel(n), style: TextStyle(color: color, fontSize: 10.5, fontWeight: FontWeight.w900)),
                          ),
                          const Spacer(),
                          Text(parentNotificationTime(n), style: const TextStyle(color: kMuted, fontSize: 10.5, fontWeight: FontWeight.w700)),
                        ],
                      ),
                      const SizedBox(height: 7),
                      Text('${n['title']}', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w900, color: kInk)),
                      const SizedBox(height: 3),
                      Text('${n['message']}', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: kMuted, height: 1.28)),
                      const SizedBox(height: 7),
                      Row(
                        children: [
                          if (student.isNotEmpty) ...[
                            const Icon(Icons.person_rounded, size: 13, color: Color(0xFF94A3B8)),
                            const SizedBox(width: 4),
                            Text(student, style: const TextStyle(color: kMuted, fontSize: 11, fontWeight: FontWeight.w700)),
                          ],
                          const Spacer(),
                          Icon(Icons.send_rounded, size: 13, color: color),
                          const SizedBox(width: 4),
                          Text('Tap to send', style: TextStyle(color: color, fontSize: 10.5, fontWeight: FontWeight.w800)),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class NotificationsTab extends StatefulWidget {
  const NotificationsTab({
    super.key,
    required this.notifications,
    this.child,
    this.onMarkRead,
    this.onMarkAllRead,
  });
  final List<dynamic> notifications;
  final Map<String, dynamic>? child;
  final Future<void> Function(int id)? onMarkRead;
  final Future<void> Function()? onMarkAllRead;

  @override
  State<NotificationsTab> createState() => _NotificationsTabState();
}

class _NotificationsTabState extends State<NotificationsTab> {
  String _filter = 'all';

  bool _isUnread(Map<String, dynamic> n) => n['is_read'] != true && n['is_read'] != 1;

  int _idOf(Map<String, dynamic> n) => int.tryParse('${n['notification_id'] ?? ''}') ?? 0;

  @override
  Widget build(BuildContext context) {
    final all = widget.notifications.whereType<Map>().map((n) => Map<String, dynamic>.from(n)).toList();
    final unreadCount = all.where(_isUnread).length;
    final notifications = _filter == 'all' ? all : all.where((n) => parentNotificationCategory(n) == _filter).toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      children: [
        _header(unreadCount),
        const SizedBox(height: 12),
        _filterBar(),
        const SizedBox(height: 12),
        if (notifications.isEmpty)
          const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('No notifications yet.', style: TextStyle(color: kMuted))))
        else
          ...notifications.map(_notificationCard),
      ],
    );
  }

  Widget _header(int unreadCount) => Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Notifications', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: kInk)),
                Text(
                  unreadCount == 0 ? 'You are all caught up' : '$unreadCount unread',
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: kMuted),
                ),
              ],
            ),
          ),
          if (unreadCount > 0 && widget.onMarkAllRead != null)
            TextButton.icon(
              onPressed: () => widget.onMarkAllRead!.call(),
              icon: const Icon(Icons.done_all_rounded, size: 18, color: kGreen),
              label: const Text('Mark all read', style: TextStyle(color: kGreen, fontWeight: FontWeight.w800, fontSize: 12.5)),
            ),
        ],
      );

  Widget _filterBar() {
    const filters = [
      ['all', 'All'],
      ['attendance', 'Attendance'],
      ['announcements', 'Announcements'],
      ['meetings', 'Meetings'],
      ['holidays', 'Holidays'],
      ['alerts', 'Alerts'],
    ];
    return SizedBox(
      height: 38,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: filters.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (_, i) {
          final key = filters[i][0];
          final label = filters[i][1];
          final selected = key == _filter;
          return ChoiceChip(
            selected: selected,
            onSelected: (_) => setState(() => _filter = key),
            label: Text(label),
            labelStyle: TextStyle(color: selected ? Colors.white : kInk, fontSize: 12, fontWeight: FontWeight.w800),
            selectedColor: kGreen,
            backgroundColor: Colors.white,
            shape: StadiumBorder(side: BorderSide(color: selected ? kGreen : const Color(0xFFE5E7EB))),
          );
        },
      ),
    );
  }

  Widget _notificationCard(Map<String, dynamic> n) {
    final color = parentNotificationColor(n);
    final unread = _isUnread(n);
    final isAlert = parentNotificationCategory(n) == 'alerts';
    final student = '${n['student_name'] ?? n['child_name'] ?? ''}'.trim();
    final school = '${n['school_name'] ?? ''}'.trim();
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: isAlert ? color.withValues(alpha: .05) : Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: isAlert ? color.withValues(alpha: .35) : const Color(0xFFE9EEF4)),
        boxShadow: const [BoxShadow(color: Color(0x0F101828), blurRadius: 12, offset: Offset(0, 6))],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => _openDetail(n),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CircleAvatar(
                  radius: 22,
                  backgroundColor: color.withValues(alpha: .12),
                  child: Icon(parentNotificationIcon(n), color: color, size: 20),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            decoration: BoxDecoration(color: color.withValues(alpha: .1), borderRadius: BorderRadius.circular(99)),
                            child: Text(parentNotificationTypeLabel(n), style: TextStyle(color: color, fontSize: 10.5, fontWeight: FontWeight.w900)),
                          ),
                          const Spacer(),
                          if (unread)
                            Container(width: 9, height: 9, decoration: const BoxDecoration(color: Color(0xFFEF4444), shape: BoxShape.circle)),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text('${n['title'] ?? 'EduTrack Guardian'}', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w900, color: kInk)),
                      const SizedBox(height: 4),
                      Text('${n['message'] ?? ''}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: kMuted, height: 1.28)),
                      const SizedBox(height: 9),
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        children: [
                          if (student.isNotEmpty) _miniMeta(Icons.person_rounded, student),
                          if (school.isNotEmpty) _miniMeta(Icons.school_rounded, school),
                          _miniMeta(Icons.schedule_rounded, parentNotificationTime(n)),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _miniMeta(IconData icon, String text) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: const Color(0xFF94A3B8)),
          const SizedBox(width: 4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 210),
            child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: kMuted, fontSize: 11, fontWeight: FontWeight.w700)),
          ),
        ],
      );

  void _openDetail(Map<String, dynamic> n) {
    final id = _idOf(n);
    if (_isUnread(n) && id > 0 && widget.onMarkRead != null) {
      widget.onMarkRead!.call(id);
    }
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.white,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (_) => _NotificationDetailSheet(note: n, child: widget.child),
    );
  }
}

// Detail sheet — full message plus Contact Adviser for alert-type notifications.
class _NotificationDetailSheet extends StatelessWidget {
  const _NotificationDetailSheet({required this.note, this.child});
  final Map<String, dynamic> note;
  final Map<String, dynamic>? child;

  Future<void> _launch(BuildContext context, Uri uri) async {
    try {
      final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!ok && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('No app available for this action.')));
      }
    } catch (_) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open this action.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final color = parentNotificationColor(note);
    final isAlert = parentNotificationCategory(note) == 'alerts';
    final student = '${note['student_name'] ?? note['child_name'] ?? ''}'.trim();
    final school = '${note['school_name'] ?? ''}'.trim();
    final phone = '${child?['adviser_contact'] ?? ''}'.replaceAll(RegExp(r'[^0-9+]'), '');
    final email = '${child?['adviser_email'] ?? ''}'.trim();
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 22),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(child: Container(width: 44, height: 5, decoration: BoxDecoration(color: const Color(0xFFE2E8F0), borderRadius: BorderRadius.circular(99)))),
            const SizedBox(height: 16),
            Row(
              children: [
                CircleAvatar(radius: 24, backgroundColor: color.withValues(alpha: .12), child: Icon(parentNotificationIcon(note), color: color, size: 22)),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(color: color.withValues(alpha: .1), borderRadius: BorderRadius.circular(99)),
                        child: Text(parentNotificationTypeLabel(note), style: TextStyle(color: color, fontSize: 10.5, fontWeight: FontWeight.w900)),
                      ),
                      const SizedBox(height: 6),
                      Text('${note['title'] ?? 'EduTrack Guardian'}', style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w900, color: kInk)),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Text('${note['message'] ?? ''}', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Color(0xFF334155), height: 1.4)),
            const SizedBox(height: 16),
            if (student.isNotEmpty) _metaRow(Icons.person_rounded, 'Student', student),
            if (school.isNotEmpty) _metaRow(Icons.school_rounded, 'School', school),
            _metaRow(Icons.schedule_rounded, 'Received', parentNotificationTime(note)),
            if (isAlert && (phone.isNotEmpty || email.isNotEmpty)) ...[
              const SizedBox(height: 16),
              if (phone.isNotEmpty)
                _contactButton(context, Icons.call_rounded, 'Contact Adviser', kGreen, Uri.parse('tel:$phone')),
              if (phone.isEmpty && email.isNotEmpty)
                _contactButton(context, Icons.email_rounded, 'Email Adviser', const Color(0xFF2563EB), Uri.parse('mailto:$email')),
            ],
          ],
        ),
      ),
    );
  }

  Widget _metaRow(IconData icon, String label, String value) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(
          children: [
            Icon(icon, size: 16, color: const Color(0xFF94A3B8)),
            const SizedBox(width: 8),
            Text('$label: ', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: kMuted)),
            Expanded(child: Text(value, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: kInk))),
          ],
        ),
      );

  Widget _contactButton(BuildContext context, IconData icon, String label, Color color, Uri uri) => SizedBox(
        width: double.infinity,
        height: 48,
        child: ElevatedButton.icon(
          onPressed: () => _launch(context, uri),
          icon: Icon(icon, size: 19),
          label: Text(label, style: const TextStyle(fontWeight: FontWeight.w800)),
          style: ElevatedButton.styleFrom(backgroundColor: color, foregroundColor: Colors.white, elevation: 0, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
        ),
      );
}

// ---------------------------------------------------------------------------
// Adviser contact tab
// ---------------------------------------------------------------------------
class AdviserTab extends StatelessWidget {
  const AdviserTab({super.key, required this.child, this.picker});
  final Map<String, dynamic> child;
  final Widget? picker;

  Future<void> _launch(BuildContext context, Uri uri) async {
    try {
      final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!ok && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('No app available for this action.')));
      }
    } catch (_) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open this action.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final adviser = '${child['adviser_name'] ?? 'No adviser assigned'}';
    final contact = '${child['adviser_contact'] ?? ''}'.trim();
    final email = '${child['adviser_email'] ?? ''}'.trim();
    final phone = contact.replaceAll(RegExp(r'[^0-9+]'), '');
    final body = Uri.encodeComponent('Good day Teacher, this is the parent/guardian of ${child['name']} (${child['grade_level']} - ${child['section']}). ');
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      children: [
        if (picker != null) ...[picker!, const SizedBox(height: 8)],
        Container(
          padding: const EdgeInsets.all(18),
          decoration: _cardDecoration(),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                const CircleAvatar(radius: 22, backgroundColor: Color(0xFFDCFCE7), child: Icon(Icons.co_present, color: kGreen)),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(adviser, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: kInk)),
                    Text('Class Adviser • ${child['section']}', style: const TextStyle(fontSize: 12, color: kMuted)),
                  ]),
                ),
              ]),
              const SizedBox(height: 18),
              if (phone.isNotEmpty) ...[
                _actionButton(context, Icons.call, 'Call Adviser', kGreen, Uri.parse('tel:$phone')),
                const SizedBox(height: 10),
                _actionButton(context, Icons.sms, 'Send SMS', const Color(0xFF2563EB), Uri.parse('sms:$phone?body=$body')),
                const SizedBox(height: 10),
              ],
              if (email.isNotEmpty)
                _actionButton(context, Icons.email, 'Send Email', const Color(0xFFEA580C), Uri.parse('mailto:$email?body=$body')),
              if (phone.isEmpty && email.isEmpty)
                const Text('No adviser contact details on file. Please reach the school office.', style: TextStyle(color: kMuted, fontSize: 12.5)),
            ],
          ),
        ),
      ],
    );
  }

  Widget _actionButton(BuildContext context, IconData icon, String label, Color color, Uri uri) => SizedBox(
        width: double.infinity,
        height: 46,
        child: OutlinedButton.icon(
          onPressed: () => _launch(context, uri),
          icon: Icon(icon, color: color, size: 19),
          label: Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w700)),
          style: OutlinedButton.styleFrom(side: BorderSide(color: color.withValues(alpha: 0.4)), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
        ),
      );
}

// ---------------------------------------------------------------------------
// Profile tab
// ---------------------------------------------------------------------------
class ProfileTab extends StatefulWidget {
  const ProfileTab({super.key, required this.api, required this.childCount, required this.onLogout});
  final ParentApi api;
  final int childCount;
  final VoidCallback onLogout;
  @override
  State<ProfileTab> createState() => _ProfileTabState();
}

class _ProfileTabState extends State<ProfileTab> {
  String _current = '';
  String _latest = '';
  String _apkUrl = '$kBaseUrl/download/parent-app';
  String _notes = '';
  bool _otaBusy = false;
  String _otaMsg = '';

  @override
  void initState() {
    super.initState();
    _loadVersions();
  }

  Future<void> _loadVersions() async {
    try {
      final info = await PackageInfo.fromPlatform();
      if (mounted) setState(() => _current = info.version);
    } catch (_) {/* ignore */}
    final v = await widget.api.appVersion();
    if (!mounted) return;
    setState(() {
      _latest = '${v['latest_version'] ?? ''}';
      if ('${v['apk_url'] ?? ''}'.isNotEmpty) _apkUrl = '${v['apk_url']}';
      _notes = '${v['notes'] ?? ''}';
    });
  }

  bool get _updateAvailable {
    if (_latest.isEmpty || _current.isEmpty) return false;
    List<int> p(String s) => s.split('.').map((x) => int.tryParse(x.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0).toList();
    final a = p(_latest), b = p(_current);
    for (var i = 0; i < a.length; i++) {
      final bi = i < b.length ? b[i] : 0;
      if (a[i] != bi) return a[i] > bi;
    }
    return false;
  }

  // Download the latest APK and open the system installer directly — no browser.
  Future<void> _installUpdate() async {
    setState(() {
      _otaBusy = true;
      _otaMsg = 'Downloading update…';
    });
    try {
      final dir = await getTemporaryDirectory();
      final file = File('${dir.path}/edutrack-parent.apk');
      final resp = await http.Client().send(http.Request('GET', Uri.parse(_apkUrl))).timeout(const Duration(minutes: 4));
      final total = resp.contentLength ?? 0;
      final sink = file.openWrite();
      var received = 0;
      await for (final chunk in resp.stream) {
        sink.add(chunk);
        received += chunk.length;
        if (total > 0 && mounted) {
          setState(() => _otaMsg = 'Downloading ${(received / total * 100).round()}%');
        }
      }
      await sink.close();
      if (!mounted) return;
      setState(() {
        _otaBusy = false;
        _otaMsg = 'Opening installer — tap Install to finish.';
      });
      final result = await OpenFilex.open(file.path, type: 'application/vnd.android.package-archive');
      if (mounted) {
        setState(() => _otaMsg = 'If Android shows package conflict, uninstall the old EduTrack Guardian app once, then install this signed update. Future updates will install normally.');
      }
      if (result.type != ResultType.done && mounted) {
        setState(() => _otaMsg = 'Allow “Install unknown apps” for EduTrack Guardian, then tap Install Update again.');
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _otaBusy = false;
        _otaMsg = 'Update failed. Check your connection and try again.';
      });
    }
  }

  Future<void> _testNotification() async {
    // Make sure notifications are allowed first, then open the gallery. Tapping a
    // card sends that alert to the system tray (see _NotificationPreviewSheet).
    final granted = await ensureParentNotificationPermission();
    if (!mounted) return;
    if (!granted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Notifications are turned off. Enable them in Settings → Apps → EduTrack Guardian → Notifications.'),
        duration: Duration(seconds: 5),
      ));
      return;
    }
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFFF6F8FB),
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (_) => _NotificationPreviewSheet(samples: sampleParentNotifications()),
    );
  }

  Future<void> _editProfile() async {
    final name = TextEditingController(text: widget.api.parentName == 'Parent' ? '' : widget.api.parentName);
    final contact = TextEditingController(text: widget.api.parentContact);
    final username = TextEditingController(text: widget.api.parentUsername);
    bool busy = false;
    String? err;
    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) {
          Future<void> submit() async {
            if (name.text.trim().isEmpty) {
              setLocal(() => err = 'Please enter your name.');
              return;
            }
            if (contact.text.trim().replaceAll(RegExp(r'[^0-9]'), '').length < 7) {
              setLocal(() => err = 'Please enter a valid contact number.');
              return;
            }
            setLocal(() {
              busy = true;
              err = null;
            });
            final res = await widget.api.updateProfile(name.text.trim(), contact.text.trim(), username.text.trim());
            if (res['success'] == true) {
              if (ctx.mounted) Navigator.pop(ctx);
              if (mounted) {
                setState(() {});
                final linked = res['linked_students'] ?? 0;
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Profile updated. Synced to $linked student record(s).')),
                );
              }
            } else {
              setLocal(() {
                busy = false;
                err = '${res['error']}';
              });
            }
          }

          InputDecoration dec(String l, [String? h]) => InputDecoration(labelText: l, hintText: h, isDense: true, border: const OutlineInputBorder());
          return AlertDialog(
            title: const Text('Edit Profile'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (err != null)
                    Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(err!, style: const TextStyle(color: Color(0xFFDC2626), fontSize: 12.5))),
                  TextField(controller: name, textCapitalization: TextCapitalization.words, decoration: dec('Full name')),
                  const SizedBox(height: 10),
                  TextField(controller: contact, keyboardType: TextInputType.phone, decoration: dec('Contact number', '09xxxxxxxxx')),
                  const SizedBox(height: 10),
                  TextField(controller: username, decoration: dec('Username (optional)')),
                  const SizedBox(height: 10),
                  const Text(
                    'Changing your number keeps you linked to your children and updates the number your teacher and principal use to reach you.',
                    style: TextStyle(fontSize: 11, color: kMuted, height: 1.3),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(onPressed: busy ? null : () => Navigator.pop(ctx), child: const Text('Cancel')),
              TextButton(
                onPressed: busy ? null : submit,
                child: busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Save'),
              ),
            ],
          );
        },
      ),
    );
    name.dispose();
    contact.dispose();
    username.dispose();
  }

  Future<void> _changePassword() async {
    final cur = TextEditingController();
    final nw = TextEditingController();
    final cf = TextEditingController();
    bool busy = false;
    bool obscure = true;
    String? err;
    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) {
          Future<void> submit() async {
            setLocal(() {
              busy = true;
              err = null;
            });
            final res = await widget.api.changePassword(cur.text, nw.text, cf.text);
            if (res['success'] == true) {
              if (ctx.mounted) Navigator.pop(ctx);
              if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Password updated successfully.')));
            } else {
              setLocal(() {
                busy = false;
                err = '${res['error']}';
              });
            }
          }

          InputDecoration dec(String l) => InputDecoration(labelText: l, isDense: true, border: const OutlineInputBorder());
          return AlertDialog(
            title: const Text('Change Password'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (err != null)
                    Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(err!, style: const TextStyle(color: Color(0xFFDC2626), fontSize: 12.5))),
                  TextField(controller: cur, obscureText: obscure, decoration: dec('Current password')),
                  const SizedBox(height: 10),
                  TextField(controller: nw, obscureText: obscure, decoration: dec('New password')),
                  const SizedBox(height: 10),
                  TextField(controller: cf, obscureText: obscure, decoration: dec('Confirm new password')),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(onPressed: () => setLocal(() => obscure = !obscure), child: Text(obscure ? 'Show' : 'Hide', style: const TextStyle(fontSize: 12))),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(onPressed: busy ? null : () => Navigator.pop(ctx), child: const Text('Cancel')),
              TextButton(
                onPressed: busy ? null : submit,
                child: busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Update'),
              ),
            ],
          );
        },
      ),
    );
    cur.dispose();
    nw.dispose();
    cf.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final api = widget.api;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: _cardDecoration(),
          child: Column(children: [
            CircleAvatar(radius: 34, backgroundColor: const Color(0xFFDCFCE7), child: Text(_initials(api.parentName), style: const TextStyle(color: kGreen, fontWeight: FontWeight.w800, fontSize: 22))),
            const SizedBox(height: 12),
            Text(api.parentName, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: kInk)),
            const SizedBox(height: 2),
            const Text('Parent / Guardian', style: TextStyle(fontSize: 12.5, color: kMuted)),
          ]),
        ),
        const SizedBox(height: 12),
        // Account info + change password
        Container(
          decoration: _cardDecoration(),
          child: Column(children: [
            ListTile(
              leading: const Icon(Icons.badge_outlined, color: kGreen, size: 20),
              title: const Text('Edit Profile', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: kInk)),
              subtitle: const Text('Update your name, contact number & username', style: TextStyle(fontSize: 11.5, color: kMuted)),
              trailing: const Icon(Icons.chevron_right, color: kMuted),
              onTap: _editProfile,
            ),
            const Divider(height: 1),
            _tile(Icons.person_outline, 'Name', api.parentName == 'Parent' ? '—' : api.parentName),
            const Divider(height: 1),
            _tile(Icons.phone_outlined, 'Contact Number', api.parentContact.isEmpty ? '—' : api.parentContact),
            const Divider(height: 1),
            _tile(Icons.alternate_email, 'Username', api.parentUsername.isEmpty ? '—' : api.parentUsername),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.lock_outline, color: kGreen, size: 20),
              title: const Text('Change Password', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: kInk)),
              subtitle: const Text('Update your account password', style: TextStyle(fontSize: 11.5, color: kMuted)),
              trailing: const Icon(Icons.chevron_right, color: kMuted),
              onTap: _changePassword,
            ),
            const Divider(height: 1),
            _tile(Icons.family_restroom, 'Linked Children', '${widget.childCount}'),
          ]),
        ),
        const SizedBox(height: 12),
        // App updates
        Container(
          padding: const EdgeInsets.all(16),
          decoration: _cardDecoration(),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: const [
                Icon(Icons.system_update, color: kGreen, size: 20),
                SizedBox(width: 8),
                Text('App Updates', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w900, color: kInk)),
              ]),
              const SizedBox(height: 8),
              Text('Installed: v${_current.isEmpty ? '…' : _current}${_latest.isEmpty ? '' : '   •   Latest: v$_latest'}',
                  style: const TextStyle(fontSize: 12.5, color: kMuted, fontWeight: FontWeight.w600)),
              if (_updateAvailable) ...[
                const SizedBox(height: 12),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: const Color(0xFFFFF7ED), border: Border.all(color: const Color(0xFFFED7AA)), borderRadius: BorderRadius.circular(10)),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Row(children: [
                        Icon(Icons.new_releases, color: Color(0xFFEA580C), size: 18),
                        SizedBox(width: 6),
                        Text('Update available', style: TextStyle(color: Color(0xFF9A3412), fontWeight: FontWeight.w800, fontSize: 13)),
                      ]),
                      if (_notes.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(_notes, style: const TextStyle(color: Color(0xFF9A3412), fontSize: 12)),
                      ],
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 46,
                child: ElevatedButton.icon(
                  onPressed: _otaBusy ? null : _installUpdate,
                  icon: _otaBusy
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Icon(Icons.download_rounded, size: 19),
                  label: Text(_updateAvailable ? 'Install Update Now' : 'Install Latest Version'),
                  style: ElevatedButton.styleFrom(backgroundColor: kGreen, foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
                ),
              ),
              if (_otaMsg.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(_otaMsg, style: const TextStyle(fontSize: 12, color: kGreenDark, fontWeight: FontWeight.w600)),
              ],
              const SizedBox(height: 8),
              const Text(
                'Installs directly inside the app — no browser needed. When asked, allow “Install unknown apps” for EduTrack Guardian, then tap Install.',
                style: TextStyle(fontSize: 11, color: kMuted),
              ),
              const SizedBox(height: 6),
              const Text(
                'Package conflict fix: uninstall the old EduTrack Guardian app once, then install this signed update. After that, future updates will install normally.',
                style: TextStyle(fontSize: 11, color: Color(0xFF9A3412), fontWeight: FontWeight.w700),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        // Notification test
        Container(
          padding: const EdgeInsets.all(16),
          decoration: _cardDecoration(),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: const [
                Icon(Icons.notifications_active_outlined, color: kGreen, size: 20),
                SizedBox(width: 8),
                Text('Notifications', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w900, color: kInk)),
              ]),
              const SizedBox(height: 6),
              const Text('Preview every alert type — tap any one to send it to your notification tray.', style: TextStyle(fontSize: 12, color: kMuted)),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 46,
                child: OutlinedButton.icon(
                  onPressed: _testNotification,
                  icon: const Icon(Icons.notifications_active_rounded, color: kGreen, size: 19),
                  label: const Text('Preview all notifications', style: TextStyle(color: kGreen, fontWeight: FontWeight.w700)),
                  style: OutlinedButton.styleFrom(side: const BorderSide(color: Color(0xFFBBF7D0)), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          height: 48,
          child: OutlinedButton.icon(
            onPressed: widget.onLogout,
            icon: const Icon(Icons.logout, color: Color(0xFFDC2626), size: 19),
            label: const Text('Log Out', style: TextStyle(color: Color(0xFFDC2626), fontWeight: FontWeight.w700)),
            style: OutlinedButton.styleFrom(side: const BorderSide(color: Color(0xFFFECACA)), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
          ),
        ),
        const SizedBox(height: 20),
        Center(child: Text('EduTrack Guardian • v${_current.isEmpty ? '1.0.1' : _current}', style: const TextStyle(color: Color(0xFF9CA3AF), fontSize: 11.5))),
      ],
    );
  }

  Widget _tile(IconData icon, String label, String value) => ListTile(
        leading: Icon(icon, color: kMuted, size: 20),
        title: Text(label, style: const TextStyle(fontSize: 12.5, color: kMuted)),
        trailing: Text(value, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: kInk)),
      );
}

// ---------------------------------------------------------------------------
// Painters & status helpers
// ---------------------------------------------------------------------------
class RingPainter extends CustomPainter {
  RingPainter(this.progress, {required this.color});
  final double progress;
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(size.width, size.height) / 2 - 10;
    final bg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 12
      ..strokeCap = StrokeCap.round
      ..color = color.withValues(alpha: .18);
    final fg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 12
      ..strokeCap = StrokeCap.round
      ..color = color;
    canvas.drawCircle(center, radius, bg);
    canvas.drawArc(Rect.fromCircle(center: center, radius: radius), -math.pi / 2, math.pi * 2 * progress.clamp(0, 1), false, fg);
  }

  @override
  bool shouldRepaint(RingPainter oldDelegate) => oldDelegate.progress != progress || oldDelegate.color != color;
}

// Renders the admin-uploaded school art (same image as the SDS/ASDS dashboard)
// when available, otherwise the bundled painted school.
class SchoolArt extends StatelessWidget {
  const SchoolArt({super.key, this.data, this.logo});
  final String? data;
  final String? logo;

  Widget _logoOrHouse() {
    final l = (logo ?? '').trim();
    if (l.isNotEmpty) {
      return Padding(
        padding: const EdgeInsets.all(4),
        child: brandLogoImage(l, fallback: () => const _DefaultSchoolArt()),
      );
    }
    return const _DefaultSchoolArt();
  }

  @override
  Widget build(BuildContext context) {
    final d = (data ?? '').trim();
    if (d.isNotEmpty) {
      try {
        final comma = d.indexOf(',');
        final encoded = comma != -1 ? d.substring(comma + 1) : d;
        final bytes = base64Decode(encoded);
        return Image.memory(
          bytes,
          fit: BoxFit.contain,
          alignment: Alignment.bottomRight,
          gaplessPlayback: true,
          errorBuilder: (_, __, ___) => _logoOrHouse(),
        );
      } on FormatException {
        return _logoOrHouse();
      }
    }
    return _logoOrHouse();
  }
}

class _DefaultSchoolArt extends StatelessWidget {
  const _DefaultSchoolArt();
  @override
  Widget build(BuildContext context) => CustomPaint(painter: _SchoolArtPainter());
}

class _SchoolArtPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final ground = Paint()..color = const Color(0xFFE8F7EE);
    final green = Paint()..color = const Color(0xFF45A56D);
    final deep = Paint()..color = const Color(0xFF127456);
    final mid = Paint()..color = const Color(0xFF73BE89);
    final pale = Paint()..color = const Color(0xFFF8FFFB);
    final sky = Paint()..color = const Color(0xFFEAF7FF);

    canvas.drawOval(Rect.fromLTWH(6, size.height - 18, size.width - 12, 15), ground);
    canvas.drawCircle(Offset(size.width * .18, size.height * .64), 18, mid);
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(size.width * .16, size.height * .64, size.width * .08, size.height * .26), const Radius.circular(4)), deep);
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(size.width * .38, size.height * .40, size.width * .52, size.height * .42), const Radius.circular(5)), mid);

    final roof = Path()
      ..moveTo(size.width * .34, size.height * .42)
      ..lineTo(size.width * .64, size.height * .23)
      ..lineTo(size.width * .94, size.height * .42)
      ..close();
    canvas.drawPath(roof, deep);

    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(size.width * .58, size.height * .58, size.width * .14, size.height * .27), const Radius.circular(4)), deep);
    for (final x in [0.45, 0.78]) {
      canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(size.width * x, size.height * .54, 12, 15), const Radius.circular(2)), pale);
    }
    canvas.drawCircle(Offset(size.width * .65, size.height * .37), 14, pale);
    canvas.drawLine(Offset(size.width * .65, size.height * .28), Offset(size.width * .65, size.height * .08), deep..strokeWidth = 3);
    final flag = Path()
      ..moveTo(size.width * .66, size.height * .08)
      ..lineTo(size.width * .82, size.height * .13)
      ..lineTo(size.width * .66, size.height * .18)
      ..close();
    canvas.drawPath(flag, green);
    canvas.drawOval(Rect.fromLTWH(size.width * .08, 6, size.width * .22, 9), sky);
    canvas.drawOval(Rect.fromLTWH(size.width * .78, 15, size.width * .18, 8), sky);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

Color statusColor(String s) {
  final v = s.toLowerCase();
  if (v.contains('inside')) return kGreen;
  if (v.contains('lunch')) return const Color(0xFFD97706);
  if (v.contains('completed')) return const Color(0xFF2563EB);
  if (v.contains('outside') || v.contains('early')) return const Color(0xFFEA580C);
  if (v.contains('absent')) return const Color(0xFFDC2626);
  if (v.contains('late')) return const Color(0xFFD97706);
  if (v.contains('half')) return const Color(0xFFEA580C);
  return kGreen;
}

IconData toneIcon(String tone) {
  switch (tone) {
    case 'out':
      return Icons.logout;
    case 'lunch':
      return Icons.restaurant;
    case 'late':
      return Icons.schedule;
    case 'holiday':
      return Icons.event_busy; // weekends / holidays / no-class days
    case 'return':
      return Icons.login;
    default:
      return Icons.login;
  }
}

// Distinct icon per scan TYPE so each row reads at a glance — early dismissal,
// late, lunch, returned, completed, PM, and plain time in/out are all different.
IconData scanTypeIcon(String label, String tone) {
  final l = label.toUpperCase();
  if (l.contains('EARLY')) return Icons.directions_run_rounded;     // early dismissal
  if (l.contains('LATE')) return Icons.running_with_errors_rounded; // late
  if (l.contains('LUNCH')) return Icons.restaurant_rounded;
  if (l.contains('RETURN')) return Icons.keyboard_return_rounded;
  if (l.contains('COMPLET')) return Icons.task_alt_rounded;
  if (l.contains('PM') && l.contains('IN')) return Icons.wb_sunny_rounded;
  if (l.contains('OUT')) return Icons.logout_rounded;
  if (l.contains('IN')) return Icons.login_rounded;
  return toneIcon(tone);
}

Color toneColor(String tone) {
  switch (tone) {
    case 'out':
      return const Color(0xFFEA580C);
    case 'lunch':
    case 'late':
      return const Color(0xFFD97706);
    case 'holiday':
      return const Color(0xFF7C3AED); // calm violet for non-school days
    default:
      return kGreen;
  }
}
