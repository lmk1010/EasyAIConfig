#!/usr/bin/env node
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const tauriCli = path.join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const args = ['dev', ...process.argv.slice(2)];

function pathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
}

function splitPath(value = '') {
  return value.split(path.delimiter).filter(Boolean);
}

function prependPath(env, entry) {
  if (!entry || !existsSync(entry)) return;
  const key = pathKey(env);
  const parts = splitPath(env[key]);
  if (parts.some((part) => part.toLowerCase() === entry.toLowerCase())) return;
  env[key] = [entry, ...parts].join(path.delimiter);
}

function commandExists(command, env = process.env) {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0;
}

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function run(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    env: options.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const cleanup = () => {
    if (options.cleanup) {
      try {
        unlinkSync(options.cleanup);
      } catch {
        // Best-effort cleanup for transient launcher scripts.
      }
    }
  };
  child.on('exit', (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on('error', (error) => {
    cleanup();
    console.error(error.message);
    process.exit(1);
  });
}

function findVsDevCmd() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (existsSync(vswhere)) {
    const result = spawnSync(vswhere, [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const installPath = result.stdout.trim().split(/\r?\n/).find(Boolean);
    if (installPath) {
      const candidate = path.join(installPath, 'Common7', 'Tools', 'VsDevCmd.bat');
      if (existsSync(candidate)) return candidate;
    }
  }

  const roots = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', '2022'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft Visual Studio', '2022'),
  ];
  const editions = ['BuildTools', 'Community', 'Professional', 'Enterprise'];
  for (const root of roots) {
    for (const edition of editions) {
      const candidate = path.join(root, edition, 'Common7', 'Tools', 'VsDevCmd.bat');
      if (existsSync(candidate)) return candidate;
    }
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name, 'Common7', 'Tools', 'VsDevCmd.bat');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return '';
}

const env = { ...process.env };
if (process.platform === 'win32') {
  prependPath(env, path.join(os.homedir(), '.cargo', 'bin'));

  if (!commandExists('cargo.exe', env)) {
    console.error('cargo.exe was not found. Install Rust with rustup, then reopen your terminal.');
    process.exit(1);
  }

  const vsDevCmd = findVsDevCmd();
  if (vsDevCmd) {
    const launcher = path.join(os.tmpdir(), `easyaiconfig-desktop-dev-${process.pid}.cmd`);
    const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
    writeFileSync(launcher, [
      '@echo off',
      `call ${cmdQuote(vsDevCmd)} -arch=x64 -host_arch=x64 >nul`,
      `set "PATH=${cargoBin};%PATH%"`,
      `${cmdQuote(process.execPath)} ${cmdQuote(tauriCli)} ${args.map(cmdQuote).join(' ')}`,
      'exit /b %ERRORLEVEL%',
    ].join('\r\n'), 'utf8');
    run('cmd.exe', ['/d', '/c', launcher], { env, cleanup: launcher });
  } else {
    console.warn('Visual Studio C++ build tools were not detected; Tauri may fail at link.exe.');
    run(process.execPath, [tauriCli, ...args], { env });
  }
} else {
  run(process.execPath, [tauriCli, ...args], { env });
}
