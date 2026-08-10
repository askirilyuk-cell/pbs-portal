// ============================================================================
//  Миграция 047 — «События» (лента событий портала, концепт №5 «Лента событий
//  как хребет», фаза 1, APPROVE владельца). Единый журнал событий — фундамент
//  для очереди «Мой день», кликабельных KPI, часов стадий и CAPA.
//
//  СТРОГО АДДИТИВНАЯ (стиль migrate-026/032/035): только СОЗДАНИЕ одной новой
//  таблицы. Ноль rename, ноль смены типов, ноль удалений, ноль связей —
//  :4173 не ломается, соседние модули не затрагиваются.
//
//  Что создаёт (в базе «Производство ПБС»):
//   • «События» (events) — журнал (append-only, пишет ТОЛЬКО сервер портала):
//       № объекта (pv) · Тип события (создан/статус изменён/файл приложен/
//       вердикт/просрочка/комментарий) · Объект (тип: ПЗ/ЗнЗ/ЗП/Акт/МК/КД —
//       SingleLineText, не select: список типов будет расти) · Было · Стало ·
//       Кто (ФИО из сессии) · Когда (DateTime) · Детали (LongText) ·
//       Роль-адресат (опц. — для будущей очереди «Мой день»).
//
//  БЕЗОПАСНОСТЬ ЗАПИСИ (как migrate-026/032/035): DRY_RUN — ПО УМОЛЧАНИЮ.
//  Запись ТОЛЬКО при ЯВНЫХ ОБОИХ флагах: DRY_RUN=0 APPLY_CONFIRM=YES.
//  К LIVE NocoDB (100.122.245.96:8080) НЕ применять без гринлайта Александра.
//
//  Запуск (DRY-RUN, по умолчанию — НИЧЕГО не пишется):
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=... node nocodb/schema/migrate-047-events.mjs
//  Запуск (APPLY, только по гринлайту Александра):
//    NC_URL=... NC_TOKEN=... DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-047-events.mjs
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = 'Производство ПБС';
const APPLY = process.env.DRY_RUN === '0' && process.env.APPLY_CONFIRM === 'YES';
const DRY_RUN = !APPLY;
const log = (...a) => console.log('  ', ...a);
const plan = (...a) => console.log('   [dry]', ...a);

// хелперы описания колонок (стиль migrate-026/032/035)
const txt = (title, column_name, pv) => ({ title, column_name, uidt: 'SingleLineText', ...(pv ? { pv: true } : {}) });
const long = (title, column_name) => ({ title, column_name, uidt: 'LongText' });
const dt = (title, column_name) => ({ title, column_name, uidt: 'DateTime' });
const sel = (title, column_name, options) => ({
  title, column_name, uidt: 'SingleSelect',
  colOptions: { options: options.map((o) => ({ title: o })) },
  dtxp: options.map((o) => `'${o.replace(/'/g, "''")}'`).join(','),
});

// держать в синхроне с EVENT_TYPES в portal/server.js (logEvent)
const EVENT_TYPES = ['создан', 'статус изменён', 'файл приложен', 'вердикт', 'просрочка', 'комментарий'];

async function main() {
  await nc.signin();
  const base = await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База «${BASE_TITLE}» не найдена`);
  const tables = await nc.listTables(base.id);
  const find = (t) => tables.find((x) => x.title === t);

  console.log(`\n=== Миграция 047 «События» (лента событий) — режим: ${DRY_RUN ? 'DRY_RUN (ничего не пишется)' : 'APPLY (запись в базу)'} ===\n`);

  const columns = [
    txt('№ объекта', 'obj_num', true),        // «ПЗ-2026-006» / «ЗнЗ-2026-014» / «ВК-2026-003» … (pv)
    sel('Тип события', 'event_type', EVENT_TYPES),
    txt('Объект', 'obj_kind'),                // тип объекта: ПЗ / ЗнЗ / ЗП / Акт / МК / КД (текст — список растёт)
    txt('Было', 'val_from'),                  // прежнее значение (для «статус изменён»)
    txt('Стало', 'val_to'),                   // новое значение / вердикт
    txt('Кто', 'who'),                        // ФИО из сессии портала (пусто = система)
    dt('Когда', 'happened_at'),
    long('Детали', 'details'),
    txt('Роль-адресат', 'role_to'),           // опц.: кому адресовано (задел под «Мой день»)
  ];

  const existing = find('События');
  if (existing) {
    log('таблица «События» уже есть — пропуск (миграция идемпотентна)');
  } else if (DRY_RUN) {
    plan(`создать таблицу «События» (events) с ${columns.length} колонками:`);
    for (const c of columns) plan(`   • «${c.title}» [${c.uidt}]${c.pv ? ' (pv)' : ''}${c.uidt === 'SingleSelect' ? ' {' + c.colOptions.options.map((o) => o.title).join('|') + '}' : ''}`);
  } else {
    log('создаю таблицу «События»');
    await nc.createTable(base.id, { table_name: 'events', title: 'События', columns });
    log('+ таблица «События» создана');
  }

  console.log(`\n✓ Миграция 047 («События»)${DRY_RUN ? ' — DRY_RUN: ничего не записано' : ' — APPLY: применена'}.`);
  if (DRY_RUN) console.log('   Для записи (по гринлайту Александра): DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-047-events.mjs');
}

main().catch((e) => { console.error('✗ Ошибка миграции 047:', e.message); process.exit(1); });
