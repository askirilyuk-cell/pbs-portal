// ============================================================================
//  Представления (views) производственного модуля — раздел 5 ТЗ.
//
//    • Заказы → Grid «Реестр ПЗ (ДпП)»            — реестр заказов
//    • Задачи → Grid «Очередь участка (мастер)»    — невыполненные задачи по сроку
//    • Задачи → Gallery «Карта задачи (планшет)»   — карточки для рабочего
//    • Задачи → Form «Новая задача»                — ввод с планшета
//
//  Мастер фильтрует свой участок в UI (фильтр по связи «Участки»).
//  Идемпотентно: вид с таким заголовком пропускается.
//
//  Запуск:  NC_URL=... NC_TOKEN=... node nocodb/views/build-views.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nc from '../lib/nocodb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.state', 'schema-map.json'), 'utf-8'));
const COL = (key, title) => map.tables[key].columns[title];
const log = (...a) => console.log('  ', ...a);

async function ensureView(tableKey, kind, title, build, opts = {}) {
  const tableId = map.tables[tableKey].id;
  const views = await nc.listViews(tableId);
  if (views.some((v) => v.title === title)) { log(`вид «${title}»: уже есть`); return; }
  let view;
  if (kind === 'grid') view = await nc.createGridView(tableId, title);
  if (kind === 'gallery') view = await nc.createGalleryView(tableId, title);
  if (kind === 'form') view = await nc.createFormView(tableId, title);
  if (kind === 'kanban') view = await nc.createKanbanView(tableId, title, opts.groupColumnId);
  log(`+ ${kind} «${title}»`);
  if (build) await build(view);
}

async function main() {
  await nc.signin();
  console.log('Представления → база', map.base);

  // 1) Реестр ПЗ (ДпП) ------------------------------------------------------
  await ensureView('orders', 'grid', 'Реестр ПЗ (ДпП)', async (v) => {
    await nc.createSort(v.id, { fk_column_id: COL('orders', 'Дата размещения'), direction: 'desc' })
      .catch((e) => log('  sort?', e.message));
  });

  // 2) Очередь участка (мастер) — невыполненные, по плановой дате -----------
  await ensureView('tasks', 'grid', 'Очередь участка (мастер)', async (v) => {
    await nc.createFilter(v.id, {
      fk_column_id: COL('tasks', 'Статус'),
      comparison_op: 'neq',
      value: 'Выполнено',
      logical_op: 'and',
    }).catch((e) => log('  filter?', e.message));
    await nc.createSort(v.id, { fk_column_id: COL('tasks', 'Дата плановая'), direction: 'asc' })
      .catch((e) => log('  sort?', e.message));
  });

  // 3) Карта задачи (планшет) — карточки активных задач ---------------------
  await ensureView('tasks', 'gallery', 'Карта задачи (планшет)', async (v) => {
    await nc.createFilter(v.id, {
      fk_column_id: COL('tasks', 'Статус'),
      comparison_op: 'neq',
      value: 'Выполнено',
      logical_op: 'and',
    }).catch((e) => log('  filter?', e.message));
  });

  // 4) Форма ввода задачи с планшета ----------------------------------------
  await ensureView('tasks', 'form', 'Новая задача (планшет)');

  // 5) Доски Kanban — движение по статусу (наглядно «всё вместе») ------------
  //    Создание устойчиво к ошибке: если контракт kanban API отличается в этой
  //    версии NocoDB, виды grid/gallery/form всё равно остаются готовыми.
  await ensureView('tasks', 'kanban', 'Доска задач по статусу', null,
    { groupColumnId: COL('tasks', 'Статус') }).catch((e) => log('  kanban задач?', e.message));
  await ensureView('orders', 'kanban', 'Заказы по статусу', null,
    { groupColumnId: COL('orders', 'Статус') }).catch((e) => log('  kanban заказов?', e.message));
  await ensureView('positions', 'kanban', 'Позиции по статусу', null,
    { groupColumnId: COL('positions', 'Статус') }).catch((e) => log('  kanban позиций?', e.message));

  console.log('\n✓ Представления готовы. Тонкую настройку колонок/полей делайте в UI.');
  console.log('  Очереди по участкам: в виде «Очередь участка» добавьте фильтр по связи «Участки» = ваш УЧ (2 клика в UI).');
}

main().catch((e) => { console.error('✗ Ошибка:', e.message); process.exit(1); });
