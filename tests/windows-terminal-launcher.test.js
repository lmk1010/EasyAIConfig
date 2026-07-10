import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tauriCodex = readFileSync(new URL('../src-tauri/src/codex.rs', import.meta.url), 'utf8');
const nodeConfigStore = readFileSync(new URL('../src/lib/config-store.js', import.meta.url), 'utf8');

test('Windows CMD launchers use UTF-8 instead of UTF-16 batch files', () => {
  assert.match(tauriCodex, /fn write_windows_cmd_file[\s\S]+text\.as_bytes\(\)/);
  assert.match(tauriCodex, /@echo off\\r\\nchcp 65001>nul\\r\\ncd \/d/);
  assert.match(tauriCodex, /write_windows_cmd_file\(&launcher_path, &script\)/);
  assert.doesNotMatch(
    tauriCodex,
    /write_windows_terminal_launcher[\s\S]{0,700}write_utf16le_file\(&launcher_path, &script\)/,
  );

  assert.match(nodeConfigStore, /const script = `@echo off\nchcp 65001>nul\ncd \/d/);
  assert.match(nodeConfigStore, /writeFileSync\(launcherPath, script, 'utf8'\)/);
  assert.doesNotMatch(
    nodeConfigStore,
    /function writeWindowsTerminalLauncher[\s\S]{0,700}Buffer\.from\(script, 'utf16le'\)/,
  );
});

test('PowerShell launchers remain UTF-16LE for Windows PowerShell compatibility', () => {
  assert.match(tauriCodex, /write_windows_powershell_launcher[\s\S]{0,900}write_utf16le_file\(&launcher_path, &script\)/);
  assert.match(nodeConfigStore, /function writeWindowsPowerShellLauncher[\s\S]{0,900}Buffer\.from\(script, 'utf16le'\)/);
});
