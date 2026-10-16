'use strict';

const path = require('node:path');

function resolveRuntime({ platform, home, env = {}, extensionPath, pythonPath = '', codexHome = '' }) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const expandHome = value => value === '~' ? home : /^~[\\/]/.test(value) ? paths.join(home, value.slice(2)) : value;
  const dataHome = expandHome(codexHome.trim() || env.CODEX_HOME || paths.join(home, '.codex'));
  const fullWindowsPath = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;
  if (!paths.isAbsolute(dataHome) || (windows && !fullWindowsPath.test(dataHome)) || (!windows && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(dataHome))) {
    throw new Error('Codex 数据目录必须是当前运行环境中的绝对路径。请检查此窗口的 codexHome 设置。');
  }
  const python = expandHome(pythonPath.trim()) || (windows ? 'py' : 'python3');
  if (!windows && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(python)) {
    throw new Error('Linux 窗口不能使用 Windows 的 Python 路径，请设置该环境的 Python 3。');
  }
  const args = windows && /^py(?:\.exe)?$/i.test(paths.basename(python)) ? ['-3'] : [];
  args.push('-X', 'utf8', paths.join(extensionPath, 'scripts', 'index_sessions.py'), '--codex-home', paths.normalize(dataHome));
  return { python, args, dataHome: paths.normalize(dataHome), platform };
}

function describeEnvironment(vscode, runtime, hostname) {
  const folders = vscode.workspace.workspaceFolders || [];
  const remote = folders.find(folder => folder.uri.scheme === 'vscode-remote')?.uri.authority;
  const system = runtime.platform === 'win32' ? 'Windows' : runtime.platform === 'linux' ? 'Linux' : runtime.platform;
  return {
    platform: runtime.platform,
    hostname,
    remoteName: vscode.env.remoteName || null,
    authority: remote || null,
    workspace: vscode.workspace.name || folders.map(folder => folder.name).join(', ') || '空窗口',
    label: `${system} · ${remote || (vscode.env.remoteName ? `${vscode.env.remoteName}: ${hostname}` : `本地 ${hostname}`)}`,
    dataHome: runtime.dataHome,
    workspacePaths: folders.map(folder => folder.uri.fsPath)
  };
}

module.exports = { resolveRuntime, describeEnvironment };
