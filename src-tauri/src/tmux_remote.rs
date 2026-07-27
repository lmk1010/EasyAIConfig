//! tmux 镜像同步：列出本机 tmux 会话，并附着为手机/桌面远程 PTY。
//! 电脑上已有 `tmux` 会话时，手机 attach 同一 session → 同屏同步。

use serde_json::{json, Value};
use std::process::Command;

use crate::provider::get_string;
use crate::{parse_json_object, terminal};

fn tmux_bin() -> Result<String, String> {
    if let Ok(p) = which::which("tmux") {
        return Ok(p.to_string_lossy().to_string());
    }
    for p in [
        "/opt/homebrew/bin/tmux",
        "/usr/local/bin/tmux",
        "/usr/bin/tmux",
    ] {
        if std::path::Path::new(p).exists() {
            return Ok(p.to_string());
        }
    }
    Err("未找到 tmux。请先安装（macOS: brew install tmux）".to_string())
}

/// GET /api/tmux/list
pub(crate) fn api_list(_query: &Value) -> Result<Value, String> {
    let tmux = match tmux_bin() {
        Ok(t) => t,
        Err(e) => {
            return Ok(json!({
                "ok": false,
                "available": false,
                "error": e,
                "sessions": [],
            }));
        }
    };
    let out = Command::new(&tmux)
        .args([
            "list-sessions",
            "-F",
            "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}\t#{session_created_string}",
        ])
        .output();
    let Ok(out) = out else {
        return Ok(json!({
            "ok": true,
            "available": true,
            "tmux": tmux,
            "sessions": [],
        }));
    };
    if !out.status.success() {
        // 无会话时 tmux 常返回非 0
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("no server running") || stderr.contains("error connecting") {
            return Ok(json!({
                "ok": true,
                "available": true,
                "tmux": tmux,
                "sessions": [],
            }));
        }
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut sessions = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.is_empty() || parts[0].is_empty() {
            continue;
        }
        let name = parts[0];
        let windows = parts
            .get(1)
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let attached = parts
            .get(2)
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0)
            > 0;
        // 活跃 pane 的 cwd，供 hook 雷达按目录匹配
        let cwd = Command::new(&tmux)
            .args([
                "display-message",
                "-p",
                "-t",
                name,
                "#{pane_current_path}",
            ])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        sessions.push(json!({
            "name": name,
            "windows": windows,
            "attached": attached,
            "activity": parts.get(3).unwrap_or(&""),
            "created": parts.get(4).unwrap_or(&""),
            "cwd": cwd,
        }));
    }
    Ok(json!({
        "ok": true,
        "available": true,
        "tmux": tmux,
        "sessions": sessions,
    }))
}

/// POST /api/tmux/create — 新建 tmux 会话并可选启动 agent，再附着
pub(crate) fn api_create(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let mut name = get_string(&object, "name");
    if name.trim().is_empty() {
        name = format!(
            "eac-{}",
            &uuid::Uuid::new_v4().to_string().replace('-', "")[..8]
        );
    }
    // 会话名安全：字母数字 _ -
    let name: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let tmux = tmux_bin()?;
    let tool = {
        let t = get_string(&object, "tool");
        if t.is_empty() {
            "codex".to_string()
        } else {
            t
        }
    };
    let cwd = get_string(&object, "cwd");
    let launch_agent = object
        .get("launchAgent")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    // 已存在则直接附着
    let exists = Command::new(&tmux)
        .args(["has-session", "-t", &name])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !exists {
        let cfg = crate::terminal::tmux_config_path();
        let mut cmd = Command::new(&tmux);
        cmd.args(["-f", &cfg, "new-session", "-d", "-s", &name]);
        if !cwd.trim().is_empty() {
            cmd.args(["-c", &cwd]);
        }
        if launch_agent {
            let prog = if tool == "claude" || tool == "claudecode" {
                "claude"
            } else if tool == "codex" {
                "codex"
            } else {
                ""
            };
            if !prog.is_empty() {
                // 用 shell 包一层：agent 退出后停在 shell，避免 session 被直接拆掉
                // 导致手机 attach 立刻结束。
                let inner = format!(
                    "export TERM=xterm-256color COLORTERM=truecolor; exec {prog} || exec bash -l"
                );
                cmd.args(["bash", "-lc", &inner]);
            }
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("创建 tmux 会话失败: {err}"));
        }
    }

    let mut attach_body = object.clone();
    attach_body.insert("name".to_string(), json!(name));
    api_attach(&Value::Object(attach_body))
}

/// POST /api/tmux/attach — 附着已有会话，返回 terminalSession（viewMode=tmux）
pub(crate) fn api_attach(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let name = get_string(&object, "name");
    if name.trim().is_empty() {
        return Err("name 不能为空（tmux session 名）".to_string());
    }
    let tmux = tmux_bin()?;
    // 确认会话存在
    let has = Command::new(&tmux)
        .args(["has-session", "-t", &name])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !has {
        return Err(format!("tmux 会话不存在: {name}"));
    }
    let origin = {
        let o = get_string(&object, "origin");
        if o.is_empty() {
            "phone".to_string()
        } else {
            o
        }
    };
    let tool = {
        let t = get_string(&object, "tool");
        if t.is_empty() {
            "shell".to_string()
        } else {
            t
        }
    };
    let mut cwd = get_string(&object, "cwd");
    if cwd.trim().is_empty() {
        if let Ok(out) = Command::new(&tmux)
            .args([
                "display-message",
                "-p",
                "-t",
                &name,
                "#{pane_current_path}",
            ])
            .output()
        {
            cwd = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
    }
    let create_body = json!({
        "tool": tool,
        "program": tmux,
        "args": [
            "-f",
            crate::terminal::tmux_config_path(),
            "attach-session",
            "-t",
            name,
        ],
        "cwd": cwd,
        "title": format!("tmux · {name}"),
        "commandPreview": format!("tmux attach -t {name}"),
        "origin": origin,
        "cols": object.get("cols").and_then(Value::as_u64).unwrap_or(120),
        "rows": object.get("rows").and_then(Value::as_u64).unwrap_or(32),
        "env": {
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
        },
    });
    let result = terminal::terminal_create(&create_body)?;
    Ok(json!({
        "ok": true,
        "viewMode": "tmux",
        "tmuxName": name,
        "terminalSession": result.get("terminalSession").cloned().unwrap_or(result),
    }))
}
