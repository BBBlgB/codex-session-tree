'use strict';
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');

async function run() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sessions.json'), 'utf8'));
  data.environment = { platform: 'linux', label: 'Linux · ssh-remote+example-host', workspace: 'example-project', dataHome: '/home/example/.codex' };
  const server = http.createServer((request, response) => {
    const name = request.url === '/' ? 'index.html' : request.url.slice(1);
    if (!['index.html', 'style.css', 'graph.js', 'app.js', 'bridge.js'].includes(name)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html');
    if (name === 'bridge.js') {
      response.end(`window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>{window.messages.push(m);if(m.type==='ready')setTimeout(()=>window.postMessage(${JSON.stringify({ type: 'data', ...data, workspacePaths: ['/example/project'] })},'*'),10)}});`); return;
    }
    let body = fs.readFileSync(path.join(root, 'media', name), 'utf8');
    if (name === 'index.html') body = body.replaceAll('{{cspSource}}', "'self'").replaceAll('{{nonce}}', 'test-nonce').replaceAll('{{styleUri}}', '/style.css')
      .replaceAll('{{graphUri}}', '/graph.js').replaceAll('{{appUri}}', '/app.js').replace('<script nonce=', '<script nonce="test-nonce" src="/bridge.js"></script><script nonce=');
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('.node');
    assert.ok((await page.locator('#environment').innerText()).includes('Linux · ssh-remote+example-host'));
    assert.ok((await page.locator('#environment-home').innerText()).includes('/home/example/.codex'));
    await page.locator('#expand').click();
    assert.ok((await page.evaluate(() => window.messages)).some(m => m.type === 'openPanel'));
    const child = data.nodes.find(item => item.relation === 'fork');
    assert.ok(child, 'Synthetic fixture must include a fork.');
    const card = page.locator(`button.node[data-id="${child.id}"]`);
    await card.hover();
    await page.locator('#tooltip').waitFor({ state: 'visible' });
    const tooltip = await page.locator('#tooltip').innerText();
    assert.ok(tooltip.includes(child.title)); assert.ok(tooltip.includes(child.model)); assert.ok(tooltip.includes(child.effort));
    assert.ok(await page.locator('path.edge').count());
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/demo-sessions.png') });
    await card.click();
    assert.ok((await page.evaluate(() => window.messages)).some(m => m.type === 'open' && m.id === child.id));
    assert.equal(await page.locator('#tooltip').isVisible(), false);
    await page.locator('.collapse').first().click();
    assert.equal(await page.locator(`button.node[data-id="${child.id}"]`).count(), 0);
    await page.locator('.collapse').first().click();
    await page.locator('#search').fill(child.title);
    assert.equal(await page.locator('.family').count(), 1);
    assert.ok(await page.locator(`button.node[data-id="${child.parentId}"]`).count());
    await page.setViewportSize({ width: 340, height: 760 });
    await card.hover();
    await page.locator('#tooltip').waitFor({ state: 'visible' });
    const box = await page.locator('#tooltip').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 340);
    await page.screenshot({ path: path.join(root, 'artifacts/demo-sidebar.png') });
    // Session text must be plain text even when it resembles executable HTML.
    await page.evaluate(snapshot => window.postMessage({ ...snapshot, type: 'data', nodes: snapshot.nodes.map(n => n.relation === 'fork' ? { ...n, title: '<img src=x onerror="window.injected=true">' } : n) }, '*'), data);
    await page.locator('#search').fill('onerror');
    assert.equal(await page.locator('.node img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.evaluate(() => window.postMessage({ type: 'dataUnavailable' }, '*'));
    await page.waitForFunction(() => document.querySelectorAll('.node').length === 0);
    assert.equal(await page.locator('#environment').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Browser: synthetic branch rendering, hover fields, hide, click message, collapse, search ancestry, narrow layout, and text escaping passed.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
