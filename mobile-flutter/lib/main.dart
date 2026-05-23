import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

class AppConfig {
  static const appName = 'Edutrack';
  static const subtitle = 'Schools Division of Sipalay City';
  static const logoAsset = 'assets/images/app_logo.png';
  static const baseUrl = 'https://school-attendance-qrbased.up.railway.app';
}

final notifications = FlutterLocalNotificationsPlugin();
const alertsChannel = AndroidNotificationChannel(
  'edutrack_alerts',
  'Edutrack Alerts',
  description: 'Attendance monitoring alerts',
  importance: Importance.high,
);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await notifications.initialize(
    const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    ),
  );
  await notifications
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >()
      ?.createNotificationChannel(alertsChannel);
  runApp(const EdutrackApp());
}

class EdutrackApp extends StatelessWidget {
  const EdutrackApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: AppConfig.appName,
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
              fontSize: 11,
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
  bool get isLoggedIn => cookie.isNotEmpty;

  Map<String, String> get authHeaders => {
    'Accept': 'application/json',
    if (cookie.isNotEmpty) 'Cookie': cookie,
  };

  Future<void> login(String username, String password) async {
    final response = await http.post(
      Uri.parse('${AppConfig.baseUrl}/app-login'),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: {'username': username, 'password': password},
    );
    final data = jsonDecode(response.body) as Map;
    if (response.statusCode >= 400 || data['success'] != true) {
      throw Exception(data['message'] ?? 'Username or password is incorrect.');
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
  }

  Future<void> logout() async {
    await prefs.remove('cookie');
    await prefs.remove('fullname');
    await prefs.remove('role');
    await prefs.remove('last_absence_key');
  }

  Future<Map<String, dynamic>> map(String path) async {
    final response = await http.get(
      Uri.parse('${AppConfig.baseUrl}$path'),
      headers: authHeaders,
    );
    if (response.statusCode == 401) throw AuthExpired();
    if (response.statusCode >= 400) throw Exception(response.body);
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<List<dynamic>> list(String path) async {
    final response = await http.get(
      Uri.parse('${AppConfig.baseUrl}$path'),
      headers: authHeaders,
    );
    if (response.statusCode == 401) throw AuthExpired();
    if (response.statusCode >= 400) throw Exception(response.body);
    final decoded = jsonDecode(response.body);
    return decoded is List ? decoded : [];
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
            builder: (_) =>
                api.isLoggedIn ? HomeShell(api: api) : LoginScreen(api: api),
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
          painter: LiveMeshPainter(controller.value, intensity: 1),
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
                          'Attendance Monitoring System',
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
  LiveMeshPainter(this.value, {this.intensity = .5, this.lightMode = false});
  final double value;
  final double intensity;
  final bool lightMode;

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
    final radarCenter = Offset(size.width * .50, size.height * .30);
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
      oldDelegate.lightMode != lightMode;
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
      await showLocalNotification(
        'WELCOME',
        '${greeting()}, ${widget.api.fullname}',
        showToast: false,
      );
      if (!mounted) return;
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(builder: (_) => HomeShell(api: widget.api)),
      );
    } catch (e) {
      setState(() {
        loading = false;
        error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return Scaffold(
      resizeToAvoidBottomInset: true,
      body: AnimatedBuilder(
        animation: backgroundController,
        builder: (context, child) => CustomPaint(
          painter: LiveMeshPainter(
            backgroundController.value,
            intensity: .16,
            lightMode: true,
          ),
          child: child,
        ),
        child: CustomScrollView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          slivers: [
            SliverToBoxAdapter(
              child: Container(
                height: 252,
                decoration: const BoxDecoration(
                  color: Color(0xFFF5F7F6),
                  borderRadius: BorderRadius.only(
                    bottomLeft: Radius.circular(36),
                    bottomRight: Radius.circular(36),
                  ),
                ),
                child: const SafeArea(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      AppLogo(size: 82),
                      SizedBox(height: 16),
                      Text(
                        AppConfig.appName,
                        style: TextStyle(
                          color: Color(0xFF12201B),
                          fontSize: 36,
                          fontWeight: FontWeight.w900,
                          letterSpacing: -.8,
                        ),
                      ),
                      SizedBox(height: 6),
                      Padding(
                        padding: EdgeInsets.symmetric(horizontal: 28),
                        child: Text(
                          AppConfig.subtitle,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: Color(0xFF4D5D56),
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            SliverToBoxAdapter(
              child: Padding(
                padding: EdgeInsets.fromLTRB(
                  20,
                  18,
                  20,
                  math.max(30, bottomInset + 26),
                ),
                child: PremiumCard(
                  padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Welcome Back',
                        style: TextStyle(
                          fontSize: 30,
                          fontWeight: FontWeight.w900,
                          letterSpacing: -.7,
                        ),
                      ),
                      const SizedBox(height: 5),
                      const Text(
                        'Sign in to monitor live attendance.',
                        style: TextStyle(
                          color: Color(0xFF667872),
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      if (error != null) ...[
                        const SizedBox(height: 14),
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: const Color(
                              0xFFFFEFEF,
                            ).withValues(alpha: .84),
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(color: const Color(0xFFFECACA)),
                          ),
                          child: Text(
                            error!,
                            style: const TextStyle(
                              color: Color(0xFFB91C1C),
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(height: 22),
                      _label('Username'),
                      _field(
                        username,
                        'Enter your username',
                        icon: Icons.person_rounded,
                      ),
                      const SizedBox(height: 14),
                      _label('Password'),
                      _field(
                        password,
                        'Enter your password',
                        secret: true,
                        icon: Icons.lock_rounded,
                      ),
                      const SizedBox(height: 24),
                      Container(
                        width: double.infinity,
                        height: 56,
                        decoration: BoxDecoration(
                          color: const Color(0xFF138A64),
                          borderRadius: BorderRadius.circular(20),
                          boxShadow: [
                            BoxShadow(
                              color: const Color(
                                0xFF0F6E52,
                              ).withValues(alpha: .25),
                              blurRadius: 18,
                              offset: const Offset(0, 10),
                            ),
                          ],
                        ),
                        child: FilledButton(
                          onPressed: loading ? null : submit,
                          style: FilledButton.styleFrom(
                            backgroundColor: Colors.transparent,
                            shadowColor: Colors.transparent,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(20),
                            ),
                          ),
                          child: loading
                              ? const SizedBox(
                                  width: 22,
                                  height: 22,
                                  child: CircularProgressIndicator(
                                    color: Colors.white,
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Text(
                                  'Sign In',
                                  style: TextStyle(
                                    fontSize: 17,
                                    fontWeight: FontWeight.w900,
                                  ),
                                ),
                        ),
                      ),
                      const SizedBox(height: 18),
                      const Center(
                        child: Text(
                          'Attendance Monitoring System\nv2.0.8',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: Color(0xFF77847E),
                            fontWeight: FontWeight.w600,
                            height: 1.35,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _label(String value) => Padding(
    padding: const EdgeInsets.only(bottom: 8, left: 2),
    child: Text(
      value,
      style: const TextStyle(
        fontWeight: FontWeight.w900,
        color: Color(0xFF1D2A25),
      ),
    ),
  );

  Widget _field(
    TextEditingController controller,
    String hint, {
    bool secret = false,
    required IconData icon,
  }) => TextField(
    controller: controller,
    obscureText: secret,
    textInputAction: secret ? TextInputAction.done : TextInputAction.next,
    onSubmitted: (_) => secret ? submit() : null,
    decoration: InputDecoration(
      hintText: hint,
      prefixIcon: Icon(icon, color: const Color(0xFF138A64)),
      filled: true,
      fillColor: Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(18)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(18),
        borderSide: const BorderSide(color: Color(0xFFDBE6E0)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(18),
        borderSide: const BorderSide(color: Color(0xFF138A64), width: 2),
      ),
    ),
  );
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.api});
  final ApiService api;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell>
    with SingleTickerProviderStateMixin {
  int tab = 0;
  Map<String, dynamic> dashboard = {};
  List<dynamic> flags = [];
  bool loading = true;
  String? error;
  Timer? timer;
  late final AnimationController backgroundController;

  @override
  void initState() {
    super.initState();
    backgroundController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 9),
    )..repeat();
    load();
    timer = Timer.periodic(
      const Duration(seconds: 6),
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
        widget.api.map('/api/dashboard-data?date=${date()}'),
        widget.api.list('/api/absence-flags?days=2&include_teachers=0'),
      ]);
      dashboard = results[0] as Map<String, dynamic>;
      flags = results[1] as List<dynamic>;
      await notifyAbsenceFlags(flags, widget.api.prefs);
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
          error = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      DashboardPage(
        api: widget.api,
        dashboard: dashboard,
        flags: flags,
        loading: loading,
        error: error,
        onRefresh: load,
      ),
      AttendancePage(api: widget.api),
      SchoolsPage(api: widget.api),
      ReportsPage(api: widget.api),
      AlertsPage(flags: flags),
    ];
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
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 250),
                child: pages[tab],
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
                height: 70,
                backgroundColor: Colors.transparent,
                selectedIndex: tab,
                onDestinationSelected: (value) => setState(() => tab = value),
                destinations: const [
                  NavigationDestination(
                    icon: Icon(Icons.dashboard_customize_rounded),
                    label: 'Home',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.fact_check_rounded),
                    label: 'Attendance',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.account_balance_rounded),
                    label: 'Schools',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.insert_chart_rounded),
                    label: 'Report',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.notifications_active_rounded),
                    label: 'Alerts',
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class Header extends StatelessWidget {
  const Header({super.key, required this.api, required this.onLogout});
  final ApiService api;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.fromLTRB(
        14,
        MediaQuery.paddingOf(context).top + 6,
        14,
        10,
      ),
      decoration: BoxDecoration(
        color: Colors.white,
        border: const Border(bottom: BorderSide(color: Color(0xFFE2E9E5))),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFF111827).withValues(alpha: .06),
            blurRadius: 12,
            offset: const Offset(0, 3),
          ),
        ],
      ),
      child: Column(
        children: [
          Row(
            children: [
              const AppLogo(size: 36),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      AppConfig.appName,
                      style: TextStyle(
                        color: Color(0xFF0F211B),
                        fontSize: 18,
                        fontWeight: FontWeight.w900,
                        letterSpacing: -.2,
                      ),
                    ),
                    const Text(
                      AppConfig.subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: Color(0xFF6D7A74),
                        fontSize: 10.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
              _actionIcon(icon: Icons.logout_rounded, onTap: onLogout),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              _chip(
                const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    LiveDot(color: Color(0xFFFF3B30), size: 8),
                    SizedBox(width: 6),
                    Text('LIVE'),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              _chip(Text(shortDate()), dense: true),
              const SizedBox(width: 8),
              Expanded(child: _chip(Text(date()), dense: true)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _chip(Widget child, {bool dense = false}) => Container(
    padding: EdgeInsets.symmetric(
      horizontal: dense ? 11 : 12,
      vertical: dense ? 7 : 8,
    ),
    decoration: BoxDecoration(
      color: const Color(0xFFF7FAF8),
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: const Color(0xFFDCE6E1)),
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

  Widget _actionIcon({required IconData icon, required VoidCallback onTap}) =>
      Container(
        width: 38,
        height: 38,
        decoration: BoxDecoration(
          color: const Color(0xFFEAF7F1),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: const Color(0xFFD7EDE3)),
        ),
        child: IconButton(
          padding: EdgeInsets.zero,
          onPressed: onTap,
          icon: Icon(icon, size: 20, color: const Color(0xFF138A64)),
        ),
      );
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
  });
  final ApiService api;
  final Map<String, dynamic> dashboard;
  final List<dynamic> flags;
  final bool loading;
  final String? error;
  final Future<void> Function({bool silent}) onRefresh;

  @override
  Widget build(BuildContext context) {
    if (loading && dashboard.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (error != null && dashboard.isEmpty) return Center(child: Text(error!));
    final active = intValue(
      dashboard['active_students'] ?? dashboard['total_students'],
    );
    final present = intValue(dashboard['students_present']);
    final rate = intValue(dashboard['attendance_rate']);
    final absent = intValue(dashboard['students_absent']);
    final schools = (dashboard['schools'] as List?) ?? [];
    final schoolRates = schools
        .map((item) => intValue((item as Map)['rate']))
        .toList();

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
                Text(
                  greeting(),
                  style: const TextStyle(
                    color: Color(0xFF4C5F57),
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  api.fullname,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF111827),
                    fontSize: 25,
                    fontWeight: FontWeight.w900,
                    height: 1.04,
                    letterSpacing: -.7,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  fullDate(),
                  style: const TextStyle(
                    color: Color(0xFF5F6F69),
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: KpiPill(
                        label: 'Students',
                        value: '$active',
                        icon: Icons.groups_rounded,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: KpiPill(
                        label: 'Present',
                        value: '$present',
                        icon: Icons.how_to_reg_rounded,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: KpiPill(
                        label: 'Absent',
                        value: '$absent',
                        icon: Icons.person_off_rounded,
                        accent: const Color(0xFFDC2626),
                        onTap: () =>
                            openAbsentDetails(title: 'Absent Students Today'),
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
              border: Border.all(color: const Color(0xFFDCE6E1)),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF111827).withValues(alpha: .07),
                  blurRadius: 18,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 136,
                  height: 136,
                  child: CustomPaint(
                    painter: RingPainter(rate),
                    child: Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            '$rate%',
                            style: const TextStyle(
                              fontSize: 34,
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
                  ),
                ),
                const SizedBox(width: 18),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Today Analytics',
                        style: TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w900,
                          letterSpacing: -.3,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        '$present of $active students present',
                        style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          color: Color(0xFF27332F),
                        ),
                      ),
                      const SizedBox(height: 12),
                      RateBar('Live rate', rate),
                      const SizedBox(height: 2),
                      InkWell(
                        borderRadius: BorderRadius.circular(8),
                        onTap: () =>
                            openAbsentDetails(title: 'Absent Students Today'),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Text(
                            absent == 1
                                ? '1 student absent'
                                : '$absent students absent',
                            style: const TextStyle(
                              color: Color(0xFF74827E),
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
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
          const SizedBox(height: 12),
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
                if (schoolRates.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  const Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'Attendance Trend by School',
                      style: TextStyle(
                        fontWeight: FontWeight.w900,
                        fontSize: 15,
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    height: 100,
                    child: SchoolTrendChart(
                      rates: schoolRates.take(10).toList(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  for (final item in schools.take(4))
                    RateBar(
                      '${(item as Map)['name'] ?? 'School'}',
                      intValue(item['rate']),
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
    borderRadius: BorderRadius.circular(14),
    child: Container(
      constraints: const BoxConstraints(minHeight: 78),
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      decoration: BoxDecoration(
        color: const Color(0xFFF5F7F6),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFDCE6E1)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: accent, size: 16),
          const SizedBox(height: 6),
          Text(
            value,
            style: const TextStyle(
              color: Color(0xFF111827),
              fontSize: 18,
              fontWeight: FontWeight.w900,
              height: 1,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFF5C6E66),
              fontSize: 11,
              fontWeight: FontWeight.w800,
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
  bool loading = true;
  String? error;
  List<Map<String, dynamic>> week = [];
  Timer? timer;

  @override
  void initState() {
    super.initState();
    load();
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
      final futures = days
          .map((d) => widget.api.map('/api/dashboard-data?date=$d'))
          .toList();
      final results = await Future.wait(futures);
      final built = <Map<String, dynamic>>[];
      for (var i = 0; i < days.length; i++) {
        final data = results[i];
        final isSchoolDay = data['is_school_day'] == true;
        final absent = isSchoolDay ? intValue(data['students_absent']) : 0;
        built.add({
          'date': days[i],
          'label': weekdayShort(days[i]),
          'day': dayOfMonth(days[i]),
          'isSchoolDay': isSchoolDay,
          'absent': absent,
        });
      }
      if (!mounted) return;
      setState(() {
        week = built;
        loading = false;
        error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        loading = false;
        error = e.toString();
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
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final day in week)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: WeekDayAbsenceTile(
                    label: '${day['label']}',
                    dayNumber: '${day['day']}',
                    absent: intValue(day['absent']),
                    isSchoolDay: day['isSchoolDay'] == true,
                    maxAbsent: maxAbsent,
                    onTap: () => widget.onDayTap(
                      '${day['date']}',
                      day['isSchoolDay'] == true,
                    ),
                  ),
                ),
            ],
          ),
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
    required this.onTap,
  });
  final String label;
  final String dayNumber;
  final int absent;
  final bool isSchoolDay;
  final int maxAbsent;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final barHeight = isSchoolDay
        ? (18 + (absent / math.max(1, maxAbsent)) * 50).toDouble()
        : 8.0;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        width: 62,
        padding: const EdgeInsets.fromLTRB(8, 8, 8, 9),
        decoration: BoxDecoration(
          color: const Color(0xFFF8FBF9),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: const Color(0xFFDCE6E1)),
        ),
        child: Column(
          children: [
            Text(
              label,
              style: const TextStyle(
                fontSize: 11,
                color: Color(0xFF64726B),
                fontWeight: FontWeight.w800,
              ),
            ),
            Text(
              dayNumber,
              style: const TextStyle(
                fontSize: 13,
                color: Color(0xFF1F2937),
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(height: 5),
            SizedBox(
              height: 56,
              child: Align(
                alignment: Alignment.bottomCenter,
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 350),
                  width: 18,
                  height: barHeight,
                  decoration: BoxDecoration(
                    color: isSchoolDay
                        ? const Color(0xFFDC2626).withValues(alpha: .88)
                        : const Color(0xFFCBD5D1),
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 4),
            Text(
              isSchoolDay ? '$absent' : '-',
              style: TextStyle(
                color: isSchoolDay
                    ? const Color(0xFFB91C1C)
                    : const Color(0xFF94A3B8),
                fontWeight: FontWeight.w900,
                fontSize: 12,
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

  @override
  void initState() {
    super.initState();
    focusedDate = DateTime.now();
  }

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
      const SizedBox(height: 8),
      Container(
        decoration: BoxDecoration(
          color: const Color(0xFFF8FBF9),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFFDCE6E1)),
          boxShadow: [
            BoxShadow(
              color: const Color(0xFF111827).withValues(alpha: .04),
              blurRadius: 10,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: CalendarDatePicker(
          initialDate: focusedDate,
          firstDate: DateTime.now().subtract(const Duration(days: 365 * 2)),
          lastDate: DateTime.now().add(const Duration(days: 365)),
          onDateChanged: openDateModal,
        ),
      ),
    ],
  );
}

class DateAttendanceModal extends StatefulWidget {
  const DateAttendanceModal({
    super.key,
    required this.api,
    required this.targetDate,
  });
  final ApiService api;
  final String targetDate;

  @override
  State<DateAttendanceModal> createState() => _DateAttendanceModalState();
}

class _DateAttendanceModalState extends State<DateAttendanceModal> {
  bool loading = true;
  String? error;
  bool isSchoolDay = true;
  int presentCount = 0;
  int absentCount = 0;
  List<Map<String, dynamic>> presentRows = [];
  List<Map<String, dynamic>> absentRows = [];
  String activeTab = 'present';

  @override
  void initState() {
    super.initState();
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
      if (!mounted) return;
      setState(() {
        isSchoolDay = data['is_school_day'] == true;
        presentRows = present;
        absentRows = absent;
        presentCount = intValue((data['totals'] as Map?)?['present']);
        absentCount = intValue((data['totals'] as Map?)?['absent']);
        activeTab = presentCount > 0 ? 'present' : 'absent';
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        loading = false;
        error = e.toString();
      });
    }
  }

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
                          const SizedBox(width: 10),
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
                        activeTab == 'present'
                            ? 'Present Students'
                            : 'Absent Students',
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

  List<Map<String, dynamic>> get _activeRows =>
      activeTab == 'present' ? presentRows : absentRows;

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
    final adviser = '${row['adviser'] ?? '-'}';
    final status = '${row['attendance_status'] ?? '-'}';
    final monitoring = '${row['monitoring_status'] ?? ''}'.trim();
    final absentDays = intValue(row['absent_days']);
    final absentFromDate = '${row['absent_from_date'] ?? ''}'.trim();
    final absentInfo = absentDays > 0
        ? 'Absent since: ${readableDate(absentFromDate.isEmpty ? widget.targetDate : absentFromDate)} | ${absentDays == 1 ? '1 day' : '$absentDays days'}'
        : 'Attendance date: ${readableDate(widget.targetDate)}';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: PremiumCard(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              name,
              style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 15),
            ),
            const SizedBox(height: 4),
            Text(
              'Grade: $grade | Section: $section',
              style: const TextStyle(
                color: Color(0xFF4F5E57),
                fontWeight: FontWeight.w700,
                fontSize: 12,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              'School: $schoolName',
              style: const TextStyle(
                color: Color(0xFF4F5E57),
                fontWeight: FontWeight.w700,
                fontSize: 12,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              'LRN: $lrn | Adviser: $adviser',
              style: const TextStyle(
                color: Color(0xFF5E6B65),
                fontWeight: FontWeight.w700,
                fontSize: 12,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              'Status: $status${monitoring.isNotEmpty ? ' | $monitoring' : ''} | Date: ${readableDate(widget.targetDate)}',
              style: TextStyle(
                color: status == 'Absent'
                    ? const Color(0xFFB91C1C)
                    : const Color(0xFF15803D),
                fontWeight: FontWeight.w900,
                fontSize: 12,
              ),
            ),
            if (status == 'Absent') ...[
              const SizedBox(height: 2),
              Text(
                absentInfo,
                style: const TextStyle(
                  color: Color(0xFFB91C1C),
                  fontWeight: FontWeight.w800,
                  fontSize: 12,
                ),
              ),
            ],
          ],
        ),
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
        error = e.toString();
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
                                  'Status: ${row['attendance_status'] ?? 'Absent'} | Absent days: ${row['absent_days'] ?? 1}',
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
  Widget build(BuildContext context) => FutureList(
    title: 'Attendance',
    subtitle: 'Live time-in and time-out records for today.',
    future: api.list('/api/attendance?date=${date()}'),
    empty: 'No attendance records yet today.',
    builder: (row) {
      final monitoring = '${row['monitoring_status'] ?? ''}'.trim();
      final out = '${row['time_out'] ?? ''}'.trim();
      return RecordTile(
        title: '${row['person_name'] ?? 'Unknown'}',
        subtitle: '${row['person_type'] ?? 'person'}',
        meta: 'In: ${row['time_in'] ?? '--'} | Out: ${out.isNotEmpty ? out : (monitoring.isNotEmpty ? monitoring : '--')}',
      );
    },
  );
}

class ReportsPage extends StatelessWidget {
  const ReportsPage({super.key, required this.api});
  final ApiService api;

  @override
  Widget build(BuildContext context) => FutureBuilder<Map<String, dynamic>>(
    future: api.map('/api/reports/daily-summary?date=${date()}'),
    builder: (_, snapshot) {
      if (!snapshot.hasData) {
        return const Center(child: CircularProgressIndicator());
      }
      final totals = (snapshot.data!['totals'] as Map?) ?? {};
      final schools = (snapshot.data!['schools'] as List?) ?? [];
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
                ),
                Metric(
                  Icons.person_off,
                  'Absent',
                  '${intValue(totals['absent'])}',
                  'today',
                  color: const Color(0xFFDC2626),
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
    },
  );
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
  late Future<Map<String, dynamic>> future;

  @override
  void initState() {
    super.initState();
    future = widget.api.map('/api/mobile-school-structure');
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<Map<String, dynamic>>(
    future: future,
    builder: (_, snapshot) {
      if (!snapshot.hasData) {
        return const Center(child: CircularProgressIndicator());
      }
      final schools = (snapshot.data!['schools'] as List?) ?? [];
      return ListView(
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
          const SizedBox(height: 12),
          section != null
              ? sectionView()
              : grade != null
              ? gradeView()
              : school != null
              ? schoolView()
              : schoolsList(schools),
        ],
      );
    },
  );

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
            'Back to schools',
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
            'Back to ${school!['name']}',
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
          BackLine(
            'Back to ${grade!['name']}',
            () => setState(() => section = null),
          ),
          InfoPill(
            'Adviser',
            adviserText(section!).replaceFirst('Adviser: ', ''),
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

class AlertsPage extends StatelessWidget {
  const AlertsPage({super.key, required this.flags});
  final List<dynamic> flags;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      const SectionTitle(
        'Alerts',
        '2-day absence alerts and notification checks.',
      ),
      const SizedBox(height: 12),
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
            if (flags.isEmpty) {
              await showLocalNotification(
                'Edutrack alert test',
                'No live 2-day flagged students found.',
              );
              return;
            }
            final row = Map<String, dynamic>.from(flags.first as Map);
            await showLocalNotification(
              absenceTitle(flags.length),
              absenceBody(row),
            );
          },
          icon: const Icon(Icons.notifications_active),
          label: const Text('Send 2-day flagged alert'),
        ),
      ),
      const SizedBox(height: 12),
      PremiumCard(
        title: '2-Day Absence Alerts',
        subtitle: '${flags.length} active flag(s)',
        child: Column(
          children: [
            if (flags.isEmpty) const EmptyText('No 2-day absentees detected.'),
            for (final item in flags)
              FlagTile(Map<String, dynamic>.from(item as Map)),
          ],
        ),
      ),
    ],
  );
}

class FlagTile extends StatelessWidget {
  const FlagTile(this.row, {super.key});
  final Map<String, dynamic> row;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      RecordTile(
        title: '${row['name'] ?? 'Student'}',
        subtitle: '${row['school_name'] ?? ''}',
        meta: absenceBody(row),
        color: const Color(0xFFF97316),
      ),
      Align(
        alignment: Alignment.centerRight,
        child: TextButton.icon(
          onPressed: () async {
            final phone =
                '${row['adviser_contact'] ?? row['school_contact'] ?? ''}'
                    .trim();
            if (phone.isNotEmpty) {
              final uri = Uri.parse('tel:$phone');
              if (await canLaunchUrl(uri)) {
                await launchUrl(uri);
                return;
              }
            }
            if (context.mounted) {
              showDialog(
                context: context,
                builder: (_) => AlertDialog(
                  title: const Text('Please contact adviser'),
                  content: Text(
                    'Student: ${row['name'] ?? 'Student'}\nGrade: ${row['grade_name'] ?? '-'}\nSection: ${row['section_name'] ?? '-'}\nLRN: ${row['lrn'] ?? '-'}\nDays absent: ${absenceDays(row)}\nAdviser: ${row['adviser'] ?? '-'}',
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
          },
          icon: const Icon(Icons.phone_forwarded),
          label: const Text('Please contact adviser'),
        ),
      ),
    ],
  );
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
      if (!snapshot.hasData) {
        return const Center(child: CircularProgressIndicator());
      }
      final rows = snapshot.data!;
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionTitle(title, subtitle),
          const SizedBox(height: 12),
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
  Widget build(BuildContext context) => PremiumCard(
    padding: const EdgeInsets.all(18),
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
        Text(subtitle, style: const TextStyle(color: Color(0xFF667872))),
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
    final logo = '${school['logo'] ?? ''}'.trim();
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
  });
  final String title;
  final String subtitle;
  final String meta;
  final VoidCallback? onTap;
  final Color color;
  final Widget? leading;

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
                      maxLines: 3,
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
  });
  final IconData icon;
  final String label;
  final String value;
  final String caption;
  final Color color;

  @override
  Widget build(BuildContext context) => ClipRRect(
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
  const RateBar(this.name, this.rate, {super.key});
  final String name;
  final int rate;

  @override
  Widget build(BuildContext context) => Padding(
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
            Text('$rate%', style: const TextStyle(fontWeight: FontWeight.w900)),
          ],
        ),
        const SizedBox(height: 5),
        ClipRRect(
          borderRadius: BorderRadius.circular(99),
          child: LinearProgressIndicator(
            value: rate.clamp(0, 100) / 100,
            minHeight: 8,
            backgroundColor: const Color(0xFFE5EEE9),
            color: rate >= 75
                ? const Color(0xFF00885B)
                : const Color(0xFFF97316),
          ),
        ),
      ],
    ),
  );
}

class RingPainter extends CustomPainter {
  RingPainter(this.rate);
  final int rate;
  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(size.width, size.height) / 2 - 12;
    final bg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 13
      ..strokeCap = StrokeCap.round
      ..color = const Color(0xFFCFFBE8);
    final fg = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 13
      ..strokeCap = StrokeCap.round
      ..color = const Color(0xFFF08A00);
    canvas.drawCircle(center, radius, bg);
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      math.pi * 2 * rate.clamp(0, 100) / 100,
      false,
      fg,
    );
  }

  @override
  bool shouldRepaint(RingPainter oldDelegate) => oldDelegate.rate != rate;
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

class AppLogo extends StatelessWidget {
  const AppLogo({super.key, required this.size});
  final double size;
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    padding: EdgeInsets.all(size * .12),
    decoration: BoxDecoration(
      color: Colors.white.withValues(alpha: .18),
      borderRadius: BorderRadius.circular(size * .28),
      border: Border.all(color: Colors.white24),
    ),
    child: Image.asset(AppConfig.logoAsset, fit: BoxFit.contain),
  );
}

Future<void> notifyAbsenceFlags(List flags, SharedPreferences prefs) async {
  if (flags.isEmpty) return;
  final key = '${date()}:${flags.length}';
  if (prefs.getString('last_absence_key') == key) return;
  final row = Map<String, dynamic>.from(flags.first as Map);
  await showLocalNotification(
    absenceTitle(flags.length),
    absenceBody(row),
    showToast: false,
  );
  await prefs.setString('last_absence_key', key);
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
  bool showToast = true,
}) async {
  final granted = await ensureNotificationPermission();
  if (!granted) return false;
  const android = AndroidNotificationDetails(
    'edutrack_alerts',
    'Edutrack Alerts',
    channelDescription: 'Attendance monitoring alerts',
    importance: Importance.high,
    priority: Priority.high,
    category: AndroidNotificationCategory.status,
    visibility: NotificationVisibility.public,
    ticker: 'Edutrack attendance alert',
  );
  await notifications.show(
    DateTime.now().millisecondsSinceEpoch ~/ 1000,
    title,
    body,
    const NotificationDetails(android: android),
  );
  return true;
}

String absenceTitle(int count) =>
    count == 1 ? '1 student absent 2+ days' : '$count students absent 2+ days';
String absenceBody(Map<String, dynamic> row) =>
    '${row['name'] ?? 'Student'} | ${fullDate()} | ${row['grade_name'] ?? '-'} - ${row['section_name'] ?? '-'} | LRN: ${row['lrn'] ?? '-'} | ${absenceDays(row)} absent | Adviser: ${row['adviser'] ?? '-'}';

String absenceDays(Map<String, dynamic> row) {
  final days = intValue(row['absent_days']);
  final count = days <= 0 ? 2 : days;
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
  final clean = path.trim();
  if (clean.isEmpty) return clean;
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

int intValue(dynamic value) => int.tryParse('$value') ?? 0;

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
