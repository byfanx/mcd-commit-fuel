# MCP 集成说明

> 参赛作品，非麦当劳官方产品。

## MCP Server

| 项 | 值 |
|---|---|
| 名称 | `mcd-mcp`（麦当劳中国 MCP Server） |
| 地址 | `https://mcp.mcd.cn` |
| 协议 | Streamable HTTP（JSON-RPC 2.0） |
| 鉴权 | `Authorization: Bearer ${MCD_MCP_TOKEN}` |

MCP 客户端配置示例见 [mcp-config.example.json](./mcp-config.example.json)。

## 调用方式

本项目不依赖 MCP SDK，由 `packages/core/src/mcp-client.ts` 直接发送 JSON-RPC 请求：

```bash
curl -s -X POST https://mcp.mcd.cn \
  -H "Authorization: Bearer $MCD_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query-my-account","arguments":{}}}'
```

- 不需要 `initialize` 握手，也没有 session，直接调用 `tools/call`。
- 程序只读取 `result.structuredContent`（统一为 `{ success, code, message, data }`），不解析给大模型看的 Markdown 文本。
- 同时兼容普通 JSON 和 SSE 响应。
- 超时 10 秒，不自动重试。错误分为 5 类：网络/超时、token 无效（HTTP 401/403）、Tool 错误（JSON-RPC `error` 或 `isError`）、业务失败（`success=false`）、响应结构异常。错误信息中不会出现 token。

## 使用的 Tool

### 只读：自动刷新

由刷新器按需调用，结果写入本地缓存，各出口（VS Code 状态栏、Claude Code statusline、小票）只读缓存。

| Tool | 参数 | 用途 | 缓存时间 |
|---|---|---|---|
| `query-my-account` | 无 | 积分余额、本月 / 下月将过期积分 | 30 分钟 |
| `query-my-coupons` | `page=1, pageSize=200` | 卡包里的券和到期日 | 30 分钟 |
| `available-coupons` | 无 | 当前可领的券 | 2 小时 |
| `query-nearby-stores` | `beType=1, searchType=1` | 收藏的门店（不需要定位） | 24 小时 |
| `query-store-coupons` | `storeCode, orderType=1, beType=1` | 收藏门店到店自取可用的券 | 30 分钟 |
| `list-nutrition-foods` | 无 | 营养成分表，用于餐品推荐和小票 | 7 天 |
| `query-meals` | `storeCode, orderType=1, beType=1` | 收藏门店的菜单，保证推荐的餐品门店在卖，并识别“我的常点” | 2 小时；跨餐段重新拉取 |
| `campaign-calendar` | 无 | 今天及以后的活动 | 6 小时 |

刷新规则：

- 只拉取当前状态需要的数据，见下表。
- 数据缺失或超过缓存时间才调用；状态切换时，积分、券、活动数据超过 5 分钟也会重新拉取。
- 某项调用失败后 5 分钟内不再重试，期间继续显示上一次成功的数据。
- 同一时间只有一个刷新器在调用（`refresh.lock`），VS Code 默认每 30 分钟轮询一次，窗口失焦时暂停。

| 开发状态 | 判定信号 | 调用的 Tool |
|---|---|---|
| 空闲 / 专注中 | 默认 / 30 分钟内提交 ≥ 2 次 | `query-my-account`、`query-my-coupons` |
| 构建等待 | 构建或测试运行 ≥ 3 分钟 | 上面两个 + `query-nearby-stores`、`query-store-coupons` |
| 卡 bug | 20 分钟内测试连续失败 3 次 / 1 小时内 revert 2 次 | 上面两个 + `query-nearby-stores`、`query-meals`、`list-nutrition-foods` |
| 刚发版 | 30 分钟内的 release tag | 上面两个 + `campaign-calendar`、`available-coupons` |
| 收工 | 今天有提交，空闲 ≥ 90 分钟 | 上面两个 + `query-nearby-stores`、`query-meals`、`list-nutrition-foods` |

### 只读：点单流程中按需调用

| Tool | 参数 | 用途 |
|---|---|---|
| `query-nearby-stores` | `beType=1, searchType=2, city, keyword` | 用户主动搜索门店（按城市和门店名或地址） |
| `query-store-coupons` | `storeCode, orderType=1, beType=1` | 用券下单时，确认所选门店能用这张券并取得适用商品 |
| `query-meals` | `storeCode, orderType=1, beType=1` | 所选门店的菜单，与营养表匹配后按当前餐段推荐 |
| `calculate-price` | `storeCode, orderType=1, beType=1, items` | 下单前展示含优惠的价格，并取得可选的取餐方式；用券时 `items[]` 带上 `couponId`、`couponCode` |

### 写操作：只能手动触发并二次确认

| Tool | 触发方式 | 确认内容 |
|---|---|---|
| `auto-bind-coupons` | VS Code 命令 `MCD Fuel: 领取可领的券` | 先用 `available-coupons` 确认有状态为 `CAN_GET` 的券，没有就不调用；模态确认框列出可领的券。领取后再查一次 `available-coupons`，对比前后差异弹窗显示本次领到的券 |
| `create-order`（到店自取） | VS Code 命令 `MCD Fuel: 点一份餐品`，或在详情中点击一张券 | 模态确认框，列出门店、餐品、热量、所用的券、取餐方式、应付金额 |
| `create-order`（团餐外送） | VS Code 命令 `MCD Fuel: 请团队吃一顿`，或发版后在详情中点击 | 模态确认框，列出门店、脱敏地址、人数、每样餐品和单份热量、人均热量、助餐服务、配送费、打包费、应付和人均金额 |

```
点一份餐品：选门店（收藏 / 搜索）─▶ query-meals + 营养表 ─▶ 选择餐品 ─┐
                                                                      │
点击一张券：选门店（收藏 / 搜索）─▶ query-store-coupons ─▶ 选适用商品 ─┤
                                                                      ▼
                                            calculate-price ─▶ 选择取餐方式
                                                                      │
                                      模态确认（门店 / 餐品 / 券 / 热量 / 金额）
                                                                      │ 用户点击“确认下单”
                                                                      ▼
                                  create-order（到店自取） ─▶ 在麦当劳 App 中支付、取餐
```

### 团餐：请团队吃一顿

| 步骤 | Tool | 参数 |
|---|---|---|
| 配送地址 | `delivery-query-addresses` | 无；没有地址时提示用户先在麦当劳 App 中添加 |
| 可配送团餐的门店 | `delivery-query-stores` | `addressId, beType=6` |
| 团餐菜单 | `query-meals` | `storeCode, beCode, orderType=2, beType=6` |
| 助餐服务 | `query-meal-assistance` | 同上；默认选可用且默认选中的服务（实测为“保鲜速达”） |
| 算价 | `calculate-price` | 同上 + `gmServiceCode, items`；不传 `gmServiceCode` 会返回“团餐助餐服务参数缺失” |
| 下单 | `create-order` | 同上 + `addressId` |

自动搭配：每人一个汉堡（单个 ≤ 650kcal，尽量不重复）加一杯饮品（≤ 150kcal，无糖饮品、纯净水、茶优先），小食每 2 人一份共享；不选薯条、甜品冰品和套餐。满减 / 满折规则由 `calculate-price` 计算，本项目不自行套用 `query-promotions` 的规则，价格以接口返回为准。

### 不使用的 Tool

不接入抽奖（`draw-lottery`）、积分商城兑换（`mall-create-order`）和个人外送（麦乐送，beType=2），也不会调用 `cancel-order`。

## 数据与隐私

- 判断开发状态所用的信号全部在本地产生：git 提交时间、是否 revert、release tag、构建 / 测试的耗时和退出码。代码、diff、commit message、仓库名、作者邮箱不会发送给 MCP 或任何其他服务。
- 发送给 MCP 的只有上表中的接口参数。
- 配送地址只用 `addressId` 下单，界面上只显示脱敏后的地址（前 6 个字和后 4 个字），姓名和电话不展示、不写入缓存。
- 本地缓存只保存积分、券名称和到期日、门店名等摘要，文件权限 0600，不保存 token。

## 业务价值

- 把麦当劳的积分、优惠券和活动带进开发者每天停留最久的编辑器和终端里，不需要切换到 App。
- 只在合适的时机（构建等待、卡 bug、发版、收工）给出提示，同类提醒每天限次，不打断工作。
- 积分即将过期、券即将到期时提前提醒，提升权益使用率。
- 推荐按餐段选择餐品（早餐、正餐、下午茶、夜宵），先看餐品类别再看热量上限，不主动推荐薯条、甜品冰品和套餐；所有推荐附营养信息，深夜只推荐轻食且不含咖啡因。
- 临期券提醒加上点击即用券下单，提高券的核销率；发版后的团餐把“请团队吃一顿”变成一次确认就能完成的操作。
- 下单永远需要用户确认，支付在官方 App 内完成。
