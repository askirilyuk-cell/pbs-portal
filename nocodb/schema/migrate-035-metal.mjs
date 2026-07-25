// ============================================================================
//  Миграция 035 — раздел «Учёт остатков металла» (K-XX, контур ДП–СХ / ДП–О).
//  Заземлена на канон-номенклатуру (migrate-032, таблица «Номенклатура-канон»,
//  категория «Металл») и на модуль «Инструмент» (migrate-026) как образец кода.
//
//  СТРОГО АДДИТИВНАЯ (стиль migrate-023/026/032): только СОЗДАНИЕ новых таблиц /
//  колонок / связей + засев реестра остатков из канон-Металла. Ноль rename, ноль
//  смены типов, ноль удалений → :4173 не ломается, соседние модули не затрагиваются.
//
//  Что создаёт (в базе «Производство ПБС»):
//   • «Остаток металла» (metal_stock) — реестр 1:1 к канон-карточке «Металл»:
//       Код (pv МС-NNNN) · Марка · Тип проката (Лист/Круг) · Типоразмер · ГОСТ ·
//       Ед. изм. (кг) · Остаток · Резерв · Мин. остаток · Норма пересчёта (кг/ед) ·
//       Склад по умолчанию · Ячейка · Примечание. Связь bt → «Номенклатура-канон».
//   • «Движения металла» (metal_movements) — журнал (running-баланс «Остаток после»):
//       Проводка (pv) · Код · Дата · Операция (Приход/Расход/Списание/Инвентаризация/
//       Резерв/Снятие резерва) · Кол-во (кг) · Остаток после · Раскрой/формат ·
//       Кол-во ед. · Поставщик · № счёта · № сертификата/плавки · Позиция ПЗ ·
//       Деталь · Основание/комментарий · Автор. Связи: «Позиция»→metal_stock,
//       «№ ЗнЗ»→«Заявки ЗнЗ», «ПЗ»→«Заказы» (hm со стороны «один», реципрок bt авто).
//   • «Деловые остатки» (metal_remnants) — надстройка: Код (pv ДО-NNNN) · Марка ·
//       Тип проката · Размеры · Толщина · Вес (кг) · Статус · Склад/ячейка ·
//       № сертификата/плавки · Дата. Связи: «Позиция»→metal_stock, «Источник ПЗ»→«Заказы».
//
//  ЗАСЕВ (только APPLY): по одной карточке metal_stock на каждую канон-карточку
//  с «Категория» = «Металл» (Остаток=0, Резерв=0), с bt-привязкой к канону.
//  Идемпотентно: карточки с уже существующим кодом канона не дублируются.
//
//  БЕЗОПАСНОСТЬ ЗАПИСИ (как migrate-026/032): DRY_RUN — ПО УМОЛЧАНИЮ. Запись
//  ТОЛЬКО при ЯВНЫХ ОБОИХ флагах: DRY_RUN=0 APPLY_CONFIRM=YES
//
//  Запуск (DRY-RUN, по умолчанию — НИЧЕГО не пишется):
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=... node nocodb/schema/migrate-035-metal.mjs
//  Запуск (APPLY, только по гринлайту Александра):
//    NC_URL=... NC_TOKEN=... DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-035-metal.mjs
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = 'Производство ПБС';
const APPLY = process.env.DRY_RUN === '0' && process.env.APPLY_CONFIRM === 'YES';
const DRY_RUN = !APPLY;
const log = (...a) => console.log('  ', ...a);
const plan = (...a) => console.log('   [dry]', ...a);

// хелперы описания колонок (стиль migrate-026/032)
const txt = (title, column_name, pv) => ({ title, column_name, uidt: 'SingleLineText', ...(pv ? { pv: true } : {}) });
const long = (title, column_name) => ({ title, column_name, uidt: 'LongText' });
const dec = (title, column_name) => ({ title, column_name, uidt: 'Decimal' });
const date = (title, column_name) => ({ title, column_name, uidt: 'Date' });
const sel = (title, column_name, options) => ({
  title, column_name, uidt: 'SingleSelect',
  colOptions: { options: options.map((o) => ({ title: o })) },
  dtxp: options.map((o) => `'${o.replace(/'/g, "''")}'`).join(','),
});

const ROLL_TYPES = ['Лист', 'Круг'];
const METAL_OPS = ['Приход', 'Расход', 'Списание', 'Инвентаризация', 'Резерв', 'Снятие резерва'];
const REMNANT_STATUSES = ['Доступен', 'Зарезервирован', 'Использован'];

// канон.kind → Тип проката (Лист/Круг)
function rollTypeFromKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (/круг|пруток|прут/.test(k)) return 'Круг';
  if (/лист/.test(k)) return 'Лист';
  return ''; // неизвестно — оставляем пустым (заполнит кладовщик)
}

async function main() {
  await nc.signin();
  const base = await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База «${BASE_TITLE}» не найдена`);
  let tables = await nc.listTables(base.id);
  const find = (t) => tables.find((x) => x.title === t);

  console.log(`\n=== Миграция 035 «Учёт остатков металла» — режим: ${DRY_RUN ? 'DRY_RUN (ничего не пишется)' : 'APPLY (запись в прод)'} ===\n`);

  async function ensureTable(title, table_name, columns) {
    const existing = find(title);
    if (existing) { log(`таблица «${title}» уже есть — пропуск`); existing.__existed = true; return existing; }
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

  // --- существующие таблицы, на которые ссылаемся (могут отсутствовать) -------
  const canon = find('Номенклатура-канон');
  const znz = find('Заявки ЗнЗ');
  const orders = find('Заказы');
  if (!canon) log('⚠ «Номенклатура-канон» (catalog_canon) не найдена — засев из канон-Металла пропустится (нужна migrate-032 APPLY).');

  // --- 1) «Остаток металла» (metal_stock) — реестр 1:1 к канон-Металлу --------
  const stock = await ensureTable('Остаток металла', 'metal_stock', [
    txt('Код', 'metal_code', true),                 // МС-NNNN — внутренний ключ (pv, автонумер бэкендом)
    txt('Марка', 'grade'),                          // Ст3сп / 30ХГСА / 40ХН2МА …
    sel('Тип проката', 'roll_type', ROLL_TYPES),    // Лист / Круг
    txt('Типоразмер', 'size'),                      // 10 мм / ⌀20 …
    txt('ГОСТ', 'gost'),
    txt('Ед. изм.', 'unit'),                        // «кг» — авторитетная единица учёта
    dec('Остаток', 'balance'),                      // кг — running-баланс по журналу
    dec('Резерв', 'reserved'),                      // кг — зарезервировано (доступно = Остаток − Резерв)
    dec('Мин. остаток', 'min_stock'),              // кг — порог дефицита (сигнал на ЗнЗ)
    dec('Норма пересчёта', 'conv_norm'),           // кг на 1 мерную ед. (лист/пруток) — для «≈ N ед.»
    txt('Склад по умолчанию', 'warehouse'),
    txt('Ячейка', 'cell'),
    long('Примечание', 'note'),
  ]);

  // --- 2) «Движения металла» (metal_movements) — журнал -----------------------
  const movements = await ensureTable('Движения металла', 'metal_movements', [
    txt('Проводка', 'title', true),                 // «МС-0001 · приход · 09.07.2026» (pv)
    txt('Код', 'metal_code'),                        // МС-NNNN — ключ журнала позиции
    date('Дата', 'moved_at'),
    sel('Операция', 'operation', METAL_OPS),        // Приход/Расход/Списание/Инвентаризация/Резерв/Снятие резерва
    dec('Кол-во', 'qty'),                            // кг
    dec('Остаток после', 'balance_after'),          // кг — running-баланс (физический остаток)
    txt('Раскрой / формат', 'cut_format'),          // «лист 10×1500×6000» / «пруток L=3000»
    dec('Кол-во ед.', 'qty_units'),                 // мерных единиц (листов/прутков) — справочно
    txt('Поставщик', 'supplier'),
    txt('№ счёта', 'invoice_no'),
    txt('№ сертификата / плавки', 'heat_no'),        // прослеживаемость плавки (надстройка 5)
    txt('Позиция ПЗ', 'pz_line'),                    // № ПЗ · поз. (свободный текст для журнала)
    txt('Деталь', 'part'),
    long('Основание / комментарий', 'basis'),
    txt('Автор', 'author'),
  ]);

  // --- 3) «Деловые остатки» (metal_remnants) — надстройка ---------------------
  const remnants = await ensureTable('Деловые остатки', 'metal_remnants', [
    txt('Код', 'remnant_code', true),               // ДО-NNNN (pv)
    txt('Марка', 'grade'),
    sel('Тип проката', 'roll_type', ROLL_TYPES),
    txt('Размеры', 'sizes'),                         // Д×Ш (лист) / Ø×L (круг)
    txt('Толщина', 'thickness'),
    dec('Вес', 'weight'),                            // кг
    sel('Статус', 'status', REMNANT_STATUSES),
    txt('Склад / ячейка', 'location'),
    txt('№ сертификата / плавки', 'heat_no'),        // наследуется из расхода-источника
    date('Дата', 'created_on'),
  ]);

  // --- 4) Связи (hm со стороны «один»; реципрок bt авто на «многих») ----------
  //   Реципрок NocoDB именует по ТАЙТЛУ таблицы-родителя (см. migrate-032):
  //   • «Остаток металла» → «Движения металла» : bt на движении = «Остаток металла» (это «Позиция»).
  //   • «Заявки ЗнЗ»       → «Движения металла» : bt = «Заявки ЗнЗ» (это «№ ЗнЗ»).
  //   • «Заказы»           → «Движения металла» : bt = «Заказы» (это «ПЗ»).
  await ensureLink(stock, movements, 'Движения металла', 'hm');
  await ensureLink(znz, movements, 'Движения металла (ЗнЗ)', 'hm');
  await ensureLink(orders, movements, 'Движения металла (расход)', 'hm');
  // канон → остаток (bt на остатке = «Номенклатура-канон»)
  await ensureLink(canon, stock, 'Остаток металла (позиция)', 'hm');
  // деловые остатки: позиция + источник-ПЗ
  await ensureLink(stock, remnants, 'Деловые остатки', 'hm');
  await ensureLink(orders, remnants, 'Деловые остатки (источник)', 'hm');

  // --- 5) Засев реестра остатков из канон-Металла (только APPLY) --------------
  if (!DRY_RUN) {
    if (canon && stock && stock.id) {
      const canonRows = await nc.listRows(canon.id).catch(() => []);
      const metalCanon = canonRows.filter((r) => String(r['Категория'] || '').trim() === 'Металл');
      const cur = await nc.listRows(stock.id).catch(() => []);
      // индекс уже привязанных канон-Id (по bt-полю «Номенклатура-канон»), чтобы не дублировать
      const linkedCanonIds = new Set();
      for (const s of cur) { const v = s['Номенклатура-канон']; const id = v && (Array.isArray(v) ? (v[0] && (v[0].Id ?? v[0].id)) : (v.Id ?? v.id)); if (id != null) linkedCanonIds.add(String(id)); }
      // id link-колонки «Номенклатура-канон» на metal_stock — для привязки создаваемых строк
      let canonColId = null;
      try { const full = await nc.getTable(stock.id); const col = full.columns.find((c) => c.title === 'Номенклатура-канон'); canonColId = col && col.id; } catch { /* нет колонки — привяжем позже вручную */ }
      let n = cur.length, seeded = 0;
      for (const c of metalCanon) {
        const canonId = c.Id ?? c.id;
        if (linkedCanonIds.has(String(canonId))) continue; // уже есть карточка на этот канон
        n += 1;
        const code = `МС-${String(n).padStart(4, '0')}`;
        const row = {
          'Код': code,
          'Марка': String(c['Марка / материал'] || '').trim(),
          'Тип проката': rollTypeFromKind(c['Тип']),
          'Типоразмер': String(c['Типоразмер'] || '').trim(),
          'Ед. изм.': 'кг',
          'Остаток': 0, 'Резерв': 0, 'Мин. остаток': 0,
          'Примечание': String(c['Каноническое наименование'] || '').trim(),
        };
        // rollTypeFromKind может вернуть '' — SingleSelect не примет пустое, убираем
        if (!row['Тип проката']) delete row['Тип проката'];
        const created = await nc.createRow(stock.id, row);
        const newId = created && (created.Id ?? created.id);
        if (newId != null && canonColId) { try { await nc.linkRecords(stock.id, canonColId, newId, [canonId]); } catch (e) { log(`⚠ привязка ${code}→канон #${canonId} не удалась: ${e.message}`); } }
        seeded += 1;
      }
      log(`засеяно карточек остатка металла: ${seeded} (из ${metalCanon.length} канон-Металл; пропущено уже привязанных)`);
    } else {
      log('засев пропущен: нет канон-таблицы или таблицы остатка.');
    }
  } else {
    if (canon) {
      const canonRows = await nc.listRows(canon.id).catch(() => []);
      const metalCanon = canonRows.filter((r) => String(r['Категория'] || '').trim() === 'Металл');
      plan(`засеять реестр остатков: по 1 карточке МС-NNNN на канон-Металл (найдено сейчас: ${metalCanon.length} канон-карточек «Металл»), Остаток=0/Резерв=0, bt→канон.`);
    } else {
      plan('засеять реестр остатков из канон-Металла (канон-таблица недоступна в DRY_RUN без токена — количество будет известно на APPLY).');
    }
  }

  console.log(`\n✓ Миграция 035 («Учёт остатков металла»)${DRY_RUN ? ' — DRY_RUN: ничего не записано' : ' — APPLY: применена'}.`);
  if (DRY_RUN) console.log('   Для записи (по гринлайту Александра): DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-035-metal.mjs');
}

main().catch((e) => { console.error('✗ Ошибка миграции 035:', e.message); process.exit(1); });
