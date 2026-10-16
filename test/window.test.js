'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function createHost(name, remoteName) {
  const panels = [], commands = new Map(), subscriptions = [];
  const disposable = { dispose() {} };
  const media = path.resolve(__dirname, '..');
  const vscode = {
    workspace: { name, workspaceFolders: [], onDidChangeConfiguration: () => disposable },
    env: { remoteName }, ViewColumn: { Active: -1 },
    Uri: { joinPath: (base, ...segments) => ({ fsPath: path.join(base.fsPath, ...segments) }) },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return disposable; } },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      registerWebviewViewProvider: () => disposable,
      createWebviewPanel: (kind, title) => {
        const panel = { title, visible: true, reveal() {}, dispose() {}, onDidDispose: () => disposable,
          webview: { cspSource: 'https://example.invalid', asWebviewUri: uri => ({ toString: () => uri.fsPath }),
            onDidReceiveMessage: () => disposable, postMessage() {} } };
        panels.push(panel); return panel;
      }
    }
  };
  const filename = path.join(media, 'src/extension.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: id => id === 'vscode' ? vscode : localRequire(id),
    module, process, setInterval: () => 0, clearInterval() {} }, { filename });
  const context = { subscriptions, extensionUri: { fsPath: media }, extensionPath: media,
    workspaceState: { get: () => '', update: async () => {} } };
  module.exports.activate(context);
  return { panels, commands };
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
