'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function run() {
  const extension = vscode.extensions.getExtension('local-tools.codex-session-tree');
  assert.ok(extension, 'VS Code discovers this extension');
  const api = await extension.activate();
  await vscode.commands.executeCommand('codexSessionTree.open');
  await api.refresh(true);
  const snapshot = api.getSnapshot();
  assert.equal(snapshot?.nodes.length, 2);
  assert.ok(snapshot.nodes.every(node => node.cwd === '/example/project'));
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('codexSessionTree.open'));
  assert.ok(commands.includes('codexSessionTree.refresh'));
  fs.mkdirSync(path.join(extension.extensionPath, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(extension.extensionPath, 'artifacts/host-smoke.json'), JSON.stringify({
    vscode: vscode.version, extensionActive: extension.isActive, indexedNodes: snapshot.nodes.length,
    branches: snapshot.nodes.filter(n => n.relation === 'fork').length, warnings: snapshot.warnings
  }, null, 2));
  console.log('VS Code extension host activation, panel creation, commands, and synthetic index passed.');
}
module.exports = { run };
