// ============================================================================
//  Печать «Производственного заказа» (Ф.1–П.2): NocoDB → HTML → Gotenberg → PDF.
//
//  Запуск:
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=<token> \
//    GOTENBERG_URL=http://192.168.1.10:3001 \
//      node print/render-pz.mjs ПЗ-2026-001 [out.pdf]
//
//  Без зависимостей (Node 18+: fetch/FormData/Blob).
//  Внутри docker-сети используйте NOCODB_INTERNAL_URL / GOTENBERG_INTERNAL_URL.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NC_URL = process.env.NC_URL || process.env.NOCODB_INTERNAL_URL || 'http://localhost:8080';
const NC_TOKEN = process.env.NC_TOKEN || '';
const GOTENBERG = process.env.GOTENBERG_URL || process.env.GOTENBERG_INTERNAL_URL || 'http://localhost:3001';

const numPz = process.argv[2];
if (!numPz) { console.error('Укажите № ПЗ, напр.: node print/render-pz.mjs ПЗ-2026-001'); process.exit(1); }
const outPath = process.argv[3] || path.join(process.cwd(), `${numPz}.pdf`);

const mapPath = path.join(__dirname, '..', 'nocodb', '.state', 'schema-map.json');
const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
const ordersTid = map.tables.orders.id;
const positionsTid = map.tables.positions.id;

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

async function main() {
  // 1) заказ (фильтр на клиенте — данных немного)
  const orders = await ncList(ordersTid);
  const o = orders.find((r) => String(r['№ ПЗ']) === numPz);
  if (!o) throw new Error(`ПЗ «${numPz}» не найден`);

  // 2) позиции (демо-ключ: поле «Позиция» начинается с № ПЗ)
  const allPos = await ncList(positionsTid);
  const positions = allPos
    .filter((p) => String(p['Позиция'] || '').startsWith(numPz))
    .sort((a, b) => String(a['№ позиции']).localeCompare(String(b['№ позиции']), 'ru', { numeric: true }));

  const rowsHtml = positions.length
    ? positions.map((p) => `<tr>
        <td class="num">${v(p['№ позиции'])}</td>
        <td>${v(p['Наименование / обозначение'])}</td>
        <td>${v(p['Чертёж / ТУ'])}</td>
        <td class="num">${v(p['Ед.'])}</td>
        <td class="qty">${v(p['Кол-во'])}</td>
        <td class="num">${v(p['Срок готовности'])}</td>
        <td>${v(p['Примечание'])}</td></tr>`).join('\n')
    : `<tr><td colspan="7" class="muted">Позиции не заведены</td></tr>`;

  // 3) шаблон
  let html = fs.readFileSync(path.join(__dirname, 'pz-template.html'), 'utf-8');
  const subst = {
    NUM_PZ: v(o['№ ПЗ']), DATE_PLACED: v(o['Дата размещения']), CUSTOMER: v(o['Заказчик / Инициатор']),
    ORDER_TYPE: v(o['Тип заказа']), PRODUCT_TYPE: v(o['Тип продукции']), PRIORITY: v(o['Приоритет']),
    DATE_PLAN: v(o['Плановый срок']), STATUS: v(o['Статус']), BASIS: v(o['Договор / основание']),
    NUM_ZP: v(o['№ ЗП']), NUM_ZKZ: v(o['№ ЗКЗ']), TERMS: v(o['Условия']),
    APPROVE_ISSUED: v(o['Выдал (менеджер)']), DATE_ISSUED: v(o['Дата выдачи']),
    APPROVE_ACCEPTED: v(o['Принял (ДпП)']), DATE_ACCEPTED: v(o['Дата принятия']),
    APPROVE_APPROVED: v(o['Утвердил (технолог)']), DATE_APPROVED: v(o['Дата утверждения']),
    GENERATED_AT: new Date().toISOString().slice(0, 16).replace('T', ' '),
    POSITIONS: rowsHtml,
  };
  for (const [k, val] of Object.entries(subst)) html = html.replaceAll(`{{${k}}}`, val);

  // 4) Gotenberg
  const fd = new FormData();
  fd.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const res = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Gotenberg ${res.status}: ${await res.text()}`);
  const pdf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, pdf);
  console.log(`✓ PDF: ${outPath} (${(pdf.length / 1024).toFixed(0)} КБ, позиций: ${positions.length})`);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
