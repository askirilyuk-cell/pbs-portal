// ============================================================================
//  Миграция 003 — параметры: норматив (план) vs факт.
//
//  До сих пор у параметра задачи было одно поле «Значение», которое правил
//  рабочий — это смешивало норматив и факт. Разделяем:
//   • НОРМАТИВ — целевое значение, задаётся на этапе заведения МК (технолог);
//     для рабочего read-only. Каталожный дефолт хранится в «Параметры типов».
//   • ФАКТ     — что получилось; забивает рабочий с «Рабочего места».
//  Так копится база «план vs факт» (основа выборочного контроля, ISO 9001 §9.1).
//
//  Что делает миграция (идемпотентно — что есть, пропускается):
//   1) «Параметры типов» (каталог): + «Норматив», + «Допуск» (дефолты).
//   2) «Значения параметров задачи»: + «Норматив», + «Допуск», + «Факт»,
//      + «Вердикт» (SingleSelect: в допуске / вне допуска).
//   3) Разовый перенос данных: где «Факт» пуст, а в старом «Значение» что-то
//      есть → копируем «Значение» → «Факт» (старая колонка остаётся, deprecated).
//
//  Запуск:  NC_URL=... NC_TOKEN=... node nocodb/schema/migrate-003-param-norms.mjs
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = 'Производство ПБС';
const log = (...a) => console.log('  ', ...a);

const sel = (title, column_name, options) => ({
  title, column_name, uidt: 'SingleSelect',
  colOptions: { options: options.map((o) => ({ title: o })) },
  dtxp: options.map((o) => `'${o}'`).join(','),
});

// добавить колонку, если её ещё нет (по title)
async function ensureColumn(table, column) {
  const full = await nc.getTable(table.id);
  if (full.columns.some((c) => c.title === column.title)) {
    log(`«${table.title}»: «${column.title}» уже есть — пропуск`);
    return false;
  }
  await nc.createColumn(table.id, column);
  log(`«${table.title}»: + поле «${column.title}»`);
  return true;
}

async function main() {
  await nc.signin();
  const base = await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База «${BASE_TITLE}» не найдена`);
  const tables = await nc.listTables(base.id);
  const byTitle = (t) => {
    const x = tables.find((y) => y.title === t);
    if (!x) throw new Error(`Таблица «${t}» не найдена`);
    return x;
  };

  // 1) каталог «Параметры типов» — дефолтные норматив/допуск ------------------
  const opParams = byTitle('Параметры типов');
  await ensureColumn(opParams, { title: 'Норматив', column_name: 'norm', uidt: 'SingleLineText' });
  await ensureColumn(opParams, { title: 'Допуск', column_name: 'tol', uidt: 'SingleLineText' });

  // 2) «Значения параметров задачи» — норматив/допуск/факт/вердикт ------------
  const pvals = byTitle('Значения параметров задачи');
  await ensureColumn(pvals, { title: 'Норматив', column_name: 'norm', uidt: 'SingleLineText' });
  await ensureColumn(pvals, { title: 'Допуск', column_name: 'tol', uidt: 'SingleLineText' });
  await ensureColumn(pvals, { title: 'Факт', column_name: 'fact', uidt: 'SingleLineText' });
  await ensureColumn(pvals, sel('Вердикт', 'verdict', ['в допуске', 'вне допуска']));

  // 3) разовый перенос «Значение» → «Факт» -----------------------------------
  const rows = await nc.listRows(pvals.id);
  let moved = 0;
  for (const r of rows) {
    const fact = r['Факт'];
    const old = r['Значение'];
    if ((fact == null || fact === '') && old != null && old !== '') {
      await nc.updateRow(pvals.id, r.Id ?? r.id, { 'Факт': String(old) });
      moved++;
    }
  }
  log(`перенос «Значение» → «Факт»: обновлено строк ${moved} из ${rows.length}`);

  console.log('\n✓ Миграция 003 применена.');
}

main().catch((e) => { console.error('✗ Ошибка миграции:', e.message); process.exit(1); });
