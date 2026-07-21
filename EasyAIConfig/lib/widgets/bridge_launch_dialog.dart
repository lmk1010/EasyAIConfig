import 'dart:async';

import 'package:flutter/material.dart';

import '../theme.dart';

/// 快速通道（app-server）启动等待：分步文案 + 进度条，避免干等几秒无反馈。
class BridgeLaunchDialog extends StatefulWidget {
  final String title;
  final List<String> steps;
  const BridgeLaunchDialog({
    super.key,
    this.title = '启动快速通道',
    this.steps = const [
      '拉起 app-server…',
      '完成握手…',
      '创建会话线程…',
      '即将就绪…',
    ],
  });

  /// 展示不可关闭的启动遮罩，执行 [task] 后自动关掉。
  static Future<T> run<T>(
    BuildContext context, {
    required Future<T> Function() task,
    String title = '启动快速通道',
    List<String>? steps,
  }) async {
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      barrierColor: Colors.black.withValues(alpha: 0.28),
      builder: (_) => PopScope(
        canPop: false,
        child: BridgeLaunchDialog(
          title: title,
          steps: steps ??
              const [
                '拉起 app-server…',
                '完成握手…',
                '创建会话线程…',
                '即将就绪…',
              ],
        ),
      ),
    );
    try {
      return await task();
    } finally {
      if (context.mounted) {
        Navigator.of(context, rootNavigator: true).pop();
      }
    }
  }

  @override
  State<BridgeLaunchDialog> createState() => _BridgeLaunchDialogState();
}

class _BridgeLaunchDialogState extends State<BridgeLaunchDialog>
    with SingleTickerProviderStateMixin {
  int _step = 0;
  Timer? _timer;
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat(reverse: true);

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(milliseconds: 900), (_) {
      if (!mounted) return;
      setState(() {
        if (_step < widget.steps.length - 1) _step++;
      });
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final progress = ((_step + 1) / widget.steps.length).clamp(0.15, 1.0);
    return Center(
      child: Material(
        color: kBg,
        elevation: 8,
        shadowColor: Colors.black26,
        borderRadius: BorderRadius.circular(18),
        child: Container(
          width: 300,
          padding: const EdgeInsets.fromLTRB(22, 22, 22, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  ScaleTransition(
                    scale: Tween(begin: 0.92, end: 1.0).animate(
                      CurvedAnimation(parent: _pulse, curve: Curves.easeInOut),
                    ),
                    child: Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        color: kRunning.withValues(alpha: 0.12),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(Icons.bolt_rounded,
                          color: kRunning, size: 20),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      widget.title,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        color: kText,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0, end: progress),
                  duration: const Duration(milliseconds: 450),
                  curve: Curves.easeOutCubic,
                  builder: (_, v, __) => LinearProgressIndicator(
                    value: v,
                    minHeight: 6,
                    backgroundColor: const Color(0xFFECECEE),
                    color: kRunning,
                  ),
                ),
              ),
              const SizedBox(height: 14),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 220),
                switchInCurve: Curves.easeOut,
                switchOutCurve: Curves.easeIn,
                child: Text(
                  widget.steps[_step.clamp(0, widget.steps.length - 1)],
                  key: ValueKey(_step),
                  style: const TextStyle(
                    fontSize: 13.5,
                    color: kMuted,
                    height: 1.35,
                  ),
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                '首次启动会稍慢，请稍候',
                style: TextStyle(fontSize: 11.5, color: kFaint),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
