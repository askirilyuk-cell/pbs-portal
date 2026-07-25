// ============================================================================
//  Миграция 002 — журнал исполнения по единицам (Ф.14 §7) + прослеживаемость.
//
//  1) Новая дочерняя таблица «Журнал исполнения»: одна строка на изготовленную
//     единицу (Ф.14 §7) — исполнитель, № заготовки/приёмки, самоконтроль и
//     контроль ОТК (годен/брак), дата. Привязка к «Задачи на участки» (hasMany).
//  2) «Входящие компоненты»: + поле «№ приёмки / сертификата» (Ф.14 §4, Ф.3).
//
//  Идемпотентно: что уже есть — пропускается. Схему ищет по API.
//
//  Запуск:  NC_URL=... NC_TOKEN=... node nocodb/schema/migrate-002-journal.mjs
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = 'Производство ПБС';
const log = (...a) => console.log('  ', ...a);

const sel = (title, column_name, options) => ({
  title, column_name, uidt: 'SingleSelect',
  colOptions: { options: options.map((o) => ({ title: o })) },
  dtxp: options.map((o) => `'${o}'`).join(','),
});

async function main() {
  await nc.signin();
  const base = await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База «${BASE_TITLE}» не найдена`);
  let tables = await nc.listTables(base.id);
  const byTitle = (t) => tables.find((x) => x.title === t);

  // 1) таблица «Журнал исполнения» ----------------------------------------
  let journal = byTitle('Журнал исполнения');
  if (journal) {
    log('Таблица «Журнал исполнения» уже есть — пропуск');
  } else {
    log('Создаю таблицу «Журнал исполнения»');
    journal = await nc.createTable(base.id, {
      table_name: 'journal_exec',
      title: 'Журнал исполнения',
      columns: [
        { title: '№ задачи', column_name: 'num_task', uidt: 'SingleLineText', pv: true },
        { title: '№ единицы', column_name: 'unit_no', uidt: 'Number' },
        { title: 'Исполнитель', column_name: 'executor', uidt: 'SingleLineText' },
        { title: '№ заготовки / приёмки', column_name: 'blank_no', uidt: 'SingleLineText' },
        sel('Самоконтроль', 'self_control', ['годен', 'брак']),
        sel('Контроль ОТК', 'otk_control', ['годен', 'брак']),
        { title: 'Дата', column_name: 'jdate', uidt: 'Date' },
        { title: 'Примечание', column_name: 'note', uidt: 'LongText' },
      ],
    });
    tables = await nc.listTables(base.id);
  }

  // связь «Задачи на участки» → «Журнал исполнения» (hasMany) --------------
  const tasks = byTitle('Задачи на участки');
  if (!tasks) throw new Error('Таблица «Задачи на участки» не найдена');
  const tasksFull = await nc.getTable(tasks.id);
  if (tasksFull.columns.some((c) => c.title === 'Журнал исполнения')) {
    log('Связь Задачи→Журнал уже есть — пропуск');
  } else {
    await nc.createLink(tasks.id, { title: 'Журнал исполнения', childTableId: journal.id, type: 'hm' });
    log('+ связь «Задачи на участки» → «Журнал исполнения» (hasMany)');
  }

  // 2) «Входящие компоненты» → «№ приёмки / сертификата» -------------------
  const comp = byTitle('Входящие компоненты');
  if (!comp) {
    log('Таблица «Входящие компоненты» не найдена — пропуск поля сертификата');
  } else {
    const compFull = await nc.getTable(comp.id);
    if (compFull.columns.some((c) => c.title === '№ приёмки / сертификата')) {
      log('Входящие компоненты: «№ приёмки / сертификата» уже есть — пропуск');
    } else {
      await nc.createColumn(comp.id, { title: '№ приёмки / сертификата', column_name: 'cert_no', uidt: 'SingleLineText' });
      log('Входящие компоненты: + поле «№ приёмки / сертификата»');
    }
  }

  console.log('\n✓ Миграция 002 применена.');
}

main().catch((e) => { console.error('✗ Ошибка миграции:', e.message); process.exit(1); });
