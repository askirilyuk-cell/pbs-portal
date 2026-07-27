// ============================================================================
//  Миграция 047 — «Цех: чертёж → задание → рабочее место», ШАГ 1.
//  ТЗ: docs/ТЗ-цех-шаг1-чертёж-задание-рабочее-место.md (утв. Александром 27.07.2026).
//
//  ПОЧЕМУ 047, А НЕ 046 (как в ТЗ). Скриптов 036–045 в git нет (Р2 из ТЗ), номера
//  восстановлены по ссылкам в коде портала. Номер 046 УЖЕ ЗАНЯТ и УЖЕ ПРИМЕНЁН:
//  это поля оплаты в «Заявки ЗнЗ» (K-83 этап 1a, portal/server.js:3161 savePaymentToZnz).
//  Проверено фактом 27.07.2026 через meta-API: в таблице procurement_requests
//  (m50p9c24isyknrj) присутствуют «Оплата Id», «Оплата статус», «Оплата ExternalRef»,
//  «Оплата сумма», «Оплата обновлено». Ссылок на 047+ в коде нет → берём 047.
//
//  СТРОГО АДДИТИВНАЯ: только СОЗДАНИЕ колонок в двух существующих таблицах.
//  Ноль новых таблиц, ноль rename, ноль смены типов, ноль удалений, ноль записи
//  в данные. Идемпотентна: колонка, которая уже есть, пропускается.
//
//  Что добавляет (база «Производство ПБС»):
//
//  «Задачи на участки» (tasks, mc45kytd0a1g8rq) — 6 колонок:
//    • «Начато (факт)»       DateTime  — ставит СЕРВЕР по кнопке «▶ Начал» (UTC)
//    • «Завершено (факт)»    DateTime  — ставит СЕРВЕР по кнопке «⏹ Закончил» (UTC)
//    • «Порядок в очереди»   Number    — ручной порядок мастера (пусто = по сроку)
//    • «Выдал в цех»         Text      — ФИО того, кто выдал задачу (аудит)
//    • «Дата выдачи»         Date      — когда выдали в цех
//    • «Без МК»              Checkbox  — ПРИЗНАК «создано без маршрутной карты»
//        (лёгкий путь «Выдать в цех» из позиции ПЗ; см. обоснование ниже)
//
//  «Сотрудники» (employees, mutpawn40xqquse) — 2 колонки:
//    • «ID Bitrix»           Number    — мост «аккаунт портала ↔ сотрудник» (гл. блокер ЛК)
//    • «Активен»             Checkbox  — работает ли сотрудник сейчас
//
//  ПОЧЕМУ «Без МК» — ОТДЕЛЬНАЯ КОЛОНКА, А НЕ ПРОИЗВОДНЫЙ ПРИЗНАК.
//  Производный вариант («нет связи с операцией маршрута», operations_id = null)
//  ломается в трёх местах: (1) операцию маршрута можно удалить/перепривязать
//  задним числом — задача, рождённая ПО техпроцессу, вдруг станет «без МК»;
//  (2) обратная ситуация — задачу лёгкого пути позже привязали к операции, и
//  факт «сделано без техпроцесса» бесследно исчезает; (3) признак не виден и не
//  фильтруется в самой NocoDB, а именно там его будут смотреть при разборе.
//  Смысл пометки — не «какая связь сейчас», а «как задача РОДИЛАСЬ»; такие факты
//  хранят, а не вычисляют. Колонка пишется один раз при создании и больше не
//  меняется. Обратная совместимость: у всех старых задач она пустая = «по МК».
//
//  ЧТО СОЗНАТЕЛЬНО НЕ ЗАВОДИТСЯ КОЛОНКОЙ: «⚠ время требует уточнения» (лимит
//  смены SHIFT_MAX_HOURS). Он полностью выводится из уже хранимых данных:
//  «Начато (факт)» и «Завершено (факт)» заданы, интервал > лимита, «Время факт. (ч)»
//  пусто → требует уточнения; мастер вписал часы → признак гаснет сам. Тут
//  производный признак не теряет информацию, поэтому лишней колонки не заводим.
//
//  БЕЗОПАСНОСТЬ ЗАПИСИ (как migrate-026/032/035): DRY_RUN — ПО УМОЛЧАНИЮ.
//  Запись ТОЛЬКО при ЯВНЫХ ОБОИХ флагах: DRY_RUN=0 APPLY_CONFIRM=YES
//
//  Запуск (DRY-RUN, НИЧЕГО не пишется — так гоняем до APPROVE Александра):
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=... node nocodb/schema/migrate-047-shopfloor.mjs
//  Запуск (APPLY, ТОЛЬКО по гринлайту Александра):
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=... DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-047-shopfloor.mjs
//  NC_URL обязателен: без него write-клиент уходит на localhost:8080 (грабля канона).
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = 'Производство ПБС';
const APPLY = process.env.DRY_RUN === '0' && process.env.APPLY_CONFIRM === 'YES';
const DRY_RUN = !APPLY;
const log = (...a) => console.log('  ', ...a);
const plan = (...a) => console.log('   [dry]', ...a);

const txt = (title, column_name) => ({ title, column_name, uidt: 'SingleLineText' });
const num = (title, column_name) => ({ title, column_name, uidt: 'Number' });
const date = (title, column_name) => ({ title, column_name, uidt: 'Date' });
const dt = (title, column_name) => ({ title, column_name, uidt: 'DateTime' });
const chk = (title, column_name) => ({ title, column_name, uidt: 'Checkbox' });

// Что добавляем. Порядок = порядок появления колонок в таблице.
const PLAN = [
  {
    table: 'Задачи на участки',
    columns: [
      dt('Начато (факт)', 'started_at'),
      dt('Завершено (факт)', 'finished_at'),
      num('Порядок в очереди', 'queue_order'),
      txt('Выдал в цех', 'issued_by'),
      date('Дата выдачи', 'issued_at'),
      chk('Без МК', 'no_route'),
    ],
  },
  {
    table: 'Сотрудники',
    columns: [
      num('ID Bitrix', 'bitrix_id'),
      chk('Активен', 'active'),
    ],
  },
];

async function main() {
  await nc.signin();
  const base = await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База «${BASE_TITLE}» не найдена`);
  const tables = await nc.listTables(base.id);
  const find = (t) => tables.find((x) => x.title === t);

  console.log(`\n=== Миграция 047 «Цех: рабочее место, шаг 1» — режим: ${DRY_RUN ? 'DRY_RUN (ничего не пишется)' : 'APPLY (запись в прод)'} ===`);
  console.log(`    NocoDB: ${nc.config.BASE}  ·  база: ${base.title} (${base.id})\n`);

  let willCreate = 0, already = 0, conflicts = 0;

  for (const step of PLAN) {
    const table = find(step.table);
    if (!table) { log(`⚠ таблица «${step.table}» НЕ НАЙДЕНА — шаг пропущен`); conflicts++; continue; }
    const full = await nc.getTable(table.id);
    const byTitle = new Map((full.columns || []).map((c) => [c.title, c]));
    const byName = new Map((full.columns || []).filter((c) => c.column_name).map((c) => [c.column_name, c]));
    console.log(`   «${step.table}» (${table.id}): колонок сейчас ${(full.columns || []).length}`);

    for (const col of step.columns) {
      const exTitle = byTitle.get(col.title);
      const exName = byName.get(col.column_name);
      if (exTitle) {
        already++;
        const same = exTitle.uidt === col.uidt;
        log(`= «${col.title}» уже есть [${exTitle.uidt}]${same ? '' : ` ⚠ ТИП НЕ СОВПАДАЕТ (ожидали ${col.uidt}) — колонку НЕ трогаем`}`);
        if (!same) conflicts++;
        continue;
      }
      if (exName) {
        conflicts++;
        log(`⚠ КОНФЛИКТ: физическое имя «${col.column_name}» занято колонкой «${exTitle ? exTitle.title : exName.title}» — колонка «${col.title}» НЕ будет создана`);
        continue;
      }
      willCreate++;
      if (DRY_RUN) { plan(`+ «${col.title}» [${col.uidt}] (column_name=${col.column_name})`); continue; }
      await nc.createColumn(table.id, col);
      log(`+ создана «${col.title}» [${col.uidt}]`);
    }
    console.log('');
  }

  console.log('   ── Итог ──────────────────────────────────────────────');
  console.log(`   к созданию: ${willCreate} · уже есть: ${already} · конфликтов/предупреждений: ${conflicts}`);
  if (DRY_RUN) {
    console.log('\n   DRY_RUN: в базу НИЧЕГО не записано.');
    console.log('   APPLY (только по гринлайту Александра):');
    console.log('     NC_URL=http://192.168.1.10:8080 NC_TOKEN=… DRY_RUN=0 APPLY_CONFIRM=YES \\');
    console.log('       node nocodb/schema/migrate-047-shopfloor.mjs\n');
  } else {
    console.log('\n   APPLY завершён. Перезапуск портала не требуется: сервер читает схему через meta-API.\n');
  }
  if (conflicts) process.exitCode = 2;
}

main().catch((e) => { console.error('\nОШИБКА миграции 047:', e.message); process.exit(1); });
