'use strict';

function quickItems(nodes, vscode) {
  const available = nodes.filter(node => node.available && !node.missing && !node.removed);
  const favorites = available.filter(node => node.favorite).sort((a, b) => b.lastOpened - a.lastOpened || b.updatedAt - a.updatedAt);
  const recent = available.filter(node => !node.favorite && node.lastOpened).sort((a, b) => b.lastOpened - a.lastOpened);
  const others = available.filter(node => !node.favorite && !node.lastOpened).sort((a, b) => b.updatedAt - a.updatedAt);
  return [['收藏', favorites], ['最近从插件打开', recent], ['其他会话', others]].flatMap(([label, items]) => items.length ? [
    { label, kind: vscode.QuickPickItemKind.Separator },
    ...items.map(node => ({ id: node.id, label: node.annotation?.alias || node.title,
      description: `${node.archived ? '已归档 · ' : ''}${node.cwd || '未记录项目'} · ${node.id.slice(0, 8)}`,
      detail: [node.title, ...(node.annotation?.tags || []), node.annotation?.note, node.annotation?.objective, node.annotation?.conclusion, node.annotation?.questions].filter(Boolean).join(' · ').replace(/\s+/g, ' '),
      buttons: [{ iconPath: new vscode.ThemeIcon(node.favorite ? 'star-full' : 'star-empty'), tooltip: node.favorite ? '取消收藏' : '收藏' }]
    }))
  ] : []);
}

module.exports = { quickItems };
