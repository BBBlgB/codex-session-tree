/* global acquireVsCodeApi, SessionGraph */
'use strict';
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const previous = vscode.getState() || {};
const state = { nodes: [], selectedId: '', workspacePaths: [], branches: previous.branches ?? true,
  query: previous.query || '', archived: previous.archived || false, agents: previous.agents || false,
  workspace: previous.workspace || false, collapsed: new Set(previous.collapsed || []) };
let hoverTimer, activeHover, renderKey = '', edgeFrame;
const effortNames = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: 'Ultra' };
const relationNames = { root: '起始会话', fork: '分支', agent: '子代理', unknown: '关系未知' };
function save() { const { branches, query, archived, agents, workspace, collapsed } = state; vscode.setState({ branches, query, archived, agents, workspace, collapsed: [...collapsed] }); }
function element(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录'; }
function hideTooltip() { clearTimeout(hoverTimer); activeHover = undefined; $('tooltip').hidden = true; }
function showTooltip(item, button) {
  clearTimeout(hoverTimer); activeHover = button;
  hoverTimer = setTimeout(() => {
    if (activeHover !== button) return;
    const tooltip = $('tooltip'); tooltip.replaceChildren(element('div', 'tooltip-title', item.title));
    const effort = item.effort ? `${effortNames[item.effort] || item.effort} (${item.effort})` : '未记录';
    for (const [label, value] of [['模型', item.model || '未记录'], ['推理强度', effort], ['关系', relationNames[item.relation] || '关系未知'], ['更新时间', date(item.updatedAt)], ['工作目录', item.cwd || '未记录'], ['会话 ID', item.id]]) {
      const row = element('div', 'tooltip-row'); row.append(element('span', 'tooltip-label', label), element('span', 'tooltip-value', value)); tooltip.append(row);
    }
    tooltip.append(element('div', 'tooltip-note', '模型与强度来自最近保存的元数据。' + (item.relation === 'unknown' ? ' 原始分支记录缺失，未推断父子关系。' : '') + (!item.available ? ' 本地历史记录不可用。' : '')));
    tooltip.hidden = false;
    const rect = button.getBoundingClientRect();
    tooltip.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 10))}px`;
    tooltip.style.top = `${Math.max(8, rect.bottom + tooltip.offsetHeight + 14 <= window.innerHeight ? rect.bottom + 8 : Math.min(rect.top - tooltip.offsetHeight - 8, window.innerHeight - tooltip.offsetHeight - 8))}px`;
  }, 350);
}
function makeBranch(item) {
  const branch = element('div', 'branch'); branch.dataset.id = item.id;
  const wrap = element('div', 'node-wrap');
  const button = element('button', 'node'); button.type = 'button'; button.dataset.id = item.id;
  button.classList.toggle('selected', item.id === state.selectedId);
  button.classList.toggle('context', item.contextOnly || !!item.missing);
  button.classList.toggle('has-children', item.children.length > 0);
  button.setAttribute('aria-label', `${item.title}，${relationNames[item.relation]}，${item.model || '模型未记录'}，${item.effort || '强度未记录'}。点击切换会话`);
  button.setAttribute('aria-describedby', 'tooltip');
  if (!item.available) button.setAttribute('aria-disabled', 'true');
  button.append(element('span', 'node-title', item.title));
  const meta = element('span', 'node-meta');
  meta.append(element('i', 'dot'), element('span', 'node-kind', item.missing ? '记录缺失' : relationNames[item.relation]));
  if (item.archived) meta.append(element('span', '', '· 已归档'));
  meta.append(element('span', '', `· ${item.id.slice(0, 8)}`));
  button.append(meta);
  button.addEventListener('mouseenter', () => showTooltip(item, button));
  button.addEventListener('mouseleave', hideTooltip);
  button.addEventListener('focus', () => showTooltip(item, button));
  button.addEventListener('blur', hideTooltip);
  button.addEventListener('click', () => {
    hideTooltip();
    if (!item.available) { showError('这个会话的本地历史记录不可用，无法切换。'); return; }
    $('status').textContent = '正在打开…';
    vscode.postMessage({ type: 'open', id: item.id });
  });
  wrap.append(button); branch.append(wrap);
  if (item.children.length) {
    const closed = state.collapsed.has(item.id);
    const toggle = element('button', 'collapse', closed ? '+' : '−');
    toggle.setAttribute('aria-label', `${closed ? '展开' : '折叠'} ${item.title} 的分支`);
    toggle.setAttribute('aria-expanded', String(!closed));
    toggle.addEventListener('click', () => { closed ? state.collapsed.delete(item.id) : state.collapsed.add(item.id); save(); render(); });
    wrap.append(toggle);
    if (!closed) {
      const children = element('div', 'children');
      for (const child of item.children) { const el = makeBranch(child); el.dataset.parent = item.id; el.dataset.relation = child.relation; children.append(el); }
      branch.append(children);
    }
  }
  return branch;
}
function drawEdges() {
  cancelAnimationFrame(edgeFrame);
  edgeFrame = requestAnimationFrame(() => {
    for (const scene of document.querySelectorAll('.scene')) {
      const svg = scene.querySelector('.edges'); svg.replaceChildren();
      const origin = scene.getBoundingClientRect();
      const buttons = new Map([...scene.querySelectorAll('.node')].map(el => [el.dataset.id, el]));
      const compact = window.innerWidth <= 600;
      for (const branch of scene.querySelectorAll('.branch[data-parent]')) {
        const parent = buttons.get(branch.dataset.parent), child = buttons.get(branch.dataset.id);
        if (!parent || !child) continue;
        const p = parent.getBoundingClientRect(), c = child.getBoundingClientRect();
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        let d;
        if (compact) {
          const x1 = p.left - origin.left + 7, y1 = p.bottom - origin.top, x2 = c.left - origin.left, y2 = c.top - origin.top + c.height / 2;
          d = `M ${x1} ${y1} V ${y2 - 5} Q ${x1} ${y2} ${x1 + 5} ${y2} H ${x2}`;
        } else {
          const x1 = p.right - origin.left, y1 = p.top - origin.top + p.height / 2, x2 = c.left - origin.left, y2 = c.top - origin.top + c.height / 2, mx = (x1 + x2) / 2;
          d = `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
        }
        line.setAttribute('d', d); line.setAttribute('class', `edge ${branch.dataset.relation === 'agent' ? 'agent' : ''}`); svg.append(line);
      }
    }
  });
}
function render() {
  hideTooltip();
  $('branches').classList.toggle('active', state.branches); $('branches').setAttribute('aria-pressed', String(state.branches));
  $('all').classList.toggle('active', !state.branches); $('all').setAttribute('aria-pressed', String(!state.branches));
  const roots = SessionGraph.buildForest(state.nodes, state);
  const forest = $('forest'); forest.replaceChildren();
  for (const root of roots) {
    const family = element('section', 'family');
    const heading = element('div', 'family-heading');
    const normalized = (root.cwd || '').replaceAll('\\', '/').replace(/\/$/, '');
    const project = element('span', 'project', normalized.split('/').pop() || '未记录项目'); project.title = root.cwd;
    heading.append(project, element('span', 'family-count', `${root.size} 个会话`));
    const canvas = element('div', 'canvas'), scene = element('div', 'scene');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('edges'); svg.setAttribute('aria-hidden', 'true');
    scene.append(svg, makeBranch(root)); canvas.append(scene); family.append(heading, canvas); forest.append(family);
  }
  $('count').textContent = `${roots.length} ${state.branches ? '个分支家族' : '组会话'} · ${roots.reduce((n, root) => n + root.size, 0)} 个节点`;
  $('empty').hidden = roots.length > 0;
  drawEdges();
}
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
for (const name of ['workspace', 'archived', 'agents']) {
  $(name).checked = state[name];
  $(name).addEventListener('change', () => { state[name] = $(name).checked; save(); render(); });
}
$('search').value = state.query;
$('search').addEventListener('input', () => { state.query = $('search').value; save(); render(); });
function setBranches(value) { state.branches = value; save(); render(); }
$('branches').onclick = () => setBranches(true); $('all').onclick = () => setBranches(false); $('showAll').onclick = () => { state.query = ''; $('search').value = ''; setBranches(false); };
$('refresh').onclick = () => { $('status').textContent = '正在刷新…'; vscode.postMessage({ type: 'refresh' }); };
$('expand').onclick = () => vscode.postMessage({ type: 'openPanel' });
$('settings').onclick = () => vscode.postMessage({ type: 'settings' });
window.addEventListener('message', event => {
  const data = event.data;
  if (data.type === 'data') {
    state.nodes = data.nodes; state.selectedId = data.selectedId; state.workspacePaths = data.workspacePaths || [];
    const key = JSON.stringify([data.nodes, data.selectedId, state.workspacePaths]);
    if (key !== renderKey) { renderKey = key; render(); }
    $('status').textContent = `更新于 ${new Date(data.scannedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
    showError((data.warnings || []).join('\n'));
  } else if (data.type === 'error') { showError(data.message); $('status').textContent = '操作未完成'; }
  else if (data.type === 'selected') {
    state.selectedId = data.id;
    for (const el of document.querySelectorAll('.node')) el.classList.toggle('selected', el.dataset.id === data.id);
    $('status').textContent = '已请求切换';
  }
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
window.addEventListener('scroll', hideTooltip, true);
window.addEventListener('resize', hideTooltip);
new ResizeObserver(drawEdges).observe(document.body);
vscode.postMessage({ type: 'ready' });
