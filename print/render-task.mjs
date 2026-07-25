// ============================================================================
//  Печать «Карты задачи на участок» (Ф.14–Д.1): NocoDB → HTML → Gotenberg → PDF.
//
//  По № задачи собирает все 7 секций. Резолв БЕЗ опоры на обратные bt-колонки:
//   • № ПЗ и № позиции парсятся из «№ задачи» (формат ПЗ-ГГГГ-NNN/ПОЗ-опN);
//   • № МК и № операции — из поля «Операция (№ МК / № оп.)» задачи;
//   • участок/РИ/параметры — проверенным путём операция→тип операции→участок
//     (как в render-route): link-эндпоинт отдаёт Id+display, полные поля из индексов.
//  §7 «Журнал исполнения» печатается пустыми строками под ручное заполнение
//  (в MVP нет поединичного журнала — зафиксированный пробел vs утверждённой Ф.14).
//
//  Запуск:
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=<token> \
//    GOTENBERG_URL=http://192.168.1.10:3001 \
//      node print/render-task.mjs "ПЗ-2026-001/1.0-оп1" [out.pdf]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nc from '../nocodb/lib/nocodb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOTENBERG = process.env.GOTENBERG_URL || process.env.GOTENBERG_INTERNAL_URL || 'http://localhost:3001';

const numTask = process.argv[2];
if (!numTask) { console.error('Укажите № задачи, напр.: node print/render-task.mjs "ПЗ-2026-001/1.0-оп1"'); process.exit(1); }
const safeName = numTask.replace(/[\\/:*?"<>|]/g, '_');
const outPath = process.argv[3] || path.join(process.cwd(), `${safeName}.pdf`);

const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'nocodb', '.state', 'schema-map.json'), 'utf-8'));
const TID = (key) => map.tables[key].id;
const COL = (key, title) => {
  const id = map.tables[key].columns[title];
  if (!id) throw new Error(`Нет колонки «${title}» в «${map.tables[key].title}» — пересоберите схему (npm run schema)`);
  return id;
};
const idOf = (r) => r.Id ?? r.id;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const v = (x) => (x === null || x === undefined || x === '' ? '—' : esc(x));

async function indexBy(key, field) {
  const m = new Map();
  for (const r of await nc.listRows(TID(key))) m.set(field === '__id' ? idOf(r) : r[field], r);
  return m;
}
async function linkedIds(key, linkTitle, rowId) {
  return (await nc.listLinkedRecords(TID(key), COL(key, linkTitle), rowId)).map(idOf);
}

async function main() {
  await nc.signin();

  // 1) задача
  const task = (await nc.listRows(TID('tasks'))).find((t) => String(t['№ задачи']) === numTask);
  if (!task) throw new Error(`Задача «${numTask}» не найдена`);
  const taskId = idOf(task);

  // парсинг ключей из номеров (без обращения к bt-колонкам)
  const numPz = String(numTask).split('/')[0];                 // «ПЗ-2026-001»
  const posPart = String(numTask).slice(numPz.length + 1);     // «1.0-оп1»
  const posNum = posPart.split('-оп')[0];                      // «1.0»
  const opLabel = String(task['Операция (№ МК / № оп.)'] || ''); // «МК-КОМ-2026-001 оп.1»
  const numMk = opLabel.split(' оп.')[0] || '';

  // индексы
  const orderByPz = await indexBy('orders', '№ ПЗ');
  const routeByMk = await indexBy('routes', '№ МК');
  const opTypeById = await indexBy('op_types', '__id');
  const sectionById = await indexBy('sections', '__id');
  const paramById = await indexBy('op_params', '__id');
  const pvById = await indexBy('task_param_values', '__id');
  const compById = await indexBy('components_in', '__id');

  const order = orderByPz.get(numPz) || {};
  const route = routeByMk.get(numMk) || {};

  // позиция: ключевое поле «Позиция» начинается с № ПЗ + совпадает № позиции
  const position = (await nc.listRows(TID('positions'))).find(
    (p) => String(p['Позиция'] || '').startsWith(numPz) && String(p['№ позиции']) === posNum) || {};

  // операция: совпадение по полю «Операция» (= «МК оп.N»)
  const operation = (await nc.listRows(TID('operations'))).find(
    (o) => String(o['Операция']) === opLabel.trim()) || {};
  const opId = idOf(operation);

  // тип операции → участок / РИ / параметры (проверенный путь)
  let opType = {}, section = {}, opTypeParams = [];
  if (opId != null) {
    const otId = (await linkedIds('operations', 'Типы операций', opId))[0] || null;
    if (otId != null) {
      opType = opTypeById.get(otId) || {};
      const secId = (await linkedIds('op_types', 'Участки', otId))[0] || null;
      if (secId != null) section = sectionById.get(secId) || {};
      const pIds = await linkedIds('op_types', 'Параметры', otId);
      opTypeParams = pIds.map((id) => paramById.get(id)).filter(Boolean);
    }
  }

  // §4 материалы: компоненты операции + свободный текст «Входящие материалы»
  const compRows = [];
  if (opId != null) {
    for (const cid of await linkedIds('operations', 'Входящие компоненты', opId)) {
      const c = compById.get(cid); if (c) compRows.push(c);
    }
  }
  const matRows = [];
  for (const c of compRows) {
    matRows.push(`<tr><td>${v(c['Компонент'])}</td><td class="c">${v(c['Кол-во'])}</td><td></td><td>${v(c['№ ПЗ-источника'])}</td></tr>`);
  }
  const freeMat = task['Входящие материалы'] || operation['Входящие материалы'] || '';
  if (freeMat) matRows.push(`<tr><td colspan="4">${esc(freeMat)}</td></tr>`);
  while (matRows.length < 3) matRows.push('<tr class="blank"><td></td><td></td><td></td><td></td></tr>');
  const materialsHtml = matRows.join('\n');

  // §5 точки контроля: точка операции (если есть) + пустая строка
  const ctlRows = [];
  if (operation['Точка контроля'] && operation['Точка контроля'] !== 'нет') {
    ctlRows.push(`<tr>
      <td class="c">1</td>
      <td>${v(operation['Что контролировать'])}</td>
      <td>${v(operation['Допуски'])}</td>
      <td>${v(operation['СИ'])}</td>
      <td class="c">${v(operation['Точка контроля'])}</td></tr>`);
  }
  ctlRows.push('<tr class="blank"><td></td><td></td><td></td><td></td><td></td></tr>');
  const controlHtml = ctlRows.join('\n');

  // §6 параметры: значения параметров задачи (если есть), иначе набор из типа операции
  const pvIds = await linkedIds('tasks', 'Значения параметров', taskId);
  let paramRows = pvIds.map((id) => pvById.get(id)).filter(Boolean)
    .map((p) => `<tr><td>${v(p['Параметр'])}</td><td class="c">${v(p['Единица'])}</td><td>${p['Значение'] ? esc(p['Значение']) : ''}</td></tr>`);
  if (!paramRows.length) {
    paramRows = opTypeParams.map((p) => `<tr><td>${v(p['Параметр'])}</td><td class="c">${v(p['Единица'])}</td><td></td></tr>`);
  }
  if (!paramRows.length) paramRows = ['<tr class="blank"><td></td><td></td><td></td></tr>'];
  const paramsHtml = paramRows.join('\n');

  // §7 журнал исполнения по единицам — из таблицы «Журнал исполнения» (создана
  // миграцией 002, в schema-map её нет → резолвим tableId по meta). Заполненные
  // единицы печатаются с данными, недостающие до кол-ва задания — пустыми.
  const qty = Number(position['Кол-во']) || 0;
  let journalRows = [];
  try {
    const jbase = await nc.getBaseByTitle('Производство ПБС');
    const jtbl = (await nc.listTables(jbase.id)).find((t) => t.title === 'Журнал исполнения');
    if (jtbl) journalRows = (await nc.listRows(jtbl.id)).filter((j) => String(j['№ задачи']) === numTask);
  } catch { /* таблицы может не быть — печатаем пустой журнал */ }
  const jByUnit = new Map(journalRows.map((j) => [Number(j['№ единицы']), j]));
  const jc = (x) => (x === null || x === undefined || x === '' ? '' : esc(x));
  const nRows = Math.min(Math.max(qty, journalRows.length, 4), 12);
  const journalHtml = Array.from({ length: nRows }, (_, i) => {
    const u = i + 1; const j = jByUnit.get(u) || {};
    return `<tr><td class="c">${u}</td><td>${jc(j['Исполнитель'])}</td><td>${jc(j['№ заготовки / приёмки'])}</td><td class="c">${jc(j['Самоконтроль'])}</td><td class="c">${jc(j['Контроль ОТК'])}</td><td class="c">${jc(j['Дата'])}</td></tr>`;
  }).join('\n');

  // шаблон
  let html = fs.readFileSync(path.join(__dirname, 'task-template.html'), 'utf-8');
  const subst = {
    NUM_TASK: v(task['№ задачи']),
    NUM_PZ: v(numPz),
    DATE_DUE: v(task['Дата плановая'] || position['Срок готовности'] || order['Плановый срок']),
    QTY: qty ? String(qty) : '—',
    PART_NAME: v(position['Наименование / обозначение'] || route['Наименование']),
    DESIGNATION: v(route['Изделие / обозначение'] || position['Чертёж / ТУ']),
    DRAWING: v(position['Чертёж / ТУ']),
    APPLICABILITY: v(route['Тип продукции']),
    NUM_MK: v(numMk || route['№ МК']),
    OP_NUM: v(operation['№ операции']),
    OP_TYPE: opType['Код типа'] ? `${esc(opType['Код типа'])} ${esc(opType['Наименование'] || '')}` : '—',
    SECTION: section['Код'] ? `${esc(section['Код'])} ${esc(section['Участок'] || '')}` : '—',
    EQUIPMENT: v(task['Оборудование'] || operation['Оборудование']),
    RI: v(opType['РИ']),
    MATERIALS: materialsHtml,
    CONTROL_POINTS: controlHtml,
    PARAMS: paramsHtml,
    JOURNAL: journalHtml,
    GENERATED_AT: new Date().toISOString().slice(0, 16).replace('T', ' '),
  };
  for (const [k, val] of Object.entries(subst)) html = html.replaceAll(`{{${k}}}`, val);

  // Gotenberg
  const fd = new FormData();
  fd.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const res = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Gotenberg ${res.status}: ${await res.text()}`);
  const pdf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, pdf);
  console.log(`✓ PDF: ${outPath} (${(pdf.length / 1024).toFixed(0)} КБ, операция: ${numMk} оп.${operation['№ операции'] ?? '?'}, параметров: ${paramRows.length})`);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
