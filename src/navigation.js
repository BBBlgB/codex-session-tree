'use strict';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function sessionUri(vscode, id) {
  if (!UUID.test(id)) throw new Error('无效的 Codex 会话 ID');
  // Verified against openai.chatgpt 26.901.22334: its URI handler forwards
  // /local/:conversationId to CodexWebviewProvider.navigateToRoute.
  return vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: 'openai.chatgpt', path: `/local/${id}` });
}

async function openSession(vscode, item) {
  if (!item || !item.available || item.missing) throw new Error('这个会话的本地历史记录不可用。');
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  if (!codex) throw new Error('请先安装 OpenAI 的 Codex 扩展（openai.chatgpt）。');
  await codex.activate();
  // VS Code attaches its window routing context here (windowId on desktop).
  // A bare vscode:// URI can otherwise be delivered to a different open window.
  const uri = await vscode.env.asExternalUri(sessionUri(vscode, item.id));
  // Keep the complete resolved URI; never reconstruct or cache its routing data.
  await vscode.commands.executeCommand('vscode.open', uri);
  return uri.toString();
}

module.exports = { sessionUri, openSession };
