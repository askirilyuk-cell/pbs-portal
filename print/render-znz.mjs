// ============================================================================
//  Печать «Заявки на закупку» (ЗнЗ: Ф.1–К/Ф.4–К): NocoDB → HTML → Gotenberg → PDF.
//  K-102 — по образцу render-pz.mjs (тот же контракт: argv[2]=№, argv[3]=out.pdf).
//
//  Запуск:
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=<token> \
//    GOTENBERG_URL=http://192.168.1.10:3001 \
//      node print/render-znz.mjs ЗнЗ-2026-001 [out.pdf]
//
//  Данные: «Заявки ЗнЗ» (procurement_requests) + позиции из «Позиции ЗнЗ»
//  (znz_items; таблицы может не быть до migrate-045 → фолбэк на легаси-поля
//  самой заявки Наименование/Кол-во/Ед.изм./Категория). «Принял в работу» —
//  из оверлея portal/.data/znz-assignee.json (K-102, схему NocoDB не трогаем).
//  Без зависимостей (Node 18+: fetch/FormData/Blob).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NC_URL = process.env.NC_URL || process.env.NOCODB_INTERNAL_URL || 'http://localhost:8080';
const NC_TOKEN = process.env.NC_TOKEN || '';
const GOTENBERG = process.env.GOTENBERG_URL || process.env.GOTENBERG_INTERNAL_URL || 'http://localhost:3001';

const numZnz = process.argv[2];
if (!numZnz) { console.error('Укажите № ЗнЗ, напр.: node print/render-znz.mjs ЗнЗ-2026-001'); process.exit(1); }
const outPath = process.argv[3] || path.join(process.cwd(), `${numZnz}.pdf`);

const mapPath = path.join(__dirname, '..', 'nocodb', '.state', 'schema-map.json');
const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
const reqTid = map.tables.procurement_requests && map.tables.procurement_requests.id;
if (!reqTid) { console.error('В schema-map.json нет таблицы procurement_requests.'); process.exit(1); }
const itemsTid = map.tables.znz_items && map.tables.znz_items.id; // может отсутствовать до migrate-045

function ncHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (NC_TOKEN) h['xc-token'] = NC_TOKEN;
  return h;
}

// Data API v2 по tableId (NocoDB 2026.06)
async function ncList(tableId, query) {
  const url = `${NC_URL}/api/v2/tables/${tableId}/records?limit=1000${query || ''}`;
  const res = await fetch(url, { headers: ncHeaders() });
  if (!res.ok) throw new Error(`NocoDB ${res.status}: ${await res.text()}`);
  return (await res.json()).list || [];
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const v = (x) => (x === null || x === undefined || x === '' ? '—' : esc(x));
// дд.мм.гггг из ISO (не дата — как есть)
const fmtD = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}.${m[2]}.${m[1]}` : String(s || ''); };

async function main() {
  // 1) заявка (фильтр на клиенте — данных немного, как в render-pz)
  const reqs = await ncList(reqTid);
  const r = reqs.find((x) => String(x['№ ЗнЗ']) === numZnz);
  if (!r) throw new Error(`ЗнЗ «${numZnz}» не найдена`);
  const rid = r.Id ?? r.id;

  // 2) позиции: «Позиции ЗнЗ» по денормализ. «ЗнЗ (№)»/«ЗнЗ Id»; таблицы нет/пусто →
  //    легаси-поля самой заявки (1 позиция) — degrade-safe, как везде в модуле закупок
  let items = [];
  if (itemsTid) {
    try {
      const all = await ncList(itemsTid);
      items = all.filter((it) => String(it['ЗнЗ (№)'] || '') === numZnz || String(it['ЗнЗ Id'] || '') === String(rid));
    } catch (e) { console.error('позиции ЗнЗ не прочитаны (фолбэк на поля заявки):', e.message); }
  }
  if (!items.length) {
    items = [{ 'Наименование': r['Наименование'], 'Кол-во': r['Кол-во'], 'Ед.изм.': r['Ед.изм.'], 'Категория': r['Категория'], 'Примечание': '' }];
  }
  const rowsHtml = items.map((it, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${v(it['Наименование'])}</td>
        <td class="qty">${v(it['Кол-во'])}</td>
        <td class="num">${v(it['Ед.изм.'])}</td>
        <td>${v(it['Категория'])}</td>
        <td>${it['Примечание'] ? esc(it['Примечание']) : '<span class="muted">—</span>'}</td></tr>`).join('\n');

  // 3) «Принял в работу» — оверлей K-102 (нет файла/записи → пусто, строка остаётся для ручной подписи)
  let assignee = null;
  try {
    const ov = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'portal', '.data', 'znz-assignee.json'), 'utf-8'));
    assignee = ov && ov[numZnz] ? ov[numZnz] : null;
  } catch { /* оверлея может не быть — норм */ }

  // 4) шаблон
  const type = String(r['Тип'] || '');
  const formCode = /план|Ф\.?1/i.test(type) ? 'Ф.1–К' : 'Ф.4–К';
  let html = fs.readFileSync(path.join(__dirname, 'znz-template.html'), 'utf-8');
  const subst = {
    NUM_ZNZ: v(r['№ ЗнЗ']), FORM_CODE: esc(formCode), DATE_CREATED: v(fmtD(r['Дата'])),
    TYPE: v(type), STATUS: v(r['Статус']), INITIATOR: v(r['Инициатор']), DEPT: v(r['Подразделение-инициатор']),
    URGENCY: v(r['Срочность']), DUE_PLAN: v(fmtD(r['Срок поставки план'])),
    RATIONALE: v(r['Обоснование']), SOURCE_REF: v(r['Триггер-источник (ЗКЗ/ПЗ/склад)']),
    SUPPLIER: v(r['Выбранный поставщик']),
    SIGN_INITIATOR: v(r['Инициатор']),
    SIGN_ASSIGNEE: assignee && assignee.fio ? esc(assignee.fio) : '',
    SIGN_ASSIGNEE_DATE: assignee && assignee.when ? esc(fmtD(assignee.when)) : '',
    GENERATED_AT: new Date().toISOString().slice(0, 16).replace('T', ' '),
    POSITIONS: rowsHtml,
  };
  for (const [k, val] of Object.entries(subst)) html = html.replaceAll(`{{${k}}}`, val);

  // 5) Gotenberg
  const fd = new FormData();
  fd.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const res = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Gotenberg ${res.status}: ${await res.text()}`);
  const pdf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, pdf);
  console.log(`✓ PDF: ${outPath} (${(pdf.length / 1024).toFixed(0)} КБ, позиций: ${items.length})`);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
