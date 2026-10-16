# Codex 会话树

一个配合 OpenAI Codex 使用的 VS Code 扩展。侧栏用树形连线展示会话的分支关系，在编辑区可打开更宽的关系图。点击节点后，通过 Codex 扩展的会话入口打开该会话；悬停约 350 毫秒显示主题、模型和推理强度，移开后隐藏。

## 安装与使用

1. 安装 OpenAI 的 Codex 扩展（`openai.chatgpt`），并准备 Python 3.10 或更新版本。Windows 默认使用 `py -3`。
2. 在 VS Code 的扩展菜单中选择 **从 VSIX 安装**，选择 `codex-session-tree-0.1.0.vsix`。也可以运行：

   ```powershell
   code --install-extension ./codex-session-tree-0.1.0.vsix
   ```

3. 点击活动栏中的树形图标，或按 `Ctrl+Shift+P` 搜索 **Codex 会话树: 打开会话关系图**。
4. **分支家族**只显示有父子关系的一组会话；**全部会话**同时显示独立会话和关系未知的历史会话。搜索会保留命中节点所属的整个家族。可按当前项目、归档状态和子代理筛选。
5. 点击节点切换会话。首次调用时，VS Code 可能询问是否允许 Codex 的 URI 处理器打开链接；这是编辑器自身的确认。可在该提示中选择记住决定。

树中描边的节点表示“最近从本扩展请求打开的会话”。Codex 未提供当前活动会话的公开订阅接口，因此在 Codex 自身界面切换后，描边不会自动跟随。

## 数据与兼容范围

- 只读本机 `CODEX_HOME` 或 `~/.codex` 下的 `state_*.sqlite`、`session_index.jsonl` 和会话 JSONL。使用 SQLite 只读连接读取实时数据库，关闭连接后结束扫描；不复制 WAL、不更新数据库、不改写历史。
- 用户分支来自明确的 `session_meta.forked_from_id`。子代理派生关系单独标识，默认隐藏。旧会话缺少原始关系记录时显示“关系未知”，不按相似标题或相似内容猜测。
- 模型和强度优先使用数据库最近保存的字段；字段缺失时读取会话尾部最近的 `turn_context`。无记录则显示“未记录”。这不是整个会话所有轮次的模型清单，也不是对尚未发送的输入框设置的实时读取。
- 会话原始文件可能因 Codex 的分页存储迁移而不再存在。本扩展保留数据库中的索引。对于缺少可访问历史的记录，按钮会说明无法切换。
- 当前项目筛选按会话工作目录与打开的工作区目录匹配；若祖先被筛选隐藏，会保留淡色的祖先节点以呈现关系。
- 仅在视图可见时定期读取，默认每 10 秒刷新。无需 API key，无联网请求，不调用模型。
- 面向本机 VS Code 使用；远程 SSH / WSL 上的独立会话目录不在本版扫描范围内。
- 点击跳转使用 `vscode://openai.chatgpt/local/<会话 ID>`（Insiders 自动使用对应 scheme）。已核对 Codex **26.901.22334** 的 URI 处理器和 `/local/:conversationId` 路由。这是现有扩展内部路由，未来 Codex 更新可能需要适配；本扩展不会修改 Codex 安装文件。

## 设置

在设置中搜索 `codexSessionTree`：

| 设置 | 用途 |
| --- | --- |
| `codexSessionTree.codexHome` | 指定本机 Codex 数据目录，默认自动发现 |
| `codexSessionTree.pythonPath` | 指定 Python 3 可执行文件路径 |
| `codexSessionTree.refreshSeconds` | 自动刷新间隔，默认 10 秒 |

## 开发与验证

```powershell
git clone https://github.com/BBBlgB/codex-session-tree.git
cd codex-session-tree
npm ci --ignore-scripts
npm test
py -3 -X utf8 -m unittest discover -s test -p 'test_*.py'
npx playwright install chromium
node test/browser.js
node test/run-host.js
npm run package
```

浏览器测试使用 `test/fixtures/sessions.json` 中的虚构会话，扩展宿主测试使用临时生成的虚构会话目录，均不读取个人会话。截图和测试输出保存在忽略目录 `artifacts/`，不上传仓库或打入安装包。扩展宿主测试使用独立下载的 VS Code 1.141.2 和隔离用户目录，也可通过 `VSCODE_EXECUTABLE` 指定现有可执行文件路径。

可选执行 `node --test test/codex-contract.local.js`，检查本机已安装 Codex 扩展的内部 URI 路由。此检查依赖具体 Codex 版本；未安装时跳过。

仓库仅包含代码、文档、依赖锁文件与虚构测试数据，不包含个人会话、真实截图、数据库、凭据或本机验证记录。`.gitignore` 已排除这些开发产物。`publisher: local-tools` 是本地 VSIX 的扩展标识，不代表已发布到 VS Code Marketplace。

相关接口依据：[VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)、[VS Code URI Handler](https://code.visualstudio.com/api/references/vscode-api#window.registerUriHandler)。
