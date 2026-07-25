// ============================================================================
//  Демо-маршрут для проверки Итерации 2 end-to-end.
//
//  Создаёт МК-КОМ-2026-001 «Втулка биметаллическая» (3 операции: заготовка →
//  токарная → наплавка), привязывает операции к типам операций и маршрут — к
//  позиции 1.0 заказа ПЗ-2026-001. После этого:
//    node scripts/generate-tasks.mjs ПЗ-2026-001
//  сгенерирует 3 карты задач на участки.
//
//  Идемпотентно: если МК уже есть — выходит.
//  Запуск:  NC_URL=... NC_TOKEN=... node nocodb/seed/seed-demo-route.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nc from '../lib/nocodb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.state', 'schema-map.json'), 'utf-8'));
const TID = (key) => map.tables[key].id;
const COL = (key, title) => map.tables[key].columns[title];
const idOf = (r) => r.Id ?? r.id;
const log = (...a) => console.log('  ', ...a);

const MK = 'МК-КОМ-2026-001';

async function main() {
  await nc.signin();
  if ((await nc.listRows(TID('routes'))).some((r) => r['№ МК'] === MK)) {
    console.log(`Демо-маршрут ${MK} уже есть — пропуск.`); return;
  }

  const route = await nc.createRow(TID('routes'), {
    '№ МК': MK, 'Тип МК': 'КОМ', 'Наименование': 'Втулка биметаллическая',
    'Изделие / обозначение': '23.12.08.021', 'Тип продукции': 'Биметалл',
    'Ревизия': 'v1.0', 'Статус': 'Действует',
  });
  const routeId = idOf(route);
  log(`+ маршрут ${MK}`);

  const byCode = new Map((await nc.listRows(TID('op_types'))).map((o) => [o['Код типа'], idOf(o)]));
  const ops = [
    { n: 1, code: 'ОП-ЗАГ', mat: 'Труба бронзовая БрАЖ; отрезать L=120 мм', ctl: 'нет' },
    { n: 2, code: 'ОП-ТОК', mat: 'Заготовка с УЧ-16', ctl: 'С', what: 'Ø наружный', si: 'штангенциркуль' },
    { n: 3, code: 'ОП-НАП', mat: 'Проволока наплавочная', ctl: 'ОТК', what: 'твёрдость HV', si: 'твердомер' },
  ];
  for (const o of ops) {
    const op = await nc.createRow(TID('operations'), {
      'Операция': `${MK} оп.${o.n}`, '№ операции': o.n, 'Входящие материалы': o.mat,
      'Точка контроля': o.ctl, 'Что контролировать': o.what || '', 'СИ': o.si || '', 'Норма времени (ч)': 1,
    });
    const opId = idOf(op);
    await nc.linkRecords(TID('routes'), COL('routes', 'Операции маршрута'), routeId, [opId]).catch(() => {});
    const otId = byCode.get(o.code);
    if (otId) await nc.linkRecords(TID('op_types'), COL('op_types', 'Операции (по типу)'), otId, [opId]).catch(() => {});
    log(`+ операция ${o.n} (${o.code})`);
  }

  const pos = (await nc.listRows(TID('positions'))).find(
    (p) => String(p['Позиция']).startsWith('ПЗ-2026-001') && String(p['№ позиции']) === '1.0');
  if (pos) {
    await nc.linkRecords(TID('routes'), COL('routes', 'Позиции (по маршруту)'), routeId, [idOf(pos)]).catch(() => {});
    log('+ маршрут привязан к позиции 1.0 ПЗ-2026-001');
  } else {
    log('позиция 1.0 ПЗ-2026-001 не найдена — привяжите маршрут вручную');
  }

  console.log(`\n✓ Демо-маршрут готов. Далее: node scripts/generate-tasks.mjs ПЗ-2026-001`);
}

main().catch((e) => { console.error('✗ Ошибка:', e.message); process.exit(1); });
