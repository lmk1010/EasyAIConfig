import 'dart:io';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'settings.dart';

/// 本地通知：等你 / 完成（不依赖云推送；App 在前台/后台均可弹）。
class AgentNotify {
  AgentNotify._();
  static final instance = AgentNotify._();

  final _plugin = FlutterLocalNotificationsPlugin();
  bool _ready = false;
  final _lastKey = <String, int>{};

  Future<void> init() async {
    if (_ready) return;
    const android = AndroidInitializationSettings('@mipmap/ic_launcher');
    const ios = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );
    await _plugin.initialize(
      settings: const InitializationSettings(android: android, iOS: ios),
    );
    if (Platform.isAndroid) {
      final androidPlugin = _plugin.resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
      await androidPlugin?.requestNotificationsPermission();
      await androidPlugin?.createNotificationChannel(
        const AndroidNotificationChannel(
          'agent_status',
          'Agent 状态',
          description: '等你确认、任务完成等提醒',
          importance: Importance.high,
        ),
      );
    }
    _ready = true;
  }

  Future<void> waiting({
    required String sessionId,
    required String title,
    String? body,
  }) =>
      _show(
        id: sessionId.hashCode & 0x7fffffff,
        key: 'waiting:$sessionId',
        title: '等你 · $title',
        body: body?.isNotEmpty == true ? body! : 'Agent 正在等待你的确认或回复',
      );

  Future<void> done({
    required String sessionId,
    required String title,
  }) =>
      _show(
        id: (sessionId.hashCode ^ 0x1111) & 0x7fffffff,
        key: 'done:$sessionId',
        title: '已完成 · $title',
        body: '本轮任务已结束，可以继续发消息',
      );

  Future<void> _show({
    required int id,
    required String key,
    required String title,
    required String body,
  }) async {
    if (!AppSettings.instance.agentNotifyEnabled.value) return;
    await init();
    final now = DateTime.now().millisecondsSinceEpoch;
    final prev = _lastKey[key] ?? 0;
    if (now - prev < 4000) return; // 防抖
    _lastKey[key] = now;
    const details = NotificationDetails(
      android: AndroidNotificationDetails(
        'agent_status',
        'Agent 状态',
        channelDescription: '等你确认、任务完成等提醒',
        importance: Importance.high,
        priority: Priority.high,
      ),
      iOS: DarwinNotificationDetails(),
    );
    await _plugin.show(
      id: id,
      title: title,
      body: body,
      notificationDetails: details,
    );
  }
}
