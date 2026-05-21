import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

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
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF009A67)),
        scaffoldBackgroundColor: const Color(0xFFF2F7F4),
        useMaterial3: true,
        navigationBarTheme: NavigationBarThemeData(
          backgroundColor: Colors.white,
          indicatorColor: const Color(0xFFE4FFF4),
          labelTextStyle: WidgetStateProperty.resolveWith(
            (states) => TextStyle(
              fontSize: 11,
              fontWeight: states.contains(WidgetState.selected)
                  ? FontWeight.w900
                  : FontWeight.w700,
              color: states.contains(WidgetState.selected)
                  ? const Color(0xFF007D55)
                  : const Color(0xFF6D7C77),
            ),
          ),
          iconTheme: WidgetStateProperty.resolveWith(
            (states) => IconThemeData(
              color: states.contains(WidgetState.selected)
                  ? const Color(0xFF007D55)
                  : const Color(0xFF63736E),
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
                          color: Colors.white,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        AppConfig.subtitle,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: Color(0xFFE0FFF2),
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
                          color: Colors.white.withValues(alpha: .13),
                          borderRadius: BorderRadius.circular(99),
                          border: Border.all(color: Colors.white24),
                        ),
                        child: const Text(
                          'Attendance Monitoring System',
                          style: TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                      const Spacer(),
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: .14),
                          borderRadius: BorderRadius.circular(22),
                          border: Border.all(color: Colors.white24),
                        ),
                        child: Column(
                          children: [
                            Row(
                              children: [
                                const LiveDot(),
                                const SizedBox(width: 8),
                                const Text(
                                  'CONNECTING TO SERVER',
                                  style: TextStyle(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w900,
                                    letterSpacing: 1.1,
                                  ),
                                ),
                                const Spacer(),
                                Text(
                                  '${(progress * 100).round()}%',
                                  style: const TextStyle(
                                    color: Colors.white,
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
                                backgroundColor: Colors.white24,
                                color: Colors.white,
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

class LiveDot extends StatelessWidget {
  const LiveDot({super.key, this.color = Colors.white});
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: 8,
    height: 8,
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      boxShadow: [
        BoxShadow(color: color.withValues(alpha: .45), blurRadius: 10),
      ],
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
      ..shader = LinearGradient(
        colors: lightMode
            ? const [Color(0xFFF4FBF8), Color(0xFFFFFFFF)]
            : const [Color(0xFF0DBC7A), Color(0xFF00885B), Color(0xFF006747)],
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
      ).createShader(rect);
    canvas.drawRect(rect, base);

    void blob(Color color, Offset center, double radius) {
      final paint = Paint()
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 42)
        ..color = color.withValues(alpha: intensity);
      canvas.drawCircle(center, radius, paint);
    }

    final t = value * math.pi * 2;
    blob(
      lightMode ? const Color(0xFFBFF8DF) : Colors.white,
      Offset(size.width * (.08 + .02 * math.sin(t)), size.height * .18),
      size.width * .42,
    );
    blob(
      lightMode ? const Color(0xFFE5FFF3) : const Color(0xFF8AFFD1),
      Offset(size.width * (.90 + .02 * math.cos(t)), size.height * .34),
      size.width * .46,
    );
    blob(
      lightMode ? const Color(0xFFFFF6D9) : const Color(0xFFFFD166),
      Offset(size.width * (.48 + .015 * math.sin(t * 1.2)), size.height * .90),
      size.width * .36,
    );

    final ringPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = (lightMode ? const Color(0xFF009A67) : Colors.white).withValues(
        alpha: .045 + intensity * .04,
      );
    final radarCenter = Offset(size.width * .50, size.height * .30);
    for (var i = 0; i < 5; i++) {
      final radius = size.width * (.12 + i * .055) + math.sin(t) * 2;
      canvas.drawCircle(radarCenter, radius, ringPaint);
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

class _LoginScreenState extends State<LoginScreen> {
  final username = TextEditingController();
  final password = TextEditingController();
  bool loading = false;
  String? error;

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
      body: CustomPaint(
        painter: LiveMeshPainter(.35, intensity: .22, lightMode: true),
        child: CustomScrollView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          slivers: [
            SliverToBoxAdapter(
              child: Container(
                height: 286,
                decoration: const BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      Color(0xFF05B777),
                      Color(0xFF009765),
                      Color(0xFF007A55),
                    ],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
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
                          color: Colors.white,
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
                            color: Color(0xFFE5FFF4),
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
              child: Transform.translate(
                offset: const Offset(0, -28),
                child: Padding(
                  padding: EdgeInsets.fromLTRB(
                    22,
                    0,
                    22,
                    math.max(28, bottomInset + 24),
                  ),
                  child: PremiumCard(
                    padding: const EdgeInsets.fromLTRB(24, 22, 24, 24),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Welcome Back',
                          style: TextStyle(
                            fontSize: 29,
                            fontWeight: FontWeight.w900,
                            letterSpacing: -.5,
                          ),
                        ),
                        const SizedBox(height: 4),
                        const Text(
                          'Sign in to monitor live attendance.',
                          style: TextStyle(
                            color: Color(0xFF667872),
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        if (error != null) ...[
                          const SizedBox(height: 14),
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: const Color(0xFFFFEFEF),
                              borderRadius: BorderRadius.circular(16),
                              border: Border.all(
                                color: const Color(0xFFFECACA),
                              ),
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
                            gradient: const LinearGradient(
                              colors: [Color(0xFF10B981), Color(0xFF00885B)],
                            ),
                            borderRadius: BorderRadius.circular(20),
                            boxShadow: [
                              BoxShadow(
                                color: const Color(
                                  0xFF00885B,
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
                            'Attendance Monitoring System\nv2.0.3',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              color: Color(0xFF91A09B),
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
        color: Color(0xFF17231F),
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
      prefixIcon: Icon(icon, color: const Color(0xFF00885B)),
      filled: true,
      fillColor: const Color(0xFFF8FBF9),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(18)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(18),
        borderSide: const BorderSide(color: Color(0xFFD6DED9)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(18),
        borderSide: const BorderSide(color: Color(0xFF009A67), width: 2),
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

class _HomeShellState extends State<HomeShell> {
  int tab = 0;
  Map<String, dynamic> dashboard = {};
  List<dynamic> flags = [];
  bool loading = true;
  String? error;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    load();
    timer = Timer.periodic(
      const Duration(seconds: 6),
      (_) => load(silent: true),
    );
  }

  @override
  void dispose() {
    timer?.cancel();
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
      backgroundColor: const Color(0xFFF2F7F4),
      body: Column(
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
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: .08),
              blurRadius: 24,
              offset: const Offset(0, -8),
            ),
          ],
        ),
        child: SafeArea(
          top: false,
          child: NavigationBar(
            height: 70,
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
    );
  }
}

class Header extends StatelessWidget {
  const Header({super.key, required this.api, required this.onLogout});
  final ApiService api;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    const radius = BorderRadius.only(
      bottomLeft: Radius.circular(28),
      bottomRight: Radius.circular(28),
    );
    return ClipRRect(
      borderRadius: radius,
      child: CustomPaint(
        painter: LiveMeshPainter(.2, intensity: .18),
        child: Container(
          padding: EdgeInsets.fromLTRB(
            18,
            MediaQuery.paddingOf(context).top + 12,
            18,
            16,
          ),
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              colors: [Color(0xFF10B981), Color(0xFF00885B), Color(0xFF007052)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
          ),
          child: Column(
            children: [
              Row(
                children: [
                  const AppLogo(size: 46),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          AppConfig.appName,
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 21,
                            fontWeight: FontWeight.w900,
                            letterSpacing: -.4,
                          ),
                        ),
                        Text(
                          api.fullname,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: Color(0xFFE0FFF2),
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton.filledTonal(
                    onPressed: onLogout,
                    style: IconButton.styleFrom(
                      backgroundColor: Colors.white.withValues(alpha: .18),
                      foregroundColor: Colors.white,
                    ),
                    icon: const Icon(Icons.logout_rounded),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  _chip(
                    const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        LiveDot(color: Color(0xFFFF3B30)),
                        SizedBox(width: 7),
                        Text('LIVE'),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  _chip(Text(shortDate())),
                  const SizedBox(width: 8),
                  Expanded(child: _chip(Center(child: Text(date())))),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _chip(Widget child) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
    decoration: BoxDecoration(
      color: Colors.white.withValues(alpha: .17),
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: Colors.white.withValues(alpha: .10)),
    ),
    child: DefaultTextStyle(
      style: const TextStyle(
        color: Colors.white,
        fontWeight: FontWeight.w800,
        fontSize: 12,
      ),
      child: child,
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
    final teachers = intValue(dashboard['total_teachers']);
    final teachersPresent = intValue(dashboard['teachers_present']);
    return RefreshIndicator(
      onRefresh: () => onRefresh(silent: false),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFF10B981), Color(0xFF00885B)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(28),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF00885B).withValues(alpha: .24),
                  blurRadius: 28,
                  offset: const Offset(0, 16),
                ),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 7,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: .16),
                        borderRadius: BorderRadius.circular(99),
                        border: Border.all(color: Colors.white24),
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          LiveDot(color: Color(0xFFFF3B30)),
                          SizedBox(width: 7),
                          Text(
                            'LIVE DASHBOARD',
                            style: TextStyle(
                              color: Colors.white,
                              fontSize: 11,
                              fontWeight: FontWeight.w900,
                              letterSpacing: .6,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Spacer(),
                    const Icon(
                      Icons.dashboard_customize_rounded,
                      color: Colors.white,
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                Text(
                  greeting(),
                  style: const TextStyle(
                    color: Color(0xFFD9FFF0),
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  api.fullname,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Colors.white,
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
                    color: Color(0xFFD9FFF0),
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 18),
                Row(
                  children: [
                    Expanded(
                      child: DashboardChip(
                        label: 'Students',
                        value: '$active',
                        icon: Icons.groups_rounded,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: DashboardChip(
                        label: 'Present',
                        value: '$present',
                        icon: Icons.how_to_reg_rounded,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: DashboardChip(
                        label: 'Alerts',
                        value: '${flags.length}',
                        icon: Icons.warning_rounded,
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
              border: Border.all(color: const Color(0xFFE1EFE9)),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF0B3428).withValues(alpha: .08),
                  blurRadius: 24,
                  offset: const Offset(0, 14),
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
                      Text(
                        absent == 1
                            ? '1 student absent'
                            : '$absent students absent',
                        style: const TextStyle(
                          color: Color(0xFF74827E),
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
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
          GridView.count(
            physics: const NeverScrollableScrollPhysics(),
            shrinkWrap: true,
            crossAxisCount: 2,
            childAspectRatio: 1.62,
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            children: [
              Metric(Icons.groups, 'Students', '$active', 'active'),
              Metric(Icons.how_to_reg, 'Present', '$present', 'today'),
              Metric(
                Icons.person_off,
                'Absent',
                '$absent',
                'now',
                color: const Color(0xFFDC2626),
              ),
              Metric(
                Icons.warning,
                '2-Day',
                '${flags.length}',
                'flagged',
                color: const Color(0xFFF97316),
              ),
              Metric(Icons.co_present, 'Teachers', '$teachers', 'active'),
              Metric(
                Icons.verified_user,
                'T. Present',
                '$teachersPresent',
                'today',
              ),
            ],
          ),
          const SizedBox(height: 14),
          Analytics(schools: (dashboard['schools'] as List?) ?? []),
        ],
      ),
    );
  }
}

class DashboardChip extends StatelessWidget {
  const DashboardChip({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
  });
  final String label;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(11),
    decoration: BoxDecoration(
      color: Colors.white.withValues(alpha: .15),
      borderRadius: BorderRadius.circular(18),
      border: Border.all(color: Colors.white.withValues(alpha: .18)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: Colors.white, size: 18),
        const SizedBox(height: 8),
        Text(
          value,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 20,
            fontWeight: FontWeight.w900,
            height: 1,
          ),
        ),
        const SizedBox(height: 3),
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            color: Color(0xFFD9FFF0),
            fontSize: 10,
            fontWeight: FontWeight.w800,
          ),
        ),
      ],
    ),
  );
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
    builder: (row) => RecordTile(
      title: '${row['person_name'] ?? 'Unknown'}',
      subtitle: '${row['person_type'] ?? 'person'}',
      meta: 'In: ${row['time_in'] ?? '--'} | Out: ${row['time_out'] ?? '--'}',
    ),
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
        padding: const EdgeInsets.all(16),
        children: [
          const SectionTitle(
            'Reports',
            'Daily summary and school attendance rates.',
          ),
          const SizedBox(height: 12),
          PremiumCard(
            title: 'Daily Summary',
            subtitle: 'Updated live',
            child: GridView.count(
              physics: const NeverScrollableScrollPhysics(),
              shrinkWrap: true,
              crossAxisCount: 2,
              childAspectRatio: 1.8,
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
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
          const SizedBox(height: 12),
          PremiumCard(
            title: 'School Rates',
            subtitle: '${schools.length} school records',
            child: Column(
              children: [
                for (final item in schools.take(60))
                  RecordTile(
                    title: '${(item as Map)['name'] ?? 'School'}',
                    subtitle:
                        '${intValue(item['present'])} of ${intValue(item['enrolled'] ?? item['student_count'])} present',
                    meta: '${intValue(item['rate'])}% attendance',
                  ),
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
              subtitle: 'LRN: ${(student as Map)['lrn'] ?? '-'}',
              meta: 'Status: ${student['status'] ?? 'active'}',
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
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: padding,
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(26),
      border: Border.all(color: border ?? const Color(0xFFE4ECE8)),
      boxShadow: [
        BoxShadow(
          color: const Color(0xFF0B3428).withValues(alpha: .075),
          blurRadius: 24,
          offset: const Offset(0, 12),
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
            ),
          ),
        if (subtitle != null)
          Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 12),
            child: Text(
              subtitle!,
              style: const TextStyle(color: Color(0xFF667872)),
            ),
          ),
        child,
      ],
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

class RecordTile extends StatelessWidget {
  const RecordTile({
    super.key,
    required this.title,
    required this.subtitle,
    required this.meta,
    this.onTap,
    this.color = const Color(0xFF00885B),
  });
  final String title;
  final String subtitle;
  final String meta;
  final VoidCallback? onTap;
  final Color color;

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
          color: const Color(0xFFF8FBF9),
          borderRadius: BorderRadius.circular(19),
          border: Border.all(color: const Color(0xFFE9F1ED)),
        ),
        child: Row(
          children: [
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
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(13),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(23),
      border: Border.all(color: const Color(0xFFE4ECE8)),
      boxShadow: [
        BoxShadow(
          color: const Color(0xFF0B3428).withValues(alpha: .06),
          blurRadius: 18,
          offset: const Offset(0, 10),
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
              style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 13),
            ),
            Text(
              caption,
              style: const TextStyle(color: Color(0xFF74827E), fontSize: 10),
            ),
          ],
        ),
      ],
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
int intValue(dynamic value) => int.tryParse('$value') ?? 0;
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

String greeting() {
  final hour = DateTime.now().hour;
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
