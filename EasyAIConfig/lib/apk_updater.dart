import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

/// APK 更新源（Cloudflare R2 自定义域）。
const kApkUpdateFeedUrl =
    'https://download.cursorxyz.it.com/latest.json';

class ApkUpdateInfo {
  final String latestVersion;
  final String currentVersion;
  final int currentBuild;
  final String apkUrl;
  final String? sha256;
  final String notes;

  const ApkUpdateInfo({
    required this.latestVersion,
    required this.currentVersion,
    required this.currentBuild,
    required this.apkUrl,
    this.sha256,
    this.notes = '',
  });

  bool get hasUpdate => _compareSemver(latestVersion, currentVersion) > 0;
}

int _compareSemver(String a, String b) {
  List<int> parts(String v) {
    final core = v.split('+').first.split('-').first;
    return core
        .split('.')
        .map((p) => int.tryParse(p.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0)
        .toList();
  }

  final pa = parts(a);
  final pb = parts(b);
  final n = pa.length > pb.length ? pa.length : pb.length;
  for (var i = 0; i < n; i++) {
    final x = i < pa.length ? pa[i] : 0;
    final y = i < pb.length ? pb[i] : 0;
    if (x != y) return x.compareTo(y);
  }
  return 0;
}

Future<ApkUpdateInfo?> checkApkUpdate() async {
  if (!Platform.isAndroid) return null;
  final info = await PackageInfo.fromPlatform();
  final res = await http
      .get(Uri.parse(kApkUpdateFeedUrl))
      .timeout(const Duration(seconds: 20));
  if (res.statusCode != 200) {
    throw Exception('检查更新失败 HTTP ${res.statusCode}');
  }
  final json = jsonDecode(utf8.decode(res.bodyBytes));
  if (json is! Map) throw Exception('latest.json 格式错误');
  final latestVersion = (json['version'] ?? '').toString().trim();
  if (latestVersion.isEmpty) throw Exception('latest.json 缺少 version');

  final platforms = json['platforms'];
  Map? android;
  if (platforms is Map) {
    android = (platforms['android-arm64'] ??
        platforms['android'] ??
        platforms['android-arm64-v8a']) as Map?;
  }
  final apkUrl = (android?['url'] ?? '').toString().trim();
  if (apkUrl.isEmpty) {
    throw Exception('latest.json 未包含 android-arm64 下载地址');
  }
  final sha = (android?['sha256'] ?? android?['sha256sum'] ?? '')
      .toString()
      .trim();

  return ApkUpdateInfo(
    latestVersion: latestVersion,
    currentVersion: info.version,
    currentBuild: int.tryParse(info.buildNumber) ?? 0,
    apkUrl: apkUrl,
    sha256: sha.isEmpty ? null : sha,
    notes: (json['notes'] ?? '').toString(),
  );
}

Future<File> downloadApk(
  ApkUpdateInfo update, {
  void Function(int received, int? total)? onProgress,
}) async {
  final client = http.Client();
  try {
    final req = http.Request('GET', Uri.parse(update.apkUrl));
    final streamed = await client.send(req).timeout(const Duration(minutes: 5));
    if (streamed.statusCode != 200) {
      throw Exception('下载失败 HTTP ${streamed.statusCode}');
    }
    final total = streamed.contentLength;
    final dir = await getTemporaryDirectory();
    final file = File(
      '${dir.path}/EasyAIConfig_${update.latestVersion}.apk',
    );
    final sink = file.openWrite();
    var received = 0;
    await for (final chunk in streamed.stream) {
      sink.add(chunk);
      received += chunk.length;
      onProgress?.call(received, total);
    }
    await sink.close();

    if (update.sha256 != null && update.sha256!.isNotEmpty) {
      final bytes = await file.readAsBytes();
      final digest = sha256.convert(bytes).toString();
      if (digest.toLowerCase() != update.sha256!.toLowerCase()) {
        await file.delete();
        throw Exception('APK 校验失败（sha256 不匹配）');
      }
    }
    return file;
  } finally {
    client.close();
  }
}

Future<void> installApkFile(File file) async {
  final result = await OpenFilex.open(file.path);
  if (result.type != ResultType.done) {
    throw Exception(result.message.isEmpty ? '无法打开安装包' : result.message);
  }
}
