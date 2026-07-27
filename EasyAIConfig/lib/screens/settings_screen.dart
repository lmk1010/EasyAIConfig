import 'dart:io';

import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../api.dart';
import '../apk_updater.dart';
import '../settings.dart';
import '../store.dart';
import '../theme.dart';
import 'pair_screen.dart';

/// 设置页：主题、终端字号、常亮、震动、Hook/通知、清除数据、关于 / APK 更新。
class SettingsScreen extends StatefulWidget {
  final ApiClient? client;
  const SettingsScreen({super.key, this.client});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  String _versionLabel = '…';
  bool _checking = false;
  bool _downloading = false;
  double? _progress;
  bool _hooksBusy = false;
  String? _hooksHint;

  @override
  void initState() {
    super.initState();
    _loadVersion();
    _refreshHooksStatus();
  }

  Future<void> _refreshHooksStatus() async {
    final c = widget.client;
    if (c == null) return;
    try {
      final res = await c.agentHooksStatus();
      if (!mounted || !res.ok || res.data is! Map) return;
      final on = res.data['enabled'] == true;
      final port = res.data['port'];
      final trust = (res.data['trustHint'] ?? '').toString().trim();
      setState(() {
        if (!on) {
          _hooksHint = '桌面 Hook 雷达未开启';
        } else if (trust.isNotEmpty) {
          _hooksHint = trust;
        } else {
          _hooksHint =
              '桌面已开启${port is num && port > 0 ? ' · 端口 $port' : ''}';
        }
      });
    } catch (_) {}
  }

  Future<void> _setHooks(bool value) async {
    final s = AppSettings.instance;
    await s.setAgentHooksEnabled(value);
    final c = widget.client;
    if (c == null) return;
    setState(() => _hooksBusy = true);
    try {
      final res = value ? await c.agentHooksOn() : await c.agentHooksOff();
      if (!mounted) return;
      if (!res.ok) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(res.error ?? '同步 Hook 失败')),
        );
      }
      await _refreshHooksStatus();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$e')),
      );
    } finally {
      if (mounted) setState(() => _hooksBusy = false);
    }
  }

  Future<void> _loadVersion() async {
    try {
      final info = await PackageInfo.fromPlatform();
      if (!mounted) return;
      setState(() => _versionLabel = '${info.version} (${info.buildNumber})');
    } catch (_) {
      if (!mounted) return;
      setState(() => _versionLabel = '未知');
    }
  }

  Future<void> _checkUpdate() async {
    if (!Platform.isAndroid) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('仅 Android APK 支持应用内更新')),
      );
      return;
    }
    setState(() {
      _checking = true;
      _progress = null;
    });
    try {
      final update = await checkApkUpdate();
      if (!mounted) return;
      if (update == null) return;
      if (!update.hasUpdate) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('已是最新 ${update.currentVersion}')),
        );
        return;
      }
      final go = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
          title: Text('发现新版本 ${update.latestVersion}'),
          content: Text(
            '当前 ${update.currentVersion}\n\n'
            '将从 R2 下载 APK 并打开系统安装器。'
            '${update.notes.trim().isEmpty ? '' : '\n\n${update.notes}'}',
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('稍后')),
            FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('下载更新')),
          ],
        ),
      );
      if (go != true || !mounted) return;
      setState(() {
        _downloading = true;
        _progress = 0;
      });
      final file = await downloadApk(
        update,
        onProgress: (recv, total) {
          if (!mounted) return;
          setState(() {
            _progress = total != null && total > 0 ? recv / total : null;
          });
        },
      );
      if (!mounted) return;
      await installApkFile(file);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$e')),
      );
    } finally {
      if (mounted) {
        setState(() {
          _checking = false;
          _downloading = false;
          _progress = null;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppSettings.instance;
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          _section('终端'),
          ValueListenableBuilder<double>(
            valueListenable: s.terminalFontSize,
            builder: (_, size, __) => Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Text('字号', style: TextStyle(fontSize: 14)),
                      const Spacer(),
                      Text('${size.toStringAsFixed(0)} pt',
                          style: const TextStyle(color: kMuted)),
                    ],
                  ),
                  Slider(
                    min: AppSettings.minFont,
                    max: AppSettings.maxFont,
                    divisions:
                        (AppSettings.maxFont - AppSettings.minFont).round(),
                    value: size,
                    label: size.toStringAsFixed(0),
                    onChanged: (v) => s.setTerminalFontSize(v),
                  ),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: kSurface,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: kLine),
                    ),
                    child: Text(
                      r'$ codex --model gpt-5  # 预览',
                      style: TextStyle(
                        fontFamily: 'monospace',
                        fontSize: size,
                        color: kText,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          ValueListenableBuilder<bool>(
            valueListenable: s.keepAwake,
            builder: (_, v, __) => SwitchListTile(
              title: const Text('终端内保持屏幕常亮'),
              subtitle: const Text('查看 agent 输出时不熄屏'),
              value: v,
              onChanged: s.setKeepAwake,
            ),
          ),
          ValueListenableBuilder<bool>(
            valueListenable: s.haptics,
            builder: (_, v, __) => SwitchListTile(
              title: const Text('快捷键震动反馈'),
              value: v,
              onChanged: s.setHaptics,
            ),
          ),
          const Divider(height: 1),
          _section('远程雷达'),
          ValueListenableBuilder<bool>(
            valueListenable: s.agentHooksEnabled,
            builder: (_, v, __) => SwitchListTile(
              title: const Text('Agent Hook 雷达'),
              subtitle: Text(
                _hooksHint ??
                    (widget.client == null
                        ? '打开会话页后可同步到桌面'
                        : '电脑原生 TUI 的「等你」状态叠加到会话列表'),
              ),
              value: v,
              onChanged: _hooksBusy ? null : _setHooks,
            ),
          ),
          ValueListenableBuilder<bool>(
            valueListenable: s.agentNotifyEnabled,
            builder: (_, v, __) => SwitchListTile(
              title: const Text('等你 / 完成通知'),
              subtitle: const Text('状态变化时弹出本地通知'),
              value: v,
              onChanged: s.setAgentNotifyEnabled,
            ),
          ),
          const Divider(height: 1),
          _section('数据'),
          ListTile(
            leading: const Icon(Icons.delete_forever, color: kExited),
            title: const Text('清除全部数据并解除配对'),
            subtitle: const Text('删除所有服务、自定义标题与偏好'),
            onTap: () => _confirmClear(context),
          ),
          const Divider(height: 1),
          _section('关于'),
          const ListTile(
            leading: Icon(Icons.hub_rounded, color: kAccent),
            title: Text('Easy AI Config'),
            subtitle: Text('远程操作电脑上的 Codex / Claude Code'),
          ),
          ListTile(
            leading: const Icon(Icons.info_outline),
            title: const Text('版本'),
            subtitle: Text(_versionLabel),
          ),
          ListTile(
            leading: _downloading || _checking
                ? const SizedBox(
                    width: 24,
                    height: 24,
                    child: Padding(
                      padding: EdgeInsets.all(2),
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : const Icon(Icons.system_update_alt),
            title: Text(_downloading
                ? '正在下载更新…'
                : _checking
                    ? '正在检查更新…'
                    : '检查更新'),
            subtitle: Text(_downloading
                ? (_progress == null
                    ? '从 R2 下载 APK'
                    : '${(_progress! * 100).toStringAsFixed(0)}%')
                : '更新源 download.cursorxyz.it.com'),
            onTap: (_checking || _downloading) ? null : _checkUpdate,
          ),
          if (_downloading && _progress != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: LinearProgressIndicator(value: _progress),
            ),
        ],
      ),
    );
  }

  Widget _section(String title) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
        child: Text(
          title,
          style: const TextStyle(
            color: kAccent,
            fontSize: 12.5,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.5,
          ),
        ),
      );

  Future<void> _confirmClear(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('清除全部数据'),
        content: const Text(
            '将删除所有已保存服务、自定义会话标题、置顶/隐藏与偏好设置。确定继续？'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: kExited),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('清除'),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    await Store.clearAll();
    if (!context.mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const PairScreen()),
      (route) => false,
    );
  }
}
