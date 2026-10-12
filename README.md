# 麦麦代码补给站（mcd-commit-fuel）

> 根据本地 git 提交与构建节奏，在 VS Code / Claude Code 状态栏给出麦当劳积分、优惠券与按餐段推荐的餐品。代码不出本机，下单需确认。

> ⚠️ 本项目为麦当劳程序员节创意开发大赛参赛作品，由参赛者独立开发，**非麦当劳官方产品**。餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准；营养信息仅供参考，不构成医疗或营养建议。

## 它做什么

在本地读取你的开发节奏，判断当前状态，只在合适的时候安静地给一句提示：

| 状态 | 什么时候出现 | 状态栏 |
|---|---|---|
| 空闲 / 专注中 | 默认；30 分钟内提交 ≥ 2 次算专注，不打扰 | `🍟 1200分 · 6券` |
| 构建等待 | 构建或测试运行超过 3 分钟 | `⏳ 构建中 · 收藏门店 3 张券可用` |
| 卡 bug | 20 分钟内测试连续失败 3 次，或 1 小时内 revert 2 次 | 按餐段推荐，如下午 `☕ 下午茶？锡兰红茶 2kcal` |
| 刚发版 | 30 分钟内打了 release tag（如 `v1.2.0`） | `🎉 发版了 · 请团队吃一顿？` |
| 收工 | 今天有提交，且已空闲 90 分钟 | `🧾 收工了 · 今日小票` |

- 本月有积分即将过期时，状态栏会加上 `⚠过期`。
- 同一类提醒每天最多 2 次，超过后只显示积分和券数。
- 3 天内到期、到店可用的券会在状态栏提示（如 `🍟 1200分 · 6券 · 2张临期`），点开后点击就能用这张券下单。
- 餐品按餐段推荐（见下方[按餐段推荐](#按餐段推荐)），所有推荐都附热量和营养信息。
- **Commit 小票**：把今天的提交、测试、构建耗时换成一张字符画小票：

```
================================
    MCD COMMIT FUEL 今日小票
--------------------------------
日期                  2026-10-10
时段               10:43 - 18:20
提交                        x 12
Revert                       x 1
测试             通过 8 / 失败 3
构建与测试耗时           14 分钟
--------------------------------
今日推荐                  苹果片
                         32 kcal
              蛋白质 0g · 钠 0mg
--------------------------------
积分                        1200
可用券                      6 张
================================
   代码不出本机 · 下单需确认
```

- **点单、团餐和领券**（VS Code）：手动触发，弹窗二次确认后才会调用写接口，支付在麦当劳 App 中完成。
  - 点一份餐品：到店自取，可以选收藏门店，也可以按城市和门店名搜索，按当前餐段推荐。
  - 用券下单：在详情里点击一张到店可用的券。
  - 请团队吃一顿：团餐外送到你在麦当劳 App 中保存的地址，默认 2~4 人，也可以自定义人数。每人一个汉堡加一杯饮品，小食共享，确认框里列出人均热量和人均价格。没有地址时会提示先去 App 里添加。

### 按餐段推荐

先看餐品是否适合这个时间，再看热量。常点的排在最前；有收藏门店时只推荐这家店当前在卖的。薯条、甜品冰品和套餐不主动推荐。

| 餐段 | 时间 | 推荐 | 每份热量上限 |
|---|---|---|---|
| 早餐 | 06:00–10:30 | 粥、豆浆、麦满分、咖啡 | 500 kcal |
| 午餐 / 晚餐 | 11:00–13:30 / 17:30–20:00 | 汉堡 + 饮品 | 800 kcal（合计） |
| 下午茶 | 14:00–17:00 | 红茶、咖啡、奶铁、派 | 300 kcal |
| 夜宵 | 22:00–06:00 | 轻食，不含咖啡因 | 250 kcal |
| 其他时段 | | 轻食和饮品 | 250 kcal |

## 目标用户

- 每天在 VS Code 或 Claude Code 里写代码、也常点麦当劳的开发者。
- 想及时用掉临期券和即将过期积分，又不想频繁切到手机 App 的人。
- 发版后想请团队吃一顿、希望一步搞定团餐搭配的小团队负责人。

## 准备 token

本项目使用麦当劳 MCP（`https://mcp.mcd.cn`），需要你自己的 MCP token。

### 申请 token

1. 打开麦当劳 MCP 开放平台：<https://open.mcd.cn/mcp>
2. 点击右上角「登录」，用手机号完成验证登录。登录后右上角会变成「控制台」。
3. 点击「控制台」，在弹窗中点击「激活」申请 MCP token。
4. 阅读并同意服务协议。
5. 申请成功后点击一键复制 token。

更多说明见官方的 [麦当劳 MCP Server 使用指南](https://github.com/M-China/mcd-mcp-server)。

### 配置 token

token 只保存在本机：

- VS Code：运行命令 `MCD Fuel: 设置 MCP token`，粘贴 token，存入 VS Code SecretStorage。
- 命令行 / Claude Code：设置环境变量 `MCD_MCP_TOKEN`，见下方"安装：命令行与 Claude Code statusline"。

token 相当于你的麦当劳账号凭证，可以查询积分、领券和下单。不要把它写进仓库或任何会被分享的配置文件；泄露后请在开放平台控制台重新申请。

## 安装：VS Code 插件

需要 VS Code 1.93 及以上。

1. 从 [Releases](https://github.com/byfanx/mcd-commit-fuel/releases) 下载 `mcd-commit-fuel-vscode-<版本>.vsix`（或按下方"开发"一节用 `npm run release` 自己打包）。
2. 在扩展面板点 `…` → `从 VSIX 安装…`，选择下载的文件。
3. 运行命令 `MCD Fuel: 设置 MCP token`。状态栏右侧会显示积分和券数，点击查看详情。

| 命令 | 说明 |
|---|---|
| `MCD Fuel: 查看详情` | 积分、券和到期日、当前状态的推荐；点击一张券可以直接用券下单 |
| `MCD Fuel: 立即刷新` | 立即拉取最新数据 |
| `MCD Fuel: 今日小票` | 打开今日 Commit 小票 |
| `MCD Fuel: 点一份餐品（按餐段推荐，到店自取，需确认）` | 选门店（收藏或搜索）→ 选餐品 → 算价 → 确认后下单 |
| `MCD Fuel: 请团队吃一顿（团餐外送，需确认）` | 选人数 → 配送地址 → 门店 → 自动搭配 → 算价 → 确认后下单 |
| `MCD Fuel: 查看全部可用的券` | 卡包里的全部券，按临期 / 到店可用 / 仅外送分组；点击到店可用的券直接下单（详情里的“查看全部 N 张券”也能进入） |
| `MCD Fuel: 领取可领的券（需确认）` | 先查询可领的券并在确认框列出，确认后领取，领完弹窗显示本次领到的券 |
| `MCD Fuel: 设置 / 清除 MCP token` | 管理 token |

插件会自动采集这些信号：`vscode.git` 的提交和 tag 变化、VS Code 任务（task）的开始和结束、终端里构建/测试命令的耗时和退出码（需要开启 shell integration）。

设置项（`mcdFuel.*`）：`pollMinutes`（轮询间隔，默认 30，窗口失焦时暂停）、`buildMinutes`（默认 3）、`dailyNudgeLimit`（默认 2）、`releaseTagPattern`、`lateNight`、`trackTerminal`。

## 安装：命令行与 Claude Code statusline

需要 Node.js 22 及以上和 git。CLI 是一个单文件 `mcd-fuel.mjs`，没有其他依赖。

1. 从 [Releases](https://github.com/byfanx/mcd-commit-fuel/releases) 下载 `mcd-fuel.mjs`。

2. 放到 PATH 里：

   ```bash
   # Linux / macOS / WSL
   mkdir -p ~/.local/bin
   mv mcd-fuel.mjs ~/.local/bin/mcd-fuel && chmod +x ~/.local/bin/mcd-fuel
   mcd-fuel --version
   ```

   Windows 上不需要改名，直接用 `node C:\路径\mcd-fuel.mjs <命令>` 运行。

3. 在 shell 配置文件（如 `~/.bashrc`、`~/.zshrc`）里设置 token，然后重新打开终端：

   ```bash
   export MCD_MCP_TOKEN=你的token
   ```

4. 在 `~/.claude/settings.json` 中加入（Windows 写成 `node C:\\路径\\mcd-fuel.mjs statusline`）：

   ```json
   {
     "statusLine": { "type": "command", "command": "mcd-fuel statusline" }
   }
   ```

   Claude Code 从启动它的终端继承环境变量，设置 token 后需要重新启动 Claude Code。

也可以从源码运行：`git clone` 后执行 `npm install && npm run package:cli`，生成的文件在 `release/mcd-fuel.mjs`。

statusline 只读本地缓存，不发网络请求；发现缓存过期时会在后台启动一次 `mcd-fuel refresh`，自己立即返回。

| 命令 | 说明 |
|---|---|
| `mcd-fuel statusline` | 给 Claude Code 用，输出一行状态 |
| `mcd-fuel refresh [--cwd 目录] [--force]` | 采集当前仓库的提交和 tag 并刷新数据（只调用只读接口） |
| `mcd-fuel receipt` | 打印今日小票 |
| `mcd-fuel run -- <命令>` | 运行构建或测试命令，并记录耗时和结果，退出码原样返回，例如 `mcd-fuel run -- npm test` |

### 缓存目录

所有出口共用一份缓存 `state.json`（文件权限 0600）：

| 环境 | 默认位置 |
|---|---|
| Linux / macOS / WSL | `~/.cache/mcd-commit-fuel`（或 `$XDG_CACHE_HOME/mcd-commit-fuel`） |
| Windows | `%LOCALAPPDATA%\mcd-commit-fuel` |

可以用环境变量 `MCD_FUEL_CACHE_DIR` 指定。在 WSL 里用 CLI、在 Windows 里用 VS Code 时，两边默认不共享数据；想共享的话，在 WSL 中设置 `MCD_FUEL_CACHE_DIR=/mnt/c/Users/<你的用户名>/AppData/Local/mcd-commit-fuel`。通过 Remote - WSL 打开项目时，插件运行在 WSL 里，会自动与 CLI 共用 `~/.cache`。

## 隐私与安全

- 代码、diff、commit message、仓库名、作者邮箱都不会离开本机。commit message 只在本地用来判断是否 revert，判断后即丢弃。
- 终端命令只记录类别（构建 / 测试）、耗时和退出码，不记录命令内容；其他命令不记录。
- 发送给麦当劳 MCP 的只有接口参数（如门店编码、商品编码、配送地址 ID）。团餐只显示脱敏后的配送地址，不展示、不缓存姓名和电话。
- 自动刷新只调用只读接口；领券、下单只能手动触发，并需要在确认框中再次确认。不接入抽奖和积分商城兑换。
- VS Code 中不受信任的工作区不读取 git 记录。
- MCP 客户端配置示例见 [mcp-config.example.json](./mcp-config.example.json)，只包含环境变量占位符。

## 开发

```bash
npm install
npm test                 # 编译并运行全部单测（node:test）
npm run release          # 打包单文件 CLI 和 VS Code 插件，输出到 release/
MCD_MCP_TOKEN=... npm run smoke   # 用真实 token 调用全部只读接口，只打印摘要
```

| 目录 | 内容 |
|---|---|
| `packages/core` | MCP 客户端、只读 API、信号与状态机、推荐、缓存与刷新、小票、领券与点单，无运行时依赖 |
| `packages/cli` | `mcd-fuel` 命令行 |
| `packages/vscode` | VS Code 插件，esbuild 打成单文件 |

## 相关文档

- [MCP_INTEGRATION.md](./MCP_INTEGRATION.md)：使用的麦当劳 MCP Tool 与调用流程
- [CONTEST_DECLARATION.md](./CONTEST_DECLARATION.md)：参赛声明
- [LICENSE](./LICENSE)：MIT
