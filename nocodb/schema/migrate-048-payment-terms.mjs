// ============================================================================
//  Миграция 048 — «Срок платежа поставщику: сохраняем условия оплаты у себя».
//  Карточка D-1 (дефект): портал отправляет во внешний платёжный портал
//  expectedPaymentDate / avansPercent / paymentType (portal/server.js,
//  createPayment ~3355–3370), но НИ ОДНО из этих значений у нас не хранится —
//  срок платежа живёт только на стороне Смирнова. Расходную часть денежного
//  календаря (K-96) на этом построить нельзя: нечего класть на ось времени.
//
//  ПОЧЕМУ 048 (проверено фактом 28.07.2026, meta-API http://192.168.1.10:8080):
//    • Скриптов 036–046 в git НЕТ — номера восстановлены по ссылкам в коде
//      портала (см. шапку migrate-047). Это не повод считать номер свободным.
//    • 046 — поля оплаты в «Заявки ЗнЗ» (K-83 этап 1a), УЖЕ ПРИМЕНЁН: в таблице
//      m50p9c24isyknrj присутствуют «Оплата Id», «Оплата статус»,
//      «Оплата ExternalRef», «Оплата сумма», «Оплата обновлено».
//    • 047 — цеховой контур (ветка feat/shopfloor-step1,
//      nocodb/schema/migrate-047-shopfloor.mjs). ЗАНЯТ.
//    • Ссылок на 048+ в коде и в git (все ветки) нет → берём 048.
//  Номер и состав совпадают с нарезкой в ТЗ K-96 («migrate-048 — срочные
//  колонки счетов: Ожидаемая дата оплаты, Тип оплаты, Процент аванса»).
//
//  ФАКТИЧЕСКАЯ СХЕМА «Счета-К» (meu5pyqp7okhnc2) НА МОМЕНТ НАПИСАНИЯ — снята
//  meta-API 28.07.2026. Колонки платежа: «Статус оплаты» (SingleSelect),
//  «Оплата ExternalRef», «Оплата ID», «Оплата обновлена» (все SingleLineText).
//  Колонок под дату/тип/процент НЕТ ни под одним из имён ниже. Подтверждено.
//
//  СТРОГО АДДИТИВНАЯ: только СОЗДАНИЕ колонок в двух существующих таблицах.
//  Ноль новых таблиц, ноль rename, ноль смены типов, ноль удалений, ноль
//  записи в данные. Идемпотентна: существующая колонка пропускается (повторный
//  прогон не плодит дублей — критерий приёмки 5 карточки D-1).
//
//  СВЕРКА СУЩЕСТВУЮЩЕЙ КОЛОНКИ — НЕ ТОЛЬКО ПО ТИПУ (правка по FAIL QA).
//  Первая редакция при живой колонке сверяла один uidt. Этого мало: колонка
//  «Тип оплаты» может УЖЕ существовать как SingleSelect, но с ЧУЖИМ словарём
//  (например {Аванс|Отсрочка}). Тип совпадает, миграция говорит «уже есть» и
//  молчит — а портал потом получает 422 на запись «Постоплата». Теперь у
//  SingleSelect сверяется ещё и набор вариантов, и недостающие показываются
//  явным конфликтом (exit code 2). Колонку по-прежнему НЕ трогаем: молча менять
//  словарь живой колонки опаснее, чем показать расхождение человеку.
//
//  ЧТО ДОБАВЛЯЕТ (база «Производство ПБС», p0ic4ghwyat7q39):
//
//  «Счета-К» (invoices, meu5pyqp7okhnc2) — 4 колонки. ОСНОВНОЙ АДРЕСАТ: сейчас
//  каждый СЧЁТ = отдельная заявка на оплату (K-83 этап 2, externalRef
//  «№ЗнЗ/№счёта»), и именно счёт — единица расходного календаря.
//    • «Ожидаемая дата оплаты» Date     — что ушло в expectedPaymentDate (постоплата)
//    • «Тип оплаты»            SingleSelect {Предоплата|Постоплата}
//    • «Процент аванса»        Decimal  — что ушло в avansPercent (предоплата)
//    • «Срок оплаты (портал)»  Date     — см. ниже, добавлено после разбора QA
//
//  ПОЧЕМУ ПОЯВИЛАСЬ ЧЕТВЁРТАЯ КОЛОНКА «Срок оплаты (портал)» (правка по FAIL QA).
//  Первая редакция писала в «Ожидаемую дату оплаты» дату ИЗ ОТВЕТА платёжного
//  портала — и затирала ею срок, который человек поправил руками (перенёс с
//  поставщиком). Это блокер: критерий 7 требует, чтобы правка человека пережила
//  любое число опросов, включая массовый «⟳ Статусы оплат».
//  Теперь «Ожидаемая дата оплаты» — НАША колонка: в неё пишется только то, что
//  ушло наружу, и её не трогает ни один опрос статуса. Но и терять то, что
//  сообщает портал, нельзя — расхождение сроков это рабочая ситуация, а не сбой.
//  Поэтому дата портала кладётся РЯДОМ, в отдельную колонку. Предупреждение в
//  тосте живёт секунды, колонка живёт всегда: снабженец видит расхождение в
//  карточке счёта, K-96 строит календарь по НАШЕЙ дате и может свериться с
//  чужой. Альтернативы («молча оставить наше» / «спросить человека») — см.
//  развилки для владельца в отчёте по карточке.
//  Шаг такой же аддитивный, как остальные три, и попадает в ТУ ЖЕ миграцию 048,
//  потому что она НЕ ПРИМЕНЕНА к боевой базе (в «Счета-К» meu5pyqp7okhnc2 на
//  28.07.2026 26 колонок, ни одной из наших нет) — плодить 049 не за чем.
//
//  «Заявки ЗнЗ» (procurement_requests, m50p9c24isyknrj) — те же 4 колонки.
//  ЗАЧЕМ, если карточка D-1 говорит только про счета: в UI ЖИВА и вторая ветка
//  отправки — кнопка «Отправить на оплату» в блоке оплаты ЗнЗ (openPayFormInline
//  без prefill, server.js createPayment без invoiceId → savePaymentToZnz).
//  Такой платёж вообще не имеет записи-счёта, и его срок девать некуда. Ветка
//  дырявая ровно тем же дефектом; ТЗ K-96 тоже называет обе таблицы. Шаг
//  аддитивный и ничего не стоит — если владелец решит ветку закрыть, шаг просто
//  удаляется из PLAN.
//
//  ПОЧЕМУ «Процент аванса» — Decimal, А НЕ Number.
//  Number в NocoDB — целое. Форма отправки на оплату (index.html, #pay-avans)
//  объявлена как step="any", а сервер проверяет только «конечное число 1..100»
//  (createPayment) — то есть 33.33 % уходит наружу штатно и законно. Number
//  молча округлил бы его до 33 — мы бы хранили НЕ ТО, что отправили, а это
//  ровно тот дефект, который чиним. Плюс K-96 будет считать сумму аванса как
//  amount×percent/100 — округление процента поехало бы в деньги.
//
//  ПОЧЕМУ «Тип оплаты» — SingleSelect с РУССКИМИ вариантами, а не AVANS/POSTOPLATA.
//  Колонку читают глазами в NocoDB (там разбирают платежи), а контрактные коды
//  живут в payload и в коде портала (PAY_TYPES). Маппинг — одна строка в
//  server.js (PAY_TYPE_RU). Соседняя «Статус оплаты» ровно так же русская,
//  хотя внешний портал отдаёт PAID/REJECTED — держим единый стиль таблицы.
//
//  ФИЗИЧЕСКИЕ ИМЕНА (column_name) — латиница snake_case, как в каноне схемы
//  (invoice_no, supplier, pay_status) и в migrate-046/047. У колонок
//  «Оплата ExternalRef»/«Оплата ID»/«Оплата обновлена» в «Счета-К» физические
//  имена кириллические — они созданы на лету через ncEnsureColumn (server.js),
//  который column_name не передаёт. Повторять эту случайность не надо: портал
//  обращается к колонкам ПО TITLE, физическое имя ни на что не влияет.
//
//  БЕЗОПАСНОСТЬ ЗАПИСИ (как migrate-032/035/047): DRY_RUN — ПО УМОЛЧАНИЮ.
//  Запись ТОЛЬКО при ЯВНЫХ ОБОИХ флагах: DRY_RUN=0 APPLY_CONFIRM=YES
//
//  Запуск (DRY-RUN, НИЧЕГО не пишется — так гоняем до APPROVE Александра):
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=… node nocodb/schema/migrate-048-payment-terms.mjs
//  Запуск (APPLY, ТОЛЬКО по гринлайту Александра):
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=… DRY_RUN=0 APPLY_CONFIRM=YES \
//      node nocodb/schema/migrate-048-payment-terms.mjs
//  NC_URL обязателен: без него write-клиент уходит на localhost:8080 (грабля канона).
//
//  ПОСЛЕ APPLY перезапуск портала НЕ нужен: server.js читает схему через
//  meta-API без кеша (ncTableMeta) и сам подхватит появившиеся колонки —
//  до APPLY он их просто не пишет и говорит об этом в ответе (см. D-1 п.2).
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = 'Производство ПБС';
const APPLY = process.env.DRY_RUN === '0' && process.env.APPLY_CONFIRM === 'YES';
const DRY_RUN = !APPLY;
const log = (...a) => console.log('  ', ...a);
const plan = (...a) => console.log('   [dry]', ...a);

const dec = (title, column_name) => ({ title, column_name, uidt: 'Decimal' });
const date = (title, column_name) => ({ title, column_name, uidt: 'Date' });
const sel = (title, column_name, options) => ({
  title, column_name, uidt: 'SingleSelect',
  colOptions: { options: options.map((o) => ({ title: o })) },
  dtxp: options.map((o) => `'${o.replace(/'/g, "''")}'`).join(','), // дубль вариантов — часть версий NocoDB читает именно dtxp
});

// Варианты «Тип оплаты» = ровно два типа контракта (§2 INTEGRATION_ISM:
// paymentType AVANS | POSTOPLATA). Третьего не бывает — см. PAY_TYPES в server.js.
const PAY_TYPE_OPTIONS = ['Предоплата', 'Постоплата'];

// Один и тот же набор колонок для обеих таблиц: имена совпадают намеренно,
// чтобы K-96 читал условия платежа одинаково независимо от того, привязан
// платёж к счёту или к заявке.
const TERM_COLUMNS = () => [
  date('Ожидаемая дата оплаты', 'expected_payment_date'),
  sel('Тип оплаты', 'payment_type', PAY_TYPE_OPTIONS),
  dec('Процент аванса', 'avans_percent'),
  // Что о сроке говорит ПЛАТЁЖНЫЙ ПОРТАЛ. Заполняется только при расхождении с
  // нашей датой (или когда нашей ещё нет) — см. payTermsPlan в portal/server.js.
  date('Срок оплаты (портал)', 'portal_payment_date'),
];

const PLAN = [
  { table: 'Счета-К', columns: TERM_COLUMNS() },
  { table: 'Заявки ЗнЗ', columns: TERM_COLUMNS() },
];

// Варианты SingleSelect живой колонки. NocoDB отдаёт их в colOptions.options,
// старые версии — строкой dtxp ('A','B'); читаем оба, иначе «словарь пуст» будет
// ложным выводом на ровном месте.
function optionsOf(col) {
  const fromMeta = ((col && col.colOptions && col.colOptions.options) || []).map((o) => o.title).filter(Boolean);
  if (fromMeta.length) return fromMeta;
  const dtxp = String((col && col.dtxp) || '');
  return dtxp ? (dtxp.match(/'((?:[^']|'')*)'/g) || []).map((s) => s.slice(1, -1).replace(/''/g, "'")) : [];
}
// Каких наших вариантов не хватает в словаре живой колонки ([] — всё на месте
// или сверять нечего: колонка не SingleSelect / мы словарь не задаём).
function missingOptions(existing, wanted) {
  if (wanted.uidt !== 'SingleSelect' || existing.uidt !== 'SingleSelect') return [];
  const have = new Set(optionsOf(existing));
  return wanted.colOptions.options.map((o) => o.title).filter((t) => !have.has(t));
}

async function main() {
  await nc.signin();
  const base = await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База «${BASE_TITLE}» не найдена`);
  const tables = await nc.listTables(base.id);
  const find = (t) => tables.find((x) => x.title === t);

  console.log(`\n=== Миграция 048 «Условия платежа поставщику» — режим: ${DRY_RUN ? 'DRY_RUN (ничего не пишется)' : 'APPLY (запись в прод)'} ===`);
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
        // ИДЕМПОТЕНТНОСТЬ: колонка с таким названием уже есть — НЕ трогаем её
        // ни при каких обстоятельствах (в т.ч. при несовпадении типа/словаря:
        // молча менять живую колонку опаснее, чем показать конфликт человеку).
        already++;
        const bad = [];
        if (exTitle.uidt !== col.uidt) bad.push(`ТИП НЕ СОВПАДАЕТ (ожидали ${col.uidt})`);
        // Сверяем и СЛОВАРЬ: одинакового uidt мало — SingleSelect с чужими
        // вариантами отвергнет нашу запись 422-м и утащит с собой соседние поля.
        const missing = missingOptions(exTitle, col);
        if (missing.length) bad.push(`В СЛОВАРЕ НЕТ ВАРИАНТОВ: ${missing.join(', ')} (есть: ${optionsOf(exTitle).join('|') || '—'})`);
        log(`= «${col.title}» уже есть [${exTitle.uidt}]${bad.length ? ` ⚠ ${bad.join('; ')} — колонку НЕ трогаем` : ''}`);
        if (bad.length) conflicts++;
        continue;
      }
      if (exName) {
        conflicts++;
        log(`⚠ КОНФЛИКТ: физическое имя «${col.column_name}» занято колонкой «${exName.title}» — «${col.title}» НЕ будет создана`);
        continue;
      }
      willCreate++;
      const opts = col.uidt === 'SingleSelect' ? ` {${col.colOptions.options.map((o) => o.title).join('|')}}` : '';
      if (DRY_RUN) { plan(`+ «${col.title}» [${col.uidt}]${opts} (column_name=${col.column_name})`); continue; }
      await nc.createColumn(table.id, col);
      log(`+ создана «${col.title}» [${col.uidt}]${opts}`);
    }
    console.log('');
  }

  console.log('   ── Итог ──────────────────────────────────────────────');
  console.log(`   к созданию: ${willCreate} · уже есть: ${already} · конфликтов/предупреждений: ${conflicts}`);
  if (DRY_RUN) {
    console.log('\n   DRY_RUN: в базу НИЧЕГО не записано.');
    console.log('   APPLY (только по гринлайту Александра):');
    console.log('     NC_URL=http://192.168.1.10:8080 NC_TOKEN=… DRY_RUN=0 APPLY_CONFIRM=YES \\');
    console.log('       node nocodb/schema/migrate-048-payment-terms.mjs\n');
  } else {
    console.log('\n   APPLY завершён. Перезапуск портала не требуется: сервер читает схему через meta-API.\n');
  }
  if (conflicts) process.exitCode = 2;
}

main().catch((e) => { console.error('\nОШИБКА миграции 048:', e.message); process.exit(1); });
