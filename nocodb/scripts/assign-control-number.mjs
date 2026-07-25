// ============================================================================
//  Автонумерация документов контроля качества (Ф.3/Ф.4/Ф.5):
//    Входной контроль   → ВК-ГГГГ-NNN  (поле «№ акта»)
//    Приёмочный контроль→ ПК-ГГГГ-NNN  (поле «№ протокола»)
//    Несоответствия     → НП-ГГГГ-NNN  (поле «№ акта НП»)
//
//  Счётчик NNN — сквозной отдельно по префиксу и году. Год берётся из поля
//  «Дата» записи (если задано), иначе — текущий. Заполняет только пустые номера,
//  занятые учитывает в максимуме — идемпотентно.
//
//  Запуск:
//    NC_URL=http://nocodb:8080 NC_TOKEN=... node nocodb/scripts/assign-control-number.mjs
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

const DOCS = [
  { key: 'incoming_control',   field: '№ акта',     prefix: 'ВК' },
  { key: 'acceptance_control', field: '№ протокола', prefix: 'ПК' },
  { key: 'nonconformity',      field: '№ акта НП',   prefix: 'НП' },
];

const curYear = String(new Date().getFullYear());
const yearOf = (r) => {
  const d = r['Дата'];
  const m = d && /^(\d{4})/.exec(String(d));
  return m ? m[1] : curYear;
};

async function processDoc({ key, field, prefix }) {
  if (!map.tables[key]) { log(`таблица «${key}» не в схеме — пропуск (запустите npm run schema)`); return 0; }
  const rows = await nc.listRows(TID(key));

  // максимум NNN по (год) для этого префикса
  const maxByYear = new Map();
  for (const r of rows) {
    const m = new RegExp(`^${prefix}-(\\d{4})-(\\d+)$`).exec(String(r[field] || ''));
    if (m) maxByYear.set(m[1], Math.max(maxByYear.get(m[1]) || 0, parseInt(m[2], 10)));
  }

  let assigned = 0;
  for (const r of rows) {
    if (String(r[field] || '').trim()) continue;
    const y = yearOf(r);
    const next = (maxByYear.get(y) || 0) + 1;
    maxByYear.set(y, next);
    const num = `${prefix}-${y}-${String(next).padStart(3, '0')}`;
    await nc.updateRow(TID(key), idOf(r), { [field]: num });
    log(`+ ${map.tables[key].title} Id=${idOf(r)} → ${num}`);
    assigned++;
  }
  return assigned;
}

async function main() {
  await nc.signin();
  console.log('Автонумерация документов контроля (ВК/ПК/НП)');
  let total = 0;
  for (const d of DOCS) total += await processDoc(d);
  console.log(total ? `\n✓ Присвоено номеров: ${total}` : '\nНомера присваивать не требуется — всё заполнено.');
}

main().catch((e) => { console.error('✗ Ошибка автонумерации:', e.message); process.exit(1); });
