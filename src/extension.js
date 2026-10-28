'use strict';

const vscode = require('vscode');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { openSession } = require('./navigation');
const { resolveRuntime, describeEnvironment } = require('./runtime');
const { annotateSnapshot, writeAnnotation, writeNodeRemoved, writeFavorite, recordOpened } = require('./annotations');
const { quickItems } = require('./quick-pick');

function scan(extensionPath, previewId, expectedHome) {
  const config = vscode.workspace.getConfiguration('codexSessionTree');
  if (process.platform === 'win32' && vscode.workspace.getConfiguration('chatgpt').get('runCodexInWindowsSubsystemForLinux', false)) {
    throw new Error('Codex 配置为在 WSL 中运行。请在对应 WSL 工作区窗口安装并打开会话树，避免误读 Windows 会话。');
  }
  const runtime = resolveRuntime({ platform: process.platform, home: os.homedir(), env: process.env,
    extensionPath, pythonPath: config.get('pythonPath', ''), codexHome: config.get('codexHome', '') });
  const environment = describeEnvironment(vscode, runtime, os.hostname());
  if (expectedHome && runtime.dataHome !== expectedHome) throw new Error('会话数据来源已变化，请刷新后重试。');
  if (previewId) runtime.args.push('--preview', previewId);
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
  let picker;
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
  function checkedNode(id, dataHome) {
    const item = snapshot?.nodes.find(node => node.id === id);
    if (!item || snapshot.environment.dataHome !== dataHome) throw new Error('会话数据来源已变化，请刷新后重试。');
    return item;
  }
  async function navigate(id, dataHome) {
    const item = checkedNode(id, dataHome);
    const environment = snapshot.environment;
    const uri = await openSession(vscode, item);
    await recordOpened(context.globalState, environment, item.id);
    selectedId = item.id;
    await context.workspaceState.update('selectedSessionId', selectedId);
    if (snapshot?.environment.dataHome === dataHome) snapshot = annotateSnapshot(context.globalState, snapshot);
    send({ type: 'selected', id: selectedId });
    output.appendLine(`已请求 Codex 打开会话：${uri}`);
  }
  async function favorite(id, dataHome, value) {
    checkedNode(id, dataHome);
    await writeFavorite(context.globalState, snapshot.environment, id, value);
    if (snapshot?.environment.dataHome === dataHome) snapshot = annotateSnapshot(context.globalState, snapshot);
    send({ type: 'favoriteUpdated', id, dataHome, favorite: value });
  }
  async function quickSwitch() {
    if (picker) { picker.show(); return; }
    await refresh(true);
    if (!snapshot) { void vscode.window.showErrorMessage('会话索引不可用，请查看 Codex 会话树输出。'); return; }
    // Two command invocations may have awaited the same scan.
    if (picker) { picker.show(); return; }
    const dataHome = snapshot.environment.dataHome;
    const quick = vscode.window.createQuickPick(); picker = quick;
    quick.title = '切换 Codex 会话';
    quick.placeholder = '搜索主题、别名、项目或研究记录；星标收藏会话';
    quick.matchOnDescription = true; quick.matchOnDetail = true;
    quick.items = quickItems(snapshot.nodes, vscode);
    const subscriptions = [];
    subscriptions.push(quick.onDidAccept(async () => {
      if (quick.busy || !quick.selectedItems[0]?.id) return;
      quick.busy = true;
      try { await navigate(quick.selectedItems[0].id, dataHome); quick.hide(); }
      catch (error) { void vscode.window.showErrorMessage(error.message); }
      finally { quick.busy = false; }
    }), quick.onDidTriggerItemButton(async ({ item }) => {
      if (quick.busy) return;
      quick.busy = true;
      try {
        const node = checkedNode(item.id, dataHome);
        await favorite(item.id, dataHome, !node.favorite);
        if (picker === quick && snapshot?.environment.dataHome === dataHome) quick.items = quickItems(snapshot.nodes, vscode);
      } catch (error) { void vscode.window.showErrorMessage(error.message); }
      finally { quick.busy = false; }
    }), quick.onDidHide(() => {
      if (picker === quick) picker = undefined;
      subscriptions.forEach(subscription => subscription.dispose()); quick.dispose();
    }));
    quick.show();
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
        else if (message.type === 'quickSwitch') await quickSwitch();
        else if (message.type === 'favorite') await favorite(message.id, message.dataHome, message.favorite);
        else if (message.type === 'loadDetails') {
          if (!Array.isArray(message.ids) || message.ids.length < 1 || message.ids.length > 2 || new Set(message.ids).size !== message.ids.length || typeof message.requestId !== 'string') throw new Error('预览请求格式无效。');
          for (const id of message.ids) checkedNode(id, message.dataHome);
          const results = await Promise.allSettled(message.ids.map(id => scan(context.extensionPath, id, message.dataHome)));
          const details = results.map((result, i) => ({ id: message.ids[i], ...(result.status === 'fulfilled' ? { history: result.value } : { error: result.reason.message }) }));
          void surface.webview.postMessage({ type: 'details', requestId: message.requestId, dataHome: message.dataHome, details });
        }
        else if (message.type === 'setNodeRemoved') {
          const item = snapshot?.nodes.find(node => node.id === message.id);
          if (!item || message.dataHome !== snapshot.environment.dataHome) throw new Error('会话数据来源已变化，请刷新后重试。');
          await writeNodeRemoved(context.globalState, snapshot.environment, item.id, message.removed);
          if (snapshot?.environment.dataHome === message.dataHome) snapshot = annotateSnapshot(context.globalState, snapshot);
          send({ type: 'nodeVisibilityUpdated', id: item.id, removed: message.removed, dataHome: message.dataHome });
        }
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
          await navigate(message.id, message.dataHome);
        }
      } catch (error) {
        if (message?.type === 'saveAnnotation') void surface.webview.postMessage({ type: 'annotationError', id: message.id, message: error.message });
        else if (message?.type === 'setNodeRemoved') void surface.webview.postMessage({ type: 'nodeVisibilityError', id: message.id, dataHome: message.dataHome, message: error.message });
        else if (message?.type === 'loadDetails') void surface.webview.postMessage({ type: 'details', requestId: message.requestId, dataHome: message.dataHome, details: (Array.isArray(message.ids) ? message.ids.slice(0, 2) : []).map(id => ({ id, error: error.message })) });
        else if (message?.type === 'favorite') void surface.webview.postMessage({ type: 'favoriteError', id: message.id, dataHome: message.dataHome, message: error.message });
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
    vscode.commands.registerCommand('codexSessionTree.quickSwitch', quickSwitch),
    vscode.commands.registerCommand('codexSessionTree.refresh', () => refresh(true)),
    vscode.commands.registerCommand('codexSessionTree.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-tools.codex-session-tree'))
  );
  let lastRefresh = 0;
  const timer = setInterval(() => {
    const seconds = vscode.workspace.getConfiguration('codexSessionTree').get('refreshSeconds', 10);
    if (Date.now() - lastRefresh >= seconds * 1000) { lastRefresh = Date.now(); void refresh(); }
  }, 1000);
  context.subscriptions.push({ dispose() { clearInterval(timer); picker?.hide(); panel?.dispose(); } },
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('codexSessionTree')) { picker?.hide(); void refresh(true); } }));
  return { refresh, getSnapshot: () => snapshot, getPanelTitle: () => panel?.title };
}

module.exports = { activate, getHtml };
