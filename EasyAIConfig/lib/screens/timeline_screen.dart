import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../api.dart';
import '../settings.dart';
import '../theme.dart';
import '../widgets/chat_composer.dart';
import '../widgets/codex_usage_sheet.dart';
import 'sessions_screen.dart';
import 'terminal_screen.dart';

/// 原生 timeline 会话页（对标 Codex/Claude app）：把 codex 的结构化对话
/// 渲染成消息流；输入 / 审批仍回写给 CLI 进程。遇到覆盖不到的场景可切「原始终端」。
class TimelineScreen extends StatefulWidget {
  final ApiClient client;
  final SessionInfo session;
  final String? displayTitle;
  const TimelineScreen({
    super.key,
    required this.client,
    required this.session,
    this.displayTitle,
  });
  @override
  State<TimelineScreen> createState() => _TimelineScreenState();
}

class _Msg {
  final int seq;
  final String role; // user | assistant | reasoning | tool
  final String kind; // text | reasoning | tool_call | tool_output
  String text;
  final String tool; // exec | patch | read | tool（仅 tool_call）
  String itemId; // app-server item id（流式增量用）；乐观插入用 pending:/client:
  _Msg(this.seq, this.role, this.kind, this.text,
      {this.tool = '', this.itemId = ''});
}

/// 渲染条目：普通消息，或「工具调用+输出」合并成的一张可折叠卡。
class _RenderEntry {
  final _Msg? msg;
  final _Msg? toolCall;
  final _Msg? toolOutput;
  _RenderEntry.message(this.msg)
      : toolCall = null,
        toolOutput = null;
  _RenderEntry.tool(this.toolCall, this.toolOutput) : msg = null;
  bool get isTool => toolCall != null;
}

class _TimelineScreenState extends State<TimelineScreen> {
  final _scroll = ScrollController();
  final _compose = TextEditingController();
  final List<_Msg> _messages = [];
  final Set<int> _seen = {};
  int _cursor = 0;
  bool _running = true;
  bool _loading = true;
  bool _bridgeWarming = false; // 刚进快速通道：空屏也要有就绪动画
  bool _awaitingReply = false; // 已发送、等待 codex 回复 → 显示"思考中"
  DateTime? _awaitingSince; // 思考开始时间，用于显示已用秒数
  final Set<int> _revealed = {}; // 已完成打字动画的 assistant 消息 seq
  Timer? _timer;
  bool _atBottom = true;
  int _failStreak = 0; // 连续拉取失败次数 → 触发"重连中"
  bool _reconnecting = false; // 断线重连中(桌面重启/网络抖动)
  bool _sessionGone = false; // 会话已结束/被清理(需恢复或返回)
  int _goneStreak = 0; // 连续「会话不存在」次数(避免误判)
  String _model = ''; // 当前模型(顶部状态条)
  String _effort = ''; // 当前推理级别
  int _tokenTotal = 0; // 已用 token（上下文占用）
  int _contextWindow = 0; // 上下文窗口
  Map? _approval; // codex 待审批提示(命令 + 选项) / 模型-推理级别选择器
  bool _checkingApproval = false;
  bool _polling = false; // 防重入：上一轮 poll 未完则跳过
  DateTime? _lastPickerCheck; // 节流 picker 检测(vt100 渲染较重)
  DateTime? _lastMetaPoll; // 节流：token / TUI 状态条
  bool _manualPickerOpen = false; // 用户从菜单主动进「切换模型/推理」流程，暂停自动 surface
  DateTime? _fastPollUntil; // 发送后短时加速拉 timeline
  late final bool _bridge; // app-server / print-bridge
  late final bool _claudeBridge;
  StreamSubscription? _bridgeSub;
  int _bridgeSeq = 0;
  final Map<String, int> _itemSeq = {}; // itemId -> local seq
  int _eventAfter = 0;

  @override
  void initState() {
    super.initState();
    _bridge = widget.session.bridge;
    _claudeBridge = _bridge &&
        (widget.session.tool == 'claude' ||
            widget.session.tool == 'claudecode');
    _running = widget.session.running;
    if (widget.session.model.isNotEmpty) _model = widget.session.model;
    _seedModelFromSession();
    if (AppSettings.instance.keepAwake.value) WakelockPlus.enable();
    _scroll.addListener(() {
      _atBottom = !_scroll.hasClients ||
          _scroll.offset >= _scroll.position.maxScrollExtent - 80;
    });
    if (_bridge) {
      _loading = false;
      _bridgeWarming = true;
      _openBridgeStream();
      _refreshBridgeMeta(force: true).whenComplete(() {
        if (!mounted) return;
        // 稍留一拍，让「就绪」动画能被看见
        Future.delayed(const Duration(milliseconds: 420), () {
          if (mounted) setState(() => _bridgeWarming = false);
        });
      });
      Future.delayed(const Duration(seconds: 4), () {
        if (mounted && _bridgeWarming) {
          setState(() => _bridgeWarming = false);
        }
      });
    } else {
      _poll(first: true);
      _timer = Timer.periodic(const Duration(milliseconds: 900), (_) => _poll());
    }
  }

  /// 启动参数 `--model xxx` 作首屏兜底，避免 jsonl 未认领时顶部只显示 "codex"。
  void _seedModelFromSession() {
    final preview = widget.session.commandPreview;
    final m = RegExp(r'--model\s+(\S+)', caseSensitive: false).firstMatch(preview);
    if (m != null) {
      _model = m.group(1)!.trim();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _bridgeSub?.cancel();
    WakelockPlus.disable();
    _scroll.dispose();
    _compose.dispose();
    super.dispose();
  }

  void _openBridgeStream() {
    _bridgeSub?.cancel();
    _bridgeSub = widget.client
        .streamBridgeEvents(widget.session.tool, widget.session.id)
        .listen(
      _onBridgeEvent,
      onError: (_) {
        if (!mounted) return;
        setState(() => _reconnecting = true);
        Future.delayed(const Duration(milliseconds: 1500), () {
          if (!mounted || !_bridge) return;
          _openBridgeStream();
        });
      },
      onDone: () {
        if (!mounted || !_bridge) return;
        Future.delayed(const Duration(milliseconds: 1200), () {
          if (!mounted) return;
          _openBridgeStream();
        });
      },
      cancelOnError: true,
    );
  }

  void _onBridgeEvent(Map<String, dynamic> evt) {
    if (!mounted) return;
    final seq = (evt['seq'] as num?)?.toInt();
    if (seq != null && seq > _eventAfter) _eventAfter = seq;
    final type = (evt['type'] ?? '').toString();
    if (type == 'bridge/closed') {
      setState(() {
        _running = false;
        _awaitingReply = false;
        _sessionGone = true;
      });
      return;
    }
    if (_reconnecting) setState(() => _reconnecting = false);

    if (type == 'local/userMessage') {
      final text = (evt['text'] ?? '').toString();
      final clientId = (evt['clientId'] ?? '').toString();
      if (text.isEmpty) return;
      // 1) 已按 clientId 乐观插入 → 忽略
      if (clientId.isNotEmpty &&
          _messages.any((m) => m.itemId == 'client:$clientId')) {
        return;
      }
      // 2) 升级 pending 乐观气泡（旧逻辑 pending:* 与 client:* 对不上会双份）
      final pendingIdx = _messages.lastIndexWhere((m) =>
          m.role == 'user' &&
          m.text == text &&
          (m.itemId.startsWith('pending:') ||
              (clientId.isNotEmpty && m.itemId == 'client:$clientId')));
      if (pendingIdx >= 0) {
        if (clientId.isNotEmpty) {
          setState(() => _messages[pendingIdx].itemId = 'client:$clientId');
        }
        return;
      }
      // 3) 同文案紧挨的上一条 user（防 SSE 重放）
      if (_messages.isNotEmpty) {
        final last = _messages.last;
        if (last.role == 'user' && last.text == text) return;
      }
      final s = ++_bridgeSeq;
      setState(() {
        _messages.add(_Msg(s, 'user', 'text', text,
            itemId: clientId.isEmpty ? '' : 'client:$clientId'));
        _seen.add(s);
      });
      if (_atBottom) _scrollToBottom();
      return;
    }

    if (type == 'serverRequest') {
      _surfaceBridgeApproval(evt);
      return;
    }

    if (type != 'notification') return;
    final method = (evt['method'] ?? '').toString();
    final params = evt['params'];
    final p = params is Map ? Map<String, dynamic>.from(params) : <String, dynamic>{};

    switch (method) {
      case 'turn/started':
        setState(() {
          _awaitingReply = true;
          _awaitingSince = DateTime.now();
          _approval = null;
        });
        break;
      case 'turn/completed':
        setState(() => _awaitingReply = false);
        _refreshBridgeMeta();
        break;
      case 'item/agentMessage/delta':
        _appendAgentDelta(p);
        break;
      case 'item/reasoning/delta':
      case 'item/reasoningSummary/delta':
        _appendReasoningDelta(p);
        break;
      case 'item/started':
        _onItemStarted(p);
        break;
      case 'item/completed':
        _onItemCompleted(p);
        break;
      case 'thread/tokenUsage/updated':
        _applyTokenUsage(p);
        break;
      case 'thread/settings/updated':
        final model = (p['threadSettings'] is Map
                ? (p['threadSettings']['model'] ?? '')
                : (p['model'] ?? ''))
            .toString();
        final effort = (p['threadSettings'] is Map
                ? (p['threadSettings']['effort'] ??
                    p['threadSettings']['reasoningEffort'] ??
                    '')
                : (p['effort'] ?? ''))
            .toString();
        setState(() {
          if (model.isNotEmpty) _model = model;
          if (effort.isNotEmpty) _effort = effort;
        });
        break;
      case 'account/rateLimits/updated':
        // 用量条由 meta 刷新；事件到达时轻拉一次
        _refreshBridgeMeta();
        break;
    }
  }

  void _appendAgentDelta(Map p) {
    final itemId = (p['itemId'] ?? p['id'] ?? '').toString();
    final delta = (p['delta'] ?? p['text'] ?? '').toString();
    if (delta.isEmpty) return;
    setState(() {
      _awaitingReply = false;
      var seq = _itemSeq[itemId];
      if (seq == null) {
        seq = ++_bridgeSeq;
        _itemSeq[itemId] = seq;
        _messages.add(_Msg(seq, 'assistant', 'text', delta, itemId: itemId));
        _seen.add(seq);
      } else {
        final i = _messages.indexWhere((m) => m.seq == seq);
        if (i >= 0) _messages[i].text += delta;
      }
    });
    if (_atBottom) _scrollToBottom();
  }

  void _appendReasoningDelta(Map p) {
    final itemId = 'reasoning:${p['itemId'] ?? p['id'] ?? 'r'}';
    final delta = (p['delta'] ?? p['text'] ?? '').toString();
    if (delta.isEmpty) return;
    setState(() {
      var seq = _itemSeq[itemId];
      if (seq == null) {
        seq = ++_bridgeSeq;
        _itemSeq[itemId] = seq;
        _messages.add(_Msg(seq, 'reasoning', 'reasoning', delta, itemId: itemId));
        _seen.add(seq);
      } else {
        final i = _messages.indexWhere((m) => m.seq == seq);
        if (i >= 0) _messages[i].text += delta;
      }
    });
  }

  void _onItemStarted(Map p) {
    final item = p['item'];
    if (item is! Map) return;
    final type = (item['type'] ?? '').toString();
    final id = (item['id'] ?? p['itemId'] ?? '').toString();
    // userMessage 已由乐观插入 / local/userMessage 渲染，避免再插一条
    if (type == 'userMessage' || type == 'user') return;
    if (type == 'commandExecution' || type == 'fileChange' || type == 'mcpToolCall') {
      final label = (item['command'] ?? item['tool'] ?? type).toString();
      final seq = ++_bridgeSeq;
      if (id.isNotEmpty) _itemSeq['tool:$id'] = seq;
      setState(() {
        _messages.add(_Msg(seq, 'tool', 'tool_call', label,
            tool: type, itemId: 'tool:$id'));
        _seen.add(seq);
        _awaitingReply = false;
      });
    }
  }

  void _onItemCompleted(Map p) {
    final item = p['item'];
    if (item is! Map) return;
    final type = (item['type'] ?? '').toString();
    final id = (item['id'] ?? p['itemId'] ?? '').toString();
    if (type == 'userMessage' || type == 'user') return;
    if (type == 'agentMessage') {
      final text = (item['text'] ?? item['content'] ?? '').toString();
      if (text.isEmpty || id.isEmpty) return;
      setState(() {
        final existing = _itemSeq[id];
        if (existing != null) {
          final i = _messages.indexWhere((m) => m.seq == existing);
          if (i >= 0 && _messages[i].text.isEmpty) _messages[i].text = text;
        } else {
          final seq = ++_bridgeSeq;
          _itemSeq[id] = seq;
          _messages.add(_Msg(seq, 'assistant', 'text', text, itemId: id));
          _seen.add(seq);
        }
        _awaitingReply = false;
      });
      if (_atBottom) _scrollToBottom();
    } else if (type == 'commandExecution' || type == 'fileChange') {
      final out = (item['aggregatedOutput'] ?? item['output'] ?? item['status'] ?? '')
          .toString();
      final callSeq = _itemSeq['tool:$id'];
      final seq = ++_bridgeSeq;
      setState(() {
        _messages.add(_Msg(seq, 'tool', 'tool_output', out,
            tool: type, itemId: 'tool-out:$id'));
        _seen.add(seq);
        if (callSeq != null) {
          // 保留 callSeq 供 _renderEntries 配对
        }
      });
    }
  }

  void _applyTokenUsage(Map p) {
    int? total;
    int? win;
    void dig(dynamic v) {
      if (v is! Map) return;
      total ??= (v['total'] as num?)?.toInt();
      win ??= (v['contextWindow'] as num?)?.toInt() ??
          (v['context_window'] as num?)?.toInt();
      for (final k in ['tokenUsage', 'usage', 'last', 'total']) {
        if (v[k] is Map) dig(v[k]);
      }
    }
    dig(p);
    if (total == null && win == null) return;
    setState(() {
      if (total != null) _tokenTotal = total!;
      if (win != null) _contextWindow = win!;
    });
  }

  void _surfaceBridgeApproval(Map evt) {
    final method = (evt['method'] ?? '').toString();
    final requestId = evt['id'];
    final params = evt['params'];
    final p = params is Map ? Map<String, dynamic>.from(params) : <String, dynamic>{};
    if (!method.contains('requestApproval') &&
        method != 'item/tool/requestUserInput' &&
        !method.contains('elicitation')) {
      return;
    }
    final cmd = (p['command'] ?? p['reason'] ?? p['message'] ?? method).toString();
    final options = <Map>[
      {'label': '允许', 'decision': 'accept', 'key': ''},
      {'label': '本会话允许', 'decision': 'acceptForSession', 'key': ''},
      {'label': '拒绝', 'decision': 'decline', 'key': ''},
    ];
    setState(() {
      _approval = {
        'stage': 'approval',
        'bridge': true,
        'requestId': requestId,
        'prompt': cmd,
        'title': '需要审批',
        'options': options,
      };
      _awaitingReply = false;
    });
    if (_atBottom) _scrollToBottom();
  }

  Future<void> _refreshBridgeMeta({bool force = false}) async {
    final now = DateTime.now();
    if (!force &&
        _lastMetaPoll != null &&
        now.difference(_lastMetaPoll!).inMilliseconds < 4000) {
      return;
    }
    _lastMetaPoll = now;
    try {
      final snap = await widget.client
          .bridgeSessionGet(widget.session.tool, widget.session.id);
      if (!mounted || !snap.ok || snap.data is! Map) return;
      final d = snap.data as Map;
      final model = (d['model'] ?? '').toString();
      final effort = (d['effort'] ?? '').toString();
      final tokens = d['tokens'];
      setState(() {
        if (model.isNotEmpty) _model = model;
        if (effort.isNotEmpty) _effort = effort;
        if (tokens is Map) {
          _tokenTotal = (tokens['total'] as num?)?.toInt() ?? _tokenTotal;
          _contextWindow =
              (tokens['contextWindow'] as num?)?.toInt() ?? _contextWindow;
        }
      });
    } catch (_) {}
  }

  Future<void> _poll({bool first = false}) async {
    if (_polling && !first) return;
    _polling = true;
    try {
      await _pollInner(first: first);
    } finally {
      _polling = false;
    }
  }

  Future<void> _pollInner({bool first = false}) async {
    final res = await widget.client.timeline(widget.session.id, _cursor);
    if (!mounted) return;
    if (!res.ok || res.data == null) {
      final err = res.error ?? '';
      // 只有明确「会话不存在」才算结束；其它一律当作暂时性(断线/忙)，继续重试。
      final isGone = err.contains('会话不存在') ||
          err.contains('不存在') ||
          err.toLowerCase().contains('not found');
      if (isGone) {
        _goneStreak++;
        _failStreak = 0;
        // 连续两次确认才判定结束，避免瞬时误判把输入框/会话冲掉
        if (_goneStreak >= 2) {
          setState(() {
            _reconnecting = false;
            _sessionGone = true;
            _running = false;
            _awaitingReply = false; // 会话没了就别再转「思考中」
          });
        }
      } else {
        // 断线/超时/瞬时错误 → "重连中"，定时器继续跑自动重试，绝不隐藏输入框
        _goneStreak = 0;
        _failStreak++;
        if (_failStreak >= 2 && !_reconnecting) {
          setState(() => _reconnecting = true);
        }
      }
      if (first) setState(() => _loading = false);
      return;
    }
    // 拉取成功：清掉重连/结束等异常态
    if (_reconnecting || _failStreak > 0 || _sessionGone || _goneStreak > 0) {
      setState(() {
        _reconnecting = false;
        _failStreak = 0;
        _sessionGone = false;
        _goneStreak = 0;
      });
    }
    final d = res.data as Map;
    final running = d['running'] == true;
    final newModel = (d['model'] ?? '').toString();
    final newEffort = (d['effort'] ?? '').toString();
    final list = (d['messages'] as List?) ?? [];
    final newCursor = (d['cursor'] as num?)?.toInt() ?? _cursor;
    var added = false;
    var gotAssistant = false;
    for (final m in list) {
      if (m is! Map) continue;
      final seq = (m['seq'] as num?)?.toInt() ?? 0;
      if (_seen.contains(seq)) continue;
      _seen.add(seq);
      final role = (m['role'] ?? 'assistant').toString();
      _messages.add(_Msg(
        seq,
        role,
        (m['kind'] ?? 'text').toString(),
        (m['text'] ?? '').toString(),
        tool: (m['tool'] ?? '').toString(),
      ));
      added = true;
      if (role == 'assistant') gotAssistant = true;
    }
    setState(() {
      if (newModel.isNotEmpty) _model = newModel;
      if (newEffort.isNotEmpty) _effort = newEffort;
      _cursor = newCursor;
      _running = running;
      _loading = false;
      // 收到助手回复 → 结束"思考中"
      if (gotAssistant) _awaitingReply = false;
      if (!running) _awaitingReply = false;
      // 有新消息进来说明审批已过/无需审批
      if (added) _approval = null;
    });
    if (added && _atBottom) _scrollToBottom();
    // codex 干活期间可能弹审批：轮询检测，命中就原生弹允许/拒绝
    if (running && _approval == null) _checkApproval();
    // 补齐模型/推理/上下文：jsonl 未就绪时从 TUI / token-snapshot 兜底
    _refreshMeta(force: first || (newModel.isEmpty && _model.isEmpty));
  }

  /// 从 TUI 状态行 / token-snapshot 刷新顶部模型条。
  /// 节流约 4s；force 时立即跑（首屏或模型仍空）。
  Future<void> _refreshMeta({bool force = false}) async {
    final now = DateTime.now();
    if (!force &&
        _lastMetaPoll != null &&
        now.difference(_lastMetaPoll!).inMilliseconds < 4000) {
      return;
    }
    _lastMetaPoll = now;
    // 1) token / 上下文
    try {
      final tok = await widget.client.tokenSnapshot(widget.session.id);
      if (!mounted) return;
      if (tok.ok && tok.data is Map) {
        final t = (tok.data as Map)['tokens'];
        if (t is Map) {
          final total = (t['total'] as num?)?.toInt() ?? 0;
          final win = (t['contextWindow'] as num?)?.toInt() ?? 0;
          if (total != _tokenTotal || win != _contextWindow) {
            setState(() {
              _tokenTotal = total;
              _contextWindow = win;
            });
          }
        }
      }
    } catch (_) {}
    // 2) 模型/推理仍空 → 读终端尾部解析状态行
    if (_model.isNotEmpty && _effort.isNotEmpty) return;
    try {
      final res = await widget.client.readSession(widget.session.id, 0);
      if (!mounted || !res.ok || res.data is! Map) return;
      final raw = ((res.data as Map)['data'] ?? '').toString();
      if (raw.isEmpty) return;
      final plain = raw
          .replaceAll(RegExp(r'\x1b\[[0-9;?]*[A-Za-z]'), '')
          .replaceAll(RegExp(r'\x1b.'), '');
      final parsed = _parseModelEffort(plain);
      if (parsed == null) return;
      setState(() {
        if (_model.isEmpty && parsed.$1.isNotEmpty) _model = parsed.$1;
        if (_effort.isEmpty && parsed.$2.isNotEmpty) _effort = parsed.$2;
      });
    } catch (_) {}
  }

  /// 解析 TUI 里的 `gpt-5.6-luna high · /path` 或 `model: gpt-5.6-luna high`。
  (String, String)? _parseModelEffort(String plain) {
    final re = RegExp(
      r'(gpt-[\w.\-]+|o\d(?:-[\w.\-]+)?|codex-[\w.\-]*)\s+'
      r'(minimal|low|medium|high|xhigh|extra\s*high|max|ultra)\b',
      caseSensitive: false,
    );
    // 优先取最后一次匹配（状态条在底部）
    Match? last;
    for (final m in re.allMatches(plain)) {
      last = m;
    }
    if (last == null) return null;
    final model = last.group(1)!.trim();
    var effort = last.group(2)!.trim().toLowerCase().replaceAll(' ', '');
    if (effort == 'extrahigh') effort = 'xhigh';
    return (model, effort);
  }

  Future<void> _checkApproval() async {
    if (_checkingApproval) return;
    // 手动切换模型/推理流程独占，避免同一个 picker 既弹 bottom-sheet 又弹审批卡
    if (_manualPickerOpen) return;
    // 节流：picker 检测走 vt100 还原屏幕，较重；≥2.5s 才查一次（发送后加速窗除外）
    final now = DateTime.now();
    final fast = _fastPollUntil != null && now.isBefore(_fastPollUntil!);
    final minMs = fast ? 800 : 2500;
    if (_lastPickerCheck != null &&
        now.difference(_lastPickerCheck!).inMilliseconds < minMs) {
      return;
    }
    _lastPickerCheck = now;
    _checkingApproval = true;
    try {
      final res = await widget.client.codexPicker(widget.session.id);
      if (!mounted) return;
      // 审批 + 通用交互提示(目录信任/Press enter/任意 Yes-No) + 模型/推理级别选择器
      // 都统一弹原生卡——只要 codex 卡在等用户输入，就必须让手机端看得到、点得动，
      // 否则 App 会一直显示"思考中"（后端已识别为 reasoning/model 但 App 忽略）
      final stage = (res.ok && res.data is Map) ? res.data['stage'] : null;
      final options = (res.ok && res.data is Map)
          ? (res.data['options'] as List?) ?? const []
          : const [];
      final surface = stage == 'approval' ||
          stage == 'prompt' ||
          ((stage == 'reasoning' || stage == 'model') && options.isNotEmpty);
      if (surface) {
        setState(() {
          _approval = res.data as Map;
          _awaitingReply = false;
        });
        if (_atBottom) _scrollToBottom();
      }
    } finally {
      _checkingApproval = false;
    }
  }

  // 选项响应：
  //   - 有快捷键(y/p/esc) → 发键
  //   - reasoning/model → 发单数字(codex Select widget 数字即选中并自动确认)
  //   - approval/prompt → 发「数字 + \r」(Y/N 类提示要 \r 才提交)
  // 补 \r 是 codex TUI 里最容易翻车的地方：picker 关闭后额外的 \r 会打空回车,
  // 可能触发 /model 或提交空 prompt。走单数字路径能规避。
  Future<void> _sendPromptOption(Map option) async {
    final key = (option['key'] ?? '').toString();
    final index = option['index'];
    final stage = (_approval?['stage'] ?? '').toString();
    final bridgeApproval = _approval?['bridge'] == true;
    final requestId = _approval?['requestId'];
    final decision = (option['decision'] ?? '').toString();
    setState(() {
      _approval = null;
      _awaitingReply = true;
      _awaitingSince = DateTime.now();
    });
    if (bridgeApproval && requestId != null && decision.isNotEmpty) {
      await widget.client.bridgeApproval(
          widget.session.tool, widget.session.id, '$requestId', decision);
      return;
    }
    if (key.isNotEmpty) {
      await widget.client
          .writeSession(widget.session.id, key == 'esc' ? '\x1b' : key);
    } else if (index != null) {
      if (stage != 'reasoning' && stage != 'model') {
        await widget.client
            .writeSession(widget.session.id, '$index', submit: true);
      } else {
        await widget.client.writeSession(widget.session.id, '$index');
      }
    }
    _bumpFastPoll();
  }

  void _bumpFastPoll() {
    _fastPollUntil = DateTime.now().add(const Duration(seconds: 4));
    Future.delayed(const Duration(milliseconds: 350), () => _poll());
    Future.delayed(const Duration(milliseconds: 900), () => _poll());
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 220), curve: Curves.easeOut);
      }
    });
  }

  Future<void> _send(String data, {bool submit = false}) async {
    await widget.client.writeSession(widget.session.id, data, submit: submit);
  }

  void _submit() {
    final t = _compose.text;
    if (t.trim().isEmpty) {
      if (!_bridge) _send('\r');
      return;
    }
    final text = t;
    _compose.clear();
    setState(() {
      _awaitingReply = true;
      _awaitingSince = DateTime.now();
    });
    if (_bridge) {
      // 客户端生成 clientId：乐观气泡与 SSE local/userMessage 用同一 id 去重
      final clientId =
          'c${DateTime.now().microsecondsSinceEpoch}_${_bridgeSeq + 1}';
      final seq = ++_bridgeSeq;
      setState(() {
        _messages.add(
            _Msg(seq, 'user', 'text', text, itemId: 'client:$clientId'));
        _seen.add(seq);
      });
      _scrollToBottom();
      widget.client
          .bridgeTurnStart(widget.session.tool, widget.session.id, text,
              clientId: clientId)
          .then((res) {
        if (!mounted) return;
        if (!res.ok) {
          setState(() {
            _awaitingReply = false;
            _messages.removeWhere((m) => m.itemId == 'client:$clientId');
          });
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('发送失败: ${res.error ?? '未知'}')),
          );
        }
      });
      return;
    }
    _sendThenEnter(text);
    _scrollToBottom();
    _bumpFastPoll();
  }

  Future<void> _sendThenEnter(String text) async {
    await widget.client
        .writeSession(widget.session.id, text, submit: true);
  }

  void _openRawTerminal() {
    if (_bridge) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(_claudeBridge
              ? '当前为 Claude 快速通道，无原始 TUI 终端'
              : '当前为 app-server 会话，无原始 TUI 终端'),
          duration: const Duration(seconds: 2),
        ),
      );
      return;
    }
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => TerminalScreen(
          client: widget.client,
          session: widget.session,
          displayTitle: widget.displayTitle,
        ),
      ),
    );
  }

  Future<void> _sendImage() async {
    try {
      final picker = ImagePicker();
      final XFile? file = await picker.pickImage(
          source: ImageSource.gallery, maxWidth: 2200, imageQuality: 85);
      if (file == null || !mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('图片上传中…'), duration: Duration(seconds: 1)),
      );
      final b64 = base64Encode(await file.readAsBytes());
      final res = await widget.client.uploadImage(file.name, b64);
      if (!mounted) return;
      final path =
          (res.ok && res.data is Map) ? res.data['path']?.toString() : null;
      if (path != null && path.isNotEmpty) {
        _compose.text =
            _compose.text.isEmpty ? '$path ' : '${_compose.text} $path ';
        setState(() {});
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('上传失败: ${res.error ?? '未知'}')));
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('上传异常: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.displayTitle ??
        (widget.session.title.isEmpty
            ? (widget.session.id.length >= 8
                ? widget.session.id.substring(0, 8)
                : widget.session.id)
            : widget.session.title);
    final effort = _effort.isEmpty ? null : (_effortLabels[_effort] ?? _effort);
    final ctx = _contextLabel;
    final metaParts = <String>[
      if (_modelLabel.isNotEmpty) _modelLabel,
      if (effort != null) effort,
      if (ctx != null) ctx,
    ];
    final meta = metaParts.join(' · ');
    final channelLabel = _bridge ? '快速' : '模拟';
    final channelColor = _bridge ? kRunning : kMuted;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 8,
        title: InkWell(
          onTap: _openModelPicker,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(children: [
              // OpenAI / Claude logo；运行中右下角小绿点
              Stack(
                clipBehavior: Clip.none,
                children: [
                  toolLogo(widget.session.tool, size: 22, running: true),
                  if (_running)
                    Positioned(
                      right: -1,
                      bottom: -1,
                      child: Container(
                        width: 7,
                        height: 7,
                        decoration: BoxDecoration(
                          color: kRunning,
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.white, width: 1.5),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(children: [
                      Flexible(
                        child: Text(title,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 15.5,
                                fontWeight: FontWeight.w600,
                                height: 1.15)),
                      ),
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: channelColor.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          channelLabel,
                          style: TextStyle(
                            color: channelColor,
                            fontSize: 10.5,
                            fontWeight: FontWeight.w700,
                            height: 1.1,
                          ),
                        ),
                      ),
                    ]),
                    if (meta.isNotEmpty) ...[
                      const SizedBox(height: 1),
                      Row(children: [
                        Flexible(
                          child: Text(meta,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                  fontSize: 11.5,
                                  color: kMuted,
                                  fontWeight: FontWeight.w500,
                                  height: 1.1)),
                        ),
                        const Icon(Icons.expand_more, size: 14, color: kFaint),
                      ]),
                    ],
                  ],
                ),
              ),
            ]),
          ),
        ),
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_horiz),
            onSelected: (v) {
              switch (v) {
                case 'raw':
                  _openRawTerminal();
                  break;
                case 'bottom':
                  _scrollToBottom();
                  break;
                case 'model':
                  _openModelPicker();
                  break;
                case 'reasoning':
                  _openReasoningPicker();
                  break;
                case 'usage':
                  _openUsageFlow();
                  break;
              }
            },
            itemBuilder: (_) => [
              PopupMenuItem(
                enabled: false,
                child: Text(
                  _bridge
                      ? (_claudeBridge
                          ? '通道：快速（print-bridge）'
                          : '通道：快速（app-server）')
                      : '通道：模拟（PTY）',
                  style: TextStyle(
                    color: channelColor,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              const PopupMenuItem(value: 'model', child: Text('切换模型')),
              const PopupMenuItem(value: 'reasoning', child: Text('推理强度')),
              const PopupMenuItem(value: 'usage', child: Text('查看用量')),
              const PopupMenuItem(value: 'bottom', child: Text('滚动到底部')),
              if (!_bridge)
                const PopupMenuItem(value: 'raw', child: Text('切换到原始终端')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (_sessionGone) _endedBanner() else if (_reconnecting) _reconnectBanner(),
          Expanded(child: _body()),
          if (_approval != null) _approvalCard(),
          if (!_sessionGone && _approval == null) _composer(),
        ],
      ),
    );
  }

  // 通用交互卡：审批 / 目录信任 / 任意编号提示 / 模型-推理级别选择器。
  // approval/prompt → 横向 chip 按钮（Y/N 类简短选项）
  // reasoning/model → 竖排列表（带 detail + 当前项高亮 + Esc 取消）
  Widget _approvalCard() {
    final stage = (_approval?['stage'] ?? '').toString();
    final title = (_approval?['title'] ?? '需要你确认').toString();
    final cmd = (_approval?['command'] ?? _approval?['prompt'] ?? '').toString();
    final reason = (_approval?['reason'] ?? '').toString();
    final model = (_approval?['model'] ?? '').toString();
    final options = ((_approval?['options'] as List?) ?? []).cast<Map>();
    final isPicker = stage == 'reasoning' || stage == 'model';
    // approval/prompt 里如果任何选项 label 过长(比如"Yes, and don't ask again for commands that start with …")
    // chip 会被截断成 …，用户看不见完整文本；改走竖排 list 布局。
    final hasLongLabel = options.any((o) => (o['label']?.toString().length ?? 0) > 24);
    final useListLayout = isPicker || hasLongLabel;

    // 横向 chip 按钮（approval/prompt 用）：按 key/label 语义配色
    Widget chipBtn(Map o) {
      final key = (o['key'] ?? '').toString();
      final label = (o['label'] ?? '选项').toString();
      final lower = label.toLowerCase();
      Color color;
      if (key == 'y' || lower.contains('yes') || lower.contains('proceed') ||
          lower.contains('continue') || lower.contains('允许')) {
        color = kRunning;
      } else if (key == 'p' || lower.contains("don't ask") || lower.contains('always')) {
        color = const Color(0xFF5B8CFF);
      } else if (key == 'esc' || lower.contains('no') || lower.contains('quit') ||
          lower.contains('拒绝') || lower.contains('cancel')) {
        color = kExited;
      } else {
        color = kMuted;
      }
      return Padding(
        padding: const EdgeInsets.only(right: 8, bottom: 8),
        child: FilledButton(
          style: FilledButton.styleFrom(
              backgroundColor: color,
              padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap),
          onPressed: () => _sendPromptOption(o),
          child: Text(label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13)),
        ),
      );
    }

    // 竖排列表项：reasoning/model 用 detail 副文本; approval 长 label 走多行 label。
    // approval 里 y/p/esc 快捷键在 index badge 位置显示，让盲选也能靠色标记忆。
    Widget listRow(Map o) {
      final label = (o['label'] ?? '选项').toString();
      final detail = (o['detail'] ?? '').toString();
      final current = o['current'] == true;
      final key = (o['key'] ?? '').toString();
      // approval 用 key 做左侧标签(y 绿 / p 蓝 / esc 红), 没 key 时退回数字
      final badgeText = key.isNotEmpty ? key : '${o['index'] ?? ''}';
      final Color badgeBg, badgeFg;
      final lower = label.toLowerCase();
      if (key == 'y' || lower.contains('yes') && !lower.contains("don't")) {
        badgeBg = kRunning.withValues(alpha: 0.15); badgeFg = kRunning;
      } else if (key == 'p' || lower.contains("don't ask") || lower.contains('always')) {
        badgeBg = const Color(0x1F5B8CFF); badgeFg = const Color(0xFF3A6DFF);
      } else if (key == 'esc' || lower.contains('no') || lower.contains('cancel')) {
        badgeBg = kExited.withValues(alpha: 0.14); badgeFg = kExited;
      } else if (current) {
        badgeBg = kAccent.withValues(alpha: 0.16); badgeFg = kAccent;
      } else {
        badgeBg = const Color(0xFFE9DFCF); badgeFg = const Color(0xFF8A6E3A);
      }
      return InkWell(
        onTap: () => _sendPromptOption(o),
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                constraints: const BoxConstraints(minWidth: 30),
                height: 26,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: badgeBg,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(badgeText,
                    style: TextStyle(
                        fontSize: 11.5,
                        fontWeight: FontWeight.w700,
                        color: badgeFg)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Flexible(
                        child: Text(label,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                                color: current ? kAccent : kText,
                                height: 1.3)),
                      ),
                      if (current) ...[
                        const SizedBox(width: 6),
                        const Icon(Icons.check_circle,
                            size: 14, color: kAccent),
                      ],
                    ]),
                    if (detail.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(detail,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style:
                              const TextStyle(color: kMuted, fontSize: 12.2)),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 4),
              const Icon(Icons.chevron_right, size: 18, color: kMuted),
            ],
          ),
        ),
      );
    }

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF3E6),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(
                isPicker
                    ? (stage == 'reasoning'
                        ? Icons.psychology_outlined
                        : Icons.auto_awesome_outlined)
                    : Icons.shield_outlined,
                size: 16,
                color: const Color(0xFFD98324)),
            const SizedBox(width: 6),
            Expanded(
              child: Text(stage == 'approval' ? 'Codex 需要你确认' : title,
                  style: const TextStyle(
                      color: Color(0xFFB5651D),
                      fontSize: 13,
                      fontWeight: FontWeight.w700)),
            ),
            if (isPicker && model.isNotEmpty)
              Text(model,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      color: Color(0xFFB5651D),
                      fontSize: 11.5,
                      fontWeight: FontWeight.w500)),
            if (isPicker) ...[
              const SizedBox(width: 6),
              InkWell(
                onTap: _dismissPicker,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 6, vertical: 3),
                  child: Text('Esc',
                      style: TextStyle(
                          color: kMuted,
                          fontSize: 11.5,
                          fontWeight: FontWeight.w600)),
                ),
              ),
            ],
          ]),
          if (reason.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(reason,
                style: const TextStyle(color: kText, fontSize: 12.5, height: 1.4)),
          ],
          if (cmd.isNotEmpty) ...[
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                  color: const Color(0xFF14181F),
                  borderRadius: BorderRadius.circular(8)),
              child: SelectableText('\$ $cmd',
                  style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 12.5,
                      color: Color(0xFFC7D0DA))),
            ),
          ],
          const SizedBox(height: 10),
          if (useListLayout)
            Column(
              children: [
                for (final o in options) listRow(o),
              ],
            )
          else
            Wrap(children: options.map(chipBtn).toList()),
        ],
      ),
    );
  }

  // 「Esc」/关掉当前 picker：向 codex 发 Escape 并清掉本地卡片。
  Future<void> _dismissPicker() async {
    setState(() => _approval = null);
    await widget.client.writeSession(widget.session.id, '\x1b');
    Future.delayed(const Duration(milliseconds: 500), () => _poll());
  }

  static const _effortLabels = {
    'minimal': '最低',
    'low': '低',
    'medium': '中',
    'high': '高',
    'xhigh': '极高',
    'max': '最大',
    'ultra': 'Ultra',
  };

  String get _modelLabel {
    if (_model.isNotEmpty) return _model;
    return toolLabel(widget.session.tool);
  }

  String? get _contextLabel {
    if (_contextWindow <= 0 || _tokenTotal <= 0) return null;
    final pct = ((_tokenTotal / _contextWindow) * 100).clamp(0, 100);
    if (pct >= 10) return '${pct.round()}%';
    if (_tokenTotal >= 1000) {
      return '${(_tokenTotal / 1000).toStringAsFixed(_tokenTotal >= 10000 ? 0 : 1)}k';
    }
    return '$_tokenTotal';
  }

  Widget _endedBanner() => Container(
        width: double.infinity,
        color: kExited.withValues(alpha: 0.12),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Row(children: [
          const Icon(Icons.stop_circle_outlined, color: kExited, size: 18),
          const SizedBox(width: 8),
          const Expanded(
            child: Text('会话已结束（电脑端重启或会话退出）',
                style: TextStyle(color: kExited, fontSize: 12.5)),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop('resume'),
            child: const Text('恢复会话'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('返回'),
          ),
        ]),
      );

  Widget _reconnectBanner() => Container(
        width: double.infinity,
        color: kWarn.withValues(alpha: 0.14),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(children: [
          const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2, color: kWarn)),
          const SizedBox(width: 10),
          const Expanded(
            child: Text('连接已断开，正在自动重连…',
                style: TextStyle(color: kWarn, fontSize: 12.5)),
          ),
        ]),
      );

  Widget _body() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_messages.isEmpty && !_awaitingReply) {
      if (_bridgeWarming) {
        return const _BridgeWarmingView();
      }
      // codex 要等第一条消息才写会话文件；这里不显示"等待/卡住"，
      // 直接引导用户开始，输入框已可用（发送即写进 codex）。
      return ListView(children: [
        const SizedBox(height: 100),
        Center(child: toolLogo(widget.session.tool, size: 40, running: true)),
        const SizedBox(height: 22),
        const Center(
          child: Text('开始对话',
              style: TextStyle(
                  fontSize: 18, fontWeight: FontWeight.w600, color: kText)),
        ),
        const SizedBox(height: 10),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40),
          child: Text(
            _bridge
                ? '快速通道已就绪。在下方输入消息即可开始。'
                : '在下方输入消息。首条发出后会开始记录会话。',
            textAlign: TextAlign.center,
            style: const TextStyle(color: kMuted, fontSize: 13.5, height: 1.5),
          ),
        ),
        if (!_bridge) ...[
          const SizedBox(height: 20),
          Center(
            child: TextButton(
              onPressed: _openRawTerminal,
              style: TextButton.styleFrom(
                foregroundColor: kMuted,
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              ),
              child: const Text('查看原始终端', style: TextStyle(fontSize: 12.5)),
            ),
          ),
        ],
      ]);
    }
    // 只要还在等回复、且最后一条不是最终回答/推理流，就显示 Working shimmer
    final lastRole = _messages.isEmpty ? '' : _messages.last.role;
    final showThinking = _awaitingReply &&
        (lastRole.isEmpty ||
            (lastRole != 'assistant' && lastRole != 'reasoning'));
    int lastAssistantSeq = -1;
    for (final m in _messages) {
      if (m.role == 'assistant') lastAssistantSeq = m.seq;
    }
    final entries = _renderEntries();
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 20),
      itemCount: entries.length + (showThinking ? 1 : 0),
      itemBuilder: (_, i) {
        if (i >= entries.length) {
          return _Appear(
            key: const ValueKey('thinking'),
            child: _ThinkingBubble(
                since: _awaitingSince, onOpenRaw: _openRawTerminal),
          );
        }
        final e = entries[i];
        if (e.isTool) {
          return _Appear(
            key: ValueKey('tool_${e.toolCall!.seq}'),
            child: _ToolCard(
              call: e.toolCall!,
              output: e.toolOutput,
            ),
          );
        }
        final m = e.msg!;
        final animate = m.role == 'assistant' &&
            m.seq == lastAssistantSeq &&
            !_revealed.contains(m.seq) &&
            m.text.length < 900 &&
            !m.text.contains('```');
        return _Appear(
          key: ValueKey('msg_${m.seq}'),
          child: _bubble(m, animate: animate),
        );
      },
    );
  }

  // 把 tool_call 与紧邻的 tool_output 合并成一条渲染项。
  List<_RenderEntry> _renderEntries() {
    final out = <_RenderEntry>[];
    for (var i = 0; i < _messages.length; i++) {
      final m = _messages[i];
      if (m.role == 'tool' && m.kind == 'tool_call') {
        _Msg? result;
        if (i + 1 < _messages.length &&
            _messages[i + 1].role == 'tool' &&
            _messages[i + 1].kind == 'tool_output') {
          result = _messages[i + 1];
          i++;
        }
        out.add(_RenderEntry.tool(m, result));
      } else if (m.role == 'tool' && m.kind == 'tool_output') {
        // 落单的输出（无配对调用）也包一层
        out.add(_RenderEntry.tool(m, null));
      } else {
        out.add(_RenderEntry.message(m));
      }
    }
    return out;
  }

  Widget _bubble(_Msg m, {bool animate = false}) {
    switch (m.role) {
      case 'user':
        return _userBubble(m.text);
      case 'reasoning':
        return _reasoningBlock(m.text);
      default:
        return _assistantBlock(m.text, animate: animate, seq: m.seq);
    }
  }

  Widget _userBubble(String text) => Align(
        alignment: Alignment.centerRight,
        child: Container(
          margin: const EdgeInsets.only(top: 18, left: 56, bottom: 4),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: const Color(0xFFF0F0F2),
            borderRadius: BorderRadius.circular(18),
          ),
          child: SelectableText(text,
              style: const TextStyle(
                  color: kText, fontSize: 15, height: 1.45)),
        ),
      );

  // 纯对话样式：左对齐正文，底部轻量操作（对标 Codex App）。
  Widget _assistantBlock(String text, {bool animate = false, int seq = -1}) =>
      Container(
        width: double.infinity,
        margin: const EdgeInsets.only(top: 18, right: 4, bottom: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            animate
                ? _TypingText(
                    text,
                    key: ValueKey('typing_$seq'),
                    style: const TextStyle(
                        color: kText, fontSize: 15.5, height: 1.65),
                    onDone: () {
                      if (mounted) setState(() => _revealed.add(seq));
                    },
                  )
                : _richText(text),
            if (!animate || _revealed.contains(seq)) _msgActions(text),
          ],
        ),
      );

  Widget _msgActions(String text) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Row(
        children: [
          _ghostIconBtn(Icons.copy_rounded, '复制', () async {
            await Clipboard.setData(ClipboardData(text: text));
            if (!mounted) return;
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('已复制'),
                duration: Duration(milliseconds: 900),
              ),
            );
          }),
          _ghostIconBtn(Icons.vertical_align_bottom_rounded, '到底',
              _scrollToBottom),
        ],
      ),
    );
  }

  Widget _ghostIconBtn(IconData icon, String tip, VoidCallback onTap) {
    return Tooltip(
      message: tip,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Icon(icon, size: 16, color: kFaint),
        ),
      ),
    );
  }

  static const _mdBase = TextStyle(color: kText, fontSize: 15.5, height: 1.65);

  // 轻量 Markdown：代码块 / 标题 / 列表 / 引用 / 段落，行内支持 **粗体**、`行内码`。
  Widget _richText(String text) {
    final blocks = <Widget>[];
    final lines = text.split('\n');
    var i = 0;
    while (i < lines.length) {
      final line = lines[i];
      final lt = line.trimLeft();
      // 代码块 ```
      if (lt.startsWith('```')) {
        final lang = lt.length > 3 ? lt.substring(3).trim() : '';
        final buf = <String>[];
        i++;
        while (i < lines.length && !lines[i].trimLeft().startsWith('```')) {
          buf.add(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // 跳过结束 ```
        final code = buf.join('\n');
        blocks.add(_looksLikeCommitLog(code)
            ? _commitTimeline(code)
            : _codeBlock(code, lang: lang));
        continue;
      }
      if (line.trim().isEmpty) {
        i++;
        continue;
      }
      // 裸提交日志（无 ``` 包裹）：连续 ≥2 行 hash+date 则渲染时间线
      final commitRe =
          RegExp(r'^[a-f0-9]{7,40}\s+\d{4}-\d{2}-\d{2}\b');
      if (commitRe.hasMatch(lt)) {
        final buf = <String>[line];
        var j = i + 1;
        while (j < lines.length) {
          final t = lines[j].trim();
          if (t.isEmpty) {
            j++;
            continue;
          }
          if (!commitRe.hasMatch(t)) break;
          buf.add(lines[j]);
          j++;
        }
        if (buf.length >= 2) {
          blocks.add(_commitTimeline(buf.join('\n')));
          i = j;
          continue;
        }
      }
      // 标题 # / ## / ###
      final h = RegExp(r'^(#{1,3})\s+(.*)$').firstMatch(lt);
      if (h != null) {
        final level = h.group(1)!.length;
        final size = level == 1 ? 18.5 : (level == 2 ? 17.0 : 16.0);
        blocks.add(Padding(
          padding: const EdgeInsets.only(top: 14, bottom: 4),
          child: SelectableText.rich(_inline(h.group(2)!,
              _mdBase.copyWith(fontSize: size, fontWeight: FontWeight.w700))),
        ));
        i++;
        continue;
      }
      // 无序列表 - / * / •
      final b = RegExp(r'^\s*[-*•]\s+(.*)$').firstMatch(line);
      if (b != null) {
        blocks.add(_mdListRow('•', b.group(1)!));
        i++;
        continue;
      }
      // 有序列表 1.
      final n = RegExp(r'^\s*(\d+)\.\s+(.*)$').firstMatch(line);
      if (n != null) {
        blocks.add(_mdListRow('${n.group(1)}.', n.group(2)!));
        i++;
        continue;
      }
      // 引用 >
      if (lt.startsWith('> ')) {
        blocks.add(Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.fromLTRB(12, 6, 8, 6),
          decoration: BoxDecoration(
            color: kSurface.withValues(alpha: 0.8),
            borderRadius: BorderRadius.circular(8),
            border: const Border(left: BorderSide(color: kAccent, width: 3)),
          ),
          child: SelectableText.rich(
              _inline(lt.substring(2), _mdBase.copyWith(color: kMuted))),
        ));
        i++;
        continue;
      }
      // 普通段落
      blocks.add(Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: SelectableText.rich(_inline(line, _mdBase)),
      ));
      i++;
    }
    return Column(
        crossAxisAlignment: CrossAxisAlignment.start, children: blocks);
  }

  bool _looksLikeCommitLog(String code) {
    final lines =
        code.split('\n').map((e) => e.trim()).where((e) => e.isNotEmpty);
    var hits = 0;
    final re = RegExp(r'^[a-f0-9]{7,40}\s+\d{4}-\d{2}-\d{2}\b');
    for (final l in lines) {
      if (re.hasMatch(l)) hits++;
      if (hits >= 2) return true;
    }
    return false;
  }

  Widget _commitTimeline(String code) {
    final rows = <({String hash, String date, String msg})>[];
    final re = RegExp(r'^([a-f0-9]{7,40})\s+(\d{4}-\d{2}-\d{2})\s+(.*)$');
    for (final raw in code.split('\n')) {
      final line = raw.trimRight();
      if (line.trim().isEmpty) continue;
      final m = re.firstMatch(line.trim());
      if (m != null) {
        rows.add((hash: m.group(1)!, date: m.group(2)!, msg: m.group(3)!.trim()));
      } else {
        rows.add((hash: '', date: '', msg: line.trim()));
      }
    }
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 10),
      padding: const EdgeInsets.fromLTRB(4, 4, 10, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(bottom: 10, left: 2),
            child: Row(children: [
              Icon(Icons.commit, size: 14, color: kFaint),
              SizedBox(width: 6),
              Text('Commits',
                  style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w500,
                      color: kFaint)),
            ]),
          ),
          for (var i = 0; i < rows.length; i++)
            _commitRow(rows[i], isLast: i == rows.length - 1),
        ],
      ),
    );
  }

  Widget _commitRow(({String hash, String date, String msg}) row,
      {required bool isLast}) {
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 16,
            child: Column(
              children: [
                Container(
                  width: 7,
                  height: 7,
                  margin: const EdgeInsets.only(top: 6),
                  decoration: const BoxDecoration(
                      color: Color(0xFFC4C4CC), shape: BoxShape.circle),
                ),
                if (!isLast)
                  Expanded(
                    child: Container(
                      width: 1.5,
                      margin: const EdgeInsets.symmetric(vertical: 2),
                      color: const Color(0xFFE6E6EA),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: isLast ? 2 : 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (row.hash.isNotEmpty)
                    Row(children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 6, vertical: 1),
                        decoration: BoxDecoration(
                          color: const Color(0xFFEEEEF0),
                          borderRadius: BorderRadius.circular(5),
                        ),
                        child: Text(
                            row.hash.length > 7
                                ? row.hash.substring(0, 7)
                                : row.hash,
                            style: const TextStyle(
                                fontFamily: 'monospace',
                                fontSize: 11.5,
                                color: kText,
                                fontWeight: FontWeight.w600)),
                      ),
                      if (row.date.isNotEmpty) ...[
                        const SizedBox(width: 8),
                        Text(row.date,
                            style: const TextStyle(
                                fontSize: 11.5, color: kFaint)),
                      ],
                    ]),
                  const SizedBox(height: 3),
                  SelectableText(
                    row.msg,
                    style: const TextStyle(
                        fontSize: 14, color: kText, height: 1.4),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _codeBlock(String code, {String lang = ''}) {
    final label = lang.isEmpty ? 'code' : lang;
    final shell = RegExp(r'^(bash|sh|zsh|shell|console|terminal)$',
            caseSensitive: false)
        .hasMatch(label);
    // Codex App：正文旁代码偏浅底；终端输出才用深色块
    if (!shell) {
      return Container(
        width: double.infinity,
        margin: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xFFF6F6F8),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: const Color(0xFFE8E8EC)),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (label != 'code')
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                child: Text(label,
                    style: const TextStyle(
                        fontSize: 11.5,
                        color: kFaint,
                        fontWeight: FontWeight.w600)),
              ),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
              child: SelectableText(
                code.trimRight(),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12.8,
                  color: kText,
                  height: 1.55,
                ),
              ),
            ),
          ],
        ),
      );
    }
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF161A21),
        borderRadius: BorderRadius.circular(12),
      ),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        child: SelectableText(
          code.trimRight(),
          style: const TextStyle(
            fontFamily: 'monospace',
            fontSize: 12.8,
            color: Color(0xFFD5DEE8),
            height: 1.55,
          ),
        ),
      ),
    );
  }

  Widget _mdListRow(String marker, String content) => Padding(
        padding: const EdgeInsets.only(top: 3, bottom: 3, left: 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 22,
              child: Text(marker,
                  style: _mdBase.copyWith(
                      color: kMuted, fontWeight: FontWeight.w600)),
            ),
            Expanded(child: SelectableText.rich(_inline(content, _mdBase))),
          ],
        ),
      );

  // 行内解析：**粗体** 与 `行内码`（Codex 风格浅灰 pill）。
  TextSpan _inline(String text, TextStyle base) {
    final spans = <InlineSpan>[];
    final re = RegExp(r'\*\*(.+?)\*\*|`([^`]+)`');
    var last = 0;
    for (final m in re.allMatches(text)) {
      if (m.start > last) {
        spans.add(TextSpan(text: text.substring(last, m.start)));
      }
      if (m.group(1) != null) {
        spans.add(TextSpan(
            text: m.group(1),
            style: const TextStyle(fontWeight: FontWeight.w600)));
      } else if (m.group(2) != null) {
        spans.add(WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 1, vertical: 1),
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: const Color(0xFFEEEEF0),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              m.group(2)!,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 13.2,
                color: kText,
                height: 1.25,
              ),
            ),
          ),
        ));
      }
      last = m.end;
    }
    if (last < text.length) spans.add(TextSpan(text: text.substring(last)));
    return TextSpan(style: base, children: spans);
  }

  Widget _reasoningBlock(String text) => Container(
        margin: const EdgeInsets.only(top: 14),
        child: Theme(
          data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
          child: ExpansionTile(
            initiallyExpanded: false,
            tilePadding: EdgeInsets.zero,
            childrenPadding: const EdgeInsets.only(bottom: 6, left: 2),
            leading: const Icon(Icons.auto_awesome_outlined,
                size: 16, color: kFaint),
            title: Row(
              children: [
                Text(_awaitingReply ? 'Thinking' : 'Thought',
                    style: const TextStyle(
                        color: kFaint,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w500)),
                if (_awaitingReply) ...[
                  const SizedBox(width: 10),
                  const Expanded(child: _ShimmerBar(height: 2.5)),
                ],
              ],
            ),
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: SelectableText(text,
                    style: const TextStyle(
                        color: kMuted, fontSize: 13.2, height: 1.55)),
              ),
            ],
          ),
        ),
      );

  Widget _composer() => ChatComposer(
        controller: _compose,
        onSend: _submit,
        onAttach: _openAttach,
        hint: '做点什么…',
      );

  // 「+」菜单：全部走可视化操作，不再堆原始按键。终端交给单独的「进入终端」全屏入口。
  void _openAttach() {
    Widget item(IconData icon, String title, String? sub, VoidCallback onTap,
            {Color? color}) =>
        ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 20),
          leading: Icon(icon, color: color ?? kText),
          title: Text(title,
              style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                  color: color ?? kText)),
          subtitle: sub == null
              ? null
              : Text(sub, style: const TextStyle(color: kMuted, fontSize: 12)),
          onTap: () {
            Navigator.pop(context);
            onTap();
          },
        );
    showModalBottomSheet(
      context: context,
      backgroundColor: kBg,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              margin: const EdgeInsets.only(top: 8, bottom: 4),
              width: 38,
              height: 4,
              decoration: BoxDecoration(
                  color: kLine, borderRadius: BorderRadius.circular(2)),
            ),
            item(Icons.image_outlined, '发送图片', '从相册选择并插入到消息', _sendImage),
            item(Icons.auto_awesome_outlined, '切换模型', '原生选择模型 + 推理级别',
                _openModelPicker),
            item(Icons.psychology_outlined, '推理强度', '保持模型，只改推理级别',
                _openReasoningPicker),
            item(Icons.data_usage_outlined, '查看用量', 'Codex /usage：用量与限额重置',
                _openUsageFlow),
            const Divider(height: 12, indent: 20, endIndent: 20),
            item(Icons.terminal, '进入终端（全屏）', '需要手动审批/查看原始输出时使用',
                _openRawTerminal),
          ],
        ),
      ),
    );
  }

  /// Codex `/usage`：打开用量菜单（Show usage / Redeem reset），原生列表点选。
  Future<void> _openUsageFlow() async {
    _manualPickerOpen = true;
    try {
      await _openUsageFlowInner();
    } finally {
      _manualPickerOpen = false;
      if (mounted && _approval != null) setState(() => _approval = null);
    }
  }

  Future<void> _openUsageFlowInner() async {
    if (_bridge) {
      await _bridgeShowUsage();
      return;
    }
    await widget.client.resizeSession(widget.session.id, 140, 48);
    await Future.delayed(const Duration(milliseconds: 200));
    // 清掉 composer 残留（否则 /usage 会拼到上一句后面）
    await widget.client.writeSession(widget.session.id, '\x1b');
    await Future.delayed(const Duration(milliseconds: 120));
    await widget.client.writeSession(widget.session.id, '\x15'); // Ctrl-U
    await Future.delayed(const Duration(milliseconds: 120));
    await widget.client.writeSession(widget.session.id, '/usage\r');

    // 日历页 → 多次 Enter 进入 Usage 菜单（日历本身不是 numbered picker）
    Map? menu;
    for (var i = 0; i < 30; i++) {
      await Future.delayed(const Duration(milliseconds: 350));
      final res = await widget.client.codexPicker(widget.session.id);
      if (!mounted) return;
      if (res.ok && res.data is Map) {
        final d = res.data as Map;
        final stage = (d['stage'] ?? '').toString();
        final opts = (d['options'] as List?) ?? [];
        if ((stage == 'prompt' || stage == 'approval') && opts.isNotEmpty) {
          final labels =
              opts.map((o) => (o is Map ? o['label'] : '').toString()).join(' ');
          if (labels.toLowerCase().contains('usage') ||
              labels.toLowerCase().contains('reset') ||
              labels.toLowerCase().contains('show') ||
              labels.toLowerCase().contains('redeem')) {
            menu = d;
            break;
          }
        }
      }
      // 日历页 / 过渡页：持续回车直到菜单出现
      if (i % 2 == 1) {
        await widget.client.writeSession(widget.session.id, '\r');
      }
    }
    if (menu == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('未能打开用量菜单，可进原始终端输入 /usage')),
      );
      return;
    }

    final options = (menu['options'] as List).cast<Map>();
    final idx = await _showPickerSheet(
      'Codex 用量',
      options,
      (menu['title'] ?? '').toString(),
    );
    if (idx == null) {
      await widget.client.writeSession(widget.session.id, '\x1b');
      return;
    }
    // usage 菜单是「数字选中 + Enter 确认」
    await widget.client.writeSession(widget.session.id, '$idx');
    await Future.delayed(const Duration(milliseconds: 250));
    await widget.client.writeSession(widget.session.id, '\r');

    final pickedLabel = options
        .where((o) => '${o['index']}' == '$idx' || o['index'] == idx)
        .map((o) => (o['label'] ?? '').toString().toLowerCase())
        .join(' ');
    final isShowUsage = pickedLabel.contains('show');

    // 后续可能还有二级菜单（Try again / Full reset / Close）——继续原生点选一轮
    for (var round = 0; round < 3; round++) {
      Map? next;
      for (var i = 0; i < 16; i++) {
        await Future.delayed(const Duration(milliseconds: 450));
        final res = await widget.client.codexPicker(widget.session.id);
        if (!mounted) return;
        if (res.ok && res.data is Map) {
          final d = res.data as Map;
          final stage = (d['stage'] ?? '').toString();
          final opts = (d['options'] as List?) ?? [];
          if ((stage == 'prompt' || stage == 'approval') && opts.isNotEmpty) {
            next = d;
            break;
          }
          if (stage == 'none' && i > 4) break;
        }
      }
      if (next == null) break;
      final opts = (next['options'] as List).cast<Map>();
      final pick = await _showPickerSheet(
        (next['title'] ?? '用量').toString(),
        opts,
        '',
      );
      if (pick == null) {
        await widget.client.writeSession(widget.session.id, '\x1b');
        break;
      }
      await widget.client.writeSession(widget.session.id, '$pick');
      await Future.delayed(const Duration(milliseconds: 250));
      await widget.client.writeSession(widget.session.id, '\r');
    }

    // Show usage 后：切换 daily / weekly / cumulative（Codex 用左右方向键）
    if (isShowUsage && mounted) {
      await Future.delayed(const Duration(milliseconds: 600));
      if (!mounted) return;
      final period = await showModalBottomSheet<String>(
        context: context,
        showDragHandle: true,
        builder: (ctx) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const ListTile(
                title: Text('切换用量视图'),
                subtitle: Text('对应终端里 daily · weekly · cumulative'),
              ),
              ListTile(
                leading: const Icon(Icons.calendar_view_day_outlined),
                title: const Text('Daily（日）'),
                onTap: () => Navigator.pop(ctx, 'daily'),
              ),
              ListTile(
                leading: const Icon(Icons.calendar_view_week_outlined),
                title: const Text('Weekly（周）'),
                onTap: () => Navigator.pop(ctx, 'weekly'),
              ),
              ListTile(
                leading: const Icon(Icons.stacked_line_chart),
                title: const Text('Cumulative（累计）'),
                onTap: () => Navigator.pop(ctx, 'cumulative'),
              ),
              ListTile(
                leading: const Icon(Icons.close),
                title: const Text('保持当前 / 关闭图表'),
                onTap: () => Navigator.pop(ctx, 'close'),
              ),
            ],
          ),
        ),
      );
      if (!mounted) return;
      if (period == 'close') {
        await widget.client.writeSession(widget.session.id, '\x1b');
      } else if (period == 'daily' || period == 'weekly' || period == 'cumulative') {
        // Codex usage 视图：左右键在 daily/weekly/cumulative 间切换
        // 先尽量回到 daily（多按几次左），再按目标步进
        for (var i = 0; i < 3; i++) {
          await widget.client.writeSession(widget.session.id, '\x1b[D');
          await Future.delayed(const Duration(milliseconds: 120));
        }
        final steps = period == 'daily' ? 0 : (period == 'weekly' ? 1 : 2);
        for (var i = 0; i < steps; i++) {
          await widget.client.writeSession(widget.session.id, '\x1b[C');
          await Future.delayed(const Duration(milliseconds: 150));
        }
      }
    }

    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('用量操作已发送'), duration: Duration(seconds: 2)),
      );
    }
  }


  Future<void> _bridgeShowUsage() async {
    if (_claudeBridge) {
      // Claude print-bridge 无 account/rateLimits；展示会话累计 token
      await CodexUsageSheet.show(
        context,
        raw: {
          'note': 'Claude 快速通道：本会话累计 token（非官方配额面板）',
          'sessionTokens': _tokenTotal,
        },
        sessionTokens: _tokenTotal > 0 ? _tokenTotal : null,
        contextWindow: _contextWindow > 0 ? _contextWindow : null,
      );
      _refreshBridgeMeta(force: true);
      return;
    }
    final res = await _withLoading(
        '读取用量…', () => widget.client.codexRateLimits(widget.session.id));
    if (!mounted) return;
    if (!res.ok || res.data == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('读取用量失败: ${res.error ?? '未知'}')),
      );
      return;
    }
    await CodexUsageSheet.show(
      context,
      raw: res.data,
      sessionTokens: _tokenTotal > 0 ? _tokenTotal : null,
      contextWindow: _contextWindow > 0 ? _contextWindow : null,
    );
    _refreshBridgeMeta(force: true);
  }

  Future<void> _bridgeSwitchModel({required bool reasoningOnly}) async {
    if (_claudeBridge) {
      await _claudeBridgeSwitchModel(reasoningOnly: reasoningOnly);
      return;
    }
    final res = await _withLoading(
        '读取模型列表…', () => widget.client.codexModels(widget.session.id));
    if (!mounted) return;
    if (!res.ok || res.data is! Map) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('读取模型失败: ${res.error ?? '未知'}')),
      );
      return;
    }
    final data = res.data as Map;
    final models = (data['data'] as List?) ?? (data['models'] as List?) ?? [];
    if (models.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('模型列表为空')),
      );
      return;
    }
    String? pickedModel = _model.isNotEmpty ? _model : null;
    List efforts = const [];
    if (!reasoningOnly) {
      final options = <Map>[];
      for (var i = 0; i < models.length; i++) {
        final m = models[i];
        if (m is! Map) continue;
        final id = (m['id'] ?? m['slug'] ?? m['model'] ?? '').toString();
        if (id.isEmpty) continue;
        options.add({
          'index': i + 1,
          'label': id,
          'detail': (m['displayName'] ?? m['name'] ?? '').toString(),
          'current': id == _model,
          'id': id,
          'raw': m,
        });
      }
      final idx = await _showPickerSheet('选择模型', options, _model);
      if (idx == null || !mounted) return;
      final sel = options.firstWhere((o) => o['index'] == idx, orElse: () => {});
      pickedModel = (sel['id'] ?? '').toString();
      final raw = sel['raw'];
      if (raw is Map) {
        efforts = (raw['supportedReasoningEfforts'] as List?) ??
            (raw['reasoningEfforts'] as List?) ??
            const [];
      }
    } else {
      for (final m in models) {
        if (m is! Map) continue;
        final id = (m['id'] ?? m['slug'] ?? m['model'] ?? '').toString();
        if (id == _model || pickedModel == null) {
          pickedModel = id;
          efforts = (m['supportedReasoningEfforts'] as List?) ??
              (m['reasoningEfforts'] as List?) ??
              const [];
          if (id == _model) break;
        }
      }
    }
    String? pickedEffort;
    if (efforts.isNotEmpty) {
      final rOpts = <Map>[];
      for (var i = 0; i < efforts.length; i++) {
        final e = efforts[i];
        String value;
        String detail = '';
        if (e is Map) {
          value =
              (e['reasoningEffort'] ?? e['effort'] ?? e['id'] ?? '').toString();
          detail = (e['description'] ?? e['label'] ?? '').toString();
        } else {
          value = '$e';
        }
        if (value.isEmpty) continue;
        rOpts.add({
          'index': rOpts.length + 1,
          'label': value,
          'detail': detail,
          'current': value == _effort,
          'id': value,
        });
      }
      if (rOpts.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('当前模型没有可切换的推理级别')),
        );
        return;
      }
      final rIdx =
          await _showPickerSheet('选择推理级别', rOpts, pickedModel ?? _model);
      if (rIdx == null || !mounted) return;
      pickedEffort = rOpts
          .firstWhere((o) => o['index'] == rIdx, orElse: () => {})['id']
          ?.toString();
    }
    final nextModel =
        (pickedModel != null && pickedModel.isNotEmpty) ? pickedModel : _model;
    final nextEffort =
        (pickedEffort != null && pickedEffort.isNotEmpty) ? pickedEffort : _effort;
    setState(() {
      _model = nextModel;
      _effort = nextEffort;
    });
    final set = await _withLoading(
      '应用设置…',
      () => widget.client.codexThreadSettings(
            widget.session.id,
            model: pickedModel,
            reasoningEffort: pickedEffort,
          ),
    );
    if (!mounted) return;
    if (set.ok) {
      await _refreshBridgeMeta(force: true);
      if (!mounted) return;
      final shown = [
        if (_model.isNotEmpty) _model,
        if (_effort.isNotEmpty) (_effortLabels[_effort] ?? _effort),
      ].join(' · ');
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(shown.isEmpty ? '已切换' : '已切换为 $shown'),
          duration: const Duration(seconds: 2),
        ),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('切换失败: ${set.error ?? '未知'}')),
      );
      await _refreshBridgeMeta(force: true);
    }
  }

  Future<void> _claudeBridgeSwitchModel({required bool reasoningOnly}) async {
    if (reasoningOnly) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Claude 快速通道暂不支持改推理强度')),
      );
      return;
    }
    const models = [
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'opus',
      'sonnet',
      'haiku',
    ];
    final options = <Map>[];
    for (var i = 0; i < models.length; i++) {
      final id = models[i];
      options.add({
        'index': i + 1,
        'label': id,
        'detail': '',
        'current': id == _model,
        'id': id,
      });
    }
    final idx = await _showPickerSheet('选择模型', options, _model);
    if (idx == null || !mounted) return;
    final sel = options.firstWhere((o) => o['index'] == idx, orElse: () => {});
    final pickedModel = (sel['id'] ?? '').toString();
    if (pickedModel.isEmpty) return;
    setState(() => _model = pickedModel);
    final set = await _withLoading(
      '应用设置…',
      () => widget.client.claudeThreadSettings(widget.session.id, model: pickedModel),
    );
    if (!mounted) return;
    if (set.ok) {
      await _refreshBridgeMeta(force: true);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('已切换为 $pickedModel'),
          duration: const Duration(seconds: 2),
        ),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('切换失败: ${set.error ?? '未知'}')),
      );
    }
  }

  // ── codex 模型/推理 原生切换 ──────────────────────────────
  // bridge：thread/settings/update（快）。PTY：/model + vt100（慢，已压缩等待）。

  void _openModelPicker() => _switchModelFlow(reasoningOnly: false);
  void _openReasoningPicker() => _switchModelFlow(reasoningOnly: true);

  Future<void> _switchModelFlow({required bool reasoningOnly}) async {
    _manualPickerOpen = true;
    try {
      await _switchModelFlowInner(reasoningOnly: reasoningOnly);
    } finally {
      _manualPickerOpen = false;
      if (mounted && _approval != null) setState(() => _approval = null);
    }
  }

  Future<void> _switchModelFlowInner({required bool reasoningOnly}) async {
    if (_bridge) {
      await _bridgeSwitchModel(reasoningOnly: reasoningOnly);
      return;
    }
    await _withLoading('准备终端…', () async {
      await widget.client.resizeSession(widget.session.id, 140, 48);
      await _send('\x1b');
      await Future.delayed(const Duration(milliseconds: 60));
      await _send('\x15');
      await Future.delayed(const Duration(milliseconds: 60));
    });
    if (!mounted) return;

    final modelPicker =
        await _withLoading('打开模型列表…', () => _openModelPickerPoll());
    if (!mounted) return;
    if (modelPicker == null) {
      _pickerFallback();
      return;
    }
    final options = (modelPicker['options'] as List).cast<Map>();
    int? modelIdx;
    String selectedModelLabel = '';
    if (reasoningOnly) {
      final cur = options.firstWhere((o) => o['current'] == true,
          orElse: () => options.isNotEmpty ? options.first : {});
      modelIdx = (cur['index'] as num?)?.toInt();
      selectedModelLabel = (cur['label'] ?? '').toString();
    } else {
      modelIdx = await _showPickerSheet(
          '选择模型', options, (modelPicker['model'] ?? '').toString());
      if (modelIdx == null) {
        await _send('\x1b');
        return;
      }
      final sel = options.firstWhere((o) => o['index'] == modelIdx,
          orElse: () => {});
      selectedModelLabel = (sel['label'] ?? '').toString();
    }
    if (modelIdx == null) {
      await _send('\x1b');
      return;
    }
    await _send('$modelIdx');
    if (!mounted) return;

    final rPicker =
        await _withLoading('读取推理级别…', () => _pollPicker('reasoning'));
    if (!mounted) return;
    if (rPicker == null) {
      _pickerFallback();
      return;
    }
    final rOptions = (rPicker['options'] as List).cast<Map>();
    final rIdx =
        await _showPickerSheet('选择推理级别', rOptions, selectedModelLabel);
    if (rIdx == null) {
      await _send('\x1b');
      return;
    }
    final rSel =
        rOptions.firstWhere((o) => o['index'] == rIdx, orElse: () => {});
    final effortLabel = (rSel['label'] ?? '').toString();
    await _send('$rIdx');
    if (!mounted) return;

    setState(() {
      if (selectedModelLabel.isNotEmpty) {
        final parts = selectedModelLabel.split(RegExp(r'\s+'));
        if (parts.isNotEmpty) _model = parts.first;
      }
      if (effortLabel.isNotEmpty) {
        final low = effortLabel.toLowerCase();
        var matched = false;
        for (final k in _effortLabels.keys) {
          if (low == k || low.contains(k)) {
            _effort = k;
            matched = true;
            break;
          }
        }
        if (!matched) _effort = effortLabel;
      }
    });
    final shown = [
      if (_model.isNotEmpty) _model,
      if (_effort.isNotEmpty) (_effortLabels[_effort] ?? _effort),
    ].join(' · ');
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(shown.isEmpty ? '已切换' : '已切换为 $shown'),
        duration: const Duration(seconds: 2),
      ),
    );
    _bumpFastPoll();
    Future.delayed(const Duration(milliseconds: 400), () {
      if (mounted) _poll();
    });
  }

  /// 打开模型选择器：先发一次 /model，短间隔轮询；中途最多再试一次。
  Future<Map?> _openModelPickerPoll() async {
    await _send('/model', submit: true);
    for (var i = 0; i < 12; i++) {
      await Future.delayed(Duration(milliseconds: i == 0 ? 280 : 220));
      if (!mounted) return null;
      final res = await widget.client.codexPicker(widget.session.id);
      if (!mounted) return null;
      if (res.ok && res.data is Map) {
        final d = res.data as Map;
        if (d['stage'] == 'model' &&
            (d['options'] as List?)?.isNotEmpty == true) {
          return d;
        }
      }
      if (i == 5) {
        await _send('\x1b');
        await Future.delayed(const Duration(milliseconds: 80));
        await _send('/model', submit: true);
      }
    }
    return null;
  }

  /// 轮询等待某阶段选择器。
  Future<Map?> _pollPicker(String wantStage) async {
    for (var i = 0; i < 12; i++) {
      await Future.delayed(Duration(milliseconds: i == 0 ? 200 : 180));
      if (!mounted) return null;
      final res = await widget.client.codexPicker(widget.session.id);
      if (!mounted) return null;
      if (res.ok && res.data is Map) {
        final d = res.data as Map;
        if (d['stage'] == wantStage &&
            (d['options'] as List?)?.isNotEmpty == true) {
          return d;
        }
      }
    }
    return null;
  }

  /// 带 loading 遮罩执行一个异步任务。
  Future<T> _withLoading<T>(String label, Future<T> Function() task) async {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 18),
          decoration: BoxDecoration(
              color: kSurface, borderRadius: BorderRadius.circular(14)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2.2)),
            const SizedBox(width: 14),
            Text(label, style: const TextStyle(color: kText, fontSize: 14)),
          ]),
        ),
      ),
    );
    try {
      return await task();
    } finally {
      if (mounted) Navigator.of(context, rootNavigator: true).pop();
    }
  }

  /// 原生选择器底部弹窗：返回选中项的 index(codex 编号)，取消返回 null。
  Future<int?> _showPickerSheet(String title, List<Map> options, String model) {
    return showModalBottomSheet<int>(
      context: context,
      backgroundColor: kBg,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
              child: Row(children: [
                Text(title,
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w700)),
                if (model.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  Text(model,
                      style: const TextStyle(color: kMuted, fontSize: 12.5)),
                ],
              ]),
            ),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 8),
                itemCount: options.length,
                itemBuilder: (_, i) {
                  final o = options[i];
                  final current = o['current'] == true;
                  final label = (o['label'] ?? '').toString();
                  final detail = (o['detail'] ?? '').toString();
                  return ListTile(
                    onTap: () =>
                        Navigator.pop(context, (o['index'] as num).toInt()),
                    title: Row(children: [
                      Flexible(
                        child: Text(label,
                            style: TextStyle(
                                fontSize: 15,
                                fontWeight: current
                                    ? FontWeight.w700
                                    : FontWeight.w500,
                                color: current ? kAccent : kText)),
                      ),
                      if (current) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 7, vertical: 2),
                          decoration: BoxDecoration(
                              color: kAccent.withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(999)),
                          child: const Text('当前',
                              style: TextStyle(
                                  color: kAccent,
                                  fontSize: 10.5,
                                  fontWeight: FontWeight.w600)),
                        ),
                      ],
                    ]),
                    subtitle: detail.isEmpty
                        ? null
                        : Text(detail,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                color: kMuted, fontSize: 12, height: 1.35)),
                    trailing: current
                        ? const Icon(Icons.check, size: 18, color: kAccent)
                        : null,
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 选择器解析失败(codex 版本差异/未就绪)时，退回原始终端手动操作。
  void _pickerFallback() {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
          content: Text('选择器未就绪，已切到原始终端，可手动用方向键选择'),
          duration: Duration(seconds: 3)),
    );
    _openRawTerminal();
  }
}

/// 快速通道刚进入时的就绪动画（避免空屏干等）。
class _BridgeWarmingView extends StatefulWidget {
  const _BridgeWarmingView();
  @override
  State<_BridgeWarmingView> createState() => _BridgeWarmingViewState();
}

class _BridgeWarmingViewState extends State<_BridgeWarmingView>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat(reverse: true);
  int _i = 0;
  Timer? _t;
  static const _tips = [
    '连接事件流…',
    '同步模型与用量…',
    '快速通道即将就绪…',
  ];

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(milliseconds: 800), (_) {
      if (!mounted) return;
      setState(() => _i = (_i + 1) % _tips.length);
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 40),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ScaleTransition(
              scale: Tween(begin: 0.94, end: 1.0).animate(
                CurvedAnimation(parent: _c, curve: Curves.easeInOut),
              ),
              child: Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: kRunning.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.bolt_rounded, color: kRunning, size: 28),
              ),
            ),
            const SizedBox(height: 18),
            const Text(
              '快速通道',
              style: TextStyle(
                  fontSize: 17, fontWeight: FontWeight.w700, color: kText),
            ),
            const SizedBox(height: 10),
            SizedBox(
              width: 180,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: const LinearProgressIndicator(
                  minHeight: 4,
                  backgroundColor: Color(0xFFECECEE),
                  color: kRunning,
                ),
              ),
            ),
            const SizedBox(height: 14),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              child: Text(
                _tips[_i],
                key: ValueKey(_i),
                textAlign: TextAlign.center,
                style: const TextStyle(color: kMuted, fontSize: 13.5),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// "Codex 思考中" 动效气泡（带已用秒数 + shimmer，对齐 Codex Working 状态感）
class _ThinkingBubble extends StatefulWidget {
  final DateTime? since;
  final VoidCallback? onOpenRaw;
  const _ThinkingBubble({super.key, this.since, this.onOpenRaw});
  @override
  State<_ThinkingBubble> createState() => _ThinkingBubbleState();
}

class _ThinkingBubbleState extends State<_ThinkingBubble> {
  Timer? _t;
  int _secs = 0;

  @override
  void initState() {
    super.initState();
    _tick();
    _t = Timer.periodic(const Duration(seconds: 1), (_) => _tick());
  }

  void _tick() {
    if (!mounted) return;
    final since = widget.since;
    setState(() {
      _secs = since == null ? 0 : DateTime.now().difference(since).inSeconds;
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final slow = _secs >= 20;
    final worked = _secs <= 0
        ? 'Working…'
        : (_secs < 60
            ? 'Worked for ${_secs}s'
            : 'Worked for ${_secs ~/ 60}m ${(_secs % 60).toString().padLeft(2, '0')}s');
    // Codex App：细灰时钟 + Worked for，不做成厚卡片
    return Padding(
      padding: const EdgeInsets.only(top: 16, bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.schedule_rounded, size: 15, color: kFaint),
              const SizedBox(width: 7),
              Text(
                worked,
                style: const TextStyle(
                  color: kMuted,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
              const SizedBox(width: 8),
              const _TypingDots(),
            ],
          ),
          const SizedBox(height: 12),
          const _ShimmerBar(height: 7, widthFactor: 0.72),
          const SizedBox(height: 7),
          const _ShimmerBar(height: 7, widthFactor: 0.48),
          if (slow && widget.onOpenRaw != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: TextButton(
                onPressed: widget.onOpenRaw,
                style: TextButton.styleFrom(
                  foregroundColor: kMuted,
                  padding: EdgeInsets.zero,
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: const Text('耗时较长 · 查看原始终端',
                    style: TextStyle(fontSize: 12.5)),
              ),
            ),
        ],
      ),
    );
  }
}

/// 横向 shimmer 条，模拟 Codex status / Working 的流动感。
class _ShimmerBar extends StatefulWidget {
  final double height;
  final double widthFactor;
  const _ShimmerBar({this.height = 8, this.widthFactor = 1});
  @override
  State<_ShimmerBar> createState() => _ShimmerBarState();
}

class _ShimmerBarState extends State<_ShimmerBar>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      final w = box.maxWidth * widget.widthFactor.clamp(0.2, 1.0);
      return AnimatedBuilder(
        animation: _c,
        builder: (_, __) {
          return Container(
            width: w,
            height: widget.height,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(999),
              gradient: LinearGradient(
                begin: Alignment(-1.2 + 2.4 * _c.value, 0),
                end: Alignment(-0.2 + 2.4 * _c.value, 0),
                colors: [
                  const Color(0xFFE8E8EC),
                  const Color(0xFFD0D0D6),
                  const Color(0xFFE8E8EC),
                ],
                stops: const [0.15, 0.5, 0.85],
              ),
            ),
          );
        },
      );
    });
  }
}

/// 消息入场：轻量上浮 + 淡入，避免列表「硬切」。
class _Appear extends StatefulWidget {
  final Widget child;
  const _Appear({required this.child, super.key});
  @override
  State<_Appear> createState() => _AppearState();
}

class _AppearState extends State<_Appear>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 280),
  )..forward();
  late final Animation<double> _fade =
      CurvedAnimation(parent: _c, curve: Curves.easeOutCubic);
  late final Animation<Offset> _slide = Tween<Offset>(
    begin: const Offset(0, 0.04),
    end: Offset.zero,
  ).animate(CurvedAnimation(parent: _c, curve: Curves.easeOutCubic));

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _fade,
      child: SlideTransition(position: _slide, child: widget.child),
    );
  }
}

/// 打字机效果：新回复逐字浮现，给"正在生成"的渲染感。
class _TypingText extends StatefulWidget {
  final String text;
  final TextStyle style;
  final VoidCallback? onDone;
  const _TypingText(this.text, {required this.style, this.onDone, super.key});
  @override
  State<_TypingText> createState() => _TypingTextState();
}

class _TypingTextState extends State<_TypingText> {
  int _n = 0;
  Timer? _t;

  @override
  void initState() {
    super.initState();
    final total = widget.text.length;
    // 约 1.2s 内显示完，长文本每 tick 多显示几个字
    final per = total > 0 ? (total / 75).ceil().clamp(1, 8) : 1;
    _t = Timer.periodic(const Duration(milliseconds: 16), (_) {
      if (!mounted) return;
      setState(() => _n += per);
      if (_n >= total) {
        _t?.cancel();
        widget.onDone?.call();
      }
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final total = widget.text.length;
    final shown = _n >= total ? widget.text : widget.text.substring(0, _n);
    return Text(shown, style: widget.style);
  }
}

/// 工具卡：默认折叠成一行(图标+命令)，点击展开命令全文 + 输出。对标 Codex app。
class _ToolCard extends StatefulWidget {
  final _Msg call;
  final _Msg? output;
  const _ToolCard({required this.call, this.output, super.key});
  @override
  State<_ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<_ToolCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final tool = widget.call.tool;
    IconData icon;
    String verb;
    switch (tool) {
      case 'exec':
      case 'commandExecution':
        icon = Icons.terminal_rounded;
        verb = 'Ran';
        break;
      case 'patch':
      case 'fileChange':
        icon = Icons.edit_outlined;
        verb = 'Edited';
        break;
      case 'read':
        icon = Icons.description_outlined;
        verb = 'Read';
        break;
      case 'mcpToolCall':
        icon = Icons.extension_outlined;
        verb = 'Called';
        break;
      default:
        icon = Icons.handyman_outlined;
        verb = 'Used';
    }
    final cmd = widget.call.text;
    final firstLine =
        cmd.split('\n').first.replaceAll(RegExp(r'\s+'), ' ').trim();
    final hasOutput = (widget.output?.text.trim().isNotEmpty ?? false);
    final multiline = cmd.contains('\n');
    return Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(children: [
                Icon(icon, size: 15, color: kFaint),
                const SizedBox(width: 8),
                Text('$verb ',
                    style: const TextStyle(
                        color: kMuted,
                        fontSize: 13,
                        fontWeight: FontWeight.w500)),
                Expanded(
                  child: Text(
                    firstLine,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12.8,
                        color: kFaint),
                  ),
                ),
                Icon(_expanded ? Icons.expand_less : Icons.expand_more,
                    size: 16, color: kFaint),
              ]),
            ),
          ),
          if (_expanded) ...[
            if (multiline)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(top: 6),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                    color: const Color(0xFFF6F6F8),
                    borderRadius: BorderRadius.circular(10)),
                child: SelectableText(cmd,
                    style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12.5,
                        color: kText,
                        height: 1.45)),
              ),
            if (hasOutput) _ToolOutput(text: widget.output!.text),
          ],
        ],
      ),
    );
  }
}

/// 工具输出块：暗色终端风格，超过若干行可折叠/展开。
class _ToolOutput extends StatefulWidget {
  final String text;
  const _ToolOutput({required this.text});
  @override
  State<_ToolOutput> createState() => _ToolOutputState();
}

class _ToolOutputState extends State<_ToolOutput> {
  bool _expanded = false;
  @override
  Widget build(BuildContext context) {
    final lines = widget.text.split('\n');
    final long = lines.length > 8;
    final shown =
        (!long || _expanded) ? widget.text : lines.take(8).join('\n');
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: const Color(0xFFF6F6F8),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFE8E8EC)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText(
            shown,
            style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 12.5,
                color: kText,
                height: 1.5),
          ),
          if (long)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: GestureDetector(
                onTap: () => setState(() => _expanded = !_expanded),
                child: Text(
                  _expanded ? '收起' : '展开全部 (${lines.length} 行)',
                  style: const TextStyle(
                      color: kMuted,
                      fontSize: 12,
                      fontWeight: FontWeight.w500),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _TypingDots extends StatefulWidget {
  const _TypingDots();
  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1000))
        ..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: List.generate(3, (i) {
            final t = ((_c.value + i * 0.2) % 1.0);
            final o = 0.3 + 0.7 * (t < 0.5 ? t * 2 : (1 - t) * 2);
            return Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Opacity(
                opacity: o.clamp(0.3, 1.0),
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: const BoxDecoration(
                      color: kMuted, shape: BoxShape.circle),
                ),
              ),
            );
          }),
        );
      },
    );
  }
}
