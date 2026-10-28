/* global acquireVsCodeApi, SessionGraph */
'use strict';
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const previous = vscode.getState() || {};
const state = { nodes: [], selectedId: '', workspacePaths: [], branches: previous.branches ?? true,
  query: previous.query || '', archived: previous.archived || false, agents: previous.agents || false,
  workspace: previous.workspace || false, showRemoved: previous.showRemoved || false,
  collapsed: new Set(previous.collapsed || []), expandedFamilies: new Set(previous.expandedFamilies || []) };
const changingVisibility = new Set();
let hoverTimer, activeHover, renderKey = '', edgeFrame, editing, savingAnnotation = false;
let searchFolds = new Map(), searchClosedFamilies = new Set(), matchIds = [], matchIndex = -1;
let comparison = [], detailsRequest = 0, detailIds = [], detailResults = new Map();
const effortNames = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: 'Ultra' };
const relationNames = { root: '起始会话', fork: '分支', agent: '子代理', unknown: '关系未知' };
function save() { const { branches, query, archived, agents, workspace, showRemoved, collapsed, expandedFamilies } = state; vscode.setState({ branches, query, archived, agents, workspace, showRemoved, collapsed: [...collapsed], expandedFamilies: [...expandedFamilies] }); }
function familyKey(id) { return JSON.stringify([state.dataHome, id]); }
function element(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录'; }
function displayTitle(item) { return item.annotation?.alias || item.title; }
function highlight(target, value) {
  const text = String(value || ''), query = state.query.trim().toLowerCase();
  if (!query) { target.textContent = text; return; }
  let offset = 0, next;
  while ((next = text.toLowerCase().indexOf(query, offset)) !== -1) {
    target.append(document.createTextNode(text.slice(offset, next)), element('mark', '', text.slice(next, next + query.length)));
    offset = next + query.length;
  }
  target.append(document.createTextNode(text.slice(offset)));
}
function hideTooltip() { clearTimeout(hoverTimer); activeHover = undefined; $('tooltip').hidden = true; }
function showTooltip(item, button) {
  clearTimeout(hoverTimer); activeHover = button;
  hoverTimer = setTimeout(() => {
    if (activeHover !== button) return;
    if ($('annotation-editor').open) return;
    const tooltip = $('tooltip'); tooltip.replaceChildren(element('div', 'tooltip-title', displayTitle(item)));
    const effort = item.effort ? `${effortNames[item.effort] || item.effort} (${item.effort})` : '未记录';
    const fields = [['模型', item.model || '未记录'], ['推理强度', effort], ['关系', relationNames[item.relation] || '关系未知'], ['更新时间', date(item.updatedAt)], ['工作目录', item.cwd || '未记录'], ['会话 ID', item.id]];
    if (item.annotation?.alias) fields.unshift(['原主题', item.title]);
    if (item.annotation?.tags?.length) fields.unshift(['标签', item.annotation.tags.join('、')]);
    for (const [label, value] of fields) {
      const row = element('div', 'tooltip-row'); row.append(element('span', 'tooltip-label', label), element('span', 'tooltip-value', value)); tooltip.append(row);
    }
    if (item.annotation?.note) tooltip.append(element('div', 'tooltip-note tooltip-annotation', item.annotation.note));
    if (item.removed) tooltip.append(element('div', 'tooltip-note', '此节点已从会话树移除，可点击恢复按钮重新显示。会话本身仍然保留。'));
    if (item.removedParent) tooltip.append(element('div', 'tooltip-note', '父节点已从会话树移除，此节点单独显示。'));
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
  button.classList.toggle('removed', !!item.removed);
  button.classList.toggle('has-children', item.children.length > 0);
  button.classList.toggle('search-match', item.selfMatch);
  button.setAttribute('aria-label', `${displayTitle(item)}，${(item.annotation?.tags || []).join('，')}，${relationNames[item.relation]}，${item.model || '模型未记录'}，${item.effort || '强度未记录'}。点击切换会话`);
  button.setAttribute('aria-describedby', 'tooltip');
  if (!item.available) button.setAttribute('aria-disabled', 'true');
  const title = element('span', 'node-title'); highlight(title, displayTitle(item)); button.append(title);
  if (item.selfMatch && !displayTitle(item).toLowerCase().includes(state.query.trim().toLowerCase())) {
    const hit = element('span', 'match-snippet');
    const text = String(item.matchText), at = text.toLowerCase().indexOf(state.query.trim().toLowerCase());
    highlight(hit, `${at > 40 ? '…' : ''}${text.slice(Math.max(0, at - 40), at + state.query.length + 80)}`); button.append(hit);
  }
  if (item.annotation?.tags?.length) {
    const tags = element('span', 'node-tags');
    for (const value of item.annotation.tags) { const tag = element('span', 'node-tag', value); tag.dataset.tag = value; tags.append(tag); }
    button.append(tags);
  }
  const meta = element('span', 'node-meta');
  meta.append(element('i', 'dot'), element('span', 'node-kind', item.missing ? '记录缺失' : relationNames[item.relation]));
  if (item.archived) meta.append(element('span', '', '· 已归档'));
  if (item.removed) meta.append(element('span', '', '· 已移除'));
  if (item.removedParent) meta.append(element('span', '', '· 父节点已移除'));
  meta.append(element('span', '', `· ${item.id.slice(0, 8)}`));
  if (item.annotation?.note) { const icon = element('span', 'node-note-icon', '▤'); icon.setAttribute('aria-label', '含备注'); meta.append(icon); }
  button.append(meta);
  button.addEventListener('mouseenter', () => showTooltip(item, button));
  button.addEventListener('mouseleave', hideTooltip);
  button.addEventListener('focus', () => showTooltip(item, button));
  button.addEventListener('blur', hideTooltip);
  button.addEventListener('click', () => {
    hideTooltip();
    if (!item.available) { showError('这个会话的本地历史记录不可用，无法切换。'); return; }
    $('status').textContent = '正在打开…';
    vscode.postMessage({ type: 'open', id: item.id, dataHome: state.dataHome });
  });
  wrap.append(button); branch.append(wrap);
  const edit = element('button', 'node-edit', '✎'); edit.type = 'button'; edit.dataset.id = item.id;
  edit.title = '编辑别名、标签与备注'; edit.setAttribute('aria-label', `编辑 ${displayTitle(item)} 的别名、标签与备注`);
  edit.addEventListener('click', () => openEditor(item)); wrap.append(edit);
  const remove = element('button', 'node-remove', item.removed ? '↶' : '×'); remove.type = 'button'; remove.dataset.id = item.id;
  remove.title = item.removed ? '恢复节点' : '从会话树移除（保留会话）';
  remove.setAttribute('aria-label', `${item.removed ? '恢复' : '移除'} ${displayTitle(item)} 的节点`);
  remove.disabled = changingVisibility.has(item.id);
  remove.addEventListener('click', () => {
    hideTooltip(); changingVisibility.add(item.id); remove.disabled = true; showError('');
    $('status').textContent = item.removed ? '正在恢复节点…' : '正在移除节点…';
    vscode.postMessage({ type: 'setNodeRemoved', id: item.id, dataHome: state.dataHome, removed: !item.removed });
  }); wrap.append(remove);
  const actions = element('div', 'node-actions');
  const preview = element('button', 'node-preview', '预览'); preview.dataset.id = item.id;
  preview.setAttribute('aria-label', `预览 ${displayTitle(item)}`);
  preview.onclick = () => openDetails([item.id]);
  const compare = element('button', 'node-compare', comparison.includes(item.id) ? '已选对照' : '加入对照'); compare.dataset.id = item.id;
  compare.setAttribute('aria-pressed', String(comparison.includes(item.id)));
  compare.onclick = () => {
    if (comparison.includes(item.id)) comparison = comparison.filter(id => id !== item.id);
    else if (comparison.length < 2) comparison.push(item.id);
    else { showError('已选择两个会话，请先取消一个，再加入新的对照会话。'); return; }
    showError(''); render();
  };
  actions.append(preview, compare); wrap.append(actions);
  if (item.children.length) {
    const searching = !!state.query.trim();
    const closed = searching ? searchFolds.get(item.id) ?? (state.collapsed.has(item.id) && !item.matches) : state.collapsed.has(item.id);
    const toggle = element('button', 'collapse', closed ? '+' : '−');
    toggle.setAttribute('aria-label', `${closed ? '展开' : '折叠'} ${displayTitle(item)} 的分支`);
    toggle.setAttribute('aria-expanded', String(!closed));
    toggle.addEventListener('click', () => {
      if (searching) searchFolds.set(item.id, !closed);
      else { closed ? state.collapsed.delete(item.id) : state.collapsed.add(item.id); save(); }
      render();
    });
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
  const focused = document.activeElement;
  const focusId = focused?.dataset.id, focusClass = focused?.classList[0];
  const scrolls = new Map([...document.querySelectorAll('.family')].map(f => [f.dataset.id, f.querySelector('.canvas')?.scrollLeft || 0]));
  $('branches').classList.toggle('active', state.branches); $('branches').setAttribute('aria-pressed', String(state.branches));
  $('all').classList.toggle('active', !state.branches); $('all').setAttribute('aria-pressed', String(!state.branches));
  const roots = SessionGraph.buildForest(state.nodes, state);
  const lastMatch = matchIds[matchIndex]; matchIds = [];
  const visit = item => { if (item.selfMatch) matchIds.push(item.id); item.children.forEach(visit); }; roots.forEach(visit);
  matchIndex = matchIds.indexOf(lastMatch);
  $('search-navigation').hidden = !state.query.trim();
  $('match-count').textContent = `${matchIds.length} 个匹配${matchIndex >= 0 ? ` · ${matchIndex + 1}/${matchIds.length}` : ''}`;
  $('previous-match').disabled = $('next-match').disabled = !matchIds.length;
  updateComparison();
  const forest = $('forest'); forest.replaceChildren();
  for (const root of roots) {
    const family = element('section', 'family'); family.dataset.id = root.id;
    const searching = !!state.query.trim();
    const expanded = searching ? !searchClosedFamilies.has(root.id) : state.expandedFamilies.has(familyKey(root.id));
    const heading = element('button', 'family-heading'); heading.type = 'button';
    heading.setAttribute('aria-expanded', String(expanded));
    heading.setAttribute('aria-label', `${expanded ? '收起' : '展开'} ${displayTitle(root)} 的会话树`);
    heading.append(element('span', 'family-chevron', expanded ? '▾' : '▸'));
    const label = element('span', 'family-label');
    label.append(element('span', 'family-title', displayTitle(root)));
    const normalized = (root.cwd || '').replaceAll('\\', '/').replace(/\/$/, '');
    const project = element('span', 'project', normalized.split('/').pop() || '未记录项目'); project.title = root.cwd;
    label.append(project);
    heading.append(label, element('span', 'family-count', `${root.size} 个会话`));
    heading.addEventListener('click', () => {
      if (searching) { expanded ? searchClosedFamilies.add(root.id) : searchClosedFamilies.delete(root.id); render(); return; }
      const key = familyKey(root.id);
      expanded ? state.expandedFamilies.delete(key) : state.expandedFamilies.add(key);
      save(); render();
    });
    family.append(heading);
    if (!expanded) { forest.append(family); continue; }
    const canvas = element('div', 'canvas'), scene = element('div', 'scene');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('edges'); svg.setAttribute('aria-hidden', 'true');
    scene.append(svg, makeBranch(root)); canvas.append(scene); family.append(canvas); forest.append(family);
  }
  $('count').textContent = `${roots.length} ${state.branches ? '个分支家族' : '组会话'} · ${roots.reduce((n, root) => n + root.size, 0)} 个节点`;
  $('empty').hidden = roots.length > 0;
  for (const family of forest.children) { const canvas = family.querySelector('.canvas'); if (canvas) canvas.scrollLeft = scrolls.get(family.dataset.id) || 0; }
  if (focusId) [...forest.querySelectorAll('[data-id]')].find(el => el.dataset.id === focusId && el.classList.contains(focusClass))?.focus({ preventScroll: true });
  drawEdges();
}
function updateComparison() {
  comparison = comparison.filter(id => state.nodes.some(n => n.id === id));
  $('compare-tray').hidden = !comparison.length;
  $('compare-selection').textContent = comparison.map(id => displayTitle(state.nodes.find(n => n.id === id))).join(' ↔ ');
  $('compare-open').disabled = comparison.length !== 2;
}
function jumpMatch(step) {
  if (!matchIds.length) return;
  matchIndex = matchIndex < 0 ? (step < 0 ? matchIds.length - 1 : 0) : (matchIndex + step + matchIds.length) % matchIds.length;
  const id = matchIds[matchIndex], nodes = new Map(state.nodes.map(n => [n.id, n]));
  let current = nodes.get(id); const seen = new Set();
  while (current && !seen.has(current.id)) { seen.add(current.id); searchFolds.delete(current.id); searchClosedFamilies.delete(current.id); current = nodes.get(current.parentId); }
  render();
  const target = [...document.querySelectorAll('button.node')].find(el => el.dataset.id === id);
  target?.scrollIntoView({ block: 'center', inline: 'center' }); target?.focus({ preventScroll: true });
}
function openDetails(ids) {
  hideTooltip(); detailIds = ids; detailResults = new Map(); detailsRequest++;
  renderDetails();
  if (!$('details-dialog').open) $('details-dialog').showModal();
  vscode.postMessage({ type: 'loadDetails', ids, dataHome: state.dataHome, requestId: String(detailsRequest) });
}
function detailSection(column, label, text) {
  const section = element('section', 'detail-section'); section.append(element('h4', '', label), element('div', 'detail-text', text || '未填写'));
  column.append(section); return section;
}
function renderDetails() {
  const comparing = detailIds.length === 2;
  $('details-dialog').classList.toggle('wide', comparing);
  $('details-title').textContent = comparing ? '分支对照' : '会话预览';
  const content = $('details-content'); content.classList.toggle('comparing', comparing); content.replaceChildren();
  $('details-context').textContent = comparing ? commonAncestorText() : '研究记录由你填写；下方对话摘录保留原文及来源。';
  for (const id of detailIds) {
    const item = state.nodes.find(n => n.id === id); if (!item) continue;
    const column = element('article', 'detail-column'); column.dataset.id = id;
    column.append(element('h3', '', displayTitle(item)), element('p', 'detail-meta', `${item.cwd || '未记录目录'} · ${item.model || '模型未记录'} · ${item.effort || '强度未记录'}`));
    const actions = element('div', 'detail-actions');
    const open = element('button', 'primary', '继续会话'); open.disabled = !item.available;
    open.onclick = () => { $('details-dialog').close(); vscode.postMessage({ type: 'open', id, dataHome: state.dataHome }); };
    const star = element('button', 'detail-favorite', item.favorite ? '★ 已收藏' : '☆ 收藏');
    star.onclick = () => { star.disabled = true; vscode.postMessage({ type: 'favorite', id, dataHome: state.dataHome, favorite: !item.favorite }); };
    const edit = element('button', '', '编辑研究记录'); edit.onclick = () => { $('details-dialog').close(); openEditor(item); document.querySelector('.research-editor').open = true; };
    actions.append(open, star, edit); column.append(actions);
    const annotation = item.annotation || {};
    const fields = [['objective', '目标'], ['conclusion', '结论'], ['questions', '待验证问题'], ['note', '备注']].filter(([key]) => comparing ? detailIds.some(other => state.nodes.find(n => n.id === other)?.annotation?.[key]) : annotation[key]);
    for (const [key, label] of fields) detailSection(column, label, annotation[key]);
    if (!fields.length) column.append(element('p', 'detail-meta', '尚未填写研究记录，可通过“编辑研究记录”补充目标、结论和待验证问题。'));
    if ((annotation.tags || []).length) detailSection(column, '标签', annotation.tags.join('、'));
    const result = detailResults.get(id);
    if (!result) column.append(element('p', 'detail-loading', '正在读取原文…'));
    else if (result.error) column.append(element('p', 'detail-error', result.error));
    else {
      const history = result.history;
      for (const [key, label] of [['question', '最近用户问题'], ['answer', history.answer?.final ? '最近最终回复' : '最近助手回复（未记录最终标记）']]) {
        const value = history[key];
        const section = detailSection(column, label, value ? value.text.slice(0, 1600) : '在本次读取范围内未找到');
        if (value) {
          if (value.text.length > 1600) {
            const more = element('details', 'full-excerpt'); more.append(element('summary', '', '展开本次读取的完整原文'), element('pre', 'detail-text', value.text)); section.append(more);
          }
          if (value.truncated) section.append(element('p', 'detail-warning', '该消息较长，已截取前 60,000 个字符。'));
          const source = element('details', 'detail-source'); source.append(element('summary', '', '原文来源'), element('p', '', `${value.timestamp ? date(value.timestamp) + '\n' : ''}${value.source}`)); section.append(source);
        }
      }
      detailSection(column, '历史中记录的文件（最多 20 个）', history.files.length ? history.files.join('\n') : '本次读取范围内无文件变更记录');
      for (const warning of history.warnings) column.append(element('p', 'detail-warning', warning));
      column.append(element('p', 'detail-meta', '最近问题与最近回复可能来自不同轮次；文件列表仅表示历史记录中的变更。'));
    }
    content.append(column);
  }
}
function commonAncestorText() {
  const nodes = new Map(state.nodes.map(n => [n.id, n]));
  const ancestors = id => { const ids = []; let node = nodes.get(id); while (node && !ids.includes(node.id)) { ids.push(node.id); node = nodes.get(node.parentId); } return ids; };
  const left = new Set(ancestors(detailIds[0]));
  const common = ancestors(detailIds[1]).find(id => left.has(id));
  return `${common ? `最近共同祖先：${displayTitle(nodes.get(common))}` : '现有关系记录中未找到共同祖先'}。目标、结论和待验证问题为手动记录，对话摘录为原文。`;
}
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
function editorBusy(busy) {
  savingAnnotation = busy;
  for (const control of $('annotation-form').elements) control.disabled = busy;
  $('editor-save').textContent = busy ? '正在保存…' : '保存';
}
function openEditor(item) {
  hideTooltip();
  editing = { id: item.id, dataHome: state.dataHome };
  const annotation = item.annotation || {};
  $('editor-original-title').textContent = item.title;
  $('node-alias').value = annotation.alias || '';
  $('node-note').value = annotation.note || '';
  for (const key of ['objective', 'conclusion', 'questions']) $(`node-${key}`).value = annotation[key] || '';
  for (const box of document.querySelectorAll('[name="node-tag"]')) box.checked = (annotation.tags || []).includes(box.value);
  $('editor-error').hidden = true; editorBusy(false);
  $('annotation-editor').showModal(); $('node-alias').focus();
}
function closeEditor() { if (!savingAnnotation) { $('annotation-editor').close(); editing = undefined; } }
$('editor-close').onclick = closeEditor; $('editor-cancel').onclick = closeEditor;
$('annotation-editor').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
$('editor-clear').onclick = () => {
  $('node-alias').value = ''; $('node-note').value = '';
  for (const key of ['objective', 'conclusion', 'questions']) $(`node-${key}`).value = '';
  for (const box of document.querySelectorAll('[name="node-tag"]')) box.checked = false;
  $('node-alias').focus();
};
$('annotation-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!editing || savingAnnotation) return;
  $('editor-error').hidden = true; editorBusy(true);
  vscode.postMessage({ type: 'saveAnnotation', ...editing, annotation: {
    alias: $('node-alias').value, note: $('node-note').value,
    objective: $('node-objective').value, conclusion: $('node-conclusion').value, questions: $('node-questions').value,
    tags: [...document.querySelectorAll('[name="node-tag"]:checked')].map(box => box.value)
  } });
});
for (const name of ['workspace', 'archived', 'agents', 'showRemoved']) {
  $(name).checked = state[name];
  $(name).addEventListener('change', () => { state[name] = $(name).checked; save(); render(); });
}
$('search').value = state.query;
$('search').addEventListener('input', () => { state.query = $('search').value; searchFolds.clear(); searchClosedFamilies.clear(); matchIndex = -1; matchIds = []; save(); render(); });
$('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); jumpMatch(event.shiftKey ? -1 : 1); } });
$('previous-match').onclick = () => jumpMatch(-1); $('next-match').onclick = () => jumpMatch(1);
$('compare-open').onclick = () => openDetails([...comparison]);
$('compare-clear').onclick = () => { comparison = []; render(); };
$('details-close').onclick = () => $('details-dialog').close();
$('details-refresh').onclick = () => openDetails([...detailIds]);
$('quick-switch').onclick = () => vscode.postMessage({ type: 'quickSwitch' });
function setBranches(value) { state.branches = value; save(); render(); }
$('branches').onclick = () => setBranches(true); $('all').onclick = () => setBranches(false); $('showAll').onclick = () => { state.query = ''; $('search').value = ''; setBranches(false); };
$('refresh').onclick = () => { $('status').textContent = '正在刷新…'; vscode.postMessage({ type: 'refresh' }); };
$('expand').onclick = () => vscode.postMessage({ type: 'openPanel' });
$('settings').onclick = () => vscode.postMessage({ type: 'settings' });
window.addEventListener('message', event => {
  const data = event.data;
  if (data.type === 'data') {
    state.nodes = data.nodes; state.selectedId = data.selectedId; state.workspacePaths = data.workspacePaths || [];
    const nextHome = data.environment?.dataHome;
    if (state.dataHome !== nextHome) { changingVisibility.clear(); comparison = []; detailIds = []; detailResults.clear(); $('details-dialog').close(); detailsRequest++; searchFolds.clear(); searchClosedFamilies.clear(); }
    if (editing && editing.dataHome !== nextHome) { editorBusy(false); closeEditor(); }
    state.dataHome = nextHome;
    state.platform = data.environment?.platform;
    $('environment').hidden = !data.environment;
    if (data.environment) {
      $('environment-label').textContent = data.environment.label;
      $('environment-workspace').textContent = `当前窗口：${data.environment.workspace}`;
      $('environment-home').textContent = `会话目录：${data.environment.dataHome}`;
    }
    const key = JSON.stringify([data.nodes, data.selectedId, state.workspacePaths, state.platform, state.dataHome]);
    if (key !== renderKey) { renderKey = key; render(); }
    $('status').textContent = `更新于 ${new Date(data.scannedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
    showError((data.warnings || []).join('\n'));
  } else if (data.type === 'dataUnavailable') {
    changingVisibility.clear(); comparison = []; detailIds = []; detailResults.clear(); $('details-dialog').close(); detailsRequest++;
    editorBusy(false); closeEditor(); state.dataHome = undefined;
    state.nodes = []; renderKey = ''; $('environment').hidden = true; render();
    $('count').textContent = '当前环境的会话数据不可用'; $('empty').hidden = true;
  } else if (data.type === 'details') {
    if (state.dataHome !== data.dataHome || String(detailsRequest) !== data.requestId || !$('details-dialog').open) return;
    detailResults = new Map(data.details.map(value => [value.id, value])); renderDetails();
  } else if (data.type === 'favoriteUpdated' || data.type === 'favoriteError') {
    if (state.dataHome !== data.dataHome) return;
    const item = state.nodes.find(n => n.id === data.id);
    if (item && data.type === 'favoriteUpdated') item.favorite = data.favorite;
    if (data.type === 'favoriteError') { showError(data.message); if ($('details-dialog').open) $('details-context').textContent = data.message; }
    if ($('details-dialog').open) { renderDetails(); if (data.type === 'favoriteError') $('details-context').textContent = data.message; }
  } else if (data.type === 'nodeVisibilityUpdated' || data.type === 'nodeVisibilityError') {
    if (state.dataHome !== data.dataHome) return;
    changingVisibility.delete(data.id);
    if (data.type === 'nodeVisibilityUpdated') {
      const item = state.nodes.find(node => node.id === data.id);
      if (item) item.removed = data.removed;
      $('status').textContent = data.removed ? '节点已从会话树移除，会话仍保留' : '节点已恢复';
    } else {
      showError(data.message); $('status').textContent = '操作未完成';
    }
    renderKey = ''; render();
  } else if (data.type === 'annotationSaved' || data.type === 'annotationUpdated') {
    if (state.dataHome === data.dataHome) {
      const item = state.nodes.find(node => node.id === data.id);
      if (item) item.annotation = data.annotation;
      if (data.type === 'annotationSaved' && editing?.id === data.id && editing.dataHome === data.dataHome) { editorBusy(false); closeEditor(); }
      renderKey = ''; render(); $('status').textContent = '节点信息已保存';
    }
  } else if (data.type === 'annotationError') {
    if (editing?.id === data.id) { editorBusy(false); $('editor-error').textContent = data.message; $('editor-error').hidden = false; }
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
