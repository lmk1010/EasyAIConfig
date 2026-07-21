import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:xterm/xterm.dart';

import '../api.dart';
import '../settings.dart';
import '../theme.dart';
import 'sessions_screen.dart';

/// 终端页：全屏 xterm，点终端弹系统键盘；无丑输入框。
/// 右上角悬浮菜单；底部半透明快捷键可收起。保留系统状态栏。
class TerminalScreen extends StatefulWidget {
  final ApiClient client;
  final SessionInfo session;
  final String? displayTitle;
  const TerminalScreen({
    super.key,
    required this.client,
    required this.session,
    this.displayTitle,
  });
  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> {
  late final Terminal _terminal;
  final ScrollController _scrollController = ScrollController();
  final FocusNode _termFocus = FocusNode();
  final GlobalKey<TerminalViewState> _termKey = GlobalKey<TerminalViewState>();
  late final TerminalController _termController;

  int _cursor = 0;
  bool _reading = false;
  bool _running = true;
  bool _disposed = false;

  bool _landscape = false;
  /// Enter/y/n 半透明条；默认开（无输入框时靠它确认）
  bool _keysOpen = true;

  StreamSubscription<TerminalStreamEvent>? _streamSub;
  Timer? _pollTimer;
  Timer? _reconnectTimer;
  int _reconnectAttempts = 0;
  static const int _maxReconnect = 5;

  @override
  void initState() {
    super.initState();
    _running = widget.session.running;
    _termController = TerminalController();
    _terminal = Terminal(maxLines: 10000);
    _terminal.onOutput = (data) => _send(data);
    _terminal.onResize = (w, h, pw, ph) {
      widget.client.resizeSession(widget.session.id, w, h);
    };
    _applyWakelock();
    AppSettings.instance.keepAwake.addListener(_applyWakelock);
    _start();
    // 进页后稍晚要一次软键盘焦点，方便直接打字
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_disposed) _termKey.currentState?.requestKeyboard();
    });
  }

  @override
  void dispose() {
    _disposed = true;
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    AppSettings.instance.keepAwake.removeListener(_applyWakelock);
    WakelockPlus.disable();
    _reconnectTimer?.cancel();
    _pollTimer?.cancel();
    _streamSub?.cancel();
    _scrollController.dispose();
    _termFocus.dispose();
    _termController.dispose();
    super.dispose();
  }

  void _applyWakelock() {
    WakelockPlus.toggle(enable: AppSettings.instance.keepAwake.value);
  }

  Future<void> _start() async {
    await _pump(reset: true);
    if (_disposed) return;
    _openStream();
  }

  void _openStream() {
    if (_disposed) return;
    _stopPolling();
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _streamSub?.cancel();
    _streamSub = widget.client.streamSession(widget.session.id, _cursor).listen(
      (evt) {
        if (!mounted || _disposed) return;
        _reconnectAttempts = 0;
        if (evt.exited) {
          if (_running) setState(() => _running = false);
          return;
        }
        if (evt.cursor >= 0) _cursor = evt.cursor;
        if (evt.data.isNotEmpty) _terminal.write(evt.data);
      },
      onError: (_) => _onStreamGone(),
      onDone: _onStreamGone,
      cancelOnError: true,
    );
  }

  void _onStreamGone() {
    if (_disposed) return;
    _streamSub = null;
    if (!_running) {
      _pump();
      return;
    }
    _reconnectAttempts++;
    if (_reconnectAttempts <= _maxReconnect) {
      _reconnectTimer?.cancel();
      _reconnectTimer = Timer(const Duration(milliseconds: 1500), () {
        if (_disposed || !_running) return;
        _openStream();
      });
    } else {
      _startPolling();
    }
  }

  void _startPolling() {
    if (_disposed || _pollTimer != null) return;
    _streamSub?.cancel();
    _streamSub = null;
    _pollTimer =
        Timer.periodic(const Duration(milliseconds: 800), (_) => _pump());
    _pump();
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  Future<void> _pump({bool reset = false}) async {
    if (_reading || _disposed) return;
    _reading = true;
    try {
      final res = await widget.client
          .readSession(widget.session.id, reset ? 0 : _cursor);
      if (!mounted || _disposed) return;
      if (res.ok && res.data != null) {
        final data = (res.data['data'] ?? '') as String;
        if (data.isNotEmpty) _terminal.write(data);
        final c = res.data['cursor'];
        if (c is int) _cursor = c;
        final sess = res.data['session'];
        if (sess is Map && sess['running'] is bool) {
          final r = sess['running'] as bool;
          if (r != _running) setState(() => _running = r);
        }
      }
    } finally {
      _reading = false;
    }
  }

  Future<void> _send(String data) async {
    await widget.client.writeSession(widget.session.id, data);
    if (_pollTimer != null && !_disposed) {
      Future.delayed(const Duration(milliseconds: 80), () => _pump());
    }
  }

  void _tapKey(String data) {
    if (AppSettings.instance.haptics.value) HapticFeedback.selectionClick();
    _send(data);
  }

  void _toggleOrientation() {
    final next = !_landscape;
    setState(() => _landscape = next);
    SystemChrome.setPreferredOrientations(next
        ? [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]
        : [DeviceOrientation.portraitUp]);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    if (AppSettings.instance.haptics.value) HapticFeedback.selectionClick();
  }

  void _scrollToBottom() {
    if (_scrollController.hasClients) {
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    }
  }

  void _showKeyboard() {
    _termKey.currentState?.requestKeyboard();
    _termFocus.requestFocus();
  }

  void _hideKeyboard() {
    _termKey.currentState?.closeKeyboard();
    FocusManager.instance.primaryFocus?.unfocus();
  }

  Future<void> _copyAll() async {
    final text = _terminal.buffer.getText();
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
          content: Text('已复制终端全部输出'), duration: Duration(seconds: 1)),
    );
  }

  Future<void> _copySelection() async {
    final sel = _termController.selection;
    if (sel == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('请先长按或双击选中文字'), duration: Duration(seconds: 1)),
      );
      return;
    }
    final text = _terminal.buffer.getText(sel);
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已复制选区'), duration: Duration(seconds: 1)),
    );
  }

  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text != null && text.isNotEmpty) {
      _send(text);
      _scrollToBottom();
    }
  }

  Future<void> _sendImage() async {
    try {
      final picker = ImagePicker();
      final XFile? file = await picker.pickImage(
        source: ImageSource.gallery,
        maxWidth: 2200,
        imageQuality: 85,
      );
      if (file == null || !mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('图片上传中…'), duration: Duration(seconds: 1)),
      );
      final bytes = await file.readAsBytes();
      final b64 = base64Encode(bytes);
      final res = await widget.client.uploadImage(file.name, b64);
      if (!mounted) return;
      final path =
          (res.ok && res.data is Map) ? res.data['path']?.toString() : null;
      if (path != null && path.isNotEmpty) {
        _send('$path ');
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('上传失败: ${res.error ?? '未知'}')),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('上传异常: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final isLand =
        _landscape || media.orientation == Orientation.landscape;
    final bottomPad = media.padding.bottom;

    return Scaffold(
      backgroundColor: const Color(0xFF0D1117),
      body: Stack(
        children: [
          // 去掉系统 padding，否则 xterm 顶部会空一大块；状态栏半透明盖在内容上
          Positioned.fill(
            child: MediaQuery.removePadding(
              context: context,
              removeTop: true,
              removeBottom: true,
              child: ValueListenableBuilder<double>(
                valueListenable: AppSettings.instance.terminalFontSize,
                builder: (_, fontSize, __) => TerminalView(
                  _terminal,
                  key: _termKey,
                  controller: _termController,
                  focusNode: _termFocus,
                  scrollController: _scrollController,
                  autofocus: true,
                  deleteDetection: true,
                  simulateScroll: true,
                  hardwareKeyboardOnly: false,
                  keyboardType: TextInputType.text,
                  keyboardAppearance: Brightness.dark,
                  padding: EdgeInsets.fromLTRB(
                    isLand ? 4 : 6,
                    media.padding.top + 2,
                    isLand ? 4 : 6,
                    (_keysOpen ? 36.0 : 8.0) + bottomPad,
                  ),
                  textStyle: TerminalStyle(
                    fontSize: isLand
                        ? (fontSize - 1).clamp(10, 22)
                        : fontSize.clamp(11, 22),
                  ),
                  theme: TerminalThemes.defaultTheme,
                ),
              ),
            ),
          ),
          // 右上角悬浮菜单
          Positioned(
            top: media.padding.top + 4,
            right: 10,
            child: _fabMenu(isLand),
          ),
          // 底部半透明快捷键（可收起）
          if (_keysOpen)
            Positioned(
              left: 0,
              right: 0,
              bottom: bottomPad,
              child: _keyStrip(isLand),
            ),
        ],
      ),
    );
  }

  Widget _fabMenu(bool isLand) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () => _openChromeMenu(isLand),
        borderRadius: BorderRadius.circular(22),
        child: Ink(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: const Color(0x66101820),
            borderRadius: BorderRadius.circular(22),
            border: Border.all(color: const Color(0x55FFFFFF)),
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              const Icon(Icons.menu_rounded, size: 20, color: Colors.white),
              Positioned(
                right: 8,
                top: 8,
                child: Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: _running ? kRunning : kExited,
                    border:
                        Border.all(color: const Color(0xFF0D1117), width: 1),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _keyStrip(bool isLand) {
    const keys = <(String, String)>[
      ('Enter', '\r'),
      ('y', 'y'),
      ('n', 'n'),
      ('Esc', '\x1b'),
      ('^C', '\x03'),
      ('Tab', '\t'),
      ('↑', '\x1b[A'),
      ('↓', '\x1b[B'),
      ('←', '\x1b[D'),
      ('→', '\x1b[C'),
    ];
    return Material(
      color: const Color(0x99101820),
      child: SizedBox(
        height: isLand ? 32 : 36,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          itemCount: keys.length + 2,
          separatorBuilder: (_, __) => const SizedBox(width: 5),
          itemBuilder: (_, i) {
            if (i == keys.length) {
              return Center(
                child: _miniChip(
                  icon: Icons.keyboard_outlined,
                  label: '键盘',
                  onTap: _showKeyboard,
                ),
              );
            }
            if (i == keys.length + 1) {
              return Center(
                child: _miniChip(
                  icon: Icons.keyboard_arrow_down,
                  label: '收起',
                  onTap: () => setState(() => _keysOpen = false),
                ),
              );
            }
            final k = keys[i];
            return Center(
              child: GestureDetector(
                onTap: () => _tapKey(k.$2),
                child: Container(
                  padding: EdgeInsets.symmetric(
                      horizontal: isLand ? 10 : 11,
                      vertical: isLand ? 4 : 5),
                  decoration: BoxDecoration(
                    color: const Color(0x44FFFFFF),
                    borderRadius: BorderRadius.circular(7),
                  ),
                  child: Text(k.$1,
                      style: TextStyle(
                          color: Colors.white,
                          fontSize: isLand ? 11.5 : 12,
                          fontWeight: FontWeight.w500)),
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _miniChip({
    IconData? icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: const Color(0x44FFFFFF),
          borderRadius: BorderRadius.circular(7),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: 14, color: Colors.white70),
              const SizedBox(width: 3),
            ],
            Text(label,
                style: const TextStyle(
                    fontSize: 11.5,
                    color: Colors.white70,
                    fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }

  void _openChromeMenu(bool isLand) {
    showModalBottomSheet(
      context: context,
      backgroundColor: kBg,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) => SafeArea(
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(height: 8),
              Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: kLine,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(height: 4),
              ListTile(
                dense: true,
                leading: const Icon(Icons.arrow_back),
                title: const Text('返回会话列表'),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.pop(context);
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.keyboard_outlined),
                title: const Text('弹出系统键盘'),
                subtitle: const Text('点终端空白处也可输入'),
                onTap: () {
                  Navigator.pop(context);
                  _showKeyboard();
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.keyboard_hide_outlined),
                title: const Text('收起系统键盘'),
                onTap: () {
                  Navigator.pop(context);
                  _hideKeyboard();
                },
              ),
              ListTile(
                dense: true,
                leading: Icon(
                  _keysOpen
                      ? Icons.expand_more
                      : Icons.keyboard_alt_outlined,
                ),
                title: Text(_keysOpen ? '收起快捷键条' : '展开快捷键条'),
                onTap: () {
                  Navigator.pop(context);
                  setState(() => _keysOpen = !_keysOpen);
                },
              ),
              ListTile(
                dense: true,
                leading: Icon(isLand
                    ? Icons.stay_current_portrait
                    : Icons.stay_current_landscape),
                title: Text(isLand ? '切换竖屏' : '切换横屏'),
                onTap: () {
                  Navigator.pop(context);
                  _toggleOrientation();
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.more_horiz),
                title: const Text('更多控制键'),
                onTap: () {
                  Navigator.pop(context);
                  _openKeysSheet();
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.content_paste),
                title: const Text('粘贴剪贴板'),
                onTap: () {
                  Navigator.pop(context);
                  _paste();
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.copy_outlined),
                title: const Text('复制选区'),
                subtitle: const Text('先长按 / 双击选中'),
                onTap: () {
                  Navigator.pop(context);
                  _copySelection();
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.copy_all_outlined),
                title: const Text('复制全部输出'),
                onTap: () {
                  Navigator.pop(context);
                  _copyAll();
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.image_outlined),
                title: const Text('发送图片路径'),
                onTap: () {
                  Navigator.pop(context);
                  _sendImage();
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.vertical_align_bottom),
                title: const Text('滚动到底部'),
                onTap: () {
                  Navigator.pop(context);
                  _scrollToBottom();
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.text_increase),
                title: const Text('放大字号'),
                onTap: () {
                  Navigator.pop(context);
                  AppSettings.instance.bumpFont(1);
                },
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.text_decrease),
                title: const Text('缩小字号'),
                onTap: () {
                  Navigator.pop(context);
                  AppSettings.instance.bumpFont(-1);
                },
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
  }

  void _openKeysSheet() {
    Widget chip(String label, String data) => GestureDetector(
          onTap: () => _tapKey(data),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
            decoration: BoxDecoration(
              color: kSurfaceHigh,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(label,
                style: const TextStyle(
                    color: kText, fontSize: 12.5, fontWeight: FontWeight.w500)),
          ),
        );
    showModalBottomSheet(
      context: context,
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('导航键',
                  style: TextStyle(color: kMuted, fontSize: 11.5)),
              const SizedBox(height: 6),
              Wrap(spacing: 6, runSpacing: 6, children: [
                chip('Esc', '\x1b'),
                chip('Home', '\x1b[H'),
                chip('End', '\x1b[F'),
                chip('PgUp', '\x1b[5~'),
                chip('PgDn', '\x1b[6~'),
                chip('Del', '\x1b[3~'),
                chip('^D', '\x04'),
              ]),
              const SizedBox(height: 12),
              const Text('Ctrl',
                  style: TextStyle(color: kMuted, fontSize: 11.5)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: List.generate(26, (i) {
                  final letter = String.fromCharCode(65 + i);
                  final code = String.fromCharCode(1 + i);
                  return chip('^$letter', code);
                }),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
