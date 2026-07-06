// 系统托盘 + 快速切换 provider。
//
// 设计：
// - 启动时建一个 tray（图标 + 菜单），菜单初始只有"显示窗口/退出"两项。
// - 前端在每次 provider 列表变化（loadState / 切换完成）后调用
//   /api/tray/refresh，把当前可见的 provider 序列化成 [{tool, label, key,
//   active, mode}] 传过来；后端 rebuild 菜单。
// - 用户在托盘里点一条 provider → 触发 menu event，event id 是
//   "switch:<tool>:<key>"；后端把这个事件 emit 到前端 window（事件名
//   "tray-switch"），前端监听后调原来的 quickSwitchCodexProvider /
//   activateOauthProfile。
// - "显示窗口" / "退出" 走标准菜单事件。
//
// 这样：托盘逻辑全在 Rust，但实际的 switch 仍走前端已有路径，避免重复。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{
    menu::{IsMenuItem, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct TrayProvider {
    pub tool: String,
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub sub: String, // e.g. base url, ChatGPT 官方登录
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub mode: String, // "apikey" / "oauth"
}

#[derive(Default)]
struct TrayState {
    installed: bool,
}

static TRAY_STATE: Mutex<TrayState> = Mutex::new(TrayState { installed: false });

pub(crate) fn install(app: &AppHandle) -> tauri::Result<()> {
    let mut state = TRAY_STATE.lock().expect("tray state lock");
    if state.installed {
        return Ok(());
    }
    let menu = build_default_menu(app)?;
    let tray = TrayIconBuilder::with_id("ea-config-tray")
        .tooltip("EasyAIConfig")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;

    let handle = app.clone();
    tray.on_menu_event(move |_tray, event| {
        let id = event.id().as_ref().to_string();
        handle_menu_event(&handle, &id);
    });

    let _ = tray; // tray icon kept alive via TrayIconBuilder retention
    state.installed = true;
    Ok(())
}

fn build_default_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let title = MenuItemBuilder::with_id("__title", "EasyAIConfig")
        .enabled(false)
        .build(app)?;
    let placeholder = MenuItemBuilder::with_id("__sep", "—— 暂未加载 provider ——")
        .enabled(false)
        .build(app)?;
    let show = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出 EasyAIConfig").build(app)?;
    MenuBuilder::new(app)
        .items(&[
            &title as &dyn IsMenuItem<tauri::Wry>,
            &placeholder as &dyn IsMenuItem<tauri::Wry>,
            &show as &dyn IsMenuItem<tauri::Wry>,
            &quit as &dyn IsMenuItem<tauri::Wry>,
        ])
        .build()
}

/// POST /api/tray/refresh — 前端把"当前所有 provider 行"传过来，
/// 我们 rebuild 菜单。
pub(crate) fn refresh_menu(app: &AppHandle, body: &Value) -> Result<Value, String> {
    use crate::parse_json_object;
    let object = parse_json_object(body);
    let providers: Vec<TrayProvider> = serde_json::from_value(
        object
            .get("providers")
            .cloned()
            .unwrap_or(Value::Array(vec![])),
    )
    .map_err(|err| format!("providers 参数无效: {err}"))?;

    let tray = match app.tray_by_id("ea-config-tray") {
        Some(t) => t,
        None => {
            install(app).map_err(|e| e.to_string())?;
            app.tray_by_id("ea-config-tray")
                .ok_or_else(|| "tray missing".to_string())?
        }
    };

    let menu = build_menu_for(app, &providers).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;

    // tooltip 用当前 active provider 名做"app 标签"
    let active_label = providers.iter().find(|p| p.active).map(|p| {
        format!(
            "EasyAIConfig — {} · {}",
            tool_display(&p.tool),
            if p.label.is_empty() {
                p.key.as_str()
            } else {
                p.label.as_str()
            }
        )
    });
    let _ = tray.set_tooltip(active_label.as_deref());

    Ok(json!({"ok": true, "count": providers.len()}))
}

fn build_menu_for(app: &AppHandle, providers: &[TrayProvider]) -> tauri::Result<Menu<tauri::Wry>> {
    use std::collections::BTreeMap;
    let mut by_tool: BTreeMap<String, Vec<&TrayProvider>> = BTreeMap::new();
    for p in providers {
        by_tool.entry(p.tool.clone()).or_default().push(p);
    }

    let mut mb = MenuBuilder::new(app);

    // 顶部 banner: 当前 active 是谁
    let banner_text = providers
        .iter()
        .find(|p| p.active)
        .map(|p| {
            format!(
                "当前: {} · {}",
                tool_display(&p.tool),
                if p.label.is_empty() {
                    p.key.as_str()
                } else {
                    p.label.as_str()
                }
            )
        })
        .unwrap_or_else(|| "EasyAIConfig".to_string());
    mb = mb.item(
        &MenuItemBuilder::with_id("__banner", banner_text)
            .enabled(false)
            .build(app)?,
    );
    mb = mb.separator();

    // 每个 tool 一个 submenu
    let tool_order = ["codex", "claudecode", "opencode", "openclaw"];
    for tool_id in tool_order {
        let Some(items) = by_tool.get(tool_id) else {
            continue;
        };
        if items.is_empty() {
            continue;
        }
        let mut sb = SubmenuBuilder::new(app, tool_display(tool_id));
        for p in items {
            let dot = if p.active { "● " } else { "○ " };
            let label = if p.label.is_empty() {
                p.key.clone()
            } else {
                p.label.clone()
            };
            let label = format!("{dot}{label}");
            let id = format!("switch:{}:{}", p.tool, p.key);
            let item = MenuItemBuilder::with_id(id, label).build(app)?;
            sb = sb.item(&item);
        }
        let submenu = sb.build()?;
        mb = mb.item(&submenu);
    }
    mb = mb.separator();
    mb = mb.item(&MenuItemBuilder::with_id("show", "显示窗口").build(app)?);
    mb = mb.item(&MenuItemBuilder::with_id("quit", "退出 EasyAIConfig").build(app)?);
    mb.build()
}

fn tool_display(tool: &str) -> &'static str {
    match tool {
        "codex" => "Codex",
        "claudecode" => "Claude Code",
        "opencode" => "OpenCode",
        "openclaw" => "OpenClaw",
        _ => "未知工具",
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    if id == "show" {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
            let _ = w.unminimize();
        }
        return;
    }
    if id == "quit" {
        app.exit(0);
        return;
    }
    // switch:<tool>:<key>
    if let Some(rest) = id.strip_prefix("switch:") {
        if let Some((tool, key)) = rest.split_once(':') {
            // 唤醒主窗口，再 emit 让前端去切（前端有完整 quickSwitch / activate 路径）
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.unminimize();
            }
            let _ = app.emit("tray-switch", json!({"tool": tool, "key": key }));
        }
    }
}
