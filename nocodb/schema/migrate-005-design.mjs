// ============================================================================
//  Миграция 005 — раздел «Проектирование и разработка» (ДП–П.1 / ДП–Д.1.2).
//
//  Создаёт в базе «Производство ПБС» таблицы конструкторско-технологического
//  контура + связи с производством. База та же (не отдельная), потому что
//  NocoDB не поддерживает связи между базами, а разделу нужны нативные связи:
//  КД↔Редакции, Извещения↔КД, ТД↔Операции (двухуровнево), УП↔Операции,
//  «применённая редакция»↔Задача (прослеживаемость §9.5).
//
//  Таблицы:
//   • Проекты разработки            (Ф.3–П.1)
//   • Конструкторская документация  (Ф.4–Д.1.2; дерево через самосвязь)
//   • Редакции КД                   (контролируемая единица = документ+редакция, §9.1)
//   • Извещения об изменении        (Ф.5–П.1; §7 / §9.4)
//   • ТД-библиотека                 (РИ/методики/формы контроля/брошюры/…)
//   • Управляющие программы ЧПУ     (заведена→опробование→утверждена)
//   • Подгруппы изделий             (классификатор ДП–Д.1.2 Прил. А)
//  + поля в существующие: «Задачи» (применённая редакция), «Маршруты» (проект, статус).
//  + связи (hm/mm).
//
//  Идемпотентно: что есть — пропускается. Связи обёрнуты в try/catch (mm
//  версозависимы) — таблицы создадутся даже если связь не встала, лог покажет.
//
//  Запуск:  NC_URL=... NC_TOKEN=... node nocodb/schema/migrate-005-design.mjs
// ============================================================================

import * as nc from '../lib/nocodb-client.mjs';

const BASE_TITLE = 'Производство ПБС';
const log = (...a) => console.log('  ', ...a);

const sel = (title, column_name, options) => ({
  title, column_name, uidt: 'SingleSelect',
  colOptions: { options: options.map((o) => ({ title: o })) },
  dtxp: options.map((o) => `'${o}'`).join(','),
});
const txt = (title, column_name, pv) => ({ title, column_name, uidt: 'SingleLineText', ...(pv ? { pv: true } : {}) });
const long = (title, column_name) => ({ title, column_name, uidt: 'LongText' });
const num = (title, column_name) => ({ title, column_name, uidt: 'Number' });
const dec = (title, column_name) => ({ title, column_name, uidt: 'Decimal' });
const date = (title, column_name) => ({ title, column_name, uidt: 'Date' });
const chk = (title, column_name) => ({ title, column_name, uidt: 'Checkbox' });

const STAGES = ['Шаг 1', 'Шаг 2', 'Шаг 3', 'Шаг 4', 'Шаг 5', 'Шаг 6', 'Шаг 7', 'Шаг 8', 'Шаг 9'];
const KD_STATUS = ['В разработке', 'На выпуске', 'Действует', 'Изменён', 'Аннулирован']; // §9.2

async function main() {
  await nc.signin();
  const base = await nc.getBaseByTitle(BASE_TITLE);
  if (!base) throw new Error(`База «${BASE_TITLE}» не найдена`);
  let tables = await nc.listTables(base.id);
  const find = (t) => tables.find((x) => x.title === t);

  // создать таблицу, если её ещё нет (идемпотентно), вернуть объект таблицы
  async function ensureTable(title, table_name, columns) {
    const existing = find(title);
    if (existing) { log(`таблица «${title}» уже есть — пропуск`); return existing; }
    log(`создаю таблицу «${title}»`);
    const t = await nc.createTable(base.id, { table_name, title, columns });
    tables = await nc.listTables(base.id);
    return find(title) || t;
  }
  // добавить колонку, если её нет
  async function ensureColumn(table, column) {
    const full = await nc.getTable(table.id);
    if (full.columns.some((c) => c.title === column.title)) { log(`«${table.title}»: «${column.title}» есть — пропуск`); return; }
    await nc.createColumn(table.id, column);
    log(`«${table.title}»: + поле «${column.title}»`);
  }
  // создать связь parent→child (hm|mm), если её нет
  async function ensureLink(parent, child, title, type = 'hm') {
    if (!parent || !child) { log(`связь «${title}»: нет таблицы — пропуск`); return; }
    try {
      const full = await nc.getTable(parent.id);
      if (full.columns.some((c) => c.title === title)) { log(`связь «${title}» есть — пропуск`); return; }
      await nc.createLink(parent.id, { title, childTableId: child.id, type });
      log(`+ связь «${parent.title}» → «${child.title}» (${type}) как «${title}»`);
    } catch (e) { log(`⚠ связь «${title}» не создана (${type}): ${e.message}`); }
  }

  // --- справочник подгрупп (классификатор Прил. А) -------------------------
  const subgroups = await ensureTable('Подгруппы изделий', 'design_subgroups', [
    txt('Код', 'code', true),
    sel('Группа', 'grp', ['ОК', 'СП', 'ПВО', 'РТИ', 'БМ', 'ЦХ']),
    txt('Расшифровка', 'name'),
  ]);

  // --- Проекты разработки (Ф.3–П.1) ----------------------------------------
  const projects = await ensureTable('Проекты разработки', 'design_projects', [
    txt('Децимальный номер', 'dec_no', true),
    sel('Группа', 'grp', ['ОК', 'СП', 'ПВО', 'РТИ', 'БМ', 'ЦХ']),
    txt('Подгруппа', 'subgroup'),
    txt('Наименование изделия', 'name'),
    txt('Тип продукции', 'product_type'),
    txt('Семейство / программа', 'family'),
    sel('Инициатор', 'initiator', ['ОП', 'ДпП', 'ЮПБ', 'Ендейвер', 'Заказчик']),
    txt('Связь с ПЗ / заказом', 'order_link'),
    date('Дата открытия', 'opened'),
    sel('Этап', 'stage', STAGES),
    date('Плановый срок', 'due'),
    txt('Ссылка на чат (Bitrix)', 'chat_url'),
    txt('NAS-папка проекта', 'nas_path'),
    long('Примечание', 'note'),
  ]);

  // --- Конструкторская документация (Ф.4–Д.1.2) ----------------------------
  const kd = await ensureTable('Конструкторская документация', 'design_kd', [
    txt('Децимальный номер документа', 'doc_no', true),
    txt('Децимальный номер проекта', 'project_no'),
    sel('Вид КД', 'kd_kind', ['ЭСБ', 'ЭМД', 'СБ', 'Чертёж детали', 'Спецификация', 'ПЗ', 'ИИ', 'ТБ']),
    sel('Тип элемента', 'elem_type', ['Г.СБ', 'П.СБ', 'Деталь', 'Материал', 'Оснастка', 'Стандартное']),
    txt('Наименование', 'name'),
    txt('Материал', 'material'),
    dec('Масса, кг', 'mass'),
    txt('Литера', 'litera'),
    txt('Код по каталогу', 'catalog_code'),
    num('Текущая редакция', 'cur_rev'),
    sel('Статус', 'status', KD_STATUS),
    chk('В производство', 'to_production'),
    txt('Workspace-путь (КОМПАС)', 'ws_path'),
    txt('Release-PDF', 'release_pdf'),
    txt('Разработал', 'author'),
    date('Дата актуализации', 'updated'),
    long('Примечание', 'note'),
  ]);

  // --- Редакции КД (контролируемая единица = документ + редакция) -----------
  const revisions = await ensureTable('Редакции КД', 'design_kd_revisions', [
    txt('Обозначение (док · ред)', 'rev_key', true),
    num('№ редакции', 'rev_no'),
    date('Дата выпуска', 'released'),
    txt('Литера', 'litera'),
    txt('№ извещения (ИИ)', 'notice_no'),
    sel('Статус редакции', 'rev_status', ['Действует', 'Изменён', 'Архив']),
    txt('Release-PDF', 'release_pdf'),
    txt('Кто выпустил', 'released_by'),
    long('Описание изменения', 'change_desc'),
  ]);

  // --- Извещения об изменении (Ф.5–П.1) ------------------------------------
  const notices = await ensureTable('Извещения об изменении', 'design_notices', [
    txt('№ извещения', 'notice_no', true),
    date('Дата', 'date'),
    txt('Инициатор', 'initiator'),
    txt('Документ / раздел', 'doc_section'),
    long('Описание изменения', 'change_desc'),
    long('Причина', 'reason'),
    sel('Влияние на выпущенную продукцию', 'impact', ['нет', 'да — нужна замена', 'да — согласование заказчика']),
    chk('Согласовал технолог', 'tech_ok'),
    chk('Утвердил ДпП', 'dpp_ok'),
    sel('Статус', 'status', ['Черновик', 'На согласовании', 'На утверждении ДпП', 'Утверждено', 'Отклонено']),
  ]);

  // --- ТД-библиотека --------------------------------------------------------
  const tdlib = await ensureTable('ТД-библиотека', 'design_td_library', [
    txt('Код', 'code', true),
    txt('Наименование', 'name'),
    sel('Тип', 'td_type', ['РИ', 'Методика расчёта', 'Форма точек контроля', 'Брошюра / каталог', 'Инструкция по сборке', 'Техпроцесс', 'Карта операционного контроля', 'Прочее']),
    txt('Реестр-источник', 'registry'),
    txt('Автор', 'author'),
    txt('NAS-путь', 'nas_path'),
    txt('Версия', 'version'),
    sel('Статус', 'status', ['Черновик', 'Действует', 'На пересмотре', 'Архив']),
    date('Дата актуализации', 'updated'),
  ]);

  // --- Управляющие программы ЧПУ -------------------------------------------
  const ncprog = await ensureTable('Управляющие программы ЧПУ', 'design_nc_programs', [
    txt('№ УП', 'up_no', true),
    txt('Наименование', 'name'),
    txt('Станок', 'machine'),
    txt('Версия', 'version'),
    sel('Статус', 'status', ['Заведена', 'Опробование', 'Утверждена', 'Архив']),
    date('Опробование — дата', 'trial_date'),
    txt('Опробование — кто', 'trial_by'),
    sel('Опробование — результат', 'trial_result', ['годен', 'замечания']),
    txt('NAS-путь', 'nas_path'),
    txt('Файл', 'file'),
    txt('Ссылка на чат', 'chat_url'),
  ]);

  // --- поля в существующие таблицы (прослеживаемость / авторство МК) --------
  const tasks = find('Задачи на участки');
  if (tasks) await ensureColumn(tasks, txt('Применённая редакция КД', 'kd_rev_applied')); // §9.5
  else log('Таблица «Задачи на участки» не найдена — поле прослеживаемости пропущено');

  const routes = find('Маршруты');
  if (routes) {
    await ensureColumn(routes, txt('Проект разработки (децим. №)', 'design_project'));
    await ensureColumn(routes, sel('Статус МК', 'mk_status', ['Черновик', 'Утверждена', 'В производстве']));
  } else log('Таблица «Маршруты» не найдена — поля проекта/статуса МК пропущены');

  // --- связи ---------------------------------------------------------------
  const opTypes = find('Типы операций');
  const operations = find('Операции маршрута');

  await ensureLink(projects, kd, 'Документы КД', 'hm');            // проект → КД
  await ensureLink(kd, kd, 'Состав (входит в)', 'hm');            // КД → КД (дерево, самосвязь)
  await ensureLink(kd, revisions, 'Редакции', 'hm');             // КД → редакции
  await ensureLink(notices, kd, 'Затронутые документы', 'mm');   // извещение ↔ КД
  await ensureLink(tdlib, opTypes, 'Типы операций (дефолт)', 'mm');   // ТД ↔ типы операций (L1)
  await ensureLink(tdlib, operations, 'Операции (переопределение)', 'mm'); // ТД ↔ операции (L2)
  await ensureLink(ncprog, operations, 'Операции', 'mm');        // УП ↔ операции
  await ensureLink(subgroups, projects, 'Проекты подгруппы', 'hm'); // подгруппа → проекты

  console.log('\n✓ Миграция 005 (раздел «Проектирование») применена.');
}

main().catch((e) => { console.error('✗ Ошибка миграции:', e.message); process.exit(1); });
