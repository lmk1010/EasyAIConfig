import 'package:flutter/material.dart';

import '../api.dart';
import '../models/server.dart';
import '../store.dart';
import '../theme.dart';
import 'scan_screen.dart';
import 'sessions_screen.dart';

/// 配对页：扫码或手动填写「地址 + token」，测试连通后保存进服务列表。
///
/// [popOnSuccess] 为 true 时（从「服务管理」里新增），配对成功仅 pop 返回新服务；
/// 否则（首次配对）直接进入会话列表。
class PairScreen extends StatefulWidget {
  final bool popOnSuccess;
  const PairScreen({super.key, this.popOnSuccess = false});
  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _name = TextEditingController();
  final _url = TextEditingController();
  final _token = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final raw = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (_) => const ScanScreen()),
    );
    if (raw == null) return;
    final parsed = parsePairing(raw);
    if (parsed == null) {
      setState(() => _error = '二维码无法识别');
      return;
    }
    _url.text = parsed.$1;
    _token.text = parsed.$2;
    _connect();
  }

  Future<void> _connect() async {
    // 允许把完整链接粘进地址栏，自动拆出 token
    final maybe = parsePairing(_url.text);
    var base = _url.text.trim();
    var token = _token.text.trim();
    if (maybe != null) {
      base = maybe.$1;
      if (token.isEmpty) token = maybe.$2;
    }
    if (base.isEmpty || token.isEmpty) {
      setState(() => _error = '请填写地址和 token（或扫码）');
      return;
    }
    if (!base.startsWith('http')) base = 'http://$base';

    setState(() {
      _busy = true;
      _error = null;
    });
    final client = ApiClient(baseUrl: base, token: token);
    final res = await client.listSessions();
    if (!mounted) return;
    setState(() => _busy = false);
    if (res.ok) {
      final server = await Store.upsertFromPairing(
        base,
        token,
        name: _name.text.trim().isEmpty ? null : _name.text.trim(),
      );
      if (!mounted) return;
      if (widget.popOnSuccess) {
        Navigator.pop<ServerConfig>(context, server);
      } else {
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(
            builder: (_) => SessionsScreen(client: client, server: server),
          ),
        );
      }
    } else {
      setState(() => _error = res.error ?? '连接失败');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: widget.popOnSuccess ? AppBar(title: const Text('添加服务')) : null,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(20),
                    child: Image.asset(
                      'assets/icon/app_icon.png',
                      width: 84,
                      height: 84,
                      filterQuality: FilterQuality.medium,
                    ),
                  ),
                  const SizedBox(height: 14),
                  const Text('Easy AI Config',
                      textAlign: TextAlign.center,
                      style:
                          TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 6),
                  const Text('远程操作电脑上的 Codex / Claude Code',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: kMuted, fontSize: 13)),
                  const SizedBox(height: 28),
                  FilledButton.icon(
                    onPressed: _busy ? null : _scan,
                    icon: const Icon(Icons.qr_code_scanner),
                    label: const Text('扫码配对'),
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                  ),
                  const SizedBox(height: 18),
                  const Row(children: [
                    Expanded(child: Divider()),
                    Padding(
                      padding: EdgeInsets.symmetric(horizontal: 10),
                      child:
                          Text('或手动输入', style: TextStyle(color: kFaint)),
                    ),
                    Expanded(child: Divider()),
                  ]),
                  const SizedBox(height: 14),
                  TextField(
                    controller: _name,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: '服务名称（可选）',
                      hintText: '如：家里的 Mac',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _url,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: '服务地址 / 完整链接',
                      hintText: 'http://192.168.1.10:8790',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _token,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'token',
                      hintText: '电脑端「远程访问」里显示',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!,
                        style: const TextStyle(color: kExited)),
                  ],
                  const SizedBox(height: 18),
                  FilledButton(
                    onPressed: _busy ? null : _connect,
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    child: _busy
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('连接'),
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
