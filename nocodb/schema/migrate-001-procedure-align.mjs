// ============================================================================
//  Миграция 001 — выравнивание схемы под утверждённую ДП–Д.1–1.1.
//
//  1) «Заказы»: добавить select «Тип задачи» (§5.4):
//       Производство / Обслуживание / Ремонт / Подготовка оснастки / Прочее.
//  2) «Сотрудники»: дополнить select «Роль» по §4 ролями
//       «Начальник ДЛЗ» и «ПРК» (существующие варианты сохраняются).
//
//  Идемпотентно: что уже есть — пропускается. Самодостаточно (схему ищет по API).
//
//  Запуск:  NC_URL=... NC_TOKEN=... node nocodb/schema/migrate-001-procedure-align.mjs
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = 'Производство ПБС';
const log = (...a) => console.log('  ', ...a);

async function main() {
  await nc.signin();
  const base = await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База «${BASE_TITLE}» не найдена`);
  const tables = await nc.listTables(base.id);
  const byTitle = (t) => tables.find((x) => x.title === t);

  // 1) «Заказы» → «Тип задачи» --------------------------------------------
  const orders = byTitle('Заказы');
  const ordFull = await nc.getTable(orders.id);
  if (ordFull.columns.some((c) => c.title === 'Тип задачи')) {
    log('Заказы: «Тип задачи» уже есть — пропуск');
  } else {
    const options = ['Производство', 'Обслуживание', 'Ремонт', 'Подготовка оснастки', 'Прочее'];
    await nc.createColumn(orders.id, {
      title: 'Тип задачи',
      column_name: 'task_kind',
      uidt: 'SingleSelect',
      colOptions: { options: options.map((o) => ({ title: o })) },
      dtxp: options.map((o) => `'${o}'`).join(','),
    });
    log('Заказы: + колонка «Тип задачи»', options.join(' / '));
  }

  // 2) «Сотрудники» → дополнить «Роль» ------------------------------------
  const emp = byTitle('Сотрудники');
  const empFull = await nc.getTable(emp.id);
  const roleCol = empFull.columns.find((c) => c.title === 'Роль');
  if (!roleCol) throw new Error('Колонка «Роль» в «Сотрудники» не найдена');

  const existing = roleCol.colOptions?.options || [];
  const have = new Set(existing.map((o) => o.title));
  const want = ['Технолог', 'ДпП', 'Менеджер', 'Мастер участка', 'Рабочий', 'ОТК', 'Начальник ДЛЗ', 'ПРК'];
  const toAdd = want.filter((t) => !have.has(t));

  if (!toAdd.length) {
    log('Сотрудники: роли уже полные — пропуск');
  } else {
    // сохраняем существующие варианты с их id (чтобы не осиротить записи)
    const options = [
      ...existing.map((o) => ({ id: o.id, title: o.title, color: o.color, order: o.order })),
      ...toAdd.map((t) => ({ title: t })),
    ];
    await nc.updateColumn(roleCol.id, {
      title: 'Роль',
      column_name: roleCol.column_name,
      uidt: 'SingleSelect',
      colOptions: { options },
      dtxp: options.map((o) => `'${o.title}'`).join(','),
    });
    log('Сотрудники: + роли', toAdd.join(' / '));
  }

  console.log('\n✓ Миграция 001 применена.');
}

main().catch((e) => { console.error('✗ Ошибка миграции:', e.message); process.exit(1); });
