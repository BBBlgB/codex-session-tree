'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sessionUri } = require('../src/navigation');

async function run() {
  const extension = vscode.extensions.getExtension('local-tools.codex-session-tree');
  assert.ok(extension, 'VS Code discovers this extension');
  const api = await extension.activate();
  await vscode.commands.executeCommand('codexSessionTree.openHere');
  await api.refresh(true);
  const snapshot = api.getSnapshot();
  assert.equal(snapshot?.nodes.length, 2);
  assert.ok(snapshot.nodes.every(node => node.cwd === '/example/project'));
  assert.equal(snapshot.environment.platform, process.platform);
  assert.equal(snapshot.environment.dataHome, process.env.CODEX_HOME);
  assert.equal(snapshot.environment.workspace, vscode.workspace.name);
  assert.ok(api.getPanelTitle().includes(vscode.workspace.name));
  const target = await vscode.env.asExternalUri(sessionUri(vscode, snapshot.nodes[0].id));
  assert.equal(target.scheme, vscode.env.uriScheme);
  assert.ok(new URLSearchParams(target.query).get('windowId'), 'Desktop VS Code must bind the navigation URI to this window');
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('codexSessionTree.open'));
  assert.ok(commands.includes('codexSessionTree.openHere'));
  assert.ok(commands.includes('codexSessionTree.refresh'));
  assert.ok(commands.includes('codexSessionTree.quickSwitch'));
  await vscode.commands.executeCommand('codexSessionTree.quickSwitch');
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  fs.mkdirSync(path.join(extension.extensionPath, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(extension.extensionPath, 'artifacts/host-smoke.json'), JSON.stringify({
    vscode: vscode.version, extensionActive: extension.isActive, indexedNodes: snapshot.nodes.length,
    branches: snapshot.nodes.filter(n => n.relation === 'fork').length, warnings: snapshot.warnings
  }, null, 2));
  console.log('VS Code extension host activation, panel creation, commands, and synthetic index passed.');
}
module.exports = { run };
