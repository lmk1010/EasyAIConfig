//! 桌面系统通知（等你 / 完成）。不引入额外 plugin，走各平台原生命令。

use std::process::Command;

/// 弹出桌面通知。失败静默（不影响主流程）。
pub(crate) fn notify(title: &str, body: &str) {
    let title = title.chars().take(80).collect::<String>();
    let body = body.chars().take(200).collect::<String>();
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            escape_applescript(&body),
            escape_applescript(&title)
        );
        let _ = Command::new("osascript").args(["-e", &script]).status();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("notify-send")
            .args([&title, &body])
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        // PowerShell toast（尽力而为）
        let ps = format!(
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; \
             $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); \
             $text = $template.GetElementsByTagName('text'); \
             $text.Item(0).AppendChild($template.CreateTextNode('{}')) | Out-Null; \
             $text.Item(1).AppendChild($template.CreateTextNode('{}')) | Out-Null; \
             $toast = [Windows.UI.Notifications.ToastNotification]::new($template); \
             [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('EasyAIConfig').Show($toast)",
            escape_ps(&title),
            escape_ps(&body)
        );
        let _ = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps])
            .status();
    }
}

#[cfg(target_os = "macos")]
fn escape_applescript(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "windows")]
fn escape_ps(s: &str) -> String {
    s.replace('\'', "''").replace('`', "``")
}

/// 供 bridge 状态变化调用
pub(crate) fn agent_status_changed(session_title: &str, status: &str, summary: &str) {
    match status {
        "waiting" => {
            let body = if summary.is_empty() {
                "Agent 正在等待你的确认或回复".to_string()
            } else {
                summary.to_string()
            };
            notify(&format!("等你 · {session_title}"), &body);
        }
        "done" => {
            notify(
                &format!("已完成 · {session_title}"),
                "本轮任务已结束，可以继续发消息",
            );
        }
        _ => {}
    }
}
