import 'package:flutter/material.dart';

import 'api.dart';
import 'settings.dart';
import 'store.dart';
import 'theme.dart';
import 'screens/pair_screen.dart';
import 'screens/sessions_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppSettings.instance.load();
  runApp(const EasyAIConfigApp());
}

class EasyAIConfigApp extends StatelessWidget {
  const EasyAIConfigApp({super.key});

  @override
  Widget build(BuildContext context) {
    // Calm 单一主题：不做明暗切换，整体安静统一。
    return MaterialApp(
      title: 'Easy AI Config',
      debugShowCheckedModeBanner: false,
      theme: calmTheme(),
      // 钳制系统字体缩放，避免大字号设置把界面撑爆（"比例太大"的主因之一）。
      builder: (context, child) {
        final mq = MediaQuery.of(context);
        return MediaQuery(
          data: mq.copyWith(
            textScaler: mq.textScaler.clamp(maxScaleFactor: 1.05),
          ),
          child: child ?? const SizedBox.shrink(),
        );
      },
      home: const _Boot(),
    );
  }
}

class _Boot extends StatefulWidget {
  const _Boot();
  @override
  State<_Boot> createState() => _BootState();
}

class _BootState extends State<_Boot> {
  @override
  void initState() {
    super.initState();
    _go();
  }

  Future<void> _go() async {
    final server = await Store.currentServer();
    if (!mounted) return;
    if (server != null) {
      final client = ApiClient(baseUrl: server.baseUrl, token: server.token);
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) => SessionsScreen(client: client, server: server),
        ),
      );
    } else {
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(builder: (_) => const PairScreen()),
      );
    }
  }

  @override
  Widget build(BuildContext context) =>
      const Scaffold(body: Center(child: CircularProgressIndicator()));
}
