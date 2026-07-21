import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:easy_ai_config/store.dart';
import 'package:easy_ai_config/models/server.dart';

void main() {
  group('parsePairing', () {
    test('extracts base url and token from hash link', () {
      final r = parsePairing('http://192.168.1.10:8790/#t=abc123');
      expect(r, isNotNull);
      expect(r!.$1, 'http://192.168.1.10:8790');
      expect(r.$2, 'abc123');
    });

    test('supports ?token= form', () {
      final r = parsePairing('http://host:9000/?token=xyz');
      expect(r!.$2, 'xyz');
    });

    test('returns null without token', () {
      expect(parsePairing('http://host:9000/'), isNull);
    });
  });

  group('ServerConfig', () {
    test('round-trips through json', () {
      final s = ServerConfig(
          id: 'id1', name: 'Home', baseUrl: 'http://a:1', token: 'tok');
      final back = ServerConfig.fromJson(s.toJson());
      expect(back, isNotNull);
      expect(back!.id, 'id1');
      expect(back.name, 'Home');
      expect(back.baseUrl, 'http://a:1');
      expect(back.token, 'tok');
    });

    test('fromJson rejects missing required fields', () {
      expect(ServerConfig.fromJson({'id': 'x'}), isNull);
      expect(ServerConfig.fromJson('nope'), isNull);
    });

    test('defaultName derives host:port', () {
      expect(ServerConfig.defaultName('http://192.168.1.5:8790'),
          '192.168.1.5:8790');
    });
  });

  group('Store', () {
    setUp(() {
      TestWidgetsFlutterBinding.ensureInitialized();
    });

    test('migrates legacy single-server keys into the list', () async {
      SharedPreferences.setMockInitialValues({
        'server_url': 'http://10.0.0.2:8790',
        'server_token': 'legacyToken',
      });
      final servers = await Store.listServers();
      expect(servers.length, 1);
      expect(servers.first.baseUrl, 'http://10.0.0.2:8790');
      final current = await Store.currentServer();
      expect(current, isNotNull);
      expect(current!.token, 'legacyToken');
    });

    test('upsertFromPairing adds then updates by baseUrl', () async {
      SharedPreferences.setMockInitialValues({});
      final a = await Store.upsertFromPairing('http://h:1', 'tokA');
      expect((await Store.listServers()).length, 1);
      final b = await Store.upsertFromPairing('http://h:1', 'tokB');
      // 相同地址应更新而非新增
      expect((await Store.listServers()).length, 1);
      expect(b.id, a.id);
      expect(b.token, 'tokB');
    });

    test('remove and select behave correctly', () async {
      SharedPreferences.setMockInitialValues({});
      final a = await Store.addServer(
          name: 'A', baseUrl: 'http://a:1', token: 't1');
      final bServer = await Store.addServer(
          name: 'B', baseUrl: 'http://b:1', token: 't2');
      await Store.selectServer(bServer.id);
      expect((await Store.currentServer())!.id, bServer.id);
      await Store.removeServer(bServer.id);
      // 删除当前项后应回退到剩余的第一个
      expect((await Store.currentServer())!.id, a.id);
    });
  });
}
