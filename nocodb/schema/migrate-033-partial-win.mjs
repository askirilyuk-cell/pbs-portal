// ============================================================================
//  Миграция 033 — «Выиграли частично» (K-66): промежуточный исход КП.
//
//  Заказчик берёт не весь объём КП, а часть (на сниженную сумму/объём). Нужно
//  зафиксировать сам факт частичного выигрыша и сумму выигранной части, чтобы
//  дальнейший ЗКЗ формировался на эту часть (а не на весь КП).
//
//  ЧТО ДЕЛАЕТ (СТРОГО АДДИТИВНО, стиль migrate-031/032; ноль rename/смен типов/удалений):
//   (a) добавляет опцию «Выиграли частично» в SingleSelect «Результат КП»
//       ИДЕМПОТЕНТНО (skip-if-exists; не пересоздаёт колонку — только дополняет
//       список опций через PATCH colOptions/dtxp). Существующие опции и их id/цвета
//       сохраняются как есть.
//   (b) добавляет колонку «Сумма выигранной части» (Decimal) и
//       «Объём/примечание выигранной части» (LongText) в таблицу «Запросы продаж».
//
//  Таблица «Запросы продаж» (sales_requests) — здесь же живут «Результат КП»,
//  «Сумма КП, руб.» и пр. (см. migrate-006/021/031). База — по имени «Производство
//  ПБС» (как во всех рабочих миграциях). ⚠ Задание называет sales-базу id
//  p0ic4ghwyat7q39 — если продажи вынесены в отдельную базу, задайте NC_BASE_ID=…
//  (или NC_BASE_TITLE=…); по умолчанию берём проверенную «Производство ПБС».
//
//  БЕЗОПАСНОСТЬ ЗАПИСИ: DRY_RUN — ПО УМОЛЧАНИЮ. Запись ТОЛЬКО при ОБОИХ флагах:
//      DRY_RUN=0 APPLY_CONFIRM=YES
//
//  Запуск (DRY-RUN, по умолчанию — НИЧЕГО не пишется):
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=... node nocodb/schema/migrate-033-partial-win.mjs
//  Запуск (APPLY, только по гринлайту Александра):
//    NC_URL=... NC_TOKEN=... DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-033-partial-win.mjs
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = process.env.NC_BASE_TITLE || 'Производство ПБС';
const BASE_ID = process.env.NC_BASE_ID || '';          // приоритетнее имени (sales-база p0ic4ghwyat7q39 при необходимости)
const TABLE_TITLE = 'Запросы продаж';
const RESULT_COL = 'Результат КП';
const NEW_OPTION = 'Выиграли частично';
const NEW_OPTION_COLOR = '#f9a03f';                    // янтарный «частичный» (нейтрально, не путать с зелёным «Выиграли»)

const APPLY = process.env.DRY_RUN === '0' && process.env.APPLY_CONFIRM === 'YES';
const DRY_RUN = !APPLY;
const log = (...a) => console.log('  ', ...a);
const plan = (...a) => console.log('   [dry]', ...a);

// хелперы описания колонок (стиль migrate-032)
const dec = (title, column_name) => ({ title, column_name, uidt: 'Decimal' });
const long = (title, column_name) => ({ title, column_name, uidt: 'LongText' });

// новые колонки реестра «Запросы продаж»
const NEW_COLS = [
  dec('Сумма выигранной части', 'won_part_sum'),          // ₽, сумма реально выигранной части (для ЗКЗ)
  long('Объём/примечание выигранной части', 'won_part_note'), // что именно выиграли: объём/позиции/комментарий
];

async function main() {
  await nc.signin();
  const base = BASE_ID
    ? (await nc.listBases()).find((b) => b.id === BASE_ID)
    : await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База ${BASE_ID ? `id «${BASE_ID}»` : `«${BASE_TITLE}»`} не найдена`);
  const tables = await nc.listTables(base.id);
  const sales = tables.find((x) => x.title === TABLE_TITLE);
  if (!sales) throw new Error(`Таблица «${TABLE_TITLE}» не найдена в базе «${base.title}».`);

  console.log(`\n=== Миграция 033 «Выиграли частично» (K-66) — режим: ${DRY_RUN ? 'DRY_RUN (ничего не пишется)' : 'APPLY (запись в прод)'} ===\n`);
  log(`база «${base.title}» (id ${base.id}) · таблица «${sales.title}» (id ${sales.id})`);

  const full = await nc.getTable(sales.id);
  // снимок «до» — контроль before == after в dry-run
  const before = {
    cols: full.columns.map((c) => c.title).sort(),
    resOpts: optTitles(full.columns.find((c) => c.title === RESULT_COL)),
  };

  // --- (a) опция «Выиграли частично» в SingleSelect «Результат КП» -------------
  const resCol = full.columns.find((c) => c.title === RESULT_COL);
  if (!resCol) {
    log(`⚠ колонка «${RESULT_COL}» не найдена — опцию не добавить. РУЧНОЙ ШАГ: проверьте, что migrate-021 (select-часть) применена.`);
  } else if (resCol.uidt !== 'SingleSelect') {
    log(`⚠ «${RESULT_COL}» имеет тип ${resCol.uidt}, не SingleSelect — авто-добавление опции небезопасно. РУЧНОЙ ШАГ: добавить опцию в NocoDB.`);
  } else {
    const existing = (resCol.colOptions && resCol.colOptions.options) || [];
    const titles = existing.map((o) => o.title);
    if (titles.includes(NEW_OPTION)) {
      log(`опция «${NEW_OPTION}» в «${RESULT_COL}» уже есть — пропуск`);
    } else {
      // сохраняем существующие опции как есть (id/цвет/порядок), добавляем новую в конец
      const options = [...existing, { title: NEW_OPTION, color: NEW_OPTION_COLOR }];
      const dtxp = options.map((o) => `'${o.title.replace(/'/g, "''")}'`).join(',');
      if (DRY_RUN) {
        plan(`+ опция «${NEW_OPTION}» → «${RESULT_COL}» (было: ${titles.join(' · ')} → станет: ${options.map((o) => o.title).join(' · ')})`);
      } else {
        // PATCH дополняет список опций, не пересоздавая колонку. Существующие значения
        // записей не трогаются (опции добавляются, не переименовываются/удаляются).
        await nc.updateColumn(resCol.id, {
          title: resCol.title, column_name: resCol.column_name, uidt: 'SingleSelect',
          colOptions: { options }, dtxp,
        });
        log(`+ опция «${NEW_OPTION}» добавлена в «${RESULT_COL}»`);
      }
    }
  }

  // --- (b) новые колонки «Сумма/Объём выигранной части» ------------------------
  const has = (t) => full.columns.some((c) => c.title === t);
  for (const col of NEW_COLS) {
    if (has(col.title)) { log(`колонка «${col.title}» уже есть — пропуск`); continue; }
    if (DRY_RUN) { plan(`+ колонка «${col.title}» [${col.uidt}] на «${sales.title}»`); continue; }
    await nc.createColumn(sales.id, col);
    log(`+ колонка «${col.title}» [${col.uidt}] на «${sales.title}»`);
  }

  // --- контроль before == after (в DRY_RUN схема не должна измениться) ----------
  const after0 = await nc.getTable(sales.id);
  const after = {
    cols: after0.columns.map((c) => c.title).sort(),
    resOpts: optTitles(after0.columns.find((c) => c.title === RESULT_COL)),
  };
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\n   [verify] схема ${DRY_RUN ? 'DRY_RUN' : 'APPLY'}: before ${unchanged ? '==' : '!='} after`);
  if (DRY_RUN && !unchanged) console.log('   ⚠ ВНИМАНИЕ: в DRY_RUN схема изменилась — этого быть не должно!');
  console.log(`   [verify] колонок «${sales.title}»: было ${before.cols.length}, стало ${after.cols.length}`);
  console.log(`   [verify] опции «${RESULT_COL}»: было [${before.resOpts.join(', ')}] → стало [${after.resOpts.join(', ')}]`);

  console.log(`\n✓ Миграция 033${DRY_RUN ? ' — DRY_RUN: ничего не записано' : ' — APPLY: применена'}.`);
  if (DRY_RUN) console.log('   Для записи (по гринлайту Александра): DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-033-partial-win.mjs');
}

const optTitles = (col) => (col && col.colOptions && col.colOptions.options ? col.colOptions.options.map((o) => o.title) : []);

main().catch((e) => { console.error('✗ Ошибка миграции 033:', e.message); process.exit(1); });
