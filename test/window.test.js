'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function createHost(name, remoteName, storage = { get: () => undefined, update: async () => {} }, options = {}) {
  const panels = [], commands = new Map(), subscriptions = [], pickers = [], opened = [], scans = [], errors = [];
  const disposable = { dispose() {} };
  let viewProvider;
  const media = path.resolve(__dirname, '..');
  const vscode = {
    QuickPickItemKind: { Separator: -1 }, ThemeIcon: class { constructor(id) { this.id = id; } },
    workspace: { name, workspaceFolders: [], onDidChangeConfiguration: () => disposable,
      getConfiguration: () => ({ get: (key, fallback) => fallback }) },
    env: { remoteName }, ViewColumn: { Active: -1 },
    Uri: { joinPath: (base, ...segments) => ({ fsPath: path.join(base.fsPath, ...segments) }) },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return disposable; } },
    window: {
      showErrorMessage: message => errors.push(message),
      createQuickPick: () => {
        const handlers = {};
        const picker = { items: [], selectedItems: [], busy: false, handlers,
          onDidAccept: cb => { handlers.accept = cb; return disposable; },
          onDidTriggerItemButton: cb => { handlers.button = cb; return disposable; },
          onDidHide: cb => { handlers.hide = cb; return disposable; },
          show() {}, hide() { handlers.hide(); }, dispose() { this.disposed = true; }
        };
        pickers.push(picker); return picker;
      },
      createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      registerWebviewViewProvider: (id, provider) => { viewProvider = provider; return disposable; },
      createWebviewPanel: (kind, title) => {
        const panel = { title, visible: true, reveal() {}, dispose() {}, onDidDispose: () => disposable, onDidChangeVisibility: () => disposable,
          messages: [], webview: { cspSource: 'https://example.invalid', asWebviewUri: uri => ({ toString: () => uri.fsPath }),
            onDidReceiveMessage: listener => { panel.receive = listener; return disposable; }, postMessage(message) { panel.messages.push(message); return Promise.resolve(true); } } };
        panels.push(panel); return panel;
      }
    }
  };
  const filename = path.join(media, 'src/extension.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const fixture = fs.readFileSync(path.join(media, 'test/fixtures/sessions.json'), 'utf8');
  const fakeProcess = { execFile: (command, args, execOptions, callback) => {
    scans.push(args);
    if (!args.includes('--preview')) { callback(null, fixture, ''); return; }
    if (options.previewFailure) callback(new Error('read failed'), '', 'history unavailable');
    else callback(null, JSON.stringify({ question: { text: 'source question', source: 'fixture' }, answer: null, files: [], warnings: [] }), '');
  } };
  const navigation = { openSession: async (api, item) => { opened.push(item.id); return 'vscode://synthetic'; } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: id => id === 'vscode' ? vscode : id === 'node:child_process' ? fakeProcess : id === './navigation' ? navigation : localRequire(id),
    module, process, setInterval: () => 0, clearInterval() {} }, { filename });
  const context = { subscriptions, extensionUri: { fsPath: media }, extensionPath: media,
    workspaceState: { get: () => '', update: async () => {} }, globalState: storage };
  const api = module.exports.activate(context);
  return { panels, commands, api, pickers, opened, scans, errors, createSidebar() {
    const sidebar = vscode.window.createWebviewPanel('sidebar', 'sidebar');
    viewProvider.resolveWebviewView(sidebar);
    return sidebar;
  } };
}

test('the open command creates a graph only in the window where the user invoked it', () => {
  const windows = createHost('windows-project');
  const linux = createHost('linux-project', 'ssh-remote');
  linux.commands.get('codexSessionTree.openHere')();
  assert.equal(windows.panels.length, 0);
  assert.equal(linux.panels.length, 1);
  assert.ok(linux.panels[0].title.includes('linux-project'));
  linux.commands.get('codexSessionTree.openHere')();
  assert.equal(linux.panels.length, 1);
  windows.commands.get('codexSessionTree.openHere')();
  assert.equal(windows.panels.length, 1);
  assert.ok(windows.panels[0].title.includes('windows-project'));
});

test('webview saves use plugin storage, survive another workspace, and reapply after scanning', async () => {
  const records = new Map();
  const storage = { get: key => records.get(key), update: async (key, value) => { records.set(key, value); } };
  const host = createHost('first-project', undefined, storage);
  host.commands.get('codexSessionTree.openHere')(); await host.api.refresh(true);
  const before = host.api.getSnapshot(); const target = before.nodes[1];
  const annotation = { alias: '审稿修改', tags: ['进行中', '待验证'], note: '待补实验\n检查公式' };
  await host.panels[0].receive({ type: 'saveAnnotation', id: target.id, dataHome: before.environment.dataHome, annotation });
  assert.equal(host.panels[0].messages.at(-1).type, 'annotationSaved');
  assert.equal(records.size, 1); assert.deepEqual(host.api.getSnapshot().nodes[1].annotation, annotation);
  assert.equal(host.api.getSnapshot().nodes[1].title, target.title);
  const other = createHost('another-project', undefined, storage); await other.api.refresh(true);
  assert.deepEqual(other.api.getSnapshot().nodes[1].annotation, annotation);
  await host.api.refresh(true); assert.deepEqual(host.api.getSnapshot().nodes[1].annotation, annotation);
});

test('save rejects stale sources and invalid nodes, and reports disk failure to the form', async () => {
  let writes = 0;
  const storage = { get: () => undefined, update: async () => { writes++; throw new Error('disk unavailable'); } };
  const host = createHost('project', undefined, storage);
  host.commands.get('codexSessionTree.openHere')(); await host.api.refresh(true);
  const data = host.api.getSnapshot();
  const request = { type: 'saveAnnotation', id: data.nodes[0].id, dataHome: data.environment.dataHome,
    annotation: { alias: '保持原输入', tags: ['待验证'], note: '' } };
  await host.panels[0].receive({ ...request, dataHome: '/wrong-source' });
  assert.equal(writes, 0); assert.equal(host.panels[0].messages.at(-1).type, 'annotationError');
  await host.panels[0].receive({ ...request, id: 'not-in-snapshot' });
  assert.equal(writes, 0); assert.equal(host.panels[0].messages.at(-1).type, 'annotationError');
  await host.panels[0].receive(request);
  assert.equal(writes, 1); assert.equal(host.panels[0].messages.at(-1).message, 'disk unavailable');
  assert.equal(host.api.getSnapshot().nodes[0].annotation.alias, '');
});

test('node removal and restoration sync both views and survive refresh and workspace changes', async () => {
  const records = new Map();
  const storage = { get: key => records.get(key), update: async (key, value) => {
    if (value === undefined) records.delete(key); else records.set(key, value);
  } };
  const host = createHost('project', undefined, storage);
  host.commands.get('codexSessionTree.openHere')();
  const sidebar = host.createSidebar();
  await host.api.refresh(true);
  const before = structuredClone(host.api.getSnapshot()); const target = before.nodes[0];
  const request = { type: 'setNodeRemoved', id: target.id, dataHome: before.environment.dataHome, removed: true };
  await sidebar.receive(request);
  for (const view of host.panels) {
    assert.equal(view.messages.at(-1).type, 'nodeVisibilityUpdated');
    assert.equal(view.messages.at(-1).removed, true);
  }
  assert.equal(host.api.getSnapshot().nodes.length, before.nodes.length);
  assert.equal(host.api.getSnapshot().nodes[0].title, target.title);
  assert.equal(host.api.getSnapshot().nodes[0].removed, true);
  assert.equal(records.size, 1);
  await host.api.refresh(true);
  assert.equal(host.api.getSnapshot().nodes[0].removed, true);
  const reopened = createHost('another-project', undefined, storage); await reopened.api.refresh(true);
  assert.equal(reopened.api.getSnapshot().nodes[0].removed, true);
  await sidebar.receive({ ...request, removed: false });
  assert.equal(host.api.getSnapshot().nodes[0].removed, false); assert.equal(records.size, 0);
});

test('node removal rejects stale sources and unknown nodes and reports failed writes without hiding', async () => {
  let writes = 0;
  const host = createHost('project', undefined, { get: () => undefined, update: async () => { writes++; throw new Error('disk unavailable'); } });
  host.commands.get('codexSessionTree.openHere')(); await host.api.refresh(true);
  const snapshot = host.api.getSnapshot();
  const request = { type: 'setNodeRemoved', id: snapshot.nodes[0].id, dataHome: snapshot.environment.dataHome, removed: true };
  const view = host.panels[0];
  for (const invalid of [{ ...request, dataHome: '/wrong-home' }, { ...request, id: 'unknown' }, { ...request, removed: 'yes' }]) {
    await view.receive(invalid);
    assert.equal(view.messages.at(-1).type, 'nodeVisibilityError');
  }
  assert.equal(writes, 0);
  await view.receive(request);
  assert.equal(writes, 1); assert.equal(view.messages.at(-1).type, 'nodeVisibilityError');
  assert.equal(view.messages.at(-1).message, 'disk unavailable');
  assert.equal(host.api.getSnapshot().nodes[0].removed, false);
});

test('quick switch opens the selected item, persists recency, and synchronizes favorites', async () => {
  const values = new Map(); const storage = { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
  const host = createHost('project', undefined, storage);
  const sidebar = host.createSidebar();
  await host.commands.get('codexSessionTree.quickSwitch')();
  const picker = host.pickers[0]; const target = picker.items.find(item => item.id);
  await picker.handlers.button({ item: target });
  assert.equal(sidebar.messages.at(-1).type, 'favoriteUpdated');
  assert.equal(host.api.getSnapshot().nodes.find(n => n.id === target.id).favorite, true);
  picker.selectedItems = [target]; await picker.handlers.accept();
  assert.deepEqual(host.opened, [target.id]); assert.equal(picker.disposed, true);
  await host.api.refresh(true);
  assert.ok(host.api.getSnapshot().nodes.find(n => n.id === target.id).lastOpened > 0);
  await sidebar.receive({ type: 'open', id: target.id, dataHome: '/wrong-home' });
  assert.equal(host.opened.length, 1, 'A stale view cannot open a session in a different data home');
});

test('preview validates source and IDs before reading and returns errors tied to the request', async () => {
  const host = createHost('project'); const sidebar = host.createSidebar(); await host.api.refresh(true);
  const data = host.api.getSnapshot();
  const request = { type: 'loadDetails', requestId: '7', dataHome: data.environment.dataHome, ids: data.nodes.map(n => n.id) };
  await sidebar.receive({ ...request, dataHome: '/wrong' });
  assert.equal(host.scans.filter(args => args.includes('--preview')).length, 0);
  assert.ok(sidebar.messages.at(-1).details.every(item => item.error));
  await sidebar.receive({ ...request, ids: ['unknown'] });
  assert.equal(host.scans.filter(args => args.includes('--preview')).length, 0);
  await sidebar.receive(request);
  const response = sidebar.messages.at(-1);
  assert.equal(response.requestId, '7'); assert.equal(response.details.length, 2);
  assert.ok(response.details.every(item => item.history.question.text === 'source question'));
  const failing = createHost('project', undefined, undefined, { previewFailure: true });
  const view = failing.createSidebar(); await failing.api.refresh(true); await view.receive(request);
  assert.equal(view.messages.at(-1).details[0].error, 'history unavailable');
});
