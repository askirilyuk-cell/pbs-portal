// ============================================================================
//  Автонумерация маршрутных карт (ДП–Д.1 §6, Ф.13): МК-[КОМ|СБР]-ГГГГ-NNN.
//
//  Счётчик NNN — сквозной отдельно по типу (КОМ/СБР) и году. Год берётся из
//  текущей даты (у маршрута нет поля даты; МК заводится «сейчас»).
//
//  Заполняет «№ МК» у маршрутов, где он пуст. Уже занятые номера не трогает и
//  учитывает их в максимуме — идемпотентно и безопасно при повторном запуске.
//
//  Запуск:
//    NC_URL=http://nocodb:8080 NC_TOKEN=... node nocodb/scripts/assign-mk-number.mjs
//    ... assign-mk-number.mjs <routeId>   # только указанный маршрут
//    ... assign-mk-number.mjs 2027         # форсировать год для счётчика
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nc from '../lib/nocodb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.state', 'schema-map.json'), 'utf-8'));
const TID = (key) => map.tables[key].id;
const idOf = (r) => r.Id ?? r.id;
const log = (...a) => console.log('  ', ...a);

// тип МК → буква серии номера
const TYPE_LETTER = { 'КОМ': 'КОМ', 'СБР': 'СБР' };

// аргумент: либо routeId (число), либо год (4 цифры), либо ничего
const arg = process.argv[2];
const onlyRouteId = arg && /^\d{1,3}$/.test(arg) ? Number(arg) : null;       // короткое число → Id маршрута
const forcedYear = arg && /^\d{4}$/.test(arg) ? arg : null;                  // 4 цифры → год
const year = forcedYear || String(new Date().getFullYear());

function nextNumberFactory(routes) {
  // максимум NNN по (тип, год), из уже присвоенных «№ МК»
  const maxByType = new Map();
  for (const r of routes) {
    const num = String(r['№ МК'] || '');
    const m = /^МК-(КОМ|СБР)-(\d{4})-(\d+)$/.exec(num);
    if (!m || m[2] !== year) continue;
    const key = m[1];
    maxByType.set(key, Math.max(maxByType.get(key) || 0, parseInt(m[3], 10)));
  }
  return (type) => {
    const letter = TYPE_LETTER[type];
    if (!letter) return null;
    const next = (maxByType.get(letter) || 0) + 1;
    maxByType.set(letter, next);
    return `МК-${letter}-${year}-${String(next).padStart(3, '0')}`;
  };
}

async function main() {
  await nc.signin();
  const routes = await nc.listRows(TID('routes'));
  const nextNumber = nextNumberFactory(routes);

  let targets = routes.filter((r) => !String(r['№ МК'] || '').trim());
  if (onlyRouteId != null) targets = routes.filter((r) => idOf(r) === onlyRouteId);

  if (!targets.length) {
    console.log(onlyRouteId != null
      ? `Маршрут Id=${onlyRouteId} не найден или уже пронумерован.`
      : 'Маршрутов без номера нет — всё пронумеровано.');
    return;
  }

  console.log(`Автонумерация МК (год ${year}), кандидатов: ${targets.length}`);
  let assigned = 0;
  for (const r of targets) {
    const id = idOf(r);
    const type = r['Тип МК'];
    if (String(r['№ МК'] || '').trim()) { log(`Id=${id}: уже «${r['№ МК']}» — пропуск`); continue; }
    const num = nextNumber(type);
    if (!num) { log(`Id=${id}: «Тип МК» не задан (КОМ/СБР) — пропуск`); continue; }
    await nc.updateRow(TID('routes'), id, { '№ МК': num });
    log(`+ Id=${id} (${type}) → ${num}`);
    assigned++;
  }

  console.log(`\n✓ Готово. Присвоено номеров: ${assigned}`);
}

main().catch((e) => { console.error('✗ Ошибка автонумерации:', e.message); process.exit(1); });
