import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:timezone/data/latest_all.dart' as tz_data;
import 'package:timezone/timezone.dart' as tz;
import 'package:url_launcher/url_launcher.dart';

class AppConfig {
  static const appName = 'EduTrack';
  static const subtitle = 'Schools Division of Sipalay City';
  static const monitoringLabel = 'Attendance Monitoring App';
  static const noInternetMessage =
      "Can't connect to server due to no internet connection.";
  static const logoAsset = 'assets/images/app_logo.png';
  static const baseUrl = 'https://sdo-sipalay-edutrack.up.railway.app';
}

// Live branding pulled from the server (admin-uploaded logo + names). These
// update the header instantly when the dashboard refreshes — so changing the
// logo in the Admin Dashboard appears in the app WITHOUT a reinstall. The
// values are cached on the device so the correct logo shows immediately on the
// next launch, even before the first network call completes.
final ValueNotifier<String?> brandLogoData = ValueNotifier<String?>(null);
final ValueNotifier<String?> dashboardSchoolArtData = ValueNotifier<String?>(
  null,
);
final ValueNotifier<String> brandName = ValueNotifier<String>(AppConfig.appName);
final ValueNotifier<String> brandSubtitle =
    ValueNotifier<String>(AppConfig.subtitle);
const MethodChannel nativeBridge = MethodChannel('edutrack/native');

Future<void> syncNativeBackgroundNotifications(ApiService api) async {
  if (!Platform.isAndroid || api.cookie.isEmpty) return;
  try {
    await nativeBridge.invokeMethod('scheduleBackgroundNotifications', {
      'baseUrl': AppConfig.baseUrl,
      'cookie': api.cookie,
      'fullname': api.fullname,
    });
  } catch (_) {}
}

Future<void> cancelNativeBackgroundNotifications() async {
  if (!Platform.isAndroid) return;
  try {
    await nativeBridge.invokeMethod('cancelBackgroundNotifications');
  } catch (_) {}
}

void loadCachedBranding(SharedPreferences prefs) {
  final logo = prefs.getString('brand_logo');
  if (logo != null && logo.trim().isNotEmpty) brandLogoData.value = logo.trim();
  final schoolArt = prefs.getString('dashboard_school_art');
  if (schoolArt != null && schoolArt.trim().isNotEmpty) {
    dashboardSchoolArtData.value = schoolArt.trim();
  }
  final name = prefs.getString('brand_name');
  if (name != null && name.trim().isNotEmpty) brandName.value = name.trim();
  final sub = prefs.getString('brand_subtitle');
  if (sub != null && sub.trim().isNotEmpty) brandSubtitle.value = sub.trim();
}

Future<void> applyBrandingNames(
  Map<String, dynamic> data,
  SharedPreferences prefs,
) async {
  final name = '${data['system_name'] ?? ''}'.trim();
  if (name.isNotEmpty && name != brandName.value) {
    brandName.value = name;
    await prefs.setString('brand_name', name);
  }
  final sub = '${data['division_name'] ?? ''}'.trim();
  if (sub.isNotEmpty && sub != brandSubtitle.value) {
    brandSubtitle.value = sub;
    await prefs.setString('brand_subtitle', sub);
  }
}

Future<void> applyBranding(
  Map<String, dynamic> data,
  SharedPreferences prefs,
) async {
  if (data.containsKey('system_logo')) {
    final logo = '${data['system_logo'] ?? ''}'.trim();
    if (logo != (brandLogoData.value ?? '')) {
      brandLogoData.value = logo.isEmpty ? null : logo;
      if (logo.isEmpty) {
        await prefs.remove('brand_logo');
      } else {
        await prefs.setString('brand_logo', logo);
      }
    }
  }
  if (data.containsKey('mobile_dashboard_school_art')) {
    final art = '${data['mobile_dashboard_school_art'] ?? ''}'.trim();
    if (art != (dashboardSchoolArtData.value ?? '')) {
      dashboardSchoolArtData.value = art.isEmpty ? null : art;
      if (art.isEmpty) {
        await prefs.remove('dashboard_school_art');
      } else {
        await prefs.setString('dashboard_school_art', art);
      }
    }
  }
  if (data.containsKey('ai_report_icon')) {
    final icon = '${data['ai_report_icon'] ?? ''}'.trim();
    if (icon.isEmpty) {
      await prefs.remove('ai_report_icon');
    } else {
      await prefs.setString('ai_report_icon', icon);
    }
  }
  await applyBrandingNames(data, prefs);
}

// Keeps the header logo in sync cheaply: names update on every poll, but the
// heavy base64 logo is only re-fetched from /api/mobile-branding when its
// version actually changes (or has never been cached) — so changing the logo
// in the Admin Dashboard appears in the app without a reinstall and without
// re-downloading the image on every 5-second refresh.
Future<void> syncBranding(
  Map<String, dynamic> dashboard,
  ApiService api,
) async {
  await applyBrandingNames(dashboard, api.prefs);
  final version = '${dashboard['logo_version'] ?? ''}'.trim();
  final schoolArtVersion = '${dashboard['school_art_version'] ?? ''}'.trim();
  final aiIconVersion = '${dashboard['ai_report_icon_version'] ?? ''}'.trim();
  var shouldFetchBranding = false;
  if (version.isEmpty) {
    if (brandLogoData.value != null) {
      brandLogoData.value = null;
      await api.prefs.remove('brand_logo');
      await api.prefs.remove('brand_logo_version');
    }
  } else {
    final cachedVersion = api.prefs.getString('brand_logo_version') ?? '';
    shouldFetchBranding =
        shouldFetchBranding ||
        version != cachedVersion ||
        brandLogoData.value == null;
  }
  if (schoolArtVersion.isEmpty) {
    if (dashboardSchoolArtData.value != null) {
      dashboardSchoolArtData.value = null;
      await api.prefs.remove('dashboard_school_art');
      await api.prefs.remove('dashboard_school_art_version');
    }
  } else {
    final cachedArtVersion =
        api.prefs.getString('dashboard_school_art_version') ?? '';
    shouldFetchBranding =
        shouldFetchBranding ||
        schoolArtVersion != cachedArtVersion ||
        dashboardSchoolArtData.value == null;
  }
  if (aiIconVersion.isEmpty) {
    if ((api.prefs.getString('ai_report_icon') ?? '').isNotEmpty) {
      await api.prefs.remove('ai_report_icon');
      await api.prefs.remove('ai_report_icon_version');
    }
  } else {
    final cachedAiIconVersion =
        api.prefs.getString('ai_report_icon_version') ?? '';
    shouldFetchBranding =
        shouldFetchBranding ||
        aiIconVersion != cachedAiIconVersion ||
        (api.prefs.getString('ai_report_icon') ?? '').isEmpty;
  }
  if (!shouldFetchBranding) return;
  try {
    final branding = await api.map('/api/mobile-branding');
    await applyBranding(branding, api.prefs);
    if (version.isNotEmpty) {
      await api.prefs.setString('brand_logo_version', version);
    }
    if (schoolArtVersion.isNotEmpty) {
      await api.prefs.setString(
        'dashboard_school_art_version',
        schoolArtVersion,
      );
    }
    if (aiIconVersion.isNotEmpty) {
      await api.prefs.setString('ai_report_icon_version', aiIconVersion);
    }
  } on Exception {
    // Keep showing the cached logo on a network/auth hiccup; retry next poll.
  }
}

final notifications = FlutterLocalNotificationsPlugin();
final appNavigatorKey = GlobalKey<NavigatorState>();
String? startupNotificationPayload;
String? startupNotificationActionId;
Map<String, dynamic>? pendingAlertIntent;
const alertsChannel = AndroidNotificationChannel(
  'edutrack_alerts',
  'Edutrack Alerts',
  description: 'Attendance monitoring alerts',
  importance: Importance.high,
);
const dailySummaryChannel = AndroidNotificationChannel(
  'edutrack_daily_summary',
  'Daily Attendance Summary',
  description: 'Daily 7:00 PM attendance report for SDS/ASDS',
  importance: Importance.high,
);

// ---------------------------------------------------------------------------
// Firebase Cloud Messaging — instant push even when the app is fully closed.
// ---------------------------------------------------------------------------
@pragma('vm:entry-point')
Future<void> _fcmBackgroundHandler(RemoteMessage message) async {
  try {
    await Firebase.initializeApp();
  } catch (_) {/* already initialised */}
}

String gMainFcmToken = '';
DateTime? _lastMainFcmRegistration;
bool _registeringMainFcm = false;
const String _mainFcmTokenResetPreference = 'main_fcm_token_reset_v1';

Future<void> _registerMainDevice(
  SharedPreferences prefs,
  String token, {
  bool force = false,
}) async {
  final cookie = prefs.getString('cookie') ?? '';
  final cleanToken = token.trim();
  if (cookie.isEmpty || cleanToken.isEmpty || _registeringMainFcm) return;
  final now = DateTime.now();
  if (!force &&
      _lastMainFcmRegistration != null &&
      now.difference(_lastMainFcmRegistration!) < const Duration(minutes: 5)) {
    return;
  }
  _registeringMainFcm = true;
  try {
    final response = await http
        .post(
          Uri.parse('${AppConfig.baseUrl}/api/user-device-token'),
          headers: {'Content-Type': 'application/json', 'Cookie': cookie},
          body: jsonEncode({
            'push_token': cleanToken,
            'platform': Platform.isAndroid ? 'android' : Platform.operatingSystem,
          }),
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode == 200) _lastMainFcmRegistration = now;
  } catch (_) {
    // Retried after login and during dashboard refresh.
  } finally {
    _registeringMainFcm = false;
  }
}

Future<void> _setupMainFcm(SharedPreferences prefs) async {
  try {
    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission(alert: true, badge: true, sound: true);
    await messaging.setForegroundNotificationPresentationOptions(alert: true, badge: true, sound: true);
    // Refresh tokens created by older builds before closed-app FCM was fully
    // wired. This runs once and immediately re-registers the replacement token.
    if (prefs.getBool(_mainFcmTokenResetPreference) != true) {
      await messaging.deleteToken();
      await prefs.remove('fcm_token');
      await prefs.setBool(_mainFcmTokenResetPreference, true);
    }
    final token = await messaging.getToken();
    if (token != null && token.isNotEmpty) {
      gMainFcmToken = token;
      await prefs.setString('fcm_token', token);
      await _registerMainDevice(prefs, token, force: true);
    }
    messaging.onTokenRefresh.listen((t) {
      gMainFcmToken = t;
      prefs.setString('fcm_token', t);
      _registerMainDevice(prefs, t, force: true);
    });
    FirebaseMessaging.onMessage.listen((message) {
      final n = message.notification;
      final title = n?.title ?? '${message.data['title'] ?? 'EduTrack'}';
      final body = n?.body ?? '${message.data['body'] ?? ''}';
      if (title.isEmpty && body.isEmpty) return;
      notifications.show(
        DateTime.now().millisecondsSinceEpoch.remainder(100000),
        title,
        body,
        NotificationDetails(
          android: AndroidNotificationDetails(
            'edutrack_alerts',
            'Edutrack Alerts',
            importance: Importance.high,
            priority: Priority.high,
            icon: '@mipmap/ic_launcher',
            styleInformation: BigTextStyleInformation(
              '<b>$body</b>',
              htmlFormatBigText: true,
              contentTitle: '<b>$title</b>',
              htmlFormatContentTitle: true,
            ),
          ),
        ),
      );
    });
  } catch (e) {
    debugPrint('Main FCM setup failed: $e');
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  tz_data.initializeTimeZones();
  tz.setLocalLocation(tz.getLocation('Asia/Manila'));
  final prefs = await SharedPreferences.getInstance();
  loadCachedBranding(prefs);
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(_fcmBackgroundHandler);
  } catch (e) {
    debugPrint('Firebase init failed: $e');
  }
  await notifications.initialize(
    const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    ),
    onDidReceiveNotificationResponse: (response) {
      openNotificationDestination(
        response.payload,
        actionId: response.actionId,
      );
    },
  );
  final androidPlugin = notifications
      .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
  await androidPlugin?.createNotificationChannel(alertsChannel);
  await androidPlugin?.createNotificationChannel(dailySummaryChannel);
  unawaited(_setupMainFcm(prefs));
  final launchDetails = await notifications.getNotificationAppLaunchDetails();
  if (launchDetails?.didNotificationLaunchApp == true) {
    startupNotificationPayload = launchDetails?.notificationResponse?.payload;
    startupNotificationActionId = launchDetails?.notificationResponse?.actionId;
    pendingAlertIntent = notificationIntentFromPayload(
      startupNotificationPayload,
      actionId: startupNotificationActionId,
    );
    if (pendingAlertIntent != null &&
        await launchContactActionFromIntent(pendingAlertIntent!)) {
      pendingAlertIntent = {...pendingAlertIntent!, 'action': 'handled'};
    }
  }
  runApp(const EdutrackApp());
}

class EdutrackApp extends StatelessWidget {
  const EdutrackApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: AppConfig.appName,
      navigatorKey: appNavigatorKey,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF138A64)),
        scaffoldBackgroundColor: const Color(0xFFF5F7F6),
        useMaterial3: true,
        navigationBarTheme: NavigationBarThemeData(
          backgroundColor: Colors.transparent,
          indicatorColor: const Color(0xFFEAF7F1),
          labelTextStyle: WidgetStateProperty.resolveWith(
            (states) => TextStyle(
              fontSize: 9.5,
              height: 1.08,
              fontWeight: states.contains(WidgetState.selected)
                  ? FontWeight.w900
                  : FontWeight.w700,
              color: states.contains(WidgetState.selected)
                  ? const Color(0xFF0F6E52)
                  : const Color(0xFF6D7772),
            ),
          ),
          iconTheme: WidgetStateProperty.resolveWith(
            (states) => IconThemeData(
              color: states.contains(WidgetState.selected)
                  ? const Color(0xFF138A64)
                  : const Color(0xFF6D7772),
            ),
          ),
        ),
      ),
      home: const SplashGate(),
    );
  }
}

class ApiService {
  ApiService(this.prefs);
  final SharedPreferences prefs;

  String get cookie => prefs.getString('cookie') ?? '';
  String get fullname => prefs.getString('fullname') ?? 'Division User';
  String get role => prefs.getString('role') ?? 'division';
  bool get isSuperAdmin => role == 'super_admin';
  bool get isLoggedIn => cookie.isNotEmpty;

  Map<String, String> get authHeaders => {
    'Accept': 'application/json',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    if (cookie.isNotEmpty) 'Cookie': cookie,
  };

  Uri liveUri(String path) {
    final base = Uri.parse('${AppConfig.baseUrl}$path');
    return base.replace(
      queryParameters: {
        ...base.queryParameters,
        '_': DateTime.now().millisecondsSinceEpoch.toString(),
      },
    );
  }

  Future<http.Response> _request(
    Future<http.Response> Function() runner,
  ) async {
    try {
      return await runner().timeout(const Duration(seconds: 18));
    } on SocketException {
      throw Exception(AppConfig.noInternetMessage);
    } on TimeoutException {
      throw Exception(AppConfig.noInternetMessage);
    } on http.ClientException catch (e) {
      final lower = e.message.toLowerCase();
      if (lower.contains('socketexception') ||
          lower.contains('timed out') ||
          lower.contains('connection') ||
          lower.contains('failed host lookup')) {
        throw Exception(AppConfig.noInternetMessage);
      }
      throw Exception('Unable to connect to server right now.');
    }
  }

  String _errorFromBody(String body, {required String fallback}) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map) {
        final msg = '${decoded['message'] ?? decoded['error'] ?? ''}'.trim();
        if (msg.isNotEmpty) return msg;
      }
    } catch (_) {}
    final raw = body.trim();
    if (raw.isEmpty || raw.length > 260) return fallback;
    return raw;
  }

  bool _looksLikeHtml(http.Response response) {
    final contentType = (response.headers['content-type'] ?? '').toLowerCase();
    final body = response.body.trimLeft().toLowerCase();
    return contentType.contains('text/html') ||
        body.startsWith('<!doctype html') ||
        body.startsWith('<html');
  }

  Map<String, dynamic> _decodeJsonMap(
    http.Response response, {
    required String fallback,
  }) {
    if (_looksLikeHtml(response)) {
      throw AuthExpired();
    }
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
      throw Exception(fallback);
    } catch (_) {
      throw Exception(_errorFromBody(response.body, fallback: fallback));
    }
  }

  List<dynamic> _decodeJsonList(
    http.Response response, {
    required String fallback,
  }) {
    if (_looksLikeHtml(response)) {
      throw AuthExpired();
    }
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is List) return decoded;
      return [];
    } catch (_) {
      throw Exception(_errorFromBody(response.body, fallback: fallback));
    }
  }

  Future<void> login(String username, String password) async {
    final response = await _request(
      () => http.post(
        Uri.parse('${AppConfig.baseUrl}/app-login'),
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {'username': username, 'password': password},
      ),
    );
    final data = _decodeJsonMap(
      response,
      fallback: 'Unable to sign in right now. Please try again.',
    );
    if (response.statusCode >= 400 || data['success'] != true) {
      throw Exception(
        _errorFromBody(
          response.body,
          fallback: 'Username or password is incorrect.',
        ),
      );
    }
    final sessionCookie = (response.headers['set-cookie'] ?? '')
        .split(';')
        .first
        .trim();
    if (sessionCookie.isEmpty) {
      throw Exception('Server did not return a session cookie.');
    }
    final user = (data['user'] as Map?) ?? {};
    await prefs.setString('cookie', sessionCookie);
    await prefs.setString('fullname', '${user['fullname'] ?? username}');
    await prefs.setString('role', '${user['role'] ?? 'division'}');
    await syncNativeBackgroundNotifications(this);
  }

  Future<void> logout() async {
    await cancelNativeBackgroundNotifications();
    await prefs.remove('cookie');
    await prefs.remove('fullname');
    await prefs.remove('role');
    await prefs.remove('last_absence_key');
  }

  Future<Map<String, dynamic>> map(String path) async {
    final response = await _request(
      () => http.get(
        liveUri(path),
        headers: authHeaders,
      ),
    );
    if (response.statusCode == 401) throw AuthExpired();
    if (response.statusCode >= 400) {
      throw Exception(
        _errorFromBody(
          response.body,
          fallback: 'Failed to load live data from the server.',
        ),
      );
    }
    return _decodeJsonMap(
      response,
      fallback: 'Server returned an invalid response format.',
    );
  }

  Future<List<dynamic>> list(String path) async {
    final response = await _request(
      () => http.get(
        liveUri(path),
        headers: authHeaders,
      ),
    );
    if (response.statusCode == 401) throw AuthExpired();
    if (response.statusCode >= 400) {
      throw Exception(
        _errorFromBody(
          response.body,
          fallback: 'Failed to load live data from the server.',
        ),
      );
    }
    return _decodeJsonList(
      response,
      fallback: 'Server returned an invalid response format.',
    );
  }

  Future<Map<String, dynamic>> putJson(
    String path,
    Map<String, dynamic> body,
  ) async {
    final response = await _request(
      () => http.put(
        Uri.parse('${AppConfig.baseUrl}$path'),
        headers: {...authHeaders, 'Content-Type': 'application/json'},
        body: jsonEncode(body),
      ),
    );
    if (response.statusCode == 401) throw AuthExpired();
    if (response.statusCode >= 400) {
      throw Exception(
        _errorFromBody(
          response.body,
          fallback: 'Failed to update the selected record.',
        ),
      );
    }
    return _decodeJsonMap(
      response,
      fallback: 'Server returned an invalid response format.',
    );
  }

  Future<Map<String, dynamic>> postJson(
    String path,
    Map<String, dynamic> body,
  ) async {
    final response = await _request(
      () => http.post(
        Uri.parse('${AppConfig.baseUrl}$path'),
        headers: {...authHeaders, 'Content-Type': 'application/json'},
        body: jsonEncode(body),
      ),
    );
    if (response.statusCode == 401) throw AuthExpired();
    if (response.statusCode >= 400) {
      throw Exception(
        _errorFromBody(
          response.body,
          fallback: 'Failed to create the selected record.',
        ),
      );
    }
    return _decodeJsonMap(
      response,
      fallback: 'Server returned an invalid response format.',
    );
  }

  Future<Map<String, dynamic>> deleteJson(String path) async {
    final response = await _request(
      () => http.delete(
        Uri.parse('${AppConfig.baseUrl}$path'),
        headers: authHeaders,
      ),
    );
    if (response.statusCode == 401) throw AuthExpired();
    if (response.statusCode >= 400) {
      throw Exception(
        _errorFromBody(
          response.body,
          fallback: 'Failed to remove the selected record.',
        ),
      );
    }
    return _decodeJsonMap(
      response,
      fallback: 'Server returned an invalid response format.',
    );
  }
}

class AuthExpired implements Exception {}

class SplashGate extends StatefulWidget {
  const SplashGate({super.key});

  @override
  State<SplashGate> createState() => _SplashGateState();
}

class _SplashGateState extends State<SplashGate>
    with SingleTickerProviderStateMixin {
  late final AnimationController controller;
  double progress = 0;

  @override
  void initState() {
    super.initState();
    controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 4),
    )..repeat(reverse: true);
    Timer.periodic(const Duration(milliseconds: 30), (timer) async {
      if (!mounted) return timer.cancel();
      setState(() => progress = math.min(1, progress + .014));
      if (progress >= 1) {
        timer.cancel();
        final api = ApiService(await SharedPreferences.getInstance());
        if (!mounted) return;
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(
            builder: (_) => api.isLoggedIn
                ? HomeShell(
                    api: api,
                    initialTab: pendingAlertIntent == null ? 0 : 4,
                    initialAlertIntent: pendingAlertIntent,
                  )
                : LoginScreen(api: api),
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
        builder: (context, child) => CustomPaint(
          painter: LiveMeshPainter(
            controller.value,
            intensity: .42,
            focusY: .36,
          ),
          child: Stack(
            children: [
              SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(30),
                  child: Column(
                    children: [
                      const Spacer(),
                      Stack(
                        alignment: Alignment.center,
                        children: [
                          PulseRing(value: controller.value, size: 148),
                          const AppLogo(size: 96),
                        ],
                      ),
                      const SizedBox(height: 30),
                      const Text(
                        AppConfig.appName,
                        style: TextStyle(
                          fontSize: 38,
                          color: Color(0xFF12201B),
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        AppConfig.subtitle,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: Color(0xFF4D5D56),
                          fontSize: 16,
                        ),
                      ),
                      const SizedBox(height: 42),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 18,
                          vertical: 10,
                        ),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: .88),
                          borderRadius: BorderRadius.circular(99),
                          border: Border.all(color: const Color(0xFFDCE7E1)),
                        ),
                        child: const Text(
                          AppConfig.monitoringLabel,
                          style: TextStyle(
                            color: Color(0xFF0F6E52),
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                      const Spacer(),
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: .94),
                          borderRadius: BorderRadius.circular(22),
                          border: Border.all(color: const Color(0xFFDCE7E1)),
                        ),
                        child: Column(
                          children: [
                            Row(
                              children: [
                                const LiveDot(color: Color(0xFFE53935)),
                                const SizedBox(width: 8),
                                const Text(
                                  'CONNECTING TO SERVER',
                                  style: TextStyle(
                                    color: Color(0xFF33423C),
                                    fontWeight: FontWeight.w900,
                                    letterSpacing: 1.1,
                                  ),
                                ),
                                const Spacer(),
                                Text(
                                  '${(progress * 100).round()}%',
                                  style: const TextStyle(
                                    color: Color(0xFF0F6E52),
                                    fontWeight: FontWeight.w900,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            ClipRRect(
                              borderRadius: BorderRadius.circular(99),
                              child: LinearProgressIndicator(
                                value: progress,
                                minHeight: 10,
                                backgroundColor: const Color(0xFFE5EFEA),
                                color: const Color(0xFF138A64),
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
}

class PulseRing extends StatelessWidget {
  const PulseRing({super.key, required this.value, required this.size});
  final double value;
  final double size;

  @override
  Widget build(BuildContext context) {
    final pulse = .6 + (math.sin(value * math.pi * 2) + 1) / 2;
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: PulseRingPainter(pulse)),
    );
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
        ..color = Colors.white.withValues(alpha: (.22 - i * .045) * pulse);
      canvas.drawCircle(center, radius, paint);
    }
  }

  @override
  bool shouldRepaint(PulseRingPainter oldDelegate) =>
      oldDelegate.pulse != pulse;
}

class LiveDot extends StatefulWidget {
  const LiveDot({
    super.key,
    this.color = Colors.white,
    this.pulse = true,
    this.size = 8,
  });
  final Color color;
  final bool pulse;
  final double size;

  @override
  State<LiveDot> createState() => _LiveDotState();
}

class _LiveDotState extends State<LiveDot> with SingleTickerProviderStateMixin {
  late final AnimationController controller;

  @override
  void initState() {
    super.initState();
    controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hostSize = widget.size + 12;
    if (!widget.pulse) {
      return SizedBox(
        width: hostSize,
        height: hostSize,
        child: Center(
          child: _dot(
            widget.size,
            widget.color,
            widget.color.withValues(alpha: .35),
          ),
        ),
      );
    }
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
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: widget.color.withValues(alpha: .12),
                  ),
                ),
              ),
              _dot(
                widget.size,
                widget.color,
                widget.color.withValues(alpha: .55),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _dot(double size, Color fill, Color glow) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: fill,
      shape: BoxShape.circle,
      boxShadow: [BoxShadow(color: glow, blurRadius: 10)],
    ),
  );
}

class LiveMeshPainter extends CustomPainter {
  LiveMeshPainter(
    this.value, {
    this.intensity = .5,
    this.lightMode = false,
    this.focusY,
  });
  final double value;
  final double intensity;
  final bool lightMode;
  final double? focusY;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final base = Paint()
      ..color = lightMode ? const Color(0xFFF5F7F6) : const Color(0xFFEDF7F1);
    canvas.drawRect(rect, base);

    void blob(Color color, Offset center, double radius) {
      final paint = Paint()
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 42)
        ..color = color.withValues(alpha: intensity);
      canvas.drawCircle(center, radius, paint);
    }

    final t = value * math.pi * 2;
    blob(
      Colors.white,
      Offset(size.width * (.08 + .025 * math.sin(t)), size.height * .17),
      size.width * .36,
    );
    blob(
      const Color(0xFFF3FBF7),
      Offset(size.width * (.88 + .025 * math.cos(t)), size.height * .34),
      size.width * .40,
    );
    blob(
      const Color(0xFFD4F2E5),
      Offset(size.width * (.48 + .02 * math.sin(t * 1.2)), size.height * .90),
      size.width * .34,
    );
    blob(
      const Color(0xFFE8F8F1),
      Offset(size.width * (.66 + .02 * math.cos(t * 1.6)), size.height * .08),
      size.width * .28,
    );

    final ringPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = (lightMode ? const Color(0xFF138A64) : const Color(0xFF138A64))
          .withValues(alpha: .045 + intensity * .04);
    final radarCenter = Offset(size.width * .50, size.height * (focusY ?? .30));
    for (var i = 0; i < 5; i++) {
      final radius = size.width * (.12 + i * .055) + math.sin(t) * 2;
      canvas.drawCircle(radarCenter, radius, ringPaint);
    }

    final facetPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = (lightMode ? const Color(0xFF138A64) : const Color(0xFF138A64))
          .withValues(alpha: .055 + intensity * .035);
    final fillFacet = Paint()
      ..style = PaintingStyle.fill
      ..color = Colors.white.withValues(alpha: lightMode ? .20 : .16);

    for (var i = 0; i < 5; i++) {
      final x = size.width * (.08 + i * .22) + math.sin(t + i) * 5;
      final y = size.height * (.18 + (i % 3) * .22) + math.cos(t * .8 + i) * 5;
      final w = size.width * (.16 + (i % 2) * .04);
      final path = Path()
        ..moveTo(x, y)
        ..lineTo(x + w * .55, y - w * .18)
        ..lineTo(x + w, y + w * .38)
        ..lineTo(x + w * .28, y + w * .72)
        ..close();
      canvas.drawPath(path, fillFacet);
      canvas.drawPath(path, facetPaint);
    }
  }

  @override
  bool shouldRepaint(LiveMeshPainter oldDelegate) =>
      oldDelegate.value != value ||
      oldDelegate.intensity != intensity ||
      oldDelegate.lightMode != lightMode ||
      oldDelegate.focusY != focusY;
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.api});
  final ApiService api;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen>
    with SingleTickerProviderStateMixin {
  final username = TextEditingController();
  final password = TextEditingController();
  late final AnimationController backgroundController;
  bool loading = false;
  bool obscurePassword = true;
  String? error;

  @override
  void initState() {
    super.initState();
    backgroundController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 8),
    )..repeat();
  }

  @override
  void dispose() {
    backgroundController.dispose();
    username.dispose();
    password.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (username.text.trim().isEmpty || password.text.isEmpty) {
      setState(() => error = 'Enter username and password.');
      return;
    }
    setState(() {
      loading = true;
      error = null;
    });
    try {
      await widget.api.login(username.text.trim(), password.text);
      final fcmToken = widget.api.prefs.getString('fcm_token') ?? gMainFcmToken;
      unawaited(_registerMainDevice(widget.api.prefs, fcmToken, force: true));
      await showLocalNotification(
        'WELCOME',
        '${greeting()}, ${widget.api.fullname}',
        showToast: false,
      );
      if (!mounted) return;
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) => HomeShell(
            api: widget.api,
            initialTab: pendingAlertIntent == null ? 0 : 4,
            initialAlertIntent: pendingAlertIntent,
          ),
        ),
      );
    } catch (e) {
      setState(() {
        loading = false;
        error = readableError(
          e,
          fallback: 'Unable to sign in. Please check your account details.',
        );
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return Scaffold(
      resizeToAvoidBottomInset: true,
      backgroundColor: const Color(0xFFEEF8F3),
      body: AnimatedBuilder(
        animation: backgroundController,
        builder: (context, child) => CustomPaint(
          painter: LiveMeshPainter(
            backgroundController.value,
            intensity: .10,
            lightMode: true,
          ),
          child: child,
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              padding: EdgeInsets.fromLTRB(20, 28, 20, math.max(28, bottomInset + 24)),
              child: Container(
                width: 420,
                constraints: const BoxConstraints(maxWidth: 420),
                padding: const EdgeInsets.fromLTRB(28, 34, 28, 26),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(22),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: .08),
                      blurRadius: 40,
                      offset: const Offset(0, 8),
                    ),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Center(child: AppLogo(size: 76)),
                    const SizedBox(height: 14),
                    const Text(
                      AppConfig.appName,
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 23, fontWeight: FontWeight.w900, color: Color(0xFF111827)),
                    ),
                    const SizedBox(height: 3),
                    const Text(
                      'Attendance Portal',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 13, color: Color(0xFF6B7280), fontWeight: FontWeight.w700),
                    ),
                    if (error != null) ...[
                      const SizedBox(height: 18),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFEF2F2),
                          border: Border.all(color: const Color(0xFFFECACA)),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.error_outline, color: Color(0xFFDC2626), size: 18),
                            const SizedBox(width: 8),
                            Expanded(child: Text(error!, style: const TextStyle(color: Color(0xFFDC2626), fontSize: 12.5, fontWeight: FontWeight.w700))),
                          ],
                        ),
                      ),
                    ],
                    const SizedBox(height: 22),
                    _label('Username'),
                    _field(username, 'Enter your username', icon: Icons.person_outline_rounded),
                    const SizedBox(height: 14),
                    _label('Password'),
                    _field(
                      password,
                      'Enter your password',
                      secret: obscurePassword,
                      isPassword: true,
                      icon: Icons.lock_outline_rounded,
                      onToggleSecret: () => setState(() => obscurePassword = !obscurePassword),
                    ),
                    const SizedBox(height: 20),
                    SizedBox(
                      width: double.infinity,
                      height: 50,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          gradient: const LinearGradient(colors: [Color(0xFF16A34A), Color(0xFF059669)]),
                          borderRadius: BorderRadius.circular(12),
                          boxShadow: [
                            BoxShadow(
                              color: const Color(0xFF16A34A).withValues(alpha: .30),
                              blurRadius: 14,
                              offset: const Offset(0, 6),
                            ),
                          ],
                        ),
                        child: ElevatedButton(
                          onPressed: loading ? null : submit,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.transparent,
                            shadowColor: Colors.transparent,
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          ),
                          child: loading
                              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                              : const Text('Sign In', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 16)),
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    const Text(
                      'For authorized EduTrack users only',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Color(0xFF9CA3AF), fontSize: 11.5, fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _label(String value) => Padding(
    padding: const EdgeInsets.only(bottom: 8, left: 2),
    child: Text(
      value.toUpperCase(),
      style: const TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w800,
        color: Color(0xFF6B7280),
        letterSpacing: .4,
      ),
    ),
  );

  Widget _field(
    TextEditingController controller,
    String hint, {
    bool secret = false,
    bool isPassword = false,
    required IconData icon,
    VoidCallback? onToggleSecret,
  }) => TextField(
    controller: controller,
    obscureText: secret,
    textInputAction: isPassword ? TextInputAction.done : TextInputAction.next,
    onSubmitted: (_) => isPassword ? submit() : null,
    decoration: InputDecoration(
      hintText: hint,
      hintStyle: const TextStyle(color: Color(0xFF9CA3AF), fontSize: 13.5),
      prefixIcon: Icon(icon, color: const Color(0xFF6B7280), size: 20),
      suffixIcon: onToggleSecret == null
          ? null
          : IconButton(
              onPressed: onToggleSecret,
              icon: Icon(secret ? Icons.visibility_off_rounded : Icons.visibility_rounded, color: const Color(0xFF6B7280), size: 20),
            ),
      filled: true,
      fillColor: Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 15),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Color(0xFFD1D5DB), width: 1.5),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Color(0xFF16A34A), width: 1.6),
      ),
    ),
  );
}

class HomeShell extends StatefulWidget {
  const HomeShell({
    super.key,
    required this.api,
    this.initialTab = 0,
    this.initialAlertIntent,
  });
  final ApiService api;
  final int initialTab;
  final Map<String, dynamic>? initialAlertIntent;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell>
    with SingleTickerProviderStateMixin {
  late int tab;
  Map<String, dynamic> dashboard = {};
  List<dynamic> flags = [];
  bool loading = true;
  String? error;
  Timer? timer;
  late final AnimationController backgroundController;
  Map<String, dynamic>? alertIntent;
  bool headerCompact = false;

  @override
  void initState() {
    super.initState();
    tab = widget.initialTab.clamp(0, widget.api.isSuperAdmin ? 5 : 4).toInt();
    alertIntent = widget.initialAlertIntent;
    backgroundController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 9),
    )..repeat();
    load();
    scheduleDailyFallbackNotification();
    syncNativeBackgroundNotifications(widget.api);
    // Poll often so edited student and absence details show quickly.
    timer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => load(silent: true),
    );
  }

  @override
  void dispose() {
    timer?.cancel();
    backgroundController.dispose();
    super.dispose();
  }

  Future<void> load({bool silent = false}) async {
    if (!silent) setState(() => loading = true);
    try {
      final results = await Future.wait([
        widget.api.map(
          '/api/dashboard-data?date=${date()}&_=${DateTime.now().millisecondsSinceEpoch}',
        ),
        widget.api.list('/api/absence-flags?days=2&include_teachers=0'),
      ]);
      dashboard = results[0] as Map<String, dynamic>;
      flags = results[1] as List<dynamic>;
      await syncBranding(dashboard, widget.api);
      await notifyAbsenceFlags(flags, widget.api.prefs);
      await checkAndShowEveningReport(dashboard, widget.api.prefs);
      final fcmToken = widget.api.prefs.getString('fcm_token') ?? gMainFcmToken;
      unawaited(_registerMainDevice(widget.api.prefs, fcmToken));
      if (mounted) {
        setState(() {
          loading = false;
          error = null;
        });
      }
    } on AuthExpired {
      await widget.api.logout();
      if (mounted) {
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(builder: (_) => LoginScreen(api: widget.api)),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          loading = false;
          error = readableError(
            e,
            fallback: 'Failed to sync dashboard data from the server.',
          );
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final pages = <Widget>[
      DashboardPage(
        api: widget.api,
        dashboard: dashboard,
        flags: flags,
        loading: loading,
        error: error,
        onRefresh: load,
        onOpenTab: (value) => setState(() => tab = value.clamp(0, 4).toInt()),
        onTestReport: () => testEveningReportNotification(dashboard, widget.api.prefs),
      ),
      AttendancePage(api: widget.api),
      SchoolsPage(api: widget.api),
      ReportsPage(api: widget.api),
      AlertsPage(
        flags: flags,
        notificationIntent: alertIntent,
        onIntentConsumed: () => setState(() {
          alertIntent = null;
          pendingAlertIntent = null;
        }),
      ),
    ];
    final destinations = <NavigationDestination>[
      const NavigationDestination(
        icon: Icon(Icons.dashboard_customize_rounded),
        label: 'Home',
      ),
      const NavigationDestination(
        icon: Icon(Icons.fact_check_rounded),
        label: 'Attendance',
      ),
      const NavigationDestination(
        icon: Icon(Icons.account_balance_rounded),
        label: 'Schools',
      ),
      const NavigationDestination(
        icon: Icon(Icons.insert_chart_rounded),
        label: 'Report',
      ),
      const NavigationDestination(
        icon: Icon(Icons.notifications_active_rounded),
        label: 'Alerts',
      ),
    ];
    if (widget.api.isSuperAdmin) {
      pages.add(SuperAdminControlPage(api: widget.api));
      destinations.add(
        const NavigationDestination(
          icon: Icon(Icons.admin_panel_settings_rounded),
          label: 'Control',
        ),
      );
    }
    final selectedTab = tab.clamp(0, pages.length - 1).toInt();
    return Scaffold(
      backgroundColor: const Color(0xFFF5F7F6),
      body: AnimatedBuilder(
        animation: backgroundController,
        builder: (context, child) => CustomPaint(
          painter: LiveMeshPainter(
            backgroundController.value,
            intensity: .13,
            lightMode: true,
          ),
          child: child,
        ),
        child: Column(
          children: [
            Header(
              api: widget.api,
              compact: headerCompact,
              onLogout: () async {
                final navigator = Navigator.of(context);
                await widget.api.logout();
                if (mounted) {
                  navigator.pushReplacement(
                    MaterialPageRoute(
                      builder: (_) => LoginScreen(api: widget.api),
                    ),
                  );
                }
              },
            ),
            Expanded(
              child: NotificationListener<ScrollNotification>(
                onNotification: (notification) {
                  if (notification.metrics.axis != Axis.vertical) {
                    return false;
                  }
                  final compact = notification.metrics.pixels > 24;
                  if (compact != headerCompact) {
                    setState(() => headerCompact = compact);
                  }
                  return false;
                },
                child: AnimatedSwitcher(
                  duration: const Duration(milliseconds: 250),
                  child: pages[selectedTab],
                ),
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: ClipRRect(
        borderRadius: const BorderRadius.only(
          topLeft: Radius.circular(26),
          topRight: Radius.circular(26),
        ),
        child: BackdropFilter(
          filter: ui.ImageFilter.blur(sigmaX: 18, sigmaY: 18),
          child: Container(
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: .86),
              border: Border(top: const BorderSide(color: Color(0xFFE2E9E5))),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF111827).withValues(alpha: .08),
                  blurRadius: 24,
                  offset: const Offset(0, -8),
                ),
              ],
            ),
            child: SafeArea(
              top: false,
              child: NavigationBar(
                height: 76,
                labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
                backgroundColor: Colors.transparent,
                selectedIndex: selectedTab,
                onDestinationSelected: (value) => setState(() => tab = value),
                destinations: destinations,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class SuperAdminControlPage extends StatefulWidget {
  const SuperAdminControlPage({super.key, required this.api});
  final ApiService api;

  @override
  State<SuperAdminControlPage> createState() => _SuperAdminControlPageState();
}

class _SuperAdminControlPageState extends State<SuperAdminControlPage> {
  Map<String, dynamic> dashboard = {};
  List<dynamic> users = [];
  List<dynamic> holidays = [];
  bool loading = true;
  bool saving = false;
  String? error;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    load();
    timer = Timer.periodic(
      const Duration(seconds: 12),
      (_) => load(silent: true),
    );
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Future<void> load({bool silent = false}) async {
    if (!silent && mounted) {
      setState(() => loading = true);
    }
    try {
      final results = await Future.wait([
        widget.api.map(
          '/api/dashboard-data?date=${date()}&_=${DateTime.now().millisecondsSinceEpoch}',
        ),
        widget.api.list('/api/users'),
        widget.api.list('/api/holidays'),
      ]);
      if (!mounted) return;
      setState(() {
        dashboard = results[0] as Map<String, dynamic>;
        users = results[1] as List<dynamic>;
        holidays = results[2] as List<dynamic>;
        loading = false;
        error = null;
      });
    } on AuthExpired {
      await widget.api.logout();
      if (mounted) {
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(builder: (_) => LoginScreen(api: widget.api)),
        );
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        loading = false;
        error = readableError(
          e,
          fallback: 'Failed to load Super Admin controls.',
        );
      });
    }
  }

  Future<void> updateUser(String id, Map<String, dynamic> body) async {
    if (id.trim().isEmpty || saving) return;
    setState(() => saving = true);
    try {
      await widget.api.putJson('/api/users/$id', body);
      await load(silent: true);
      if (!mounted) return;
      Navigator.pop(context);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Account updated.')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            readableError(e, fallback: 'Unable to update this account.'),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Future<void> deleteUser(Map user) async {
    final id = '${user['id'] ?? ''}'.trim();
    if (id.isEmpty || saving) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Delete account'),
        content: Text(
          'Delete ${user['fullname'] ?? user['username'] ?? 'this account'}?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFFB91C1C),
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => saving = true);
    try {
      await widget.api.deleteJson('/api/users/$id');
      await load(silent: true);
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Account deleted.')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            readableError(e, fallback: 'Unable to update this account.'),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Future<void> createUser(Map<String, dynamic> body) async {
    if (saving) return;
    setState(() => saving = true);
    try {
      await widget.api.postJson('/api/users', body);
      await load(silent: true);
      if (!mounted) return;
      Navigator.pop(context);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Admin account created.')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            readableError(e, fallback: 'Unable to create admin account.'),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Future<void> createHoliday(Map<String, dynamic> body) async {
    if (saving) return;
    setState(() => saving = true);
    try {
      final delivery = await widget.api.postJson('/api/holidays', body);
      await load(silent: true);
      if (!mounted) return;
      Navigator.pop(context);
      final guardianPushes = (delivery['guardian_push_count'] as num?)?.toInt() ?? 0;
      final edutrackPushes = (delivery['edutrack_push_count'] as num?)?.toInt() ?? 0;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Holiday saved • $guardianPushes Guardian push${guardianPushes == 1 ? '' : 'es'} • '
            '$edutrackPushes EduTrack push${edutrackPushes == 1 ? '' : 'es'}',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(readableError(e, fallback: 'Unable to save holiday.')),
        ),
      );
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Future<void> deleteHoliday(Map holiday) async {
    final id = '${holiday['id'] ?? ''}'.trim();
    if (id.isEmpty || saving) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Remove holiday'),
        content: Text('Remove ${holiday['name'] ?? 'this holiday'}?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => saving = true);
    try {
      await widget.api.deleteJson('/api/holidays/$id');
      await load(silent: true);
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Holiday removed.')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            readableError(e, fallback: 'Unable to remove holiday.'),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  void openCreateUserSheet() {
    final schools = (dashboard['schools'] as List?) ?? const [];
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => AdminAccountFormSheet(
        schools: schools,
        saving: saving,
        onSubmit: createUser,
      ),
    );
  }

  void openEditUserSheet(Map<String, dynamic> user) {
    final schools = (dashboard['schools'] as List?) ?? const [];
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => AdminAccountFormSheet(
        schools: schools,
        saving: saving,
        initialUser: user,
        onSubmit: (body) => updateUser('${user['id'] ?? ''}', body),
      ),
    );
  }

  void openHolidaySheet() {
    final schools = (dashboard['schools'] as List?) ?? const [];
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => HolidayFormSheet(
        schools: schools,
        saving: saving,
        onSubmit: createHoliday,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (loading && dashboard.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (error != null && dashboard.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Text(
            error!,
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Color(0xFFB91C1C),
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () => load(silent: false),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
        children: [
          PremiumCard(
            padding: const EdgeInsets.all(20),
            child: Row(
              children: [
                Container(
                  width: 54,
                  height: 54,
                  decoration: BoxDecoration(
                    color: const Color(0xFF0F6E52),
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: const Icon(
                    Icons.admin_panel_settings_rounded,
                    color: Colors.white,
                    size: 28,
                  ),
                ),
                const SizedBox(width: 14),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Super Admin Control',
                        style: TextStyle(
                          fontSize: 24,
                          fontWeight: FontWeight.w900,
                          letterSpacing: -.5,
                        ),
                      ),
                      Text(
                        'Account Management and Holiday Management only.',
                        style: TextStyle(
                          color: Color(0xFF667872),
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                ),
                const LiveDot(color: Color(0xFFFF3B30)),
              ],
            ),
          ),
          const SizedBox(height: 14),
          PremiumCard(
            title: 'Holiday Management',
            subtitle:
                'Add or remove holidays excluded from attendance calculations.',
            child: Column(
              children: [
                AdminActionButton(
                  icon: Icons.add_circle_rounded,
                  label: 'Add Holiday',
                  onTap: saving ? null : openHolidaySheet,
                ),
                const SizedBox(height: 12),
                for (final item in holidays.take(8))
                  HolidayRow(
                    Map<String, dynamic>.from(item),
                    onDelete: saving
                        ? null
                        : () => deleteHoliday(Map<String, dynamic>.from(item)),
                  ),
                if (holidays.isEmpty)
                  const EmptyText('No holidays configured.'),
              ],
            ),
          ),
          const SizedBox(height: 14),
          PremiumCard(
            title: 'Account Management',
            subtitle: 'Add, edit, and delete administrator accounts.',
            child: Column(
              children: [
                AdminActionButton(
                  icon: Icons.person_add_rounded,
                  label: 'Add Admin Account',
                  onTap: saving ? null : openCreateUserSheet,
                ),
                const SizedBox(height: 12),
                for (final item
                    in users
                        .where(
                          (row) =>
                              '${(row as Map)['status'] ?? 'active'}'
                                  .toLowerCase() ==
                              'active',
                        )
                        .take(10))
                  UserControlTile(
                    user: Map<String, dynamic>.from(item as Map),
                    busy: saving,
                    onEdit: openEditUserSheet,
                    onDelete: deleteUser,
                  ),
                if (users
                    .where(
                      (row) =>
                          '${(row as Map)['status'] ?? 'active'}'
                              .toLowerCase() ==
                          'active',
                    )
                    .isEmpty)
                  const EmptyText('No active user accounts found.'),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class AdminModuleTile extends StatelessWidget {
  const AdminModuleTile({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
  });
  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 10),
    padding: const EdgeInsets.all(13),
    decoration: BoxDecoration(
      color: const Color(0xFFF8FBF9),
      borderRadius: BorderRadius.circular(18),
      border: Border.all(color: const Color(0xFFE2ECE6)),
    ),
    child: Row(
      children: [
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            color: const Color(0xFFE5F7EF),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Icon(icon, color: const Color(0xFF0F6E52), size: 22),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  color: Color(0xFF0F211B),
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: const TextStyle(
                  color: Color(0xFF64726B),
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class AdminActionButton extends StatelessWidget {
  const AdminActionButton({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => FilledButton.icon(
    onPressed: onTap,
    icon: Icon(icon, size: 18),
    label: Text(
      label,
      textAlign: TextAlign.center,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
    ),
    style: FilledButton.styleFrom(
      backgroundColor: const Color(0xFF0F6E52),
      foregroundColor: Colors.white,
      minimumSize: const Size.fromHeight(48),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w900),
    ),
  );
}

class DangerActionButton extends StatelessWidget {
  const DangerActionButton({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => OutlinedButton.icon(
    onPressed: onTap,
    icon: Icon(icon, size: 18),
    label: Text(
      label,
      textAlign: TextAlign.center,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
    ),
    style: OutlinedButton.styleFrom(
      foregroundColor: const Color(0xFFB91C1C),
      side: const BorderSide(color: Color(0xFFF3B4B4)),
      minimumSize: const Size.fromHeight(48),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w900),
    ),
  );
}

class SettingInfoTile extends StatelessWidget {
  const SettingInfoTile({
    super.key,
    required this.icon,
    required this.label,
    required this.value,
  });
  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 10),
    padding: const EdgeInsets.all(13),
    decoration: BoxDecoration(
      color: const Color(0xFFF8FBF9),
      borderRadius: BorderRadius.circular(18),
      border: Border.all(color: const Color(0xFFE2ECE6)),
    ),
    child: Row(
      children: [
        Icon(icon, color: const Color(0xFF0F6E52), size: 22),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: const TextStyle(
                  color: Color(0xFF64726B),
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                value,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: Color(0xFF0F211B),
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class SettingMiniCard extends StatelessWidget {
  const SettingMiniCard({
    super.key,
    required this.label,
    required this.value,
    this.color = const Color(0xFF0F6E52),
  });
  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minHeight: 74),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: const Color(0xFFF8FBF9),
      borderRadius: BorderRadius.circular(18),
      border: Border.all(color: const Color(0xFFE2ECE6)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            color: Color(0xFF64726B),
            fontSize: 10.5,
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 5),
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: color,
            fontSize: 17,
            fontWeight: FontWeight.w900,
            letterSpacing: -.2,
          ),
        ),
      ],
    ),
  );
}

class StatusCountTile extends StatelessWidget {
  const StatusCountTile({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    this.color = const Color(0xFF0F6E52),
  });
  final String label;
  final int value;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minHeight: 82),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .06),
      borderRadius: BorderRadius.circular(18),
      border: Border.all(color: color.withValues(alpha: .18)),
    ),
    child: Row(
      children: [
        Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            color: color.withValues(alpha: .12),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Icon(icon, color: color, size: 21),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                '$value',
                style: const TextStyle(
                  color: Color(0xFF0F211B),
                  fontSize: 22,
                  height: 1,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                label,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: Color(0xFF64726B),
                  fontSize: 10.5,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class MobileSettingsFormSheet extends StatefulWidget {
  const MobileSettingsFormSheet({
    super.key,
    required this.settings,
    required this.saving,
    required this.onSubmit,
  });
  final Map<String, dynamic> settings;
  final bool saving;
  final Future<void> Function(Map<String, dynamic> body) onSubmit;

  @override
  State<MobileSettingsFormSheet> createState() =>
      _MobileSettingsFormSheetState();
}

class _MobileSettingsFormSheetState extends State<MobileSettingsFormSheet> {
  late final TextEditingController systemName;
  late final TextEditingController divisionName;
  late final TextEditingController amTimeInEnd;
  late final TextEditingController amTimeOutUntil;
  late final TextEditingController pmTimeInStart;
  late final TextEditingController pmTimeOutEnd;
  late final TextEditingController lateThreshold;
  late final TextEditingController autoTimeout;
  bool smsEnabled = true;
  bool autoActivate = true;
  bool submitting = false;

  @override
  void initState() {
    super.initState();
    systemName = TextEditingController(
      text: settingValue(widget.settings, 'system_name', AppConfig.appName),
    );
    divisionName = TextEditingController(
      text: settingValue(widget.settings, 'division_name', AppConfig.subtitle),
    );
    amTimeInEnd = TextEditingController(
      text: settingTime(widget.settings, 'am_time_in_end', fallback: '08:00'),
    );
    amTimeOutUntil = TextEditingController(
      text: settingTime(
        widget.settings,
        'am_time_out_until',
        fallback: '12:00',
      ),
    );
    pmTimeInStart = TextEditingController(
      text: settingTime(widget.settings, 'pm_time_in_start', fallback: '13:00'),
    );
    pmTimeOutEnd = TextEditingController(
      text: settingTime(widget.settings, 'pm_time_out_end', fallback: '17:00'),
    );
    lateThreshold = TextEditingController(
      text: settingValue(widget.settings, 'late_threshold', '15'),
    );
    autoTimeout = TextEditingController(
      text: settingValue(widget.settings, 'auto_timeout', '480'),
    );
    smsEnabled = settingEnabled(widget.settings, 'sms_enabled', fallback: true);
    autoActivate = settingEnabled(
      widget.settings,
      'auto_activate_on_scan',
      fallback: true,
    );
  }

  @override
  void dispose() {
    systemName.dispose();
    divisionName.dispose();
    amTimeInEnd.dispose();
    amTimeOutUntil.dispose();
    pmTimeInStart.dispose();
    pmTimeOutEnd.dispose();
    lateThreshold.dispose();
    autoTimeout.dispose();
    super.dispose();
  }

  bool validTime(String value) =>
      RegExp(r'^\d{2}:\d{2}$').hasMatch(value.trim());

  Future<void> submit() async {
    if (submitting) return;
    final times = [
      amTimeInEnd.text,
      amTimeOutUntil.text,
      pmTimeInStart.text,
      pmTimeOutEnd.text,
    ];
    if (systemName.text.trim().isEmpty || divisionName.text.trim().isEmpty) {
      showLocalMessage('System name and division name are required.');
      return;
    }
    if (times.any((item) => !validTime(item))) {
      showLocalMessage('Please use HH:mm format for time windows.');
      return;
    }
    if (int.tryParse(lateThreshold.text.trim()) == null ||
        int.tryParse(autoTimeout.text.trim()) == null) {
      showLocalMessage('Late threshold and auto time-out must be numbers.');
      return;
    }
    setState(() => submitting = true);
    await widget.onSubmit({
      'system_name': systemName.text.trim(),
      'division_name': divisionName.text.trim(),
      'am_time_in_end': amTimeInEnd.text.trim(),
      'am_time_out_until': amTimeOutUntil.text.trim(),
      'pm_time_in_start': pmTimeInStart.text.trim(),
      'pm_time_out_end': pmTimeOutEnd.text.trim(),
      'late_threshold': lateThreshold.text.trim(),
      'auto_timeout': autoTimeout.text.trim(),
      'sms_enabled': smsEnabled ? '1' : '0',
      'auto_activate_on_scan': autoActivate ? '1' : '0',
    });
    if (mounted) setState(() => submitting = false);
  }

  void showLocalMessage(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    return AdminFormShell(
      title: 'Settings',
      subtitle: 'Edit the same system rules used by the web Settings page.',
      bottomInset: bottom,
      child: Column(
        children: [
          AdminTextInput(
            controller: systemName,
            label: 'System Name',
            icon: Icons.badge_rounded,
          ),
          AdminTextInput(
            controller: divisionName,
            label: 'Division Name',
            icon: Icons.apartment_rounded,
          ),
          Row(
            children: [
              Expanded(
                child: AdminTextInput(
                  controller: amTimeInEnd,
                  label: 'AM Time In End',
                  icon: Icons.login_rounded,
                  keyboardType: TextInputType.datetime,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: AdminTextInput(
                  controller: amTimeOutUntil,
                  label: 'AM Time Out Until',
                  icon: Icons.logout_rounded,
                  keyboardType: TextInputType.datetime,
                ),
              ),
            ],
          ),
          Row(
            children: [
              Expanded(
                child: AdminTextInput(
                  controller: pmTimeInStart,
                  label: 'PM Time In Start',
                  icon: Icons.login_rounded,
                  keyboardType: TextInputType.datetime,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: AdminTextInput(
                  controller: pmTimeOutEnd,
                  label: 'PM Time Out End',
                  icon: Icons.logout_rounded,
                  keyboardType: TextInputType.datetime,
                ),
              ),
            ],
          ),
          Row(
            children: [
              Expanded(
                child: AdminTextInput(
                  controller: lateThreshold,
                  label: 'Late Threshold',
                  icon: Icons.timer_rounded,
                  keyboardType: TextInputType.number,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: AdminTextInput(
                  controller: autoTimeout,
                  label: 'Auto Time-Out',
                  icon: Icons.av_timer_rounded,
                  keyboardType: TextInputType.number,
                ),
              ),
            ],
          ),
          DropdownButtonFormField<bool>(
            initialValue: smsEnabled,
            decoration: adminInputDecoration(
              'SMS Notifications',
              Icons.sms_rounded,
            ),
            items: const [
              DropdownMenuItem(value: true, child: Text('Enabled')),
              DropdownMenuItem(value: false, child: Text('Disabled')),
            ],
            onChanged: (value) => setState(() => smsEnabled = value ?? true),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<bool>(
            initialValue: autoActivate,
            decoration: adminInputDecoration(
              'Auto-Activate on First Scan',
              Icons.verified_user_rounded,
            ),
            items: const [
              DropdownMenuItem(value: true, child: Text('Enabled')),
              DropdownMenuItem(value: false, child: Text('Disabled')),
            ],
            onChanged: (value) => setState(() => autoActivate = value ?? true),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: submitting || widget.saving ? null : submit,
            icon: submitting || widget.saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save_rounded),
            label: const Text('Save Settings'),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF0F6E52),
              foregroundColor: Colors.white,
              minimumSize: const Size.fromHeight(50),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class AdminAccountFormSheet extends StatefulWidget {
  const AdminAccountFormSheet({
    super.key,
    required this.schools,
    required this.saving,
    required this.onSubmit,
    this.initialUser,
  });
  final List schools;
  final bool saving;
  final Future<void> Function(Map<String, dynamic> body) onSubmit;
  final Map<String, dynamic>? initialUser;

  @override
  State<AdminAccountFormSheet> createState() => _AdminAccountFormSheetState();
}

class _AdminAccountFormSheetState extends State<AdminAccountFormSheet> {
  final username = TextEditingController();
  final fullname = TextEditingController();
  final email = TextEditingController();
  final password = TextEditingController();
  String role = 'principal';
  int? schoolId;
  bool submitting = false;
  bool get editing => widget.initialUser != null;

  @override
  void initState() {
    super.initState();
    final user = widget.initialUser;
    if (user != null) {
      username.text = '${user['username'] ?? ''}';
      fullname.text = '${user['fullname'] ?? ''}';
      email.text = '${user['email'] ?? ''}';
      role = '${user['role'] ?? 'principal'}';
      final cleanSchoolId = intValue(user['school_id']);
      schoolId = cleanSchoolId > 0 ? cleanSchoolId : null;
    }
  }

  @override
  void dispose() {
    username.dispose();
    fullname.dispose();
    email.dispose();
    password.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (submitting) return;
    final cleanUsername = username.text.trim();
    final cleanName = fullname.text.trim();
    final cleanPassword = password.text.trim();
    if (cleanUsername.isEmpty || cleanName.isEmpty) {
      showLocalMessage('Username and full name are required.');
      return;
    }
    if (!editing && cleanPassword.isEmpty) {
      showLocalMessage('Password is required for a new account.');
      return;
    }
    if (role == 'principal' && schoolId == null) {
      showLocalMessage(
        'School Administrator accounts must be assigned to a school.',
      );
      return;
    }
    setState(() => submitting = true);
    final body = <String, dynamic>{
      'username': cleanUsername,
      'fullname': cleanName,
      'email': email.text.trim(),
      'role': role,
      'school_id': role == 'principal' ? schoolId : null,
      'status': 'active',
    };
    if (cleanPassword.isNotEmpty) {
      body['password'] = cleanPassword;
    }
    await widget.onSubmit(body);
    if (mounted) setState(() => submitting = false);
  }

  void showLocalMessage(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    return AdminFormShell(
      title: editing ? 'Edit Admin Account' : 'Add Admin Account',
      subtitle: editing
          ? 'Update account details, role, school assignment, or password.'
          : 'Add a role-based login account for the Edutrack system.',
      bottomInset: bottom,
      child: Column(
        children: [
          AdminTextInput(
            controller: username,
            label: 'Username',
            icon: Icons.person_rounded,
          ),
          AdminTextInput(
            controller: fullname,
            label: 'Full Name',
            icon: Icons.badge_rounded,
          ),
          AdminTextInput(
            controller: email,
            label: 'Email Address',
            icon: Icons.email_rounded,
            keyboardType: TextInputType.emailAddress,
          ),
          AdminTextInput(
            controller: password,
            label: editing ? 'New Password (optional)' : 'Temporary Password',
            icon: Icons.lock_rounded,
            obscure: true,
          ),
          DropdownButtonFormField<String>(
            initialValue: role,
            decoration: adminInputDecoration(
              'Role',
              Icons.admin_panel_settings_rounded,
            ),
            items: const [
              DropdownMenuItem(
                value: 'principal',
                child: Text('School Administrator'),
              ),
              DropdownMenuItem(
                value: 'super_admin',
                child: Text('Super Administrator'),
              ),
              DropdownMenuItem(
                value: 'superintendent',
                child: Text('SDS View Only'),
              ),
              DropdownMenuItem(
                value: 'asst_superintendent',
                child: Text('ASDS View Only'),
              ),
            ],
            onChanged: (value) => setState(() {
              role = value ?? 'principal';
              if (role != 'principal') schoolId = null;
            }),
          ),
          const SizedBox(height: 12),
          if (role == 'principal')
            DropdownButtonFormField<int>(
              initialValue: schoolId,
              decoration: adminInputDecoration(
                'Assigned School',
                Icons.account_balance_rounded,
              ),
              items: [
                for (final item in widget.schools)
                  DropdownMenuItem<int>(
                    value: intValue((item as Map)['id']),
                    child: Text(
                      '${item['name'] ?? 'School'}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: (value) => setState(() => schoolId = value),
            ),
          if (role == 'principal') const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: submitting || widget.saving ? null : submit,
            icon: submitting || widget.saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.person_add_alt_1_rounded),
            label: Text(editing ? 'Save Changes' : 'Create Account'),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF0F6E52),
              foregroundColor: Colors.white,
              minimumSize: const Size.fromHeight(50),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class HolidayFormSheet extends StatefulWidget {
  const HolidayFormSheet({
    super.key,
    required this.schools,
    required this.saving,
    required this.onSubmit,
  });
  final List schools;
  final bool saving;
  final Future<void> Function(Map<String, dynamic> body) onSubmit;

  @override
  State<HolidayFormSheet> createState() => _HolidayFormSheetState();
}

class _HolidayFormSheetState extends State<HolidayFormSheet> {
  final name = TextEditingController();
  String holidayDate = date();
  int holidayType = 1;
  int? schoolId;
  bool submitting = false;

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  Future<void> pickDate() async {
    final current = DateTime.tryParse(holidayDate) ?? DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: current,
      firstDate: DateTime(2020),
      lastDate: DateTime(2035),
    );
    if (picked == null) return;
    setState(() {
      holidayDate =
          '${picked.year.toString().padLeft(4, '0')}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}';
    });
  }

  Future<void> submit() async {
    if (submitting) return;
    if (name.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Holiday name is required.')),
      );
      return;
    }
    setState(() => submitting = true);
    await widget.onSubmit({
      'name': name.text.trim(),
      'holiday_date': holidayDate,
      'is_national': holidayType,
      'school_id': holidayType == 2 ? schoolId : null,
    });
    if (mounted) setState(() => submitting = false);
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    return AdminFormShell(
      title: 'Add Holiday',
      subtitle:
          'Manage holidays and non-school days excluded from attendance calculations.',
      bottomInset: bottom,
      child: Column(
        children: [
          AdminTextInput(
            controller: name,
            label: 'Holiday Name',
            icon: Icons.event_rounded,
          ),
          InkWell(
            onTap: pickDate,
            borderRadius: BorderRadius.circular(16),
            child: InputDecorator(
              decoration: adminInputDecoration(
                'Holiday Date',
                Icons.calendar_month_rounded,
              ),
              child: Text(
                '$holidayDate - ${readableDate(holidayDate)}',
                style: const TextStyle(fontWeight: FontWeight.w800),
              ),
            ),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<int>(
            initialValue: holidayType,
            decoration: adminInputDecoration(
              'Holiday Type',
              Icons.flag_rounded,
            ),
            items: const [
              DropdownMenuItem(value: 1, child: Text('Regular Holiday')),
              DropdownMenuItem(value: 0, child: Text('Special Non-Working')),
              DropdownMenuItem(value: 2, child: Text('Class Suspension')),
            ],
            onChanged: (value) => setState(() {
              holidayType = value ?? 1;
              if (holidayType != 2) schoolId = null;
            }),
          ),
          const SizedBox(height: 12),
          if (holidayType == 2)
            DropdownButtonFormField<int>(
              initialValue: schoolId,
              decoration: adminInputDecoration(
                'School',
                Icons.account_balance_rounded,
              ),
              items: [
                for (final item in widget.schools)
                  DropdownMenuItem<int>(
                    value: intValue((item as Map)['id']),
                    child: Text(
                      '${item['name'] ?? 'School'}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: (value) => setState(() => schoolId = value),
            ),
          if (holidayType == 2) const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: submitting || widget.saving ? null : submit,
            icon: submitting || widget.saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.add_circle_rounded),
            label: const Text('Save Holiday'),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF0F6E52),
              foregroundColor: Colors.white,
              minimumSize: const Size.fromHeight(50),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class AdminFormShell extends StatelessWidget {
  const AdminFormShell({
    super.key,
    required this.title,
    required this.subtitle,
    required this.child,
    required this.bottomInset,
  });
  final String title;
  final String subtitle;
  final Widget child;
  final double bottomInset;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(bottom: bottomInset),
    child: Container(
      decoration: const BoxDecoration(
        color: Color(0xFFF5F7F6),
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Center(
                child: Container(
                  width: 44,
                  height: 4,
                  decoration: BoxDecoration(
                    color: const Color(0xFFCAD5CF),
                    borderRadius: BorderRadius.circular(99),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                title,
                style: const TextStyle(
                  color: Color(0xFF0F211B),
                  fontSize: 22,
                  fontWeight: FontWeight.w900,
                  letterSpacing: -.35,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                subtitle,
                style: const TextStyle(
                  color: Color(0xFF64726B),
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 16),
              child,
            ],
          ),
        ),
      ),
    ),
  );
}

class AdminTextInput extends StatelessWidget {
  const AdminTextInput({
    super.key,
    required this.controller,
    required this.label,
    required this.icon,
    this.obscure = false,
    this.keyboardType,
  });
  final TextEditingController controller;
  final String label;
  final IconData icon;
  final bool obscure;
  final TextInputType? keyboardType;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextField(
      controller: controller,
      obscureText: obscure,
      keyboardType: keyboardType,
      decoration: adminInputDecoration(label, icon),
    ),
  );
}

InputDecoration adminInputDecoration(String label, IconData icon) =>
    InputDecoration(
      labelText: label,
      prefixIcon: Icon(icon, color: const Color(0xFF0F6E52)),
      filled: true,
      fillColor: Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(16)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: const BorderSide(color: Color(0xFFDCE6E1)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: const BorderSide(color: Color(0xFF0F6E52), width: 1.5),
      ),
    );

class UserControlTile extends StatelessWidget {
  const UserControlTile({
    super.key,
    required this.user,
    required this.busy,
    required this.onEdit,
    required this.onDelete,
  });
  final Map<String, dynamic> user;
  final bool busy;
  final void Function(Map<String, dynamic> user) onEdit;
  final Future<void> Function(Map user) onDelete;

  @override
  Widget build(BuildContext context) {
    final status = '${user['status'] ?? 'active'}'.toLowerCase();
    final active = status == 'active';
    final role = roleLabel('${user['role'] ?? ''}');
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: active ? const Color(0xFFF8FBF9) : const Color(0xFFFFF7F7),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: active ? const Color(0xFFE2ECE6) : const Color(0xFFF6C8C8),
        ),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 21,
            backgroundColor: active
                ? const Color(0xFFE5F7EF)
                : const Color(0xFFFEE2E2),
            child: Text(
              initials('${user['fullname'] ?? user['username'] ?? 'U'}'),
              style: TextStyle(
                color: active
                    ? const Color(0xFF0F6E52)
                    : const Color(0xFFB91C1C),
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${user['fullname'] ?? user['username'] ?? 'User'}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF0F211B),
                    fontWeight: FontWeight.w900,
                  ),
                ),
                Text(
                  '$role - ${active ? 'Active' : 'Inactive'}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF64726B),
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Wrap(
            spacing: 4,
            children: [
              IconButton(
                tooltip: 'Edit',
                onPressed: busy ? null : () => onEdit(user),
                style: IconButton.styleFrom(
                  backgroundColor: const Color(0xFFEAF7F1),
                  foregroundColor: const Color(0xFF0F6E52),
                  fixedSize: const Size(38, 38),
                ),
                icon: const Icon(Icons.edit_rounded, size: 18),
              ),
              IconButton(
                tooltip: 'Delete',
                onPressed: busy ? null : () => onDelete(user),
                style: IconButton.styleFrom(
                  backgroundColor: const Color(0xFFFEE2E2),
                  foregroundColor: const Color(0xFFB91C1C),
                  fixedSize: const Size(38, 38),
                ),
                icon: const Icon(Icons.delete_rounded, size: 18),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class HolidayRow extends StatelessWidget {
  const HolidayRow(this.row, {super.key, this.onDelete});
  final Map<String, dynamic> row;
  final VoidCallback? onDelete;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 10),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: const Color(0xFFFFFBEB),
      borderRadius: BorderRadius.circular(17),
      border: Border.all(color: const Color(0xFFF7D57A)),
    ),
    child: Row(
      children: [
        const Icon(Icons.event_busy_rounded, color: Color(0xFFE78300)),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${row['name'] ?? 'Holiday'}',
                style: const TextStyle(fontWeight: FontWeight.w900),
              ),
              Text(
                readableDate('${row['holiday_date'] ?? ''}'),
                style: const TextStyle(
                  color: Color(0xFF736044),
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
        if (onDelete != null)
          IconButton(
            onPressed: onDelete,
            icon: const Icon(Icons.delete_outline_rounded),
            color: const Color(0xFFB91C1C),
            tooltip: 'Remove holiday',
          ),
      ],
    ),
  );
}

class ActivityRow extends StatelessWidget {
  const ActivityRow(this.row, {super.key});
  final Map<String, dynamic> row;

  @override
  Widget build(BuildContext context) {
    final actor = '${row['fullname'] ?? row['username'] ?? 'System user'}';
    final action =
        '${row['action'] ?? row['activity'] ?? row['description'] ?? 'Activity recorded'}';
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FBF9),
        borderRadius: BorderRadius.circular(17),
        border: Border.all(color: const Color(0xFFE2ECE6)),
      ),
      child: Row(
        children: [
          const Icon(Icons.history_rounded, color: Color(0xFF0F6E52)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  actor,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w900),
                ),
                Text(
                  action,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF64726B),
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class Header extends StatelessWidget {
  const Header({
    super.key,
    required this.api,
    required this.onLogout,
    this.compact = false,
  });
  final ApiService api;
  final VoidCallback onLogout;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final logoSize = compact ? 42.0 : 52.0;
    final titleSize = compact ? 17.0 : 20.0;
    final subtitleSize = compact ? 10.5 : 11.5;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      width: double.infinity,
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          colors: [Color(0xFF0C5A3C), Color(0xFF14855A), Color(0xFF0D6347)],
          stops: [0.0, 0.52, 1.0],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.vertical(bottom: Radius.circular(26)),
        boxShadow: [
          BoxShadow(
            color: Color(0x330C5A3C),
            blurRadius: 16,
            offset: Offset(0, 6),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius:
            const BorderRadius.vertical(bottom: Radius.circular(26)),
        child: Stack(
          children: [
            Positioned.fill(
              child: CustomPaint(painter: _HeaderPatternPainter()),
            ),
            Positioned(
              right: 14,
              bottom: compact ? -34 : -18,
              child: Icon(
                Icons.school_rounded,
                size: compact ? 78 : 104,
                color: Colors.white.withValues(alpha: .06),
              ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(
                16,
                MediaQuery.paddingOf(context).top + (compact ? 6 : 10),
                16,
                compact ? 9 : 16,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      _seal(logoSize),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            ValueListenableBuilder<String>(
                              valueListenable: brandName,
                              builder: (context, value, _) => Text(
                                value,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: Colors.white,
                                  fontSize: titleSize,
                                  fontWeight: FontWeight.w900,
                                  letterSpacing: -.2,
                                ),
                              ),
                            ),
                            const SizedBox(height: 2),
                            ValueListenableBuilder<String>(
                              valueListenable: brandSubtitle,
                              builder: (context, value, _) => Text(
                                value,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: Colors.white.withValues(alpha: .85),
                                  fontSize: subtitleSize,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 10),
                      _headerAction(
                        icon: Icons.logout_rounded,
                        onTap: onLogout,
                      ),
                    ],
                  ),
                  AnimatedSize(
                    duration: const Duration(milliseconds: 220),
                    curve: Curves.easeOutCubic,
                    child: compact
                        ? const SizedBox.shrink()
                        : Column(
                            children: [
                              const SizedBox(height: 14),
                              Row(
                                children: [
                                  _chip(
                                    Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: const [
                                        LiveDot(
                                          color: Color(0xFFFF3B30),
                                          size: 9,
                                        ),
                                        SizedBox(width: 6),
                                        Text(
                                          'LIVE',
                                          style: TextStyle(
                                            color: Color(0xFFE5403A),
                                            fontWeight: FontWeight.w900,
                                            fontSize: 11.5,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  _chip(Text(shortDate()), dense: true),
                                  const SizedBox(width: 8),
                                  Flexible(
                                    child: _chip(Text(date()), dense: true),
                                  ),
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
      boxShadow: [
        BoxShadow(
          color: const Color(0xFF06301F).withValues(alpha: .28),
          blurRadius: 12,
          offset: const Offset(0, 4),
        ),
      ],
    ),
    child: const ClipOval(child: BrandLogoImage()),
  );

  Widget _headerAction({
    required IconData icon,
    required VoidCallback onTap,
  }) => Material(
    color: Colors.white.withValues(alpha: .14),
    borderRadius: BorderRadius.circular(14),
    child: InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: onTap,
      child: SizedBox(
        width: 44,
        height: 44,
        child: Icon(icon, size: 20, color: Colors.white),
      ),
    ),
  );

  Widget _chip(Widget child, {bool dense = false}) => Container(
    padding: EdgeInsets.symmetric(
      horizontal: dense ? 11 : 13,
      vertical: dense ? 8 : 9,
    ),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(13),
      boxShadow: [
        BoxShadow(
          color: const Color(0xFF06301F).withValues(alpha: .14),
          blurRadius: 10,
          offset: const Offset(0, 4),
        ),
      ],
    ),
    child: DefaultTextStyle(
      style: const TextStyle(
        color: Color(0xFF0F6E52),
        fontWeight: FontWeight.w900,
        fontSize: 11.5,
      ),
      child: child,
    ),
  );
}

// Subtle dot-grid pattern for the header, faded toward the bottom edge.
class _HeaderPatternPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    const gap = 15.0;
    const radius = 1.15;
    final paint = Paint();
    for (double y = 10; y < size.height; y += gap) {
      final fade = (1 - (y / size.height)).clamp(0.0, 1.0);
      paint.color = Colors.white.withValues(alpha: 0.14 * fade);
      for (double x = 10; x < size.width; x += gap) {
        canvas.drawCircle(Offset(x, y), radius, paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _HeaderPatternPainter oldDelegate) => false;
}

class DashboardPage extends StatelessWidget {
  const DashboardPage({
    super.key,
    required this.api,
    required this.dashboard,
    required this.flags,
    required this.loading,
    required this.error,
    required this.onRefresh,
    required this.onOpenTab,
    this.onTestReport,
  });
  final ApiService api;
  final Map<String, dynamic> dashboard;
  final List<dynamic> flags;
  final bool loading;
  final String? error;
  final Future<void> Function({bool silent}) onRefresh;
  final ValueChanged<int> onOpenTab;
  final VoidCallback? onTestReport;

  @override
  Widget build(BuildContext context) {
    if (loading && dashboard.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (error != null && dashboard.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Text(
            readableError(
              error!,
              fallback: 'Failed to load dashboard data from the server.',
            ),
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Color(0xFFB91C1C),
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
      );
    }
    final active = intValue(
      dashboard['active_students'] ?? dashboard['total_students'],
    );
    final attendanceBase = intValue(
      dashboard['attendance_eligible_students'] ?? active,
    );
    final present = intValue(dashboard['students_present']);
    final absent = intValue(dashboard['students_absent']);
    final halfDay = intValue(dashboard['students_half_day']);
    final teachers = intValue(
      dashboard['active_teachers'] ?? dashboard['total_teachers'],
    );
    final flaggedFromDashboard = intValue(dashboard['flagged_absent_2day']);
    final flaggedCount = flaggedFromDashboard > 0
        ? flaggedFromDashboard
        : flags.length;
    final analyticsBase = attendanceBase > 0
        ? attendanceBase
        : (active > 0 ? active : present + absent);
    final rate = analyticsBase > 0
        ? clampPercent(((present / analyticsBase) * 100).round())
        : clampPercent(intValue(dashboard['attendance_rate']));
    final scoreColor = attendanceScoreColor(rate);
    final scoreLabel = attendanceScoreLabel(rate);
    final schools = (dashboard['schools'] as List?) ?? [];
    // Sort schools highest attendance rate first
    final sortedSchools = [...schools]
      ..sort((a, b) => intValue((b as Map)['rate'])
          .compareTo(intValue((a as Map)['rate'])));

    Future<void> openAbsentDetails({
      String? targetDate,
      String? title,
      bool isSchoolDay = true,
    }) async {
      final day = targetDate ?? date();
      if (!isSchoolDay) {
        if (!context.mounted) return;
        showDialog(
          context: context,
          builder: (_) => AlertDialog(
            title: const Text('No classes'),
            content: Text('No classes on ${readableDate(day)}.'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Close'),
              ),
            ],
          ),
        );
        return;
      }
      if (!context.mounted) return;
      await showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (_) => AbsentStudentsSheet(
          api: api,
          targetDate: day,
          title: title ?? 'Absent Students',
        ),
      );
    }

    Future<void> openAttendanceDetails(String tab) async {
      if (!context.mounted) return;
      await showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (_) => DateAttendanceModal(
          api: api,
          targetDate: date(),
          initialTab: tab,
        ),
      );
    }

    Future<void> openFlaggedStudents() async {
      if (!context.mounted) return;
      await showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (_) => FlaggedStudentsSheet(flags: flags),
      );
    }

    return RefreshIndicator(
      onRefresh: () => onRefresh(silent: false),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(28),
              border: Border.all(color: const Color(0xFFDCE6E1)),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF111827).withValues(alpha: .08),
                  blurRadius: 20,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            greeting(),
                            style: const TextStyle(
                              color: Color(0xFF4C5F57),
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 4),
                          FittedDashboardText(
                            api.fullname,
                            maxLines: 2,
                            minFontSize: 18,
                            maxFontSize: 30,
                            style: const TextStyle(
                              color: Color(0xFF111827),
                              fontWeight: FontWeight.w900,
                              height: 1.02,
                            ),
                          ),
                          const SizedBox(height: 8),
                          FittedDashboardText(
                            fullDate(),
                            maxLines: 1,
                            minFontSize: 10,
                            maxFontSize: 13,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: Color(0xFF5F6F69),
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    const DashboardSchoolArt(),
                  ],
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: KpiPill(
                        label: 'Students',
                        value: '$active',
                        icon: Icons.groups_rounded,
                        accent: const Color(0xFF138A64),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: KpiPill(
                        label: 'Teachers',
                        value: '$teachers',
                        icon: Icons.school_rounded,
                        accent: const Color(0xFF4F46E5),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: KpiPill(
                        label: '2-Day Flagged Students',
                        value: '$flaggedCount',
                        icon: Icons.warning_amber_rounded,
                        accent: const Color(0xFFDC2626),
                        onTap: openFlaggedStudents,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(28),
              border: Border.all(color: attendanceScoreSoftColor(rate)),
              boxShadow: [
                BoxShadow(
                  color: scoreColor.withValues(alpha: .10),
                  blurRadius: 18,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: Column(
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    AttendanceScoreRing(rate: rate, color: scoreColor),
                    const SizedBox(width: 18),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Today Analytics',
                            style: TextStyle(
                              fontSize: 21,
                              fontWeight: FontWeight.w900,
                              letterSpacing: -.4,
                            ),
                          ),
                          const SizedBox(height: 7),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 5,
                            ),
                            decoration: BoxDecoration(
                              color: attendanceScoreSoftColor(rate),
                              borderRadius: BorderRadius.circular(999),
                            ),
                            child: Text(
                              scoreLabel,
                              style: TextStyle(
                                color: scoreColor,
                                fontSize: 11,
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                          ),
                          const SizedBox(height: 10),
                          Text(
                            halfDay > 0
                                ? '$present of $analyticsBase students attended - $halfDay half-day'
                                : '$present of $analyticsBase students present',
                            style: const TextStyle(
                              fontWeight: FontWeight.w900,
                              color: Color(0xFF1F2A26),
                              height: 1.25,
                            ),
                          ),
                          const SizedBox(height: 12),
                          RateBar(
                            'Live Attendance Rate (Half-Day counted)',
                            rate,
                            color: scoreColor,
                          ),
                          const SizedBox(height: 2),
                          InkWell(
                            borderRadius: BorderRadius.circular(8),
                            onTap: () => openAbsentDetails(
                              title: 'Absent Students Today',
                            ),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(vertical: 4),
                              child: Text(
                                absent == 1
                                    ? '1 student absent'
                                    : '$absent students absent',
                                style: const TextStyle(
                                  color: Color(0xFF74827E),
                                  fontSize: 12,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: AnalyticsMetric(
                        label: 'Total Students',
                        value: '$analyticsBase',
                        color: const Color(0xFF138A64),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: AnalyticsMetric(
                        label: halfDay > 0
                            ? 'Attended Students'
                            : 'Present Students',
                        value: '$present',
                        color: const Color(0xFF138A64),
                        onTap: () => openAttendanceDetails('present'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: AnalyticsMetric(
                        label: 'Absent Students',
                        value: '$absent',
                        color: const Color(0xFFDC2626),
                        onTap: () =>
                            openAbsentDetails(title: 'Absent Students Today'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: AnalyticsMetric(
                        label: 'Half-Day',
                        value: '$halfDay',
                        color: const Color(0xFFEA580C),
                        onTap: () => openAttendanceDetails('half_day'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          if (dashboard['is_school_day'] == false) ...[
            const SizedBox(height: 12),
            AlertStrip(
              '${fullDate()}: ${safeReason(dashboard['non_school_day_reason'])}',
            ),
          ],
          const SizedBox(height: 16),
          PremiumCard(
            title: 'Weekly Absence Analytics',
            subtitle: 'Absent students per day (Mon-Fri)',
            child: Column(
              children: [
                WeeklyAbsenceAnalytics(
                  api: api,
                  onDayTap: (dayDate, isSchoolDay) => openAbsentDetails(
                    targetDate: dayDate,
                    title: 'Absent Students - ${readableDate(dayDate)}',
                    isSchoolDay: isSchoolDay,
                  ),
                ),
                const SizedBox(height: 14),
                DailyAttendanceCalendar(api: api),
                if (sortedSchools.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  SchoolLeaderboard(schools: sortedSchools),
                ],
                if (onTestReport != null) ...[
                  const SizedBox(height: 24),
                  Center(
                    child: OutlinedButton.icon(
                      onPressed: onTestReport,
                      icon: const Icon(Icons.notifications_active_outlined, size: 15),
                      label: const Text('Test 7PM Notification'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFF6B7280),
                        side: const BorderSide(color: Color(0xFFD1D5DB)),
                        textStyle: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                        ),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 8,
                        ),
                        minimumSize: Size.zero,
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class FittedDashboardText extends StatelessWidget {
  const FittedDashboardText(
    this.text, {
    super.key,
    required this.style,
    required this.maxLines,
    required this.minFontSize,
    required this.maxFontSize,
    this.overflow = TextOverflow.ellipsis,
  });

  final String text;
  final TextStyle style;
  final int maxLines;
  final double minFontSize;
  final double maxFontSize;
  final TextOverflow overflow;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
        builder: (context, constraints) {
          final width = constraints.maxWidth;
          var selectedSize = maxFontSize;
          if (width.isFinite && width > 0 && text.trim().isNotEmpty) {
            selectedSize = minFontSize;
            for (double size = maxFontSize; size >= minFontSize; size -= 1) {
              final painter = TextPainter(
                text: TextSpan(text: text, style: style.copyWith(fontSize: size)),
                maxLines: maxLines,
                textDirection: Directionality.of(context),
              )..layout(maxWidth: width);
              if (!painter.didExceedMaxLines) {
                selectedSize = size;
                break;
              }
            }
          }

          return Text(
            text,
            maxLines: maxLines,
            softWrap: true,
            overflow: overflow,
            style: style.copyWith(fontSize: selectedSize),
          );
        },
      );
}

class KpiPill extends StatelessWidget {
  const KpiPill({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    this.accent = const Color(0xFF138A64),
    this.onTap,
  });
  final String label;
  final String value;
  final IconData icon;
  final Color accent;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(16),
    child: Container(
      constraints: const BoxConstraints(minHeight: 88),
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: .07),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: accent.withValues(alpha: .18)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Container(
            width: 26,
            height: 26,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: .86),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: accent, size: 16),
          ),
          const SizedBox(height: 7),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 260),
            switchInCurve: Curves.easeOutCubic,
            switchOutCurve: Curves.easeInCubic,
            transitionBuilder: (child, animation) => FadeTransition(
              opacity: animation,
              child: SlideTransition(
                position: Tween<Offset>(
                  begin: const Offset(0, .18),
                  end: Offset.zero,
                ).animate(animation),
                child: child,
              ),
            ),
            child: Text(
              value,
              key: ValueKey(value),
              style: const TextStyle(
                color: Color(0xFF111827),
                fontSize: 20,
                fontWeight: FontWeight.w900,
                height: 1,
              ),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            label,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFF5C6E66),
              fontSize: 10.3,
              height: 1.08,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    ),
  );
}

class FlaggedStudentsSheet extends StatelessWidget {
  const FlaggedStudentsSheet({super.key, required this.flags});

  final List<dynamic> flags;

  @override
  Widget build(BuildContext context) {
    final rows = flags
        .map((item) => Map<String, dynamic>.from(item as Map))
        .toList();
    return DraggableScrollableSheet(
      initialChildSize: .82,
      minChildSize: .48,
      maxChildSize: .94,
      builder: (context, controller) => Container(
        decoration: const BoxDecoration(
          color: Color(0xFFF5F7F6),
          borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
        ),
        child: Column(
          children: [
            const SizedBox(height: 10),
            Container(
              width: 44,
              height: 4,
              decoration: BoxDecoration(
                color: const Color(0xFFCAD5CF),
                borderRadius: BorderRadius.circular(99),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 10, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          '2-Day Flagged Students',
                          style: TextStyle(
                            color: Color(0xFF0F1F1A),
                            fontSize: 20,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        Text(
                          rows.length == 1
                              ? '1 student needs adviser follow-up'
                              : '${rows.length} students need adviser follow-up',
                          style: const TextStyle(
                            color: Color(0xFF5F716B),
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            Expanded(
              child: rows.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Text(
                          'No 2-day flagged students detected.',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: Color(0xFF64726B),
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    )
                  : ListView(
                      controller: controller,
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                      children: [for (final row in rows) FlagTile(row)],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class AttendanceScoreRing extends StatelessWidget {
  const AttendanceScoreRing({
    super.key,
    required this.rate,
    required this.color,
  });

  final int rate;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final target = clampPercent(rate) / 100;
    return SizedBox(
      width: 132,
      height: 132,
      child: TweenAnimationBuilder<double>(
        tween: Tween<double>(begin: 0, end: target),
        duration: const Duration(milliseconds: 750),
        curve: Curves.easeOutCubic,
        builder: (context, value, _) {
          final displayRate = (value * 100).round();
          return CustomPaint(
            painter: RingPainter(value, color: color),
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    '$displayRate%',
                    style: TextStyle(
                      color: color,
                      fontSize: 32,
                      fontWeight: FontWeight.w900,
                      height: 1,
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'ATTENDANCE',
                    style: TextStyle(
                      fontSize: 10,
                      color: Color(0xFF5F716B),
                      fontWeight: FontWeight.w900,
                      letterSpacing: .8,
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class AnalyticsMetric extends StatelessWidget {
  const AnalyticsMetric({
    super.key,
    required this.label,
    required this.value,
    required this.color,
    this.onTap,
  });

  final String label;
  final String value;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(18),
    child: Container(
      constraints: const BoxConstraints(minHeight: 72),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .08),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: .18)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: color,
              fontSize: 20,
              fontWeight: FontWeight.w900,
              height: 1,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFF5C6E66),
              fontSize: 10.5,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    ),
  );
}

class WeeklyAbsenceAnalytics extends StatefulWidget {
  const WeeklyAbsenceAnalytics({
    super.key,
    required this.api,
    required this.onDayTap,
  });
  final ApiService api;
  final void Function(String dayDate, bool isSchoolDay) onDayTap;

  @override
  State<WeeklyAbsenceAnalytics> createState() => _WeeklyAbsenceAnalyticsState();
}

class _WeeklyAbsenceAnalyticsState extends State<WeeklyAbsenceAnalytics> {
  // Static cache: persists across rebuilds so data shows instantly on re-visit
  static final Map<String, List<Map<String, dynamic>>> _cache = {};

  bool loading = true;
  String? error;
  List<Map<String, dynamic>> week = [];
  Timer? timer;

  @override
  void initState() {
    super.initState();
    // Show cached data immediately (no spinner) if available
    final cacheKey = weekdayDatesOfWeek(date()).first;
    if (_cache.containsKey(cacheKey)) {
      week = _cache[cacheKey]!;
      loading = false;
    }
    load(silent: week.isNotEmpty);
    timer = Timer.periodic(
      const Duration(seconds: 90),
      (_) => load(silent: true),
    );
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Future<void> load({bool silent = false}) async {
    if (!silent) {
      setState(() {
        loading = true;
        error = null;
      });
    }
    try {
      final days = weekdayDatesOfWeek(date());
      // Single lightweight call returns all 5 weekday absent counts
      final data = await widget.api.map('/api/weekly-absence?date=${date()}');
      final rawWeek = (data['week'] as List?) ?? const [];
      // Index server results by date for safe lookup
      final byDate = <String, Map<String, dynamic>>{};
      for (final item in rawWeek) {
        if (item is Map) {
          byDate['${item['date']}'] = Map<String, dynamic>.from(item);
        }
      }
      final built = <Map<String, dynamic>>[];
      for (var i = 0; i < days.length; i++) {
        final server = byDate[days[i]];
        final isSchoolDay = server?['is_school_day'] == true;
        final absent = isSchoolDay ? intValue(server?['students_absent']) : 0;
        built.add({
          'date': days[i],
          'label': weekdayShort(days[i]),
          'day': dayOfMonth(days[i]),
          'isSchoolDay': isSchoolDay,
          'absent': absent,
        });
      }
      if (!mounted) return;
      // Save to cache keyed by Monday's date of this week
      final cacheKey = days.first;
      _cache[cacheKey] = built;
      setState(() {
        week = built;
        loading = false;
        error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        loading = false;
        error = readableError(
          e,
          fallback: 'Failed to load weekly absence analytics.',
        );
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (loading && week.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 26),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (error != null && week.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 14),
        child: Text(
          'Failed to load weekly absence analytics.',
          style: const TextStyle(
            color: Color(0xFFB91C1C),
            fontWeight: FontWeight.w700,
          ),
        ),
      );
    }
    final maxAbsent = week.fold<int>(1, (maxVal, d) {
      final value = intValue(d['absent']);
      return value > maxVal ? value : maxVal;
    });
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Tap a day to view absent students',
          style: TextStyle(
            color: Color(0xFF64726B),
            fontSize: 12,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 10),
        LayoutBuilder(
          builder: (context, constraints) {
            const tileGap = 6.0;
            final tileWidth = (constraints.maxWidth - (tileGap * 4)) / 5;
            final compact = tileWidth < 58;
            return Row(
              children: [
                for (var i = 0; i < week.length; i++) ...[
                  Expanded(
                    child: WeekDayAbsenceTile(
                      label: '${week[i]['label']}',
                      dayNumber: '${week[i]['day']}',
                      absent: intValue(week[i]['absent']),
                      isSchoolDay: week[i]['isSchoolDay'] == true,
                      maxAbsent: maxAbsent,
                      compact: compact,
                      onTap: () => widget.onDayTap(
                        '${week[i]['date']}',
                        week[i]['isSchoolDay'] == true,
                      ),
                    ),
                  ),
                  if (i < week.length - 1) const SizedBox(width: tileGap),
                ],
              ],
            );
          },
        ),
      ],
    );
  }
}

class WeekDayAbsenceTile extends StatelessWidget {
  const WeekDayAbsenceTile({
    super.key,
    required this.label,
    required this.dayNumber,
    required this.absent,
    required this.isSchoolDay,
    required this.maxAbsent,
    required this.compact,
    required this.onTap,
  });
  final String label;
  final String dayNumber;
  final int absent;
  final bool isSchoolDay;
  final int maxAbsent;
  final bool compact;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final normalized = isSchoolDay
        ? (absent / math.max(1, maxAbsent)).clamp(0.0, 1.0).toDouble()
        : 0.0;
    final trackHeight = compact ? 60.0 : 70.0;
    final minBarHeight = compact ? 10.0 : 12.0;
    final barHeight = isSchoolDay
        ? minBarHeight + ((trackHeight - minBarHeight) * normalized)
        : minBarHeight;
    final countLabel = isSchoolDay ? '$absent' : '-';
    final barWidth = compact ? 22.0 : 26.0;
    final accent = isSchoolDay
        ? const Color(0xFFDC2626)
        : const Color(0xFFB6C2BC);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        width: double.infinity,
        padding: EdgeInsets.fromLTRB(4, compact ? 8 : 10, 4, compact ? 8 : 10),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFFDCE6E1)),
          boxShadow: [
            BoxShadow(
              color: const Color(0xFF111827).withValues(alpha: .03),
              blurRadius: 10,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Column(
          children: [
            Text(
              label,
              style: TextStyle(
                fontSize: compact ? 10 : 11,
                color: const Color(0xFF64726B),
                fontWeight: FontWeight.w800,
              ),
            ),
            Text(
              dayNumber,
              style: TextStyle(
                fontSize: compact ? 12 : 13,
                color: const Color(0xFF1F2937),
                fontWeight: FontWeight.w900,
              ),
            ),
            SizedBox(height: compact ? 6 : 8),
            // Count badge — auto-sizes to 1, 2, or 3+ digits without overflow
            Container(
              constraints: const BoxConstraints(minWidth: 26),
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
              decoration: BoxDecoration(
                color: accent,
                borderRadius: BorderRadius.circular(99),
                boxShadow: isSchoolDay
                    ? [
                        BoxShadow(
                          color: accent.withValues(alpha: .25),
                          blurRadius: 6,
                          offset: const Offset(0, 2),
                        ),
                      ]
                    : null,
              ),
              alignment: Alignment.center,
              child: Text(
                countLabel,
                maxLines: 1,
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w900,
                  fontSize: 12,
                  height: 1,
                ),
              ),
            ),
            SizedBox(height: compact ? 6 : 8),
            // Pure proportional bar (no text inside)
            SizedBox(
              height: trackHeight,
              width: barWidth,
              child: Stack(
                alignment: Alignment.bottomCenter,
                children: [
                  Container(
                    width: barWidth,
                    height: trackHeight,
                    decoration: BoxDecoration(
                      color: const Color(0xFFF0F4F2),
                      borderRadius: BorderRadius.circular(99),
                    ),
                  ),
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 320),
                    curve: Curves.easeOutCubic,
                    width: barWidth,
                    height: barHeight,
                    decoration: BoxDecoration(
                      color: accent,
                      borderRadius: BorderRadius.circular(99),
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
}

class DailyAttendanceCalendar extends StatefulWidget {
  const DailyAttendanceCalendar({super.key, required this.api});
  final ApiService api;

  @override
  State<DailyAttendanceCalendar> createState() =>
      _DailyAttendanceCalendarState();
}

class _DailyAttendanceCalendarState extends State<DailyAttendanceCalendar> {
  late DateTime focusedDate;
  late DateTime visibleMonth;

  static const _monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  static const _weekdayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    focusedDate = now;
    visibleMonth = DateTime(now.year, now.month);
  }

  DateTime get _firstAllowed =>
      DateTime.now().subtract(const Duration(days: 365 * 2));
  DateTime get _lastAllowed => DateTime.now().add(const Duration(days: 365));

  bool get _canGoPrev =>
      visibleMonth.isAfter(DateTime(_firstAllowed.year, _firstAllowed.month));
  bool get _canGoNext =>
      visibleMonth.isBefore(DateTime(_lastAllowed.year, _lastAllowed.month));

  void _prevMonth() {
    if (!_canGoPrev) return;
    setState(() =>
        visibleMonth = DateTime(visibleMonth.year, visibleMonth.month - 1));
  }

  void _nextMonth() {
    if (!_canGoNext) return;
    setState(() =>
        visibleMonth = DateTime(visibleMonth.year, visibleMonth.month + 1));
  }

  void _goToday() {
    final now = DateTime.now();
    setState(() => visibleMonth = DateTime(now.year, now.month));
  }

  bool _sameDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;

  String dateString(DateTime day) =>
      '${day.year.toString().padLeft(4, '0')}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}';

  Future<void> openDateModal(DateTime value) async {
    setState(() => focusedDate = value);
    final selectedDateString = dateString(value);
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) =>
          DateAttendanceModal(api: widget.api, targetDate: selectedDateString),
    );
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Align(
        alignment: Alignment.centerLeft,
        child: Text(
          'Select a date',
          style: TextStyle(fontWeight: FontWeight.w900, fontSize: 15),
        ),
      ),
      const SizedBox(height: 4),
      const Text(
        'Tap any date to open attendance details',
        style: TextStyle(
          color: Color(0xFF64726B),
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
      const SizedBox(height: 10),
      Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: const Color(0xFFDCE6E1)),
          boxShadow: [
            BoxShadow(
              color: const Color(0xFF0F6E52).withValues(alpha: .08),
              blurRadius: 18,
              offset: const Offset(0, 8),
            ),
          ],
        ),
        child: Column(
          children: [
            _buildHeader(),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 6),
              child: _buildWeekdayRow(),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
              child: _buildDayGrid(),
            ),
            const Divider(height: 1, color: Color(0xFFEDF2EF)),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
              child: _buildLegend(),
            ),
          ],
        ),
      ),
    ],
  );

  Widget _buildHeader() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          colors: [Color(0xFF0F6E52), Color(0xFF138A64)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.vertical(top: Radius.circular(19)),
      ),
      child: Row(
        children: [
          _navButton(Icons.chevron_left_rounded, _canGoPrev, _prevMonth),
          Expanded(
            child: Column(
              children: [
                Text(
                  _monthNames[visibleMonth.month - 1],
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w900,
                    fontSize: 16,
                    letterSpacing: .3,
                  ),
                ),
                Text(
                  '${visibleMonth.year}',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: .75),
                    fontWeight: FontWeight.w700,
                    fontSize: 11,
                    letterSpacing: 1.5,
                  ),
                ),
              ],
            ),
          ),
          _navButton(Icons.chevron_right_rounded, _canGoNext, _nextMonth),
        ],
      ),
    );
  }

  Widget _navButton(IconData icon, bool enabled, VoidCallback onTap) {
    return Material(
      color: Colors.white.withValues(alpha: enabled ? .18 : .06),
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: enabled ? onTap : null,
        child: SizedBox(
          width: 36,
          height: 36,
          child: Icon(
            icon,
            color: Colors.white.withValues(alpha: enabled ? 1 : .4),
            size: 24,
          ),
        ),
      ),
    );
  }

  Widget _buildWeekdayRow() {
    return Row(
      children: [
        for (var i = 0; i < 7; i++)
          Expanded(
            child: Center(
              child: Text(
                _weekdayLabels[i],
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  color: (i == 0 || i == 6)
                      ? const Color(0xFFDC8A8A)
                      : const Color(0xFF8A968F),
                ),
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildDayGrid() {
    final firstOfMonth = DateTime(visibleMonth.year, visibleMonth.month, 1);
    // Sunday-first calendar: weekday Mon=1..Sun=7 -> Sun=0..Sat=6
    final leadingBlanks = firstOfMonth.weekday % 7;
    final daysInMonth =
        DateTime(visibleMonth.year, visibleMonth.month + 1, 0).day;

    final cells = <Widget>[];
    for (var i = 0; i < leadingBlanks; i++) {
      cells.add(const Expanded(child: SizedBox(height: 42)));
    }
    for (var day = 1; day <= daysInMonth; day++) {
      cells.add(Expanded(child: _buildDayCell(day)));
    }
    // Pad the last week so all rows have 7 cells
    while (cells.length % 7 != 0) {
      cells.add(const Expanded(child: SizedBox(height: 42)));
    }

    final rows = <Widget>[];
    for (var i = 0; i < cells.length; i += 7) {
      rows.add(Row(children: cells.sublist(i, i + 7)));
    }
    return Column(children: rows);
  }

  Widget _buildDayCell(int day) {
    final cellDate = DateTime(visibleMonth.year, visibleMonth.month, day);
    final now = DateTime.now();
    final isToday = _sameDay(cellDate, now);
    final isSelected = _sameDay(cellDate, focusedDate) && !isToday;
    final isWeekend = cellDate.weekday == DateTime.saturday ||
        cellDate.weekday == DateTime.sunday;
    final isDisabled = cellDate.isBefore(
          DateTime(_firstAllowed.year, _firstAllowed.month, _firstAllowed.day),
        ) ||
        cellDate.isAfter(
          DateTime(_lastAllowed.year, _lastAllowed.month, _lastAllowed.day),
        );

    Color textColor;
    if (isToday) {
      textColor = Colors.white;
    } else if (isDisabled) {
      textColor = const Color(0xFFC4CFCA);
    } else if (isWeekend) {
      textColor = const Color(0xFFCF6B6B);
    } else {
      textColor = const Color(0xFF1F2937);
    }

    BoxDecoration? decoration;
    if (isToday) {
      decoration = BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF138A64), Color(0xFF0F6E52)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        shape: BoxShape.circle,
        boxShadow: [
          BoxShadow(
            color: const Color(0xFF0F6E52).withValues(alpha: .35),
            blurRadius: 8,
            offset: const Offset(0, 3),
          ),
        ],
      );
    } else if (isSelected) {
      decoration = BoxDecoration(
        color: const Color(0xFFE7F6EF),
        shape: BoxShape.circle,
        border: Border.all(color: const Color(0xFF138A64), width: 1.6),
      );
    } else if (isWeekend && !isDisabled) {
      decoration = const BoxDecoration(
        color: Color(0xFFFCF1F1),
        shape: BoxShape.circle,
      );
    }

    return Padding(
      padding: const EdgeInsets.all(3),
      child: Material(
        color: Colors.transparent,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: isDisabled ? null : () => openDateModal(cellDate),
          child: Container(
            height: 38,
            alignment: Alignment.center,
            decoration: decoration,
            child: Text(
              '$day',
              style: TextStyle(
                fontSize: 13,
                fontWeight: isToday || isSelected
                    ? FontWeight.w900
                    : FontWeight.w600,
                color: textColor,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildLegend() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        _legendDot(const Color(0xFF138A64), 'Today', filled: true),
        const SizedBox(width: 16),
        _legendDot(const Color(0xFF138A64), 'Selected', filled: false),
        const SizedBox(width: 16),
        _legendDot(const Color(0xFFCF6B6B), 'Weekend', filled: true),
        const Spacer(),
        InkWell(
          borderRadius: BorderRadius.circular(99),
          onTap: _goToday,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: const Color(0xFFE7F6EF),
              borderRadius: BorderRadius.circular(99),
              border: Border.all(color: const Color(0xFFBFE5D5)),
            ),
            child: const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.today_rounded,
                    size: 13, color: Color(0xFF0F6E52)),
                SizedBox(width: 5),
                Text(
                  'Today',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    color: Color(0xFF0F6E52),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _legendDot(Color color, String label, {required bool filled}) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 11,
          height: 11,
          decoration: BoxDecoration(
            color: filled ? color : Colors.transparent,
            shape: BoxShape.circle,
            border: Border.all(color: color, width: 1.6),
          ),
        ),
        const SizedBox(width: 5),
        Text(
          label,
          style: const TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w700,
            color: Color(0xFF64726B),
          ),
        ),
      ],
    );
  }
}

class DateAttendanceModal extends StatefulWidget {
  const DateAttendanceModal({
    super.key,
    required this.api,
    required this.targetDate,
    this.initialTab = 'present',
  });
  final ApiService api;
  final String targetDate;
  final String initialTab;

  @override
  State<DateAttendanceModal> createState() => _DateAttendanceModalState();
}

class _DateAttendanceModalState extends State<DateAttendanceModal> {
  bool loading = true;
  String? error;
  bool isSchoolDay = true;
  int presentCount = 0;
  int halfDayCount = 0;
  int absentCount = 0;
  List<Map<String, dynamic>> presentRows = [];
  List<Map<String, dynamic>> halfDayRows = [];
  List<Map<String, dynamic>> absentRows = [];
  late String activeTab;

  @override
  void initState() {
    super.initState();
    activeTab = _cleanInitialTab(widget.initialTab);
    load();
  }

  Future<void> load() async {
    try {
      final data = await widget.api.map(
        '/api/date-attendance-details?date=${widget.targetDate}',
      );
      final present = ((data['present_students'] as List?) ?? [])
          .map((row) => Map<String, dynamic>.from(row as Map))
          .toList();
      final absent = ((data['absent_students'] as List?) ?? [])
          .map((row) => Map<String, dynamic>.from(row as Map))
          .toList();
      final halfDay = present.where(_isHalfDayRow).toList();
      if (!mounted) return;
      setState(() {
        isSchoolDay = data['is_school_day'] == true;
        presentRows = present;
        halfDayRows = halfDay;
        absentRows = absent;
        presentCount = present.length;
        halfDayCount = halfDay.length;
        absentCount = absent.length;
        final requestedTab = _cleanInitialTab(widget.initialTab);
        activeTab = requestedTab != 'present'
            ? requestedTab
            : (presentCount > 0 ? 'present' : 'absent');
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        loading = false;
        error = readableError(
          e,
          fallback: 'Failed to load attendance details.',
        );
      });
    }
  }

  static String _cleanInitialTab(String value) {
    final key = statusKey(value);
    if (key == 'absent') return 'absent';
    if (key == 'half_day') return 'half_day';
    return 'present';
  }

  static bool _isHalfDayRow(Map<String, dynamic> row) =>
      statusKey(row['attendance_status'] ?? row['att_status']) == 'half_day';

  @override
  Widget build(BuildContext context) => DraggableScrollableSheet(
    initialChildSize: .88,
    minChildSize: .60,
    maxChildSize: .95,
    builder: (_, controller) => Container(
      decoration: const BoxDecoration(
        color: Color(0xFFF5F7F6),
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: Column(
        children: [
          const SizedBox(height: 10),
          Container(
            width: 42,
            height: 4,
            decoration: BoxDecoration(
              color: const Color(0xFFCAD5CF),
              borderRadius: BorderRadius.circular(99),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 10, 8),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Attendance Details',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      Text(
                        readableDate(widget.targetDate),
                        style: const TextStyle(
                          color: Color(0xFF64726B),
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ),
          Expanded(
            child: loading
                ? const Center(child: CircularProgressIndicator())
                : error != null
                ? const Center(
                    child: Text(
                      'Failed to load attendance details.',
                      style: TextStyle(
                        color: Color(0xFFB91C1C),
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  )
                : ListView(
                    controller: controller,
                    padding: const EdgeInsets.fromLTRB(14, 8, 14, 18),
                    children: [
                      if (!isSchoolDay)
                        const AlertStrip(
                          'No classes on this date. Attendance data is for reference only.',
                        ),
                      if (!isSchoolDay) const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: _countTile(
                              label: 'Present',
                              value: presentCount,
                              color: const Color(0xFF10B981),
                              selected: activeTab == 'present',
                              onTap: () =>
                                  setState(() => activeTab = 'present'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: _countTile(
                              label: 'Half-Day',
                              value: halfDayCount,
                              color: const Color(0xFFEA580C),
                              selected: activeTab == 'half_day',
                              onTap: () =>
                                  setState(() => activeTab = 'half_day'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: _countTile(
                              label: 'Absent',
                              value: absentCount,
                              color: const Color(0xFFDC2626),
                              selected: activeTab == 'absent',
                              onTap: () => setState(() => activeTab = 'absent'),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Text(
                        _activeTitle,
                        style: const TextStyle(
                          fontWeight: FontWeight.w900,
                          fontSize: 15,
                        ),
                      ),
                      const SizedBox(height: 8),
                      ..._activeRows.map((row) => _studentDetailTile(row)),
                      if (_activeRows.isEmpty)
                        const EmptyText('No students found for this category.'),
                    ],
                  ),
          ),
        ],
      ),
    ),
  );

  List<Map<String, dynamic>> get _activeRows {
    if (activeTab == 'half_day') return halfDayRows;
    if (activeTab == 'absent') return absentRows;
    return presentRows;
  }

  String get _activeTitle {
    if (activeTab == 'half_day') return 'Half-Day Students';
    if (activeTab == 'absent') return 'Absent Students';
    return 'Present Students';
  }

  Widget _countTile({
    required String label,
    required int value,
    required Color color,
    required bool selected,
    required VoidCallback onTap,
  }) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(14),
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      decoration: BoxDecoration(
        color: selected ? color.withValues(alpha: .12) : Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: selected
              ? color.withValues(alpha: .45)
              : const Color(0xFFDCE6E1),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '$value',
            style: TextStyle(
              color: color,
              fontSize: 22,
              fontWeight: FontWeight.w900,
              height: 1,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            label,
            style: const TextStyle(
              color: Color(0xFF4F5E57),
              fontWeight: FontWeight.w800,
              fontSize: 12,
            ),
          ),
        ],
      ),
    ),
  );

  Widget _studentDetailTile(Map<String, dynamic> row) {
    final name = '${row['name'] ?? 'Student'}';
    final schoolName = '${row['school_name'] ?? '-'}';
    final grade = '${row['grade_name'] ?? '-'}';
    final section = '${row['section_name'] ?? '-'}';
    final lrn = '${row['lrn'] ?? '-'}';
    final adviser = '${row['adviser'] ?? '-'}'.trim();
    // Derive the status key from the raw status so chip colour/grouping stay
    // correct. The visible label uses the server's professional final status
    // (Half-Day PM, Half-Day AM Early Dismissal, etc.), falling back to the late
    // half-day wording only when no detailed label is available.
    final lateHalfDay = row['late_half_day'] == true;
    final statusValue = statusKey(
      row['att_status'] ?? row['attendance_status'],
    );
    final detailedStatus = '${row['attendance_status'] ?? ''}'.trim();
    final status = detailedStatus.isNotEmpty
        ? formatStatusLabel(detailedStatus)
        : (lateHalfDay && statusValue == 'half_day'
            ? 'Half-Day (Late)'
            : formatStatusLabel(row['att_status']));
    final isAbsent = statusValue == 'absent';
    final isHalfDay = statusValue == 'half_day';
    final absentDays = intValue(row['absent_days']);
    final absentFromDate = '${row['absent_from_date'] ?? ''}'.trim();
    final statusColor = isAbsent
        ? const Color(0xFFDC2626)
        : (isHalfDay ? const Color(0xFFEA580C) : const Color(0xFF15803D));
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: PremiumCard(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header: name + status pill (aligned, never jumbled)
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontWeight: FontWeight.w900,
                      fontSize: 15,
                      height: 1.15,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: statusColor.withValues(alpha: .12),
                    borderRadius: BorderRadius.circular(99),
                    border: Border.all(color: statusColor.withValues(alpha: .3)),
                  ),
                  child: Text(
                    status,
                    style: TextStyle(
                      color: statusColor,
                      fontWeight: FontWeight.w900,
                      fontSize: 11,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            _detailRow(Icons.school_rounded, 'Grade & Section',
                '$grade  •  $section'),
            _detailRow(Icons.account_balance_rounded, 'School', schoolName),
            _detailRow(Icons.badge_rounded, 'LRN', lrn),
            _detailRow(Icons.person_rounded, 'Adviser',
                adviser.isEmpty ? 'Not assigned' : adviser),
            if (isAbsent) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(
                  color: const Color(0xFFFEF2F2),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: const Color(0xFFFCD9D9)),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.event_busy_rounded,
                        size: 15, color: Color(0xFFDC2626)),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        absentDays > 0
                            ? 'Absent since ${readableDate(absentFromDate.isEmpty ? widget.targetDate : absentFromDate)}  ·  ${absentDays == 1 ? '1 day' : '$absentDays days'}'
                            : 'Attendance date ${readableDate(widget.targetDate)}',
                        style: const TextStyle(
                          color: Color(0xFFB91C1C),
                          fontWeight: FontWeight.w800,
                          fontSize: 11.5,
                          height: 1.2,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  // Aligned label/value row used by the student detail card
  Widget _detailRow(IconData icon, String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 14, color: const Color(0xFF9AA8A1)),
          const SizedBox(width: 7),
          SizedBox(
            width: 92,
            child: Text(
              label,
              style: const TextStyle(
                color: Color(0xFF8A968F),
                fontWeight: FontWeight.w700,
                fontSize: 11.5,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(
                color: Color(0xFF374151),
                fontWeight: FontWeight.w800,
                fontSize: 12,
                height: 1.25,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class AbsentStudentsSheet extends StatefulWidget {
  const AbsentStudentsSheet({
    super.key,
    required this.api,
    required this.targetDate,
    required this.title,
  });
  final ApiService api;
  final String targetDate;
  final String title;

  @override
  State<AbsentStudentsSheet> createState() => _AbsentStudentsSheetState();
}

class _AbsentStudentsSheetState extends State<AbsentStudentsSheet> {
  bool loading = true;
  String? error;
  List<Map<String, dynamic>> rows = [];

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final result = await Future.wait([
        widget.api.list('/api/reports/absentees?date=${widget.targetDate}'),
        widget.api.list(
          '/api/absence-flags?days=1&include_teachers=0&date=${widget.targetDate}',
        ),
      ]);
      final absentees = result[0];
      final flags = result[1];
      final absentDaysById = <String, int>{};
      final absentFromDateById = <String, String>{};
      for (final item in flags) {
        final row = Map<String, dynamic>.from(item as Map);
        absentDaysById['${row['id']}'] = math.max(
          1,
          intValue(row['absent_days']),
        );
        final checkedDates = (row['checked_dates'] as List?) ?? const [];
        if (checkedDates.isNotEmpty) {
          absentFromDateById['${row['id']}'] = '${checkedDates.last}';
        }
      }

      final mapped = absentees.map<Map<String, dynamic>>((item) {
        final row = Map<String, dynamic>.from(item as Map);
        final id = '${row['id']}';
        final first = '${row['firstname'] ?? ''}'.trim();
        final last = '${row['lastname'] ?? ''}'.trim();
        final name = '$first $last'.trim();
        return {
          ...row,
          'name': name.isEmpty ? 'Student' : name,
          'attendance_status': 'Absent',
          'absent_days': absentDaysById[id] ?? 1,
          'absent_from_date': absentFromDateById[id] ?? widget.targetDate,
        };
      }).toList();

      if (!mounted) return;
      setState(() {
        rows = mapped;
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        loading = false;
        error = readableError(
          e,
          fallback: 'Failed to load absent student details.',
        );
      });
    }
  }

  @override
  Widget build(BuildContext context) => DraggableScrollableSheet(
    initialChildSize: .86,
    minChildSize: .55,
    maxChildSize: .94,
    builder: (context, controller) => Container(
      decoration: const BoxDecoration(
        color: Color(0xFFF5F7F6),
        borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
      ),
      child: Column(
        children: [
          const SizedBox(height: 10),
          Container(
            width: 44,
            height: 4,
            decoration: BoxDecoration(
              color: const Color(0xFFCAD5CF),
              borderRadius: BorderRadius.circular(99),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 10, 8),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.title,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      Text(
                        readableDate(widget.targetDate),
                        style: const TextStyle(
                          color: Color(0xFF64726B),
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ),
          Expanded(
            child: loading
                ? const Center(child: CircularProgressIndicator())
                : error != null
                ? Center(
                    child: Text(
                      'Failed to load absent student details.',
                      style: const TextStyle(
                        color: Color(0xFFB91C1C),
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  )
                : rows.isEmpty
                ? const Center(
                    child: Text(
                      'No absent students found for this day.',
                      style: TextStyle(color: Color(0xFF64726B)),
                    ),
                  )
                : ListView(
                    controller: controller,
                    padding: const EdgeInsets.fromLTRB(14, 8, 14, 22),
                    children: [
                      for (final row in rows)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: PremiumCard(
                            padding: const EdgeInsets.all(12),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '${row['name'] ?? 'Student'}',
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w900,
                                    fontSize: 15,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  'Grade: ${row['grade_name'] ?? '-'} | Section: ${row['section_name'] ?? '-'}',
                                  style: const TextStyle(
                                    color: Color(0xFF4F5E57),
                                    fontWeight: FontWeight.w700,
                                    fontSize: 12,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  'School: ${row['school_name'] ?? '-'}',
                                  style: const TextStyle(
                                    color: Color(0xFF4F5E57),
                                    fontWeight: FontWeight.w700,
                                    fontSize: 12,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  'LRN: ${row['lrn'] ?? '-'} | Adviser: ${row['adviser'] ?? '-'}',
                                  style: const TextStyle(
                                    color: Color(0xFF5E6B65),
                                    fontWeight: FontWeight.w700,
                                    fontSize: 12,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  'Status: ${formatStatusLabel(row['attendance_status'] ?? 'Absent')} | Absent days: ${row['absent_days'] ?? 1}',
                                  style: const TextStyle(
                                    color: Color(0xFFB91C1C),
                                    fontWeight: FontWeight.w900,
                                    fontSize: 12,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  'Absent since: ${readableDate('${row['absent_from_date'] ?? widget.targetDate}')}',
                                  style: const TextStyle(
                                    color: Color(0xFFB91C1C),
                                    fontWeight: FontWeight.w800,
                                    fontSize: 12,
                                  ),
                                ),
                              ],
                            ),
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

// ── School Leaderboard ─────────────────────────────────────────────────────────

class SchoolLeaderboard extends StatelessWidget {
  const SchoolLeaderboard({super.key, required this.schools});
  final List<dynamic> schools;

  static const _medalColors = [
    Color(0xFFD4A017), // gold
    Color(0xFF9E9E9E), // silver
    Color(0xFFCD7F32), // bronze
  ];

  @override
  Widget build(BuildContext context) {
    final shown = schools.take(6).toList();
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFDCE6E1)),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFF111827).withValues(alpha: .04),
            blurRadius: 12,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
            child: Row(
              children: [
                const Icon(Icons.workspace_premium_rounded,
                    color: Color(0xFFD4A017), size: 20),
                const SizedBox(width: 8),
                const Expanded(
                  child: Text(
                    'Attendance Rate by School',
                    style: TextStyle(
                      fontWeight: FontWeight.w900,
                      fontSize: 14,
                      color: Color(0xFF1F2937),
                    ),
                  ),
                ),
                Text(
                  'Today',
                  style: const TextStyle(
                    fontSize: 11,
                    color: Color(0xFF64726B),
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 2),
          // Top school highlight card
          if (shown.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
              child: _TopSchoolCard(
                school: shown[0] as Map,
                rate: intValue((shown[0] as Map)['rate']),
              ),
            ),
          ],
          // Rest of the list
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
            child: Column(
              children: [
                for (var i = 1; i < shown.length; i++)
                  _SchoolRankRow(
                    rank: i + 1,
                    school: shown[i] as Map,
                    rate: intValue((shown[i] as Map)['rate']),
                    medalColor: i < 3 ? _medalColors[i] : null,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TopSchoolCard extends StatelessWidget {
  const _TopSchoolCard({required this.school, required this.rate});
  final Map school;
  final int rate;

  @override
  Widget build(BuildContext context) {
    final clamped = clampPercent(rate);
    final accent = attendanceScoreColor(clamped);
    final name = '${school['name'] ?? 'School'}';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            const Color(0xFFF0FDF4),
            const Color(0xFFDCFCE7),
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF86EFAC)),
      ),
      child: Row(
        children: [
          // School logo with a gold #1 rank badge
          SizedBox(
            width: 46,
            height: 46,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: const Color(0xFFD4A017),
                      width: 2,
                    ),
                  ),
                  child: SchoolLogoAvatar(school, size: 42),
                ),
                Positioned(
                  bottom: -4,
                  right: -4,
                  child: Container(
                    width: 20,
                    height: 20,
                    decoration: BoxDecoration(
                      color: const Color(0xFFD4A017),
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white, width: 1.5),
                      boxShadow: [
                        BoxShadow(
                          color: const Color(0xFFD4A017).withValues(alpha: .4),
                          blurRadius: 4,
                        ),
                      ],
                    ),
                    alignment: Alignment.center,
                    child: const Icon(
                      Icons.emoji_events_rounded,
                      size: 12,
                      color: Colors.white,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  '#1 Top School',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF138A64),
                    letterSpacing: 0.5,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontWeight: FontWeight.w900,
                    fontSize: 13,
                    color: Color(0xFF1F2937),
                  ),
                ),
                const SizedBox(height: 6),
                TweenAnimationBuilder<double>(
                  tween: Tween<double>(begin: 0, end: clamped / 100),
                  duration: const Duration(milliseconds: 800),
                  curve: Curves.easeOutCubic,
                  builder: (context, value, _) => ClipRRect(
                    borderRadius: BorderRadius.circular(99),
                    child: Stack(
                      children: [
                        Container(
                          height: 7,
                          width: double.infinity,
                          color: const Color(0xFFBBF7D0),
                        ),
                        FractionallySizedBox(
                          widthFactor: value,
                          child: Container(
                            height: 7,
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                colors: [accent, accent.withValues(alpha: .8)],
                              ),
                              borderRadius: BorderRadius.circular(99),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Text(
            '$clamped%',
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w900,
              color: accent,
            ),
          ),
        ],
      ),
    );
  }
}

class _SchoolRankRow extends StatelessWidget {
  const _SchoolRankRow({
    required this.rank,
    required this.school,
    required this.rate,
    this.medalColor,
  });
  final int rank;
  final Map school;
  final int rate;
  final Color? medalColor;

  @override
  Widget build(BuildContext context) {
    final clamped = clampPercent(rate);
    final accent = attendanceScoreColor(clamped);
    final name = '${school['name'] ?? 'School'}';
    final badgeColor = medalColor ?? const Color(0xFF64726B);
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Row(
        children: [
          // School logo with a small rank-number badge
          SizedBox(
            width: 38,
            height: 38,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                SchoolLogoAvatar(school, size: 36),
                Positioned(
                  bottom: -3,
                  right: -3,
                  child: Container(
                    width: 17,
                    height: 17,
                    decoration: BoxDecoration(
                      color: badgeColor,
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white, width: 1.5),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      '$rank',
                      style: const TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w900,
                        color: Colors.white,
                        height: 1,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF1F2937),
                  ),
                ),
                const SizedBox(height: 4),
                TweenAnimationBuilder<double>(
                  tween: Tween<double>(begin: 0, end: clamped / 100),
                  duration: const Duration(milliseconds: 700),
                  curve: Curves.easeOutCubic,
                  builder: (context, value, _) => ClipRRect(
                    borderRadius: BorderRadius.circular(99),
                    child: Stack(
                      children: [
                        Container(
                          height: 6,
                          width: double.infinity,
                          color: const Color(0xFFE5EEE9),
                        ),
                        FractionallySizedBox(
                          widthFactor: value,
                          child: Container(height: 6, color: accent),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Text(
            '$clamped%',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w900,
              color: accent,
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

class SchoolTrendChart extends StatelessWidget {
  const SchoolTrendChart({super.key, required this.rates});
  final List<int> rates;

  @override
  Widget build(BuildContext context) => CustomPaint(
    painter: SchoolTrendPainter(rates),
    child: const SizedBox.expand(),
  );
}

class SchoolTrendPainter extends CustomPainter {
  SchoolTrendPainter(this.rates);
  final List<int> rates;

  @override
  void paint(Canvas canvas, Size size) {
    if (rates.isEmpty) return;
    final line = Paint()
      ..color = const Color(0xFF138A64)
      ..strokeWidth = 2.5
      ..style = PaintingStyle.stroke;
    final fill = Paint()
      ..color = const Color(0xFF138A64).withValues(alpha: .10)
      ..style = PaintingStyle.fill;
    final dot = Paint()..color = const Color(0xFF0F6E52);
    final grid = Paint()
      ..color = const Color(0xFFE5ECE8)
      ..strokeWidth = 1;

    for (var i = 1; i <= 3; i++) {
      final y = size.height * i / 4;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }

    final step = rates.length == 1 ? 0.0 : size.width / (rates.length - 1);
    final path = Path();
    final fillPath = Path();

    for (var i = 0; i < rates.length; i++) {
      final x = i * step;
      final normalized = rates[i].clamp(0, 100).toDouble() / 100;
      final y = size.height - normalized * (size.height - 8) - 4;
      if (i == 0) {
        path.moveTo(x, y);
        fillPath.moveTo(x, size.height);
        fillPath.lineTo(x, y);
      } else {
        path.lineTo(x, y);
        fillPath.lineTo(x, y);
      }
      canvas.drawCircle(Offset(x, y), 3.2, dot);
    }
    fillPath.lineTo(size.width, size.height);
    fillPath.close();
    canvas.drawPath(fillPath, fill);
    canvas.drawPath(path, line);
  }

  @override
  bool shouldRepaint(SchoolTrendPainter oldDelegate) =>
      oldDelegate.rates != rates;
}

class AttendancePage extends StatelessWidget {
  const AttendancePage({super.key, required this.api});
  final ApiService api;

  @override
  Widget build(BuildContext context) => LiveList(
    title: 'Attendance',
    subtitle: 'Live time-in and time-out records for today.',
    cacheKey: 'attendance-${date()}',
    fetch: () => api.list('/api/attendance?date=${date()}'),
    empty: 'No attendance records yet today.',
    builder: (row) {
      final monitoring = '${row['monitoring_status'] ?? ''}'.trim();
      final out = '${row['time_out'] ?? ''}'.trim();
      return RecordTile(
        title: '${row['person_name'] ?? 'Unknown'}',
        subtitle: '${row['person_type'] ?? 'person'}',
        meta:
            'In: ${row['time_in'] ?? '--'} | Out: ${out.isNotEmpty ? out : (monitoring.isNotEmpty ? monitoring : '--')}',
      );
    },
  );
}

class ReportsPage extends StatelessWidget {
  const ReportsPage({super.key, required this.api});
  final ApiService api;

  @override
  Widget build(BuildContext context) => LiveMap(
    cacheKey: 'reports-${date()}',
    fetch: () => api.map('/api/reports/daily-summary?date=${date()}'),
    errorFallback: 'Failed to load report data.',
    builder: (context, data, refresh) {
      final totals = (data['totals'] as Map?) ?? {};
      final schools = (data['schools'] as List?) ?? [];
      Future<void> openDateDetails(String tab) async {
        await showModalBottomSheet(
          context: context,
          isScrollControlled: true,
          backgroundColor: Colors.transparent,
          builder: (_) => DateAttendanceModal(
            api: api,
            targetDate: date(),
            initialTab: tab,
          ),
        );
      }

      return RefreshIndicator(
        onRefresh: refresh,
        child: _legacyReportsBody(context, totals, schools, openDateDetails),
      );
    },
  );

  Widget _legacyReportsBody(
    BuildContext context,
    Map totals,
    List schools,
    Future<void> Function(String) openDateDetails,
  ) {
      return ListView(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
        children: [
          PremiumCard(
            padding: const EdgeInsets.all(20),
            child: Row(
              children: [
                Container(
                  width: 54,
                  height: 54,
                  decoration: BoxDecoration(
                    color: const Color(0xFF00885B),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Icon(
                    Icons.insert_chart_rounded,
                    color: Colors.white,
                    size: 28,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Reports',
                        style: TextStyle(
                          fontSize: 25,
                          fontWeight: FontWeight.w900,
                          letterSpacing: -.65,
                        ),
                      ),
                      Text(
                        'Live daily insight - ${shortDate()}',
                        style: const TextStyle(
                          color: Color(0xFF667872),
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                ),
                const LiveDot(color: Color(0xFFFF3B30)),
              ],
            ),
          ),
          const SizedBox(height: 14),
          PremiumCard(
            title: 'Daily Summary',
            subtitle: 'Live data overview',
            child: GridView.count(
              physics: const NeverScrollableScrollPhysics(),
              shrinkWrap: true,
              crossAxisCount: 2,
              childAspectRatio: 1.62,
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              children: [
                Metric(
                  Icons.groups,
                  'Students',
                  '${intValue(totals['enrolled'])}',
                  'total',
                ),
                Metric(
                  Icons.how_to_reg,
                  'Present',
                  '${intValue(totals['present'])}',
                  'today',
                  onTap: () => openDateDetails('present'),
                ),
                Metric(
                  Icons.person_off,
                  'Absent',
                  '${intValue(totals['absent'])}',
                  'today',
                  color: const Color(0xFFDC2626),
                  onTap: () => openDateDetails('absent'),
                ),
                Metric(
                  Icons.percent,
                  'Rate',
                  '${intValue(totals['rate'])}%',
                  'average',
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          PremiumCard(
            title: 'School Insights',
            subtitle: '${schools.length} live school record(s)',
            child: Column(
              children: [
                for (final item in schools.take(60))
                  RateBar(
                    '${(item as Map)['name'] ?? 'School'}',
                    intValue(item['rate']),
                  ),
                if (schools.isEmpty)
                  const EmptyText('No school report records yet.'),
              ],
            ),
          ),
        ],
      );
  }
}

class SchoolsPage extends StatefulWidget {
  const SchoolsPage({super.key, required this.api});
  final ApiService api;

  @override
  State<SchoolsPage> createState() => _SchoolsPageState();
}

class _SchoolsPageState extends State<SchoolsPage> {
  Map? school;
  Map? grade;
  Map? section;
  // Static cache — school structure rarely changes, so show it instantly on
  // re-entry (no spinner) while a fresh copy loads in the background.
  static Map<String, dynamic>? _cachedStructure;
  Map<String, dynamic>? structure;
  String? error;

  @override
  void initState() {
    super.initState();
    structure = _cachedStructure;
    load(silent: structure != null);
  }

  Future<void> load({bool silent = false}) async {
    if (!silent && mounted) setState(() => error = null);
    try {
      final data = await widget.api.map('/api/mobile-school-structure');
      _cachedStructure = data;
      if (!mounted) return;
      setState(() {
        structure = data;
        error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = readableError(e, fallback: 'Failed to load school details.');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (structure == null && error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Text(
            error!,
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Color(0xFFB91C1C),
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
      );
    }
    if (structure == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final schools = (structure!['schools'] as List?) ?? [];
    return RefreshIndicator(
      onRefresh: () => load(silent: true),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionTitle(
            'Schools',
            section != null
                ? 'Students and adviser information.'
                : grade != null
                ? 'Tap a section to view students.'
                : school != null
                ? 'Tap a grade level to view sections.'
                : 'Tap a school to view grade levels.',
          ),
          const SizedBox(height: 16),
          section != null
              ? sectionView()
              : grade != null
              ? gradeView()
              : school != null
              ? schoolView()
              : schoolsList(schools),
        ],
      ),
    );
  }

  Widget schoolsList(List schools) => PremiumCard(
    title: 'School List',
    subtitle: '${schools.length} school(s)',
    child: Column(
      children: [
        for (final item in schools)
          RecordTile(
            title: '${(item as Map)['name'] ?? 'School'}',
            subtitle: '${item['address'] ?? 'No address saved'}',
            meta:
                '${intValue(item['student_count'])} students - ${intValue(item['teacher_count'])} teachers',
            leading: SchoolLogoAvatar(item),
            onTap: () => setState(() => school = item),
          ),
      ],
    ),
  );

  Widget schoolView() {
    final grades = (school!['grade_levels'] as List?) ?? [];
    return PremiumCard(
      title: '${school!['name']}',
      subtitle: '${intValue(school!['student_count'])} students',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              SchoolLogoAvatar(school!, size: 48),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  '${school!['name']}',
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          BackLine(
            'Back',
            () => setState(() {
              school = null;
              grade = null;
              section = null;
            }),
          ),
          for (final item in grades)
            RecordTile(
              title: '${(item as Map)['name'] ?? 'Grade'}',
              subtitle:
                  '${((item['sections'] as List?) ?? []).length} section(s)',
              meta: '${countStudents(item)} students',
              onTap: () => setState(() => grade = item),
            ),
          if (grades.isEmpty) const EmptyText('No grade levels assigned.'),
        ],
      ),
    );
  }

  Widget gradeView() {
    final sections = (grade!['sections'] as List?) ?? [];
    return PremiumCard(
      title: '${grade!['name']}',
      subtitle: '${school!['name']}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              SchoolLogoAvatar(school!, size: 38),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  '${school!['name']}',
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          BackLine(
            'Back',
            () => setState(() {
              grade = null;
              section = null;
            }),
          ),
          for (final item in sections)
            RecordTile(
              title: '${(item as Map)['name'] ?? 'Section'}',
              subtitle: adviserText(item),
              meta: '${((item['students'] as List?) ?? []).length} students',
              color: adviserText(item).startsWith('No')
                  ? const Color(0xFFF97316)
                  : const Color(0xFF00885B),
              onTap: () => setState(() => section = item),
            ),
          if (sections.isEmpty) const EmptyText('No sections assigned.'),
        ],
      ),
    );
  }

  Widget sectionView() {
    final students = (section!['students'] as List?) ?? [];
    return PremiumCard(
      title: '${section!['name']}',
      subtitle: '${grade!['name']} - ${school!['name']}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              SchoolLogoAvatar(school!, size: 34),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '${school!['name']}',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          BackLine('Back', () => setState(() => section = null)),
          InfoPill(
            'Adviser',
            adviserText(section!).replaceFirst('Adviser: ', ''),
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: () => contactAdviserViaCall(context, {
                    'adviser': section!['adviser'],
                    'adviser_contact': section!['adviser_contact'],
                    'adviser_email': section!['adviser_email'],
                    'school_name': school!['name'],
                    'school_contact': school!['contact'],
                    'grade_name': grade!['name'],
                    'section_name': section!['name'],
                  }),
                  icon: const Icon(Icons.call_rounded, size: 16),
                  label: const Text('Call Adviser'),
                ),
                OutlinedButton.icon(
                  onPressed: () => contactAdviserViaSms(context, {
                    'adviser': section!['adviser'],
                    'adviser_contact': section!['adviser_contact'],
                    'adviser_email': section!['adviser_email'],
                    'school_name': school!['name'],
                    'school_contact': school!['contact'],
                    'grade_name': grade!['name'],
                    'section_name': section!['name'],
                  }),
                  icon: const Icon(Icons.sms_rounded, size: 16),
                  label: const Text('Send SMS'),
                ),
                OutlinedButton.icon(
                  onPressed: () => contactAdviserViaEmail(context, {
                    'adviser': section!['adviser'],
                    'adviser_contact': section!['adviser_contact'],
                    'adviser_email': section!['adviser_email'],
                    'school_name': school!['name'],
                    'school_contact': school!['contact'],
                    'grade_name': grade!['name'],
                    'section_name': section!['name'],
                  }),
                  icon: const Icon(Icons.email_rounded, size: 16),
                  label: const Text('Send Email'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          for (final student in students)
            RecordTile(
              title: studentName(student),
              subtitle:
                  '${(student as Map)['school_name'] ?? school!['name']} | ${student['grade_name'] ?? grade!['name']} - ${student['section_name'] ?? section!['name']}',
              meta:
                  'LRN: ${student['lrn'] ?? '-'} | Adviser: ${student['adviser'] ?? adviserText(section!).replaceFirst('Adviser: ', '')}',
            ),
          if (students.isEmpty)
            const EmptyText('No students assigned to this section.'),
        ],
      ),
    );
  }
}

class AlertsPage extends StatefulWidget {
  const AlertsPage({
    super.key,
    required this.flags,
    this.notificationIntent,
    this.onIntentConsumed,
  });
  final List<dynamic> flags;
  final Map<String, dynamic>? notificationIntent;
  final VoidCallback? onIntentConsumed;

  @override
  State<AlertsPage> createState() => _AlertsPageState();
}

class _AlertsPageState extends State<AlertsPage> {
  String? consumedIntentKey;

  @override
  void didUpdateWidget(covariant AlertsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextKey = notificationIntentKey(widget.notificationIntent);
    final oldKey = notificationIntentKey(oldWidget.notificationIntent);
    if (nextKey != oldKey) consumedIntentKey = null;
  }

  Future<void> _consumeIntentIfNeeded() async {
    final intent = widget.notificationIntent;
    final key = notificationIntentKey(intent);
    if (intent == null || key == null || key == consumedIntentKey) return;
    consumedIntentKey = key;

    final action = '${intent['action'] ?? 'view'}';
    final rowFromIntent = intent['row'];
    Map<String, dynamic>? row;
    if (rowFromIntent is Map) {
      row = Map<String, dynamic>.from(rowFromIntent);
    } else if (widget.flags.isNotEmpty) {
      row = Map<String, dynamic>.from(widget.flags.first as Map);
    }

    if (row != null && mounted) {
      if (action == 'contact') {
        await contactAdviserViaCall(context, row);
      } else if (action == 'view') {
        await FlagTile.openStudentDetailsModal(context, row);
      }
    }
    widget.onIntentConsumed?.call();
  }

  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _consumeIntentIfNeeded();
    });
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const SectionTitle(
          'Alerts',
          '2-day absence alerts and notification checks.',
        ),
        const SizedBox(height: 16),
        PremiumCard(
          title: 'Notification Test',
          subtitle: 'Verify the 2-day flagged student alert on this phone.',
          child: FilledButton.icon(
            onPressed: () async {
              final granted = await ensureNotificationPermission();
              if (!granted) {
                if (context.mounted) {
                  showDialog(
                    context: context,
                    builder: (_) => AlertDialog(
                      title: const Text('Notifications are blocked'),
                      content: const Text(
                        'Please allow Edutrack notifications in your phone settings, then press the test button again.',
                      ),
                      actions: [
                        TextButton(
                          onPressed: () => Navigator.pop(context),
                          child: const Text('Close'),
                        ),
                      ],
                    ),
                  );
                }
                return;
              }
              if (widget.flags.isEmpty) {
                await showLocalNotification(
                  'Edutrack alert test',
                  'No live 2-day flagged students found.',
                );
                return;
              }
              for (final item in widget.flags) {
                final row = Map<String, dynamic>.from(item as Map);
                await showLocalNotification(
                  '2-Day Absence Alert',
                  absenceBody(row),
                  payload: absenceNotificationPayload([row]),
                  actions: const [
                    AndroidNotificationAction(
                      'view',
                      'View',
                      showsUserInterface: true,
                    ),
                    AndroidNotificationAction(
                      'contact_adviser',
                      'Contact Adviser',
                      showsUserInterface: true,
                    ),
                  ],
                );
              }
            },
            icon: const Icon(Icons.notifications_active),
            label: const Text('Send 2-day flagged alert'),
          ),
        ),
        const SizedBox(height: 12),
        PremiumCard(
          title: '2-Day Absence Alerts',
          subtitle: '${widget.flags.length} active flag(s)',
          child: Column(
            children: [
              if (widget.flags.isEmpty)
                const EmptyText('No 2-day absentees detected.'),
              for (final item in widget.flags)
                FlagTile(Map<String, dynamic>.from(item as Map)),
            ],
          ),
        ),
      ],
    );
  }
}

class FlagTile extends StatelessWidget {
  const FlagTile(this.row, {super.key});
  final Map<String, dynamic> row;

  @override
  Widget build(BuildContext context) {
    final schoolName = '${row['school_name'] ?? '-'}';
    final grade = '${row['grade_name'] ?? '-'}';
    final section = '${row['section_name'] ?? '-'}';
    final summary = '$schoolName | $grade - $section';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: Colors.white,
        elevation: 0,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          onTap: () => _openStudentDetails(context),
          borderRadius: BorderRadius.circular(16),
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: const Color(0xFFDDE7E2)),
            ),
            child: Row(
              children: [
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    color: const Color(0xFFFEE2E2),
                    borderRadius: BorderRadius.circular(11),
                  ),
                  child: const Icon(
                    Icons.person_rounded,
                    color: Color(0xFFDC2626),
                    size: 20,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${row['name'] ?? 'Student'}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Color(0xFF111827),
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                          height: 1.08,
                        ),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        summary,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Color(0xFF5C6D66),
                          fontSize: 12.8,
                          fontWeight: FontWeight.w700,
                          height: 1.25,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                const Icon(
                  Icons.chevron_right_rounded,
                  color: Color(0xFFF97316),
                  size: 22,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  static Future<void> openStudentDetailsModal(
    BuildContext context,
    Map<String, dynamic> row, {
    bool openContactActions = false,
  }) async {
    final studentName = '${row['name'] ?? 'Student'}';
    final lrn = '${row['lrn'] ?? '-'}';
    final schoolName = '${row['school_name'] ?? '-'}';
    final grade = '${row['grade_name'] ?? '-'}';
    final section = '${row['section_name'] ?? '-'}';
    final daysAbsent = absenceDays(row);
    final status = formatStatusLabel(row['attendance_status'] ?? 'Absent');
    final adviserName = '${row['adviser'] ?? '-'}';
    final adviserPhone = adviserPhoneFromRow(row) ?? '-';
    final adviserEmail = adviserEmailFromRow(row) ?? '-';

    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => DraggableScrollableSheet(
        initialChildSize: .84,
        minChildSize: .58,
        maxChildSize: .94,
        builder: (context, controller) => Container(
          decoration: const BoxDecoration(
            color: Color(0xFFFDFEFD),
            borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
          ),
          child: ListView(
            controller: controller,
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 22),
            children: [
              Center(
                child: Container(
                  width: 42,
                  height: 4,
                  decoration: BoxDecoration(
                    color: const Color(0xFFCAD5CF),
                    borderRadius: BorderRadius.circular(99),
                  ),
                ),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      studentName,
                      style: const TextStyle(
                        fontSize: 21,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: const Color(0xFFDDE7E2)),
                  boxShadow: [
                    BoxShadow(
                      color: const Color(0xFF111827).withValues(alpha: .04),
                      blurRadius: 10,
                      offset: const Offset(0, 4),
                    ),
                  ],
                ),
                child: Column(
                  children: [
                    _detailLine('Student Name', studentName),
                    _detailLine('LRN', lrn),
                    _detailLine(
                      'School Name',
                      schoolName,
                      trailing: _schoolNameWithLogo(schoolName, row),
                    ),
                    _detailLine('Grade Level', grade),
                    _detailLine('Section', section),
                    _detailLine('Attendance Status', status),
                    _detailLine('Number of Days Absent', daysAbsent),
                    _detailLine('Adviser Name', adviserName),
                    _detailLine('Adviser Contact Number', adviserPhone),
                    _detailLine('Adviser Email Address', adviserEmail),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                'Please click an option below if you want to contact the adviser.',
                style: TextStyle(
                  color: Color(0xFF42544D),
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 10),
              LayoutBuilder(
                builder: (context, constraints) {
                  final wide = constraints.maxWidth >= 520;
                  final buttonWidth = wide
                      ? (constraints.maxWidth - 16) / 3
                      : (constraints.maxWidth - 8) / 2;
                  return Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      SizedBox(
                        width: buttonWidth,
                        child: _contactActionButton(
                          icon: Icons.call_rounded,
                          label: 'Call Adviser',
                          filled: true,
                          onPressed: () => contactAdviserViaCall(context, row),
                        ),
                      ),
                      SizedBox(
                        width: buttonWidth,
                        child: _contactActionButton(
                          icon: Icons.sms_rounded,
                          label: 'Send SMS',
                          onPressed: () =>
                              contactAdviserAlertViaSms(context, row),
                        ),
                      ),
                      SizedBox(
                        width: buttonWidth,
                        child: _contactActionButton(
                          icon: Icons.email_rounded,
                          label: 'Send Email',
                          onPressed: () =>
                              contactAdviserAlertViaEmail(context, row),
                        ),
                      ),
                    ],
                  );
                },
              ),
              if (openContactActions)
                const Padding(
                  padding: EdgeInsets.only(top: 10),
                  child: Text(
                    'Contact actions are ready below.',
                    style: TextStyle(
                      color: Color(0xFF0F6E52),
                      fontWeight: FontWeight.w700,
                      fontSize: 12,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _openStudentDetails(BuildContext context) =>
      openStudentDetailsModal(context, row);

  static Widget _schoolNameWithLogo(
    String schoolName,
    Map<String, dynamic> row,
  ) => SizedBox(
    width: double.infinity,
    child: Row(
      mainAxisAlignment: MainAxisAlignment.end,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        SchoolLogoAvatar({
          'name': schoolName,
          'school_logo': row['school_logo'],
          'logo': row['school_logo'],
        }, size: 24),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            schoolName,
            textAlign: TextAlign.right,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFF101C18),
              fontWeight: FontWeight.w800,
              fontSize: 13,
              height: 1.15,
            ),
          ),
        ),
      ],
    ),
  );

  static Widget _contactActionButton({
    required IconData icon,
    required String label,
    required VoidCallback onPressed,
    bool filled = false,
  }) => SizedBox(
    height: 48,
    child: filled
        ? FilledButton.icon(
            onPressed: onPressed,
            icon: Icon(icon, size: 17),
            label: Text(label),
            style: FilledButton.styleFrom(
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
              textStyle: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w800,
              ),
            ),
          )
        : OutlinedButton.icon(
            onPressed: onPressed,
            icon: Icon(icon, size: 17),
            label: Text(label),
            style: OutlinedButton.styleFrom(
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
              side: const BorderSide(color: Color(0xFFBFD2CA)),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
              textStyle: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
  );

  static Widget _detailLine(String label, String value, {Widget? trailing}) =>
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              flex: 2,
              child: Text(
                label,
                style: const TextStyle(
                  color: Color(0xFF5A6A64),
                  fontWeight: FontWeight.w700,
                  fontSize: 12,
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              flex: 3,
              child: Align(
                alignment: Alignment.centerRight,
                child:
                    trailing ??
                    Text(
                      value,
                      textAlign: TextAlign.right,
                      style: const TextStyle(
                        color: Color(0xFF101C18),
                        fontWeight: FontWeight.w800,
                        fontSize: 13,
                      ),
                    ),
              ),
            ),
          ],
        ),
      );
}

// Stale-while-revalidate list loader. Shows cached data INSTANTLY on
// re-entry (no spinner), refreshes in the background, stays live via a
// periodic timer + pull-to-refresh. Fast navigation without losing live data.
class LiveList extends StatefulWidget {
  const LiveList({
    super.key,
    required this.title,
    required this.subtitle,
    required this.cacheKey,
    required this.fetch,
    required this.empty,
    required this.builder,
    this.recordsTitle = 'Today Records',
    this.refreshInterval = const Duration(seconds: 20),
  });
  final String title;
  final String subtitle;
  final String cacheKey;
  final Future<List<dynamic>> Function() fetch;
  final String empty;
  final Widget Function(Map<String, dynamic>) builder;
  final String recordsTitle;
  final Duration refreshInterval;

  @override
  State<LiveList> createState() => _LiveListState();
}

class _LiveListState extends State<LiveList> {
  static final Map<String, List<dynamic>> _cache = {};
  List<dynamic>? rows;
  String? error;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    rows = _cache[widget.cacheKey];
    load(silent: rows != null);
    timer = Timer.periodic(widget.refreshInterval, (_) => load(silent: true));
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Future<void> load({bool silent = false}) async {
    if (!silent && mounted) setState(() => error = null);
    try {
      final data = await widget.fetch();
      _cache[widget.cacheKey] = data;
      if (!mounted) return;
      setState(() {
        rows = data;
        error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = readableError(
          e,
          fallback: 'Failed to load records from the server.',
        );
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (rows == null && error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Text(
            error!,
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Color(0xFFB91C1C),
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
      );
    }
    if (rows == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final data = rows!;
    return RefreshIndicator(
      onRefresh: () => load(silent: true),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionTitle(widget.title, widget.subtitle),
          const SizedBox(height: 16),
          PremiumCard(
            title: widget.recordsTitle,
            subtitle: '${data.length} synced record(s)',
            child: Column(
              children: [
                if (data.isEmpty) EmptyText(widget.empty),
                for (final row in data.take(80))
                  widget.builder(Map<String, dynamic>.from(row as Map)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// Stale-while-revalidate map loader (single JSON object endpoints).
class LiveMap extends StatefulWidget {
  const LiveMap({
    super.key,
    required this.cacheKey,
    required this.fetch,
    required this.builder,
    this.errorFallback = 'Failed to load data.',
    this.refreshInterval = const Duration(seconds: 25),
  });
  final String cacheKey;
  final Future<Map<String, dynamic>> Function() fetch;
  final Widget Function(
    BuildContext context,
    Map<String, dynamic> data,
    Future<void> Function() refresh,
  ) builder;
  final String errorFallback;
  final Duration refreshInterval;

  @override
  State<LiveMap> createState() => _LiveMapState();
}

class _LiveMapState extends State<LiveMap> {
  static final Map<String, Map<String, dynamic>> _cache = {};
  Map<String, dynamic>? data;
  String? error;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    data = _cache[widget.cacheKey];
    load(silent: data != null);
    timer = Timer.periodic(widget.refreshInterval, (_) => load(silent: true));
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Future<void> load({bool silent = false}) async {
    if (!silent && mounted) setState(() => error = null);
    try {
      final result = await widget.fetch();
      _cache[widget.cacheKey] = result;
      if (!mounted) return;
      setState(() {
        data = result;
        error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = readableError(e, fallback: widget.errorFallback);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (data == null && error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Text(
            error!,
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Color(0xFFB91C1C),
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
      );
    }
    if (data == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return widget.builder(context, data!, () => load(silent: true));
  }
}

class FutureList extends StatelessWidget {
  const FutureList({
    super.key,
    required this.title,
    required this.subtitle,
    required this.future,
    required this.empty,
    required this.builder,
  });
  final String title;
  final String subtitle;
  final Future<List<dynamic>> future;
  final String empty;
  final Widget Function(Map<String, dynamic>) builder;

  @override
  Widget build(BuildContext context) => FutureBuilder<List<dynamic>>(
    future: future,
    builder: (_, snapshot) {
      if (snapshot.hasError) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Text(
              readableError(
                snapshot.error!,
                fallback: 'Failed to load records from the server.',
              ),
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: Color(0xFFB91C1C),
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        );
      }
      if (!snapshot.hasData) {
        return const Center(child: CircularProgressIndicator());
      }
      final rows = snapshot.data!;
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionTitle(title, subtitle),
          const SizedBox(height: 16),
          PremiumCard(
            title: 'Today Records',
            subtitle: '${rows.length} synced record(s)',
            child: Column(
              children: [
                if (rows.isEmpty) EmptyText(empty),
                for (final row in rows.take(80))
                  builder(Map<String, dynamic>.from(row as Map)),
              ],
            ),
          ),
        ],
      );
    },
  );
}

class PremiumCard extends StatelessWidget {
  const PremiumCard({
    super.key,
    this.title,
    this.subtitle,
    required this.child,
    this.border,
    this.padding = const EdgeInsets.all(16),
  });
  final String? title;
  final String? subtitle;
  final Widget child;
  final Color? border;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(28),
    child: BackdropFilter(
      filter: ui.ImageFilter.blur(sigmaX: 18, sigmaY: 18),
      child: Container(
        width: double.infinity,
        padding: padding,
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: .96),
          borderRadius: BorderRadius.circular(28),
          border: Border.all(
            color: border?.withValues(alpha: .65) ?? const Color(0xFFDCE6E1),
          ),
          boxShadow: [
            BoxShadow(
              color: const Color(0xFF111827).withValues(alpha: .07),
              blurRadius: 16,
              offset: const Offset(0, 8),
            ),
            BoxShadow(
              color: Colors.white.withValues(alpha: .75),
              blurRadius: 8,
              offset: const Offset(-3, -3),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (title != null)
              Text(
                title!,
                style: const TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w900,
                  letterSpacing: -.25,
                  color: Color(0xFF0F211B),
                ),
              ),
            if (subtitle != null)
              Padding(
                padding: const EdgeInsets.only(top: 2, bottom: 12),
                child: Text(
                  subtitle!,
                  style: const TextStyle(
                    color: Color(0xFF667872),
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            child,
          ],
        ),
      ),
    ),
  );
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.title, this.subtitle, {super.key});
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 2, 4, 2),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.w900,
            letterSpacing: -.55,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          subtitle,
          style: const TextStyle(
            color: Color(0xFF667872),
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    ),
  );
}

class SchoolLogoAvatar extends StatelessWidget {
  const SchoolLogoAvatar(this.school, {super.key, this.size = 42});
  final Map school;
  final double size;

  @override
  Widget build(BuildContext context) {
    var logo = '';
    for (final key in ['logo', 'logo_url', 'logo_path', 'school_logo']) {
      final value = '${school[key] ?? ''}'.trim();
      if (value.isNotEmpty && value.toLowerCase() != 'null') {
        logo = value;
        break;
      }
    }
    final name = '${school['name'] ?? 'School'}';
    if (logo.isEmpty) return _fallback(name);
    if (logo.startsWith('data:image/')) {
      final commaIndex = logo.indexOf(',');
      if (commaIndex > 0) {
        try {
          return _logoFrame(
            Image.memory(
              base64Decode(logo.substring(commaIndex + 1)),
              fit: BoxFit.cover,
              errorBuilder: (context, error, stackTrace) => _fallback(name),
            ),
          );
        } catch (_) {
          return _fallback(name);
        }
      }
    }
    return _logoFrame(
      Image.network(
        absoluteUrl(logo),
        fit: BoxFit.cover,
        gaplessPlayback: true,
        filterQuality: FilterQuality.medium,
        loadingBuilder: (context, child, progress) =>
            progress == null ? child : _fallback(name),
        errorBuilder: (context, error, stackTrace) => _fallback(name),
      ),
    );
  }

  Widget _logoFrame(Widget child) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: Container(
        width: size,
        height: size,
        color: const Color(0xFFF1F5F3),
        child: child,
      ),
    );
  }

  Widget _fallback(String name) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: const Color(0xFFEAF7F1),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: const Color(0xFFD7EDE3)),
    ),
    alignment: Alignment.center,
    child: Text(
      initials(name),
      style: const TextStyle(
        color: Color(0xFF138A64),
        fontWeight: FontWeight.w900,
      ),
    ),
  );
}

class RecordTile extends StatelessWidget {
  const RecordTile({
    super.key,
    required this.title,
    required this.subtitle,
    required this.meta,
    this.onTap,
    this.color = const Color(0xFF00885B),
    this.leading,
    this.metaMaxLines = 3,
  });
  final String title;
  final String subtitle;
  final String meta;
  final VoidCallback? onTap;
  final Color color;
  final Widget? leading;
  final int metaMaxLines;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        constraints: const BoxConstraints(minHeight: 78),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: const Color(0xFFF9FBFA),
          borderRadius: BorderRadius.circular(19),
          border: Border.all(color: const Color(0xFFE4ECE8)),
        ),
        child: Row(
          children: [
            leading ??
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: .10),
                    borderRadius: BorderRadius.circular(15),
                  ),
                  child: Icon(
                    onTap == null
                        ? Icons.person_rounded
                        : Icons.chevron_right_rounded,
                    color: color,
                    size: 22,
                  ),
                ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontWeight: FontWeight.w900,
                      fontSize: 15,
                    ),
                  ),
                  if (subtitle.trim().isNotEmpty)
                    Text(
                      subtitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Color(0xFF52605C)),
                    ),
                  if (meta.trim().isNotEmpty)
                    Text(
                      meta,
                      maxLines: metaMaxLines,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: Color(0xFF6A7874),
                        fontWeight: FontWeight.w700,
                        fontSize: 12,
                      ),
                    ),
                ],
              ),
            ),
            if (onTap != null)
              Icon(Icons.arrow_forward_ios_rounded, size: 16, color: color),
          ],
        ),
      ),
    ),
  );
}

class Metric extends StatelessWidget {
  const Metric(
    this.icon,
    this.label,
    this.value,
    this.caption, {
    super.key,
    this.color = const Color(0xFF00885B),
    this.onTap,
  });
  final IconData icon;
  final String label;
  final String value;
  final String caption;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(23),
    child: ClipRRect(
      borderRadius: BorderRadius.circular(23),
      child: BackdropFilter(
        filter: ui.ImageFilter.blur(sigmaX: 14, sigmaY: 14),
        child: Container(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: .95),
            borderRadius: BorderRadius.circular(23),
            border: Border.all(color: const Color(0xFFDCE6E1)),
            boxShadow: [
              BoxShadow(
                color: const Color(0xFF111827).withValues(alpha: .06),
                blurRadius: 14,
                offset: const Offset(0, 6),
              ),
              BoxShadow(
                color: Colors.white.withValues(alpha: .70),
                blurRadius: 8,
                offset: const Offset(-3, -3),
              ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Container(
                    width: 38,
                    height: 38,
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: .11),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Icon(icon, color: color, size: 21),
                  ),
                  const Spacer(),
                  Text(
                    value,
                    style: const TextStyle(
                      fontWeight: FontWeight.w900,
                      fontSize: 26,
                      height: 1,
                      letterSpacing: -.5,
                    ),
                  ),
                ],
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontWeight: FontWeight.w900,
                      fontSize: 13,
                    ),
                  ),
                  Text(
                    caption,
                    style: const TextStyle(
                      color: Color(0xFF74827E),
                      fontSize: 10,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class Analytics extends StatelessWidget {
  const Analytics({super.key, required this.schools});
  final List schools;

  @override
  Widget build(BuildContext context) {
    final rates = schools
        .map((item) => intValue((item as Map)['rate']))
        .toList();
    final avg = rates.isEmpty
        ? 0
        : (rates.reduce((a, b) => a + b) / rates.length).round();
    return PremiumCard(
      title: 'Attendance Analytics',
      subtitle: 'Live school rate snapshot',
      child: Column(
        children: [
          InfoPill('Average rate', '$avg%'),
          const SizedBox(height: 8),
          for (final item in schools.take(5))
            RateBar(
              '${(item as Map)['name'] ?? 'School'}',
              intValue(item['rate']),
            ),
        ],
      ),
    );
  }
}

class RateBar extends StatelessWidget {
  const RateBar(this.name, this.rate, {super.key, this.color});
  final String name;
  final int rate;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final clamped = clampPercent(rate);
    final accent = color ?? attendanceScoreColor(clamped);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
              ),
              Text(
                '$clamped%',
                style: TextStyle(color: accent, fontWeight: FontWeight.w900),
              ),
            ],
          ),
          const SizedBox(height: 6),
          TweenAnimationBuilder<double>(
            tween: Tween<double>(begin: 0, end: clamped / 100),
            duration: const Duration(milliseconds: 650),
            curve: Curves.easeOutCubic,
            builder: (context, value, _) => ClipRRect(
              borderRadius: BorderRadius.circular(99),
              child: Stack(
                children: [
                  Container(
                    height: 9,
                    width: double.infinity,
                    color: const Color(0xFFE5EEE9),
                  ),
                  FractionallySizedBox(
                    widthFactor: value,
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 300),
                      height: 9,
                      color: accent,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class RingPainter extends CustomPainter {
  RingPainter(this.progress, {required this.color});
  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(size.width, size.height) / 2 - 12;
    final bg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 13
      ..strokeCap = StrokeCap.round
      ..color = color.withValues(alpha: .18);
    final fg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 13
      ..strokeCap = StrokeCap.round
      ..color = color;
    canvas.drawCircle(center, radius, bg);
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      math.pi * 2 * progress.clamp(0, 1),
      false,
      fg,
    );
  }

  @override
  bool shouldRepaint(RingPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.color != color;
}

class AlertStrip extends StatelessWidget {
  const AlertStrip(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: const Color(0xFFFFF8E8),
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: const Color(0xFFFBBF24)),
    ),
    child: Text(
      text,
      style: const TextStyle(
        color: Color(0xFF8D4700),
        fontWeight: FontWeight.w800,
      ),
    ),
  );
}

class InfoPill extends StatelessWidget {
  const InfoPill(this.label, this.value, {super.key});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: const Color(0xFFE8FAF3),
      borderRadius: BorderRadius.circular(14),
    ),
    child: Text(
      '$label: $value',
      style: const TextStyle(
        color: Color(0xFF00885B),
        fontWeight: FontWeight.w900,
      ),
    ),
  );
}

class EmptyText extends StatelessWidget {
  const EmptyText(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 18),
    child: Center(
      child: Text(text, style: const TextStyle(color: Color(0xFF667872))),
    ),
  );
}

class BackLine extends StatelessWidget {
  const BackLine(this.label, this.onTap, {super.key});
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextButton.icon(
      onPressed: onTap,
      icon: const Icon(Icons.arrow_back),
      label: Text(label),
    ),
  );
}

class DashboardSchoolArt extends StatelessWidget {
  const DashboardSchoolArt({super.key});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 132,
      height: 96,
      child: ValueListenableBuilder<String?>(
        valueListenable: dashboardSchoolArtData,
        builder: (context, data, _) {
          if (data != null && data.trim().isNotEmpty) {
            try {
              final value = data.trim();
              final comma = value.indexOf(',');
              final encoded = comma != -1 ? value.substring(comma + 1) : value;
              final bytes = base64Decode(encoded);
              return Image.memory(
                bytes,
                fit: BoxFit.contain,
                alignment: Alignment.bottomRight,
                gaplessPlayback: true,
                errorBuilder: (_, __, ___) => const _DefaultSchoolArt(),
              );
            } on FormatException {
              return const _DefaultSchoolArt();
            }
          }
          return const _DefaultSchoolArt();
        },
      ),
    );
  }
}

class _DefaultSchoolArt extends StatelessWidget {
  const _DefaultSchoolArt();

  @override
  Widget build(BuildContext context) {
    return CustomPaint(painter: _SchoolArtPainter());
  }
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

    canvas.drawOval(
      Rect.fromLTWH(6, size.height - 18, size.width - 12, 15),
      ground,
    );
    canvas.drawCircle(Offset(size.width * .18, size.height * .64), 20, mid);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(
          size.width * .16,
          size.height * .64,
          size.width * .08,
          size.height * .26,
        ),
        const Radius.circular(4),
      ),
      deep,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(
          size.width * .38,
          size.height * .40,
          size.width * .52,
          size.height * .42,
        ),
        const Radius.circular(5),
      ),
      mid,
    );

    final roof = Path()
      ..moveTo(size.width * .34, size.height * .42)
      ..lineTo(size.width * .64, size.height * .23)
      ..lineTo(size.width * .94, size.height * .42)
      ..close();
    canvas.drawPath(roof, deep);

    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(
          size.width * .58,
          size.height * .58,
          size.width * .14,
          size.height * .27,
        ),
        const Radius.circular(4),
      ),
      deep,
    );
    for (final x in [0.45, 0.78]) {
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(size.width * x, size.height * .54, 14, 17),
          const Radius.circular(2),
        ),
        pale,
      );
    }
    canvas.drawCircle(Offset(size.width * .65, size.height * .37), 16, pale);
    canvas.drawLine(
      Offset(size.width * .65, size.height * .28),
      Offset(size.width * .65, size.height * .08),
      deep..strokeWidth = 3,
    );
    final flag = Path()
      ..moveTo(size.width * .66, size.height * .08)
      ..lineTo(size.width * .82, size.height * .13)
      ..lineTo(size.width * .66, size.height * .18)
      ..close();
    canvas.drawPath(flag, green);
    canvas.drawOval(
      Rect.fromLTWH(size.width * .08, 6, size.width * .22, 9),
      sky,
    );
    canvas.drawOval(
      Rect.fromLTWH(size.width * .78, 15, size.width * .18, 8),
      sky,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

// Renders the live (admin-uploaded) logo when available, otherwise the bundled
// asset. Listens to [brandLogoData] so it swaps instantly when the logo changes.
class BrandLogoImage extends StatelessWidget {
  const BrandLogoImage({super.key, this.fit = BoxFit.contain});
  final BoxFit fit;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<String?>(
      valueListenable: brandLogoData,
      builder: (context, data, _) {
        if (data != null && data.trim().isNotEmpty) {
          try {
            final value = data.trim();
            final comma = value.indexOf(',');
            final encoded = comma != -1 ? value.substring(comma + 1) : value;
            final bytes = base64Decode(encoded);
            return Image.memory(
              bytes,
              fit: fit,
              gaplessPlayback: true,
              errorBuilder: (_, __, ___) =>
                  Image.asset(AppConfig.logoAsset, fit: fit),
            );
          } on FormatException {
            // Malformed data URL — fall back to the bundled asset below.
          }
        }
        return Image.asset(AppConfig.logoAsset, fit: fit);
      },
    );
  }
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
      boxShadow: [
        BoxShadow(
          color: const Color(0xFF0F6E52).withValues(alpha: .10),
          blurRadius: size * .18,
          offset: Offset(0, size * .06),
        ),
      ],
    ),
    child: const BrandLogoImage(),
  );
}

String readableError(
  Object error, {
  String fallback = 'Something went wrong. Please try again.',
}) {
  final text = '$error'.replaceFirst('Exception: ', '').trim();
  if (text.isEmpty) return fallback;
  final lower = text.toLowerCase();
  if (lower.contains('socketexception') ||
      lower.contains('clientexception') ||
      lower.contains('failed host lookup') ||
      lower.contains('connection timed out') ||
      lower.contains('connection refused') ||
      lower.contains('network is unreachable') ||
      lower.contains('connection error')) {
    return AppConfig.noInternetMessage;
  }
  if (lower.startsWith('<!doctype') || lower.startsWith('<html')) {
    return fallback;
  }
  return text;
}

String? adviserEmailFromRow(Map<String, dynamic> row) {
  for (final key in ['adviser_email', 'adviser_contact']) {
    final value = '${row[key] ?? ''}'.trim();
    if (value.contains('@')) return value;
  }
  return null;
}

String? adviserPhoneFromRow(Map<String, dynamic> row) {
  for (final key in ['adviser_contact']) {
    final value = '${row[key] ?? ''}'.trim();
    if (value.isEmpty || value.contains('@')) continue;
    final digits = value.replaceAll(RegExp(r'[^0-9+]'), '');
    if (digits.isNotEmpty) return digits;
  }
  return null;
}

int absenceDayCount(Map<String, dynamic> row) {
  final days = intValue(row['absent_days']);
  return days <= 0 ? 2 : days;
}

String alertEmailSubject(Map<String, dynamic> row) {
  final count = absenceDayCount(row);
  final unit = count == 1 ? 'Day' : 'Days';
  return 'Student Attendance Alert - $count $unit Absent';
}

String alertEmailBody(Map<String, dynamic> row) {
  final adviser = '${row['adviser'] ?? 'Adviser'}'.trim();
  final student = '${row['name'] ?? 'Student'}'.trim();
  final school = '${row['school_name'] ?? '-'}'.trim();
  final grade = '${row['grade_name'] ?? '-'}'.trim();
  final section = '${row['section_name'] ?? '-'}'.trim();
  final days = absenceDays(row);
  final adviserName = adviser.isEmpty || adviser == '-' ? 'Adviser' : adviser;
  final studentName = student.isEmpty || student == '-' ? 'Student' : student;

  return 'Good day, $adviserName.\n\n'
      'This is to inform you that the following student has been flagged for attendance monitoring due to consecutive absences.\n\n'
      'Student Name: $studentName\n'
      'School: $school\n'
      'Grade Level: $grade\n'
      'Section: $section\n'
      'Number of Days Absent: $days\n\n'
      "Please review and monitor the student's attendance accordingly.\n\n"
      'Thank you.';
}

Uri adviserEmailUri(String email, Map<String, dynamic> row) => Uri.parse(
  'mailto:$email?subject=${Uri.encodeComponent(alertEmailSubject(row))}'
  '&body=${Uri.encodeComponent(alertEmailBody(row))}',
);

Future<void> _showContactError(BuildContext context, String message) async {
  if (!context.mounted) return;
  final messenger = ScaffoldMessenger.maybeOf(context);
  messenger?.hideCurrentSnackBar();
  messenger?.showSnackBar(
    SnackBar(
      content: Text(message),
      behavior: SnackBarBehavior.floating,
      duration: const Duration(seconds: 3),
    ),
  );
}

Future<void> _launchContactUri(
  BuildContext context,
  Uri uri, {
  required String onFailure,
}) async {
  final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
  if (!launched) {
    if (!context.mounted) return;
    await _showContactError(context, onFailure);
  }
}

Future<void> contactAdviserViaCall(
  BuildContext context,
  Map<String, dynamic> row,
) async {
  final phone = adviserPhoneFromRow(row);
  if (phone == null) {
    await _showContactError(context, 'Adviser contact number is unavailable.');
    return;
  }
  await _launchContactUri(
    context,
    Uri(scheme: 'tel', path: phone),
    onFailure: 'Unable to open the phone dialer.',
  );
}

Future<void> contactAdviserViaSms(
  BuildContext context,
  Map<String, dynamic> row,
) async {
  final phone = adviserPhoneFromRow(row);
  if (phone == null) {
    await _showContactError(context, 'Adviser contact number is unavailable.');
    return;
  }
  await _launchContactUri(
    context,
    Uri(scheme: 'sms', path: phone),
    onFailure: 'Unable to open the SMS app.',
  );
}

Future<void> contactAdviserViaEmail(
  BuildContext context,
  Map<String, dynamic> row,
) async {
  final email = adviserEmailFromRow(row);
  if (email == null) {
    await _showContactError(context, 'Adviser email address is unavailable.');
    return;
  }
  await _launchContactUri(
    context,
    adviserEmailUri(email, row),
    onFailure: 'Unable to open the email app.',
  );
}

Future<void> contactAdviserAlertViaSms(
  BuildContext context,
  Map<String, dynamic> row,
) async {
  final phone = adviserPhoneFromRow(row);
  if (phone == null) {
    await _showContactError(context, 'Adviser contact number is unavailable.');
    return;
  }
  await _launchContactUri(
    context,
    Uri(scheme: 'sms', path: phone),
    onFailure: 'Unable to open the SMS app.',
  );
}

Future<void> contactAdviserAlertViaEmail(
  BuildContext context,
  Map<String, dynamic> row,
) async {
  final email = adviserEmailFromRow(row);
  if (email == null) {
    await _showContactError(context, 'Adviser email address is unavailable.');
    return;
  }
  await _launchContactUri(
    context,
    adviserEmailUri(email, row),
    onFailure: 'Unable to open the email app.',
  );
}

Future<void> notifyAbsenceFlags(List flags, SharedPreferences prefs) async {
  final today = date();
  final storeKey = 'absence_notified_flags_$today';
  final notified = (prefs.getStringList(storeKey) ?? <String>[]).toSet();
  final currentKeys = <String>{};
  var changed = false;

  for (final item in flags) {
    final row = Map<String, dynamic>.from(item as Map);
    currentKeys.add(absenceFlagNotificationKey(row, today));
  }

  for (final staleKey in notified.difference(currentKeys).toList()) {
    await notifications.cancel(stableNotificationId(staleKey));
    notified.remove(staleKey);
    changed = true;
  }

  for (final item in flags) {
    final row = Map<String, dynamic>.from(item as Map);
    final key = absenceFlagNotificationKey(row, today);
    if (notified.contains(key)) continue;
    final sent = await showLocalNotification(
      '2-Day Absence Alert',
      absenceBody(row),
      id: stableNotificationId(key),
      payload: absenceNotificationPayload([row]),
      actions: const [
        AndroidNotificationAction('view', 'View', showsUserInterface: true),
        AndroidNotificationAction(
          'contact_adviser',
          'Contact Adviser',
          showsUserInterface: true,
        ),
      ],
      showToast: false,
    );
    if (sent) {
      notified.add(key);
      changed = true;
    }
  }

  if (changed) await prefs.setStringList(storeKey, notified.toList());
}

Future<bool> launchContactActionFromIntent(Map<String, dynamic> intent) async {
  if ('${intent['action']}' != 'contact') return false;
  final rowData = intent['row'];
  if (rowData is! Map) return false;
  final row = Map<String, dynamic>.from(rowData);
  final phone = adviserPhoneFromRow(row);
  if (phone == null || phone.trim().isEmpty) return false;
  return launchUrl(
    Uri(scheme: 'tel', path: phone),
    mode: LaunchMode.externalApplication,
  );
}

Future<void> openNotificationDestination(
  String? payload, {
  String? actionId,
}) async {
  final parsedIntent = notificationIntentFromPayload(
    payload,
    actionId: actionId,
  );
  if (parsedIntent == null) return;
  var intent = Map<String, dynamic>.from(parsedIntent);
  if (await launchContactActionFromIntent(intent)) {
    intent = {...intent, 'action': 'handled'};
  }
  pendingAlertIntent = intent;
  final prefs = await SharedPreferences.getInstance();
  final api = ApiService(prefs);
  final navigator = appNavigatorKey.currentState;
  if (navigator == null) return;
  navigator.pushAndRemoveUntil(
    MaterialPageRoute(
      builder: (_) => api.isLoggedIn
          ? HomeShell(api: api, initialTab: 4, initialAlertIntent: intent)
          : LoginScreen(api: api),
    ),
    (_) => false,
  );
}

Future<bool> ensureNotificationPermission() async {
  final android = notifications
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();
  return await android?.requestNotificationsPermission() ?? true;
}

Future<bool> showLocalNotification(
  String title,
  String body, {
  int? id,
  String? payload,
  List<AndroidNotificationAction>? actions,
  bool showToast = true,
}) async {
  final granted = await ensureNotificationPermission();
  if (!granted) return false;
  final android = AndroidNotificationDetails(
    'edutrack_alerts',
    'Edutrack Alerts',
    channelDescription: 'Attendance monitoring alerts',
    importance: Importance.high,
    priority: Priority.high,
    category: AndroidNotificationCategory.status,
    visibility: NotificationVisibility.public,
    ticker: 'Edutrack attendance alert',
    actions: actions,
    styleInformation: BigTextStyleInformation(
      '<b>$body</b>',
      htmlFormatBigText: true,
      contentTitle: '<b>$title</b>',
      htmlFormatContentTitle: true,
    ),
  );
  await notifications.show(
    id ?? (DateTime.now().microsecondsSinceEpoch % 2147483647),
    title,
    body,
    NotificationDetails(android: android),
    payload: payload,
  );
  return true;
}

String absenceTitle(int count) => count == 1
    ? '1 Student Flagged for Absence'
    : '$count Students Flagged for Absence';

String absenceBody(Map<String, dynamic> row, {int count = 1}) {
  final student = '${row['name'] ?? 'Student'}';
  final gradeSection =
      '${row['grade_name'] ?? '-'} - ${row['section_name'] ?? '-'}';
  final school = '${row['school_name'] ?? '-'}';
  final days = absenceDays(row);
  return '$student\n$gradeSection | $school\n$days Absent';
}

// ── Daily 7 PM Summary Notification ─────────────────────────────────────────

const _kDailySummaryId = 9001;
const _kDailySummaryFallbackId = 9002;
const _kPhManila = 'Asia/Manila';

tz.TZDateTime _nextSevenPM() {
  final loc = tz.getLocation(_kPhManila);
  final now = tz.TZDateTime.now(loc);
  var target = tz.TZDateTime(loc, now.year, now.month, now.day, 19, 0, 0);
  if (!target.isAfter(now)) target = target.add(const Duration(days: 1));
  return target;
}

String _weekdayShortName(int weekday) =>
    const ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekday - 1];

String _readableReportDate(DateTime now) {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return '${_weekdayShortName(now.weekday)}, ${months[now.month - 1]} ${now.day}';
}

const _kAiAssistantName = 'SDO Sipalay AI Assistant';
const _kDailyReportTitle = '$_kAiAssistantName · Daily Report';

// Decodes the admin-uploaded notification icon (a base64 data URL cached in
// prefs as 'ai_report_icon') to a file and returns it as a notification large
// icon. Returns null when no icon is set, so the app icon is used instead.
Future<AndroidBitmap<Object>?> _aiReportLargeIcon(
  SharedPreferences prefs,
) async {
  final dataUrl = (prefs.getString('ai_report_icon') ?? '').trim();
  if (dataUrl.isEmpty) return null;
  try {
    final commaIdx = dataUrl.indexOf(',');
    final b64 = commaIdx >= 0 ? dataUrl.substring(commaIdx + 1) : dataUrl;
    final bytes = base64Decode(b64);
    final file = File('${Directory.systemTemp.path}/ai_report_icon.png');
    await file.writeAsBytes(bytes, flush: true);
    return FilePathAndroidBitmap(file.path);
  } on Exception {
    return null;
  }
}

// Builds and shows the daily attendance report notification. Shared by the
// live 7 PM trigger and the in-app test button so the layout stays identical.
Future<void> _showDailyReportNotification(
  Map<String, dynamic> data,
  SharedPreferences prefs, {
  bool isTest = false,
}) async {
  final now = DateTime.now();
  final largeIcon = await _aiReportLargeIcon(prefs);
  final suffix = isTest ? ' · TEST' : '';
  final dateLine = _readableReportDate(now);
  final isWeekend =
      now.weekday == DateTime.saturday || now.weekday == DateTime.sunday;

  if (isWeekend) {
    final dayName = now.weekday == DateTime.saturday ? 'Saturday' : 'Sunday';
    await notifications.show(
      _kDailySummaryId,
      '$_kDailyReportTitle$suffix',
      'No classes today ($dayName) — attendance reports resume Monday.',
      NotificationDetails(
        android: AndroidNotificationDetails(
          dailySummaryChannel.id,
          dailySummaryChannel.name,
          importance: Importance.high,
          priority: Priority.high,
          visibility: NotificationVisibility.public,
          largeIcon: largeIcon,
          styleInformation: BigTextStyleInformation(
            'No classes today ($dayName).<br>'
            'Attendance reports resume on Monday.',
            htmlFormatBigText: true,
            contentTitle: '<b>$_kAiAssistantName · Weekend</b>',
            htmlFormatContentTitle: true,
            summaryText: dateLine,
            htmlFormatSummaryText: true,
          ),
        ),
      ),
    );
    return;
  }

  final studPresent = intValue(data['students_present']);
  final studAbsent = intValue(data['students_absent']);
  final studLate = intValue(data['students_late']);
  final studHalfDay = intValue(data['students_half_day']);
  final tchPresent = intValue(data['teachers_present']);
  final tchAbsent = intValue(data['teachers_absent']);
  final rate = intValue(data['attendance_rate']);

  final collapsed =
      '$rate% attendance · $studPresent present, $studAbsent absent';
  final bigText =
      '<b>👨‍🎓 Students</b><br>'
      'Present: $studPresent&nbsp;&nbsp;Absent: $studAbsent<br>'
      'Late: $studLate&nbsp;&nbsp;Half-day: $studHalfDay<br>'
      '<br>'
      '<b>🧑‍🏫 Teachers</b><br>'
      'Present: $tchPresent&nbsp;&nbsp;Absent: $tchAbsent<br>'
      '<br>'
      '<b>📈 Attendance Rate: $rate%</b>';

  await notifications.show(
    _kDailySummaryId,
    '$_kDailyReportTitle$suffix',
    collapsed,
    NotificationDetails(
      android: AndroidNotificationDetails(
        dailySummaryChannel.id,
        dailySummaryChannel.name,
        importance: Importance.high,
        priority: Priority.high,
        visibility: NotificationVisibility.public,
        largeIcon: largeIcon,
        styleInformation: BigTextStyleInformation(
          bigText,
          htmlFormatBigText: true,
          contentTitle: '<b>$_kDailyReportTitle</b>',
          htmlFormatContentTitle: true,
          summaryText: dateLine,
          htmlFormatSummaryText: true,
        ),
      ),
    ),
  );
}

Future<void> scheduleDailyFallbackNotification() async {
  final granted = await ensureNotificationPermission();
  if (!granted) return;
  try {
    final prefs = await SharedPreferences.getInstance();
    final largeIcon = await _aiReportLargeIcon(prefs);
    // Fires every day at 7 PM as a fallback when the app is closed.
    // When the app IS open at 7 PM, checkAndShowEveningReport() cancels this
    // and replaces it with a rich notification that includes live counts.
    await notifications.zonedSchedule(
      _kDailySummaryFallbackId,
      _kDailyReportTitle,
      'Today\'s attendance summary is ready. Open the app to view details.',
      _nextSevenPM(),
      NotificationDetails(
        android: AndroidNotificationDetails(
          dailySummaryChannel.id,
          dailySummaryChannel.name,
          channelDescription: dailySummaryChannel.description,
          importance: Importance.high,
          priority: Priority.high,
          visibility: NotificationVisibility.public,
          largeIcon: largeIcon,
          styleInformation: const BigTextStyleInformation(
            '<b>Today\'s attendance summary is ready. Open the app to view details.</b>',
            htmlFormatBigText: true,
            contentTitle: '<b>Daily Attendance Summary</b>',
            htmlFormatContentTitle: true,
          ),
        ),
      ),
      androidScheduleMode: AndroidScheduleMode.exactAllowWhileIdle,
      matchDateTimeComponents: DateTimeComponents.time,
    );
  } catch (_) {}
}

Future<void> checkAndShowEveningReport(
  Map<String, dynamic> dashboardData,
  SharedPreferences prefs,
) async {
  final now = DateTime.now();
  if (now.hour != 19 || now.minute != 0) return;

  final todayKey =
      'evening_report_${now.year}_${('${now.month}'.padLeft(2, '0'))}_${('${now.day}'.padLeft(2, '0'))}';
  if (prefs.getBool(todayKey) == true) return;
  await prefs.setBool(todayKey, true);

  // Cancel the static fallback — we'll show a richer notification instead.
  await notifications.cancel(_kDailySummaryFallbackId);
  await _showDailyReportNotification(dashboardData, prefs);
}

// Bypasses the 7 PM time check and the daily dedup key so you can fire the
// notification immediately for testing without waiting until actual 7 PM.
Future<void> testEveningReportNotification(
  Map<String, dynamic> dashboardData,
  SharedPreferences prefs,
) async {
  final granted = await ensureNotificationPermission();
  if (!granted) return;
  await notifications.cancel(_kDailySummaryFallbackId);
  await _showDailyReportNotification(dashboardData, prefs, isTest: true);
}

String absenceFlagNotificationKey(Map<String, dynamic> row, String day) {
  final personType = '${row['person_type'] ?? 'student'}'.trim();
  final id = '${row['id'] ?? row['lrn'] ?? row['name'] ?? ''}'.trim();
  final school = '${row['school_name'] ?? ''}'.trim();
  final days = absenceDayCount(row);
  return '$day|$personType|$id|$school|$days';
}

int stableNotificationId(String value) {
  var hash = 17;
  for (final unit in value.codeUnits) {
    hash = ((hash * 31) + unit) & 0x7fffffff;
  }
  return 100000 + (hash % 2000000000);
}

String absenceNotificationPayload(List flags) {
  final first = flags.isNotEmpty
      ? Map<String, dynamic>.from(flags.first as Map)
      : <String, dynamic>{};
  final row = {
    'id': first['id'],
    'name': first['name'],
    'lrn': first['lrn'],
    'school_name': first['school_name'],
    'school_logo': first['school_logo'],
    'grade_name': first['grade_name'],
    'section_name': first['section_name'],
    'absent_days': first['absent_days'],
    'attendance_status': formatStatusLabel(
      first['attendance_status'] ?? 'Absent',
    ),
    'adviser': first['adviser'],
    'adviser_contact': first['adviser_contact'],
    'adviser_email': first['adviser_email'],
  };
  return jsonEncode({
    'type': 'absence_alert',
    'count': flags.length,
    'row': row,
  });
}

Map<String, dynamic>? notificationIntentFromPayload(
  String? payload, {
  String? actionId,
}) {
  if (payload == null || payload.trim().isEmpty) return null;
  if (payload == 'alerts') {
    return {'type': 'absence_alert', 'action': 'view'};
  }
  try {
    final decoded = jsonDecode(payload);
    if (decoded is! Map) return null;
    final map = Map<String, dynamic>.from(decoded);
    if ('${map['type']}' != 'absence_alert') return null;
    final action = actionId == 'contact_adviser' ? 'contact' : 'view';
    return {...map, 'action': action};
  } catch (_) {
    return null;
  }
}

String? notificationIntentKey(Map<String, dynamic>? intent) {
  if (intent == null) return null;
  try {
    return jsonEncode(intent);
  } catch (_) {
    return '${intent['type']}:${intent['action']}';
  }
}

String absenceDays(Map<String, dynamic> row) {
  final count = absenceDayCount(row);
  return count == 1 ? '1 day' : '$count days';
}

String safeReason(dynamic value) {
  final clean = '${value ?? ''}'.trim();
  return clean.isEmpty || RegExp(r'^[A-Za-z]+$').hasMatch(clean)
      ? 'No classes today. Attendance data is shown for reference only.'
      : clean;
}

String adviserText(Map row) {
  final adviser = '${row['adviser'] ?? ''}'.trim();
  return adviser.isEmpty ? 'No adviser assigned' : 'Adviser: $adviser';
}

String studentName(dynamic student) {
  final row = student as Map;
  final name = '${row['firstname'] ?? ''} ${row['lastname'] ?? ''}'.trim();
  return name.isEmpty ? 'Student' : name;
}

int countStudents(dynamic grade) =>
    (((grade as Map)['sections'] as List?) ?? []).fold<int>(
      0,
      (sum, section) =>
          sum + (((section as Map)['students'] as List?) ?? []).length,
    );

String absoluteUrl(String path) {
  var clean = path.trim().replaceAll('\\', '/');
  if (clean.isEmpty) return clean;
  if (clean.startsWith('public/')) clean = clean.substring(6);
  if (clean.startsWith('http://') ||
      clean.startsWith('https://') ||
      clean.startsWith('data:image/')) {
    return clean;
  }
  if (clean.startsWith('/')) return '${AppConfig.baseUrl}$clean';
  return '${AppConfig.baseUrl}/$clean';
}

String initials(String text) {
  final parts = text
      .trim()
      .split(RegExp(r'\s+'))
      .where((part) => part.isNotEmpty)
      .toList();
  if (parts.isEmpty) return 'S';
  if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
  return '${parts[0][0]}${parts[1][0]}'.toUpperCase();
}

String roleLabel(String role) {
  switch (role) {
    case 'super_admin':
      return 'Super Administrator';
    case 'superintendent':
      return 'SDS';
    case 'asst_superintendent':
      return 'ASDS';
    case 'principal':
      return 'School Administrator';
    default:
      return role.trim().isEmpty
          ? 'User'
          : role.replaceAll('_', ' ').toUpperCase();
  }
}

int intValue(dynamic value) => int.tryParse('$value') ?? 0;

int clampPercent(int value) => value.clamp(0, 100).toInt();

Color attendanceScoreColor(int rate) {
  final clamped = clampPercent(rate);
  if (clamped >= 90) return const Color(0xFF138A64);
  if (clamped >= 75) return const Color(0xFFD97706);
  if (clamped >= 50) return const Color(0xFFF97316);
  return const Color(0xFFDC2626);
}

Color attendanceScoreSoftColor(int rate) {
  final clamped = clampPercent(rate);
  if (clamped >= 90) return const Color(0xFFDDF7EA);
  if (clamped >= 75) return const Color(0xFFFFF3C4);
  if (clamped >= 50) return const Color(0xFFFFE2C7);
  return const Color(0xFFFFD7D7);
}

String attendanceScoreLabel(int rate) {
  final clamped = clampPercent(rate);
  if (clamped >= 90) return 'Excellent Attendance';
  if (clamped >= 75) return 'Good Attendance';
  if (clamped >= 50) return 'Fair Attendance';
  return 'Poor Attendance';
}

String statusKey(dynamic value) => '${value ?? ''}'
    .trim()
    .toLowerCase()
    .replaceAll(RegExp(r'[\s-]+'), '_');

String formatStatusLabel(dynamic value) {
  final raw = '${value ?? ''}'.trim();
  if (raw.isEmpty || raw.toLowerCase() == 'null') return '-';
  switch (statusKey(raw).replaceAll('_', ' ')) {
    case 'present':
      return 'Present';
    case 'absent':
      return 'Absent';
    case 'late':
      return 'Late';
    case 'half day':
      return 'Half-Day';
    case 'half day pm':
      return 'Half-Day PM';
    case 'half day pm late':
      return 'Half-Day PM Late';
    case 'half day am':
      return 'Half-Day AM';
    case 'half day am early dismissal':
      return 'Half-Day AM Early Dismissal';
    case 'half day pm early dismissal':
      return 'Half-Day PM Early Dismissal';
    case 'completed':
      return 'Completed';
    case 'returned':
      return 'Returned';
    case 'lunch out':
      return 'Lunch Out';
    case 'attendance closed':
      return 'Attendance Closed';
    case 'inactive':
      return 'Inactive';
    case 'active':
      return 'Active';
    case 'flagged':
      return 'Flagged';
    case 'pending time out':
      return 'Pending Time Out';
    case 'no time out':
      return 'No Time Out';
    case 'no time in':
      return 'No Time In';
    case 'complete':
      return 'Complete';
    default:
      return raw
          .split(RegExp(r'[\s_-]+'))
          .where((part) => part.isNotEmpty)
          .map(
            (part) => part[0].toUpperCase() + part.substring(1).toLowerCase(),
          )
          .join(' ');
  }
}

String settingValue(
  Map<String, dynamic> settings,
  String key,
  String fallback,
) {
  final value = '${settings[key] ?? ''}'.trim();
  if (value.isEmpty || value.toLowerCase() == 'null') return fallback;
  return value;
}

String settingTime(
  Map<String, dynamic> settings,
  String key, {
  required String fallback,
}) {
  var value = settingValue(settings, key, fallback).trim();
  if (value.contains('T')) value = value.split('T').last;
  if (RegExp(r'^\d{2}:\d{2}:\d{2}$').hasMatch(value)) {
    return value.substring(0, 5);
  }
  if (RegExp(r'^\d{2}:\d{2}$').hasMatch(value)) return value;
  return fallback;
}

bool settingEnabled(
  Map<String, dynamic> settings,
  String key, {
  required bool fallback,
}) {
  final value = '${settings[key] ?? ''}'.trim().toLowerCase();
  if (value.isEmpty || value == 'null') return fallback;
  return ['1', 'true', 'yes', 'enabled', 'on'].contains(value);
}

List<String> weekdayDatesOfWeek(String baseDate) {
  final base = DateTime.tryParse(baseDate) ?? DateTime.now();
  final monday = base.subtract(Duration(days: base.weekday - 1));
  return List.generate(5, (index) {
    final d = monday.add(Duration(days: index));
    return '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
  });
}

String weekdayShort(String dayDate) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  final parsed = DateTime.tryParse(dayDate);
  if (parsed == null) return '-';
  return days[parsed.weekday - 1];
}

int dayOfMonth(String dayDate) => DateTime.tryParse(dayDate)?.day ?? 0;

String date() {
  final now = DateTime.now();
  return '${now.year.toString().padLeft(4, '0')}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
}

String shortDate() {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  final now = DateTime.now();
  return '${days[now.weekday - 1]}, ${months[now.month - 1]} ${now.day}';
}

String fullDate() {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const days = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ];
  final now = DateTime.now();
  return '${days[now.weekday - 1]}, ${months[now.month - 1]} ${now.day}, ${now.year}';
}

String readableDate(String dayDate) {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const days = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ];
  final parsed = DateTime.tryParse(dayDate);
  if (parsed == null) return dayDate;
  return '${days[parsed.weekday - 1]}, ${months[parsed.month - 1]} ${parsed.day}, ${parsed.year}';
}

String greeting() {
  final hour = DateTime.now().hour;
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
