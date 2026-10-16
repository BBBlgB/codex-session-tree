'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Verify the integration against the installed Codex handler without activating
// the agent or sending messages. This is distinct from testing our URI builder.
test('installed Codex URI handler forwards the local conversation route', async t => {
  const extensions = path.join(os.homedir(), '.vscode', 'extensions');
  if (!fs.existsSync(extensions)) { t.skip('Codex installation is not available'); return; }
  const directory = fs.readdirSync(extensions).filter(n => n.startsWith('openai.chatgpt-')).sort().at(-1);
  if (!directory) { t.skip('Codex installation is not available'); return; }
  const source = fs.readFileSync(path.join(extensions, directory, 'out', 'extension.js'), 'utf8');
  const handler = source.match(/var (\w+)=class\{constructor\(e,r\)\{this\.codexWebviewProvider=e;this\.ideAppEntryLifecycle=r\}async handleUri\(e\).*?(?=;var )/s);
  assert.ok(handler, 'Review the URI handler contract after a Codex upgrade');
  let sidebarOpened = false;
  const context = vm.createContext({ Y: () => ({ info() {}, error(error) { throw error; } }), Us: async () => { sidebarOpened = true; } });
  vm.runInContext(`${handler[0]}; globalThis.Handler = ${handler[1]}`, context);
  const forwarded = [];
  const instance = new context.Handler({ navigateToRoute: route => forwarded.push(route) }, { handleDeepLink() {} });
  const id = '11111111-1111-4111-8111-111111111111';
  await instance.handleUri({ path: `/local/${id}`, query: '', toString: () => `vscode://openai.chatgpt/local/${id}` });
  assert.equal(sidebarOpened, true);
  assert.deepEqual(forwarded, [`/local/${id}`]);
  assert.ok(source.includes('"/local"') && source.includes('/:conversationId'));
});
