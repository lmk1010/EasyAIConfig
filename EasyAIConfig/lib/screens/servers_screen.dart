import 'package:flutter/material.dart';

import '../api.dart';
import '../models/server.dart';
import '../store.dart';
import '../theme.dart';
import 'pair_screen.dart';

/// 服务管理：增删改查 + 切换当前服务。点某个服务即切换并返回。
class ServersScreen extends StatefulWidget {
  final String? currentId;
  const ServersScreen({super.key, this.currentId});
  @override
  State<ServersScreen> createState() => _ServersScreenState();
}

class _ServersScreenState extends State<ServersScreen> {
  List<ServerConfig> _servers = [];
  String? _currentId;
  bool _loading = true;
  final Map<String, bool?> _health = {}; // id -> null(未测)/true/false

  @override
  void initState() {
    super.initState();
    _currentId = widget.currentId;
    _load();
  }

  Future<void> _load() async {
    final list = await Store.listServers();
    final cur = await Store.currentServerId();
    if (!mounted) return;
    setState(() {
      _servers = list;
      _currentId = cur;
      _loading = false;
    });
  }

  Future<void> _addServer() async {
    final added = await Navigator.push<ServerConfig>(
      context,
      MaterialPageRoute(builder: (_) => const PairScreen(popOnSuccess: true)),
    );
    if (added != null) await _load();
  }

  Future<void> _switchTo(ServerConfig s) async {
    await Store.selectServer(s.id);
    if (!mounted) return;
    Navigator.pop<ServerConfig>(context, s);
  }

  Future<void> _rename(ServerConfig s) async {
    final ctrl = TextEditingController(text: s.name);
    final name = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('重命名服务'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(border: OutlineInputBorder()),
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
    await Store.updateServer(s.copyWith(name: name));
    await _load();
  }

  Future<void> _delete(ServerConfig s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('删除服务'),
        content: Text('确定删除「${s.name}」？该操作不可撤销。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: kExited),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await Store.removeServer(s.id);
    await _load();
  }

  Future<void> _test(ServerConfig s) async {
    setState(() => _health[s.id] = null);
    final client = ApiClient(baseUrl: s.baseUrl, token: s.token);
    final res = await client.ping();
    if (!mounted) return;
    setState(() => _health[s.id] = res.ok);
    if (!res.ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('「${s.name}」连接失败：${res.error ?? '未知'}')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('服务管理')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _addServer,
        icon: const Icon(Icons.add),
        label: const Text('添加服务'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : (_servers.isEmpty
              ? _empty()
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 96),
                  itemCount: _servers.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 10),
                  itemBuilder: (_, i) => _tile(_servers[i]),
                )),
    );
  }

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.dns_outlined, size: 48, color: kFaint),
              const SizedBox(height: 12),
              const Text('还没有服务，点下方「添加服务」配对',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: kFaint)),
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: _addServer,
                icon: const Icon(Icons.qr_code_scanner),
                label: const Text('扫码/手动添加'),
              ),
            ],
          ),
        ),
      );

  Widget _tile(ServerConfig s) {
    final isCurrent = s.id == _currentId;
    final health = _health[s.id];
    return Material(
      color: Theme.of(context).colorScheme.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => _switchTo(s),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: kAccent.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(isCurrent ? Icons.check_circle : Icons.dns,
                    color: kAccent, size: 22),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            s.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontWeight: FontWeight.w600, fontSize: 15),
                          ),
                        ),
                        if (isCurrent) ...[
                          const SizedBox(width: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 8, vertical: 2),
                            decoration: BoxDecoration(
                              color: kAccent.withValues(alpha: 0.18),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: const Text('当前',
                                style: TextStyle(
                                    fontSize: 11, color: kAccent)),
                          ),
                        ],
                        if (health != null) ...[
                          const SizedBox(width: 8),
                          Icon(
                            health ? Icons.check_circle : Icons.error,
                            size: 15,
                            color: health ? kRunning : kExited,
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      s.baseUrl,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style:
                          const TextStyle(color: kMuted, fontSize: 12),
                    ),
                  ],
                ),
              ),
              PopupMenuButton<String>(
                onSelected: (v) {
                  switch (v) {
                    case 'test':
                      _test(s);
                      break;
                    case 'rename':
                      _rename(s);
                      break;
                    case 'delete':
                      _delete(s);
                      break;
                  }
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'test', child: Text('测试连接')),
                  PopupMenuItem(value: 'rename', child: Text('重命名')),
                  PopupMenuItem(value: 'delete', child: Text('删除')),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
