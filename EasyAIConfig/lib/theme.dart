import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// 浅色 · ChatGPT/Claude App 风格单一主题（不做明暗切换）。
/// 纯白/浅灰底、近黑文字、克制的珊瑚色强调、近黑主按钮、无边框填充控件。

// ── 色板 ────────────────────────────────────────────────────────────
const kBg = Color(0xFFFFFFFF); // 页面底：纯白
const kSurface = Color(0xFFF7F7F8); // 卡片 / 抽屉 / 面板
const kSurfaceHigh = Color(0xFFECECEE); // 输入框 / chip / hover
const kLine = Color(0xFFE6E6E9); // 分隔线
const kText = Color(0xFF1D1D22); // 主文字（近黑）
const kMuted = Color(0xFF6B6B73); // 次要文字
const kFaint = Color(0xFF9B9BA3); // 占位 / 更弱

// 主操作 = 近黑（ChatGPT 发送键/主按钮风格）
const kPrimary = Color(0xFF1A1A1F);
const kOnPrimary = Color(0xFFFFFFFF);

// 强调 = Claude 珊瑚橙（用于激活态 / 链接 / 下划线，克制使用）
const kAccent = Color(0xFFC96442);
const kAccentSoft = Color(0x1FC96442); // 12% 珊瑚，选中底

const kRunning = Color(0xFF1F9D57);
const kExited = Color(0xFFD24B44);
const kWarn = Color(0xFFC7841F);

const kCodex = Color(0xFFC96442);
const kClaude = Color(0xFFB4632F);

/// 工具的主题色。
Color toolColor(String tool) {
  switch (tool) {
    case 'codex':
      return kCodex;
    case 'claudecode':
    case 'claude':
      return kClaude;
    default:
      return kMuted;
  }
}

/// 工具的展示名。
String toolLabel(String tool) {
  switch (tool) {
    case 'codex':
      return 'Codex';
    case 'claudecode':
    case 'claude':
      return 'Claude Code';
    default:
      return tool.isEmpty ? 'Shell' : tool;
  }
}

/// 工具图标：一眼区分 Codex / Claude Code / Shell。
IconData toolIcon(String tool) {
  switch (tool) {
    case 'codex':
      return Icons.auto_awesome; // Codex：星芒
    case 'claudecode':
    case 'claude':
      return Icons.psychology_outlined; // Claude：思考头像
    default:
      return Icons.terminal; // Shell：终端
  }
}

/// 工具的高质感 PNG logo（真 logo）。shell 等无 logo 返回 null，回退到 toolIcon。
String? toolLogoAsset(String tool) {
  switch (tool) {
    case 'codex':
      return 'assets/icon/codex_logo.png';
    case 'claudecode':
    case 'claude':
      return 'assets/icon/claude_logo.png';
    default:
      return null;
  }
}

/// 统一的工具 logo 组件：优先 PNG logo，退出态降透明度。
Widget toolLogo(String tool, {double size = 20, bool running = true}) {
  final asset = toolLogoAsset(tool);
  if (asset == null) {
    return Icon(toolIcon(tool),
        size: size, color: running ? kMuted : kFaint);
  }
  return Opacity(
    opacity: running ? 1.0 : 0.38,
    child: Image.asset(
      asset,
      width: size,
      height: size,
      filterQuality: FilterQuality.high,
      isAntiAlias: true,
    ),
  );
}

/// 全局唯一主题。组件样式集中在这里，页面尽量不写死颜色。
ThemeData calmTheme() {
  const scheme = ColorScheme.light(
    surface: kSurface,
    onSurface: kText,
    primary: kPrimary,
    onPrimary: kOnPrimary,
    secondary: kAccent,
    onSecondary: Colors.white,
    error: kExited,
    onError: Colors.white,
    outline: kLine,
    surfaceContainerHighest: kSurfaceHigh,
    onSurfaceVariant: kMuted,
  );

  const radius12 = BorderRadius.all(Radius.circular(12));

  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    colorScheme: scheme,
    scaffoldBackgroundColor: kBg,
    canvasColor: kBg,
    visualDensity: VisualDensity.compact,
    splashFactory: InkSparkle.splashFactory,
    dividerColor: kLine,
    dividerTheme: const DividerThemeData(color: kLine, thickness: 1, space: 1),
    iconTheme: const IconThemeData(color: kMuted),

    appBarTheme: const AppBarTheme(
      backgroundColor: kBg,
      foregroundColor: kText,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: true,
      systemOverlayStyle: SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: Brightness.dark,
        statusBarBrightness: Brightness.light,
      ),
      titleTextStyle: TextStyle(
        color: kText,
        fontSize: 16,
        fontWeight: FontWeight.w600,
      ),
      iconTheme: IconThemeData(color: kText, size: 22),
    ),

    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: kSurfaceHigh,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      hintStyle: const TextStyle(color: kFaint, fontSize: 13.5),
      labelStyle: const TextStyle(color: kMuted, fontSize: 13),
      floatingLabelStyle: const TextStyle(color: kAccent, fontSize: 12.5),
      border: const OutlineInputBorder(
        borderRadius: radius12,
        borderSide: BorderSide.none,
      ),
      enabledBorder: const OutlineInputBorder(
        borderRadius: radius12,
        borderSide: BorderSide.none,
      ),
      focusedBorder: const OutlineInputBorder(
        borderRadius: radius12,
        borderSide: BorderSide(color: kAccent, width: 1.2),
      ),
    ),

    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: kPrimary,
        foregroundColor: kOnPrimary,
        elevation: 0,
        textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        shape: const RoundedRectangleBorder(borderRadius: radius12),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: kText,
        side: const BorderSide(color: kLine),
        textStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500),
        shape: const RoundedRectangleBorder(borderRadius: radius12),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: kAccent,
        textStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500),
      ),
    ),

    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? kAccentSoft
              : Colors.transparent,
        ),
        foregroundColor: WidgetStateProperty.resolveWith(
          (states) =>
              states.contains(WidgetState.selected) ? kAccent : kMuted,
        ),
        side: const WidgetStatePropertyAll(BorderSide(color: kLine)),
        textStyle: const WidgetStatePropertyAll(
          TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
        ),
        visualDensity: VisualDensity.compact,
      ),
    ),

    chipTheme: const ChipThemeData(
      backgroundColor: kSurfaceHigh,
      labelStyle: TextStyle(color: kMuted, fontSize: 11.5),
      side: BorderSide.none,
      padding: EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(8)),
      ),
    ),

    drawerTheme: const DrawerThemeData(
      backgroundColor: kBg,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.horizontal(right: Radius.circular(0)),
      ),
    ),

    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: kBg,
      modalBackgroundColor: kBg,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      showDragHandle: false,
    ),
    dialogTheme: const DialogThemeData(
      backgroundColor: kBg,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(16)),
      ),
      titleTextStyle: TextStyle(
        color: kText,
        fontSize: 16,
        fontWeight: FontWeight.w600,
      ),
      contentTextStyle: TextStyle(color: kMuted, fontSize: 13.5, height: 1.5),
    ),

    tabBarTheme: const TabBarThemeData(
      labelColor: kText,
      unselectedLabelColor: kMuted,
      indicatorColor: kAccent,
      indicatorSize: TabBarIndicatorSize.label,
      dividerColor: kLine,
      labelStyle: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
      unselectedLabelStyle: TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
    ),

    switchTheme: SwitchThemeData(
      trackColor: WidgetStateProperty.resolveWith(
        (states) =>
            states.contains(WidgetState.selected) ? kAccent : kSurfaceHigh,
      ),
      thumbColor: const WidgetStatePropertyAll(Colors.white),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
    ),
    listTileTheme: const ListTileThemeData(
      iconColor: kMuted,
      textColor: kText,
      dense: true,
    ),
    popupMenuTheme: const PopupMenuThemeData(
      color: kBg,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(12)),
        side: BorderSide(color: kLine),
      ),
    ),

    floatingActionButtonTheme: const FloatingActionButtonThemeData(
      backgroundColor: kPrimary,
      foregroundColor: kOnPrimary,
      elevation: 0,
      highlightElevation: 0,
      extendedTextStyle: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(16)),
      ),
    ),

    snackBarTheme: const SnackBarThemeData(
      backgroundColor: kText,
      contentTextStyle: TextStyle(color: Colors.white, fontSize: 13),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(12)),
      ),
    ),

    textTheme: const TextTheme(
      bodyMedium: TextStyle(color: kText, fontSize: 13.5),
      bodySmall: TextStyle(color: kMuted, fontSize: 12),
      titleMedium:
          TextStyle(color: kText, fontSize: 15, fontWeight: FontWeight.w600),
      titleSmall:
          TextStyle(color: kText, fontSize: 13.5, fontWeight: FontWeight.w600),
      labelMedium: TextStyle(color: kMuted, fontSize: 12),
    ),
  );
}
