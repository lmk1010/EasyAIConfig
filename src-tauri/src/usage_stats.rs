// Lightweight local-usage stats for the console page. Intentionally cheap —
// directory listing + mtime stat, no file parsing unless we really need it.
//
// Two endpoints:
//
//   GET /api/codex/session-stats
//     Counts files under ~/.codex/sessions/, returns total + latestMtime.
//     This is what backs the "会话数 / 最近活动" row on the Codex console.
//
//   GET /api/claudecode/local-usage
//     Rolling-5h window: enumerates ~/.claude/projects/**/*.jsonl, filters
//     lines whose timestamp is within the last 5 hours, returns message
//     count + window-start timestamp. Token count is INTENTIONALLY NOT
//     computed — partial local estimates mislead users into gambling
//     against their real server-side quota.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

use crate::{claude_code_home, default_codex_home};

fn walk_latest_mtime_and_count(dir: &Path, ext: &str) -> (u64, u64) {
  let mut count: u64 = 0;
  let mut latest: u64 = 0;
  let Ok(entries) = fs::read_dir(dir) else { return (0, 0); };
  for entry in entries.flatten() {
    let Ok(ft) = entry.file_type() else { continue; };
    if ft.is_dir() {
      let (sub_count, sub_latest) = walk_latest_mtime_and_count(&entry.path(), ext);
      count += sub_count;
      if sub_latest > latest { latest = sub_latest; }
      continue;
    }
    let path = entry.path();
    if !ext.is_empty() && path.extension().and_then(|s| s.to_str()) != Some(ext) {
      continue;
    }
    count += 1;
    if let Ok(meta) = entry.metadata() {
      if let Ok(mtime) = meta.modified() {
        if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
          let secs = dur.as_secs();
          if secs > latest { latest = secs; }
        }
      }
    }
  }
  (count, latest)
}

pub(crate) fn codex_session_stats(_query: &Value) -> Result<Value, String> {
  let sessions = default_codex_home()?.join("sessions");
  let (count, latest) = walk_latest_mtime_and_count(&sessions, "");
  let latest_iso = if latest > 0 {
    DateTime::from_timestamp(latest as i64, 0)
      .map(|dt| dt.to_rfc3339())
      .unwrap_or_default()
  } else {
    String::new()
  };

  // Count sessions updated in the last 24h as "today"-ish activity.
  let now = Utc::now().timestamp() as u64;
  let day_ago = now.saturating_sub(24 * 3600);
  let (today_count, _) = count_recent_in(&sessions, day_ago);
  let week_ago = now.saturating_sub(7 * 24 * 3600);
  let (week_count, _) = count_recent_in(&sessions, week_ago);

  // Recent session previews — top 5 by mtime.
  let recent = collect_recent_codex_sessions(&sessions, 5);

  // Unique model distribution across the last 7 days.
  let model_counts = codex_model_distribution(&sessions, week_ago);

  Ok(json!({
    "total": count,
    "today": today_count,
    "week": week_count,
    "latestMtime": latest_iso,
    "sessionsDir": sessions.to_string_lossy().to_string(),
    "recent": recent,
    "modelDistribution": model_counts,
  }))
}

// Walk sessions/, collect (path, mtime), sort desc, take top-N and parse
// enough of each session file to return a readable preview row.
fn collect_recent_codex_sessions(root: &Path, limit: usize) -> Vec<Value> {
  let mut all: Vec<(std::path::PathBuf, u64)> = Vec::new();
  fn walk(p: &Path, out: &mut Vec<(std::path::PathBuf, u64)>) {
    let Ok(entries) = fs::read_dir(p) else { return };
    for e in entries.flatten() {
      let Ok(ft) = e.file_type() else { continue };
      if ft.is_dir() { walk(&e.path(), out); continue; }
      let path = e.path();
      if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
      if let Ok(meta) = e.metadata() {
        if let Ok(mtime) = meta.modified() {
          if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
            out.push((path, dur.as_secs()));
          }
        }
      }
    }
  }
  walk(root, &mut all);
  all.sort_by(|a, b| b.1.cmp(&a.1));

  all.into_iter().take(limit).map(|(path, mtime)| {
    let session_id = path
      .file_stem()
      .and_then(|s| s.to_str())
      .unwrap_or("")
      .to_string();
    let (message_count, first_user, model, started_at) = peek_codex_session(&path);
    let mtime_iso = DateTime::from_timestamp(mtime as i64, 0)
      .map(|dt| dt.to_rfc3339())
      .unwrap_or_default();
    json!({
      "sessionId": session_id,
      "path": path.to_string_lossy().to_string(),
      "lastActiveAt": mtime_iso,
      "startedAt": started_at,
      "messageCount": message_count,
      "firstMessage": first_user,
      "model": model,
    })
  }).collect()
}

// Parse a single Codex session.jsonl. Each line is a JSON object; shape varies
// by event type. We only care about: total line count, first user message,
// and the first model string we see. Stops after finding both or 200 lines.
fn peek_codex_session(path: &Path) -> (u64, String, String, String) {
  let Ok(text) = fs::read_to_string(path) else { return (0, String::new(), String::new(), String::new()); };
  let mut count: u64 = 0;
  let mut first_user = String::new();
  let mut model = String::new();
  let mut started_at = String::new();
  for line in text.lines() {
    count += 1;
    if !first_user.is_empty() && !model.is_empty() && !started_at.is_empty() { continue; }
    let trimmed = line.trim();
    if trimmed.is_empty() { continue; }
    let Ok(v): Result<Value, _> = serde_json::from_str(trimmed) else { continue; };

    if started_at.is_empty() {
      if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
        started_at = ts.to_string();
      }
    }
    if model.is_empty() {
      if let Some(m) = v.get("model").and_then(Value::as_str) {
        model = m.to_string();
      } else if let Some(m) = v.get("payload").and_then(|p| p.get("model")).and_then(Value::as_str) {
        model = m.to_string();
      }
    }
    if first_user.is_empty() {
      // Codex stores user messages as event_msg.user_message OR response_item.message[role=user]
      let event_type = v.get("type").and_then(Value::as_str).unwrap_or("");
      let payload = v.get("payload");
      if event_type == "event_msg"
        && payload.and_then(|p| p.get("type")).and_then(Value::as_str) == Some("user_message")
      {
        let msg = payload
          .and_then(|p| p.get("message"))
          .and_then(Value::as_str)
          .unwrap_or("");
        if !msg.is_empty() { first_user = truncate(msg, 72); }
      } else if event_type == "response_item"
        && payload.and_then(|p| p.get("type")).and_then(Value::as_str) == Some("message")
        && payload.and_then(|p| p.get("role")).and_then(Value::as_str) == Some("user")
      {
        if let Some(content) = payload.and_then(|p| p.get("content")).and_then(Value::as_array) {
          let joined: String = content
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("input_text"))
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" ");
          if !joined.is_empty() { first_user = truncate(&joined, 72); }
        }
      }
    }
  }
  (count, first_user, model, started_at)
}

fn codex_model_distribution(root: &Path, since_epoch: u64) -> Vec<Value> {
  use std::collections::HashMap;
  let mut counts: HashMap<String, u64> = HashMap::new();

  fn walk(p: &Path, since: u64, counts: &mut HashMap<String, u64>) {
    let Ok(entries) = fs::read_dir(p) else { return };
    for e in entries.flatten() {
      let Ok(ft) = e.file_type() else { continue };
      if ft.is_dir() { walk(&e.path(), since, counts); continue; }
      let path = e.path();
      if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
      if let Ok(meta) = e.metadata() {
        if let Ok(mtime) = meta.modified() {
          if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
            if dur.as_secs() < since { continue; }
          }
        }
      }
      let Ok(text) = fs::read_to_string(&path) else { continue };
      // Take just the first valid line's model hint to avoid N² parsing.
      for line in text.lines().take(20) {
        let Ok(v): Result<Value, _> = serde_json::from_str(line.trim()) else { continue };
        let model = v.get("model").and_then(Value::as_str)
          .or_else(|| v.get("payload").and_then(|p| p.get("model")).and_then(Value::as_str));
        if let Some(m) = model {
          if !m.is_empty() {
            *counts.entry(m.to_string()).or_insert(0) += 1;
            break;
          }
        }
      }
    }
  }

  walk(root, since_epoch, &mut counts);
  let mut pairs: Vec<(String, u64)> = counts.into_iter().collect();
  pairs.sort_by(|a, b| b.1.cmp(&a.1));
  pairs.into_iter().take(6).map(|(m, c)| json!({ "model": m, "count": c })).collect()
}

fn truncate(s: &str, max_chars: usize) -> String {
  if s.chars().count() <= max_chars {
    return s.split_whitespace().collect::<Vec<_>>().join(" ");
  }
  let clean: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
  if clean.chars().count() <= max_chars {
    return clean;
  }
  let mut out: String = clean.chars().take(max_chars).collect();
  out.push('…');
  out
}

fn count_recent_in(dir: &Path, since_epoch: u64) -> (u64, u64) {
  let mut count: u64 = 0;
  let mut total: u64 = 0;
  let Ok(entries) = fs::read_dir(dir) else { return (0, 0); };
  for entry in entries.flatten() {
    let Ok(ft) = entry.file_type() else { continue; };
    if ft.is_dir() {
      let (sub_c, sub_t) = count_recent_in(&entry.path(), since_epoch);
      count += sub_c;
      total += sub_t;
      continue;
    }
    total += 1;
    if let Ok(meta) = entry.metadata() {
      if let Ok(mtime) = meta.modified() {
        if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
          if dur.as_secs() >= since_epoch { count += 1; }
        }
      }
    }
  }
  (count, total)
}

pub(crate) fn claudecode_local_usage(_query: &Value) -> Result<Value, String> {
  let projects = claude_code_home()?.join("projects");
  let now = Utc::now();
  let window_start = now - ChronoDuration::hours(5);
  let window_start_iso = window_start.to_rfc3339();

  let mut messages_in_window: u64 = 0;
  let mut first_msg_in_window: Option<DateTime<Utc>> = None;
  let mut latest_msg_overall: Option<DateTime<Utc>> = None;
  let mut total_sessions: u64 = 0;
  let mut today_sessions: u64 = 0;

  let today_cutoff = now - ChronoDuration::hours(24);
  let today_cutoff_epoch = today_cutoff.timestamp() as u64;

  fn walk_jsonl(
    dir: &Path,
    window_start: DateTime<Utc>,
    today_cutoff_epoch: u64,
    messages_in_window: &mut u64,
    first_msg_in_window: &mut Option<DateTime<Utc>>,
    latest_msg_overall: &mut Option<DateTime<Utc>>,
    total_sessions: &mut u64,
    today_sessions: &mut u64,
  ) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
      let Ok(ft) = entry.file_type() else { continue; };
      let path = entry.path();
      if ft.is_dir() {
        walk_jsonl(&path, window_start, today_cutoff_epoch, messages_in_window, first_msg_in_window, latest_msg_overall, total_sessions, today_sessions);
        continue;
      }
      if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }

      *total_sessions += 1;
      if let Ok(meta) = entry.metadata() {
        if let Ok(mtime) = meta.modified() {
          if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
            if dur.as_secs() >= today_cutoff_epoch { *today_sessions += 1; }
          }
        }
      }

      // Read the file line by line; for each JSONL row, look for a `timestamp`
      // field. Parse every line so tokens of interest aren't skipped, but bail
      // early on files that obviously predate the window (mtime before window
      // start — nothing in them can be inside).
      if let Ok(meta) = entry.metadata() {
        if let Ok(mtime) = meta.modified() {
          if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
            if (dur.as_secs() as i64) < window_start.timestamp() { continue; }
          }
        }
      }

      let Ok(text) = fs::read_to_string(&path) else { continue; };
      for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        let parsed: Value = match serde_json::from_str(trimmed) {
          Ok(v) => v,
          Err(_) => continue,
        };
        let ts_str = parsed.get("timestamp").and_then(Value::as_str).unwrap_or("");
        if ts_str.is_empty() { continue; }
        let Ok(ts) = DateTime::parse_from_rfc3339(ts_str) else { continue; };
        let ts_utc = ts.with_timezone(&Utc);

        if latest_msg_overall.map(|t| ts_utc > t).unwrap_or(true) {
          *latest_msg_overall = Some(ts_utc);
        }

        if ts_utc >= window_start {
          *messages_in_window += 1;
          if first_msg_in_window.map(|t| ts_utc < t).unwrap_or(true) {
            *first_msg_in_window = Some(ts_utc);
          }
        }
      }
    }
  }

  walk_jsonl(
    &projects,
    window_start,
    today_cutoff_epoch,
    &mut messages_in_window,
    &mut first_msg_in_window,
    &mut latest_msg_overall,
    &mut total_sessions,
    &mut today_sessions,
  );

  // Recent sessions: by jsonl file mtime (each jsonl = one Claude session).
  let recent = collect_recent_claude_sessions(&projects, 5);

  Ok(json!({
    "windowHours": 5,
    "windowStart": window_start_iso,
    "windowFirstMessageAt": first_msg_in_window.map(|t| t.to_rfc3339()).unwrap_or_default(),
    "messagesInWindow": messages_in_window,
    "latestMessageAt": latest_msg_overall.map(|t| t.to_rfc3339()).unwrap_or_default(),
    "totalSessions": total_sessions,
    "todaySessions": today_sessions,
    "projectsDir": projects.to_string_lossy().to_string(),
    "recent": recent,
  }))
}

fn collect_recent_claude_sessions(root: &Path, limit: usize) -> Vec<Value> {
  let mut all: Vec<(std::path::PathBuf, u64)> = Vec::new();
  fn walk(p: &Path, out: &mut Vec<(std::path::PathBuf, u64)>) {
    let Ok(entries) = fs::read_dir(p) else { return };
    for e in entries.flatten() {
      let Ok(ft) = e.file_type() else { continue };
      if ft.is_dir() { walk(&e.path(), out); continue; }
      let path = e.path();
      if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
      if let Ok(meta) = e.metadata() {
        if let Ok(mtime) = meta.modified() {
          if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
            out.push((path, dur.as_secs()));
          }
        }
      }
    }
  }
  walk(root, &mut all);
  all.sort_by(|a, b| b.1.cmp(&a.1));

  all.into_iter().take(limit).map(|(path, mtime)| {
    // Project name = the directory name containing the jsonl.
    let project = path
      .parent()
      .and_then(|p| p.file_name())
      .and_then(|s| s.to_str())
      .unwrap_or("")
      .to_string();
    let session_id = path
      .file_stem()
      .and_then(|s| s.to_str())
      .unwrap_or("")
      .to_string();
    let (message_count, first_user, model, started_at) = peek_claude_session(&path);
    let mtime_iso = DateTime::from_timestamp(mtime as i64, 0)
      .map(|dt| dt.to_rfc3339())
      .unwrap_or_default();
    json!({
      "sessionId": session_id,
      "project": project,
      "path": path.to_string_lossy().to_string(),
      "lastActiveAt": mtime_iso,
      "startedAt": started_at,
      "messageCount": message_count,
      "firstMessage": first_user,
      "model": model,
    })
  }).collect()
}

fn peek_claude_session(path: &Path) -> (u64, String, String, String) {
  let Ok(text) = fs::read_to_string(path) else { return (0, String::new(), String::new(), String::new()); };
  let mut count: u64 = 0;
  let mut first_user = String::new();
  let mut model = String::new();
  let mut started_at = String::new();

  for line in text.lines() {
    count += 1;
    if !first_user.is_empty() && !model.is_empty() && !started_at.is_empty() { continue; }
    let trimmed = line.trim();
    if trimmed.is_empty() { continue; }
    let Ok(v): Result<Value, _> = serde_json::from_str(trimmed) else { continue };

    if started_at.is_empty() {
      if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
        started_at = ts.to_string();
      }
    }
    if model.is_empty() {
      // Claude session jsonl puts model under message.model for assistant turns
      if let Some(m) = v.get("message").and_then(|m| m.get("model")).and_then(Value::as_str) {
        model = m.to_string();
      }
    }
    if first_user.is_empty() {
      // message.role == 'user', message.content = string or array of blocks
      if v.get("type").and_then(Value::as_str) == Some("user") {
        let message = v.get("message");
        if let Some(content) = message.and_then(|m| m.get("content")) {
          if let Some(text) = content.as_str() {
            first_user = truncate(text, 72);
          } else if let Some(arr) = content.as_array() {
            let joined: String = arr.iter()
              .filter_map(|b| b.get("text").and_then(Value::as_str))
              .collect::<Vec<_>>()
              .join(" ");
            if !joined.is_empty() { first_user = truncate(&joined, 72); }
          }
        }
      }
    }
  }
  (count, first_user, model, started_at)
}
