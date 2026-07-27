import 'dart:convert';
import 'package:http/http.dart' as http;

/// 统一返回结构：对应桌面端 { ok, data } / { ok:false, error }
class ApiResult {
  final bool ok;
  final dynamic data;
  final String? error;
  /// true = 传输层失败(服务器不可达/超时) → 应触发重连；
  /// false = 收到了服务器响应(即使是 ok:false 的业务错误，如会话不存在)。
  final bool connectionFailed;
  const ApiResult(this.ok, this.data, this.error,
      [this.connectionFailed = false]);
}

/// SSE 终端流的一帧事件。data 为增量输出；cursor 为已吐出的原始字节游标
/// （断线回退轮询时据此续读，避免重复/漏字）；exited 表示会话结束事件。
class TerminalStreamEvent {
  final String data;
  final int cursor;
  final bool exited;
  final int? exitCode;
  const TerminalStreamEvent({
    this.data = '',
    this.cursor = -1,
    this.exited = false,
    this.exitCode,
  });
}

/// EasyAIConfig 远程 API 客户端。指向桌面端开启的远程服务
/// (LAN: http://内网IP:端口，或 VPS 中转地址)，带 token 鉴权。
class ApiClient {
  String baseUrl; // 例如 http://192.168.1.10:8790
  String token;
  /// 复用 TCP（配合服务端 keep-alive），避免每次请求重握手。
  final http.Client _http = http.Client();

  ApiClient({required this.baseUrl, required this.token});

  void close() => _http.close();

  Uri _uri(String path, [Map<String, String>? query]) {
    var b = baseUrl.trim();
    if (b.endsWith('/')) b = b.substring(0, b.length - 1);
    final base = Uri.parse(b);
    final q = <String, String>{...?query, 'token': token};
    return base.replace(path: path, queryParameters: q);
  }

  Map<String, String> get _headers => {
        'x-remote-token': token,
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
      };

  Future<ApiResult> get(String path, {Map<String, String>? query}) async {
    try {
      final res = await _http
          .get(_uri(path, query), headers: _headers)
          .timeout(const Duration(seconds: 15));
      return _parse(res);
    } catch (e) {
      return ApiResult(false, null, _friendly(e), true);
    }
  }

  Future<ApiResult> post(String path, Map<String, dynamic> body) async {
    try {
      final res = await _http
          .post(_uri(path), headers: _headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 15));
      return _parse(res);
    } catch (e) {
      return ApiResult(false, null, _friendly(e), true);
    }
  }

  ApiResult _parse(http.Response res) {
    if (res.statusCode == 401) return const ApiResult(false, null, '未授权：token 不正确');
    if (res.statusCode == 403) return const ApiResult(false, null, '该接口不允许远程调用');
    try {
      final j = jsonDecode(res.body);
      if (j is Map && j['ok'] == true) return ApiResult(true, j['data'], null);
      final err = (j is Map ? j['error']?.toString() : null) ?? 'HTTP ${res.statusCode}';
      return ApiResult(false, null, err);
    } catch (_) {
      return ApiResult(false, null, 'HTTP ${res.statusCode}');
    }
  }

  String _friendly(Object e) {
    final s = e.toString();
    if (s.contains('TimeoutException')) return '连接超时，确认在同一 WiFi / 服务已开启';
    if (s.contains('SocketException')) return '无法连接，检查地址与端口';
    return s;
  }

  // ── 终端相关 ────────────────────────────────────────────────
  Future<ApiResult> listSessions() => get('/api/terminal/list');

  Future<ApiResult> readSession(String sessionId, int cursor) =>
      get('/api/terminal/read', query: {'sessionId': sessionId, 'cursor': '$cursor'});

  /// 打开 SSE 实时流：GET /api/terminal/stream，逐帧 yield 终端增量输出。
  /// 只解析 `data:` 行的 JSON；`:` 心跳注释与 `event:`/`retry:` 行忽略。
  /// 会话退出（exitCode 帧）后流自然结束；网络异常以 stream error 抛出，
  /// 交给调用方重连或回退轮询。
  Stream<TerminalStreamEvent> streamSession(String sessionId, int cursor) async* {
    final uri = _uri('/api/terminal/stream', {
      'sessionId': sessionId,
      'cursor': '$cursor',
    });
    // SSE 长连接单独 Client，避免占用普通 keep-alive 池
    final client = http.Client();
    try {
      final req = http.Request('GET', uri);
      req.headers['x-remote-token'] = token;
      req.headers['Accept'] = 'text/event-stream';
      final res = await client.send(req).timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) {
        throw http.ClientException('stream HTTP ${res.statusCode}', uri);
      }
      final lines =
          res.stream.transform(utf8.decoder).transform(const LineSplitter());
      await for (final line in lines) {
        if (line.isEmpty || line.startsWith(':')) continue; // 空行 / 心跳注释
        if (!line.startsWith('data:')) continue; // event: / retry: 等忽略
        final raw = line.substring(5).trim();
        if (raw.isEmpty) continue;
        Map<String, dynamic>? j;
        try {
          final decoded = jsonDecode(raw);
          if (decoded is Map<String, dynamic>) j = decoded;
        } catch (_) {
          continue; // 非 JSON data 行，跳过
        }
        if (j == null) continue;
        if (j.containsKey('exitCode')) {
          yield TerminalStreamEvent(
            exited: true,
            exitCode: (j['exitCode'] as num?)?.toInt(),
          );
          return; // 会话已退出，结束流
        }
        final data = j['data'];
        if (data is String) {
          final c = j['cursor'];
          yield TerminalStreamEvent(
            data: data,
            cursor: c is num ? c.toInt() : -1,
          );
        }
      }
    } finally {
      client.close();
    }
  }

  Future<ApiResult> writeSession(
    String sessionId,
    String data, {
    bool submit = false,
  }) =>
      post('/api/terminal/write', {
        'sessionId': sessionId,
        'data': data,
        if (submit) 'submit': true,
      });

  /// 结构化 timeline（codex JSONL 解析）：增量返回消息 + 新行号 cursor。
  Future<ApiResult> timeline(String sessionId, int cursor) =>
      get('/api/terminal/timeline',
          query: {'sessionId': sessionId, 'cursor': '$cursor'});

  /// 上传图片/文件到桌面 uploads/，返回 { path } 绝对路径（可在会话里引用）。
  /// 单独走 60s 超时（图片体积大于普通请求）。
  Future<ApiResult> uploadImage(String filename, String dataBase64) async {
    try {
      final res = await _http
          .post(
            _uri('/api/terminal/upload'),
            headers: _headers,
            body: jsonEncode({'filename': filename, 'dataBase64': dataBase64}),
          )
          .timeout(const Duration(seconds: 60));
      return _parse(res);
    } catch (e) {
      return ApiResult(false, null, _friendly(e), true);
    }
  }

  Future<ApiResult> resizeSession(String sessionId, int cols, int rows) =>
      post('/api/terminal/resize', {'sessionId': sessionId, 'cols': cols, 'rows': rows});

  Future<ApiResult> createSession({
    required String tool,
    required String program,
    required List<String> args,
    required String cwd,
    required String title,
    Map<String, String>? env,
    int cols = 100,
    int rows = 30,
  }) =>
      post('/api/terminal/create', {
        'tool': tool,
        'program': program,
        'args': args,
        'cwd': cwd,
        'title': title,
        'commandPreview': ([program, ...args]).join(' '),
        'cols': cols,
        'rows': rows,
        if (env != null && env.isNotEmpty) 'env': env,
      });

  // ── Codex app-server 桥（低延迟 Timeline）────────────────────
  Future<ApiResult> codexThreadStart({
    required String cwd,
    String? model,
    String? title,
    Map<String, String>? env,
    String? resumeThreadId,
  }) =>
      post('/api/codex/thread/start', {
        'cwd': cwd,
        if (model != null && model.isNotEmpty) 'model': model,
        if (title != null && title.isNotEmpty) 'title': title,
        if (env != null && env.isNotEmpty) 'env': env,
        if (resumeThreadId != null && resumeThreadId.isNotEmpty)
          'resumeThreadId': resumeThreadId,
      });

  Future<ApiResult> codexThreadResume(String sessionId, {String? threadId}) =>
      post('/api/codex/thread/resume', {
        'sessionId': sessionId,
        if (threadId != null && threadId.isNotEmpty) 'threadId': threadId,
      });

  Future<ApiResult> codexTurnStart(String sessionId, String text,
          {String? clientId}) =>
      post('/api/codex/turn/start', {
        'sessionId': sessionId,
        'text': text,
        if (clientId != null && clientId.isNotEmpty) 'clientId': clientId,
      });

  Future<ApiResult> codexTurnInterrupt(String sessionId) =>
      post('/api/codex/turn/interrupt', {'sessionId': sessionId});

  Future<ApiResult> codexApproval(String sessionId, String requestId, String decision) =>
      post('/api/codex/approval', {
        'sessionId': sessionId,
        'requestId': requestId,
        'decision': decision,
      });

  Future<ApiResult> codexModels(String sessionId) =>
      get('/api/codex/models', query: {'sessionId': sessionId});

  Future<ApiResult> codexThreadSettings(
    String sessionId, {
    String? model,
    String? reasoningEffort,
  }) =>
      post('/api/codex/thread/settings', {
        'sessionId': sessionId,
        if (model != null) 'model': model,
        if (reasoningEffort != null) 'reasoningEffort': reasoningEffort,
      });

  Future<ApiResult> codexRateLimits(String sessionId) =>
      get('/api/codex/rate-limits', query: {'sessionId': sessionId});

  Future<ApiResult> codexSessionGet(String sessionId) =>
      get('/api/codex/session', query: {'sessionId': sessionId});

  /// app-server 事件 SSE：通知 + 审批请求。
  Stream<Map<String, dynamic>> streamCodexEvents(String sessionId,
      {int after = 0}) async* {
    yield* _streamBridgeEvents('/api/codex/events', sessionId, after: after);
  }

  Stream<Map<String, dynamic>> streamClaudeEvents(String sessionId,
      {int after = 0}) async* {
    yield* _streamBridgeEvents('/api/claude/events', sessionId, after: after);
  }

  /// 列表级推送：agent/status · session/upsert · session/remove · hook/status · snapshot
  Stream<Map<String, dynamic>> streamSessions({int after = 0}) async* {
    final q = <String, String>{};
    if (after > 0) q['after'] = '$after';
    final uri = _uri('/api/sessions/stream', q.isEmpty ? null : q);
    final client = http.Client();
    try {
      final req = http.Request('GET', uri);
      req.headers['x-remote-token'] = token;
      req.headers['Accept'] = 'text/event-stream';
      final res = await client.send(req).timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) {
        throw http.ClientException('sessions stream HTTP ${res.statusCode}', uri);
      }
      final lines =
          res.stream.transform(utf8.decoder).transform(const LineSplitter());
      await for (final line in lines) {
        if (line.isEmpty || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        final raw = line.substring(5).trim();
        if (raw.isEmpty) continue;
        try {
          final decoded = jsonDecode(raw);
          if (decoded is Map<String, dynamic>) yield decoded;
        } catch (_) {}
      }
    } finally {
      client.close();
    }
  }

  // ── Claude print-bridge（低延迟 Timeline）────────────────────
  Future<ApiResult> claudeThreadStart({
    required String cwd,
    String? model,
    String? title,
    Map<String, String>? env,
    String? resumeThreadId,
  }) =>
      post('/api/claude/thread/start', {
        'cwd': cwd,
        if (model != null && model.isNotEmpty) 'model': model,
        if (title != null && title.isNotEmpty) 'title': title,
        if (env != null && env.isNotEmpty) 'env': env,
        if (resumeThreadId != null && resumeThreadId.isNotEmpty)
          'resumeThreadId': resumeThreadId,
      });

  Future<ApiResult> claudeTurnStart(String sessionId, String text,
          {String? clientId}) =>
      post('/api/claude/turn/start', {
        'sessionId': sessionId,
        'text': text,
        if (clientId != null && clientId.isNotEmpty) 'clientId': clientId,
      });

  Future<ApiResult> claudeTurnInterrupt(String sessionId) =>
      post('/api/claude/turn/interrupt', {'sessionId': sessionId});

  Future<ApiResult> claudeApproval(
          String sessionId, String requestId, String decision) =>
      post('/api/claude/approval', {
        'sessionId': sessionId,
        'requestId': requestId,
        'decision': decision,
      });

  Future<ApiResult> claudeThreadSettings(String sessionId, {String? model}) =>
      post('/api/claude/thread/settings', {
        'sessionId': sessionId,
        if (model != null) 'model': model,
      });

  Future<ApiResult> claudeSessionGet(String sessionId) =>
      get('/api/claude/session', query: {'sessionId': sessionId});

  Future<ApiResult> claudeModels(String sessionId) =>
      get('/api/claude/models', query: {'sessionId': sessionId});

  Future<ApiResult> claudeRateLimits(String sessionId) =>
      get('/api/claude/rate-limits', query: {'sessionId': sessionId});

  // ── tmux 镜像 ───────────────────────────────────────────────
  Future<ApiResult> tmuxList() => get('/api/tmux/list');

  Future<ApiResult> tmuxAttach({
    required String name,
    String tool = 'shell',
    String? cwd,
  }) =>
      post('/api/tmux/attach', {
        'name': name,
        'tool': tool,
        'origin': 'phone',
        if (cwd != null && cwd.isNotEmpty) 'cwd': cwd,
      });

  /// 新建 tmux 会话并附着；[launchAgent] 为 true 时在窗内启动 codex/claude。
  Future<ApiResult> tmuxCreate({
    String? name,
    String tool = 'codex',
    String? cwd,
    bool launchAgent = true,
  }) =>
      post('/api/tmux/create', {
        'tool': tool,
        'origin': 'phone',
        'launchAgent': launchAgent,
        if (name != null && name.isNotEmpty) 'name': name,
        if (cwd != null && cwd.isNotEmpty) 'cwd': cwd,
      });

  // ── Agent Hook 雷达 ─────────────────────────────────────────
  Future<ApiResult> agentHooksStatus() => get('/api/agent-hooks/status');
  Future<ApiResult> agentHooksOn() => post('/api/agent-hooks/on', {});
  Future<ApiResult> agentHooksOff() => post('/api/agent-hooks/off', {});
  Future<ApiResult> agentHooksSessions() => get('/api/agent-hooks/sessions');

  /// 按 tool 选择 bridge API（codex app-server / claude print-bridge）。
  bool _isClaudeTool(String tool) =>
      tool == 'claude' || tool == 'claudecode';

  Future<ApiResult> bridgeTurnStart(String tool, String sessionId, String text,
          {String? clientId}) =>
      _isClaudeTool(tool)
          ? claudeTurnStart(sessionId, text, clientId: clientId)
          : codexTurnStart(sessionId, text, clientId: clientId);

  Future<ApiResult> bridgeTurnInterrupt(String tool, String sessionId) =>
      _isClaudeTool(tool)
          ? claudeTurnInterrupt(sessionId)
          : codexTurnInterrupt(sessionId);

  Future<ApiResult> bridgeApproval(
          String tool, String sessionId, String requestId, String decision) =>
      _isClaudeTool(tool)
          ? claudeApproval(sessionId, requestId, decision)
          : codexApproval(sessionId, requestId, decision);

  Future<ApiResult> bridgeSessionGet(String tool, String sessionId) =>
      _isClaudeTool(tool)
          ? claudeSessionGet(sessionId)
          : codexSessionGet(sessionId);

  Stream<Map<String, dynamic>> streamBridgeEvents(
          String tool, String sessionId,
          {int after = 0}) =>
      _isClaudeTool(tool)
          ? streamClaudeEvents(sessionId, after: after)
          : streamCodexEvents(sessionId, after: after);

  Stream<Map<String, dynamic>> _streamBridgeEvents(
      String path, String sessionId,
      {int after = 0}) async* {
    final q = <String, String>{'sessionId': sessionId};
    if (after > 0) q['after'] = '$after';
    final uri = _uri(path, q);
    final client = http.Client();
    try {
      final req = http.Request('GET', uri);
      req.headers['x-remote-token'] = token;
      req.headers['Accept'] = 'text/event-stream';
      final res = await client.send(req).timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) {
        throw http.ClientException('bridge events HTTP ${res.statusCode}', uri);
      }
      final lines =
          res.stream.transform(utf8.decoder).transform(const LineSplitter());
      await for (final line in lines) {
        if (line.isEmpty || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        final raw = line.substring(5).trim();
        if (raw.isEmpty) continue;
        try {
          final decoded = jsonDecode(raw);
          if (decoded is Map<String, dynamic>) yield decoded;
        } catch (_) {}
      }
    } finally {
      client.close();
    }
  }

  // ── 只读辅助接口（远程白名单内，均为可选/防御式调用）──────────────
  /// 桌面端整体状态：含 codex providers 与 summary（新建会话可选预填 provider）。
  Future<ApiResult> getState() => get('/api/state');

  /// Codex 官方多账号（OAuth profiles）：{ active, profiles:[{id,name,email,codexHome}] }。
  /// 手机端按会话切账号 → 传 env CODEX_HOME。
  Future<ApiResult> getCodexAccounts() => get('/api/codex/oauth/profiles');

  /// Claude Code 多账号（OAuth profiles）：{ active, profiles:[{id,name,email,configDir}] }。
  /// 手机端按会话切账号 → 传 env CLAUDE_CONFIG_DIR（不泄露任何密钥）。
  Future<ApiResult> getClaudeAccounts() => get('/api/claudecode/oauth/profiles');

  /// 历史会话清单（codex / claude 等）。默认只取 codex + claudecode。
  Future<ApiResult> getSessionsInventory({
    int limit = 60,
    List<String> tools = const ['codex', 'claudecode'],
  }) =>
      get('/api/sessions/inventory', query: {
        'limit': '$limit',
        if (tools.isNotEmpty) 'tools': tools.join(','),
      });

  /// 轻量连通性探测：复用受白名单允许的 list 接口。
  Future<ApiResult> ping() => listSessions();

  /// 列出电脑上某目录的子目录(可视化选工作目录)。path 为空则从家目录开始。
  /// 返回 { path, parent, home, dirs:[{name,path}] }。
  Future<ApiResult> listDir([String? path]) =>
      get('/api/terminal/list-dir', query: {if (path != null) 'path': path});

  /// 读取 codex 当前 TUI 选择器(模型/推理)的解析结果。
  /// 返回 { stage:"model"|"reasoning"|"none", title, model, options:[{index,label,detail,current,default}] }
  /// 手机端据此做原生选择器，选中后 writeSession 发送对应 index 数字即可切换。
  Future<ApiResult> codexPicker(String sessionId) =>
      get('/api/terminal/codex-picker', query: {'sessionId': sessionId});

  /// 会话 token/上下文用量快照：{ tokens:{total,contextWindow,...} } 或 tokens:null。
  Future<ApiResult> tokenSnapshot(String sessionId) =>
      get('/api/terminal/token-snapshot', query: {'sessionId': sessionId});
}
