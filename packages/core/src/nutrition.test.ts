import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNutritionTable } from './nutrition.js';
import { McpError } from './errors.js';

const HEADER = '[4]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:';

test('parses rows and drops null descriptions', () => {
  const foods = parseNutritionTable(
    [HEADER, '  苹果片,null,133,32,0,0,7,0,18', '  柠檬拉明顿,能量约猕猴桃2个,506,121,2,7,12,35,17'].join('\n'),
  );
  assert.deepEqual(foods, [
    { name: '苹果片', energyKj: 133, energyKcal: 32, protein: 0, fat: 0, carbohydrate: 7, sodium: 0, calcium: 18 },
    {
      name: '柠檬拉明顿',
      description: '能量约猕猴桃2个',
      energyKj: 506,
      energyKcal: 121,
      protein: 2,
      fat: 7,
      carbohydrate: 12,
      sodium: 35,
      calcium: 17,
    },
  ]);
});

test('keeps commas inside the description column', () => {
  const [food] = parseNutritionTable([HEADER, '测试餐品,约1个苹果,或半根香蕉,100,24,1,0,5,1,2'].join('\n'));
  assert.equal(food?.name, '测试餐品');
  assert.equal(food?.description, '约1个苹果,或半根香蕉');
  assert.equal(food?.energyKcal, 24);
  assert.equal(food?.calcium, 2);
});

test('follows header column order', () => {
  const header = '[1]{energyKcal,productName,energyKj,protein,fat,carbohydrate,sodium,calcium}:';
  const [food] = parseNutritionTable([header, '50,美式咖啡,209,1,0,9,10,20'].join('\n'));
  assert.equal(food?.name, '美式咖啡');
  assert.equal(food?.energyKcal, 50);
  assert.equal(food?.energyKj, 209);
});

test('skips blank and malformed rows', () => {
  const foods = parseNutritionTable(
    [HEADER, '', '缺列,null,1,2', '非数字,null,abc,32,0,0,7,0,18', '正常,null,133,32,0,0,7,0,18'].join('\r\n'),
  );
  assert.deepEqual(
    foods.map((f) => f.name),
    ['正常'],
  );
});

test('throws PROTOCOL on unexpected header', () => {
  assert.throws(
    () => parseNutritionTable('productName,energyKcal\n苹果片,32'),
    (err: unknown) => err instanceof McpError && err.kind === 'PROTOCOL',
  );
  assert.throws(
    () => parseNutritionTable('[1]{productName,energyKcal}:\n苹果片,32'),
    (err: unknown) => err instanceof McpError && err.kind === 'PROTOCOL',
  );
});
