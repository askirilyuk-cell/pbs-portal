// ============================================================================
//  Миграция 032 — «Каталог канонической номенклатуры» (K-54, MVP).
//
//  Задача (одобрено Александром [USER=11]): одна и та же позиция закупается под
//  разными названиями/толщинами/единицами («лист АМГ6» / «Лист г/к 10х1500х6000» /
//  «металл лист 6мм»; грунт — м³, проволока — кг/катушка, газы — баллон). Нужна
//  нормализация → канон-карточка + алиасы + базовая ед + история цен НА КАНОН.
//
//  Что создаёт (в базе «Производство ПБС»):
//   • «Номенклатура-канон» (catalog_canon) — одна карточка на изделие:
//       Каноническое наименование (pv), Тип, Марка/материал, Типоразмер,
//       ISO-обозначение (для инструмента), Категория (SingleSelect), Примечание.
//       Базовая единица — СВЯЗЬ на «Единицы измерения» (dict_units), см. ниже.
//   • «Алиасы номенклатуры» (catalog_aliases) — «как называют» → привязка к канону:
//       Наименование (pv), Источник/производитель, Единица в источнике,
//       Коэффициент к базовой (задел под авто-конвертацию — СЛЕДУЮЩИЙ этап).
//   • «История цен» (catalog_prices) — цены НА КАНОН от разных названий/поставщиков:
//       Дата, Поставщик, Цена, Единица, Кол-во, Цена в базовой ед (₽/базовую),
//       Наименование в источнике, Источник (SingleSelect счёт/заказ/ЗнЗ/…), Примечание.
//   • Связи (все hm со стороны «один» — стиль migrate-023; реципрок bt авто на «многих»):
//       Канон → Алиасы  («Алиасы»),  Канон → История цен  («История цен»),
//       Единицы измерения → Канон  («Позиции канона (ЕИ)», реципрок bt на каноне =
//       «Единицы измерения» — базовая единица канона).
//
//  РЕШЕНИЕ ПО ЕДИНИЦАМ (допущение, требует подтверждения Александра):
//   dict_units НЕ расширяем полями «Базовая ед группы»/«Коэффициент к базовой».
//   Коэффициент перевода кладём на СТРОКУ АЛИАСА («Коэффициент к базовой»), т.к.
//   перевод по своей природе per-alias/per-типоразмер (1 «лист 10х1500х6000» → N кг
//   зависит от типоразмера, а не от глобальной единицы «кг»). Базовая единица канона —
//   это связь на общий справочник dict_units (без дублей ЕИ). Авто-конвертацию цен в
//   MVP НЕ включаем (поле-задел есть) — это следующий этап (авто-матчинг + перевод).
//
//  СТРОГО АДДИТИВНАЯ (стиль migrate-023): только СОЗДАНИЕ таблиц/колонок/связей.
//  Ноль rename, ноль смены типов существующих колонок, ноль удалений. Идемпотентно
//  (skip-if-exists). Существующий dict_units не трогаем (только добавляем hm-связь).
//
//  БЕЗОПАСНОСТЬ ЗАПИСИ: DRY_RUN — ПО УМОЛЧАНИЮ. Запись ТОЛЬКО при ЯВНЫХ ОБОИХ флагах:
//      DRY_RUN=0 APPLY_CONFIRM=YES
//  APPLY даёт оркестратор по «Деплой» Александра (не этот скрипт по умолчанию).
//
//  Запуск (DRY-RUN, по умолчанию — НИЧЕГО не пишется):
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=... node nocodb/schema/migrate-032-catalog-canon.mjs
//  Запуск (APPLY, только по гринлайту Александра):
//    NC_URL=... NC_TOKEN=... DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-032-catalog-canon.mjs
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = 'Производство ПБС';
const APPLY = process.env.DRY_RUN === '0' && process.env.APPLY_CONFIRM === 'YES';
const DRY_RUN = !APPLY;
const log = (...a) => console.log('  ', ...a);
const plan = (...a) => console.log('   [dry]', ...a);

// хелперы описания колонок (стиль migrate-023)
const txt = (title, column_name, pv) => ({ title, column_name, uidt: 'SingleLineText', ...(pv ? { pv: true } : {}) });
const long = (title, column_name) => ({ title, column_name, uidt: 'LongText' });
const dec = (title, column_name) => ({ title, column_name, uidt: 'Decimal' });
const date = (title, column_name) => ({ title, column_name, uidt: 'Date' });
const sel = (title, column_name, options) => ({
  title, column_name, uidt: 'SingleSelect',
  colOptions: { options: options.map((o) => ({ title: o })) },
  dtxp: options.map((o) => `'${o.replace(/'/g, "''")}'`).join(','),
});

// канон-категории (SingleSelect); задел, редактируется в NocoDB при необходимости
const CANON_CATEGORIES = ['Металл', 'Материалы', 'Инструмент', 'Крепёж / сварка', 'Газы', 'ЛКМ', 'Прочее'];
// источник записи истории цен (SingleSelect)
const PRICE_SOURCES = ['Счёт', 'Заказ', 'ЗнЗ', 'Прайс', 'Прочее'];

async function main() {
  await nc.signin();
  const base = await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База «${BASE_TITLE}» не найдена`);
  let tables = await nc.listTables(base.id);
  const find = (t) => tables.find((x) => x.title === t);

  console.log(`\n=== Миграция 032 «Каталог канон-номенклатуры» (K-54) — режим: ${DRY_RUN ? 'DRY_RUN (ничего не пишется)' : 'APPLY (запись в прод)'} ===\n`);

  async function ensureTable(title, table_name, columns) {
    const existing = find(title);
    if (existing) { log(`таблица «${title}» уже есть — пропуск`); return existing; }
    if (DRY_RUN) {
      plan(`создать таблицу «${title}» (${table_name}) с ${columns.length} колонками:`);
      for (const c of columns) plan(`     • «${c.title}» [${c.uidt}]${c.pv ? ' (pv)' : ''}${c.uidt === 'SingleSelect' ? ' {' + c.colOptions.options.map((o) => o.title).join('|') + '}' : ''}`);
      return { id: null, title, __planned: true };
    }
    log(`создаю таблицу «${title}»`);
    const t = await nc.createTable(base.id, { table_name, title, columns });
    tables = await nc.listTables(base.id);
    return find(title) || t;
  }

  async function ensureLink(parent, child, title, type = 'hm') {
    if (!parent || !child) { log(`связь «${title}»: нет таблицы — пропуск`); return; }
    if (DRY_RUN) { plan(`+ связь «${parent.title}» → «${child.title}» (${type}) как «${title}»`); return; }
    try {
      const full = await nc.getTable(parent.id);
      if (full.columns.some((c) => c.title === title)) { log(`связь «${title}» есть — пропуск`); return; }
      await nc.createLink(parent.id, { title, childTableId: child.id, type });
      log(`+ связь «${parent.title}» → «${child.title}» (${type}) как «${title}»`);
    } catch (e) { log(`⚠ связь «${title}» не создана (${type}): ${e.message}`); }
  }

  // --- существующие справочники (dict_units должен быть от migrate-023) -------
  const units = find('Единицы измерения');
  if (!units) log('⚠ «Единицы измерения» (dict_units) не найдена — базовую ед канона свяжете после migrate-023 (APPLY). Каталог создастся без ЕИ-связи.');

  // --- 1) «Номенклатура-канон» ----------------------------------------------
  const canon = await ensureTable('Номенклатура-канон', 'catalog_canon', [
    txt('Каноническое наименование', 'canon_name', true),   // pv — «Лист стальной г/к, Ст3, 6 мм»
    txt('Тип', 'kind'),                                       // лист / пруток / фреза / грунт / газ …
    txt('Марка / материал', 'grade'),                         // Ст3 / АМГ6 / ВК8 …
    txt('Типоразмер', 'size'),                                // 6 мм / ⌀20 / 10×1500×6000 …
    txt('ISO-обозначение', 'iso'),                            // для инструмента (по геометрии/ISO)
    sel('Категория', 'category', CANON_CATEGORIES),
    long('Примечание', 'note'),
  ]);

  // --- 2) «Алиасы номенклатуры» ---------------------------------------------
  const aliases = await ensureTable('Алиасы номенклатуры', 'catalog_aliases', [
    txt('Наименование', 'alias_name', true),                  // pv — «как называют» (в счетах/у производителей)
    txt('Источник / производитель', 'source'),
    txt('Единица в источнике', 'source_unit'),                // ед, в которой встречается это название
    dec('Коэффициент к базовой', 'conv_factor'),              // задел под авто-конвертацию (сколько базовых ед в 1 ед источника)
    long('Примечание', 'note'),
  ]);

  // --- 3) «История цен» (на канон) ------------------------------------------
  const prices = await ensureTable('История цен', 'catalog_prices', [
    txt('Заголовок', 'title', true),                          // pv — «<канон> · <поставщик> · ДД.ММ.ГГГГ»
    date('Дата', 'priced_at'),
    txt('Поставщик', 'supplier'),
    dec('Цена', 'price'),
    txt('Единица', 'unit'),                                   // ед, в которой дана цена (может ≠ базовой)
    dec('Кол-во', 'qty'),
    dec('Цена в базовой ед', 'price_base'),                   // ₽/базовую — нормализованная (в MVP вводится вручную)
    txt('Наименование в источнике', 'source_name'),          // как названо в счёте/заказе (для трассировки)
    sel('Источник', 'source_type', PRICE_SOURCES),
    long('Примечание', 'note'),
  ]);

  // --- 4) Связи (hm со стороны «один»; реципрок bt авто на «многих») ----------
  await ensureLink(canon, aliases, 'Алиасы', 'hm');            // Канон → Алиасы (реципр. «Номенклатура-канон»)
  await ensureLink(canon, prices, 'История цен', 'hm');        // Канон → История цен (реципр. «Номенклатура-канон»)
  // базовая единица канона: dict_units → канон (реципр. bt на каноне = «Единицы измерения»)
  await ensureLink(units, canon, 'Позиции канона (ЕИ)', 'hm');

  console.log(`\n✓ Миграция 032 (каталог канон-номенклатуры, K-54)${DRY_RUN ? ' — DRY_RUN: ничего не записано' : ' — APPLY: применена'}.`);
  if (DRY_RUN) console.log('   Для записи (по гринлайту Александра): DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-032-catalog-canon.mjs');
}

main().catch((e) => { console.error('✗ Ошибка миграции 032:', e.message); process.exit(1); });
