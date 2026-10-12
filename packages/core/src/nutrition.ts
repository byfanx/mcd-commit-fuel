import { McpError } from './errors.js';
import { asNumber } from './json.js';

export interface NutritionFood {
  name: string;
  description?: string;
  energyKj: number;
  energyKcal: number;
  /** 克 */
  protein: number;
  /** 克 */
  fat: number;
  /** 克 */
  carbohydrate: number;
  /** 毫克 */
  sodium: number;
  /** 毫克 */
  calcium: number;
}

const NUMERIC_FIELDS = ['energyKj', 'energyKcal', 'protein', 'fat', 'carbohydrate', 'sodium', 'calcium'] as const;
const HEADER = /^\[(\d+)\]\{([^}]*)\}:\s*$/;

/**
 * 解析 `list-nutrition-foods` 返回的压缩表格：
 *
 *   [160]{productName,nutritionDescription,energyKj,...}:
 *     猪柳麦满分,null,1288,308,16,16,24,781,213
 *
 * 列按表头名称取值；某行列数多于表头时，多出来的逗号算在描述列里。
 * 数值缺失或不合法的行直接跳过。
 */
export function parseNutritionTable(table: string): NutritionFood[] {
  const lines = table.split(/\r?\n/);
  const header = HEADER.exec((lines[0] ?? '').trim());
  if (!header) throw new McpError('PROTOCOL', 'list-nutrition-foods：营养数据表头格式不符合预期');

  const fields = (header[2] ?? '').split(',').map((f) => f.trim());
  const nameIdx = fields.indexOf('productName');
  const descIdx = fields.indexOf('nutritionDescription');
  if (nameIdx < 0 || NUMERIC_FIELDS.some((f) => !fields.includes(f))) {
    throw new McpError('PROTOCOL', 'list-nutrition-foods：营养数据缺少必要的列');
  }

  const foods: NutritionFood[] = [];
  rows: for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;

    let cols = line.split(',');
    const extra = cols.length - fields.length;
    if (extra < 0) continue;
    if (extra > 0) {
      if (descIdx < 0) continue;
      cols = [
        ...cols.slice(0, descIdx),
        cols.slice(descIdx, descIdx + extra + 1).join(','),
        ...cols.slice(descIdx + extra + 1),
      ];
    }
    const get = (field: string) => cols[fields.indexOf(field)]?.trim();

    const name = get('productName');
    if (!name) continue;

    const values = {} as Record<(typeof NUMERIC_FIELDS)[number], number>;
    for (const field of NUMERIC_FIELDS) {
      const n = asNumber(get(field));
      if (n === undefined) continue rows;
      values[field] = n;
    }

    const description = descIdx >= 0 ? get('nutritionDescription') : undefined;
    foods.push({
      name,
      ...(description && description !== 'null' ? { description } : {}),
      ...values,
    });
  }
  return foods;
}

/** 菜单名和营养表名称写法不同（"麦咖啡™热美式中杯" / "热美式中杯"），比较前先去掉品牌、括号和空格。 */
export function normalizeFoodName(name: string): string {
  return name
    .replace(/麦咖啡|™|®/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/^100%/, '');
}

/**
 * 给菜单项找营养数据：名称完全一致优先；否则取以菜单名开头的规格（如"优品豆浆" → "优品豆浆大杯"），
 * 多个规格时取热量最高的，宁可多报。
 */
export function matchNutrition(item: { name: string }, foods: readonly NutritionFood[]): NutritionFood | undefined {
  const name = normalizeFoodName(item.name);
  if (!name) return undefined;
  const exact = foods.find((f) => normalizeFoodName(f.name) === name);
  if (exact) return exact;
  return foods
    .filter((f) => normalizeFoodName(f.name).startsWith(name))
    .sort((a, b) => b.energyKcal - a.energyKcal)[0];
}
