// ============================================================================
//  Чистка осиротевших / некорректных карт задач.
//
//  Кандидаты — задачи, у которых «№ задачи» содержит «?» (создавались ранним
//  generate-tasks до фикса № позиции/№ операции, напр. «ПЗ-2026-001/?-оп?»).
//
//  По умолчанию — сухой прогон (только показывает кандидатов). Удаление —
//  с флагом --apply. Удаление записи в NocoDB снимает и её связи.
//
//  Запуск:
//    NC_URL=http://nocodb:8080 NC_TOKEN=... node nocodb/scripts/cleanup-orphan-tasks.mjs          # показать
//    NC_URL=http://nocodb:8080 NC_TOKEN=... node nocodb/scripts/cleanup-orphan-tasks.mjs --apply  # удалить
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nc from '../lib/nocodb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.state', 'schema-map.json'), 'utf-8'));
const TID = (key) => map.tables[key].id;
const idOf = (r) => r.Id ?? r.id;

const apply = process.argv.includes('--apply');

async function main() {
  await nc.signin();
  const tasks = await nc.listRows(TID('tasks'));
  const orphans = tasks.filter((t) => /\?/.test(String(t['№ задачи'] || '')));

  if (!orphans.length) { console.log('Осиротевших задач (с «?» в № задачи) нет.'); return; }

  console.log(`Найдено кандидатов: ${orphans.length}`);
  for (const t of orphans) console.log(`  • Id=${idOf(t)}  «${t['№ задачи']}»  (${t['Операция (№ МК / № оп.)'] || '—'}, статус: ${t['Статус'] || '—'})`);

  if (!apply) { console.log('\nСухой прогон. Для удаления повторите с флагом --apply'); return; }

  let deleted = 0;
  for (const t of orphans) {
    await nc.deleteRow(TID('tasks'), idOf(t));
    console.log(`  − удалена Id=${idOf(t)} «${t['№ задачи']}»`);
    deleted++;
  }
  console.log(`\n✓ Удалено: ${deleted}`);
}

main().catch((e) => { console.error('✗ Ошибка чистки:', e.message); process.exit(1); });
