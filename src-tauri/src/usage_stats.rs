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

  Ok(json!({
    "total": count,
    "today": today_count,
    "latestMtime": latest_iso,
    "sessionsDir": sessions.to_string_lossy().to_string(),
  }))
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

  Ok(json!({
    "windowHours": 5,
    "windowStart": window_start_iso,
    "windowFirstMessageAt": first_msg_in_window.map(|t| t.to_rfc3339()).unwrap_or_default(),
    "messagesInWindow": messages_in_window,
    "latestMessageAt": latest_msg_overall.map(|t| t.to_rfc3339()).unwrap_or_default(),
    "totalSessions": total_sessions,
    "todaySessions": today_sessions,
    "projectsDir": projects.to_string_lossy().to_string(),
  }))
}
