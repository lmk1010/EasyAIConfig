import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';

import '../agent_notify.dart';
import '../api.dart';
import '../models/server.dart';
import '../session_capabilities.dart';
import '../settings.dart';
import '../store.dart';
import '../theme.dart';
import '../util.dart';
import '../widgets/bridge_launch_dialog.dart';
import 'servers_screen.dart';
import 'settings_screen.dart';
import 'terminal_screen.dart';
import 'timeline_screen.dart';

class SessionInfo {
  final String id;
  final String tool;
  final String title;
  final String displayName;
  final String cwd;
  final String commandPreview;
  final String createdAt;
  final bool running;
  final int? exitCode;
  final String origin;
  final bool remoteActive;
  final bool persistent;
  /// true = Codex app-server / Claude print-bridge（低延迟 Timeline），非 PTY。
  final bool bridge;
  /// bridge | terminal | tmux（timeline 旧值映射为 bridge）
  final String viewMode;
  final String threadId;
  final String model;
  /// working | waiting | done（服务端）；列表再归一 exited
  final String agentStatus;
  final String pendingSummary;
  final String authLabel;
  final String providerName;

  SessionInfo({
    required this.id,
    required this.tool,
    required this.title,
    required this.displayName,
    required this.cwd,
    required this.commandPreview,
    required this.createdAt,
    required this.running,
    required this.exitCode,
    required this.origin,
    required this.remoteActive,
    required this.persistent,
    this.bridge = false,
    this.viewMode = '',
    this.threadId = '',
    this.model = '',
    this.agentStatus = '',
    this.pendingSummary = '',
    this.authLabel = '',
    this.providerName = '',
  });

  /// 规范化后的界面模式。
  String get mode {
    if (viewMode == SessionMode.bridge ||
        viewMode == SessionMode.terminal ||
        viewMode == SessionMode.tmux) {
      return viewMode;
    }
    // 遗留刮屏会话：仍可打开，但不再作为启动入口
    if (viewMode == 'timeline') return 'timeline';
    if (bridge) return SessionMode.bridge;
    return SessionMode.terminal;
  }

  String get status =>
      AgentStatus.normalize(agentStatus, running: running);

  SessionCapabilities get caps =>
      SessionCapabilities.of(tool: tool, mode: mode);

  static SessionInfo fromJson(Map j) {
    final bridge = j['bridge'] == true;
    var viewMode = (j['viewMode'] ?? j['mode'] ?? '').toString();
    if (viewMode == 'timeline') viewMode = SessionMode.bridge;
    if (viewMode.isEmpty) {
      viewMode = bridge
          ? SessionMode.bridge
          : ((j['preferTerminal'] == true || j['rawTerminal'] == true)
              ? SessionMode.terminal
              : SessionMode.terminal);
    }
    final pending = j['pendingApproval'];
    var pendingSummary = '';
    if (pending is Map) {
      pendingSummary =
          (pending['summary'] ?? pending['command'] ?? pending['message'] ?? '')
              .toString();
    }
    return SessionInfo(
      id: (j['sessionId'] ?? j['id'] ?? '').toString(),
      tool: (j['tool'] ?? '').toString(),
      title: (j['title'] ?? j['commandPreview'] ?? j['command'] ?? '')
          .toString(),
      displayName: (j['displayName'] ?? '').toString(),
      cwd: (j['cwd'] ?? '').toString(),
      commandPreview: (j['commandPreview'] ?? '').toString(),
      createdAt: (j['createdAt'] ?? '').toString(),
      running: j['running'] == true,
      exitCode: (j['exitCode'] as num?)?.toInt(),
      origin: (j['origin'] ?? '').toString(),
      remoteActive: j['remoteActive'] == true,
      persistent: j['persistent'] == true,
      bridge: bridge,
      viewMode: viewMode,
      threadId: (j['threadId'] ?? '').toString(),
      model: (j['model'] ?? '').toString(),
      agentStatus: (j['agentStatus'] ?? '').toString(),
      pendingSummary: pendingSummary,
      authLabel: (j['authLabel'] ?? '').toString(),
      providerName: (j['providerName'] ?? '').toString(),
    );
  }
}

class HistItem {
  final String sessionId;
  final String tool;
  final String title;
  final String provider;
  final String model;
  final String cwd;
  final DateTime? updatedAt;

  HistItem({
    required this.sessionId,
    required this.tool,
    required this.title,
    required this.provider,
    required this.model,
    required this.cwd,
    required this.updatedAt,
  });

  static HistItem fromJson(Map j) => HistItem(
        sessionId: (j['sessionId'] ?? '').toString(),
        tool: (j['tool'] ?? '').toString(),
        title: (j['title'] ?? '').toString(),
        provider: (j['provider'] ?? '').toString(),
        model: (j['model'] ?? '').toString(),
        cwd: (j['cwd'] ?? j['projectPath'] ?? '').toString(),
        updatedAt: parseTime(j['updatedAtMs'] ?? j['updatedAt']),
      );
}

class SessionsScreen extends StatefulWidget {
  final ApiClient client;
  final ServerConfig server;
  const SessionsScreen(
      {super.key, required this.client, required this.server});
  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen>
    with SingleTickerProviderStateMixin {
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  late ApiClient _client;
  late ServerConfig _server;
  late final TabController _tab;

  // 实时会话
  List<SessionInfo> _sessions = [];
  String? _error;
  bool _loading = true;
  bool _reachable = true;
  Timer? _retryTimer;
  int _retryAttempt = 0;
  String _query = '';

  // 本地个性化
  Map<String, String> _titles = {};
  Set<String> _pinned = {};
  Set<String> _hidden = {};

  // 历史会话
  bool _histLoading = false;
  bool _histLoaded = false;
  String? _histError;
  List<HistItem> _hist = [];
  String _histQuery = ''; // 历史搜索
  final Set<String> _histCollapsed = {}; // 已折叠的历史分组
  /// 上次 agentStatus（用于等你/完成通知去重）
  final Map<String, String> _prevAgentStatus = {};
  bool _hooksArmed = false;
  /// 列表级 SSE：取代 3s 轮询
  int _streamGen = 0;
  int _sessionsAfter = 0;
  bool _streamAlive = false;

  @override
  void initState() {
    super.initState();
    _client = widget.client;
    _server = widget.server;
    _tab = TabController(length: 2, vsync: this);
    _tab.addListener(_onTabChanged);
    _loadPrefs();
    _ensureHooks();
    _refresh();
    _startSessionsStream();
  }

  Future<void> _ensureHooks() async {
    if (_hooksArmed) return;
    _hooksArmed = true;
    // 仅在用户开启时装一次；已装则后端返回 already，不重复写配置
    if (!AppSettings.instance.agentHooksEnabled.value) return;
    try {
      await _client.agentHooksOn();
    } catch (_) {}
  }

  @override
  void dispose() {
    _streamGen++;
    _tab.removeListener(_onTabChanged);
    _tab.dispose();
    _retryTimer?.cancel();
    super.dispose();
  }

  void _onTabChanged() {
    if (_tab.indexIsChanging) return;
    if (_tab.index == 1 && !_histLoaded) _loadHistory();
  }

  Future<void> _loadPrefs() async {
    final titles = await SessionPrefs.titles();
    final pinned = await SessionPrefs.pinned();
    final hidden = await SessionPrefs.hidden();
    if (!mounted) return;
    setState(() {
      _titles = titles;
      _pinned = pinned;
      _hidden = hidden;
    });
  }

  void _startSessionsStream() {
    final gen = ++_streamGen;
    () async {
      var backoffMs = 600;
      while (mounted && gen == _streamGen) {
        try {
          await for (final ev
              in _client.streamSessions(after: _sessionsAfter)) {
            if (!mounted || gen != _streamGen) return;
            final seq = (ev['seq'] as num?)?.toInt();
            if (seq != null && seq > _sessionsAfter) _sessionsAfter = seq;
            _applySessionsEvent(ev);
            if (!_streamAlive || !_reachable) {
              setState(() {
                _streamAlive = true;
                _reachable = true;
                _error = null;
              });
            }
            backoffMs = 600;
            _retryAttempt = 0;
            _retryTimer?.cancel();
          }
          // 正常结束 → 立刻重连
        } catch (e) {
          if (!mounted || gen != _streamGen) return;
          setState(() {
            _streamAlive = false;
            _reachable = false;
            _error = '推送断开，重连中…';
          });
        }
        if (!mounted || gen != _streamGen) return;
        await Future.delayed(Duration(milliseconds: backoffMs));
        backoffMs = min(15000, backoffMs * 2);
        // 重连时补一次 REST，覆盖 PTY 等非总线源
        if (mounted && gen == _streamGen) {
          await _refresh(silent: true);
        }
      }
    }();
  }

  void _applySessionsEvent(Map<String, dynamic> ev) {
    final type = (ev['type'] ?? '').toString();
    if (type == 'sessions/snapshot') {
      final list = (ev['sessions'] as List?) ?? [];
      final bridge = list
          .whereType<Map>()
          .map((e) {
            final m = Map<String, dynamic>.from(e);
            m['bridge'] = true;
            m['viewMode'] = m['viewMode'] ?? 'bridge';
            return SessionInfo.fromJson(m);
          })
          .toList();
      setState(() {
        final pty = _sessions.where((s) => !s.bridge).toList();
        _sessions = [...bridge, ...pty];
        _sortSessionsInPlace();
        _loading = false;
        _reachable = true;
      });
      _notifyStatusTransitions(_sessions);
      return;
    }
    if (type == 'session/upsert') {
      final raw = ev['session'];
      if (raw is! Map) return;
      final m = Map<String, dynamic>.from(raw);
      m['bridge'] = m['bridge'] ?? true;
      m['viewMode'] = m['viewMode'] ?? 'bridge';
      final s = SessionInfo.fromJson(m);
      setState(() {
        final i = _sessions.indexWhere((x) => x.id == s.id);
        if (i >= 0) {
          _sessions[i] = s;
        } else {
          _sessions.insert(0, s);
        }
        _sortSessionsInPlace();
        _loading = false;
      });
      _notifyStatusTransitions([s]);
      return;
    }
    if (type == 'session/remove') {
      final id = (ev['sessionId'] ?? '').toString();
      if (id.isEmpty) return;
      setState(() {
        _sessions.removeWhere((s) => s.id == id);
      });
      return;
    }
    if (type == 'agent/status') {
      final id = (ev['sessionId'] ?? '').toString();
      if (id.isEmpty) return;
      final st = (ev['agentStatus'] ?? '').toString();
      final pending = ev['pendingApproval'];
      final sessionRaw = ev['session'];
      setState(() {
        final i = _sessions.indexWhere((x) => x.id == id);
        if (sessionRaw is Map) {
          final m = Map<String, dynamic>.from(sessionRaw);
          m['bridge'] = true;
          m['viewMode'] = 'bridge';
          final s = SessionInfo.fromJson(m);
          if (i >= 0) {
            _sessions[i] = s;
          } else {
            _sessions.insert(0, s);
          }
        } else if (i >= 0) {
          final cur = _sessions[i];
          final m = {
            'sessionId': cur.id,
            'tool': cur.tool,
            'title': cur.title,
            'displayName': cur.displayName,
            'cwd': cur.cwd,
            'commandPreview': cur.commandPreview,
            'createdAt': cur.createdAt,
            'running': cur.running,
            'origin': cur.origin,
            'remoteActive': cur.remoteActive,
            'persistent': cur.persistent,
            'bridge': cur.bridge,
            'viewMode': cur.viewMode.isEmpty ? 'bridge' : cur.viewMode,
            'threadId': cur.threadId,
            'model': cur.model,
            'agentStatus': st,
            'pendingApproval': pending,
          };
          _sessions[i] = SessionInfo.fromJson(m);
        }
        _sortSessionsInPlace();
      });
      final hit = _sessions.where((s) => s.id == id);
      if (hit.isNotEmpty) _notifyStatusTransitions([hit.first]);
      return;
    }
    if (type == 'hook/status') {
      final cwd = (ev['cwd'] ?? '').toString();
      final st = (ev['agentStatus'] ?? '').toString();
      final summary = (ev['pendingApproval'] is Map)
          ? ((ev['pendingApproval']['summary'] ?? '').toString())
          : '';
      if (cwd.isEmpty || st.isEmpty) return;
      bool cwdMatch(String a, String b) {
        String norm(String p) {
          var s = p.trim();
          while (s.length > 1 && s.endsWith('/')) {
            s = s.substring(0, s.length - 1);
          }
          return s;
        }
        final na = norm(a);
        final nb = norm(b);
        if (na.isEmpty || nb.isEmpty) return false;
        return na == nb || na.startsWith('$nb/') || nb.startsWith('$na/');
      }
      setState(() {
        for (var i = 0; i < _sessions.length; i++) {
          if (!cwdMatch(_sessions[i].cwd, cwd)) continue;
          if (_sessions[i].bridge &&
              _sessions[i].agentStatus == AgentStatus.waiting) {
            continue; // bridge 自身 waiting 优先
          }
          if (st != AgentStatus.waiting) continue;
          final cur = _sessions[i];
          _sessions[i] = SessionInfo.fromJson({
            'sessionId': cur.id,
            'tool': cur.tool,
            'title': cur.title,
            'displayName': cur.displayName,
            'cwd': cur.cwd,
            'commandPreview': cur.commandPreview,
            'createdAt': cur.createdAt,
            'running': cur.running,
            'exitCode': cur.exitCode,
            'origin': cur.origin,
            'remoteActive': cur.remoteActive,
            'persistent': cur.persistent,
            'bridge': cur.bridge,
            'viewMode':
                cur.viewMode.isEmpty ? (cur.bridge ? 'bridge' : 'terminal') : cur.viewMode,
            'model': cur.model,
            'agentStatus': st,
            'pendingApproval': {'summary': summary},
          });
        }
        _sortSessionsInPlace();
      });
    }
  }

  void _sortSessionsInPlace() {
    _sessions.sort((a, b) {
      final ra = AgentStatus.sortRank(a.status);
      final rb = AgentStatus.sortRank(b.status);
      if (ra != rb) return ra.compareTo(rb);
      return b.createdAt.compareTo(a.createdAt);
    });
  }

  void _notifyStatusTransitions(List<SessionInfo> rows) {
    for (final s in rows) {
      final prev = _prevAgentStatus[s.id] ?? '';
      final cur = s.status;
      if (prev.isNotEmpty && prev != cur) {
        if (cur == AgentStatus.waiting) {
          AgentNotify.instance.waiting(
            sessionId: s.id,
            title: _displayTitle(s),
            body: s.pendingSummary,
          );
        } else if (cur == AgentStatus.done && prev == AgentStatus.working) {
          AgentNotify.instance.done(
            sessionId: s.id,
            title: _displayTitle(s),
          );
        }
      }
      _prevAgentStatus[s.id] = cur;
    }
  }

  void _scheduleRetry() {
    _retryTimer?.cancel();
    _retryAttempt++;
    final secs = min(30, 3 * pow(2, _retryAttempt - 1).toInt());
    // 仅补 REST；SSE 自带重连循环，避免双开流
    _retryTimer = Timer(Duration(seconds: secs), () => _refresh(silent: true));
  }

  Future<void> _refresh({bool silent = false}) async {
    final res = await _client.listSessions();
    if (!mounted) return;
    if (res.ok) {
      final rows = (res.data?['rows'] as List?) ?? [];
      final pty = rows.map((e) => SessionInfo.fromJson(e as Map)).toList();
      // 合并 bridge 会话（Codex app-server + Claude print-bridge）
      List<SessionInfo> bridge = [];
      Future<void> loadBridge(String path, String defaultTool, String preview) async {
        try {
          final br = await _client.get(path);
          if (br.ok && br.data is Map) {
            final list = (br.data['sessions'] as List?) ?? [];
            bridge.addAll(list.map((e) {
              final m = Map<String, dynamic>.from(e as Map);
              m['bridge'] = true;
              m['viewMode'] = 'bridge';
              m['tool'] = m['tool'] ?? defaultTool;
              m['commandPreview'] = m['commandPreview'] ?? preview;
              m['createdAt'] = m['createdAt'] ?? '';
              m['origin'] = m['origin'] ?? 'phone';
              m['remoteActive'] = true;
              m['persistent'] = false;
              m['displayName'] = m['displayName'] ?? m['title'] ?? '';
              return SessionInfo.fromJson(m);
            }));
          }
        } catch (_) {}
      }
      await loadBridge('/api/codex/list', 'codex', 'codex app-server');
      await loadBridge('/api/claude/list', 'claude', 'claude -p stream-json');
      // Hook 雷达：按 cwd 叠加 waiting/working 到已有会话（含终端/镜像）
      try {
        if (AppSettings.instance.agentHooksEnabled.value) {
          final hr = await _client.agentHooksSessions();
          if (hr.ok && hr.data is Map) {
            final hooks = (hr.data['sessions'] as List?) ?? [];
            bool cwdMatch(String a, String b) {
              String norm(String p) {
                var s = p.trim();
                while (s.length > 1 && s.endsWith('/')) {
                  s = s.substring(0, s.length - 1);
                }
                return s;
              }
              final na = norm(a);
              final nb = norm(b);
              if (na.isEmpty || nb.isEmpty) return false;
              return na == nb ||
                  na.startsWith('$nb/') ||
                  nb.startsWith('$na/');
            }
            for (final h in hooks) {
              if (h is! Map) continue;
              final cwd = (h['cwd'] ?? '').toString();
              final st = (h['agentStatus'] ?? '').toString();
              final summary = (h['pendingSummary'] ?? '').toString();
              if (cwd.isEmpty || st.isEmpty) continue;
              for (var i = 0; i < bridge.length; i++) {
                if (cwdMatch(bridge[i].cwd, cwd) &&
                    bridge[i].agentStatus != AgentStatus.waiting) {
                  // bridge 自身状态优先；仅在空/done 时用 hook 补 waiting
                  if (st == AgentStatus.waiting) {
                    final m = {
                      'sessionId': bridge[i].id,
                      'tool': bridge[i].tool,
                      'title': bridge[i].title,
                      'displayName': bridge[i].displayName,
                      'cwd': bridge[i].cwd,
                      'commandPreview': bridge[i].commandPreview,
                      'createdAt': bridge[i].createdAt,
                      'running': bridge[i].running,
                      'origin': bridge[i].origin,
                      'remoteActive': bridge[i].remoteActive,
                      'persistent': bridge[i].persistent,
                      'bridge': true,
                      'viewMode': 'bridge',
                      'threadId': bridge[i].threadId,
                      'model': bridge[i].model,
                      'agentStatus': st,
                      'pendingApproval': {'summary': summary},
                    };
                    bridge[i] = SessionInfo.fromJson(m);
                  }
                }
              }
              for (var i = 0; i < pty.length; i++) {
                if (cwdMatch(pty[i].cwd, cwd)) {
                  final m = {
                    'sessionId': pty[i].id,
                    'tool': pty[i].tool,
                    'title': pty[i].title,
                    'displayName': pty[i].displayName,
                    'cwd': pty[i].cwd,
                    'commandPreview': pty[i].commandPreview,
                    'createdAt': pty[i].createdAt,
                    'running': pty[i].running,
                    'exitCode': pty[i].exitCode,
                    'origin': pty[i].origin,
                    'remoteActive': pty[i].remoteActive,
                    'persistent': pty[i].persistent,
                    'bridge': false,
                    'viewMode':
                        pty[i].viewMode.isEmpty ? 'terminal' : pty[i].viewMode,
                    'model': pty[i].model,
                    'agentStatus': st,
                    'pendingApproval': {'summary': summary},
                  };
                  pty[i] = SessionInfo.fromJson(m);
                }
              }
            }
          }
        }
      } catch (_) {}
      final merged = [...bridge, ...pty];
      merged.sort((a, b) {
        final ra = AgentStatus.sortRank(a.status);
        final rb = AgentStatus.sortRank(b.status);
        if (ra != rb) return ra.compareTo(rb);
        return b.createdAt.compareTo(a.createdAt);
      });
      final wasUnreachable = !_reachable;
      setState(() {
        _sessions = merged;
        _sortSessionsInPlace();
        _error = null;
        _reachable = true;
        _loading = false;
      });
      _notifyStatusTransitions(merged);
      _retryAttempt = 0;
      _retryTimer?.cancel();
      if (wasUnreachable) _startSessionsStream();
    } else {
      setState(() {
        _error = res.error;
        _reachable = false;
        _loading = false;
        _streamAlive = false;
      });
      _scheduleRetry();
    }
  }

  Future<void> _loadHistory() async {
    setState(() {
      _histLoading = true;
      _histError = null;
    });
    final res = await _client.getSessionsInventory();
    if (!mounted) return;
    if (res.ok) {
      final items = (res.data?['items'] as List?) ?? [];
      setState(() {
        _hist = items.map((e) => HistItem.fromJson(e as Map)).toList()
          ..sort((a, b) {
            final ta = a.updatedAt?.millisecondsSinceEpoch ?? 0;
            final tb = b.updatedAt?.millisecondsSinceEpoch ?? 0;
            if (ta != tb) return tb.compareTo(ta);
            return b.sessionId.compareTo(a.sessionId);
          });
        _histLoaded = true;
        _histLoading = false;
      });
    } else {
      setState(() {
        _histError = res.error;
        _histLoading = false;
      });
    }
  }

  // ── 服务切换 ────────────────────────────────────────────────
  Future<void> _applyServer(ServerConfig s) async {
    await Store.selectServer(s.id);
    if (!mounted) return;
    setState(() {
      _server = s;
      _client = ApiClient(baseUrl: s.baseUrl, token: s.token);
      _sessions = [];
      _loading = true;
      _error = null;
      _reachable = true;
      _hist = [];
      _histLoaded = false;
      _retryAttempt = 0;
      _sessionsAfter = 0;
      _streamAlive = false;
      _hooksArmed = false;
    });
    _ensureHooks();
    _refresh();
    _startSessionsStream();
  }

  Future<void> _openServers() async {
    final picked = await Navigator.push<ServerConfig>(
      context,
      MaterialPageRoute(builder: (_) => ServersScreen(currentId: _server.id)),
    );
    if (!mounted) return;
    if (picked != null && picked.id != _server.id) {
      _applyServer(picked);
    } else {
      // 可能只是改了名或删除了别的服务：回读当前项刷新标题
      final cur = await Store.currentServer();
      if (cur != null && mounted) setState(() => _server = cur);
    }
  }

  Future<void> _renameServer(ServerConfig s) async {
    final ctrl = TextEditingController(text: s.name);
    final name = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('重命名服务'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: InputDecoration(
            hintText: s.baseUrl,
            border: const OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.pop(context, ctrl.text.trim()),
              child: const Text('保存')),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    s.name = name;
    await Store.updateServer(s);
    if (!mounted) return;
    Navigator.pop(context); // 关掉切换弹窗
    if (s.id == _server.id) setState(() => _server = s);
  }

  Future<void> _quickSwitch() async {
    final servers = await Store.listServers();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Theme.of(context).colorScheme.surface,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('切换服务',
                    style:
                        TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
              ),
            ),
            ...servers.map((s) => ListTile(
                  leading: Icon(
                    s.id == _server.id
                        ? Icons.check_circle
                        : Icons.dns_outlined,
                    color: s.id == _server.id ? kAccent : null,
                  ),
                  title: Text(s.name),
                  subtitle: Text(s.baseUrl,
                      maxLines: 1, overflow: TextOverflow.ellipsis),
                  trailing: IconButton(
                    icon: const Icon(Icons.edit_outlined, size: 18),
                    tooltip: '重命名',
                    onPressed: () => _renameServer(s),
                  ),
                  onTap: () {
                    Navigator.pop(context);
                    if (s.id != _server.id) _applyServer(s);
                  },
                )),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.settings_ethernet),
              title: const Text('管理服务…'),
              onTap: () {
                Navigator.pop(context);
                _openServers();
              },
            ),
          ],
        ),
      ),
    );
  }

  // ── 新建会话 ────────────────────────────────────────────────
  Future<void> _newSession() async {
    final result = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      backgroundColor: Theme.of(context).colorScheme.surface,
      isScrollControlled: true,
      builder: (_) => _NewSessionSheet(client: _client),
    );
    if (result == null) return;
    final cwd = (result['cwd'] ?? '') as String;
    if (cwd.trim().isNotEmpty) await RecentCwds.add(cwd.trim());
    final tool = (result['tool'] ?? '').toString();
    final viewMode = (result['viewMode'] ?? 'bridge').toString();
    final model = (result['model'] ?? '').toString();
    final effort = (result['effort'] ?? '').toString();
    final env = (result['env'] as Map?)?.map((k, v) => MapEntry('$k', '$v'));

    // Codex / Claude × 快速通道
    final isClaudeTool = tool == 'claude' || tool == 'claudecode';
    if ((tool == 'codex' || isClaudeTool) && viewMode == 'bridge') {
      late final ApiResult res;
      try {
        if (!mounted) return;
        res = await BridgeLaunchDialog.run(
          context,
          title: '启动快速通道',
          task: () => isClaudeTool
              ? _client.claudeThreadStart(
                  cwd: cwd,
                  model: model.isEmpty ? null : model,
                  title: (result['title'] ?? 'Claude').toString(),
                  env: env,
                )
              : _client.codexThreadStart(
                  cwd: cwd,
                  model: model.isEmpty ? null : model,
                  title: (result['title'] ?? 'Codex').toString(),
                  env: env,
                ),
        );
      } catch (e) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('启动失败: $e')),
        );
        return;
      }
      if (!mounted) return;
      if (res.ok && res.data is Map) {
        final m = Map<String, dynamic>.from(res.data as Map);
        m['bridge'] = true;
        m['viewMode'] = 'bridge';
        m['tool'] = isClaudeTool ? 'claude' : 'codex';
        m['commandPreview'] = isClaudeTool
            ? 'claude -p stream-json'
            : 'codex app-server';
        m['createdAt'] = DateTime.now().toIso8601String();
        m['origin'] = 'phone';
        m['remoteActive'] = true;
        m['persistent'] = false;
        m['displayName'] =
            m['title'] ?? (isClaudeTool ? 'Claude' : 'Codex');
        m['running'] = m['running'] ?? true;
        final s = SessionInfo.fromJson(m);
        if (!isClaudeTool && effort.isNotEmpty) {
          await _client.codexThreadSettings(s.id, reasoningEffort: effort);
        }
        _openTerminal(s);
        _refresh(silent: true);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('启动失败: ${res.error ?? '未知'}')),
        );
      }
      return;
    }

    // tmux 镜像：列出本机会话并附着
    if (viewMode == SessionMode.tmux) {
      await _attachTmuxSession(tool: tool, cwd: cwd);
      return;
    }

    // PTY：仅完整终端（刮屏 Timeline 已淘汰）
    late final ApiResult res;
    try {
      if (!mounted) return;
      res = await BridgeLaunchDialog.run(
        context,
        title: '启动终端模式',
        steps: const [
          '分配远程终端…',
          '启动 CLI…',
          '同步窗口尺寸…',
          '即将就绪…',
        ],
        task: () => _client.createSession(
          tool: tool,
          program: result['program'],
          args: List<String>.from(result['args'] ?? const []),
          cwd: cwd,
          title: result['title'] ?? result['program'],
          env: env,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('启动失败: $e')),
      );
      return;
    }
    if (!mounted) return;
    if (res.ok && res.data?['terminalSession'] != null) {
      final m = Map<String, dynamic>.from(res.data['terminalSession'] as Map);
      m['viewMode'] = SessionMode.terminal;
      m['bridge'] = false;
      final s = SessionInfo.fromJson(m);
      _openTerminal(s);
      _refresh(silent: true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('启动失败: ${res.error ?? '未知'}')),
      );
    }
  }

  Future<void> _attachTmuxSession({required String tool, required String cwd}) async {
    final listRes = await _client.tmuxList();
    if (!mounted) return;
    if (!listRes.ok || listRes.data is! Map) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('无法列出 tmux：${listRes.error ?? '未知'}')),
      );
      return;
    }
    if (listRes.data['available'] != true) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text((listRes.data['error'] ?? '本机未安装 tmux').toString()),
        ),
      );
      return;
    }
    final sessions = (listRes.data['sessions'] as List?) ?? [];
    // null = 取消；'' = 新建并启动 agent；其它 = 附着已有名
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Theme.of(context).colorScheme.surface,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 16, 20, 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('镜像 tmux',
                    style:
                        TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '新建后手机与电脑同屏；也可附着已有会话',
                  style: TextStyle(fontSize: 12, color: kMuted),
                ),
              ),
            ),
            ListTile(
              leading: const Icon(Icons.add_circle_outline, color: kAccent),
              title: Text('新建并启动 ${tool == 'claude' || tool == 'claudecode' ? 'Claude' : 'Codex'}'),
              subtitle: const Text('tmux new → 启动 agent → 附着'),
              onTap: () => Navigator.pop(context, ''),
            ),
            if (sessions.isNotEmpty) const Divider(height: 1),
            if (sessions.isEmpty)
              const Padding(
                padding: EdgeInsets.fromLTRB(20, 8, 20, 16),
                child: Text(
                  '本机暂无其它 tmux 会话',
                  style: TextStyle(fontSize: 12.5, color: kFaint),
                ),
              )
            else
              ...sessions.map((raw) {
                final m = raw is Map ? raw : <String, dynamic>{};
                final n = (m['name'] ?? '').toString();
                final attached = m['attached'] == true;
                final windows = m['windows'];
                return ListTile(
                  leading: Icon(
                    Icons.desktop_windows_outlined,
                    color: attached ? kRunning : kMuted,
                  ),
                  title: Text(n),
                  subtitle: Text(
                    [
                      attached ? '已有附着' : '空闲',
                      '${windows ?? '?'} windows',
                      if ((m['cwd'] ?? '').toString().isNotEmpty)
                        (m['cwd'] ?? '').toString(),
                    ].join(' · '),
                  ),
                  onTap: () => Navigator.pop(context, n),
                );
              }),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (choice == null || !mounted) return;
    final createNew = choice.isEmpty;
    var attachCwd = cwd;
    if (!createNew) {
      for (final raw in sessions) {
        if (raw is! Map) continue;
        if ((raw['name'] ?? '').toString() == choice) {
          final sc = (raw['cwd'] ?? '').toString().trim();
          if (sc.isNotEmpty) attachCwd = sc;
          break;
        }
      }
    }
    late final ApiResult res;
    try {
      res = await BridgeLaunchDialog.run(
        context,
        title: createNew ? '新建 tmux 并启动' : '附着 tmux · $choice',
        steps: createNew
            ? const [
                '创建 tmux 会话…',
                '启动 agent…',
                '分配远程 PTY…',
                '即将就绪…',
              ]
            : const [
                '连接本机 tmux…',
                '分配远程 PTY…',
                '同步画面…',
                '即将就绪…',
              ],
        task: () => createNew
            ? _client.tmuxCreate(tool: tool, cwd: cwd, launchAgent: true)
            : _client.tmuxAttach(name: choice, tool: tool, cwd: attachCwd),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${createNew ? '创建' : '附着'}失败: $e')),
      );
      return;
    }
    if (!mounted) return;
    final term = res.data is Map
        ? (res.data['terminalSession'] ?? res.data)
        : null;
    if (res.ok && term is Map) {
      final m = Map<String, dynamic>.from(term);
      m['viewMode'] = SessionMode.tmux;
      m['bridge'] = false;
      m['tool'] = tool.isEmpty ? (m['tool'] ?? 'shell') : tool;
      final s = SessionInfo.fromJson(m);
      _openTerminal(s);
      _refresh(silent: true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '${createNew ? '创建' : '附着'}失败: ${res.error ?? '未知'}',
          ),
        ),
      );
    }
  }

  void _openTerminal(SessionInfo s) {
    if (_scaffoldKey.currentState?.isDrawerOpen ?? false) {
      _scaffoldKey.currentState?.closeDrawer();
    }
    final displayTitle = _displayTitle(s);
    // bridge（及遗留刮屏）→ Timeline UI；terminal/tmux → 完整 TUI
    final useTimeline =
        s.bridge || s.mode == 'bridge' || s.mode == 'timeline';
    final Widget page = useTimeline
        ? TimelineScreen(client: _client, session: s, displayTitle: displayTitle)
        : TerminalScreen(client: _client, session: s, displayTitle: displayTitle);
    Navigator.push(context, MaterialPageRoute(builder: (_) => page)).then((result) {
      _refresh(silent: true);
      if (result == 'resume' && mounted) {
        _tab.animateTo(1);
        if (!_histLoaded) _loadHistory();
        _scaffoldKey.currentState?.openDrawer();
      }
    });
  }

  /// 列表级快捷回复：等你时不用先进 Timeline。
  Future<void> _quickReply(SessionInfo s) async {
    if (!s.bridge) {
      _openTerminal(s);
      return;
    }
    final ctrl = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('快捷回复'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (s.pendingSummary.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(
                  s.pendingSummary,
                  style: const TextStyle(color: kMuted, fontSize: 13),
                ),
              ),
            TextField(
              controller: ctrl,
              autofocus: true,
              maxLines: 3,
              decoration: const InputDecoration(
                hintText: '发给 Agent…',
                border: OutlineInputBorder(),
              ),
              onSubmitted: (v) => Navigator.pop(ctx, v),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              _openTerminal(s);
            },
            child: const Text('打开会话'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text),
            child: const Text('发送'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (text == null || text.trim().isEmpty || !mounted) return;
    final res = await _client.bridgeTurnStart(s.tool, s.id, text.trim());
    if (!mounted) return;
    if (!res.ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(res.error ?? '发送失败')),
      );
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已发送'), duration: Duration(seconds: 1)),
    );
  }

  // ── 本地个性化操作 ──────────────────────────────────────────
  String _displayTitle(SessionInfo s) {
    final custom = _titles[SessionPrefs.key(_server.id, s.id)];
    if (custom != null && custom.isNotEmpty) return custom;
    // 名称优先「会话第一句话」(后端 displayName)
    final first = s.displayName.trim();
    if (first.isNotEmpty && !_isGenericName(first)) return first;
    if (s.title.isNotEmpty && !_isGenericName(s.title)) return s.title;
    if (s.title.isNotEmpty) return s.title;
    return s.id.length >= 8 ? s.id.substring(0, 8) : s.id;
  }

  bool _isGenericName(String name) {
    final n = name.trim().toLowerCase();
    if (n.isEmpty) return true;
    return const [
      'codex', 'claude', 'claude code', 'claudecode',
      'shell', 'bash', 'zsh', 'sh', '命令',
    ].contains(n);
  }

  /// 会话来源标签：通道 / 等你 / 手机·电脑 / 常驻 / 在看。
  List<Widget> _deviceTags(SessionInfo s) {
    final tags = <Widget>[];
    final st = s.status;
    if (st == AgentStatus.waiting) {
      tags.add(_chip('等你', Icons.priority_high_rounded, kWaiting));
    } else if (st == AgentStatus.working) {
      tags.add(_chip('工作中', Icons.autorenew_rounded, kRunning));
    }
    switch (s.mode) {
      case SessionMode.bridge:
        tags.add(_chip('快速', Icons.bolt_rounded, kRunning));
        break;
      case SessionMode.terminal:
        tags.add(_chip('终端', Icons.terminal, const Color(0xFF5B8CFF)));
        break;
      case SessionMode.tmux:
        tags.add(_chip('镜像', Icons.phone_android_rounded, const Color(0xFF8B6DFF)));
        break;
    }
    if (s.persistent) {
      tags.add(_chip('常驻', Icons.bolt, const Color(0xFF2FA860)));
    }
    if (s.origin == 'phone') {
      tags.add(_chip('手机', Icons.smartphone, kAccent));
    } else if (s.origin == 'desktop') {
      tags.add(_chip('电脑', Icons.computer, const Color(0xFF5B8CFF)));
    }
    if (s.remoteActive && s.origin != 'phone') {
      tags.add(_chip('在看', Icons.visibility, kRunning));
    }
    if (tags.isEmpty) return const [];
    return [
      for (final t in tags) ...[const SizedBox(width: 4), t],
    ];
  }

  String _modeLabel(String mode) => SessionMode.shortLabel(mode);

  Widget _chip(String label, IconData icon, Color color) {
    // 无边框：只用极浅底色区分
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 10, color: color),
        const SizedBox(width: 3),
        Text(label,
            style: TextStyle(
                fontSize: 10, fontWeight: FontWeight.w600, color: color)),
      ]),
    );
  }

  Future<void> _rename(SessionInfo s) async {
    final ctrl = TextEditingController(text: _displayTitle(s));
    final name = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('重命名（仅本机）'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            hintText: '留空则恢复默认标题',
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(
              onPressed: () => Navigator.pop(context, ctrl.text),
              child: const Text('保存')),
        ],
      ),
    );
    if (name == null) return;
    await SessionPrefs.setTitle(_server.id, s.id, name);
    await _loadPrefs();
  }

  Future<void> _togglePin(SessionInfo s) async {
    await SessionPrefs.togglePin(_server.id, s.id);
    await _loadPrefs();
  }

  Future<void> _hide(SessionInfo s) async {
    await SessionPrefs.setHidden(_server.id, s.id, true);
    await _loadPrefs();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: const Text('已在本机隐藏该会话'),
        action: SnackBarAction(
          label: '撤销',
          onPressed: () async {
            await SessionPrefs.setHidden(_server.id, s.id, false);
            await _loadPrefs();
          },
        ),
      ),
    );
  }

  List<SessionInfo> get _visibleSessions {
    final q = _query.trim().toLowerCase();
    final list = _sessions.where((s) {
      if (_hidden.contains(SessionPrefs.key(_server.id, s.id))) return false;
      if (q.isEmpty) return true;
      final hay =
          '${_displayTitle(s)} ${toolLabel(s.tool)} ${s.cwd}'.toLowerCase();
      return hay.contains(q);
    }).toList();
    list.sort((a, b) {
      final pa = _pinned.contains(SessionPrefs.key(_server.id, a.id)) ? 0 : 1;
      final pb = _pinned.contains(SessionPrefs.key(_server.id, b.id)) ? 0 : 1;
      if (pa != pb) return pa - pb;
      // 等你 > 工作中 > 空闲/退出
      final sa = AgentStatus.sortRank(a.status);
      final sb = AgentStatus.sortRank(b.status);
      if (sa != sb) return sa.compareTo(sb);
      final ta = parseTime(a.createdAt)?.millisecondsSinceEpoch ?? 0;
      final tb = parseTime(b.createdAt)?.millisecondsSinceEpoch ?? 0;
      if (ta != tb) return tb.compareTo(ta);
      if (a.running != b.running) return a.running ? -1 : 1;
      return b.id.compareTo(a.id);
    });
    return list;
  }

  // ChatGPT 风格圆形图标按钮
  Widget _circleBtn(IconData icon, VoidCallback onTap, {double size = 40}) =>
      Material(
        color: kSurface,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
            width: size,
            height: size,
            child: Icon(icon, size: 20, color: kText),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: _scaffoldKey,
      drawer: _buildDrawer(),
      appBar: AppBar(
        leadingWidth: 60,
        leading: Builder(
          builder: (ctx) => Padding(
            padding: const EdgeInsets.only(left: 12),
            child: _circleBtn(Icons.menu, () => Scaffold.of(ctx).openDrawer()),
          ),
        ),
        title: InkWell(
          onTap: _quickSwitch,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Flexible(
                child: Text(_server.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w600)),
              ),
              const Icon(Icons.expand_more, size: 18, color: kMuted),
            ]),
          ),
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: _circleBtn(Icons.add_comment_outlined, _newSession),
          ),
        ],
      ),
      body: Column(
        children: [
          if (!_reachable) _healthBanner(),
          Expanded(child: _home()),
        ],
      ),
    );
  }

  // 主区：干净的起始页（会话在左侧抽屉）。
  Widget _home() {
    final live = _visibleSessions;
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 40),
      children: [
        const SizedBox(height: 48),
        const Center(
          child: Text('开始对话',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, letterSpacing: -0.3)),
        ),
        const SizedBox(height: 8),
        const Center(
          child: Text('远程操作电脑上的 Codex / Claude Code',
              textAlign: TextAlign.center,
              style: TextStyle(color: kMuted, fontSize: 13.5)),
        ),
        const SizedBox(height: 22),
        Center(
          child: FilledButton.icon(
            onPressed: _newSession,
            icon: const Icon(Icons.add, size: 18),
            label: const Text('新建会话'),
          ),
        ),
        if (live.isNotEmpty) ...[
          const SizedBox(height: 36),
          const Padding(
            padding: EdgeInsets.only(left: 4, bottom: 6),
            child: Text('进行中',
                style: TextStyle(
                    color: kMuted,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.2)),
          ),
          ...live.take(8).map(_sessionCard),
        ] else if (_reachable) ...[
          const SizedBox(height: 24),
          const Center(
            child: Text('还没有进行中的会话',
                style: TextStyle(color: kFaint, fontSize: 12.5)),
          ),
        ],
      ],
    );
  }

  Widget _buildDrawer() {
    return Drawer(
      width: 320,
      child: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 14, 10, 10),
              child: Row(children: [
                const Expanded(
                  child: Text('EasyAIConfig',
                      style: TextStyle(
                          fontSize: 18, fontWeight: FontWeight.w700)),
                ),
                _circleBtn(Icons.refresh, () => _refresh(), size: 36),
                const SizedBox(width: 6),
                _circleBtn(Icons.add_comment_outlined, () {
                  Navigator.pop(context);
                  _newSession();
                }, size: 36),
              ]),
            ),
            TabBar(
              controller: _tab,
              tabs: const [Tab(text: '会话'), Tab(text: '历史')],
            ),
            Expanded(
              child: TabBarView(
                controller: _tab,
                children: [_liveTab(), _historyTab()],
              ),
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.dns_outlined),
              title: Text(_server.name,
                  maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: const Text('切换 / 管理服务器',
                  style: TextStyle(fontSize: 11.5)),
              onTap: () {
                Navigator.pop(context);
                _quickSwitch();
              },
            ),
            ListTile(
              leading: const Icon(Icons.settings_outlined),
              title: const Text('设置'),
              onTap: () {
                Navigator.pop(context);
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => SettingsScreen(client: _client),
                  ),
                );
              },
            ),
            const SizedBox(height: 6),
          ],
        ),
      ),
    );
  }

  Widget _healthBanner() {
    return Material(
      color: kWarn.withValues(alpha: 0.14),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        child: Row(
          children: [
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2, color: kWarn),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                '连接已断开，正在自动重连…${_error != null ? '（$_error）' : ''}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: kWarn, fontSize: 12.5),
              ),
            ),
            TextButton(
              onPressed: () => _refresh(),
              child: const Text('立即重试'),
            ),
          ],
        ),
      ),
    );
  }

  // ── 实时会话 Tab ────────────────────────────────────────────
  Widget _liveTab() {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
          child: TextField(
            onChanged: (v) => setState(() => _query = v),
            decoration: InputDecoration(
              isDense: true,
              prefixIcon: const Icon(Icons.search, size: 20),
              hintText: '搜索标题 / 工具 / 目录',
              border:
                  OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
              contentPadding: const EdgeInsets.symmetric(vertical: 8),
            ),
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _refresh,
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : (_sessions.isEmpty
                    ? (_reachable ? _emptyLive() : _errorLive())
                    : _liveList()),
          ),
        ),
      ],
    );
  }

  Widget _errorLive() => ListView(children: [
        const SizedBox(height: 100),
        const Icon(Icons.cloud_off, size: 48, color: kFaint),
        const SizedBox(height: 12),
        Center(
            child: Text(_error ?? '连接失败',
                style: const TextStyle(color: kMuted))),
        const SizedBox(height: 20),
        Center(
          child:
              FilledButton(onPressed: () => _refresh(), child: const Text('重试')),
        ),
      ]);

  Widget _emptyLive() => ListView(children: const [
        SizedBox(height: 120),
        Icon(Icons.terminal, size: 48, color: kFaint),
        SizedBox(height: 12),
        Center(
          child: Text('还没有会话\n在电脑端新建，或点右下角「新建会话」',
              textAlign: TextAlign.center,
              style: TextStyle(color: kFaint)),
        ),
      ]);

  Widget _liveList() {
    final items = _visibleSessions;
    if (items.isEmpty) {
      return ListView(children: const [
        SizedBox(height: 120),
        Center(
            child: Text('没有匹配的会话',
                style: TextStyle(color: kFaint))),
      ]);
    }
    // codex / claude 分类展示
    final codex = items.where((s) => s.tool == 'codex').toList();
    final claude = items
        .where((s) => s.tool == 'claudecode' || s.tool == 'claude')
        .toList();
    final other = items
        .where((s) =>
            s.tool != 'codex' && s.tool != 'claudecode' && s.tool != 'claude')
        .toList();
    final children = <Widget>[];
    void addGroup(String title, List<SessionInfo> list) {
      if (list.isEmpty) return;
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(8, 14, 8, 6),
        child: Row(children: [
          Text(title,
              style: const TextStyle(
                  color: kText, fontSize: 13, fontWeight: FontWeight.w700)),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
            decoration: BoxDecoration(
                color: kSurfaceHigh, borderRadius: BorderRadius.circular(999)),
            child: Text('${list.length}',
                style: const TextStyle(color: kMuted, fontSize: 11)),
          ),
        ]),
      ));
      for (var i = 0; i < list.length; i++) {
        children.add(_sessionCard(list[i]));
        if (i != list.length - 1) {
          children.add(const Divider(height: 1, indent: 40, endIndent: 8));
        }
      }
    }

    // 只有一类时不显分组标题，避免多余
    final groups = [codex, claude, other].where((g) => g.isNotEmpty).length;
    if (groups <= 1) {
      return ListView.separated(
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 96),
        itemCount: items.length,
        separatorBuilder: (_, __) =>
            const Divider(height: 1, indent: 40, endIndent: 8),
        itemBuilder: (_, i) => _sessionCard(items[i]),
      );
    }
    addGroup('Codex', codex);
    addGroup('Claude Code', claude);
    addGroup('其他', other);
    return ListView(
      padding: const EdgeInsets.fromLTRB(8, 2, 8, 96),
      children: children,
    );
  }

  Widget _sessionCard(SessionInfo s) {
    final pinned = _pinned.contains(SessionPrefs.key(_server.id, s.id));
    final created = parseTime(s.createdAt);
    return Dismissible(
      key: ValueKey('sess_${s.id}'),
      direction: DismissDirection.endToStart,
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 20),
        decoration: BoxDecoration(
          color: kWarn.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(14),
        ),
        child: const Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          Icon(Icons.visibility_off, color: kWarn),
          SizedBox(width: 6),
          Text('隐藏', style: TextStyle(color: kWarn)),
        ]),
      ),
      confirmDismiss: (_) async {
        await _hide(s);
        return false; // 由列表刷新移除，避免 Dismissible 动画与状态冲突
      },
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => _openTerminal(s),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                // OpenAI / Claude 真 logo；退出态降透明
                toolLogo(s.tool, size: 28, running: s.running),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        if (pinned) ...[
                          const Icon(Icons.push_pin, size: 12, color: kAccent),
                          const SizedBox(width: 3),
                        ],
                        Flexible(
                          child: Text(
                            _displayTitle(s),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                fontSize: 14.5,
                                height: 1.2),
                          ),
                        ),
                        ..._deviceTags(s),
                      ]),
                      const SizedBox(height: 2),
                      Text(
                        '${toolLabel(s.tool)}'
                        ' · ${_modeLabel(s.mode)}'
                        ' · ${AgentStatus.label(s.status)}'
                        '${s.pendingSummary.isNotEmpty && s.status == AgentStatus.waiting ? ' · ${s.pendingSummary}' : ''}'
                        '${created != null ? ' · ${relativeTime(created)}' : ''}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: s.status == AgentStatus.waiting
                              ? kWaiting
                              : kMuted,
                          fontSize: 11.5,
                          fontWeight: s.status == AgentStatus.waiting
                              ? FontWeight.w600
                              : FontWeight.w400,
                        ),
                      ),
                    ],
                  ),
                ),
                if (s.status == AgentStatus.waiting && s.bridge)
                  IconButton(
                    tooltip: '快捷回复',
                    icon: const Icon(Icons.reply_rounded, color: kWaiting),
                    onPressed: () => _quickReply(s),
                  ),
                SizedBox(
                  width: 32,
                  height: 32,
                  child: PopupMenuButton<String>(
                    padding: EdgeInsets.zero,
                    iconSize: 18,
                    icon: const Icon(Icons.more_vert, color: kFaint),
                    onSelected: (v) {
                      switch (v) {
                        case 'rename':
                          _rename(s);
                          break;
                        case 'pin':
                          _togglePin(s);
                          break;
                        case 'hide':
                          _hide(s);
                          break;
                        case 'reply':
                          _quickReply(s);
                          break;
                      }
                    },
                    itemBuilder: (_) => [
                      if (s.status == AgentStatus.waiting && s.bridge)
                        const PopupMenuItem(
                            value: 'reply', child: Text('快捷回复')),
                      const PopupMenuItem(value: 'rename', child: Text('重命名')),
                      PopupMenuItem(
                          value: 'pin', child: Text(pinned ? '取消置顶' : '置顶')),
                      const PopupMenuItem(value: 'hide', child: Text('隐藏')),
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

  // ── 历史会话 Tab ────────────────────────────────────────────
  Widget _historyTab() {
    if (_histLoading && !_histLoaded) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_histError != null && _hist.isEmpty) {
      return ListView(children: [
        const SizedBox(height: 100),
        const Icon(Icons.history, size: 48, color: kFaint),
        const SizedBox(height: 12),
        Center(
            child: Text(_histError!,
                style: const TextStyle(color: kMuted))),
        const SizedBox(height: 20),
        Center(
            child: FilledButton(
                onPressed: _loadHistory, child: const Text('重试'))),
      ]);
    }
    if (_hist.isEmpty) {
      return RefreshIndicator(
        onRefresh: _loadHistory,
        child: ListView(children: const [
          SizedBox(height: 120),
          Icon(Icons.history, size: 48, color: kFaint),
          SizedBox(height: 12),
          Center(child: Text('没有历史会话', style: TextStyle(color: kFaint))),
        ]),
      );
    }
    // 搜索过滤
    final q = _histQuery.trim().toLowerCase();
    bool match(HistItem h) => q.isEmpty ||
        '${h.title} ${h.model} ${h.provider} ${h.cwd} ${h.sessionId}'
            .toLowerCase()
            .contains(q);
    final codex = _hist.where((h) => h.tool == 'codex' && match(h)).toList();
    final claude = _hist
        .where((h) =>
            (h.tool == 'claudecode' || h.tool == 'claude') && match(h))
        .toList();
    final other = _hist
        .where((h) =>
            h.tool != 'codex' &&
            h.tool != 'claudecode' &&
            h.tool != 'claude' &&
            match(h))
        .toList();
    int byUpdated(HistItem a, HistItem b) {
      final ta = a.updatedAt?.millisecondsSinceEpoch ?? 0;
      final tb = b.updatedAt?.millisecondsSinceEpoch ?? 0;
      if (ta != tb) return tb.compareTo(ta);
      return b.sessionId.compareTo(a.sessionId);
    }
    codex.sort(byUpdated);
    claude.sort(byUpdated);
    other.sort(byUpdated);
    final children = <Widget>[];
    void addGroup(String title, List<HistItem> items) {
      if (items.isEmpty) return;
      final collapsed = _histCollapsed.contains(title);
      children.add(_groupHeader(title, items.length, collapsed));
      if (!collapsed) {
        for (var i = 0; i < items.length; i++) {
          children.add(_histRow(items[i]));
          if (i != items.length - 1) {
            children.add(const Divider(height: 1, indent: 44, endIndent: 4));
          }
        }
        children.add(const SizedBox(height: 6));
      }
    }

    addGroup('Codex', codex);
    addGroup('Claude Code', claude);
    addGroup('其他', other);
    if (children.isEmpty) {
      children.add(const Padding(
        padding: EdgeInsets.only(top: 60),
        child: Center(
            child: Text('没有匹配的历史', style: TextStyle(color: kFaint))),
      ));
    }
    return Column(
      children: [
        // 搜索框
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
          child: TextField(
            onChanged: (v) => setState(() => _histQuery = v),
            decoration: InputDecoration(
              isDense: true,
              prefixIcon: const Icon(Icons.search, size: 20),
              hintText: '搜索历史（标题 / 模型 / 目录）',
              border:
                  OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
              contentPadding: const EdgeInsets.symmetric(vertical: 8),
            ),
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _loadHistory,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(12, 2, 12, 96),
              children: children,
            ),
          ),
        ),
      ],
    );
  }

  // 分组标题：点击折叠/展开。
  Widget _groupHeader(String title, int count, [bool collapsed = false]) =>
      InkWell(
        onTap: () => setState(() {
          if (collapsed) {
            _histCollapsed.remove(title);
          } else {
            _histCollapsed.add(title);
          }
        }),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(6, 14, 6, 8),
          child: Row(children: [
            Icon(collapsed ? Icons.chevron_right : Icons.expand_more,
                size: 18, color: kMuted),
            const SizedBox(width: 2),
            Text(title,
                style: const TextStyle(
                    color: kText, fontSize: 13, fontWeight: FontWeight.w700)),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
              decoration: BoxDecoration(
                  color: kSurfaceHigh, borderRadius: BorderRadius.circular(999)),
              child: Text('$count',
                  style: const TextStyle(color: kMuted, fontSize: 11)),
            ),
          ]),
        ),
      );

  // 无卡片列表行：小图标 + 标题 + 一行元信息 + 恢复箭头。
  Widget _histRow(HistItem h) {
    final meta = [
      if (h.model.isNotEmpty && h.model != 'unknown') h.model,
      if (h.cwd.isNotEmpty) shortCwd(h.cwd),
      if (h.updatedAt != null) relativeTime(h.updatedAt),
    ].join(' · ');
    return InkWell(
      onTap: () => _openHistory(h),
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 11),
        child: Row(children: [
          toolLogo(h.tool, size: 20),
          const SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  h.title.isEmpty ? h.sessionId : h.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style:
                      const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w500),
                ),
                if (meta.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: kMuted, fontSize: 11.5)),
                ],
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: kFaint, size: 18),
        ]),
      ),
    );
  }

  Future<void> _openHistory(HistItem h) async {
    final canResume = h.tool == 'codex' || h.tool == 'claudecode';
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Theme.of(context).colorScheme.surface,
      isScrollControlled: true,
      builder: (_) => _HistoryDetailSheet(
        item: h,
        canResume: canResume,
        onResume: canResume ? () => _resumeHistory(h) : null,
      ),
    );
  }

  Future<void> _resumeHistory(HistItem h) async {
    Navigator.pop(context); // 关闭详情弹窗
    final isCodex = h.tool == 'codex';
    if (isCodex) {
      // 历史会话走 app-server thread/resume
      late final ApiResult res;
      try {
        res = await BridgeLaunchDialog.run(
          context,
          title: '恢复快速通道',
          steps: const [
            '拉起 app-server…',
            '恢复历史线程…',
            '同步上下文…',
            '即将就绪…',
          ],
          task: () => _client.codexThreadStart(
            cwd: h.cwd.isEmpty ? '.' : h.cwd,
            model: h.model.isEmpty ? null : h.model,
            title: h.title.isEmpty ? 'Codex' : h.title,
            resumeThreadId: h.sessionId,
          ),
        );
      } catch (e) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('恢复失败: $e')),
        );
        return;
      }
      if (!mounted) return;
      if (res.ok && res.data is Map) {
        final m = Map<String, dynamic>.from(res.data as Map);
        m['bridge'] = true;
        m['viewMode'] = 'bridge';
        m['tool'] = 'codex';
        m['commandPreview'] = 'codex app-server resume';
        m['createdAt'] = DateTime.now().toIso8601String();
        m['origin'] = 'phone';
        m['remoteActive'] = true;
        m['persistent'] = false;
        m['displayName'] = h.title;
        m['running'] = true;
        final s = SessionInfo.fromJson(m);
        _tab.animateTo(0);
        _openTerminal(s);
        _refresh(silent: true);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('恢复失败: ${res.error ?? '未知'}')),
        );
      }
      return;
    }
    final program = 'claude';
    final args = <String>['--continue'];
    final res = await _client.createSession(
      tool: h.tool,
      program: program,
      args: args,
      cwd: h.cwd,
      title: 'claude --continue',
    );
    if (!mounted) return;
    if (res.ok && res.data?['terminalSession'] != null) {
      final s = SessionInfo.fromJson(res.data['terminalSession'] as Map);
      _tab.animateTo(0);
      _openTerminal(s);
      _refresh(silent: true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('恢复失败: ${res.error ?? '未知'}')),
      );
    }
  }
}

/// 历史会话详情弹窗（只读 + 可选恢复）。
class _HistoryDetailSheet extends StatelessWidget {
  final HistItem item;
  final bool canResume;
  final VoidCallback? onResume;
  const _HistoryDetailSheet({
    required this.item,
    required this.canResume,
    this.onResume,
  });

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 18, 20, 20 + bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            item.title.isEmpty ? item.sessionId : item.title,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 14),
          _row('工具', toolLabel(item.tool)),
          if (item.model.isNotEmpty) _row('模型', item.model),
          if (item.provider.isNotEmpty) _row('Provider', item.provider),
          if (item.cwd.isNotEmpty) _row('目录', item.cwd),
          if (item.updatedAt != null) _row('更新', relativeTime(item.updatedAt)),
          _row('Session', item.sessionId),
          const SizedBox(height: 18),
          if (canResume)
            FilledButton.icon(
              onPressed: onResume,
              icon: const Icon(Icons.play_arrow),
              label: Text(item.tool == 'codex'
                  ? '以 app-server 继续'
                  : '以 claude --continue 继续'),
              style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 14)),
            )
          else
            Text(
              '该工具暂不支持远程恢复，仅供查看。',
              style: TextStyle(
                  color:
                      Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6)),
            ),
        ],
      ),
    );
  }

  Widget _row(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 72,
              child: Text(k,
                  style: const TextStyle(color: kMuted, fontSize: 13)),
            ),
            Expanded(
              child: Text(v, style: const TextStyle(fontSize: 13)),
            ),
          ],
        ),
      );
}

/// 新建会话底部弹窗：工具 + 目录（最近目录 chips）+ codex 的模型/推理/沙盒/provider。
class _NewSessionSheet extends StatefulWidget {
  final ApiClient client;
  const _NewSessionSheet({required this.client});
  @override
  State<_NewSessionSheet> createState() => _NewSessionSheetState();
}

class _NewSessionSheetState extends State<_NewSessionSheet> {
  static const _customModel = '__custom__';
  static const _codexModels = [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5-codex',
    'gpt-5',
    'gpt-5-mini',
  ];
  static const _claudeModels = [
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ];
  static const _efforts = [
    '',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ];

  String _tool = 'codex';
  /// bridge | timeline | terminal
  String _viewMode = 'bridge';
  final _cwd = TextEditingController();
  final _modelCustom = TextEditingController();
  String _sandbox = 'bypass';
  String _model = '';
  String _effort = '';
  String? _providerKey;
  bool _advanced = false;

  List<String> _recentCwds = [];
  List<(String, String)> _providers = []; // (key, label)
  // 账号（多账号切换）：(home, label)；home 为空表示默认当前登录。
  List<(String, String)> _accounts = [];
  String _accountHome = '';

  @override
  void initState() {
    super.initState();
    _loadRecent();
    _loadProviders();
    _loadAccounts();
  }

  @override
  void dispose() {
    _cwd.dispose();
    _modelCustom.dispose();
    super.dispose();
  }

  Future<void> _loadRecent() async {
    final r = await RecentCwds.list();
    if (!mounted) return;
    setState(() => _recentCwds = r);
  }

  Future<void> _browseDir() async {
    final start = _cwd.text.trim();
    final selected = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) =>
          _DirBrowser(client: widget.client, startPath: start.isEmpty ? null : start),
    );
    if (selected != null && selected.isNotEmpty && mounted) {
      setState(() => _cwd.text = selected);
    }
  }

  Future<void> _loadProviders() async {
    // 可选/防御式：失败就不显示 provider 选择。
    final res = await widget.client.getState();
    if (!mounted || !res.ok) return;
    final list = (res.data?['providers'] as List?) ?? [];
    final providers = <(String, String)>[];
    for (final p in list) {
      if (p is Map) {
        final key = (p['key'] ?? '').toString();
        if (key.isEmpty) continue;
        final name = (p['name'] ?? key).toString();
        providers.add((key, name));
      }
    }
    if (!mounted) return;
    setState(() => _providers = providers);
  }

  // 载入当前工具的多账号列表（codex 官方 / claude），失败则只保留「默认」。
  Future<void> _loadAccounts() async {
    final isCodex = _tool == 'codex';
    final res =
        isCodex ? await widget.client.getCodexAccounts() : await widget.client.getClaudeAccounts();
    final accounts = <(String, String)>[('', '默认（当前登录账号）')];
    if (res.ok) {
      final list = (res.data?['profiles'] as List?) ?? [];
      for (final p in list) {
        if (p is! Map) continue;
        final home = isCodex
            ? (p['codexHome'] ?? '').toString()
            : (p['configDir'] ?? '').toString();
        if (home.isEmpty) continue;
        final label = (p['email'] ?? p['name'] ?? p['id'] ?? home).toString();
        accounts.add((home, label));
      }
    }
    if (!mounted) return;
    setState(() {
      _accounts = accounts;
      if (!_accounts.any((a) => a.$1 == _accountHome)) _accountHome = '';
    });
  }

  List<String> get _models => _tool == 'codex' ? _codexModels : _claudeModels;

  void _start() {
    // 旧刮屏模式已淘汰，强制走快速通道
    if (_viewMode == 'timeline') {
      _viewMode = SessionMode.bridge;
    }
    if (_viewMode == SessionMode.tmux) {
      Navigator.pop(context, {
        'tool': _tool,
        'viewMode': SessionMode.tmux,
        'cwd': _cwd.text.trim(),
        'title': 'tmux',
      });
      return;
    }
    final isCodex = _tool == 'codex';
    final program = isCodex ? 'codex' : 'claude';
    final args = <String>[];
    final model =
        _model == _customModel ? _modelCustom.text.trim() : _model.trim();
    if (isCodex) {
      switch (_sandbox) {
        case 'bypass':
          args.add('--dangerously-bypass-approvals-and-sandbox');
          break;
        case 'workspace-write':
          args.addAll(['--sandbox', 'workspace-write']);
          break;
        case 'read-only':
          args.addAll(['--sandbox', 'read-only']);
          break;
        default:
          break; // 默认：不加沙盒参数
      }
      if (_effort.isNotEmpty) {
        args.addAll(['-c', 'model_reasoning_effort="$_effort"']);
      }
      if (_providerKey != null && _providerKey!.isNotEmpty) {
        args.addAll(['-c', 'model_provider="$_providerKey"']);
      }
    }
    if (model.isNotEmpty) args.addAll(['--model', model]);
    // 多账号切换：按会话注入 env，不改全局配置、不泄露密钥。
    final env = <String, String>{};
    if (_accountHome.isNotEmpty) {
      env[isCodex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = _accountHome;
    }
    Navigator.pop(context, {
      'tool': _tool,
      'program': program,
      'args': args,
      'cwd': _cwd.text.trim(),
      'title': program,
      'model': model,
      'effort': _effort,
      'env': env,
      'viewMode': _viewMode,
    });
  }

  static const _valueStyle = TextStyle(fontSize: 14, height: 1.2);

  Widget _labeled(String label, Widget field) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 2, bottom: 5),
              child: Text(label,
                  style: const TextStyle(
                      color: kMuted,
                      fontSize: 11.5,
                      fontWeight: FontWeight.w500,
                      height: 1.1)),
            ),
            field,
          ],
        ),
      );

  InputDecoration _dec({String? hint}) => InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(fontSize: 13, color: kFaint),
        filled: true,
        fillColor: kSurfaceHigh,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: kAccent, width: 1.1),
        ),
        isDense: true,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      );

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    final isCodex = _tool == 'codex';
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 6, 16, 14 + bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 32,
                height: 3.5,
                margin: const EdgeInsets.only(bottom: 10),
                decoration: BoxDecoration(
                  color: kLine,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const Text('新建会话',
                style: TextStyle(
                    fontSize: 16, fontWeight: FontWeight.w700, height: 1.15)),
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(2),
              decoration: BoxDecoration(
                color: kSurfaceHigh,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                children: [
                  Expanded(child: _toolTab('codex', 'Codex')),
                  Expanded(child: _toolTab('claudecode', 'Claude Code')),
                ],
              ),
            ),
            const SizedBox(height: 10),
            _modePicker(isCodex),
            _labeled(
              '工作目录',
              Row(children: [
                Expanded(
                  child: TextField(
                    controller: _cwd,
                    autocorrect: false,
                    readOnly: true,
                    style: _valueStyle,
                    onTap: _browseDir,
                    decoration: _dec(hint: '默认 \$HOME · 点选或浏览'),
                  ),
                ),
                const SizedBox(width: 8),
                Material(
                  color: kAccent,
                  borderRadius: BorderRadius.circular(10),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(10),
                    onTap: _browseDir,
                    child: const SizedBox(
                      width: 42,
                      height: 42,
                      child: Icon(Icons.folder_open,
                          color: Colors.white, size: 20),
                    ),
                  ),
                ),
              ]),
            ),
            if (_recentCwds.isNotEmpty) ...[
              const Padding(
                padding: EdgeInsets.only(left: 2, bottom: 5),
                child: Text('最近',
                    style: TextStyle(
                        color: kMuted,
                        fontSize: 11.5,
                        fontWeight: FontWeight.w500)),
              ),
              SizedBox(
                height: 34,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: _recentCwds.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 6),
                  itemBuilder: (_, i) {
                    final c = _recentCwds[i];
                    final selected = _cwd.text.trim() == c;
                    final parts = c
                        .split(RegExp(r'[\\/]'))
                        .where((e) => e.isNotEmpty)
                        .toList();
                    final name = parts.isEmpty ? null : parts.last;
                    return Material(
                      color: selected ? kAccentSoft : kSurfaceHigh,
                      borderRadius: BorderRadius.circular(8),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(8),
                        onTap: () => setState(() => _cwd.text = c),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 10, vertical: 6),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.folder_outlined,
                                  size: 14,
                                  color: selected ? kAccent : kMuted),
                              const SizedBox(width: 4),
                              ConstrainedBox(
                                constraints:
                                    const BoxConstraints(maxWidth: 120),
                                child: Text(
                                  name ?? shortCwd(c),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w600,
                                    color: selected ? kAccent : kText,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(height: 12),
            ],
            if (_accounts.length > 1) _accountPicker(),
            _modelPicker(),
            if (_model == _customModel)
              _labeled(
                '自定义模型名',
                TextField(
                  controller: _modelCustom,
                  autocorrect: false,
                  style: _valueStyle,
                  decoration: _dec(hint: 'gpt-5-pro / claude-opus-4-x'),
                ),
              ),
            if (isCodex) ...[
              InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () => setState(() => _advanced = !_advanced),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(children: [
                    Icon(_advanced ? Icons.expand_less : Icons.expand_more,
                        size: 18, color: kMuted),
                    const SizedBox(width: 2),
                    const Text('高级选项',
                        style: TextStyle(
                            fontSize: 12.5,
                            color: kMuted,
                            fontWeight: FontWeight.w500)),
                  ]),
                ),
              ),
              if (_advanced) ...[
                const SizedBox(height: 4),
                ..._codexAdvanced(),
              ],
            ],
            const SizedBox(height: 8),
            SizedBox(
              height: 44,
              child: FilledButton(
                onPressed: _start,
                style: FilledButton.styleFrom(
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)),
                  textStyle: const TextStyle(
                      fontSize: 14.5, fontWeight: FontWeight.w600),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(SessionMode.icon(_viewMode), size: 17),
                    const SizedBox(width: 5),
                    Text(_startLabel(isCodex)),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _startLabel(bool isCodex) {
    switch (_viewMode) {
      case SessionMode.bridge:
        return '启动快速通道';
      case SessionMode.terminal:
        return '启动终端模式';
      case SessionMode.tmux:
        return '打开镜像…';
      default:
        return isCodex ? '启动快速通道' : '启动快速通道';
    }
  }

  Widget _toolTab(String value, String label) {
    final on = _tool == value;
    return Material(
      color: on ? kBg : Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () {
          if (_tool == value) return;
          setState(() {
            _tool = value;
            _model = '';
            _accountHome = '';
            _viewMode = 'bridge';
          });
          _loadAccounts();
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 7),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (on) ...[
                const Icon(Icons.check, size: 13, color: kAccent),
                const SizedBox(width: 3),
              ],
              Text(
                label,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: on ? FontWeight.w700 : FontWeight.w500,
                  color: on ? kText : kMuted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _modePicker(bool isCodex) {
    // 两工具对称：快速 / 终端 / 镜像；已淘汰刮屏
    final modes = SessionMode.launchable;
    final caps = SessionCapabilities.of(tool: _tool, mode: _viewMode);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 2, bottom: 5),
            child: Row(
              children: [
                const Text('模式',
                    style: TextStyle(
                        color: kMuted,
                        fontSize: 11.5,
                        fontWeight: FontWeight.w500)),
                const Spacer(),
                Text(SessionMode.subtitle(_viewMode),
                    style: TextStyle(
                        color: SessionMode.accent(_viewMode),
                        fontSize: 11,
                        fontWeight: FontWeight.w600)),
              ],
            ),
          ),
          Row(
            children: [
              for (var i = 0; i < modes.length; i++) ...[
                if (i > 0) const SizedBox(width: 6),
                Expanded(child: _modeCell(modes[i])),
              ],
            ],
          ),
          if (caps.chips.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 5,
              runSpacing: 5,
              children: [
                for (final c in caps.chips)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                    decoration: BoxDecoration(
                      color: SessionMode.accent(_viewMode).withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      c,
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w600,
                        color: SessionMode.accent(_viewMode),
                      ),
                    ),
                  ),
              ],
            ),
          ],
          if (_viewMode == SessionMode.tmux) ...[
            const SizedBox(height: 6),
            const Text(
              '镜像同步：可新建并启动 agent，或附着电脑已有 tmux，手机与电脑同屏',
              style: TextStyle(fontSize: 11, color: kFaint, height: 1.25),
            ),
          ],
        ],
      ),
    );
  }

  Widget _modeCell(String id) {
    final title = SessionMode.shortLabel(id);
    final icon = SessionMode.icon(id);
    final color = SessionMode.accent(id);
    final on = _viewMode == id;
    return Material(
      color: on ? color.withValues(alpha: 0.12) : kSurfaceHigh,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () => setState(() => _viewMode = id),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 4),
          child: Column(
            children: [
              Icon(icon, size: 18, color: on ? color : kMuted),
              const SizedBox(height: 4),
              Text(
                title,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: on ? FontWeight.w700 : FontWeight.w500,
                  color: on ? color : kText,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _accountPicker() => _labeled(
        '账号',
        _dropdownBox<String>(
          value: _accountHome,
          items: _accounts.map((a) => (a.$1, a.$2)).toList(),
          onChanged: (v) => setState(() => _accountHome = v ?? ''),
        ),
      );

  Widget _modelPicker() => _labeled(
        '模型',
        _dropdownBox<String>(
          value: _model,
          items: [
            ('', '默认'),
            ..._models.map((m) => (m, m)),
            (_customModel, '自定义…'),
          ],
          onChanged: (v) => setState(() => _model = v ?? ''),
        ),
      );

  List<Widget> _codexAdvanced() {
    return [
      _labeled(
        '沙盒 / 审批',
        _dropdownBox<String>(
          value: _sandbox,
          items: const [
            ('bypass', '完全放开 (--dangerously-bypass)'),
            ('workspace-write', '允许写工作区'),
            ('read-only', '只读沙盒'),
            ('default', '默认（跟随 config）'),
          ],
          onChanged: (v) => setState(() => _sandbox = v ?? 'bypass'),
        ),
      ),
      _labeled(
        '推理强度 (reasoning effort)',
        _dropdownBox<String>(
          value: _effort,
          items: _efforts
              .map((e) => (e, e.isEmpty ? '默认（跟随 profile）' : e))
              .toList(),
          onChanged: (v) => setState(() => _effort = v ?? ''),
        ),
      ),
      if (_providers.isNotEmpty)
        _labeled(
          'Provider（可选覆盖）',
          _dropdownBox<String?>(
            value: _providerKey,
            items: [
              (null, '默认（账号登录 / 不强制 Provider）'),
              ..._providers.map((p) => (p.$1, p.$2)),
            ],
            onChanged: (v) => setState(() => _providerKey = v),
          ),
        ),
    ];
  }

  // 统一的填充式下拉框（无浮动标签，标签由 _labeled 提供）
  Widget _dropdownBox<T>({
    required T value,
    required List<(T, String)> items,
    required ValueChanged<T?> onChanged,
  }) {
    return Container(
      height: 42,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: kSurfaceHigh,
        borderRadius: BorderRadius.circular(10),
      ),
      alignment: Alignment.center,
      child: DropdownButtonHideUnderline(
        child: DropdownButton<T>(
          isExpanded: true,
          isDense: true,
          borderRadius: BorderRadius.circular(10),
          style: _valueStyle.copyWith(color: kText),
          icon: const Icon(Icons.expand_more, color: kMuted, size: 18),
          value: value,
          items: items
              .map((e) => DropdownMenuItem<T>(
                    value: e.$1,
                    child: Text(e.$2,
                        maxLines: 1, overflow: TextOverflow.ellipsis),
                  ))
              .toList(),
          onChanged: onChanged,
        ),
      ),
    );
  }
}

/// 电脑目录浏览器：可视化选工作目录，不用手输路径。
class _DirBrowser extends StatefulWidget {
  final ApiClient client;
  final String? startPath;
  const _DirBrowser({required this.client, this.startPath});
  @override
  State<_DirBrowser> createState() => _DirBrowserState();
}

class _DirBrowserState extends State<_DirBrowser> {
  String _path = '';
  String? _parent;
  String? _home;
  List<Map> _dirs = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load(widget.startPath);
  }

  Future<void> _load(String? path) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final res = await widget.client.listDir(path);
    if (!mounted) return;
    if (res.ok && res.data is Map) {
      final d = res.data as Map;
      setState(() {
        _path = (d['path'] ?? '').toString();
        _parent = d['parent']?.toString();
        _home = d['home']?.toString();
        _dirs = ((d['dirs'] as List?) ?? []).cast<Map>();
        _loading = false;
      });
    } else {
      setState(() {
        _error = res.error ?? '读取失败';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final maxH = MediaQuery.of(context).size.height * 0.72;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxH),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 标题 + 当前路径
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 12, 6),
              child: Row(children: [
                const Icon(Icons.folder_open, size: 18, color: kAccent),
                const SizedBox(width: 8),
                const Text('选择工作目录',
                    style:
                        TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.home_outlined),
                  tooltip: '家目录',
                  onPressed: () => _load(_home),
                ),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              child: Text(_path.isEmpty ? '…' : _path,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: kMuted, fontSize: 12)),
            ),
            const SizedBox(height: 6),
            const Divider(height: 1),
            // 列表
            Flexible(
              child: _loading
                  ? const Padding(
                      padding: EdgeInsets.all(30),
                      child: Center(child: CircularProgressIndicator()))
                  : (_error != null
                      ? Padding(
                          padding: const EdgeInsets.all(24),
                          child: Center(
                              child: Text(_error!,
                                  style: const TextStyle(color: kExited))))
                      : ListView(
                          shrinkWrap: true,
                          children: [
                            if (_parent != null && _parent!.isNotEmpty)
                              ListTile(
                                dense: true,
                                leading: const Icon(Icons.arrow_upward, size: 20),
                                title: const Text('上级目录'),
                                onTap: () => _load(_parent),
                              ),
                            ..._dirs.map((d) => ListTile(
                                  dense: true,
                                  leading: const Icon(Icons.folder,
                                      size: 20, color: Color(0xFF5B8CFF)),
                                  title: Text((d['name'] ?? '').toString(),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis),
                                  trailing: const Icon(Icons.chevron_right,
                                      size: 18, color: kFaint),
                                  onTap: () => _load((d['path'] ?? '').toString()),
                                )),
                            if (_dirs.isEmpty)
                              const Padding(
                                padding: EdgeInsets.all(24),
                                child: Center(
                                    child: Text('此目录下没有子文件夹',
                                        style: TextStyle(color: kFaint))),
                              ),
                          ],
                        )),
            ),
            const Divider(height: 1),
            // 选择当前目录
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _path.isEmpty
                      ? null
                      : () => Navigator.pop(context, _path),
                  icon: const Icon(Icons.check, size: 18),
                  label: Text('选择此目录'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
