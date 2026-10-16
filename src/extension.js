'use strict';

const vscode = require('vscode');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { openSession } = require('./navigation');
const { resolveRuntime, describeEnvironment } = require('./runtime');
const { annotateSnapshot, writeAnnotation } = require('./annotations');

function scan(extensionPath) {
  const config = vscode.workspace.getConfiguration('codexSessionTree');
  if (process.platform === 'win32' && vscode.workspace.getConfiguration('chatgpt').get('runCodexInWindowsSubsystemForLinux', false)) {
    throw new Error('Codex 配置为在 WSL 中运行。请在对应 WSL 工作区窗口安装并打开会话树，避免误读 Windows 会话。');
  }
  const runtime = resolveRuntime({ platform: process.platform, home: os.homedir(), env: process.env,
    extensionPath, pythonPath: config.get('pythonPath', ''), codexHome: config.get('codexHome', '') });
  const environment = describeEnvironment(vscode, runtime, os.hostname());
  return new Promise((resolve, reject) => {
    execFile(runtime.python, runtime.args, { windowsHide: true, timeout: 25000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(error.code === 'ENOENT' ? `${environment.label} 找不到 Python 3，请在该环境安装 Python 3.10+，或配置 pythonPath。` : stderr.trim() || error.message));
        return;
      }
      try { resolve({ ...JSON.parse(stdout), environment }); } catch (e) { reject(new Error(`会话索引输出无法解析：${e.message}`)); }
    });
  });
}

function getHtml(webview, extensionUri) {
  const media = vscode.Uri.joinPath(extensionUri, 'media');
  const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
  const nonce = crypto.randomBytes(18).toString('base64');
  return fs.readFileSync(vscode.Uri.joinPath(media, 'index.html').fsPath, 'utf8')
    .replaceAll('{{cspSource}}', webview.cspSource).replaceAll('{{nonce}}', nonce)
    .replaceAll('{{styleUri}}', asset('style.css')).replaceAll('{{graphUri}}', asset('graph.js'))
    .replaceAll('{{appUri}}', asset('app.js'));
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Codex 会话树');
  const surfaces = new Set();
  let panel, snapshot, pending;
  let selectedId = context.workspaceState.get('selectedSessionId', '');
  const send = message => { for (const surface of surfaces) void surface.webview.postMessage(message); };
  const report = error => {
    output.appendLine(`${new Date().toISOString()} ${error.message}`);
    send({ type: 'error', message: error.message });
  };
  async function refresh(force = false) {
    if (pending) return pending;
    if (!force && ![...surfaces].some(s => s.visible)) return;
    pending = (async () => {
      try {
        snapshot = annotateSnapshot(context.globalState, await scan(context.extensionPath));
        const workspacePaths = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
        send({ type: 'data', ...snapshot, selectedId, workspacePaths });
      } catch (error) {
        snapshot = undefined;
        send({ type: 'dataUnavailable' });
        report(error);
      }
      finally { pending = undefined; }
    })();
    return pending;
  }
  function attach(surface) {
    surfaces.add(surface);
    surface.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
    const receiver = surface.webview.onDidReceiveMessage(async message => {
      try {
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'ready' || message.type === 'refresh') await refresh(true);
        else if (message.type === 'openPanel') await vscode.commands.executeCommand('codexSessionTree.openHere');
        else if (message.type === 'settings') await vscode.commands.executeCommand('codexSessionTree.settings');
        else if (message.type === 'saveAnnotation') {
          const item = snapshot?.nodes.find(node => node.id === message.id);
          // Keep a form bound to the data source it was opened from, even if
          // the user changes codexHome while the editor remains open.
          if (!item || message.dataHome !== snapshot.environment.dataHome) throw new Error('会话数据来源已变化，请关闭编辑框并重新打开。');
          const annotation = await writeAnnotation(context.globalState, snapshot.environment, item.id, message.annotation);
          // An automatic scan may have replaced the snapshot during persistence.
          if (snapshot?.environment.dataHome === message.dataHome) snapshot = annotateSnapshot(context.globalState, snapshot);
          for (const target of surfaces) void target.webview.postMessage({
            type: target === surface ? 'annotationSaved' : 'annotationUpdated', id: item.id, annotation, dataHome: message.dataHome
          });
        }
        else if (message.type === 'open' && typeof message.id === 'string') {
          const item = snapshot?.nodes.find(node => node.id === message.id);
          const uri = await openSession(vscode, item);
          selectedId = item.id;
          await context.workspaceState.update('selectedSessionId', selectedId);
          send({ type: 'selected', id: selectedId });
          output.appendLine(`已请求 Codex 打开会话：${uri}`);
        }
      } catch (error) {
        if (message?.type === 'saveAnnotation') void surface.webview.postMessage({ type: 'annotationError', id: message.id, message: error.message });
        else report(error);
      }
    });
    surface.onDidDispose(() => { surfaces.delete(surface); receiver.dispose(); });
    surface.webview.html = getHtml(surface.webview, context.extensionUri);
  }
  function openPanel() {
    if (panel) { panel.reveal(vscode.ViewColumn.Active); return; }
    // This API belongs to the invoking extension host's VS Code window, including
    // SSH/WSL hosts. Never launch a global vscode:// URI to choose a graph window.
    panel = vscode.window.createWebviewPanel('codexSessionTree.graph', `Codex 会话关系图 · ${vscode.workspace.name || '空窗口'}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    attach(panel);
    panel.onDidDispose(() => { panel = undefined; });
  }
  context.subscriptions.push(output,
    vscode.window.registerWebviewViewProvider('codexSessionTree.view', {
      resolveWebviewView(view) {
        attach(view);
        context.subscriptions.push(view.onDidChangeVisibility(() => { if (view.visible) void refresh(true); }));
      }
    }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('codexSessionTree.openHere', openPanel),
    vscode.commands.registerCommand('codexSessionTree.open', openPanel),
    vscode.commands.registerCommand('codexSessionTree.refresh', () => refresh(true)),
    vscode.commands.registerCommand('codexSessionTree.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-tools.codex-session-tree'))
  );
  let lastRefresh = 0;
  const timer = setInterval(() => {
    const seconds = vscode.workspace.getConfiguration('codexSessionTree').get('refreshSeconds', 10);
    if (Date.now() - lastRefresh >= seconds * 1000) { lastRefresh = Date.now(); void refresh(); }
  }, 1000);
  context.subscriptions.push({ dispose() { clearInterval(timer); panel?.dispose(); } },
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('codexSessionTree')) void refresh(true); }));
  return { refresh, getSnapshot: () => snapshot, getPanelTitle: () => panel?.title };
}

module.exports = { activate, getHtml };
