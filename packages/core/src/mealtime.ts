import { matchNutrition, type NutritionFood } from './nutrition.js';

/** 餐段。夜宵（lateNight）由 isLateNight 单独判断，优先级最高。 */
export type MealPeriod = 'breakfast' | 'lunch' | 'afternoonTea' | 'dinner' | 'lateNight' | 'other';

interface PeriodRule {
  label: string;
  emoji: string;
  /** 每份热量上限（午餐/晚餐是主食 + 饮品的合计） */
  maxKcal: number;
  /** 按顺序匹配，越靠前越优先推荐。餐品是第一参考，热量是第二参考。 */
  foods: RegExp[];
  /** 午餐/晚餐：主食 + 饮品成对推荐 */
  drinks?: RegExp[];
  /** 这个餐段不推荐的（如午餐不推早餐） */
  exclude?: RegExp;
}

const NOT_BREAKFAST = /麦满分|早安|粥|油条|薯饼|早餐|双蛋|猪柳|厚松饼|营养卷|晨/;

const CAFFEINE_RE = /美式|咖啡|奶铁|拿铁|卡布奇诺|玛奇朵|红茶|抹茶|黑巧|可乐/;
/** 任何餐段都不主动推荐的：甜品冰品、炸薯条、桶装分享、套餐组合 */
const NEVER_RE = /新地|冰淇淋|圆筒|麦旋风|麦旋酷|奶昔|薯条|桶|分享|套餐|组合|全家/;

const LIGHT_FOODS = [/苹果片/, /粥/, /玉米杯/, /纯牛奶|热牛奶|冰牛奶|牛奶/, /豆浆/, /纯悦/, /苹果汁/, /美式/, /鲜萃咖啡|浓缩咖啡/, /奶铁/, /红茶/];

export const PERIOD_RULES: Readonly<Record<MealPeriod, PeriodRule>> = Object.freeze({
  breakfast: {
    label: '早餐',
    emoji: '🥣',
    maxKcal: 500,
    foods: [/粥/, /豆浆/, /麦满分/, /早安/, /薯饼/, /油条/, /美式/, /鲜萃咖啡/, /奶铁/, /牛奶/, /玉米杯/],
  },
  lunch: {
    exclude: NOT_BREAKFAST,
    label: '午餐',
    emoji: '🍔',
    maxKcal: 800,
    foods: [/麦香鱼/, /板烧/, /麦辣鸡腿/, /鸡腿堡/, /鸡排堡/, /吉士/, /汉堡包/, /安格斯/, /堡/, /卷/],
    drinks: [/无糖/, /纯悦/, /美式/, /红茶/, /柠檬/, /怡泉/, /豆浆/, /牛奶/],
  },
  afternoonTea: {
    exclude: NOT_BREAKFAST,
    label: '下午茶',
    emoji: '☕',
    maxKcal: 300,
    foods: [/红茶/, /美式/, /鲜萃咖啡|浓缩咖啡/, /奶铁|拿铁/, /卡布奇诺/, /玛奇朵/, /抹茶/, /黑巧/, /派/, /苹果片/, /玉米杯/, /拉明顿/],
  },
  dinner: {
    exclude: NOT_BREAKFAST,
    label: '晚餐',
    emoji: '🍔',
    maxKcal: 800,
    foods: [/麦香鱼/, /板烧/, /麦辣鸡腿/, /鸡腿堡/, /鸡排堡/, /吉士/, /汉堡包/, /安格斯/, /堡/, /卷/],
    drinks: [/无糖/, /纯悦/, /红茶/, /柠檬/, /怡泉/, /豆浆/, /牛奶/],
  },
  lateNight: { label: '夜宵', emoji: '🌙', maxKcal: 250, foods: LIGHT_FOODS },
  other: { label: '加餐', emoji: '☕', maxKcal: 250, foods: LIGHT_FOODS },
});

/** 按本地时间判断餐段（不含夜宵）。 */
export function mealPeriod(now: number): Exclude<MealPeriod, 'lateNight'> {
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  if (m >= 6 * 60 && m < 10 * 60 + 30) return 'breakfast';
  if (m >= 11 * 60 && m < 13 * 60 + 30) return 'lunch';
  if (m >= 14 * 60 && m < 17 * 60) return 'afternoonTea';
  if (m >= 17 * 60 + 30 && m < 20 * 60) return 'dinner';
  return 'other';
}

/** 夜宵优先，其次按时间。 */
export function currentPeriod(now: number, lateNight: boolean): MealPeriod {
  return lateNight ? 'lateNight' : mealPeriod(now);
}

export interface MealCandidate {
  name: string;
  nutrition: NutritionFood;
  /** 来自门店菜单时才有，有编码才能直接下单 */
  code?: string;
  /** 分 */
  price?: number;
  frequent?: boolean;
}

export interface MealPick {
  /** 展示名，成对推荐时为"主食 + 饮品" */
  name: string;
  kcal: number;
  protein: number;
  sodium: number;
  /** 分；所有组成都有价格时才有 */
  price?: number;
  frequent: boolean;
  parts: MealCandidate[];
}

function rank(name: string, patterns: readonly RegExp[]): number {
  const i = patterns.findIndex((re) => re.test(name));
  return i < 0 ? Infinity : i;
}

function allowed(c: MealCandidate, period: MealPeriod): boolean {
  if (NEVER_RE.test(c.name) || PERIOD_RULES[period].exclude?.test(c.name)) return false;
  return !(period === 'lateNight' && CAFFEINE_RE.test(c.name));
}

/** 去重、过滤后按"常点 → 餐品优先级 → 名称"排序。 */
export function rankCandidates(candidates: readonly MealCandidate[], patterns: readonly RegExp[], maxKcal: number, period: MealPeriod) {
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      if (seen.has(c.name) || !allowed(c, period)) return false;
      if (rank(c.name, patterns) === Infinity || c.nutrition.energyKcal > maxKcal) return false;
      seen.add(c.name);
      return true;
    })
    .sort(
      (a, b) =>
        Number(Boolean(b.frequent)) - Number(Boolean(a.frequent)) ||
        rank(a.name, patterns) - rank(b.name, patterns) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}

/**
 * 常点固定在最前，其余只在优先级最高的 2×count 个里按种子轮换：
 * 每天推荐有变化，但不会轮到排在后面的餐品。同一天同一场景结果一致。
 */
function rotate<T extends { frequent?: boolean | undefined }>(list: T[], seed: string, count: number): T[] {
  const head = list.filter((x) => x.frequent);
  const rest = list.filter((x) => !x.frequent).slice(0, Math.max(1, count * 2));
  const start = rest.length ? fnv1a(seed) % rest.length : 0;
  const rotated = rest.map((_, i) => rest[(start + i) % rest.length]!);
  return [...head, ...rotated].slice(0, count);
}

function single(c: MealCandidate): MealPick {
  return {
    name: c.name,
    kcal: c.nutrition.energyKcal,
    protein: c.nutrition.protein,
    sodium: c.nutrition.sodium,
    ...(c.price !== undefined ? { price: c.price } : {}),
    frequent: Boolean(c.frequent),
    parts: [c],
  };
}

function pair(main: MealCandidate, drink: MealCandidate): MealPick {
  const price = main.price !== undefined && drink.price !== undefined ? main.price + drink.price : undefined;
  return {
    name: `${main.name} + ${drink.name}`,
    kcal: main.nutrition.energyKcal + drink.nutrition.energyKcal,
    protein: main.nutrition.protein + drink.nutrition.protein,
    sodium: main.nutrition.sodium + drink.nutrition.sodium,
    ...(price !== undefined ? { price } : {}),
    frequent: Boolean(main.frequent || drink.frequent),
    parts: [main, drink],
  };
}

/**
 * 按餐段挑选推荐。先看餐品类别是否适合这个餐段，再看热量是否在上限内。
 * 午餐/晚餐推荐"主食 + 饮品"，合计不超过上限。
 */
export function pickMeals(
  candidates: readonly MealCandidate[],
  options: { period: MealPeriod; seed: string; count?: number },
): MealPick[] {
  const rule = PERIOD_RULES[options.period];
  const count = options.count ?? 3;

  if (!rule.drinks) {
    return rotate(rankCandidates(candidates, rule.foods, rule.maxKcal, options.period), options.seed, count).map(single);
  }

  const drinks = rankCandidates(candidates, rule.drinks, 250, options.period);
  if (drinks.length === 0) return [];
  const mains = rotate(rankCandidates(candidates, rule.foods, rule.maxKcal, options.period), options.seed, count);
  const out: MealPick[] = [];
  mains.forEach((main, i) => {
    // 饮品也轮换，但必须让合计热量在上限内
    const fits = drinks.filter((d) => main.nutrition.energyKcal + d.nutrition.energyKcal <= rule.maxKcal);
    const drink = fits[i % Math.max(1, fits.length)];
    if (drink) out.push(pair(main, drink));
  });
  return out;
}

/** 营养表本身就是候选（没有门店菜单时的降级）。 */
export function nutritionCandidates(foods: readonly NutritionFood[]): MealCandidate[] {
  return foods.map((f) => ({ name: f.name, nutrition: f }));
}

/**
 * 按餐段推荐：优先用门店菜单（推荐的都是这家店在卖的），
 * 门店菜单里挑不出合适的（比如缓存的还是早餐菜单）就退回营养表。
 */
export function pickForPeriod(
  menu: ReadonlyArray<{ code: string; name: string; price?: number; frequent?: boolean }> | undefined,
  foods: readonly NutritionFood[] | undefined,
  options: { period: MealPeriod; seed: string; count?: number },
): MealPick[] {
  if (!foods?.length) return [];
  if (menu?.length) {
    const picks = pickMeals(menuCandidates(menu, foods), options);
    if (picks.length) return picks;
  }
  return pickMeals(nutritionCandidates(foods), options);
}

/** 有门店菜单就只用门店在卖的餐品，否则退回营养表。 */
export function mealCandidates(
  menu: ReadonlyArray<{ code: string; name: string; price?: number; frequent?: boolean }> | undefined,
  foods: readonly NutritionFood[] | undefined,
): MealCandidate[] {
  if (!foods?.length) return [];
  if (menu?.length) {
    const fromMenu = menuCandidates(menu, foods);
    if (fromMenu.length) return fromMenu;
  }
  return nutritionCandidates(foods);
}

/**
 * 门店菜单 + 营养表 → 候选。找不到营养数据的餐品不推荐，保证每个推荐都附热量。
 * 用门店菜单做候选，推荐的都是这家店当前在卖的，并且带商品编码可以直接下单。
 */
export function menuCandidates(
  menu: ReadonlyArray<{ code: string; name: string; price?: number; frequent?: boolean }>,
  foods: readonly NutritionFood[],
): MealCandidate[] {
  const out: MealCandidate[] = [];
  const seen = new Set<string>();
  for (const item of menu) {
    if (seen.has(item.code)) continue;
    seen.add(item.code);
    const nutrition = matchNutrition(item, foods);
    if (!nutrition) continue;
    out.push({
      name: item.name,
      nutrition,
      code: item.code,
      ...(item.price !== undefined ? { price: item.price } : {}),
      ...(item.frequent ? { frequent: true } : {}),
    });
  }
  return out;
}

export function describeMeal(pick: MealPick): string {
  return `${pick.kcal} kcal · 蛋白质 ${pick.protein}g · 钠 ${pick.sodium}mg`;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
