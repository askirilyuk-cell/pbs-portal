// ============================================================================
//  Печать документов контроля качества (Ф.3/Ф.4/Ф.5): NocoDB → HTML → Gotenberg.
//  Тип определяется по префиксу номера: ВК → Ф.3, ПК → Ф.4, НП → Ф.5.
//  Шапка берётся из записи; детальные таблицы печатаются бланком (header-only).
//
//  Запуск:
//    NC_URL=... NC_TOKEN=... GOTENBERG_URL=http://pbs-gotenberg:3000 \
//      node print/render-control.mjs ВК-2026-001 [out.pdf]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nc from '../nocodb/lib/nocodb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOTENBERG = process.env.GOTENBERG_URL || process.env.GOTENBERG_INTERNAL_URL || 'http://localhost:3001';

const num = process.argv[2];
if (!num) { console.error('Укажите № документа: ВК-2026-001 | ПК-2026-001 | НП-2026-001'); process.exit(1); }
const safe = num.replace(/[\\/:*?"<>|]/g, '_');
const outPath = process.argv[3] || path.join(process.cwd(), `${safe}.pdf`);

const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'nocodb', '.state', 'schema-map.json'), 'utf-8'));
const TID = (key) => map.tables[key].id;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const v = (x) => (x === null || x === undefined || x === '' ? '—' : esc(x));
const chk = (on, label) => `${on ? '☑' : '☐'} ${label}`;
const radio = (val, opts) => opts.map((o) => chk(String(val) === o, o)).join('&nbsp;&nbsp;&nbsp;');
const parseMulti = (val) => Array.isArray(val) ? val : String(val || '').split(',').map((s) => s.trim()).filter(Boolean);

const TYPES = {
  'ВК': { key: 'incoming_control',   field: '№ акта',     tpl: 'control-incoming-template.html',     build: buildIncoming },
  'ПК': { key: 'acceptance_control', field: '№ протокола', tpl: 'control-acceptance-template.html',    build: buildAcceptance },
  'НП': { key: 'nonconformity',      field: '№ акта НП',   tpl: 'control-nonconformity-template.html', build: buildNonconformity },
};

function buildIncoming(r) {
  const docs = parseMulti(r['Документы']);
  const docLine = ['Сертификат качества', 'Паспорт', 'Накладная', 'Иное'].map((d) => chk(docs.includes(d), d)).join('&nbsp;&nbsp;&nbsp;');
  const checks = [
    ['Визуальный осмотр', 'Без видимых дефектов'],
    ['Маркировка', 'Соответствие документам'],
    ['Сертификат качества', 'Наличие и соответствие'],
    ['Измерительный (критич. материалы)', 'Размеры / марка / толщина'],
    ['Срок годности', 'В пределах нормы (для огранич. срока)'],
  ];
  const rows = checks.map(([p, req], i) =>
    `<tr><td class="c">${i + 1}</td><td>${p}</td><td>${req}</td><td></td><td></td><td></td><td></td></tr>`).join('\n');
  return {
    NUM: v(r['№ акта']), DATE: v(r['Дата']),
    SUPPLIER: v(r['Поставщик']), WAYBILL_NO: v(r['Накладная №']), WAYBILL_DATE: v(r['Накладная от']),
    CONTRACT: v(r['Договор / Заказ №']), MAT_NAME: v(r['Наименование материала']), GRADE: v(r['Марка / Сортамент']),
    QTY: r['Кол-во'] != null ? esc(r['Кол-во']) : '—', UNIT: r['Ед. изм.'] ? esc(r['Ед. изм.']) : '',
    MFG_DATE: v(r['Дата изготовления']), EXPIRY: v(r['Срок годности до']),
    DOCS: docLine, CHECK_ROWS: rows,
    VERDICT: radio(r['Заключение'], ['ГОДЕН', 'ГОДЕН С ЗАМЕЧАНИЯМИ', 'НЕ ГОДЕН']),
    OTK: v(r['Контролёр ОТК']), WAREHOUSE: v(r['Представитель склада']), RECEIVER: v(r['Получатель']),
  };
}

function buildAcceptance(r) {
  const rows = Array.from({ length: 8 }, (_, i) =>
    `<tr class="blank"><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`).join('\n');
  return {
    NUM: v(r['№ протокола']), DATE: v(r['Дата']),
    ORDER_NO: v(r['Заказ №']), MK_NO: v(r['МК №']), PRODUCT: v(r['Наименование изделия']), DRAWING: v(r['Чертёж №']),
    QTY: r['Кол-во, шт.'] != null ? esc(r['Кол-во, шт.']) : '—', BATCH: v(r['Партия / серия']),
    APPEARANCE: radio(r['Внешний вид'], ['Соответствует', 'Не соответствует']),
    MARKING: radio(r['Маркировка'], ['Нанесена', 'Не нанесена']),
    COMPLETENESS: radio(r['Комплектность'], ['Полная', 'Неполная']),
    MK_SIGNED: radio(r['МК подписана'], ['Все операции', 'Не все']),
    MEASURE_ROWS: rows,
    VERDICT: radio(r['Заключение'], ['ГОДЕН', 'ГОДЕН С ОТКЛОНЕНИЕМ', 'НЕ ГОДЕН']),
    OTK: v(r['Контролёр ОТК']), DPP: v(r['Директор по производству']),
  };
}

function buildNonconformity(r) {
  return {
    NUM: v(r['№ акта НП']), DATE: v(r['Дата']),
    STAGE: radio(r['Этап обнаружения'], ['Входной контроль', 'Операционный', 'Приёмочный']),
    ORDER_MK: v(r['Заказ № / МК №']), PRODUCT: v(r['Наименование изделия / материала']),
    QTY_NC: r['Кол-во НП'] != null ? esc(r['Кол-во НП']) : '—', FOUND_BY: v(r['Участок / Обнаружил']),
    DESCRIPTION: r['Описание несоответствия'] ? esc(r['Описание несоответствия']) : '',
    CAUSE: v(r['Причина (предварительная)']),
    DECISION: radio(r['Решение'], ['Исправить (доработка)', 'Принять с отклонением', 'Утилизировать', 'Вернуть поставщику']),
    CUSTOMER_APPROVAL: v(r['Согласование заказчика']), DECISION_BY: v(r['Решение принял']), DECISION_DATE: v(r['Дата решения']),
    CORRECTIVE: r['Корректирующее действие (ДП–У.2)'] ? esc(r['Корректирующее действие (ДП–У.2)']) : '',
    DEADLINE: v(r['Срок']), RESPONSIBLE: v(r['Ответственный']),
    CHECK_DATE: v(r['Дата проверки']), CHECK_RESULT: v(r['Результат проверки']),
    EFFECTIVENESS: radio(r['Результативность'], ['Эффективно', 'Требуется доп. действие']),
    COMPILER: v(r['Составил']), DPP: v(r['Согласовал (ДпП)']),
  };
}

async function main() {
  const prefix = String(num).split('-')[0];
  const cfg = TYPES[prefix];
  if (!cfg) throw new Error(`Неизвестный префикс «${prefix}». Ожидается ВК / ПК / НП.`);
  if (!map.tables[cfg.key]) throw new Error(`Таблица «${cfg.key}» не в схеме — запустите npm run schema на NAS.`);

  await nc.signin();
  const rec = (await nc.listRows(TID(cfg.key))).find((x) => String(x[cfg.field]) === num);
  if (!rec) throw new Error(`Документ «${num}» не найден в «${map.tables[cfg.key].title}»`);

  const subst = { ...cfg.build(rec), GENERATED_AT: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  let html = fs.readFileSync(path.join(__dirname, cfg.tpl), 'utf-8');
  for (const [k, val] of Object.entries(subst)) html = html.replaceAll(`{{${k}}}`, val);

  const fd = new FormData();
  fd.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const res = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Gotenberg ${res.status}: ${await res.text()}`);
  const pdf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, pdf);
  console.log(`✓ PDF: ${outPath} (${(pdf.length / 1024).toFixed(0)} КБ, ${map.tables[cfg.key].title}: ${num})`);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
