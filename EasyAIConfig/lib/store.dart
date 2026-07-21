import 'dart:convert';
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import 'models/server.dart';

/// 多服务持久化 + 会话本地个性化（自定义标题 / 置顶 / 隐藏）+ 最近工作目录。
///
/// 向后兼容：首次运行会把旧的单服务键（server_url / server_token）迁移进列表。
class Store {
  // 旧键（单服务）——仅用于一次性迁移，保留不删以防回退。
  static const _kOldUrl = 'server_url';
  static const _kOldToken = 'server_token';

  // 新键（多服务）
  static const _kServers = 'servers_v2';
  static const _kCurrentId = 'current_server_id';

  static final _rand = Random();

  static String _newId() {
    final ts = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
    final r = _rand.nextInt(1 << 32).toRadixString(36);
    return 's_${ts}_$r';
  }

  /// 迁移旧单服务配置到列表（只执行一次：以 servers_v2 键是否存在为准）。
  static Future<void> _migrate(SharedPreferences p) async {
    if (p.containsKey(_kServers)) return;
    final u = p.getString(_kOldUrl);
    final t = p.getString(_kOldToken);
    final list = <ServerConfig>[];
    if (u != null && t != null && u.isNotEmpty && t.isNotEmpty) {
      final s = ServerConfig(
        id: _newId(),
        name: ServerConfig.defaultName(u),
        baseUrl: u,
        token: t,
      );
      list.add(s);
      await p.setString(_kCurrentId, s.id);
    }
    await _writeList(p, list);
  }

  static Future<void> _writeList(
      SharedPreferences p, List<ServerConfig> list) async {
    await p.setString(
        _kServers, jsonEncode(list.map((e) => e.toJson()).toList()));
  }

  static List<ServerConfig> _readList(SharedPreferences p) {
    final raw = p.getString(_kServers);
    if (raw == null || raw.isEmpty) return [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return [];
      return decoded
          .map(ServerConfig.fromJson)
          .whereType<ServerConfig>()
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// 所有已保存的服务。
  static Future<List<ServerConfig>> listServers() async {
    final p = await SharedPreferences.getInstance();
    await _migrate(p);
    return _readList(p);
  }

  /// 当前选中服务的 id（可能为空）。
  static Future<String?> currentServerId() async {
    final p = await SharedPreferences.getInstance();
    await _migrate(p);
    return p.getString(_kCurrentId);
  }

  /// 当前选中的服务；若选中项缺失则退回列表第一个。
  static Future<ServerConfig?> currentServer() async {
    final p = await SharedPreferences.getInstance();
    await _migrate(p);
    final list = _readList(p);
    if (list.isEmpty) return null;
    final id = p.getString(_kCurrentId);
    final found = list.where((s) => s.id == id).toList();
    if (found.isNotEmpty) return found.first;
    // 选中项失效：默认取第一个并回写
    await p.setString(_kCurrentId, list.first.id);
    return list.first;
  }

  /// 选中某个服务。
  static Future<void> selectServer(String id) async {
    final p = await SharedPreferences.getInstance();
    await _migrate(p);
    await p.setString(_kCurrentId, id);
  }

  /// 配对入口：按 baseUrl 归并——已存在同地址则更新其 token（并可改名），
  /// 否则新增。无论如何都把它设为当前服务并返回。
  static Future<ServerConfig> upsertFromPairing(
    String baseUrl,
    String token, {
    String? name,
  }) async {
    final p = await SharedPreferences.getInstance();
    await _migrate(p);
    final list = _readList(p);
    final idx = list.indexWhere((s) => s.baseUrl == baseUrl);
    ServerConfig result;
    if (idx >= 0) {
      list[idx].token = token;
      if (name != null && name.trim().isNotEmpty) list[idx].name = name.trim();
      result = list[idx];
    } else {
      result = ServerConfig(
        id: _newId(),
        name: (name != null && name.trim().isNotEmpty)
            ? name.trim()
            : ServerConfig.defaultName(baseUrl),
        baseUrl: baseUrl,
        token: token,
      );
      list.add(result);
    }
    await _writeList(p, list);
    await p.setString(_kCurrentId, result.id);
    return result;
  }

  /// 新增一个空白服务（手动或扫码前置），返回其 id。
  static Future<ServerConfig> addServer({
    required String name,
    required String baseUrl,
    required String token,
    bool select = true,
  }) async {
    final p = await SharedPreferences.getInstance();
    await _migrate(p);
    final list = _readList(p);
    final s = ServerConfig(
      id: _newId(),
      name: name.trim().isEmpty ? ServerConfig.defaultName(baseUrl) : name.trim(),
      baseUrl: baseUrl,
      token: token,
    );
    list.add(s);
    await _writeList(p, list);
    if (select) await p.setString(_kCurrentId, s.id);
    return s;
  }

  /// 更新已有服务（按 id 匹配）。
  static Future<void> updateServer(ServerConfig server) async {
    final p = await SharedPreferences.getInstance();
    await _migrate(p);
    final list = _readList(p);
    final idx = list.indexWhere((s) => s.id == server.id);
    if (idx >= 0) {
      list[idx] = server;
      await _writeList(p, list);
    }
  }

  /// 删除服务；若删掉的是当前项，则自动切到剩余第一个。
  static Future<void> removeServer(String id) async {
    final p = await SharedPreferences.getInstance();
    await _migrate(p);
    final list = _readList(p)..removeWhere((s) => s.id == id);
    await _writeList(p, list);
    if (p.getString(_kCurrentId) == id) {
      if (list.isNotEmpty) {
        await p.setString(_kCurrentId, list.first.id);
      } else {
        await p.remove(_kCurrentId);
      }
    }
  }

  /// 清空所有数据（解除全部配对 + 本地个性化）。
  static Future<void> clearAll() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_kServers);
    await p.remove(_kCurrentId);
    await p.remove(_kOldUrl);
    await p.remove(_kOldToken);
    await SessionPrefs.clearAll();
    await RecentCwds.clear();
  }
}

/// 会话的本地个性化：自定义标题、置顶、隐藏。键以 serverId 隔离。
class SessionPrefs {
  static const _kTitles = 'session_titles_v1'; // { "serverId::sessionId": title }
  static const _kPins = 'session_pins_v1'; // [ "serverId::sessionId" ]
  static const _kHidden = 'session_hidden_v1'; // [ "serverId::sessionId" ]

  static String key(String serverId, String sessionId) =>
      '$serverId::$sessionId';

  static Future<Map<String, String>> titles() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_kTitles);
    if (raw == null || raw.isEmpty) return {};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        return decoded.map((k, v) => MapEntry(k.toString(), v.toString()));
      }
    } catch (_) {}
    return {};
  }

  static Future<void> setTitle(
      String serverId, String sessionId, String title) async {
    final p = await SharedPreferences.getInstance();
    final map = await titles();
    final k = key(serverId, sessionId);
    if (title.trim().isEmpty) {
      map.remove(k);
    } else {
      map[k] = title.trim();
    }
    await p.setString(_kTitles, jsonEncode(map));
  }

  static Future<Set<String>> _set(String prefKey) async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(prefKey);
    if (raw == null || raw.isEmpty) return {};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) return decoded.map((e) => e.toString()).toSet();
    } catch (_) {}
    return {};
  }

  static Future<void> _writeSet(String prefKey, Set<String> value) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(prefKey, jsonEncode(value.toList()));
  }

  static Future<Set<String>> pinned() => _set(_kPins);
  static Future<Set<String>> hidden() => _set(_kHidden);

  static Future<void> togglePin(String serverId, String sessionId) async {
    final k = key(serverId, sessionId);
    final s = await pinned();
    s.contains(k) ? s.remove(k) : s.add(k);
    await _writeSet(_kPins, s);
  }

  static Future<void> setHidden(
      String serverId, String sessionId, bool hide) async {
    final k = key(serverId, sessionId);
    final s = await hidden();
    hide ? s.add(k) : s.remove(k);
    await _writeSet(_kHidden, s);
  }

  static Future<void> clearAll() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_kTitles);
    await p.remove(_kPins);
    await p.remove(_kHidden);
  }
}

/// 新建会话时最近使用过的工作目录（全局共享，最多留 8 条）。
class RecentCwds {
  static const _kKey = 'recent_cwds_v1';
  static const _max = 8;

  static Future<List<String>> list() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_kKey);
    if (raw == null || raw.isEmpty) return [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) return decoded.map((e) => e.toString()).toList();
    } catch (_) {}
    return [];
  }

  static Future<void> add(String cwd) async {
    final v = cwd.trim();
    if (v.isEmpty) return;
    final p = await SharedPreferences.getInstance();
    final items = await list();
    items.remove(v);
    items.insert(0, v);
    while (items.length > _max) {
      items.removeLast();
    }
    await p.setString(_kKey, jsonEncode(items));
  }

  static Future<void> clear() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_kKey);
  }
}

/// 解析配对输入：支持二维码/链接 http://ip:port/#t=TOKEN，
/// 也支持 ?token= 形式，或直接把 URL 与 token 分开填写。
/// 返回 (baseUrl, token)。
(String, String)? parsePairing(String input) {
  final text = input.trim();
  if (text.isEmpty) return null;
  try {
    final u = Uri.parse(text);
    if (u.scheme.isEmpty || u.host.isEmpty) return null;
    var token = '';
    if (u.fragment.isNotEmpty) {
      final f = Uri.splitQueryString(u.fragment);
      token = f['t'] ?? f['token'] ?? '';
    }
    if (token.isEmpty) {
      token = u.queryParameters['token'] ?? u.queryParameters['t'] ?? '';
    }
    if (token.isEmpty) return null;
    final port = u.hasPort ? ':${u.port}' : '';
    final base = '${u.scheme}://${u.host}$port';
    return (base, token);
  } catch (_) {
    return null;
  }
}
