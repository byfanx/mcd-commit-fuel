import type { MenuItem } from './actions.js';
import { isClaimable, type Account, type CampaignEvent, type ClaimableCoupon, type Coupon, type MyCoupons, type Store, type StoreCoupon } from './api.js';
import { PERIOD_RULES, currentPeriod, describeMeal, pickForPeriod, type MealPick } from './mealtime.js';
import type { NutritionFood } from './nutrition.js';
import type { DevState } from './state.js';
import { DAY, localDate } from './time.js';

/** 刷新器缓存下来的 MCP 数据，任何一项都可能缺失。 */
export interface FuelData {
  account?: Account;
  myCoupons?: MyCoupons;
  claimableCoupons?: ClaimableCoupon[];
  /** 收藏门店，第一家用于查门店券和菜单 */
  stores?: Store[];
  /** stores[0] 的到店可用券 */
  storeCoupons?: StoreCoupon[];
  /** stores[0] 的到店菜单，用来保证推荐的餐品门店在卖 */
  menu?: MenuItem[];
  nutrition?: NutritionFood[];
  campaigns?: CampaignEvent[];
}

export interface CouponRef {
  id: string;
  code?: string;
  title: string;
  /** 已知可用的门店（来自门店券），没有就让用户选 */
  storeCode?: string;
}

export interface DetailItem {
  label: string;
  description?: string;
  detail?: string;
  /** 出口层据此绑定命令，没有就是纯展示 */
  action?: 'receipt' | 'setToken' | 'useCoupon' | 'order' | 'teamMeal' | 'allCoupons';
  coupon?: CouponRef;
}

export interface Recommendation {
  /** 状态栏短文本 */
  text: string;
  items: DetailItem[];
  /** 本次推荐的餐品 */
  picks: MealPick[];
}

export interface RecommendInput {
  state: DevState;
  lateNight: boolean;
  now: number;
  data: FuelData;
  hasToken: boolean;
  /** 今天的提醒次数用完了：状态栏只显示积分和券数，详情不变 */
  quiet?: boolean;
}

/** 几天内到期的券算临期 */
export const EXPIRING_DAYS = 3;

export function recommend(input: RecommendInput): Recommendation {
  const { state, lateNight, now, data } = input;
  if (!input.hasToken) {
    return {
      text: '🍟 设置 token',
      items: [
        {
          label: '设置麦当劳 MCP token',
          description: '只保存在本机',
          detail: '还没有 token？在 https://open.mcd.cn/mcp 登录后到控制台申请',
          action: 'setToken',
        },
      ],
      picks: [],
    };
  }

  const today = localDate(now);
  const period = currentPeriod(now, lateNight);
  const rule = PERIOD_RULES[period];
  const picks =
    state === 'stuck'
      ? pickForPeriod(data.menu, data.nutrition, { period, seed: `${today}:${period}:stuck` })
      : [];
  const expiring = expiringCoupons(data.myCoupons?.coupons ?? [], now);
  const summary = summaryText(data, expiring.length);
  let text: string;
  const items: DetailItem[] = [];

  switch (state) {
    case 'building': {
      const n = data.storeCoupons?.length ?? 0;
      text = n > 0 ? `⏳ 构建中 · 收藏门店 ${n} 张券可用` : `⏳ 构建中 · ${summary.replace(/^🍟 /, '')}`;
      items.push(...storeCouponItems(data));
      break;
    }
    case 'stuck': {
      const first = picks[0];
      const ask = period === 'afternoonTea' ? '下午茶' : '歇一下';
      text = first ? `${rule.emoji} ${ask}？${first.name} ${first.kcal}kcal` : `${rule.emoji} ${ask}？`;
      items.push({ label: '起身走走，喝口水', description: '连续失败时换个角度往往更快' });
      items.push(
        ...picks.map((p) => ({
          label: `${p.frequent ? '★ ' : ''}${p.name}`,
          description: describeMeal(p),
          detail: `${rule.label}推荐 · 点击去下单`,
          action: 'order' as const,
        })),
      );
      break;
    }
    case 'shipped':
      text = '🎉 发版了 · 请团队吃一顿？';
      items.push({ label: '请队吃一顿', description: '团餐外送 · 默认 2~4 人 · 需确认', action: 'teamMeal' });
      items.push(...campaignItems(data, today));
      {
        // 旧缓存里可能还有已领取的券，这里再过滤一次
        const claimable = (data.claimableCoupons ?? []).filter(isClaimable).length;
        if (claimable) items.push({ label: `${claimable} 张券可领`, description: '领券需要手动确认' });
      }
      break;
    case 'wrapup':
      text = '🧾 收工了 · 今日小票';
      items.push({ label: '查看今日小票', action: 'receipt' });
      break;
    default:
      text = summary;
  }

  if (lateNight) {
    items.unshift({ label: '夜深了', description: `只推荐 ${rule.maxKcal}kcal 以内的轻食和不含咖啡因的饮品` });
  }
  items.push(...expiringItems(expiring, now), ...accountItems(data, expiring));

  return { text: input.quiet ? summary : text, items, picks };
}

function summaryText(data: FuelData, expiringCount: number): string {
  const parts: string[] = [];
  if (data.account) parts.push(`${Math.floor(data.account.availablePoints)}分`);
  if (data.myCoupons) parts.push(`${data.myCoupons.total}券`);
  let text = `🍟 ${parts.length ? parts.join(' · ') : '麦麦'}`;
  if (expiringCount > 0) text += ` · ${expiringCount}张临期`;
  if ((data.account?.expiringThisMonth ?? 0) > 0) text += ' ⚠过期';
  return text;
}

/** 距今天还有几天到期（0 = 今天）。日期无效时返回 undefined。 */
export function daysUntil(endDate: string, now: number): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate);
  if (!m) return undefined;
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((end - start) / DAY);
}

function isPickup(c: Coupon): boolean {
  return c.orderTypes.length === 0 || c.orderTypes.includes(1);
}

/** 到店可用、EXPIRING_DAYS 天内到期的券，按到期日排序。同一种券只算一次。 */
export function expiringCoupons(coupons: readonly Coupon[], now: number): Coupon[] {
  const seen = new Set<string>();
  return coupons
    .filter((c) => {
      if (!c.endDate || !isPickup(c) || seen.has(c.id)) return false;
      const days = daysUntil(c.endDate, now);
      if (days === undefined || days < 0 || days > EXPIRING_DAYS) return false;
      seen.add(c.id);
      return true;
    })
    .sort((a, b) => a.endDate!.localeCompare(b.endDate!));
}

function couponRef(c: Coupon): CouponRef {
  return { id: c.id, ...(c.code ? { code: c.code } : {}), title: c.title };
}

function expiringItems(coupons: readonly Coupon[], now: number): DetailItem[] {
  return coupons.map((c) => {
    const days = daysUntil(c.endDate!, now)!;
    return {
      label: `🎟 ${c.title}`,
      description: days === 0 ? '今天到期' : `${days} 天后到期`,
      action: 'useCoupon' as const,
      coupon: couponRef(c),
    };
  });
}

function accountItems(data: FuelData, expiring: readonly Coupon[]): DetailItem[] {
  const items: DetailItem[] = [];
  const a = data.account;
  if (a) {
    const expiringPoints =
      a.expiringThisMonth > 0
        ? `本月将过期 ${a.expiringThisMonth}`
        : a.expiringNextMonth > 0
          ? `下月将过期 ${a.expiringNextMonth}`
          : '近期没有过期积分';
    items.push({ label: `积分 ${Math.floor(a.availablePoints)}`, description: expiringPoints });
  }
  // 临期券已经在上面单独列出，这里不再重复
  const shown = new Set(expiring.map((c) => c.id));
  const coupons = [...(data.myCoupons?.coupons ?? [])]
    .filter((c) => !shown.has(c.id))
    .sort((x, y) => (x.endDate ?? '9999').localeCompare(y.endDate ?? '9999'));
  for (const c of coupons.slice(0, 5)) {
    // 只有能到店使用的券才能点击去下单
    items.push({
      label: c.title,
      ...(c.endDate ? { description: `到期 ${c.endDate}` } : {}),
      ...(isPickup(c) ? { action: 'useCoupon' as const, coupon: couponRef(c) } : {}),
    });
  }
  const total = data.myCoupons?.total ?? 0;
  if (total > 0) {
    items.push({ label: `查看全部 ${total} 张券`, description: '按到期日排序 · 点击券可直接下单', action: 'allCoupons' });
  }
  return items;
}

export interface CouponGroup {
  id: string;
  /** 同一种券有多张时取第一张的券码下单 */
  code?: string;
  title: string;
  endDate?: string;
  daysLeft?: number;
  /** 同一种券的张数 */
  count: number;
  /** 到店可用，可以点击下单 */
  pickup: boolean;
  /** EXPIRING_DAYS 天内到期 */
  expiring: boolean;
}

/** 卡包里的券按种类合并（id 相同即同一种），按到期日排序，没有到期日的排最后。 */
export function groupCoupons(coupons: readonly Coupon[], now: number): CouponGroup[] {
  const groups = new Map<string, CouponGroup>();
  for (const c of coupons) {
    const g = groups.get(c.id);
    if (g) {
      g.count++;
      continue;
    }
    const daysLeft = c.endDate ? daysUntil(c.endDate, now) : undefined;
    groups.set(c.id, {
      id: c.id,
      ...(c.code ? { code: c.code } : {}),
      title: c.title,
      ...(c.endDate ? { endDate: c.endDate } : {}),
      ...(daysLeft !== undefined ? { daysLeft } : {}),
      count: 1,
      pickup: isPickup(c),
      expiring: daysLeft !== undefined && daysLeft >= 0 && daysLeft <= EXPIRING_DAYS,
    });
  }
  return [...groups.values()].sort((x, y) => (x.endDate ?? '9999').localeCompare(y.endDate ?? '9999'));
}

function storeCouponItems(data: FuelData): DetailItem[] {
  const store = data.stores?.[0];
  if (!store || !data.storeCoupons?.length) return [];
  return data.storeCoupons.slice(0, 5).map((c) => ({
    label: c.title,
    description: store.storeName,
    ...(c.endDate ? { detail: `到期 ${c.endDate}` } : {}),
    action: 'useCoupon' as const,
    coupon: { id: c.id, ...(c.code ? { code: c.code } : {}), title: c.title, storeCode: store.storeCode },
  }));
}

function campaignItems(data: FuelData, today: string): DetailItem[] {
  const seen = new Set<string>();
  return (data.campaigns ?? [])
    .filter((e) => e.date >= today && !seen.has(e.title) && seen.add(e.title))
    .slice(0, 5)
    .map((e) => ({ label: e.title, description: e.date === today ? '进行中' : e.date }));
}
