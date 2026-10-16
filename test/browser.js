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
      response.end(`
        window.messages=[];
        const fixture=${JSON.stringify({ type: 'data', ...data, workspacePaths: ['/example/project'] })};
        window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>{
          window.messages.push(m);
          if(m.type==='ready')setTimeout(()=>window.postMessage({...fixture,nodes:fixture.nodes.map(n=>({...n,annotation:JSON.parse(localStorage.getItem(n.id)||'null')}))},'*'),10);
          if(m.type==='saveAnnotation')setTimeout(()=>{
            if(window.rejectSave){window.postMessage({type:'annotationError',id:m.id,message:'模拟存储失败'},'*');return;}
            localStorage.setItem(m.id,JSON.stringify(m.annotation));
            window.postMessage({type:'annotationSaved',id:m.id,annotation:m.annotation,dataHome:m.dataHome},'*');
          },10);
        }});
      `); return;
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
    const edit = page.locator(`.node-edit[data-id="${child.id}"]`);
    const openCount = await page.evaluate(() => window.messages.filter(m => m.type === 'open').length);
    await edit.click();
    assert.equal(await page.locator('#annotation-editor').isVisible(), true);
    assert.equal(await page.evaluate(() => window.messages.filter(m => m.type === 'open').length), openCount);
    assert.equal(await page.locator('#editor-original-title').innerText(), child.title);
    await page.locator('#node-alias').fill('方案 A · 等待评审');
    await page.locator('[name="node-tag"][value="进行中"]').check();
    await page.locator('[name="node-tag"][value="待验证"]').check();
    await page.locator('#node-note').fill('用于讨论接口。\n核对边界条件后再继续。');
    // An automatic scan must not erase a form being edited.
    await page.evaluate(snapshot => window.postMessage({ type: 'data', ...snapshot }, '*'), data);
    assert.equal(await page.locator('#node-alias').inputValue(), '方案 A · 等待评审');
    // Updates from the other view may refresh the graph, but never close or
    // replace this view's unsaved draft for the same node.
    await page.evaluate(({ id, dataHome }) => window.postMessage({ type: 'annotationUpdated', id, dataHome,
      annotation: { alias: '另一个视图保存的别名', tags: ['已完成'], note: '另一份备注' } }, '*'), { id: child.id, dataHome: data.environment.dataHome });
    assert.equal(await page.locator('#annotation-editor').isVisible(), true);
    assert.equal(await page.locator('#node-alias').inputValue(), '方案 A · 等待评审');
    const editorBox = await page.locator('#annotation-editor').boundingBox();
    assert.ok(editorBox.x >= 0 && editorBox.x + editorBox.width <= 340);
    await page.screenshot({ path: path.join(root, 'artifacts/demo-node-editor.png') });
    await page.locator('#editor-save').click();
    await page.locator('#annotation-editor').waitFor({ state: 'hidden' });
    assert.equal(await card.locator('.node-title').innerText(), '方案 A · 等待评审');
    assert.equal(await card.locator('.node-tag').count(), 2);
    await card.hover(); await page.locator('#tooltip').waitFor({ state: 'visible' });
    const annotatedTooltip = await page.locator('#tooltip').innerText();
    for (const text of ['方案 A · 等待评审', child.title, '进行中', '待验证', '核对边界条件']) assert.ok(annotatedTooltip.includes(text));
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.screenshot({ path: path.join(root, 'artifacts/demo-annotations.png') });
    await page.reload(); await page.waitForSelector('.node');
    assert.equal(await card.locator('.node-title').innerText(), '方案 A · 等待评审');
    await page.locator('#search').fill('核对边界条件'); assert.equal(await page.locator('.family').count(), 1);
    await edit.click();
    assert.equal(await page.locator('#node-note').inputValue(), '用于讨论接口。\n核对边界条件后再继续。');
    await page.locator('#node-alias').fill('不保存的修改'); await page.locator('#editor-cancel').click();
    assert.equal(await card.locator('.node-title').innerText(), '方案 A · 等待评审');
    await edit.click();
    await page.evaluate(() => { window.rejectSave = true; });
    await page.locator('#node-alias').fill('<img src=x onerror="window.injected=true">');
    await page.locator('#editor-save').click(); await page.locator('#editor-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#annotation-editor').isVisible(), true);
    assert.equal(await page.locator('#editor-save').isEnabled(), true);
    assert.equal(await card.locator('.node-title').innerText(), '方案 A · 等待评审');
    await page.evaluate(() => { window.rejectSave = false; });
    await page.locator('#editor-save').click(); await page.locator('#annotation-editor').waitFor({ state: 'hidden' });
    assert.equal(await card.locator('img').count(), 0);
    assert.ok((await card.locator('.node-title').innerText()).includes('<img'));
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await edit.click(); await page.locator('#editor-clear').click();
    assert.equal(await page.locator('#node-alias').inputValue(), '');
    await page.locator('#editor-save').click(); await page.locator('#annotation-editor').waitFor({ state: 'hidden' });
    await page.locator('#search').fill('');
    assert.equal(await card.locator('.node-title').innerText(), child.title);
    assert.equal(await card.locator('.node-tag').count(), 0);
    assert.equal(await card.locator('.node-note-icon').count(), 0);
    // Session text must be plain text even when it resembles executable HTML.
    await page.evaluate(snapshot => window.postMessage({ ...snapshot, type: 'data', nodes: snapshot.nodes.map(n => n.relation === 'fork' ? { ...n, title: '<img src=x onerror="window.injected=true">' } : n) }, '*'), data);
    await page.locator('#search').fill('onerror');
    assert.equal(await page.locator('.node img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.evaluate(() => window.postMessage({ type: 'dataUnavailable' }, '*'));
    await page.waitForFunction(() => document.querySelectorAll('.node').length === 0);
    assert.equal(await page.locator('#environment').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Browser: tree/navigation regressions, alias/tags/multiline notes, save/reload, cancel/clear, storage failure recovery, live refresh, search, narrow editor and text escaping passed.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
