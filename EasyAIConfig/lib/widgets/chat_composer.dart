import 'package:flutter/material.dart';
import '../theme.dart';

/// 统一的对话输入条（对标 Codex App 浮动输入）：
/// 大圆角白底浅阴影，`+` 在左、占位「做点什么…」、发送圆钮在右。
/// [busy] 时发送钮变停止，点 [onStop]。
class ChatComposer extends StatefulWidget {
  final TextEditingController controller;
  final VoidCallback onSend;
  final VoidCallback? onAttach;
  final VoidCallback? onStop;
  final bool busy;
  final String hint;
  const ChatComposer({
    super.key,
    required this.controller,
    required this.onSend,
    this.onAttach,
    this.onStop,
    this.busy = false,
    this.hint = '做点什么…',
  });

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final hasText = widget.controller.text.trim().isNotEmpty;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 6, 14, 10),
        child: Container(
          constraints: const BoxConstraints(minHeight: 52, maxHeight: 168),
          decoration: BoxDecoration(
            color: kBg,
            borderRadius: BorderRadius.circular(22),
            border: Border.all(color: const Color(0xFFE8E8EC)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.045),
                blurRadius: 16,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          padding: const EdgeInsets.fromLTRB(4, 4, 4, 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (widget.onAttach != null)
                _roundIcon(
                    Icons.add_rounded, kMuted, Colors.transparent, widget.onAttach!),
              Expanded(
                child: Padding(
                  padding: EdgeInsets.only(
                    left: widget.onAttach == null ? 14 : 2,
                    right: 4,
                    bottom: 2,
                  ),
                  child: TextField(
                    controller: widget.controller,
                    minLines: 1,
                    maxLines: 6,
                    autocorrect: true,
                    enableSuggestions: true,
                    enableIMEPersonalizedLearning: true,
                    textCapitalization: TextCapitalization.sentences,
                    keyboardType: TextInputType.multiline,
                    textInputAction: TextInputAction.newline,
                    style: const TextStyle(
                        color: kText, fontSize: 15.5, height: 1.35),
                    decoration: InputDecoration(
                      isCollapsed: true,
                      filled: false,
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      hintText: widget.hint,
                      hintStyle: const TextStyle(color: kFaint, fontSize: 15.5),
                      contentPadding: const EdgeInsets.symmetric(vertical: 13),
                    ),
                  ),
                ),
              ),
              _sendBtn(hasText),
            ],
          ),
        ),
      ),
    );
  }

  Widget _roundIcon(IconData icon, Color fg, Color bg, VoidCallback onTap) =>
      Material(
        color: bg,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
              width: 42, height: 42, child: Icon(icon, color: fg, size: 24)),
        ),
      );

  Widget _sendBtn(bool hasText) {
    final stop = widget.busy && widget.onStop != null;
    return Padding(
      padding: const EdgeInsets.only(left: 2),
      child: Material(
        color: stop
            ? kExited
            : (hasText ? kPrimary : const Color(0xFFF0F0F2)),
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: stop
              ? widget.onStop
              : (hasText ? widget.onSend : null),
          child: SizedBox(
            width: 42,
            height: 42,
            child: Icon(
              stop ? Icons.stop_rounded : Icons.arrow_upward_rounded,
              color: stop || hasText ? kOnPrimary : kFaint,
              size: 22,
            ),
          ),
        ),
      ),
    );
  }
}
