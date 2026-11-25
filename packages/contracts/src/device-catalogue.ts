/**
 * Built-in device data (Sprint 2 story §2 DV1, decision A18): device types, brands per type and the seed model
 * catalogue. Data only, not editable per shop in Sprint 2. Free text is always accepted for brand ("Other") and model.
 */

export const DEVICE_TYPES = ['PHONE', 'TABLET', 'LAPTOP', 'DESKTOP', 'CONSOLE', 'WATCH', 'OTHER'] as const;
export type DeviceTypeValue = (typeof DEVICE_TYPES)[number];

export const DEVICE_TYPE_LABELS: Record<DeviceTypeValue, string> = {
  PHONE: 'Phone',
  TABLET: 'Tablet',
  LAPTOP: 'Laptop',
  DESKTOP: 'Desktop',
  CONSOLE: 'Console',
  WATCH: 'Watch',
  OTHER: 'Other',
};

/** Types that show the IMEI field (DV2.4). IMEI on any other type → 400 VALIDATION_FAILED. Serial is for every type. */
export const IMEI_DEVICE_TYPES: readonly DeviceTypeValue[] = ['PHONE', 'TABLET', 'WATCH'];

/** Brand choice meaning "type the brand yourself". */
export const OTHER_BRAND = 'Other';

/**
 * Brand select options per type, most common first (story §10: US/UK/PK brands). The web appends "Other"
 * (`OTHER_BRAND`), which reveals a free-text brand field; the stored `brand` is the free text.
 */
export const DEVICE_BRANDS_BY_TYPE: Record<DeviceTypeValue, readonly string[]> = {
  PHONE: [
    'Apple', 'Samsung', 'Google', 'Motorola', 'Xiaomi', 'Redmi', 'Infinix', 'Tecno', 'Oppo', 'Vivo', 'Realme',
    'OnePlus', 'Nokia', 'Huawei', 'Honor', 'Sony',
  ],
  TABLET: ['Apple', 'Samsung', 'Lenovo', 'Amazon', 'Microsoft', 'Xiaomi', 'Huawei'],
  LAPTOP: ['Apple', 'Dell', 'HP', 'Lenovo', 'Asus', 'Acer', 'Microsoft', 'MSI', 'Samsung', 'Razer'],
  DESKTOP: ['Apple', 'Dell', 'HP', 'Lenovo', 'Asus', 'Acer', 'Custom build'],
  CONSOLE: ['Sony', 'Microsoft', 'Nintendo', 'Valve'],
  WATCH: ['Apple', 'Samsung', 'Google', 'Garmin', 'Fitbit', 'Huawei'],
  OTHER: [],
};

export interface CatalogueModel {
  type: DeviceTypeValue;
  brand: string;
  model: string;
}

const models = (type: DeviceTypeValue, brand: string, names: readonly string[]): CatalogueModel[] =>
  names.map((model) => ({ type, brand, model }));

const range = (prefix: string, from: number, to: number, suffixes: readonly string[] = ['']): string[] => {
  const out: string[] = [];
  for (let n = from; n <= to; n++) for (const s of suffixes) out.push(`${prefix}${n}${s}`);
  return out;
};

/**
 * Seed catalogue for model suggestions (DV1.2), ~200 entries. Suggestions = catalogue matches for type+brand
 * plus models this shop has used before (most used first); see `ModelSuggestionsQuery`.
 */
export const DEVICE_MODEL_CATALOGUE: readonly CatalogueModel[] = [
  // Apple iPhone 11–16 incl. Pro / Pro Max / Plus / mini, SE 2nd/3rd gen
  ...models('PHONE', 'Apple', [
    'iPhone 11', 'iPhone 11 Pro', 'iPhone 11 Pro Max',
    'iPhone 12 mini', 'iPhone 12', 'iPhone 12 Pro', 'iPhone 12 Pro Max',
    'iPhone 13 mini', 'iPhone 13', 'iPhone 13 Pro', 'iPhone 13 Pro Max',
    'iPhone 14', 'iPhone 14 Plus', 'iPhone 14 Pro', 'iPhone 14 Pro Max',
    'iPhone 15', 'iPhone 15 Plus', 'iPhone 15 Pro', 'iPhone 15 Pro Max',
    'iPhone 16', 'iPhone 16 Plus', 'iPhone 16 Pro', 'iPhone 16 Pro Max', 'iPhone 16e',
    'iPhone SE (2nd generation)', 'iPhone SE (3rd generation)',
  ]),
  // Samsung Galaxy S20–S24 incl. + / Ultra / FE, A13–A55
  ...models('PHONE', 'Samsung', [
    'Galaxy S20', 'Galaxy S20+', 'Galaxy S20 Ultra', 'Galaxy S20 FE',
    'Galaxy S21', 'Galaxy S21+', 'Galaxy S21 Ultra', 'Galaxy S21 FE',
    'Galaxy S22', 'Galaxy S22+', 'Galaxy S22 Ultra',
    'Galaxy S23', 'Galaxy S23+', 'Galaxy S23 Ultra', 'Galaxy S23 FE',
    'Galaxy S24', 'Galaxy S24+', 'Galaxy S24 Ultra', 'Galaxy S24 FE',
    'Galaxy A13', 'Galaxy A14', 'Galaxy A15', 'Galaxy A23', 'Galaxy A24', 'Galaxy A25', 'Galaxy A33', 'Galaxy A34',
    'Galaxy A35', 'Galaxy A53', 'Galaxy A54', 'Galaxy A55',
    'Galaxy Z Flip5', 'Galaxy Z Fold5',
  ]),
  // Google Pixel 6–9 incl. Pro / a
  ...models('PHONE', 'Google', [
    'Pixel 6', 'Pixel 6 Pro', 'Pixel 6a', 'Pixel 7', 'Pixel 7 Pro', 'Pixel 7a', 'Pixel 8', 'Pixel 8 Pro', 'Pixel 8a',
    'Pixel 9', 'Pixel 9 Pro', 'Pixel 9 Pro XL', 'Pixel 9a',
  ]),
  ...models('PHONE', 'Motorola', ['Moto G Power', 'Moto G Stylus', 'Moto G Play', 'Edge', 'Razr']),
  // PK-popular
  ...models('PHONE', 'Infinix', ['Hot 30', 'Hot 40', 'Hot 40 Pro', 'Hot 50', 'Note 30', 'Note 40', 'Note 40 Pro', 'Smart 8']),
  ...models('PHONE', 'Tecno', ['Spark 10', 'Spark 20', 'Spark 20 Pro', 'Camon 20', 'Camon 30', 'Pova 6']),
  ...models('PHONE', 'Redmi', [
    ...range('Redmi Note ', 10, 13),
    ...range('Redmi Note ', 10, 13, [' Pro']),
    'Redmi 12', 'Redmi 13', 'Redmi A3',
  ]),
  ...models('PHONE', 'Xiaomi', ['Xiaomi 13T', 'Xiaomi 14', 'Poco X6', 'Poco F6']),
  ...models('PHONE', 'Oppo', ['A17', 'A18', 'A38', 'A58', 'A78', 'Reno 10', 'Reno 11', 'Reno 12']),
  ...models('PHONE', 'Vivo', ['Y03', 'Y17s', 'Y27', 'Y36', 'Y100', 'V30']),
  ...models('PHONE', 'Realme', ['C53', 'C55', 'C67', 'Note 50', '12 Pro']),
  // Apple iPad
  ...models('TABLET', 'Apple', [
    'iPad (9th generation)', 'iPad (10th generation)',
    'iPad Air (4th generation)', 'iPad Air (5th generation)', 'iPad Air 11-inch (M2)', 'iPad Air 13-inch (M2)',
    'iPad Pro 11-inch', 'iPad Pro 12.9-inch', 'iPad Pro 11-inch (M4)', 'iPad Pro 13-inch (M4)',
    'iPad mini (6th generation)', 'iPad mini (A17 Pro)',
  ]),
  ...models('TABLET', 'Samsung', ['Galaxy Tab A8', 'Galaxy Tab A9', 'Galaxy Tab A9+', 'Galaxy Tab S8', 'Galaxy Tab S9', 'Galaxy Tab S9 FE']),
  // MacBook Air / Pro M1–M3
  ...models('LAPTOP', 'Apple', [
    'MacBook Air 13-inch (M1)', 'MacBook Air 13-inch (M2)', 'MacBook Air 15-inch (M2)', 'MacBook Air 13-inch (M3)',
    'MacBook Air 15-inch (M3)', 'MacBook Pro 13-inch (M1)', 'MacBook Pro 13-inch (M2)', 'MacBook Pro 14-inch (M1 Pro)',
    'MacBook Pro 16-inch (M1 Pro)', 'MacBook Pro 14-inch (M2 Pro)', 'MacBook Pro 16-inch (M2 Pro)',
    'MacBook Pro 14-inch (M3)', 'MacBook Pro 14-inch (M3 Pro)', 'MacBook Pro 16-inch (M3 Pro)',
  ]),
  ...models('LAPTOP', 'Dell', ['XPS 13', 'XPS 15', 'Inspiron 15', 'Latitude 5440', 'Vostro 15']),
  ...models('LAPTOP', 'HP', ['Pavilion 15', 'EliteBook 840', 'ProBook 450', 'Envy x360', 'Victus 15']),
  ...models('LAPTOP', 'Lenovo', ['ThinkPad T14', 'ThinkPad E14', 'IdeaPad 3', 'IdeaPad 5', 'Legion 5', 'Yoga 7']),
  ...models('LAPTOP', 'Asus', ['VivoBook 15', 'ZenBook 14', 'TUF Gaming F15', 'ROG Strix G16']),
  ...models('LAPTOP', 'Acer', ['Aspire 5', 'Swift 3', 'Nitro 5']),
  ...models('LAPTOP', 'Microsoft', ['Surface Laptop 5', 'Surface Pro 9']),
  ...models('DESKTOP', 'Apple', ['iMac 24-inch (M1)', 'iMac 24-inch (M3)', 'Mac mini (M2)', 'Mac Studio']),
  ...models('DESKTOP', 'Dell', ['OptiPlex 7010', 'Inspiron Desktop']),
  ...models('DESKTOP', 'HP', ['ProDesk 400', 'Pavilion Desktop', 'All-in-One 24']),
  // Consoles
  ...models('CONSOLE', 'Sony', ['PlayStation 4', 'PlayStation 4 Slim', 'PlayStation 4 Pro', 'PlayStation 5', 'PlayStation 5 Digital Edition', 'PlayStation 5 Slim', 'PlayStation 5 Pro', 'DualSense controller', 'DualShock 4 controller']),
  ...models('CONSOLE', 'Microsoft', ['Xbox One', 'Xbox One S', 'Xbox One X', 'Xbox Series S', 'Xbox Series X', 'Xbox Wireless Controller']),
  ...models('CONSOLE', 'Nintendo', ['Switch', 'Switch OLED', 'Switch Lite', 'Joy-Con']),
  ...models('CONSOLE', 'Valve', ['Steam Deck', 'Steam Deck OLED']),
  // Apple Watch Series 6–9 / SE / Ultra
  ...models('WATCH', 'Apple', [
    'Apple Watch Series 6', 'Apple Watch Series 7', 'Apple Watch Series 8', 'Apple Watch Series 9',
    'Apple Watch SE', 'Apple Watch SE (2nd generation)', 'Apple Watch Ultra', 'Apple Watch Ultra 2',
  ]),
  ...models('WATCH', 'Samsung', ['Galaxy Watch5', 'Galaxy Watch6', 'Galaxy Watch7']),
  ...models('WATCH', 'Google', ['Pixel Watch', 'Pixel Watch 2']),
];

/** Colour suggestions (free text ≤ 30 is always accepted). */
export const DEVICE_COLOUR_SUGGESTIONS = [
  'Black', 'White', 'Silver', 'Gold', 'Space Grey', 'Graphite', 'Blue', 'Green', 'Red', 'Purple', 'Pink', 'Yellow',
  'Midnight', 'Starlight', 'Titanium',
] as const;

/**
 * Catalogue suggestions for a type + brand, filtered by `q` (case-insensitive, every word must appear).
 * Pure; the API merges these with the shop's own history.
 */
export function catalogueModels(type: DeviceTypeValue, brand: string | null | undefined, q = '', limit = 20): string[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const b = brand?.trim().toLowerCase();
  return DEVICE_MODEL_CATALOGUE.filter(
    (m) =>
      m.type === type &&
      (!b || m.brand.toLowerCase() === b) &&
      words.every((w) => m.model.toLowerCase().includes(w)),
  )
    .slice(0, limit)
    .map((m) => m.model);
}
