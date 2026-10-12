import { pickForPeriod, type MealPeriod } from './mealtime.js';
import type { FuelData } from './recommend.js';
import type { DailyStats } from './stats.js';
import { MINUTE } from './time.js';

export const RECEIPT_WIDTH = 32;

export interface ReceiptInput {
  stats: DailyStats;
  data: FuelData;
  lateNight: boolean;
  /** 打印时间，毫秒时间戳 */
  printedAt?: number;
  /** 默认按 lateNight 判断：夜宵或加餐 */
  period?: MealPeriod;
  width?: number;
}

/**
 * 字符画版今日小票。只用当天的计数和时长，
 * 不包含 commit message、仓库名、作者邮箱。推荐按当前餐段选择并附营养信息。
 */
export function renderReceipt(input: ReceiptInput): string {
  const w = input.width ?? RECEIPT_WIDTH;
  const { stats, data } = input;
  const lines: string[] = [];

  const rule = (ch: string) => lines.push(ch.repeat(w));
  const center = (s: string) => {
    const t = truncate(s, w);
    lines.push(' '.repeat(Math.floor((w - displayWidth(t)) / 2)) + t);
  };
  const row = (label: string, value: string) => {
    const v = truncate(value, w - displayWidth(label) - 1);
    lines.push(label + ' '.repeat(Math.max(1, w - displayWidth(label) - displayWidth(v))) + v);
  };

  rule('=');
  center('MCD COMMIT FUEL 今日小票');
  rule('-');
  row('日期', stats.date);
  if (input.printedAt !== undefined) row('时间', hhmm(input.printedAt));
  row('提交', `x ${stats.commits}`);
  if (stats.reverts > 0) row('Revert', `x ${stats.reverts}`);
  if (stats.releases > 0) row('发版', `x ${stats.releases}`);
  row('测试', `通过 ${stats.testsPassed} / 失败 ${stats.testsFailed}`);
  row('构建与测试耗时', formatDuration(stats.buildMs));

  rule('-');
  const period = input.period ?? (input.lateNight ? 'lateNight' : 'other');
  const [pick] = pickForPeriod(data.menu, data.nutrition, {
    period,
    seed: `${stats.date}:${period}:receipt`,
    count: 1,
  });
  if (pick) {
    row('今日推荐', pick.name);
    row('', `${pick.kcal} kcal`);
    row('', `蛋白质 ${pick.protein}g · 钠 ${pick.sodium}mg`);
  } else {
    row('今日推荐', '喝杯水，早点休息');
  }

  if (data.account || data.myCoupons) {
    rule('-');
    if (data.account) row('积分', String(Math.floor(data.account.availablePoints)));
    if (data.myCoupons) row('可用券', `${data.myCoupons.total} 张`);
  }
  rule('=');
  center('代码不出本机 · 下单需确认');
  return lines.join('\n');
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / MINUTE);
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 终端显示宽度：中日韩文字、全角符号和 emoji 算 2 列。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return w;
}

/** 超过 max 列时截断并加省略号。 */
export function truncate(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0)!) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}
