'use strict';
const { runTests } = require('@vscode/test-electron');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sessions.json'), 'utf8'));
const fixtureHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codex-session-tree-test-'));
const sessions = path.join(fixtureHome, 'sessions');
fs.mkdirSync(sessions);
for (const item of fixtures.nodes) {
  const records = [
    { type: 'session_meta', payload: { id: item.id, cwd: item.cwd, timestamp: new Date(item.createdAt).toISOString(), ...(item.parentId ? { forked_from_id: item.parentId } : {}) } },
    { type: 'turn_context', payload: { model: item.model, effort: item.effort } }
  ];
  fs.writeFileSync(path.join(sessions, `${item.id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n');
}
fs.writeFileSync(path.join(fixtureHome, 'session_index.jsonl'), fixtures.nodes.map(item => JSON.stringify({ id: item.id, thread_name: item.title })).join('\n') + '\n');
process.env.CODEX_HOME = fixtureHome;
// Codex's integrated terminal can inherit Electron's Node-only launch flag.
delete process.env.ELECTRON_RUN_AS_NODE;
runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
  version: '1.141.2',
  cachePath: path.join(root, 'artifacts', 'vscode-runtime'),
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(__dirname, 'host-smoke.js'),
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir', path.join(root, 'artifacts', 'vscode-test-user'), '--extensions-dir', path.join(root, 'artifacts', 'vscode-test-extensions')]
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  // Delete only this exact test-created directory, never a user CODEX_HOME.
  fs.rmSync(fixtureHome, { recursive: true });
});
