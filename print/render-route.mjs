// ============================================================================
//  Печать «Маршрутной карты» (Ф.13–Д.1): NocoDB → HTML → Gotenberg → PDF.
//
//  По № МК собирает: шапку маршрута, входящие компоненты (со всех операций
//  маршрута — прослеживаемость §6.8) и таблицу операций. Для каждой операции
//  резолвит из её Типа операции — наименование, участок, РИ и набор параметров,
//  а № карт Ф.14 — из связанных задач (если уже сгенерированы).
//
//  ВАЖНО (гоча v2): link-эндпоинт отдаёт у связанных записей только Id + display.
//  Полные поля берём из полных списков таблиц (индексы по Id), как в generate-tasks.
//
//  Запуск:
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=<token> \
//    GOTENBERG_URL=http://192.168.1.10:3001 \
//      node print/render-route.mjs МК-КОМ-2026-001 [out.pdf]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nc from '../nocodb/lib/nocodb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOTENBERG = process.env.GOTENBERG_URL || process.env.GOTENBERG_INTERNAL_URL || 'http://localhost:3001';

const numMk = process.argv[2];
if (!numMk) { console.error('Укажите № МК, напр.: node print/render-route.mjs МК-КОМ-2026-001'); process.exit(1); }
const outPath = process.argv[3] || path.join(process.cwd(), `${numMk}.pdf`);

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

// Этап 1 доработки МК: пометка о вложениях операции (ЧПУ-программа / карта наладки).
// Файлы лежат на диске портала (portal/.data/mk-files/<№МК>/op<N>/{nc|setup}) — тот же rw-каталог,
// что пишет server.js. Печать лишь помечает наличие; guard'ится try/catch — отсутствие папки не ломает PDF.
const MK_FILE_ROOT = path.join(__dirname, '..', 'portal', '.data', 'mk-files');
const _mkSafe = (s) => String(s ?? '').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
function opHasFiles(mk, opNum, kind) {
  try {
    const n = String(opNum ?? '').replace(/[^\d]/g, ''); if (!n) return false;
    const dir = path.join(MK_FILE_ROOT, _mkSafe(mk), 'op' + n, kind);
    return fs.readdirSync(dir).some((f) => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; } });
  } catch { return false; }
}

async function indexById(key) {
  const m = new Map();
  for (const r of await nc.listRows(TID(key))) m.set(idOf(r), r);
  return m;
}
async function linkedIds(key, linkTitle, rowId) {
  return (await nc.listLinkedRecords(TID(key), COL(key, linkTitle), rowId)).map(idOf);
}

async function main() {
  await nc.signin();

  // индексы для резолва связанных записей по Id
  const opById = await indexById('operations');
  const opTypeById = await indexById('op_types');
  const sectionById = await indexById('sections');
  const paramById = await indexById('op_params');
  const compById = await indexById('components_in');
  const taskById = await indexById('tasks');

  // 1) маршрут
  const route = (await nc.listRows(TID('routes'))).find((r) => String(r['№ МК']) === numMk);
  if (!route) throw new Error(`Маршрут «${numMk}» не найден`);
  const routeId = idOf(route);
  const type = route['Тип МК'];

  // 2) операции маршрута (по порядку)
  const opIds = await linkedIds('routes', 'Операции маршрута', routeId);
  const ops = opIds.map((id) => opById.get(id)).filter(Boolean)
    .sort((a, b) => (Number(a['№ операции']) || 0) - (Number(b['№ операции']) || 0));

  // 3) строки операций (резолв типа операции → участок/РИ/параметры, задачи → Ф.14)
  const opRows = [];
  const compRows = [];      // входящие компоненты со всех операций (для СБР)
  for (const op of ops) {
    const opId = idOf(op);
    const opTypeId = (await linkedIds('operations', 'Типы операций', opId))[0] || null;
    const ot = opTypeId ? (opTypeById.get(opTypeId) || {}) : {};
    const sectionId = opTypeId ? ((await linkedIds('op_types', 'Участки', opTypeId))[0] || null) : null;
    const sec = sectionId ? (sectionById.get(sectionId) || {}) : {};

    // параметры/режимы — из типа операции
    let params = '—';
    if (opTypeId) {
      const pIds = await linkedIds('op_types', 'Параметры', opTypeId);
      const names = pIds.map((id) => paramById.get(id)).filter(Boolean)
        .map((p) => p['Единица'] ? `${p['Параметр']} (${p['Единица']})` : p['Параметр']);
      if (names.length) params = esc(names.join('; '));
    }

    // № карт задач Ф.14 (если сгенерированы)
    const taskIds = await linkedIds('operations', 'Задачи (по операции)', opId);
    const taskNums = taskIds.map((id) => taskById.get(id)).filter(Boolean).map((t) => t['№ задачи']);

    // контроль + что/СИ/допуски мелким текстом
    const ctlExtra = [op['Что контролировать'], op['СИ'], op['Допуски']].filter(Boolean).join(' · ');
    const ctlCell = `${v(op['Точка контроля'])}${ctlExtra ? `<br><span class="small">${esc(ctlExtra)}</span>` : ''}`;

    const attNc = opHasFiles(numMk, op['№ операции'], 'nc');
    const attSetup = opHasFiles(numMk, op['№ операции'], 'setup');
    const attMark = (attNc || attSetup) ? `<br><span class="small">📎 ${[attNc ? 'ЧПУ-программа' : null, attSetup ? 'карта наладки' : null].filter(Boolean).join(' · ')}</span>` : '';
    opRows.push(`<tr>
      <td class="c">${v(op['№ операции'])}</td>
      <td>${v(ot['Наименование'] || op['Операция'])}${attMark}</td>
      <td class="c">${v(ot['Код типа'])}</td>
      <td>${sec['Код'] ? `${esc(sec['Код'])} ${esc(sec['Участок'] || '')}` : '—'}</td>
      <td>${v(op['Оборудование'])}</td>
      <td>${params}</td>
      <td class="c">${ctlCell}</td>
      <td>${v(ot['РИ'])}</td>
      <td class="c">${v(op['Норма времени (ч)'])}</td>
      <td>${taskNums.length ? esc(taskNums.join(', ')) : ''}</td></tr>`);

    // входящие компоненты этой операции
    const compIds = await linkedIds('operations', 'Входящие компоненты', opId);
    for (const cid of compIds) {
      const c = compById.get(cid);
      if (c) compRows.push(c);
    }
  }

  const componentsHtml = compRows.length
    ? compRows.map((c, i) => `<tr>
        <td class="c">${i + 1}</td>
        <td>${v(c['Компонент'])}</td>
        <td>${v(c['№ ПЗ-источника'])}</td>
        <td class="c">${v(c['Кол-во'])}</td></tr>`).join('\n')
    : `<tr><td colspan="4" class="muted">${type === 'СБР' ? 'Компоненты не заведены' : 'Не заполняется для МК-КОМ'}</td></tr>`;

  const operationsHtml = opRows.length
    ? opRows.join('\n')
    : `<tr><td colspan="10" class="muted">Операции не заведены</td></tr>`;

  // 4) шаблон
  let html = fs.readFileSync(path.join(__dirname, 'route-template.html'), 'utf-8');
  const subst = {
    NUM_MK: v(route['№ МК']),
    KOM_BOX: type === 'КОМ' ? '☑' : '☐',
    SBR_BOX: type === 'СБР' ? '☑' : '☐',
    PRODUCT_TYPE: v(route['Тип продукции']),
    PRODUCT_NAME: v(route['Наименование']),
    DESIGNATION: v(route['Изделие / обозначение']),
    REVISION: v(route['Ревизия']),
    STATUS: v(route['Статус']),
    COMPONENTS: componentsHtml,
    OPERATIONS: operationsHtml,
    GENERATED_AT: new Date().toISOString().slice(0, 16).replace('T', ' '),
  };
  for (const [k, val] of Object.entries(subst)) html = html.replaceAll(`{{${k}}}`, val);

  // 5) Gotenberg
  const fd = new FormData();
  fd.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const res = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Gotenberg ${res.status}: ${await res.text()}`);
  const pdf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, pdf);
  console.log(`✓ PDF: ${outPath} (${(pdf.length / 1024).toFixed(0)} КБ, операций: ${ops.length}, компонентов: ${compRows.length})`);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
