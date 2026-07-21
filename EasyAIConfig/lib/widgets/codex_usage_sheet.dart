import 'dart:convert';

import 'package:flutter/material.dart';

import '../theme.dart';

/// 解析 Codex `account/rateLimits/read` 结果，渲染成可读用量卡（进度条 / 重置时间 / 计划）。
class CodexUsageSheet extends StatelessWidget {
  final dynamic raw;
  final int? sessionTokens;
  final int? contextWindow;

  const CodexUsageSheet({
    super.key,
    required this.raw,
    this.sessionTokens,
    this.contextWindow,
  });

  static Future<void> show(
    BuildContext context, {
    required dynamic raw,
    int? sessionTokens,
    int? contextWindow,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: kBg,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (_) => CodexUsageSheet(
        raw: raw,
        sessionTokens: sessionTokens,
        contextWindow: contextWindow,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final parsed = _UsageParse.from(raw);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 36,
                height: 4,
                margin: const EdgeInsets.only(bottom: 14),
                decoration: BoxDecoration(
                  color: kLine,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Row(
              children: [
                const Expanded(
                  child: Text(
                    'Codex 用量',
                    style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                      color: kText,
                    ),
                  ),
                ),
                if (parsed.planLabel.isNotEmpty) _planPill(parsed.planLabel),
              ],
            ),
            if (parsed.limitName.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                parsed.limitName,
                style: const TextStyle(color: kMuted, fontSize: 12.5),
              ),
            ],
            const SizedBox(height: 16),
            if (sessionTokens != null ||
                (contextWindow != null && contextWindow! > 0))
              _sessionTokenCard(sessionTokens ?? 0, contextWindow ?? 0),
            if (parsed.windows.isEmpty && !parsed.hasCredits) ...[
              const SizedBox(height: 8),
              Text(
                parsed.emptyHint,
                style: const TextStyle(color: kMuted, fontSize: 13.5, height: 1.4),
              ),
            ],
            for (final w in parsed.windows) ...[
              _windowCard(w),
              const SizedBox(height: 10),
            ],
            if (parsed.hasCredits) ...[
              _creditsCard(parsed),
              const SizedBox(height: 10),
            ],
            if (parsed.resetCreditsAvailable > 0) ...[
              _infoRow(
                Icons.restart_alt,
                '可兑换重置额度',
                '${parsed.resetCreditsAvailable} 次',
                kAccent,
              ),
              const SizedBox(height: 8),
            ],
            if (parsed.reachedType.isNotEmpty) ...[
              _infoRow(
                Icons.warning_amber_rounded,
                '已触达限额',
                parsed.reachedType,
                kWarn,
              ),
              const SizedBox(height: 8),
            ],
            const SizedBox(height: 4),
            Theme(
              data: Theme.of(context).copyWith(dividerColor: kLine),
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                childrenPadding: const EdgeInsets.only(bottom: 4),
                title: const Text(
                  '原始数据',
                  style: TextStyle(fontSize: 13, color: kMuted),
                ),
                children: [
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: kSurface,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: SelectableText(
                      const JsonEncoder.withIndent('  ').convert(
                        raw is Map || raw is List ? raw : {'value': raw},
                      ),
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: kFaint,
                        height: 1.35,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _planPill(String label) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: kAccentSoft,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: const TextStyle(
          color: kAccent,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }

  Widget _sessionTokenCard(int used, int window) {
    final pct = window > 0 ? (used / window).clamp(0.0, 1.0) : 0.0;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: _windowCard(_RateWindow(
        title: '本会话上下文',
        usedPercent: pct * 100,
        detailLeft: _fmtTokens(used),
        detailRight: window > 0 ? _fmtTokens(window) : '—',
        resetText: window > 0 ? '会话内 token / 上下文窗口' : '已用 token',
      )),
    );
  }

  Widget _windowCard(_RateWindow w) {
    final pct = (w.usedPercent / 100).clamp(0.0, 1.0);
    final remain = (100 - w.usedPercent).clamp(0.0, 100.0);
    final barColor = _barColor(pct);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: kSurface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: kLine.withValues(alpha: 0.8)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  w.title,
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: kText,
                  ),
                ),
              ),
              Text(
                '${w.usedPercent.toStringAsFixed(w.usedPercent >= 10 ? 0 : 1)}%',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: barColor,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: LinearProgressIndicator(
              value: pct,
              minHeight: 8,
              backgroundColor: kSurfaceHigh,
              color: barColor,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: Text(
                  '已用 ${w.detailLeft}${w.detailRight.isNotEmpty ? ' / ${w.detailRight}' : ''}',
                  style: const TextStyle(fontSize: 12, color: kMuted),
                ),
              ),
              Text(
                '剩余 ${remain.toStringAsFixed(remain >= 10 ? 0 : 1)}%',
                style: const TextStyle(fontSize: 12, color: kMuted),
              ),
            ],
          ),
          if (w.resetText.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              w.resetText,
              style: const TextStyle(fontSize: 12, color: kFaint, height: 1.3),
            ),
          ],
        ],
      ),
    );
  }

  Widget _creditsCard(_UsageParse p) {
    final unlimited = p.creditsUnlimited;
    final balance = p.creditsBalance;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: kSurface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: kLine.withValues(alpha: 0.8)),
      ),
      child: Row(
        children: [
          Icon(
            unlimited ? Icons.all_inclusive : Icons.toll_outlined,
            size: 20,
            color: unlimited ? kRunning : kMuted,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Credits',
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: kText,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  unlimited
                      ? '无限额度'
                      : (p.creditsHas
                          ? '余额 $balance'
                          : '无可用 credits（余额 $balance）'),
                  style: const TextStyle(fontSize: 12, color: kMuted),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _infoRow(IconData icon, String title, String value, Color color) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(title,
                style: TextStyle(
                    fontSize: 13, fontWeight: FontWeight.w600, color: color)),
          ),
          Text(value, style: TextStyle(fontSize: 12.5, color: color)),
        ],
      ),
    );
  }

  static Color _barColor(double pct) {
    if (pct >= 0.9) return kExited;
    if (pct >= 0.7) return kWarn;
    return kRunning;
  }

  static String _fmtTokens(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(n >= 10000 ? 0 : 1)}K';
    return '$n';
  }
}

class _RateWindow {
  final String title;
  final double usedPercent;
  final String detailLeft;
  final String detailRight;
  final String resetText;
  const _RateWindow({
    required this.title,
    required this.usedPercent,
    this.detailLeft = '',
    this.detailRight = '',
    this.resetText = '',
  });
}

class _UsageParse {
  final String planLabel;
  final String limitName;
  final String reachedType;
  final bool hasCredits;
  final bool creditsHas;
  final bool creditsUnlimited;
  final String creditsBalance;
  final int resetCreditsAvailable;
  final List<_RateWindow> windows;
  final String emptyHint;

  const _UsageParse({
    required this.planLabel,
    required this.limitName,
    required this.reachedType,
    required this.hasCredits,
    required this.creditsHas,
    required this.creditsUnlimited,
    required this.creditsBalance,
    required this.resetCreditsAvailable,
    required this.windows,
    required this.emptyHint,
  });

  factory _UsageParse.from(dynamic raw) {
    final root = _asMap(raw) ?? <String, dynamic>{};
    final rate = _asMap(root['rateLimits']) ??
        _asMap(root['rate_limits']) ??
        _asMap(root['limits']) ??
        root;
    final credits = _asMap(rate['credits']) ?? _asMap(root['credits']);
    final resetBlock = _asMap(root['rateLimitResetCredits']) ??
        _asMap(root['rate_limit_reset_credits']);

    final planRaw =
        (rate['planType'] ?? rate['plan'] ?? root['planType'] ?? '').toString();
    final planLabel = _planLabel(planRaw);
    final limitName = (rate['limitName'] ?? rate['limitId'] ?? '').toString();
    final reached =
        (rate['rateLimitReachedType'] ?? rate['reachedType'] ?? '').toString();

    final windows = <_RateWindow>[];
    final primary = _asMap(rate['primary']);
    final secondary = _asMap(rate['secondary']);
    if (primary != null) {
      windows.add(_windowFrom(
        primary,
        fallbackTitle: _windowTitle(primary, fallback: '主限额'),
      ));
    }
    if (secondary != null) {
      windows.add(_windowFrom(
        secondary,
        fallbackTitle: _windowTitle(secondary, fallback: '次限额'),
      ));
    }
    // 兼容 oauth 风格 fiveHour / week
    for (final key in [
      'fiveHour',
      'five_hour',
      'week',
      'weekly',
      'day',
      'daily'
    ]) {
      final m = _asMap(rate[key]) ?? _asMap(root[key]);
      if (m == null) continue;
      if (windows
          .any((w) => w.title.contains(_windowTitle(m, fallback: key)))) {
        continue;
      }
      windows
          .add(_windowFrom(m, fallbackTitle: _windowTitle(m, fallback: key)));
    }

    final balance = (credits?['balance'] ?? '0').toString();
    final hasCreditsField = credits != null;
    final creditsHas = credits?['hasCredits'] == true ||
        credits?['has_credits'] == true ||
        (double.tryParse(balance) ?? 0) > 0;
    final unlimited =
        credits?['unlimited'] == true || rate['unlimited'] == true;
    final resetAvail = (resetBlock?['availableCount'] as num?)?.toInt() ??
        (resetBlock?['available_count'] as num?)?.toInt() ??
        0;

    return _UsageParse(
      planLabel: planLabel,
      limitName: limitName == 'codex' ? 'Codex 限额' : limitName,
      reachedType: reached,
      hasCredits: hasCreditsField,
      creditsHas: creditsHas,
      creditsUnlimited: unlimited,
      creditsBalance: balance,
      resetCreditsAvailable: resetAvail,
      windows: windows,
      emptyHint: root.isEmpty
          ? '暂无用量数据（当前账号可能未返回 rate limits）'
          : '已拿到响应，但没有可识别的限额窗口',
    );
  }

  static _RateWindow _windowFrom(Map m, {required String fallbackTitle}) {
    final used = _num(m['usedPercent'] ?? m['used_percent'] ?? m['used']);
    final remain = _num(m['remainingPercent'] ?? m['remaining_percent']);
    final pct = used ?? (remain != null ? (100 - remain) : 0);
    final mins = (m['windowDurationMins'] as num?)?.toInt() ??
        (m['window_duration_mins'] as num?)?.toInt();
    final secs = (m['limitWindowSeconds'] as num?)?.toInt() ??
        (m['limit_window_seconds'] as num?)?.toInt();
    final duration = mins != null
        ? _fmtDurationMins(mins)
        : (secs != null ? _fmtDurationSecs(secs) : '');
    final reset = _fmtReset(m['resetsAt'] ?? m['resets_at'] ?? m['resetAt']);
    final bits = <String>[
      if (duration.isNotEmpty) '窗口 $duration',
      if (reset.isNotEmpty) reset,
    ];
    return _RateWindow(
      title: fallbackTitle,
      usedPercent: pct.clamp(0, 100).toDouble(),
      detailLeft: '${pct.clamp(0, 100).toStringAsFixed(pct >= 10 ? 0 : 1)}%',
      detailRight: '配额',
      resetText: bits.join(' · '),
    );
  }

  static String _windowTitle(Map m, {required String fallback}) {
    final label = (m['label'] ?? m['name'] ?? m['limitName'] ?? '').toString();
    if (label.isNotEmpty) return label;
    final mins = (m['windowDurationMins'] as num?)?.toInt() ??
        (m['window_duration_mins'] as num?)?.toInt();
    if (mins != null) {
      if (mins >= 10000) return '周限额';
      if (mins >= 1400) return '日限额';
      if (mins >= 240) return '5 小时限额';
      if (mins >= 50) return '小时限额';
    }
    final secs = (m['limitWindowSeconds'] as num?)?.toInt();
    if (secs != null) {
      if (secs >= 600000) return '周限额';
      if (secs >= 80000) return '日限额';
      if (secs >= 14000) return '5 小时限额';
    }
    switch (fallback) {
      case 'fiveHour':
      case 'five_hour':
        return '5 小时限额';
      case 'week':
      case 'weekly':
        return '周限额';
      case 'day':
      case 'daily':
        return '日限额';
      default:
        return fallback;
    }
  }

  static String _planLabel(String raw) {
    final p = raw.trim().toLowerCase();
    if (p.isEmpty) return '';
    switch (p) {
      case 'plus':
        return 'Plus';
      case 'pro':
        return 'Pro';
      case 'team':
        return 'Team';
      case 'enterprise':
        return 'Enterprise';
      case 'free':
        return 'Free';
      default:
        return raw[0].toUpperCase() + raw.substring(1);
    }
  }

  static String _fmtDurationMins(int mins) {
    if (mins >= 10080) return '${(mins / 10080).round()} 周';
    if (mins >= 1440) return '${(mins / 1440).round()} 天';
    if (mins >= 60) return '${(mins / 60).round()} 小时';
    return '$mins 分钟';
  }

  static String _fmtDurationSecs(int secs) =>
      _fmtDurationMins((secs / 60).round());

  static String _fmtReset(dynamic v) {
    if (v == null) return '';
    DateTime? dt;
    if (v is num) {
      final n = v.toInt();
      // 秒 / 毫秒
      dt = DateTime.fromMillisecondsSinceEpoch(
          n > 1000000000000 ? n : n * 1000,
          isUtc: true);
    } else {
      dt = DateTime.tryParse(v.toString());
    }
    if (dt == null) return '';
    final local = dt.toLocal();
    final now = DateTime.now();
    final diff = local.difference(now);
    String relative;
    if (diff.isNegative) {
      relative = '已过重置点';
    } else if (diff.inMinutes < 90) {
      relative = '约 ${diff.inMinutes} 分钟后重置';
    } else if (diff.inHours < 48) {
      relative = '约 ${diff.inHours} 小时后重置';
    } else {
      relative = '约 ${diff.inDays} 天后重置';
    }
    final stamp =
        '${local.month.toString().padLeft(2, '0')}-${local.day.toString().padLeft(2, '0')} '
        '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
    return '$relative（$stamp）';
  }

  static Map<String, dynamic>? _asMap(dynamic v) {
    if (v is Map<String, dynamic>) return v;
    if (v is Map) return Map<String, dynamic>.from(v);
    return null;
  }

  static double? _num(dynamic v) {
    if (v is num) return v.toDouble();
    if (v is String) return double.tryParse(v);
    return null;
  }
}
