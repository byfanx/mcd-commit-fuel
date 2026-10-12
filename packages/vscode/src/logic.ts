// 插件里不依赖 VS Code API 的逻辑，单独放在这里便于测试。
import {
  MINUTE,
  classifyTask,
  formatYuan,
  type CachedView,
  type ClaimDiff,
  type CouponGroup,
  type CouponRef,
  type PriceQuote,
  type TeamPlan,
  type Signal,
  type StateConfig,
  type TaskCategory,
} from '@mcd-commit-fuel/core';

export interface TaskInfo {
  name: string;
  /** TaskGroup.id，'build' / 'test' 等 */
  groupId?: string | undefined;
  /** shell 命令行或进程及参数，只用来判断类别 */
  commandLine?: string | undefined;
}

/** 任务声明了分组就按分组，否则按名称和命令行判断。 */
export function taskCategory(task: TaskInfo): TaskCategory {
  if (task.groupId === 'test') return 'test';
  if (task.groupId === 'build') return 'build';
  return classifyTask(`${task.name} ${task.commandLine ?? ''}`);
}

/**
 * 为每次执行分配 id，生成成对的 task-start / task-end 信号。
 * 'other' 类别不记录，既减少噪音，也不留下与开发无关的命令痕迹。
 */
export class ExecutionTracker<K extends object> {
  readonly #running = new WeakMap<K, { id: string; category: TaskCategory }>();
  #seq = 0;

  constructor(private readonly prefix: string) {}

  start(key: K, category: TaskCategory, ts: number): Signal | undefined {
    if (category === 'other') return undefined;
    const id = `${this.prefix}-${ts}-${++this.#seq}`;
    this.#running.set(key, { id, category });
    return { kind: 'task-start', ts, id, category };
  }

  end(key: K, exitCode: number | undefined, ts: number): Signal | undefined {
    const run = this.#running.get(key);
    if (!run) return undefined;
    this.#running.delete(key);
    return {
      kind: 'task-end',
      ts,
      id: run.id,
      category: run.category,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }
}

export interface Settings {
  pollMs: number;
  dailyNudgeLimit: number;
  releaseTagPattern: string;
  trackTerminal: boolean;
  state: Partial<StateConfig>;
}

/** 读取 `mcdFuel.*` 配置；类型不对或越界的值回退到默认值或下限。 */
export function readSettings(get: (key: string) => unknown): Settings {
  const num = (key: string, fallback: number, min: number) => {
    const v = get(key);
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback;
  };
  const bool = (key: string, fallback: boolean) => {
    const v = get(key);
    return typeof v === 'boolean' ? v : fallback;
  };
  const pattern = get('releaseTagPattern');
  return {
    pollMs: num('pollMinutes', 30, 5) * MINUTE,
    dailyNudgeLimit: Math.floor(num('dailyNudgeLimit', 2, 0)),
    releaseTagPattern: typeof pattern === 'string' && pattern.trim() ? pattern : '^v?\\d+\\.\\d+\\.\\d+',
    trackTerminal: bool('trackTerminal', true),
    state: { buildMinutes: num('buildMinutes', 3, 1), lateNightEnabled: bool('lateNight', true) },
  };
}

/** 两次自动刷新之间的最短间隔，防止拿不到锁时反复尝试。 */
export const MIN_AUTO_REFRESH_GAP_MS = MINUTE;

export interface RefreshCheck {
  focused: boolean;
  now: number;
  pollMs: number;
  stateChanged: boolean;
  lastRefreshAt?: number | undefined;
  lastAttemptAt?: number | undefined;
}

/** 窗口失焦时不刷新；状态切换、从没刷新过或超过轮询间隔时刷新。 */
export function shouldRefresh(c: RefreshCheck): boolean {
  if (!c.focused) return false;
  if (c.lastAttemptAt !== undefined && c.now - c.lastAttemptAt < MIN_AUTO_REFRESH_GAP_MS) return false;
  if (c.stateChanged || c.lastRefreshAt === undefined) return true;
  return c.now - c.lastRefreshAt >= c.pollMs;
}

export type PickAction =
  | 'refresh'
  | 'receipt'
  | 'setToken'
  | 'clearToken'
  | 'order'
  | 'claimCoupons'
  | 'useCoupon'
  | 'teamMeal'
  | 'allCoupons';

export interface PickEntry {
  label: string;
  description?: string;
  detail?: string;
  action?: PickAction;
  /** action 为 useCoupon 时要用的券 */
  coupon?: CouponRef;
  separator?: boolean;
}

/** 详情列表：推荐内容在前，操作在后；内容里已经有的操作不再重复。 */
export function toPickEntries(view: CachedView | undefined, hasToken: boolean): PickEntry[] {
  const entries: PickEntry[] = [];
  for (const item of view?.items ?? []) {
    entries.push({
      label: item.label,
      ...(item.description ? { description: item.description } : {}),
      ...(item.detail ? { detail: item.detail } : {}),
      // 没有 token 时不能用券下单，券只做展示
      ...(item.action && (item.action !== 'useCoupon' || hasToken) ? { action: item.action } : {}),
      ...(item.coupon && hasToken ? { coupon: item.coupon } : {}),
    });
  }

  const present = new Set(entries.map((e) => e.action));
  const all: PickEntry[] = [
    { label: '$(refresh) 立即刷新', action: 'refresh' },
    ...(hasToken
      ? ([
          { label: '$(coffee) 点一份餐品', description: '按当前餐段推荐 · 到店自取 · 需确认', action: 'order' },
          { label: '$(organization) 请团队吃一顿', description: '团餐外送 · 2~4 人 · 需确认', action: 'teamMeal' },
          { label: '$(gift) 领取可领的券', description: '需确认', action: 'claimCoupons' },
        ] satisfies PickEntry[])
      : []),
    { label: '$(note) 今日小票', action: 'receipt' },
    hasToken ? { label: '$(trash) 清除 MCP token', action: 'clearToken' } : { label: '$(key) 设置 MCP token', action: 'setToken' },
  ];
  const actions = all.filter((a) => !present.has(a.action));

  if (actions.length) entries.push({ label: '操作', separator: true }, ...actions);
  return entries;
}

export interface OrderSummary {
  storeName: string;
  itemName: string;
  /** 营养表里找不到时为空 */
  kcal?: number | undefined;
  couponTitle?: string | undefined;
  takeWay: string;
  /** 单位：分 */
  price: number;
  /** 单位：分 */
  discount: number;
}

/** 下单确认弹窗的正文。金额、门店、取餐方式都要列清楚。 */
export function orderConfirmDetail(o: OrderSummary): string {
  return [
    `门店：${o.storeName}（到店自取）`,
    `餐品：${o.itemName} × 1${o.kcal !== undefined ? `（${o.kcal} kcal）` : ''}`,
    ...(o.couponTitle ? [`优惠券：${o.couponTitle}`] : []),
    `取餐方式：${o.takeWay}`,
    `应付：${formatYuan(o.price)}${o.discount > 0 ? `（已优惠 ${formatYuan(o.discount)}）` : ''}`,
    '',
    '确认后会调用麦当劳 MCP 的 create-order 创建订单，请在麦当劳 App 中查看订单、完成支付和取餐。',
  ].join('\n');
}

export interface TeamSummary {
  storeName: string;
  /** 已脱敏的地址 */
  addressLabel: string;
  serviceName: string;
  plan: TeamPlan;
  quote: Pick<PriceQuote, 'price' | 'discount' | 'deliveryPrice' | 'packingPrice'>;
}

/** 团餐确认弹窗的正文：送到哪里、几个人、吃什么、每人多少热量、总共多少钱。 */
export function teamConfirmDetail(t: TeamSummary): string {
  const fees = [
    t.quote.deliveryPrice !== undefined ? `配送费 ${formatYuan(t.quote.deliveryPrice)}` : '',
    t.quote.packingPrice !== undefined ? `打包费 ${formatYuan(t.quote.packingPrice)}` : '',
  ].filter(Boolean);
  return [
    `门店：${t.storeName}（团餐外送）`,
    `送达：${t.addressLabel}`,
    `人数：${t.plan.people} 人`,
    '餐品：',
    ...t.plan.lines.map((l) => `  · ${l.name} × ${l.quantity}（${l.kcal} kcal/份）`),
    `人均约 ${t.plan.kcalPerPerson} kcal`,
    `助餐服务：${t.serviceName}`,
    ...(fees.length ? [`费用：${fees.join(' · ')}`] : []),
    `应付：${formatYuan(t.quote.price)}${t.quote.discount > 0 ? `（已优惠 ${formatYuan(t.quote.discount)}）` : ''}，人均 ${formatYuan(Math.round(t.quote.price / t.plan.people))}`,
    '',
    '价格以麦当劳返回的结果为准。确认后会调用 create-order 创建团餐外送订单，请在麦当劳 App 中查看订单并完成支付。',
  ].join('\n');
}

function couponEntry(g: CouponGroup): PickEntry {
  const when =
    g.daysLeft === undefined
      ? '长期有效'
      : g.daysLeft === 0
        ? '今天到期'
        : g.daysLeft < 0
          ? `已于 ${g.endDate} 到期`
          : `${g.daysLeft} 天后到期 · ${g.endDate}`;
  return {
    label: `${g.title}${g.count > 1 ? ` ×${g.count}` : ''}`,
    description: when,
    ...(g.pickup
      ? {
          action: 'useCoupon' as const,
          coupon: { id: g.id, ...(g.code ? { code: g.code } : {}), title: g.title },
        }
      : {}),
  };
}

/** "全部可用的券"列表：临期 → 到店可用 → 仅外送，每组内按到期日排序。 */
export function couponEntries(groups: readonly CouponGroup[]): PickEntry[] {
  const sections: Array<[string, CouponGroup[]]> = [
    ['3 天内到期', groups.filter((g) => g.expiring)],
    ['到店可用', groups.filter((g) => !g.expiring && g.pickup)],
    ['仅外送可用', groups.filter((g) => !g.expiring && !g.pickup)],
  ];
  const out: PickEntry[] = [];
  for (const [title, list] of sections) {
    if (list.length === 0) continue;
    out.push({ label: title, separator: true }, ...list.map(couponEntry));
  }
  return out;
}

/** 领券结果弹窗正文。diff 为空表示领取后没能再查到列表。 */
export function claimResultDetail(diff: ClaimDiff | undefined, summary: string): { title: string; detail: string } {
  const line = (c: { name: string; count: number }) => `· ${c.name}${c.count > 1 ? ` ×${c.count}` : ''}`;
  if (!diff) {
    return { title: '已提交领取', detail: `${summary}\n\n暂时查不到领取明细，稍后可在“查看全部券”中确认。` };
  }
  const total = diff.claimed.reduce((n, c) => n + c.count, 0);
  const parts: string[] = [];
  if (diff.claimed.length) parts.push(...diff.claimed.map(line));
  if (diff.remaining.length) {
    if (parts.length) parts.push('');
    parts.push('以下券没有领到（可能已领完或有限制）：', ...diff.remaining.map(line));
  }
  return {
    title: total > 0 ? `本次领到 ${total} 张券` : '这次没有领到券',
    detail: parts.join('\n') || summary,
  };
}
