// ============================================================================
//  Генерация карт задач из маршрута (ДП–Д.1 §6.7).
//
//  Для указанного ПЗ: по каждой позиции, у которой задан Маршрут, по каждой
//  операции маршрута создаётся Задача на участок (участок — из типа операции),
//  и копируется набор «Значения параметров задачи» из Типа операции.
//
//  Позиции без маршрута пропускаются («лёгкий путь» §6.7 — задачи вручную).
//  Идемпотентно: задача с тем же «№ задачи» (ПЗ/позиция-опN) не дублируется.
//
//  ВАЖНО: link-эндпоинт v2 (listLinkedRecords) отдаёт у связанных записей
//  только первичное поле + Id. Поэтому связи используем лишь для получения Id,
//  а полные поля берём из полных списков таблиц (индексы по Id ниже).
//
//  Запуск:
//    NC_URL=http://nocodb:8080 NC_TOKEN=... node nocodb/scripts/generate-tasks.mjs ПЗ-2026-001
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nc from '../lib/nocodb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.state', 'schema-map.json'), 'utf-8'));
const TID = (key) => map.tables[key].id;
const COL = (key, title) => {
  const id = map.tables[key].columns[title];
  if (!id) throw new Error(`Нет колонки «${title}» в «${map.tables[key].title}» — пересоберите схему (npm run schema)`);
  return id;
};
const idOf = (r) => r.Id ?? r.id;
const log = (...a) => console.log('  ', ...a);

const numPz = process.argv[2];
if (!numPz) { console.error('Укажите № ПЗ: node scripts/generate-tasks.mjs ПЗ-2026-001'); process.exit(1); }

// индекс полных записей таблицы по Id
async function indexById(key) {
  const m = new Map();
  for (const r of await nc.listRows(TID(key))) m.set(idOf(r), r);
  return m;
}
// связанные Id (link-эндпоинт отдаёт Id + display)
async function linkedIds(key, linkTitle, rowId) {
  return (await nc.listLinkedRecords(TID(key), COL(key, linkTitle), rowId)).map(idOf);
}

async function main() {
  await nc.signin();
  console.log(`Генерация задач из маршрутов для ${numPz}`);

  // полные записи (для чтения не-первичных полей)
  const posById = await indexById('positions');
  const routeById = await indexById('routes');
  const opById = await indexById('operations');
  const paramById = await indexById('op_params');

  const order = (await nc.listRows(TID('orders'))).find((o) => String(o['№ ПЗ']) === numPz);
  if (!order) throw new Error(`ПЗ «${numPz}» не найден`);
  const orderId = idOf(order);

  const posIds = await linkedIds('orders', 'Позиции', orderId);
  const existingNums = new Set((await nc.listRows(TID('tasks'))).map((t) => String(t['№ задачи'])));

  let created = 0, skipped = 0, noRoute = 0;

  for (const posId of posIds) {
    const pos = posById.get(posId) || {};
    const posNum = pos['№ позиции'] || String(posId);

    const routeId = (await linkedIds('positions', 'Маршруты', posId))[0];
    if (!routeId) { log(`позиция ${posNum}: маршрут не задан — пропуск (лёгкий путь)`); noRoute++; continue; }
    const route = routeById.get(routeId) || {};
    const mk = route['№ МК'] || 'МК';

    const opIds = await linkedIds('routes', 'Операции маршрута', routeId);
    const ops = opIds.map((id) => opById.get(id)).filter(Boolean)
      .sort((a, b) => (Number(a['№ операции']) || 0) - (Number(b['№ операции']) || 0));
    log(`позиция ${posNum} → ${mk}: операций ${ops.length}`);

    for (const op of ops) {
      const opId = idOf(op);
      const opNum = op['№ операции'] ?? '?';
      const taskNum = `${numPz}/${posNum}-оп${opNum}`;
      if (existingNums.has(taskNum)) { skipped++; continue; }

      const opTypeId = (await linkedIds('operations', 'Типы операций', opId))[0] || null;
      const sectionId = opTypeId ? ((await linkedIds('op_types', 'Участки', opTypeId))[0] || null) : null;

      const task = await nc.createRow(TID('tasks'), {
        '№ задачи': taskNum,
        'Операция (№ МК / № оп.)': `${mk} оп.${opNum}`,
        'Статус': 'В очереди',
        'Приоритет': order['Приоритет'] || 'Нормальный',
        'Дата плановая': pos['Срок готовности'] || order['Плановый срок'] || null,
        'Входящие материалы': op['Входящие материалы'] || '',
      });
      const taskId = idOf(task);
      existingNums.add(taskNum);

      await nc.linkRecords(TID('orders'), COL('orders', 'Задачи'), orderId, [taskId]).catch((e) => log('  ↳ заказ?', e.message));
      await nc.linkRecords(TID('positions'), COL('positions', 'Задачи'), posId, [taskId]).catch(() => {});
      await nc.linkRecords(TID('operations'), COL('operations', 'Задачи (по операции)'), opId, [taskId]).catch(() => {});
      if (opTypeId) await nc.linkRecords(TID('op_types'), COL('op_types', 'Задачи (по типу)'), opTypeId, [taskId]).catch(() => {});
      if (sectionId) await nc.linkRecords(TID('sections'), COL('sections', 'Задачи на участки'), sectionId, [taskId]).catch(() => {});

      let pcount = 0;
      if (opTypeId) {
        const pIds = await linkedIds('op_types', 'Параметры', opTypeId);
        for (const pid of pIds) {
          const p = paramById.get(pid) || {};
          const pv = await nc.createRow(TID('task_param_values'), {
            'Параметр': p['Параметр'] || '', 'Единица': p['Единица'] || '',
            'Обязательный': !!p['Обязательный'],
            // норматив/допуск переносим из каталога типа операции (migrate-003);
            // технолог при заведении МК может переопределить per-деталь. Факт — пуст.
            'Норматив': p['Норматив'] || '', 'Допуск': p['Допуск'] || '', 'Факт': '',
          });
          await nc.linkRecords(TID('tasks'), COL('tasks', 'Значения параметров'), taskId, [idOf(pv)]).catch(() => {});
          pcount++;
        }
      }
      created++;
      log(`+ ${taskNum} → участок ${sectionId ? 'ok' : '—'}, параметров: ${pcount}`);
    }
  }

  console.log(`\n✓ Готово. Создано: ${created}, пропущено (уже есть): ${skipped}, позиций без маршрута: ${noRoute}`);
}

main().catch((e) => { console.error('✗ Ошибка генерации:', e.message); process.exit(1); });
