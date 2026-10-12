// 用真实 token 调用全部只读接口，只打印摘要，不打印账户 ID、券码等明细。
// 用法：MCD_MCP_TOKEN=... npm run smoke
import { McdApi, McpClient } from '@mcd-commit-fuel/core';

const token = process.env.MCD_MCP_TOKEN;
if (!token) {
  console.error('请先设置环境变量 MCD_MCP_TOKEN');
  process.exit(2);
}

const api = new McdApi(new McpClient({ token }));
let failed = 0;

async function check(name, fn) {
  const started = Date.now();
  try {
    const summary = await fn();
    console.log(`ok   ${name.padEnd(20)} ${String(Date.now() - started).padStart(5)}ms  ${summary}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name.padEnd(20)} ${String(Date.now() - started).padStart(5)}ms  ${err.kind ?? ''} ${err.message}`);
  }
}

let stores = [];
await check('getAccount', async () => {
  const a = await api.getAccount();
  return `积分 ${a.availablePoints}，本月过期 ${a.expiringThisMonth}`;
});
await check('getMyCoupons', async () => {
  const c = await api.getMyCoupons();
  return `共 ${c.total} 张，解析 ${c.coupons.length} 张`;
});
await check('getClaimableCoupons', async () => `${(await api.getClaimableCoupons()).length} 张可领`);
await check('getFavoriteStores', async () => {
  stores = await api.getFavoriteStores();
  return `${stores.length} 家收藏门店`;
});
await check('getStoreCoupons', async () => {
  if (!stores[0]) return '跳过（没有收藏门店）';
  return `${(await api.getStoreCoupons(stores[0].storeCode)).length} 张可用`;
});
await check('getNutrition', async () => {
  const foods = await api.getNutrition();
  return `${foods.length} 条，≤250kcal 的 ${foods.filter((f) => f.energyKcal <= 250).length} 条`;
});
await check('getCampaigns', async () => `${(await api.getCampaigns()).length} 个活动`);

process.exitCode = failed ? 1 : 0;
