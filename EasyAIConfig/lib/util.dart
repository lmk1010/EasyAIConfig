/// 把 ISO 时间或毫秒时间戳转成「x 分钟前」这类相对描述。
String relativeTime(DateTime? t) {
  if (t == null) return '';
  final now = DateTime.now();
  var diff = now.difference(t);
  if (diff.isNegative) diff = Duration.zero;
  if (diff.inSeconds < 45) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
  if (diff.inHours < 24) return '${diff.inHours} 小时前';
  if (diff.inDays < 30) return '${diff.inDays} 天前';
  if (diff.inDays < 365) return '${(diff.inDays / 30).floor()} 个月前';
  return '${(diff.inDays / 365).floor()} 年前';
}

/// 尝试解析多种时间形态：ISO 字符串或毫秒数字。
DateTime? parseTime(Object? raw) {
  if (raw == null) return null;
  if (raw is num) {
    final n = raw.toInt();
    // 粗略区分秒/毫秒
    return DateTime.fromMillisecondsSinceEpoch(n > 1000000000000 ? n : n * 1000);
  }
  final s = raw.toString().trim();
  if (s.isEmpty) return null;
  final asInt = int.tryParse(s);
  if (asInt != null) {
    return DateTime.fromMillisecondsSinceEpoch(
        asInt > 1000000000000 ? asInt : asInt * 1000);
  }
  return DateTime.tryParse(s);
}

/// 目录路径的简短展示（保留最后两段）。
String shortCwd(String cwd) {
  if (cwd.isEmpty) return '';
  final parts = cwd.split(RegExp(r'[\\/]')).where((e) => e.isNotEmpty).toList();
  if (parts.length <= 2) return cwd;
  return '…/${parts[parts.length - 2]}/${parts.last}';
}
