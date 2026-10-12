import { isClaimable, type ClaimableCoupon, type StoreCoupon } from './api.js';
import { McpError } from './errors.js';
import { asArray, asNumber, asString, isObject, type JsonObject } from './json.js';
import type { ToolCaller } from './mcp-client.js';

export interface MenuItem {
  code: string;
  name: string;
  /** 现价，单位：分 */
  price?: number;
  /** 菜单标记为"我的常点" */
  frequent?: boolean;
}

export interface OrderItem {
  productCode: string;
  quantity: number;
  /** 用券时传 query-store-coupons 返回的 couponId 和 couponCode */
  couponId?: string;
  couponCode?: string;
}

/** 在门店可用券里找到用户卡包里的那一张：券码优先，其次按券 id。 */
export function findStoreCoupon(
  storeCoupons: readonly StoreCoupon[],
  coupon: { id: string; code?: string | undefined },
): StoreCoupon | undefined {
  return (
    (coupon.code ? storeCoupons.find((c) => c.code === coupon.code) : undefined) ??
    storeCoupons.find((c) => c.id === coupon.id)
  );
}

/** 用一张门店券下单时的商品行。 */
export function couponOrderItem(coupon: StoreCoupon, productCode: string): OrderItem {
  return { productCode, quantity: 1, couponId: coupon.id, ...(coupon.code ? { couponCode: coupon.code } : {}) };
}

export interface TakeWay {
  code: string;
  title: string;
}

export interface PriceQuote {
  /** 实付，单位：分 */
  price: number;
  /** 原价，单位：分 */
  originalPrice: number;
  /** 优惠，单位：分 */
  discount: number;
  products: Array<{ code: string; name: string; quantity: number; subtotal: number }>;
  takeWays: TakeWay[];
  /** 外送/团餐才有，单位：分 */
  deliveryPrice?: number;
  /** 外送/团餐才有，单位：分 */
  packingPrice?: number;
}

export interface OrderResult {
  orderId?: string;
  summary: string;
}

/**
 * 点单、团餐和领券。到店自取用 orderType=1, beType=1；团餐外送用 orderType=2, beType=6。
 * claimAllCoupons、createPickupOrder、createGroupOrder 是写操作，只能在用户手动触发并确认后调用。
 */
export class McdActions {
  constructor(private readonly caller: ToolCaller) {}

  /** 只读：门店菜单 */
  async getMenu(storeCode: string): Promise<MenuItem[]> {
    return parseMenu(await this.caller.callTool('query-meals', { storeCode, orderType: 1, beType: 1 }));
  }

  /** 只读：算价，同时返回可选的取餐方式 */
  async quote(storeCode: string, items: OrderItem[]): Promise<PriceQuote> {
    return parseQuote(await this.caller.callTool('calculate-price', { storeCode, orderType: 1, beType: 1, items }));
  }

  /** 只读：配送地址 */
  async getAddresses(): Promise<DeliveryAddress[]> {
    return parseAddresses(await this.caller.callTool('delivery-query-addresses'));
  }

  /** 只读：该地址可以配送团餐的门店 */
  async getGroupStores(addressId: string): Promise<GroupStore[]> {
    return parseGroupStores(await this.caller.callTool('delivery-query-stores', { addressId, beType: 6 }));
  }

  /** 只读：团餐菜单 */
  async getGroupMenu(store: Pick<GroupStore, 'storeCode' | 'beCode'>): Promise<MenuItem[]> {
    return parseMenu(
      await this.caller.callTool('query-meals', { storeCode: store.storeCode, beCode: store.beCode, orderType: 2, beType: 6 }),
    );
  }

  /** 只读：团餐助餐服务（算价必须带 gmServiceCode） */
  async getMealAssistance(store: Pick<GroupStore, 'storeCode' | 'beCode'>): Promise<MealAssistance[]> {
    return parseMealAssistance(
      await this.caller.callTool('query-meal-assistance', {
        storeCode: store.storeCode,
        beCode: store.beCode,
        orderType: 2,
        beType: 6,
      }),
    );
  }

  /** 只读：团餐算价，返回含配送费、打包费的应付金额 */
  async quoteGroup(store: Pick<GroupStore, 'storeCode' | 'beCode'>, gmServiceCode: string, items: OrderItem[]): Promise<PriceQuote> {
    return parseQuote(
      await this.caller.callTool('calculate-price', {
        storeCode: store.storeCode,
        beCode: store.beCode,
        orderType: 2,
        beType: 6,
        gmServiceCode,
        items,
      }),
    );
  }

  /** 写操作：创建团餐外送订单。仍需用户在麦当劳 App 中支付。 */
  async createGroupOrder(
    store: Pick<GroupStore, 'storeCode' | 'beCode'>,
    addressId: string,
    gmServiceCode: string,
    items: OrderItem[],
  ): Promise<OrderResult> {
    return parseOrder(
      await this.caller.callTool('create-order', {
        storeCode: store.storeCode,
        beCode: store.beCode,
        orderType: 2,
        beType: 6,
        addressId,
        gmServiceCode,
        items,
      }),
    );
  }

  /** 写操作：领取当前全部可领的券 */
  async claimAllCoupons(): Promise<string> {
    return summarizeClaim(await this.caller.callTool('auto-bind-coupons'));
  }

  /** 写操作：创建到店自取订单。订单创建后仍需用户在麦当劳 App 中支付。 */
  async createPickupOrder(storeCode: string, items: OrderItem[], takeWayCode: string): Promise<OrderResult> {
    return parseOrder(
      await this.caller.callTool('create-order', { storeCode, orderType: 1, beType: 1, items, takeWayCode }),
    );
  }
}

function shapeError(tool: string): McpError {
  return new McpError('PROTOCOL', `${tool}：返回结构不符合预期`);
}

function expectObject(data: unknown, tool: string): JsonObject {
  if (!isObject(data)) throw shapeError(tool);
  return data;
}

function nonEmpty(v: unknown): string | undefined {
  const s = asString(v)?.trim();
  return s ? s : undefined;
}

/** `query-meals` 的 meals 是以商品编码为 key 的对象，现价以"元"为单位的字符串返回。 */
export function parseMenu(data: unknown): MenuItem[] {
  const o = expectObject(data, 'query-meals');
  const out: MenuItem[] = [];
  if (!isObject(o.meals)) return out;
  // frequent 实测是单个对象 { code, tags }，也兼容数组
  const frequent = new Set(
    (Array.isArray(o.frequent) ? o.frequent : [o.frequent])
      .map((f) => (isObject(f) ? nonEmpty(f.code) : undefined))
      .filter((c): c is string => c !== undefined),
  );
  for (const [code, v] of Object.entries(o.meals)) {
    if (!isObject(v)) continue;
    const name = nonEmpty(v.name);
    if (!name) continue;
    const yuan = asNumber(v.currentPrice);
    out.push({
      code,
      name,
      ...(yuan === undefined ? {} : { price: Math.round(yuan * 100) }),
      ...(frequent.has(code) ? { frequent: true } : {}),
    });
  }
  return out;
}

/** `calculate-price` 的金额都是以"分"为单位的字符串。 */
export function parseQuote(data: unknown): PriceQuote {
  const o = expectObject(data, 'calculate-price');
  const price = asNumber(o.price);
  if (price === undefined) throw shapeError('calculate-price');
  const originalPrice = asNumber(o.originalPrice) ?? price;

  const products: PriceQuote['products'] = [];
  for (const p of asArray(o.productList)) {
    if (!isObject(p)) continue;
    const code = nonEmpty(p.productCode);
    if (!code) continue;
    products.push({
      code,
      name: nonEmpty(p.productName) ?? code,
      quantity: asNumber(p.quantity) ?? 1,
      subtotal: asNumber(p.subtotal) ?? 0,
    });
  }

  const takeWays: TakeWay[] = [];
  for (const t of asArray(o.takeWayList)) {
    if (!isObject(t)) continue;
    const code = nonEmpty(t.code);
    if (code) takeWays.push({ code, title: nonEmpty(t.title) ?? code });
  }

  const deliveryPrice = asNumber(o.deliveryPrice);
  const packingPrice = asNumber(o.packingPrice);
  return {
    price,
    originalPrice,
    discount: asNumber(o.discount) ?? originalPrice - price,
    products,
    takeWays,
    ...(deliveryPrice === undefined ? {} : { deliveryPrice }),
    ...(packingPrice === undefined ? {} : { packingPrice }),
  };
}

const ORDER_ID_KEYS = ['orderId', 'orderNo', 'orderCode', 'id'] as const;

/** create-order 的返回结构还没有实测过，这里按常见字段宽松解析。 */
export function parseOrder(data: unknown): OrderResult {
  if (typeof data === 'string') return { summary: data.trim().slice(0, 200) || '订单已提交' };
  if (!isObject(data)) throw shapeError('create-order');
  const source = isObject(data.order) ? data.order : data;
  for (const key of ORDER_ID_KEYS) {
    const orderId = nonEmpty(source[key]);
    if (orderId) return { orderId, summary: `订单号 ${orderId}` };
  }
  return { summary: '订单已提交' };
}

/** auto-bind-coupons 的返回结构还没有实测过，尽量给出领取数量。 */
export function summarizeClaim(data: unknown): string {
  if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 200);
  if (Array.isArray(data)) return `领取 ${data.length} 张`;
  if (isObject(data)) {
    for (const key of ['successCount', 'count', 'total', 'num']) {
      const n = asNumber(data[key]);
      if (n !== undefined) return `领取 ${n} 张`;
    }
    const list = Object.values(data).find(Array.isArray);
    if (list) return `领取 ${list.length} 张`;
  }
  return '已提交';
}

export interface CouponCount {
  name: string;
  count: number;
}

export interface ClaimDiff {
  /** 这次领到的券 */
  claimed: CouponCount[];
  /** 领取后仍是"可领取"的券（可能是领取失败或限量） */
  remaining: CouponCount[];
}

function countClaimable(list: readonly ClaimableCoupon[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of list) if (isClaimable(c)) m.set(c.name, (m.get(c.name) ?? 0) + 1);
  return m;
}

/**
 * 对比领取前后的 available-coupons，得出这次领到了哪些券。
 * 同名的券可能有多张，按名称计数；领取后券可能变成"已领取"，也可能直接从列表消失，两种都算领到。
 */
export function diffClaimed(before: readonly ClaimableCoupon[], after: readonly ClaimableCoupon[]): ClaimDiff {
  const b = countClaimable(before);
  const a = countClaimable(after);
  const claimed: CouponCount[] = [];
  for (const [name, n] of b) {
    const got = n - (a.get(name) ?? 0);
    if (got > 0) claimed.push({ name, count: got });
  }
  const remaining = [...a].map(([name, count]) => ({ name, count }));
  return { claimed, remaining };
}

/** 分 → `¥11.9` */
export function formatYuan(fen: number): string {
  return `¥${(fen / 100).toFixed(2).replace(/\.?0+$/, '')}`;
}


// ---- 团餐（企业团餐外送，beType=6, orderType=2）----

export interface DeliveryAddress {
  addressId: string;
  /** 脱敏后的地址，只用于让用户辨认，不含姓名和电话 */
  label: string;
}

export interface GroupStore {
  storeCode: string;
  storeName: string;
  beCode: string;
  open: boolean;
  /** 如 "07:00-23:00" */
  hours?: string;
}

export interface MealAssistance {
  code: string;
  name: string;
  enabled: boolean;
  selected: boolean;
  reason?: string;
}

export const TEAM_MIN_PEOPLE = 2;
export const TEAM_MAX_PEOPLE = 20;
export const TEAM_DEFAULT_PEOPLE = [2, 3, 4] as const;

/** 只保留前 6 个字和后 4 个字，避免截图或录屏时露出完整地址。 */
export function maskAddress(full: string): string {
  const s = full.trim();
  return [...s].length <= 12 ? s : `${[...s].slice(0, 6).join('')}…${[...s].slice(-4).join('')}`;
}

export function parseAddresses(data: unknown): DeliveryAddress[] {
  const o = expectObject(data, 'delivery-query-addresses');
  const out: DeliveryAddress[] = [];
  for (const a of asArray(o.addresses)) {
    if (!isObject(a)) continue;
    const addressId = nonEmpty(a.addressId);
    if (!addressId) continue;
    out.push({ addressId, label: maskAddress(nonEmpty(a.fullAddress) ?? '未命名地址') });
  }
  return out;
}

export function parseGroupStores(data: unknown): GroupStore[] {
  if (!Array.isArray(data)) throw shapeError('delivery-query-stores');
  const out: GroupStore[] = [];
  for (const s of data) {
    if (!isObject(s)) continue;
    const storeCode = nonEmpty(s.storeCode);
    const storeName = nonEmpty(s.storeName);
    const beCode = nonEmpty(s.beCode);
    if (!storeCode || !storeName || !beCode) continue;
    const start = nonEmpty(s.businessStartTime);
    const end = nonEmpty(s.businessEndTime);
    out.push({
      storeCode,
      storeName,
      beCode,
      open: s.businessStatus === true || s.businessStatus === 'true',
      ...(start && end ? { hours: `${start}-${end}` } : {}),
    });
  }
  return out;
}

export function parseMealAssistance(data: unknown): MealAssistance[] {
  const o = expectObject(data, 'query-meal-assistance');
  const out: MealAssistance[] = [];
  for (const m of asArray(o.mealAssistanceItems)) {
    if (!isObject(m)) continue;
    const code = nonEmpty(m.gmServiceCode);
    if (!code) continue;
    const reason = nonEmpty(m.unusableReason);
    out.push({
      code,
      name: nonEmpty(m.gmServiceName) ?? code,
      enabled: m.enable === true || m.enable === 'true',
      selected: m.selected === true || m.selected === 'true',
      ...(reason ? { reason } : {}),
    });
  }
  return out;
}

/** 默认助餐服务：可用且默认选中的优先，其次第一个可用的。团餐算价必须带上它。 */
export function defaultAssistance(items: readonly MealAssistance[]): MealAssistance | undefined {
  return items.find((m) => m.enabled && m.selected) ?? items.find((m) => m.enabled);
}

export interface TeamCandidate {
  code: string;
  name: string;
  /** 分 */
  price?: number;
  kcal: number;
}

export interface TeamLine {
  code: string;
  name: string;
  quantity: number;
  /** 单份热量 */
  kcal: number;
  role: 'main' | 'drink' | 'snack';
}

export interface TeamPlan {
  people: number;
  lines: TeamLine[];
  /** 人均热量（主食 + 饮品 + 分摊的小食） */
  kcalPerPerson: number;
}

const TEAM_MAIN = [/麦香鱼/, /板烧/, /麦辣鸡腿/, /鸡腿堡/, /鸡排堡/, /吉士/, /汉堡包/, /安格斯/, /堡/];
const TEAM_DRINK = [/无糖/, /纯悦/, /红茶/, /柠檬/, /美式/, /怡泉/, /豆浆/, /牛奶/];
const TEAM_SNACK = [/麦乐鸡/, /V翅|鸡翅/, /芝士条/, /玉米杯/, /苹果片/];
const TEAM_NEVER = /新地|冰淇淋|圆筒|麦旋风|麦旋酷|奶昔|薯条|桶|分享|套餐|组合|全家|开心乐园/;

function teamRank(name: string, patterns: readonly RegExp[]): number {
  if (TEAM_NEVER.test(name)) return Infinity;
  const i = patterns.findIndex((re) => re.test(name));
  return i < 0 ? Infinity : i;
}

function teamPool(candidates: readonly TeamCandidate[], patterns: readonly RegExp[], maxKcal: number): TeamCandidate[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => c.kcal <= maxKcal && teamRank(c.name, patterns) < Infinity && !seen.has(c.name) && seen.add(c.name))
    .sort((a, b) => teamRank(a.name, patterns) - teamRank(b.name, patterns) || (a.name < b.name ? -1 : 1));
}

/**
 * 团餐自动搭配：每人一个汉堡 + 一杯饮品（主食尽量不重复），小食每 2 人一份共享。
 * 不选薯条、甜品冰品和套餐；单人主食 ≤ 650kcal、饮品 ≤ 150kcal。
 * 找不到主食或饮品时返回 undefined，让用户换一家门店。
 */
export function planTeamMeal(candidates: readonly TeamCandidate[], people: number): TeamPlan | undefined {
  const n = Math.min(TEAM_MAX_PEOPLE, Math.max(TEAM_MIN_PEOPLE, Math.floor(people)));
  const mains = teamPool(candidates, TEAM_MAIN, 650);
  const drinks = teamPool(candidates, TEAM_DRINK, 150);
  const snacks = teamPool(candidates, TEAM_SNACK, 400);
  const firstDrink = drinks[0];
  if (mains.length === 0 || !firstDrink) return undefined;

  const lines = new Map<string, TeamLine>();
  const add = (c: TeamCandidate, role: TeamLine['role'], quantity: number) => {
    const line = lines.get(c.code);
    if (line) line.quantity += quantity;
    else lines.set(c.code, { code: c.code, name: c.name, quantity, kcal: c.kcal, role });
  };
  for (let i = 0; i < n; i++) add(mains[i % mains.length]!, 'main', 1);
  add(firstDrink, 'drink', n);
  const snack = snacks[0];
  const snackCount = Math.ceil(n / 2);
  if (snack) add(snack, 'snack', snackCount);

  const total = [...lines.values()].reduce((sum, l) => sum + l.kcal * l.quantity, 0);
  return { people: n, lines: [...lines.values()], kcalPerPerson: Math.round(total / n) };
}
