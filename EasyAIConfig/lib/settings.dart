import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 全局应用设置。轻量方案：单例 + ValueNotifier，无需状态管理框架。
/// 在 main() 里 `await AppSettings.instance.load()` 后再 runApp。
class AppSettings {
  AppSettings._();
  static final AppSettings instance = AppSettings._();

  static const _kTheme = 'theme_mode';
  static const _kFont = 'term_font_size';
  static const _kAwake = 'keep_awake';
  static const _kHaptics = 'haptics';
  static const _kHooks = 'agent_hooks_enabled';
  static const _kNotify = 'agent_notify_enabled';

  static const double minFont = 8;
  static const double maxFont = 28;
  static const double defaultFont = 13;

  final ValueNotifier<ThemeMode> themeMode = ValueNotifier(ThemeMode.dark);
  final ValueNotifier<double> terminalFontSize = ValueNotifier(defaultFont);
  final ValueNotifier<bool> keepAwake = ValueNotifier(false);
  final ValueNotifier<bool> haptics = ValueNotifier(true);
  /// 桌面托管 Hook 雷达（等你状态）
  final ValueNotifier<bool> agentHooksEnabled = ValueNotifier(true);
  /// 本地「等你 / 完成」通知
  final ValueNotifier<bool> agentNotifyEnabled = ValueNotifier(true);

  bool _loaded = false;

  Future<void> load() async {
    if (_loaded) return;
    final p = await SharedPreferences.getInstance();
    themeMode.value = _themeFromString(p.getString(_kTheme));
    final f = p.getDouble(_kFont);
    if (f != null) terminalFontSize.value = f.clamp(minFont, maxFont);
    keepAwake.value = p.getBool(_kAwake) ?? false;
    haptics.value = p.getBool(_kHaptics) ?? true;
    agentHooksEnabled.value = p.getBool(_kHooks) ?? true;
    agentNotifyEnabled.value = p.getBool(_kNotify) ?? true;
    _loaded = true;
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    themeMode.value = mode;
    final p = await SharedPreferences.getInstance();
    await p.setString(_kTheme, _themeToString(mode));
  }

  Future<void> setTerminalFontSize(double size) async {
    final v = size.clamp(minFont, maxFont).toDouble();
    terminalFontSize.value = v;
    final p = await SharedPreferences.getInstance();
    await p.setDouble(_kFont, v);
  }

  Future<void> bumpFont(double delta) => setTerminalFontSize(
        terminalFontSize.value + delta,
      );

  Future<void> setKeepAwake(bool value) async {
    keepAwake.value = value;
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kAwake, value);
  }

  Future<void> setHaptics(bool value) async {
    haptics.value = value;
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kHaptics, value);
  }

  Future<void> setAgentHooksEnabled(bool value) async {
    agentHooksEnabled.value = value;
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kHooks, value);
  }

  Future<void> setAgentNotifyEnabled(bool value) async {
    agentNotifyEnabled.value = value;
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kNotify, value);
  }

  static ThemeMode _themeFromString(String? s) {
    switch (s) {
      case 'light':
        return ThemeMode.light;
      case 'system':
        return ThemeMode.system;
      case 'dark':
      default:
        return ThemeMode.dark;
    }
  }

  static String _themeToString(ThemeMode m) {
    switch (m) {
      case ThemeMode.light:
        return 'light';
      case ThemeMode.system:
        return 'system';
      case ThemeMode.dark:
        return 'dark';
    }
  }

  static String themeLabel(ThemeMode m) {
    switch (m) {
      case ThemeMode.light:
        return '浅色';
      case ThemeMode.system:
        return '跟随系统';
      case ThemeMode.dark:
        return '深色';
    }
  }
}
