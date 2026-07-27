import 'package:flutter/material.dart';

import 'theme.dart';

/// 一等会话模式（已淘汰 timeline 刮屏主入口）。
class SessionMode {
  static const bridge = 'bridge';
  static const terminal = 'terminal';
  static const tmux = 'tmux';

  /// 启动器一等模式。
  static const launchable = [bridge, terminal, tmux];

  static bool isKnown(String mode) =>
      mode == bridge || mode == terminal || mode == tmux || mode == 'timeline';

  static String label(String mode) {
    switch (mode) {
      case bridge:
        return '快速通道';
      case terminal:
        return '完整终端';
      case tmux:
        return '镜像同步';
      case 'timeline':
        return '刮屏(已淘汰)';
      default:
        return mode.isEmpty ? '快速通道' : mode;
    }
  }

  static String shortLabel(String mode) {
    switch (mode) {
      case bridge:
        return '快速';
      case terminal:
        return '终端';
      case tmux:
        return '镜像';
      default:
        return label(mode);
    }
  }

  static String subtitle(String mode) {
    switch (mode) {
      case bridge:
        return '低延迟 · 用量/模型/审批';
      case terminal:
        return '原生 TUI';
      case tmux:
        return '与电脑同一会话';
      default:
        return '';
    }
  }

  static IconData icon(String mode) {
    switch (mode) {
      case bridge:
        return Icons.bolt_rounded;
      case terminal:
        return Icons.terminal_rounded;
      case tmux:
        return Icons.phone_android_rounded;
      default:
        return Icons.chat_bubble_outline;
    }
  }

  static Color accent(String mode) {
    switch (mode) {
      case bridge:
        return kRunning;
      case terminal:
        return const Color(0xFF5B8CFF);
      case tmux:
        return const Color(0xFF8B6DFF);
      default:
        return kMuted;
    }
  }
}

/// agentStatus：working | waiting | done（及本地派生 exited）
class AgentStatus {
  static const working = 'working';
  static const waiting = 'waiting';
  static const done = 'done';
  static const exited = 'exited';

  static String normalize(String raw, {required bool running}) {
    if (!running) return exited;
    switch (raw) {
      case working:
      case waiting:
      case done:
        return raw;
      default:
        return done;
    }
  }

  static String label(String status) {
    switch (status) {
      case working:
        return '工作中';
      case waiting:
        return '等你';
      case done:
        return '空闲';
      case exited:
        return '已退出';
      default:
        return status;
    }
  }

  static Color color(String status) {
    switch (status) {
      case working:
        return kRunning;
      case waiting:
        return kWaiting;
      case done:
        return kMuted;
      case exited:
        return kExited;
      default:
        return kMuted;
    }
  }

  /// 列表排序：等你 > 工作中 > 空闲 > 已退出
  static int sortRank(String status) {
    switch (status) {
      case waiting:
        return 0;
      case working:
        return 1;
      case done:
        return 2;
      default:
        return 3;
    }
  }
}

/// 按 tool + mode 算出的能力开关；UI 只展示 Y 的入口。
class SessionCapabilities {
  final String tool;
  final String mode;

  const SessionCapabilities({required this.tool, required this.mode});

  bool get isCodex => tool == 'codex';
  bool get isClaude =>
      tool == 'claude' || tool == 'claudecode' || tool == 'claude-code';

  bool get bridge => mode == SessionMode.bridge;
  bool get terminal => mode == SessionMode.terminal;
  bool get tmux => mode == SessionMode.tmux;

  /// 结构化 Timeline 聊天气泡
  bool get structuredChat => bridge;

  /// 用量面板（bridge）
  bool get usagePanel => bridge;

  /// 模型 / 推理切换（bridge）
  bool get modelSwitch => bridge;

  bool get reasoningSwitch => bridge && isCodex;

  /// RPC 审批卡
  bool get approvalCards => bridge;

  bool get imageAttach => true;

  /// 电脑↔手机镜像
  bool get desktopMirror => tmux;

  bool get accessoryKeyboard => terminal || tmux;

  bool get optimisticBubble => bridge;

  /// 启动器能力芯片文案
  List<String> get chips {
    final out = <String>[];
    if (structuredChat) out.add('Timeline');
    if (usagePanel) out.add('用量');
    if (modelSwitch) out.add('模型');
    if (reasoningSwitch) out.add('推理');
    if (approvalCards) out.add('审批');
    if (imageAttach && bridge) out.add('图片');
    if (desktopMirror) out.add('镜像');
    if (terminal) out.add('完整 TUI');
    if (accessoryKeyboard) out.add('配件键');
    if (tmux) out.add('同屏同步');
    return out;
  }

  static SessionCapabilities of({
    required String tool,
    required String mode,
  }) {
    var m = mode;
    // 遗留刮屏：按终端能力展示（无 bridge 用量/模型面板）
    if (m == 'timeline') m = SessionMode.terminal;
    if (m != SessionMode.bridge &&
        m != SessionMode.terminal &&
        m != SessionMode.tmux) {
      m = SessionMode.bridge;
    }
    return SessionCapabilities(tool: tool, mode: m);
  }
}
