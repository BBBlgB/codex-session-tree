'use strict';

const vscode = require('vscode');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { openSession } = require('./navigation');

function scan(extensionPath) {
  const config = vscode.workspace.getConfiguration('codexSessionTree');
  const custom = config.get('pythonPath', '').trim();
  const python = custom || (process.platform === 'win32' ? 'py' : 'python3');
  const args = !custom && process.platform === 'win32' ? ['-3'] : [];
  const dataHome = config.get('codexHome', '').trim() || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  args.push('-X', 'utf8', path.join(extensionPath, 'scripts', 'index_sessions.py'), '--codex-home', dataHome);
  return new Promise((resolve, reject) => {
    execFile(python, args, { windowsHide: true, timeout: 25000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(error.code === 'ENOENT' ? '找不到 Python 3，请在扩展设置中填写 pythonPath。' : stderr.trim() || error.message));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`会话索引输出无法解析：${e.message}`)); }
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
        snapshot = await scan(context.extensionPath);
        const workspacePaths = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
        send({ type: 'data', ...snapshot, selectedId, workspacePaths });
      } catch (error) { report(error); }
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
        else if (message.type === 'openPanel') await vscode.commands.executeCommand('codexSessionTree.open');
        else if (message.type === 'settings') await vscode.commands.executeCommand('codexSessionTree.settings');
        else if (message.type === 'open' && typeof message.id === 'string') {
          const item = snapshot?.nodes.find(node => node.id === message.id);
          const uri = await openSession(vscode, item);
          selectedId = item.id;
          await context.workspaceState.update('selectedSessionId', selectedId);
          send({ type: 'selected', id: selectedId });
          output.appendLine(`已请求 Codex 打开会话：${uri}`);
        }
      } catch (error) { report(error); }
    });
    surface.onDidDispose(() => { surfaces.delete(surface); receiver.dispose(); });
    surface.webview.html = getHtml(surface.webview, context.extensionUri);
  }
  function openPanel() {
    if (panel) { panel.reveal(vscode.ViewColumn.Active); return; }
    panel = vscode.window.createWebviewPanel('codexSessionTree.graph', 'Codex 会话关系图', vscode.ViewColumn.Active,
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
    vscode.commands.registerCommand('codexSessionTree.open', openPanel),
    vscode.commands.registerCommand('codexSessionTree.refresh', () => refresh(true)),
    vscode.commands.registerCommand('codexSessionTree.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-tools.codex-session-tree')),
    vscode.window.registerUriHandler({ handleUri(uri) { if (uri.path === '/open') openPanel(); } })
  );
  let lastRefresh = 0;
  const timer = setInterval(() => {
    const seconds = vscode.workspace.getConfiguration('codexSessionTree').get('refreshSeconds', 10);
    if (Date.now() - lastRefresh >= seconds * 1000) { lastRefresh = Date.now(); void refresh(); }
  }, 1000);
  context.subscriptions.push({ dispose() { clearInterval(timer); panel?.dispose(); } },
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('codexSessionTree')) void refresh(true); }));
  return { refresh, getSnapshot: () => snapshot };
}

module.exports = { activate, getHtml };
