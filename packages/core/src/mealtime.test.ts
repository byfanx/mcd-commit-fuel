import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentPeriod, mealCandidates, mealPeriod, nutritionCandidates, pickForPeriod, pickMeals } from './mealtime.js';
import type { NutritionFood } from './nutrition.js';

const food = (name: string, energyKcal: number): NutritionFood => ({
  name,
  energyKj: Math.round(energyKcal * 4.184),
  energyKcal,
  protein: 10,
  fat: 5,
  carbohydrate: 20,
  sodium: 300,
  calcium: 50,
});

const FOODS = [
  food('猪柳蛋麦满分', 387),
  food('皮蛋鸡肉粥', 133),
  food('优品豆浆小杯', 151),
  food('麦辣鸡腿汉堡', 540),
  food('麦香鱼', 350),
  food('双层安格斯厚牛堡', 1003),
  food('无糖可口可乐中杯', 0),
  food('中薯条', 289),
  food('锡兰红茶', 2),
  food('热美式中杯', 13),
  food('菠萝派', 221),
  food('麦旋风', 300),
  food('苹果片', 32),
];

const at = (h: number, m = 0) => new Date(2026, 9, 10, h, m).getTime();

test('mealPeriod boundaries', () => {
  assert.equal(mealPeriod(at(6)), 'breakfast');
  assert.equal(mealPeriod(at(10, 29)), 'breakfast');
  assert.equal(mealPeriod(at(10, 30)), 'other');
  assert.equal(mealPeriod(at(11)), 'lunch');
  assert.equal(mealPeriod(at(13, 30)), 'other');
  assert.equal(mealPeriod(at(14)), 'afternoonTea');
  assert.equal(mealPeriod(at(16, 59)), 'afternoonTea');
  assert.equal(mealPeriod(at(17, 30)), 'dinner');
  assert.equal(mealPeriod(at(20)), 'other');
  assert.equal(currentPeriod(at(23), true), 'lateNight');
  assert.equal(currentPeriod(at(14), false), 'afternoonTea');
});

const names = (period: Parameters<typeof pickMeals>[1]['period'], count = 10) =>
  pickMeals(nutritionCandidates(FOODS), { period, seed: 'x', count }).map((p) => p.name);

test('breakfast picks breakfast items first, never fries or desserts', () => {
  const picks = names('breakfast');
  assert.deepEqual(picks.sort(), ['优品豆浆小杯', '热美式中杯', '猪柳蛋麦满分', '皮蛋鸡肉粥'].sort());
});

test('lunch pairs a burger with a drink within 800kcal and skips breakfast items', () => {
  const picks = pickMeals(nutritionCandidates(FOODS), { period: 'lunch', seed: 'x', count: 10 });
  assert.ok(picks.length > 0);
  for (const p of picks) {
    assert.equal(p.parts.length, 2);
    assert.ok(p.kcal <= 800, `${p.name} ${p.kcal}`);
    assert.doesNotMatch(p.name, /麦满分|粥|薯条|麦旋风|安格斯/);
  }
  const mains = picks.map((p) => p.parts[0]!.name).sort();
  assert.deepEqual(mains, ['麦辣鸡腿汉堡', '麦香鱼'].sort());
});

test('rotation stays within the highest-priority items', () => {
  // 10 个低优先级的"堡"排在麦香鱼、麦辣鸡腿汉堡之后，只推荐 1 个时不会轮到它们
  const many = [...FOODS, ...Array.from({ length: 10 }, (_, i) => food(`示例堡${i}`, 400))];
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const [pick] = pickMeals(nutritionCandidates(many), { period: 'lunch', seed, count: 1 });
    assert.match(pick!.name, /^(麦香鱼|麦辣鸡腿汉堡) \+ /, seed);
  }
});

test('afternoon tea picks tea, coffee and pies', () => {
  assert.deepEqual(names('afternoonTea').sort(), ['热美式中杯', '苹果片', '菠萝派', '锡兰红茶'].sort());
});

test('late night: light only and no caffeine', () => {
  assert.deepEqual(names('lateNight').sort(), ['优品豆浆小杯', '皮蛋鸡肉粥', '苹果片'].sort());
});

test('picks are deterministic for the same seed', () => {
  const a = pickMeals(nutritionCandidates(FOODS), { period: 'afternoonTea', seed: 'day1' });
  const b = pickMeals(nutritionCandidates(FOODS), { period: 'afternoonTea', seed: 'day1' });
  assert.deepEqual(a, b);
});

test('mealCandidates uses the store menu when it matches, otherwise the nutrition table', () => {
  const menu = [
    { code: 'a', name: '锡兰红茶', price: 1150, frequent: true },
    { code: 'b', name: '查无此物', price: 100 },
  ];
  const fromMenu = mealCandidates(menu, FOODS);
  assert.deepEqual(
    fromMenu.map((c) => [c.code, c.name, c.frequent ?? false]),
    [['a', '锡兰红茶', true]],
  );
  assert.equal(mealCandidates([{ code: 'b', name: '查无此物' }], FOODS).length, FOODS.length);
  assert.deepEqual(mealCandidates(menu, undefined), []);
});

test('lunch never recommends breakfast burgers', () => {
  const breakfastMenu = [food('猪柳炒双蛋堡', 380), food('原味板烧鸡腿炒双蛋堡', 400), food('无糖可口可乐中杯', 0)];
  const picks = pickMeals(nutritionCandidates(breakfastMenu), { period: 'lunch', seed: 'x', count: 5 });
  assert.deepEqual(picks, []);
});

test('pickForPeriod falls back to the nutrition table when the cached menu has nothing for this period', () => {
  const breakfastOnly = [{ code: 'b1', name: '猪柳蛋麦满分' }, { code: 'b2', name: '皮蛋鸡肉粥' }];
  const picks = pickForPeriod(breakfastOnly, FOODS, { period: 'lunch', seed: 'x' });
  assert.ok(picks.length > 0);
  assert.ok(picks.every((p) => p.parts.length === 2 && !p.parts[0]!.code), 'came from the nutrition table');
  // 门店菜单能挑出来时用门店菜单，带商品编码
  const fromMenu = pickForPeriod([{ code: 't1', name: '锡兰红茶' }], FOODS, { period: 'afternoonTea', seed: 'x' });
  assert.deepEqual(fromMenu.map((p) => p.parts[0]?.code), ['t1']);
});
