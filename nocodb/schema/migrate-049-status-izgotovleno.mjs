// ============================================================================
//  Миграция 049 — статус «Изготовлено» у ПЗ (K-105, решение владельца).
//
//  Новая модель статусов заказа (ПЗ):
//    Размещён → В работе → (Приостановлен) → Изготовлено (продукция на складе;
//    сюда ведёт авто-агрегация задач) → Отгружен → Выполнен (поставлено
//    заказчику — терминал успеха). «Отменён» — терминал. «Закрыт» — ЛЕГАСИ:
//    старые записи остаются валидными и читаются, но из активного словаря
//    (переходы/создание) статус убран на стороне сервера портала.
//
//  ЧТО ДЕЛАЕТ:
//   (a) МЕТА: добавляет опцию «Изготовлено» в SingleSelect «Статус» таблицы
//       «Заказы» ИДЕМПОТЕНТНО (skip-if-exists; PATCH colOptions/dtxp —
//       существующие опции с их id/цветами сохраняются, «Закрыт» НЕ удаляется —
//       легаси-записи должны остаться валидными).
//   (b) ДАННЫЕ: переводит существующие ПЗ со статусом «Выполнен» → «Изготовлено».
//       По новой семантике «Выполнен» = поставлено заказчику, а текущие
//       «Выполнен» в базе = изготовлено и лежит на складе (в проде это
//       ПЗ-2026-002 ЕВРАЗ). Список переводимых печатается и в DRY_RUN, и в
//       APPLY — оркестратор сверяет его ПЕРЕД применением (⚠ если ЕВРАЗ уже
//       фактически отгружен — его надо будет руками перевести дальше по рельсу,
//       миграция об этом знать не может). «Закрыт» и прочие статусы НЕ трогаем.
//
//  БЕЗОПАСНОСТЬ ЗАПИСИ (как migrate-033/047): DRY_RUN — ПО УМОЛЧАНИЮ.
//  Запись ТОЛЬКО при ЯВНЫХ ОБОИХ флагах: DRY_RUN=0 APPLY_CONFIRM=YES.
//  К LIVE NocoDB НЕ применять без гринлайта Александра.
//
//  Запуск (DRY-RUN, по умолчанию — НИЧЕГО не пишется):
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=... node nocodb/schema/migrate-049-status-izgotovleno.mjs
//  Запуск (APPLY, только по гринлайту Александра):
//    NC_URL=... NC_TOKEN=... DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-049-status-izgotovleno.mjs
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = process.env.NC_BASE_TITLE || 'Производство ПБС';
const TABLE_TITLE = 'Заказы';
const STATUS_COL = 'Статус';
const NEW_OPTION = 'Изготовлено';
const NEW_OPTION_COLOR = '#27ae60';   // done-зелёный (готово на складе) — канон 5 семантических цветов
const FROM_STATUS = 'Выполнен';        // данные: эти записи переводим…
const TO_STATUS = 'Изготовлено';       // …в новый статус (семантика «на складе»)

const APPLY = process.env.DRY_RUN === '0' && process.env.APPLY_CONFIRM === 'YES';
const DRY_RUN = !APPLY;
const log = (...a) => console.log('  ', ...a);
const plan = (...a) => console.log('   [dry]', ...a);

const optTitles = (col) => (col && col.colOptions && col.colOptions.options ? col.colOptions.options.map((o) => o.title) : []);

async function main() {
  await nc.signin();
  const base = await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База «${BASE_TITLE}» не найдена`);
  const tables = await nc.listTables(base.id);
  const orders = tables.find((x) => x.title === TABLE_TITLE);
  if (!orders) throw new Error(`Таблица «${TABLE_TITLE}» не найдена в базе «${base.title}».`);

  console.log(`\n=== Миграция 049 «Изготовлено» (K-105) — режим: ${DRY_RUN ? 'DRY_RUN (ничего не пишется)' : 'APPLY (запись в базу)'} ===\n`);
  log(`база «${base.title}» (id ${base.id}) · таблица «${orders.title}» (id ${orders.id})`);

  const full = await nc.getTable(orders.id);
  const before = { opts: optTitles(full.columns.find((c) => c.title === STATUS_COL)) };

  // --- (a) МЕТА: опция «Изготовлено» в SingleSelect «Статус» -------------------
  const stCol = full.columns.find((c) => c.title === STATUS_COL);
  if (!stCol) {
    throw new Error(`Колонка «${STATUS_COL}» не найдена в «${TABLE_TITLE}» — мета-шаг невозможен.`);
  } else if (stCol.uidt !== 'SingleSelect') {
    log(`⚠ «${STATUS_COL}» имеет тип ${stCol.uidt}, не SingleSelect — авто-добавление опции небезопасно. РУЧНОЙ ШАГ: добавить опцию в NocoDB.`);
  } else {
    const existing = (stCol.colOptions && stCol.colOptions.options) || [];
    const titles = existing.map((o) => o.title);
    if (titles.includes(NEW_OPTION)) {
      log(`опция «${NEW_OPTION}» в «${STATUS_COL}» уже есть — пропуск (идемпотентно)`);
    } else {
      // существующие опции (id/цвет/порядок) сохраняем как есть; новая — в конец.
      // «Закрыт» НЕ удаляем: легаси-записи должны остаться валидными.
      const options = [...existing, { title: NEW_OPTION, color: NEW_OPTION_COLOR }];
      const dtxp = options.map((o) => `'${o.title.replace(/'/g, "''")}'`).join(',');
      if (DRY_RUN) {
        plan(`+ опция «${NEW_OPTION}» → «${STATUS_COL}» (было: ${titles.join(' · ')} → станет: ${options.map((o) => o.title).join(' · ')})`);
      } else {
        await nc.updateColumn(stCol.id, {
          title: stCol.title, column_name: stCol.column_name, uidt: 'SingleSelect',
          colOptions: { options }, dtxp,
        });
        log(`+ опция «${NEW_OPTION}» добавлена в «${STATUS_COL}»`);
      }
    }
  }

  // --- (b) ДАННЫЕ: «Выполнен» → «Изготовлено» ----------------------------------
  //  Печатаем СПИСОК переводимых всегда (dry и apply) — оркестратор проверяет его
  //  перед применением (в проде ожидается ПЗ-2026-002 ЕВРАЗ; если он уже отгружен
  //  фактически — после миграции перевести его по рельсу дальше вручную).
  const rows = await nc.listRows(orders.id);
  const move = rows.filter((r) => String(r[STATUS_COL] || '').trim() === FROM_STATUS);
  console.log(`\n   Записей «${TABLE_TITLE}» всего: ${rows.length}; со статусом «${FROM_STATUS}» (переводимых → «${TO_STATUS}»): ${move.length}`);
  for (const r of move) {
    log(`• Id ${r.Id ?? r.id} · ${r['№ ПЗ'] || '(без №)'} · ${r['Заказчик / Инициатор'] || ''} · план: ${r['Плановый срок'] || '—'}`);
  }
  if (!move.length) {
    log(`переводить нечего — записей в статусе «${FROM_STATUS}» нет`);
  } else if (DRY_RUN) {
    plan(`перевести ${move.length} зап. «${FROM_STATUS}» → «${TO_STATUS}» (список выше)`);
  } else {
    if (!optTitles((await nc.getTable(orders.id)).columns.find((c) => c.title === STATUS_COL)).includes(TO_STATUS)) {
      throw new Error(`Опция «${TO_STATUS}» не появилась в «${STATUS_COL}» — данные не переводим.`);
    }
    for (const r of move) {
      await nc.updateRow(orders.id, r.Id ?? r.id, { [STATUS_COL]: TO_STATUS });
      log(`✓ ${r['№ ПЗ'] || ('Id ' + (r.Id ?? r.id))}: «${FROM_STATUS}» → «${TO_STATUS}»`);
    }
  }

  // --- контроль before == after (в DRY_RUN мета не должна измениться) ----------
  const after = { opts: optTitles((await nc.getTable(orders.id)).columns.find((c) => c.title === STATUS_COL)) };
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\n   [verify] мета «${STATUS_COL}» ${DRY_RUN ? 'DRY_RUN' : 'APPLY'}: before ${unchanged ? '==' : '!='} after`);
  if (DRY_RUN && !unchanged) console.log('   ⚠ ВНИМАНИЕ: в DRY_RUN схема изменилась — этого быть не должно!');
  console.log(`   [verify] опции «${STATUS_COL}»: было [${before.opts.join(', ')}] → стало [${after.opts.join(', ')}]`);

  console.log(`\n✓ Миграция 049 («Изготовлено»)${DRY_RUN ? ' — DRY_RUN: ничего не записано' : ' — APPLY: применена'}.`);
  if (DRY_RUN) console.log('   Для записи (по гринлайту Александра): DRY_RUN=0 APPLY_CONFIRM=YES node nocodb/schema/migrate-049-status-izgotovleno.mjs');
}

main().catch((e) => { console.error('✗ Ошибка миграции 049:', e.message); process.exit(1); });
