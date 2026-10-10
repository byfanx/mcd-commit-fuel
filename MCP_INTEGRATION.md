# MCP 集成说明

> 草案：随功能实现持续更新。

## MCP Server

| 项 | 值 |
|---|---|
| 名称 | `mcd-mcp`（麦当劳中国 MCP Server） |
| 地址 | `https://mcp.mcd.cn` |
| 协议 | Streamable HTTP（JSON-RPC 2.0） |
| 鉴权 | `Authorization: Bearer ${MCD_MCP_TOKEN}` |

配置示例见 [mcp-config.example.json](./mcp-config.example.json)。

## 使用的 Tool

**只读（自动刷新，带缓存与限频）**

| Tool | 用途 |
|---|---|
| `now-time-info` | 获取服务端时间，用于活动日历日期 |
| `query-my-account` | 状态栏展示积分余额 |
| `available-coupons` | 状态栏展示可领券数量 |
| `query-my-coupons` | 查看卡包中的券 |
| `campaign-calendar` | 当日 / 近期活动提醒 |
| `query-nearby-stores` | 构建等待时查找附近门店 |
| `query-store-coupons` | 指定门店可用券 |
| `query-meals` | 按开发状态推荐餐品 |
| `list-nutrition-foods` | 推荐附带热量与营养信息 |
| `query-promotions` | 发版请客场景的团餐满减 |
| `calculate-price` | 下单前计算含优惠价格 |

**写操作（仅手动触发 + 二次确认）**

| Tool | 用途 |
|---|---|
| `auto-bind-coupons` | 一键领券 |
| `create-order` | 用户确认后下单 |

不接入抽奖（`draw-lottery`）与积分兑换（`mall-create-order`）等扣减类接口。

## 调用流程

```
本地信号（git / 任务耗时 / 测试结果）
        │
        ▼
  开发者状态机 ──状态切换──▶ 调用只读 Tool（结果写入本地缓存，带 TTL）
        │
        ▼
 VS Code 状态栏 / Claude Code statusline（只读缓存）
        │ 用户点击
        ▼
 calculate-price 展示价格 ──用户确认──▶ create-order
```

| 开发状态 | 判定信号 | 调用的 Tool |
|---|---|---|
| 专注中 | 持续有提交 | `query-my-account`、`available-coupons` |
| 构建等待 | 任务运行超过阈值 | `query-nearby-stores`、`query-store-coupons` |
| 卡 bug | 测试连续失败 / 反复 revert | `query-meals`、`calculate-price` |
| 刚发版 | 新的 release tag | `query-meals`、`query-promotions` |
| 收工 | 当日最后提交后长时间空闲 | `campaign-calendar`、`list-nutrition-foods` |

## 业务价值

- 把麦当劳的积分、优惠券和活动信息带进开发者每天停留最久的工具里，不需要额外打开 App。
- 只在合适的时机（构建等待、发版、收工）给出提示，同类提醒每日限次，不打扰工作。
- 推荐附带营养信息，深夜状态只推荐轻食或饮品，倡导健康饮食。
