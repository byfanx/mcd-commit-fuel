# mcd-commit-fuel

> 代码换麦麦：根据本地 git 提交与构建节奏，在 VS Code / Claude Code 状态栏给出麦当劳积分、优惠券与餐品推荐。

> ⚠️ 本项目为麦当劳程序员节创意开发大赛参赛作品，由参赛者独立开发，**非麦当劳官方产品**。餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准。

🚧 项目开发中，以下为规划内容，完成后会补充安装方法与使用演示。

## 它做什么

- **读节奏**：在本地分析 git 提交、发版 tag、构建耗时与测试结果，判断你当前的开发状态（专注中 / 构建等待 / 卡 bug / 刚发版 / 收工）。
- **轻提示**：在 VS Code 状态栏或 Claude Code statusline 安静地展示积分、可领券和与当前状态匹配的餐品建议。
- **Commit 小票**：把今天的提交换成一张麦麦小票，方便分享。
- **点单需确认**：领券、下单等写操作只能手动触发并二次确认，不做任何自动下单。

## 隐私与安全

- 代码、提交信息只在本机读取，不会上传。
- MCP Token 存放在 VS Code SecretStorage 或环境变量 `MCD_MCP_TOKEN` 中，仓库内仅保留占位符，见 [mcp-config.example.json](./mcp-config.example.json)。

## 目标用户

日常使用 VS Code 或 Claude Code 写代码、也爱吃麦当劳的开发者。

## 相关文档

- [MCP_INTEGRATION.md](./MCP_INTEGRATION.md)：使用的麦当劳 MCP Tool 与调用流程
- [CONTEST_DECLARATION.md](./CONTEST_DECLARATION.md)：参赛声明
- [LICENSE](./LICENSE)：MIT
