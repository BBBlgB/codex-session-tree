'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function createHost(name, remoteName, storage = { get: () => undefined, update: async () => {} }) {
  const panels = [], commands = new Map(), subscriptions = [];
  const disposable = { dispose() {} };
  const media = path.resolve(__dirname, '..');
  const vscode = {
    workspace: { name, workspaceFolders: [], onDidChangeConfiguration: () => disposable,
      getConfiguration: () => ({ get: (key, fallback) => fallback }) },
    env: { remoteName }, ViewColumn: { Active: -1 },
    Uri: { joinPath: (base, ...segments) => ({ fsPath: path.join(base.fsPath, ...segments) }) },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return disposable; } },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      registerWebviewViewProvider: () => disposable,
      createWebviewPanel: (kind, title) => {
        const panel = { title, visible: true, reveal() {}, dispose() {}, onDidDispose: () => disposable,
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
  const fakeProcess = { execFile: (command, args, options, callback) => { callback(null, fixture, ''); } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: id => id === 'vscode' ? vscode : id === 'node:child_process' ? fakeProcess : localRequire(id),
    module, process, setInterval: () => 0, clearInterval() {} }, { filename });
  const context = { subscriptions, extensionUri: { fsPath: media }, extensionPath: media,
    workspaceState: { get: () => '', update: async () => {} }, globalState: storage };
  const api = module.exports.activate(context);
  return { panels, commands, api };
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
