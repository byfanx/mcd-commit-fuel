import { McpError } from './errors.js';
import { asArray, asNumber, asString, isObject, type JsonObject } from './json.js';
import type { ToolCaller } from './mcp-client.js';
import { parseMenu, type MenuItem } from './actions.js';
import { parseNutritionTable, type NutritionFood } from './nutrition.js';

export interface Account {
  availablePoints: number;
  expiringThisMonth: number;
  expiringNextMonth: number;
}

export interface Coupon {
  id: string;
  /** 同一种券可能有多张，id 相同、券码不同 */
  code?: string;
  title: string;
  /** yyyy-MM-dd */
  endDate?: string;
  /** 1=到店，2=外送 */
  orderTypes: number[];
}

export interface MyCoupons {
  total: number;
  coupons: Coupon[];
}

export interface ClaimableCoupon {
  name: string;
  status: string;
  label: string;
}

export interface Store {
  storeCode: string;
  storeName: string;
  beCode?: string;
  address?: string;
  /** 米；收藏门店不返回距离 */
  distance?: number;
}

export interface StoreCoupon {
  id: string;
  /** 下单时和 id 一起传给 calculate-price / create-order */
  code?: string;
  title: string;
  /** yyyy-MM-dd */
  endDate?: string;
  /** 这张券可以用在哪些商品上 */
  products: Array<{ code: string; name: string }>;
}

export interface CampaignEvent {
  /** yyyy-MM-dd */
  date: string;
  title: string;
  stage?: number;
}

/** 只读接口的类型化封装。写接口不放在这里。 */
export class McdApi {
  constructor(private readonly caller: ToolCaller) {}

  async getAccount(): Promise<Account> {
    return parseAccount(await this.caller.callTool('query-my-account'));
  }

  async getMyCoupons(): Promise<MyCoupons> {
    return parseMyCoupons(await this.caller.callTool('query-my-coupons', { page: '1', pageSize: '200' }));
  }

  async getClaimableCoupons(): Promise<ClaimableCoupon[]> {
    return parseClaimableCoupons(await this.caller.callTool('available-coupons'));
  }

  /** 收藏的门店，到店自取。不需要定位。 */
  async getFavoriteStores(): Promise<Store[]> {
    return parseStores(await this.caller.callTool('query-nearby-stores', { beType: 1, searchType: 1 }));
  }

  /** 按城市和关键词（门店名或地址）搜索可到店自取的门店。 */
  async searchStores(city: string, keyword?: string): Promise<Store[]> {
    const args: Record<string, unknown> = { beType: 1, searchType: 2, city };
    if (keyword?.trim()) args.keyword = keyword.trim();
    return parseStores(await this.caller.callTool('query-nearby-stores', args));
  }

  /** 指定门店到店自取可用的券。 */
  async getStoreCoupons(storeCode: string): Promise<StoreCoupon[]> {
    return parseStoreCoupons(
      await this.caller.callTool('query-store-coupons', { storeCode, orderType: 1, beType: 1 }),
    );
  }

  /** 指定门店到店自取的菜单。 */
  async getStoreMenu(storeCode: string): Promise<MenuItem[]> {
    return parseMenu(await this.caller.callTool('query-meals', { storeCode, orderType: 1, beType: 1 }));
  }

  async getNutrition(): Promise<NutritionFood[]> {
    const data = await this.caller.callTool('list-nutrition-foods');
    if (typeof data !== 'string') throw shapeError('list-nutrition-foods');
    return parseNutritionTable(data);
  }

  async getCampaigns(): Promise<CampaignEvent[]> {
    return parseCampaigns(await this.caller.callTool('campaign-calendar'));
  }
}

function shapeError(tool: string): McpError {
  return new McpError('PROTOCOL', `${tool}：返回结构不符合预期`);
}

function expectObject(data: unknown, tool: string): JsonObject {
  if (!isObject(data)) throw shapeError(tool);
  return data;
}

function expectArray(data: unknown, tool: string): unknown[] {
  if (!Array.isArray(data)) throw shapeError(tool);
  return data;
}

function nonEmpty(v: unknown): string | undefined {
  const s = asString(v)?.trim();
  return s ? s : undefined;
}

export function parseAccount(data: unknown): Account {
  const o = expectObject(data, 'query-my-account');
  const availablePoints = asNumber(o.availablePoint);
  if (availablePoints === undefined) throw shapeError('query-my-account');
  return {
    availablePoints,
    expiringThisMonth: asNumber(o.currentMouthExpirePoint) ?? 0,
    expiringNextMonth: asNumber(o.nextMouthExpirePoint) ?? 0,
  };
}

export function parseMyCoupons(data: unknown): MyCoupons {
  const o = expectObject(data, 'query-my-coupons');
  const coupons: Coupon[] = [];
  for (const item of asArray(o.coupons)) {
    if (!isObject(item)) continue;
    const id = nonEmpty(item.id);
    const title = nonEmpty(item.title);
    if (!id || !title) continue;
    const endDate = nonEmpty(item.tradeEndDate);
    const code = nonEmpty(item.code);
    coupons.push({
      id,
      ...(code ? { code } : {}),
      title,
      ...(endDate ? { endDate } : {}),
      orderTypes: asArray(item.orderTypes)
        .map(asNumber)
        .filter((n): n is number => n !== undefined),
    });
  }
  return { total: asNumber(o.totalCount) ?? coupons.length, coupons };
}

/** available-coupons 也会返回已领取的券（couponStatus=HAVING_RECEIVE），只有 CAN_GET 才算可领。 */
export function isClaimable(c: ClaimableCoupon): boolean {
  return c.status === 'CAN_GET';
}

export function parseClaimableCoupons(data: unknown): ClaimableCoupon[] {
  const out: ClaimableCoupon[] = [];
  for (const item of expectArray(data, 'available-coupons')) {
    if (!isObject(item)) continue;
    const name = nonEmpty(item.couponName);
    if (!name) continue;
    out.push({ name, status: asString(item.couponStatus) ?? '', label: asString(item.label) ?? '' });
  }
  return out;
}

export function parseStores(data: unknown): Store[] {
  const out: Store[] = [];
  for (const item of expectArray(data, 'query-nearby-stores')) {
    if (!isObject(item)) continue;
    const storeCode = nonEmpty(item.storeCode);
    const storeName = nonEmpty(item.storeName);
    if (!storeCode || !storeName) continue;
    const beCode = nonEmpty(item.beCode);
    const address = nonEmpty(item.address);
    const distance = asNumber(item.distance);
    out.push({
      storeCode,
      storeName,
      ...(beCode ? { beCode } : {}),
      ...(address ? { address } : {}),
      ...(distance !== undefined && distance > 0 ? { distance } : {}),
    });
  }
  return out;
}

// "2026-09-24 00:00:00-2026-12-31 23:59:59" → "2026-12-31"
const RANGE_END_DATE = /(\d{4}-\d{2}-\d{2})(?: \d{2}:\d{2}(?::\d{2})?)?\s*$/;

export function parseStoreCoupons(data: unknown): StoreCoupon[] {
  const out: StoreCoupon[] = [];
  for (const item of expectArray(data, 'query-store-coupons')) {
    if (!isObject(item)) continue;
    const id = nonEmpty(item.couponId);
    const title = nonEmpty(item.title);
    if (!id || !title) continue;
    const endDate = RANGE_END_DATE.exec(asString(item.tradeDateTime) ?? '')?.[1];
    const code = nonEmpty(item.couponCode);
    const products: StoreCoupon['products'] = [];
    for (const p of asArray(item.products)) {
      if (!isObject(p)) continue;
      const productCode = nonEmpty(p.productCode);
      if (productCode) products.push({ code: productCode, name: nonEmpty(p.productName) ?? productCode });
    }
    out.push({ id, ...(code ? { code } : {}), title, ...(endDate ? { endDate } : {}), products });
  }
  return out;
}

/** 活动标题实测在 articleDto.title，activityTitle 通常为空，两者都兼容。 */
export function parseCampaigns(data: unknown): CampaignEvent[] {
  const o = expectObject(data, 'campaign-calendar');
  const out: CampaignEvent[] = [];
  for (const day of asArray(o.dailyList)) {
    if (!isObject(day)) continue;
    const date = nonEmpty(day.date);
    if (!date) continue;
    for (const ev of asArray(day.events)) {
      if (!isObject(ev)) continue;
      const title = nonEmpty(ev.activityTitle) ?? (isObject(ev.articleDto) ? nonEmpty(ev.articleDto.title) : undefined);
      if (!title) continue;
      const stage = asNumber(ev.activityStage);
      out.push({ date, title, ...(stage === undefined ? {} : { stage }) });
    }
  }
  return out;
}
