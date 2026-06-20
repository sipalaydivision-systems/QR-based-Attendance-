import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

final FlutterLocalNotificationsPlugin _notifications = FlutterLocalNotificationsPlugin();
const AndroidNotificationChannel _channel = AndroidNotificationChannel(
  'edutrack_parent',
  'EduTrack Parent',
  description: 'Attendance alerts for your child',
  importance: Importance.high,
);

Future<void> _initNotifications() async {
  const android = AndroidInitializationSettings('@mipmap/ic_launcher');
  await _notifications.initialize(const InitializationSettings(android: android));
  final impl = _notifications.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
  await impl?.createNotificationChannel(_channel);
  await impl?.requestNotificationsPermission();
}

Future<void> showParentNotification(String title, String body) async {
  await _notifications.show(
    DateTime.now().millisecondsSinceEpoch.remainder(100000),
    title,
    body,
    const NotificationDetails(
      android: AndroidNotificationDetails(
        'edutrack_parent',
        'EduTrack Parent',
        channelDescription: 'Attendance alerts for your child',
        importance: Importance.high,
        priority: Priority.high,
        icon: '@mipmap/ic_launcher',
        largeIcon: DrawableResourceAndroidBitmap('@mipmap/ic_launcher'),
      ),
    ),
  );
}

const String kBaseUrl = 'https://sdo-sipalay-edutrack.up.railway.app';
const String kAppName = 'EduTrack';
const String kSubtitle = 'Schools Division of Sipalay City';
const String kMonitoringLabel = 'Parent Attendance Monitor';
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

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await _initNotifications();
  } catch (_) {/* notifications are best-effort */}
  final prefs = await SharedPreferences.getInstance();
  runApp(ParentApp(api: ParentApi(prefs)));
}

// ---------------------------------------------------------------------------
// API — cookie-based session auth against the EduTrack parent endpoints.
// ---------------------------------------------------------------------------
class ParentApi {
  ParentApi(this.prefs);
  final SharedPreferences prefs;

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

  Future<void> registerDeviceToken() async {
    if (!isLoggedIn) return;
    try {
      final info = await PackageInfo.fromPlatform();
      final token = await ensureDeviceToken();
      await http
          .post(Uri.parse('$kBaseUrl/api/parent/device-token'), headers: _headers, body: {
            'device_token': token,
            'platform': Platform.isAndroid ? 'android' : Platform.operatingSystem,
            'app_version': info.version,
          })
          .timeout(const Duration(seconds: 15));
    } catch (_) {
      // Device registration is retried on the next dashboard refresh.
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

  Future<void> logout() async {
    try {
      await http
          .post(Uri.parse('$kBaseUrl/api/parent/logout'), headers: _headers)
          .timeout(const Duration(seconds: 10));
    } catch (_) {/* ignore */}
    await prefs.remove('cookie');
    await prefs.remove('parent_name');
    await prefs.remove('parent_contact');
    await prefs.remove('parent_username');
    await prefs.remove('parent_notified_notifications');
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
      title: 'EduTrack Parent',
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
                            LiveDot(color: Colors.white, size: 8),
                            SizedBox(width: 7),
                            Text('Preparing parent dashboard', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 12.5)),
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
                                const Expanded(child: Text('Securely loading records', style: TextStyle(color: kInk, fontWeight: FontWeight.w900))),
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
        child: Image.asset('assets/images/app_logo.png', fit: BoxFit.contain),
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
      } catch (_) {}
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => HomeShell(api: widget.api, showWelcome: true)));
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
                subtitle: 'Parent Portal',
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
                  const Text('For registered parents/guardians only', style: TextStyle(color: Color(0xFF9CA3AF), fontSize: 11.5)),
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
      } catch (_) {}
      Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => HomeShell(api: widget.api, showWelcome: true)), (r) => false);
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
  const HomeShell({super.key, required this.api, this.showWelcome = false});
  final ParentApi api;
  final bool showWelcome;
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
  String? _schoolArt;
  int _unreadCount = 0;
  Map<String, dynamic>? _bannerNote;
  Map<String, dynamic> _data = {};
  Timer? _timer;
  Timer? _bannerTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.api.registerDeviceToken();
    if (widget.showWelcome) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _showWelcomeBanner());
    }
    _load();
    _loadBranding();
    _timer = Timer.periodic(const Duration(seconds: 20), (_) => _load(silent: true));
  }

  Future<void> _loadBranding() async {
    final b = await widget.api.branding();
    if (!mounted) return;
    final art = '${b['mobile_dashboard_school_art'] ?? ''}';
    if (art.isNotEmpty) setState(() => _schoolArt = art);
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

  bool _isImportant(Map<String, dynamic> note) {
    final type = '${note['type'] ?? ''}'.toLowerCase();
    return type.contains('emergency') || type.contains('early') || type.contains('absent') || type.contains('flagged');
  }

  Future<void> _processNotificationUpdates(Map<String, dynamic> data, {required bool showPopups}) async {
    final notes = ((data['notifications'] as List?) ?? const [])
        .whereType<Map>()
        .map((n) => Map<String, dynamic>.from(n))
        .toList();
    final notified = (widget.api.prefs.getStringList('parent_notified_notifications') ?? const <String>[]).toSet();
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
    await widget.api.prefs.setStringList('parent_notified_notifications', notified.take(150).toList());
  }

  Future<void> _showNotificationPopup(Map<String, dynamic> note) async {
    final title = '${note['title'] ?? 'EduTrack Parent'}';
    final body = '${note['message'] ?? ''}';
    try {
      await showParentNotification(title, body);
    } catch (_) {}
    if (!mounted) return;
    setState(() => _bannerNote = note);
    _bannerTimer?.cancel();
    _bannerTimer = Timer(const Duration(seconds: 7), () {
      if (mounted) setState(() => _bannerNote = null);
    });
    if (_isImportant(note)) {
      Future.delayed(const Duration(milliseconds: 250), () {
        if (!mounted) return;
        showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: Text(title, style: const TextStyle(fontWeight: FontWeight.w900)),
            content: Text(body),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Close')),
              TextButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  setState(() => _tab = 3);
                },
                child: const Text('Contact Adviser'),
              ),
            ],
          ),
        );
      });
    }
  }

  Future<void> _showWelcomeBanner() async {
    final note = {
      'type': 'welcome',
      'title': 'Welcome to EduTrack Parent',
      'message': '${greeting()}, ${widget.api.parentName}. Your child attendance dashboard is ready.',
    };
    try {
      await showParentNotification('Welcome to EduTrack Parent', 'Your child attendance dashboard is ready.');
    } catch (_) {}
    if (!mounted) return;
    setState(() => _bannerNote = note);
    _bannerTimer?.cancel();
    _bannerTimer = Timer(const Duration(seconds: 6), () {
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
              ParentHeader(onLogout: _confirmLogout, compact: _headerCompact),
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
          child: _emptyState(_error != null ? Icons.wifi_off : Icons.child_care,
              _error ?? 'No linked students found for your contact number. Please contact the school adviser.'),
        ),
      ]);
    }
    switch (_tab) {
      case 1:
        return AttendanceTab(child: _selectedChild!, picker: _childPicker());
      case 2:
        return NotificationsTab(notifications: _notifications);
      case 3:
        return AdviserTab(child: _selectedChild!, picker: _childPicker());
      case 4:
        return ProfileTab(api: widget.api, childCount: _children.length, onLogout: _confirmLogout);
      default:
        return HomeTab(parentName: widget.api.parentName, children: _children, selected: _child, picker: _childPicker(), schoolArt: _schoolArt);
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

class ParentNotificationBanner extends StatelessWidget {
  const ParentNotificationBanner({super.key, required this.note, required this.onTap, required this.onClose});
  final Map<String, dynamic> note;
  final VoidCallback onTap;
  final VoidCallback onClose;

  bool get important {
    final type = '${note['type'] ?? ''}'.toLowerCase();
    return type.contains('emergency') || type.contains('early') || type.contains('absent') || type.contains('flagged');
  }

  @override
  Widget build(BuildContext context) {
    final color = important ? const Color(0xFFDC2626) : kGreen;
    final isWelcome = '${note['type'] ?? ''}'.toLowerCase() == 'welcome';
    return Material(
      elevation: 12,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(18),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: color.withValues(alpha: .28)),
            boxShadow: [BoxShadow(color: color.withValues(alpha: .18), blurRadius: 20, offset: const Offset(0, 8))],
          ),
          child: Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(color: color.withValues(alpha: .12), borderRadius: BorderRadius.circular(14)),
                child: isWelcome
                    ? const Center(child: AppLogo(size: 34))
                    : Icon(important ? Icons.warning_amber_rounded : Icons.notifications_active_rounded, color: color),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('${note['title'] ?? 'EduTrack Parent'}', maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w900, color: kInk)),
                    const SizedBox(height: 2),
                    Text('${note['message'] ?? ''}', maxLines: 2, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: kMuted)),
                    const SizedBox(height: 4),
                    Text('Tap to open full details', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, color: color)),
                  ],
                ),
              ),
              IconButton(onPressed: onClose, icon: const Icon(Icons.close_rounded, size: 18), color: kMuted),
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
  const ParentHeader({super.key, required this.onLogout, required this.compact});
  final VoidCallback onLogout;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final sealSize = compact ? 42.0 : 52.0;
    final actionSize = compact ? 40.0 : 44.0;
    final radius = compact ? 20.0 : 26.0;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 240),
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
                      _headerAction(Icons.logout_rounded, onLogout, actionSize),
                    ],
                  ),
                  SizedBox(height: compact ? 9 : 14),
                  Row(
                    children: [
                      _chip(Row(mainAxisSize: MainAxisSize.min, children: [
                        LiveDot(color: const Color(0xFFFF3B30), size: compact ? 8 : 9),
                        const SizedBox(width: 6),
                        Text('LIVE', style: TextStyle(color: const Color(0xFFE5403A), fontWeight: FontWeight.w900, fontSize: compact ? 10.5 : 11.5)),
                      ]), dense: compact),
                      const SizedBox(width: 8),
                      _chip(Text(shortDateString()), dense: true, fontSize: compact ? 10.5 : 11.5),
                      const SizedBox(width: 8),
                      Flexible(child: _chip(Text(isoDateString()), dense: true, fontSize: compact ? 10.5 : 11.5)),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _seal(double size) => Container(
        width: size,
        height: size,
        padding: EdgeInsets.all(size * .115),
        decoration: BoxDecoration(
          color: Colors.white,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white.withValues(alpha: .45), width: 3),
          boxShadow: [BoxShadow(color: const Color(0xFF06301F).withValues(alpha: .28), blurRadius: 12, offset: const Offset(0, 4))],
        ),
        child: ClipOval(child: Image.asset('assets/images/app_logo.png', fit: BoxFit.contain)),
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
  const HomeTab({super.key, required this.parentName, required this.children, required this.selected, this.picker, this.schoolArt});
  final String parentName;
  final List<dynamic> children;
  final int selected;
  final Widget? picker;
  final String? schoolArt;

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
                  SizedBox(width: 124, height: 92, child: SchoolArt(data: schoolArt)),
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
            return Container(
              margin: const EdgeInsets.only(bottom: 10),
              decoration: _cardDecoration(),
              child: ListTile(
                leading: CircleAvatar(backgroundColor: toneColor(tone).withValues(alpha: 0.12), child: Icon(toneIcon(tone), color: toneColor(tone), size: 20)),
                title: Text('${entry['label_display'] ?? entry['label']}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5, color: kInk)),
                subtitle: Text('${entry['time_display'] ?? ''}', style: const TextStyle(fontSize: 12, color: kMuted)),
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
  if (type.contains('meeting')) return Icons.groups_rounded;
  if (type.contains('holiday')) return Icons.event_busy_rounded;
  if (type.contains('emergency')) return Icons.warning_amber_rounded;
  if (type.contains('absent') || type.contains('flagged') || type.contains('early')) return Icons.report_problem_rounded;
  if (type.contains('lunch')) return Icons.restaurant_rounded;
  if (type.contains('completed')) return Icons.task_alt_rounded;
  if (type.contains('announcement') || type.contains('reminder') || type.contains('event')) return Icons.campaign_rounded;
  return Icons.login_rounded;
}

String parentNotificationTime(Map<String, dynamic> note) {
  final display = '${note['time_display'] ?? ''}'.trim();
  if (display.isNotEmpty && display != 'null') return display;
  final raw = '${note['created_at'] ?? ''}'.trim();
  if (raw.isEmpty || raw == 'null') return '';
  final parsed = DateTime.tryParse(raw.replaceFirst(' ', 'T'));
  if (parsed == null) return raw;
  final hour = parsed.hour == 0 ? 12 : (parsed.hour > 12 ? parsed.hour - 12 : parsed.hour);
  final minute = parsed.minute.toString().padLeft(2, '0');
  final suffix = parsed.hour >= 12 ? 'PM' : 'AM';
  return '${_moShort[parsed.month - 1]} ${parsed.day}, $hour:$minute $suffix';
}

class NotificationsTab extends StatefulWidget {
  const NotificationsTab({super.key, required this.notifications});
  final List<dynamic> notifications;

  @override
  State<NotificationsTab> createState() => _NotificationsTabState();
}

class _NotificationsTabState extends State<NotificationsTab> {
  String _filter = 'all';

  @override
  Widget build(BuildContext context) {
    final all = widget.notifications.whereType<Map>().map((n) => Map<String, dynamic>.from(n)).toList();
    final notifications = _filter == 'all' ? all : all.where((n) => parentNotificationCategory(n) == _filter).toList();
    if (notifications.isEmpty) {
      return ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: [
          _filterBar(),
          const SizedBox(height: 16),
          const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('No notifications yet.', style: TextStyle(color: kMuted)))),
        ],
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      children: [
        _filterBar(),
        const SizedBox(height: 12),
        ...notifications.map(_notificationCard),
      ],
    );
  }

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
    final unread = n['is_read'] != true && n['is_read'] != 1;
    final student = '${n['student_name'] ?? n['child_name'] ?? ''}'.trim();
    final school = '${n['school_name'] ?? ''}'.trim();
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: _cardDecoration(),
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
                Text('${n['title'] ?? 'EduTrack Parent'}', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w900, color: kInk)),
                const SizedBox(height: 4),
                Text('${n['message'] ?? ''}', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: kMuted, height: 1.28)),
                const SizedBox(height: 9),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    if (student.isNotEmpty) _miniMeta(Icons.child_care_rounded, student),
                    if (school.isNotEmpty) _miniMeta(Icons.school_rounded, school),
                    _miniMeta(Icons.schedule_rounded, parentNotificationTime(n)),
                  ],
                ),
              ],
            ),
          ),
        ],
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
      if (result.type != ResultType.done && mounted) {
        setState(() => _otaMsg = 'Allow “Install unknown apps” for EduTrack Parent, then tap Install Update again.');
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
    try {
      await showParentNotification('EduTrack Parent — Test', 'Notifications are working. You will be alerted about your child’s attendance.');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Test notification sent. Check your notification tray.')));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not send a notification. Please allow notifications in settings.')));
      }
    }
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
                'Installs directly inside the app — no browser needed. When asked, allow “Install unknown apps” for EduTrack Parent, then tap Install.',
                style: TextStyle(fontSize: 11, color: kMuted),
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
              const Text('Send yourself a test alert to confirm notifications are working.', style: TextStyle(fontSize: 12, color: kMuted)),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 46,
                child: OutlinedButton.icon(
                  onPressed: _testNotification,
                  icon: const Icon(Icons.notifications, color: kGreen, size: 19),
                  label: const Text('Test Notification', style: TextStyle(color: kGreen, fontWeight: FontWeight.w700)),
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
        Center(child: Text('EduTrack Parent • v${_current.isEmpty ? '1.0.1' : _current}', style: const TextStyle(color: Color(0xFF9CA3AF), fontSize: 11.5))),
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
  const SchoolArt({super.key, this.data});
  final String? data;
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
          errorBuilder: (_, __, ___) => const _DefaultSchoolArt(),
        );
      } on FormatException {
        return const _DefaultSchoolArt();
      }
    }
    return const _DefaultSchoolArt();
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
