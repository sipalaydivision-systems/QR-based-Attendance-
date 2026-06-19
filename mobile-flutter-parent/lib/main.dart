import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

const String kBaseUrl = 'https://sdo-sipalay-edutrack.up.railway.app';
const Color kGreen = Color(0xFF16A34A);
const Color kGreenDark = Color(0xFF15803D);
const Color kInk = Color(0xFF111827);
const Color kMuted = Color(0xFF6B7280);
const String kNoNet = 'No internet connection. Please check your network.';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
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

  Exception _netError(Object e) {
    if (e is SocketException || e is TimeoutException) return Exception(kNoNet);
    return Exception('Unable to connect to the server right now.');
  }

  Future<Map<String, dynamic>> login(String identifier, String password) async {
    try {
      final res = await http
          .post(
            Uri.parse('$kBaseUrl/api/parent/login'),
            headers: const {'Accept': 'application/json'},
            body: {'identifier': identifier, 'password': password},
          )
          .timeout(const Duration(seconds: 20));
      _captureCookie(res);
      final data = _decode(res.body);
      if (res.statusCode == 200 && data['success'] == true) {
        await _saveParent(data['parent'] as Map<String, dynamic>?);
        return {'success': true};
      }
      return {'success': false, 'error': data['error'] ?? 'Login failed.'};
    } catch (e) {
      return {'success': false, 'error': _netError(e).toString().replaceFirst('Exception: ', '')};
    }
  }

  Future<Map<String, dynamic>> register(Map<String, String> body) async {
    try {
      final res = await http
          .post(
            Uri.parse('$kBaseUrl/api/parent/register'),
            headers: const {'Accept': 'application/json'},
            body: body,
          )
          .timeout(const Duration(seconds: 20));
      _captureCookie(res);
      final data = _decode(res.body);
      if (res.statusCode == 200 && data['success'] == true) {
        await _saveParent(data['parent'] as Map<String, dynamic>?);
        return {'success': true};
      }
      return {'success': false, 'error': data['error'] ?? 'Registration failed.'};
    } catch (e) {
      return {'success': false, 'error': _netError(e).toString().replaceFirst('Exception: ', '')};
    }
  }

  Future<Map<String, dynamic>> dashboard() async {
    final res = await http
        .get(Uri.parse('$kBaseUrl/api/parent/dashboard'), headers: _headers)
        .timeout(const Duration(seconds: 20));
    if (res.statusCode == 401) throw Exception('SESSION_EXPIRED');
    return _decode(res.body);
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
// App shell
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
        scaffoldBackgroundColor: const Color(0xFFF1F5F9),
        colorScheme: ColorScheme.fromSeed(seedColor: kGreen, primary: kGreen),
        fontFamily: 'Roboto',
        appBarTheme: const AppBarTheme(
          backgroundColor: Colors.white,
          foregroundColor: kInk,
          elevation: 0,
          centerTitle: false,
        ),
      ),
      home: api.isLoggedIn ? HomeShell(api: api) : LoginScreen(api: api),
    );
  }
}

// ---------------------------------------------------------------------------
// Login — mirrors the adviser login design (green gradient + white card).
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
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => HomeShell(api: widget.api)),
      );
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
                icon: Icons.family_restroom,
                children: [
                  if (_error != null) AuthAlert(message: _error!),
                  AuthField(
                    controller: _id,
                    label: 'Mobile Number or Username',
                    hint: 'e.g. 09171234567',
                    icon: Icons.person_outline,
                    keyboardType: TextInputType.text,
                  ),
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
                  AuthButton(
                    label: 'Sign In',
                    busy: _busy,
                    onPressed: _busy ? null : _submit,
                  ),
                  const SizedBox(height: 14),
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => Navigator.of(context).push(
                              MaterialPageRoute(builder: (_) => RegisterScreen(api: widget.api)),
                            ),
                    child: const Text.rich(
                      TextSpan(
                        text: "Don't have an account?  ",
                        style: TextStyle(color: kMuted, fontSize: 13),
                        children: [
                          TextSpan(
                            text: 'Register',
                            style: TextStyle(color: kGreen, fontWeight: FontWeight.w800),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'For registered parents/guardians only',
                    style: TextStyle(color: Color(0xFF9CA3AF), fontSize: 11.5),
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

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------
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
      Navigator.of(context).pushAndRemoveUntil(
        MaterialPageRoute(builder: (_) => HomeShell(api: widget.api)),
        (route) => false,
      );
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
                icon: Icons.person_add_alt_1,
                children: [
                  if (_error != null) AuthAlert(message: _error!),
                  AuthField(controller: _name, label: 'Parent / Guardian Name', hint: 'Full name', icon: Icons.badge_outlined),
                  const SizedBox(height: 12),
                  AuthField(
                    controller: _contact,
                    label: 'Registered Contact Number',
                    hint: 'e.g. 09171234567',
                    icon: Icons.phone_outlined,
                    keyboardType: TextInputType.phone,
                  ),
                  const SizedBox(height: 12),
                  AuthField(controller: _username, label: 'Username (optional)', hint: 'Choose a username', icon: Icons.alternate_email),
                  const SizedBox(height: 12),
                  AuthField(
                    controller: _pw,
                    label: 'Password',
                    hint: 'At least 6 characters',
                    icon: Icons.lock_outline,
                    obscure: _obscure,
                    onToggleObscure: () => setState(() => _obscure = !_obscure),
                  ),
                  const SizedBox(height: 12),
                  AuthField(
                    controller: _confirm,
                    label: 'Confirm Password',
                    hint: 'Re-enter password',
                    icon: Icons.lock_outline,
                    obscure: _obscure,
                  ),
                  const SizedBox(height: 18),
                  AuthButton(label: 'Create Account', busy: _busy, onPressed: _busy ? null : _submit),
                  const SizedBox(height: 10),
                  TextButton(
                    onPressed: _busy ? null : () => Navigator.of(context).pop(),
                    child: const Text('Back to Sign In', style: TextStyle(color: kGreen, fontWeight: FontWeight.w700)),
                  ),
                  const Padding(
                    padding: EdgeInsets.only(top: 4),
                    child: Text(
                      'Use the contact number registered with your child’s school.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Color(0xFF9CA3AF), fontSize: 11.5),
                    ),
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

// ---------------------------------------------------------------------------
// Shared auth widgets
// ---------------------------------------------------------------------------
class AuthCard extends StatelessWidget {
  const AuthCard({super.key, required this.subtitle, required this.icon, required this.children});
  final String subtitle;
  final IconData icon;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 420,
      constraints: const BoxConstraints(maxWidth: 420),
      padding: const EdgeInsets.fromLTRB(28, 36, 28, 28),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(22),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 40, offset: const Offset(0, 8))],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 78,
            height: 78,
            decoration: const BoxDecoration(color: Color(0xFFDCFCE7), shape: BoxShape.circle),
            child: Icon(icon, color: kGreen, size: 38),
          ),
          const SizedBox(height: 14),
          const Text('EduTrack', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: kInk)),
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
      decoration: BoxDecoration(
        color: const Color(0xFFFEF2F2),
        border: Border.all(color: const Color(0xFFFECACA)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: Color(0xFFDC2626), size: 18),
          const SizedBox(width: 8),
          Expanded(child: Text(message, style: const TextStyle(color: Color(0xFFDC2626), fontSize: 12.5))),
        ],
      ),
    );
  }
}

class AuthField extends StatelessWidget {
  const AuthField({
    super.key,
    required this.controller,
    required this.label,
    required this.icon,
    this.hint,
    this.obscure = false,
    this.keyboardType,
    this.onToggleObscure,
  });
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
        Text(label.toUpperCase(),
            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: kMuted, letterSpacing: 0.4)),
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
                : IconButton(
                    onPressed: onToggleObscure,
                    icon: Icon(obscure ? Icons.visibility_off : Icons.visibility, size: 19, color: kMuted),
                  ),
            isDense: true,
            contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
            filled: true,
            fillColor: Colors.white,
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: const BorderSide(color: Color(0xFFD1D5DB), width: 1.5),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: const BorderSide(color: kGreen, width: 1.6),
            ),
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
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.transparent,
            shadowColor: Colors.transparent,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
          child: busy
              ? const SizedBox(
                  width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 15)),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Home shell with 5 tabs
// ---------------------------------------------------------------------------
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.api});
  final ParentApi api;
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;
  int _child = 0;
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _data = {};
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 45), (_) => _load(silent: true));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  List<dynamic> get _children => (_data['children'] as List?) ?? const [];
  List<dynamic> get _notifications => (_data['notifications'] as List?) ?? const [];
  Map<String, dynamic>? get _selectedChild {
    if (_children.isEmpty) return null;
    final i = _child.clamp(0, _children.length - 1);
    return _children[i] as Map<String, dynamic>;
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() => _loading = true);
    try {
      final data = await widget.api.dashboard();
      if (!mounted) return;
      setState(() {
        _data = data;
        _loading = false;
        _error = null;
      });
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

  Future<void> _logout() async {
    await widget.api.logout();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => LoginScreen(api: widget.api)),
      (route) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final titles = ['Home', 'Attendance', 'Notifications', 'Adviser', 'Profile'];
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: Row(
          children: [
            const CircleAvatar(radius: 14, backgroundColor: Color(0xFFDCFCE7), child: Icon(Icons.school, color: kGreen, size: 16)),
            const SizedBox(width: 8),
            Text(titles[_tab], style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
          ],
        ),
        actions: [
          IconButton(onPressed: () => _load(), icon: const Icon(Icons.refresh, color: kMuted)),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: kGreen))
          : RefreshIndicator(
              color: kGreen,
              onRefresh: _load,
              child: _buildTab(),
            ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        height: 64,
        backgroundColor: Colors.white,
        indicatorColor: const Color(0xFFDCFCE7),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home, color: kGreen), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.assignment_outlined), selectedIcon: Icon(Icons.assignment, color: kGreen), label: 'Attendance'),
          NavigationDestination(icon: Icon(Icons.notifications_outlined), selectedIcon: Icon(Icons.notifications, color: kGreen), label: 'Alerts'),
          NavigationDestination(icon: Icon(Icons.phone_outlined), selectedIcon: Icon(Icons.phone, color: kGreen), label: 'Adviser'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person, color: kGreen), label: 'Profile'),
        ],
      ),
    );
  }

  Widget _buildTab() {
    if (_error != null && _children.isEmpty) {
      return ListView(children: [Padding(padding: const EdgeInsets.all(40), child: _emptyState(Icons.wifi_off, _error!))]);
    }
    if (_children.isEmpty) {
      return ListView(children: [
        Padding(
          padding: const EdgeInsets.all(40),
          child: _emptyState(Icons.child_care, 'No linked students found for your contact number. Please contact the school adviser.'),
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
        return ProfileTab(api: widget.api, childCount: _children.length, onLogout: _logout);
      default:
        return HomeTab(child: _selectedChild!, picker: _childPicker());
    }
  }

  Widget? _childPicker() {
    if (_children.length < 2) return null;
    return SizedBox(
      height: 44,
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

  Widget _emptyState(IconData icon, String text) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(icon, size: 46, color: const Color(0xFFCBD5E1)),
        const SizedBox(height: 12),
        Text(text, textAlign: TextAlign.center, style: const TextStyle(color: kMuted, fontSize: 13.5)),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
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
      return const Color(0xFFD97706);
    case 'late':
      return const Color(0xFFD97706);
    default:
      return kGreen;
  }
}

// ---------------------------------------------------------------------------
// Home tab — child summary card
// ---------------------------------------------------------------------------
class HomeTab extends StatelessWidget {
  const HomeTab({super.key, required this.child, this.picker});
  final Map<String, dynamic> child;
  final Widget? picker;

  @override
  Widget build(BuildContext context) {
    final status = '${child['current_status'] ?? 'Absent'}';
    final today = '${child['today_status'] ?? 'Absent'}';
    final latest = '${child['latest_scan_time'] ?? ''}';
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        if (picker != null) Padding(padding: const EdgeInsets.only(top: 12), child: picker!),
        const SizedBox(height: 12),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Card(
            elevation: 0,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      CircleAvatar(
                        radius: 26,
                        backgroundColor: const Color(0xFFEEF2FF),
                        child: Text(
                          _initials('${child['name']}'),
                          style: const TextStyle(color: Color(0xFF4F46E5), fontWeight: FontWeight.w800),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('${child['name']}', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: kInk)),
                            const SizedBox(height: 2),
                            Text('LRN: ${child['lrn']?.toString().isNotEmpty == true ? child['lrn'] : 'N/A'}',
                                style: const TextStyle(fontSize: 12, color: kMuted)),
                          ],
                        ),
                      ),
                      StatusPill(label: status),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _infoRow(Icons.layers_outlined, 'Grade & Section', '${child['grade_level']} • ${child['section']}'),
                  _infoRow(Icons.account_balance_outlined, 'School', '${child['school_name']}'),
                  _infoRow(Icons.co_present, 'Adviser', '${child['adviser_name']}'),
                  const Divider(height: 26),
                  Row(
                    children: [
                      Expanded(child: _miniStat('Today', today, statusColor(today))),
                      Container(width: 1, height: 38, color: const Color(0xFFF1F5F9)),
                      Expanded(child: _miniStat('Latest Scan', latest.isEmpty ? '—' : latest, kInk)),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
        if (((child['consecutive_absences'] as num?)?.toInt() ?? 0) >= 2)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: const Color(0xFFFEF2F2),
                border: Border.all(color: const Color(0xFFFECACA)),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber_rounded, color: Color(0xFFDC2626)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      '${child['name']} has ${child['consecutive_absences']} consecutive absences. Please contact the adviser.',
                      style: const TextStyle(color: Color(0xFF991B1B), fontSize: 12.5, fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _infoRow(IconData icon, String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 17, color: kMuted),
          const SizedBox(width: 10),
          Text('$label:  ', style: const TextStyle(fontSize: 12.5, color: kMuted)),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: kInk))),
        ],
      ),
    );
  }

  Widget _miniStat(String label, String value, Color color) {
    return Column(
      children: [
        Text(value, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: color)),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(fontSize: 10.5, color: kMuted, fontWeight: FontWeight.w600)),
      ],
    );
  }
}

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
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
      child: Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w800, fontSize: 11.5)),
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
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        if (picker != null) Padding(padding: const EdgeInsets.only(top: 12), child: picker!),
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 8),
          child: Text("Today’s Scan History", style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: kInk)),
        ),
        if (timeline.isEmpty)
          const Padding(
            padding: EdgeInsets.all(40),
            child: Center(child: Text('No scans recorded yet today.', style: TextStyle(color: kMuted))),
          )
        else
          ...timeline.map((e) {
            final entry = e as Map<String, dynamic>;
            final tone = '${entry['tone'] ?? 'in'}';
            return Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
              child: Card(
                elevation: 0,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                child: ListTile(
                  leading: CircleAvatar(
                    backgroundColor: toneColor(tone).withValues(alpha: 0.12),
                    child: Icon(toneIcon(tone), color: toneColor(tone), size: 20),
                  ),
                  title: Text('${entry['label_display'] ?? entry['label']}',
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5, color: kInk)),
                  subtitle: Text('${entry['time_display'] ?? ''}', style: const TextStyle(fontSize: 12, color: kMuted)),
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
class NotificationsTab extends StatelessWidget {
  const NotificationsTab({super.key, required this.notifications});
  final List<dynamic> notifications;
  @override
  Widget build(BuildContext context) {
    if (notifications.isEmpty) {
      return ListView(children: const [
        Padding(padding: EdgeInsets.all(40), child: Center(child: Text('No notifications yet.', style: TextStyle(color: kMuted)))),
      ]);
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 12),
      itemCount: notifications.length,
      itemBuilder: (_, i) {
        final n = notifications[i] as Map<String, dynamic>;
        final tone = '${n['tone'] ?? 'in'}';
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
          child: Card(
            elevation: 0,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            child: ListTile(
              leading: CircleAvatar(
                backgroundColor: toneColor(tone).withValues(alpha: 0.12),
                child: Icon(toneIcon(tone), color: toneColor(tone), size: 20),
              ),
              title: Text('${n['title']}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5, color: kInk)),
              subtitle: Text('${n['message']}', style: const TextStyle(fontSize: 12, color: kMuted)),
            ),
          ),
        );
      },
    );
  }
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
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open this action.')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final adviser = '${child['adviser_name'] ?? 'No adviser assigned'}';
    final contact = '${child['adviser_contact'] ?? ''}'.trim();
    final email = '${child['adviser_email'] ?? ''}'.trim();
    final phone = contact.replaceAll(RegExp(r'[^0-9+]'), '');
    final body = Uri.encodeComponent(
        'Good day Teacher, this is the parent/guardian of ${child['name']} (${child['grade_level']} - ${child['section']}). ');
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        if (picker != null) Padding(padding: const EdgeInsets.only(top: 12), child: picker!),
        const SizedBox(height: 12),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Card(
            elevation: 0,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const CircleAvatar(radius: 22, backgroundColor: Color(0xFFDCFCE7), child: Icon(Icons.co_present, color: kGreen)),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(adviser, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: kInk)),
                            Text('Class Adviser • ${child['section']}', style: const TextStyle(fontSize: 12, color: kMuted)),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 18),
                  if (phone.isNotEmpty) ...[
                    _actionButton(context, Icons.call, 'Call Adviser', kGreen, Uri.parse('tel:$phone')),
                    const SizedBox(height: 10),
                    _actionButton(context, Icons.sms, 'Send SMS', const Color(0xFF2563EB), Uri.parse('sms:$phone?body=$body')),
                    const SizedBox(height: 10),
                  ],
                  if (email.isNotEmpty)
                    _actionButton(context, Icons.email, 'Send Email', const Color(0xFFEA580C),
                        Uri.parse('mailto:$email?subject=Attendance%20Inquiry&body=$body')),
                  if (phone.isEmpty && email.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 6),
                      child: Text('No adviser contact details on file. Please reach the school office.',
                          style: TextStyle(color: kMuted, fontSize: 12.5)),
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _actionButton(BuildContext context, IconData icon, String label, Color color, Uri uri) {
    return SizedBox(
      width: double.infinity,
      height: 46,
      child: OutlinedButton.icon(
        onPressed: () => _launch(context, uri),
        icon: Icon(icon, color: color, size: 19),
        label: Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w700)),
        style: OutlinedButton.styleFrom(
          side: BorderSide(color: color.withValues(alpha: 0.4)),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Profile tab
// ---------------------------------------------------------------------------
class ProfileTab extends StatelessWidget {
  const ProfileTab({super.key, required this.api, required this.childCount, required this.onLogout});
  final ParentApi api;
  final int childCount;
  final VoidCallback onLogout;
  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          elevation: 0,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              children: [
                CircleAvatar(
                  radius: 34,
                  backgroundColor: const Color(0xFFDCFCE7),
                  child: Text(_initials(api.parentName), style: const TextStyle(color: kGreen, fontWeight: FontWeight.w800, fontSize: 22)),
                ),
                const SizedBox(height: 12),
                Text(api.parentName, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: kInk)),
                const SizedBox(height: 2),
                Text('Parent / Guardian', style: const TextStyle(fontSize: 12.5, color: kMuted)),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          elevation: 0,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          child: Column(
            children: [
              _tile(Icons.phone_outlined, 'Contact Number', api.parentContact.isEmpty ? '—' : api.parentContact),
              const Divider(height: 1),
              _tile(Icons.alternate_email, 'Username', api.parentUsername.isEmpty ? '—' : api.parentUsername),
              const Divider(height: 1),
              _tile(Icons.family_restroom, 'Linked Children', '$childCount'),
            ],
          ),
        ),
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          height: 48,
          child: OutlinedButton.icon(
            onPressed: () async {
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
              if (ok == true) onLogout();
            },
            icon: const Icon(Icons.logout, color: Color(0xFFDC2626), size: 19),
            label: const Text('Log Out', style: TextStyle(color: Color(0xFFDC2626), fontWeight: FontWeight.w700)),
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: Color(0xFFFECACA)),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            ),
          ),
        ),
        const SizedBox(height: 20),
        const Center(child: Text('EduTrack Parent • v1.0.0', style: TextStyle(color: Color(0xFF9CA3AF), fontSize: 11.5))),
      ],
    );
  }

  Widget _tile(IconData icon, String label, String value) {
    return ListTile(
      leading: Icon(icon, color: kMuted, size: 20),
      title: Text(label, style: const TextStyle(fontSize: 12.5, color: kMuted)),
      trailing: Text(value, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: kInk)),
    );
  }
}
