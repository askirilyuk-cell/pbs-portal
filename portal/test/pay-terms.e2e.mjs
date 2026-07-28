// ============================================================================
//  D-1 (условия платежа поставщику) — воспроизводимый разрушающий стенд.
//
//  ЗАЧЕМ. Карточку D-1 завернул QA: критерии 1 и 2 нарушены, все три решения,
//  принятые сверх постановки, сломались на первом же разрушающем сценарии.
//  Общий корень — ВНЕШНЕМУ ПОЛЮ ДОВЕРЯЛИ БЕЗУСЛОВНО: ответ платёжного портала
//  писался в наши колонки без сверки с тем, что уже лежит, и без валидации.
//  Чтобы правка не проверялась «рассуждением», здесь поднимается настоящий
//  portal/server.js и гоняется через настоящие HTTP-эндпойнты.
//
//  ЧТО ПОДНИМАЕТСЯ (всё локально, боевая база НЕ трогается):
//    • заглушка NocoDB   — meta v1 (/api/v1/db/meta/…) + data v2 (/api/v2/tables/…);
//    • заглушка платёжного портала — /api/v1/ingest/payments (POST/GET);
//    • заглушка Bitrix   — user.get (нужен initiatorEmail, §2 контракта);
//    • сам portal/server.js как дочерний процесс с NC_URL/PAYMENT_API_BASE,
//      направленными на заглушки.
//
//  ПОЧЕМУ ЗАГЛУШКА NocoDB ВЕДЁТ СЕБЯ ИМЕННО ТАК (это часть проверки):
//    • неизвестное поле в PATCH — МОЛЧА игнорируется (реальное поведение NocoDB;
//      ровно поэтому слепая запись без сверки схемы = тихая потеря);
//    • Date-колонка отвергает значение не вида ГГГГ-ММ-ДД → 422 на ВЕСЬ PATCH
//      (так «15.08.2026» из ответа портала уносил вместе с собой тип и процент);
//    • Date-колонка ПРИНИМАЕТ календарно неверную ISO-дату (2026-02-29,
//      9999-12-31) — так было на стенде QA. Стенд намеренно снисходителен:
//      значит, от мусора защищает НАША валидация, а не тип колонки;
//    • SingleSelect отвергает значение вне своего словаря → 422 на весь PATCH.
//
//  Контракта платёжного портала в репозитории нет (docs/INTEGRATION_ISM.md
//  отсутствует), поэтому заглушка умеет ВСЕ три варианта его поведения: дату не
//  возвращает, возвращает нашу, возвращает чужую/мусорную. Правка обязана быть
//  верной во всех трёх.
//
//  Запуск:  node portal/test/pay-terms.e2e.mjs
//  Код возврата 0 — все проверки прошли, 1 — есть падения.
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, '..', 'server.js');

// ── состояние заглушек (тесты его крутят между сценариями) ───────────────────
const TBL = { 'Счета-К': 'tblInv', 'Заявки ЗнЗ': 'tblZnz' };

// колонки условий платежа в том виде, в каком их создаёт migrate-048
const TERM_COLS = () => ([
  { title: 'Ожидаемая дата оплаты', uidt: 'Date' },
  { title: 'Тип оплаты', uidt: 'SingleSelect', colOptions: { options: [{ title: 'Предоплата' }, { title: 'Постоплата' }] } },
  { title: 'Процент аванса', uidt: 'Decimal' },
  { title: 'Срок оплаты (портал)', uidt: 'Date' },
]);

const BASE_INV_COLS = () => ([
  { title: 'Id', uidt: 'ID' }, { title: '№ счёта', uidt: 'SingleLineText' },
  { title: 'Поставщик', uidt: 'SingleLineText' }, { title: 'Сумма, ₽', uidt: 'Decimal' },
  { title: 'ЗнЗ Id', uidt: 'Number' }, { title: 'Статус оплаты', uidt: 'SingleSelect', colOptions: { options: ['Черновик', 'На согласовании', 'Ожидает оплаты', 'Оплачено', 'Отклонено'].map((t) => ({ title: t })) } },
  { title: 'Оплата ExternalRef', uidt: 'SingleLineText' }, { title: 'Оплата ID', uidt: 'SingleLineText' },
  { title: 'Оплата обновлена', uidt: 'SingleLineText' }, { title: 'Дата счёта', uidt: 'Date' },
]);

const S = {
  metaDown: false,        // D-6: meta-API недоступен
  ncWriteDown: false,     // критерий 4: запись к нам падает целиком
  columns: {},            // tid → колонки
  rows: {},               // tid → строки
  portal: { echoDate: null, mode: 'ok', calls: [] }, // mode: ok|down|error
};

function resetDb({ termCols = true, invTypeCol = null } = {}) {
  const inv = BASE_INV_COLS();
  const znz = [{ title: 'Id', uidt: 'ID' }, { title: '№ ЗнЗ', uidt: 'SingleLineText' },
    { title: 'Оплата Id', uidt: 'SingleLineText' }, { title: 'Оплата статус', uidt: 'SingleLineText' },
    { title: 'Оплата ExternalRef', uidt: 'SingleLineText' }, { title: 'Оплата сумма', uidt: 'Decimal' },
    { title: 'Оплата обновлено', uidt: 'SingleLineText' }];
  if (termCols) {
    for (const c of TERM_COLS()) {
      // invTypeCol — подмена «Тип оплаты» колонкой с ЧУЖИМ словарём (D-4, вторая половина)
      if (c.title === 'Тип оплаты' && invTypeCol) { inv.push(invTypeCol); continue; }
      inv.push(c);
    }
    znz.push(...TERM_COLS());
  }
  S.columns = { tblInv: inv, tblZnz: znz };
  S.rows = {
    tblInv: [{ Id: 1, '№ счёта': 'СЧ-1', 'Поставщик': 'ООО Ромашка', 'Сумма, ₽': 100000, 'ЗнЗ Id': 7, 'Статус оплаты': 'Черновик' }],
    tblZnz: [{ Id: 7, '№ ЗнЗ': 'ЗнЗ-0007' }],
  };
  S.metaDown = false; S.ncWriteDown = false;
  S.portal = { echoDate: null, mode: 'ok', calls: [] };
}

const colOf = (tid, title) => (S.columns[tid] || []).find((c) => c.title === title) || null;

// Эмуляция записи NocoDB: неизвестные поля молча игнорируются, Date/SingleSelect
// проверяются — негодное значение роняет ВЕСЬ PATCH (422), как в реальной базе.
function applyPatch(tid, rec) {
  const row = (S.rows[tid] || []).find((r) => String(r.Id) === String(rec.Id));
  if (!row) return { code: 404, body: { msg: 'row not found' } };
  const staged = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'Id') continue;
    const col = colOf(tid, k);
    if (!col) continue;                                   // NocoDB: неизвестное поле — молча мимо
    if (v != null && col.uidt === 'Date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v)))
      return { code: 422, body: { msg: `Invalid date value «${v}» for column «${k}»` } };
    if (v != null && col.uidt === 'SingleSelect') {
      const opts = ((col.colOptions || {}).options || []).map((o) => o.title);
      if (!opts.includes(String(v))) return { code: 422, body: { msg: `Invalid option «${v}» for column «${k}»` } };
    }
    staged[k] = v;
  }
  Object.assign(row, staged);
  return { code: 200, body: [{ Id: row.Id }] };
}

// ── заглушки (NocoDB + платёжный портал + Bitrix) на одном порту ─────────────
function stubServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    let body = '';
    for await (const ch of req) body += ch;
    const json = () => { try { return body ? JSON.parse(body) : null; } catch { return null; } };

    // --- NocoDB meta v1 ---
    if (p === '/api/v1/db/meta/projects') {
      if (S.metaDown) return send(503, { msg: 'meta down' });
      return send(200, { list: [{ id: 'p1', title: 'Производство ПБС' }] });
    }
    if (p === '/api/v1/db/meta/projects/p1/tables') {
      if (S.metaDown) return send(503, { msg: 'meta down' });
      return send(200, { list: Object.entries(TBL).map(([title, id]) => ({ id, title })) });
    }
    let m = /^\/api\/v1\/db\/meta\/tables\/([^/]+)$/.exec(p);
    if (m) {
      if (S.metaDown) return send(503, { msg: 'meta down' });
      return send(200, { id: m[1], columns: S.columns[m[1]] || [] });
    }
    m = /^\/api\/v1\/db\/meta\/tables\/([^/]+)\/columns$/.exec(p);
    if (m && req.method === 'POST') {
      if (S.metaDown) return send(503, { msg: 'meta down' });
      (S.columns[m[1]] = S.columns[m[1]] || []).push(json());
      return send(200, { ok: true });
    }
    // --- NocoDB data v2 ---
    m = /^\/api\/v2\/tables\/([^/]+)\/records$/.exec(p);
    if (m) {
      const tid = m[1];
      if (req.method === 'GET') return send(200, { list: S.rows[tid] || [] });
      if (req.method === 'PATCH') {
        if (S.ncWriteDown) return send(500, { msg: 'NocoDB запись недоступна' });
        const recs = json() || [];
        const out = [];
        for (const rec of recs) { const r = applyPatch(tid, rec); if (r.code !== 200) return send(r.code, r.body); out.push(...r.body); }
        return send(200, out);
      }
    }
    // --- платёжный портал (ingest-API) ---
    if (p.startsWith('/api/v1/ingest/')) {
      if (S.portal.mode === 'down') { res.destroy(); return; }
      if (S.portal.mode === 'error') return send(502, { error: 'payment portal 502' });
      const sub = p.slice('/api/v1/ingest/'.length);
      if (sub === 'reference') return send(200, { legalEntities: [{ id: 4, name: 'ПБС' }], departments: [{ id: 1, legalEntityId: 4, name: 'Снабжение' }], projects: [] });
      if (sub === 'payments' && req.method === 'POST') {
        const b = json() || {};
        S.portal.calls.push({ kind: 'create', payload: b });
        const payment = { id: 'PAY-1', status: 'PENDING_APPROVAL', externalRef: b.externalRef, amount: b.amount };
        if (S.portal.echoDate !== null) payment.expectedPaymentDate = S.portal.echoDate;
        return send(201, { payment });
      }
      if (sub === 'payments' && req.method === 'GET') {
        S.portal.calls.push({ kind: 'status', ref: u.searchParams.get('externalRef') });
        const payment = { id: 'PAY-1', status: 'PENDING_APPROVAL', externalRef: u.searchParams.get('externalRef'), amount: 100000 };
        if (S.portal.echoDate !== null) payment.expectedPaymentDate = S.portal.echoDate;
        return send(200, { payments: [payment] });
      }
      return send(404, { error: 'no such ingest path' });
    }
    // --- Bitrix (user.get → initiatorEmail) ---
    if (p === '/bx/user.get.json') return send(200, { result: [{ ID: '11', EMAIL: 'snab@pbs.local' }] });
    if (p.startsWith('/bx/')) return send(200, { result: [] });
    return send(404, { error: 'stub: ' + p });
  });
}

// ── запуск настоящего portal/server.js поверх заглушек ──────────────────────
const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));

// server.js импортирует ТОЛЬКО node:*-модули, поэтому его можно запустить копией во
// временной папке. Делаем это намеренно: рядом с боевым portal/server.js лежит
// portal/.runtime.json оператора (он старше env и мог бы утащить тест на РЕАЛЬНУЮ базу
// NocoDB и РЕАЛЬНЫЙ платёжный портал). В temp-копии runtime-файла нет — конфиг задаём
// только через env, и уехать в прод физически некуда. Заодно сюда же уходит
// .sessions.local.json, а не в рабочее дерево.
function isolatedServerCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbs-payterms-'));
  const file = path.join(dir, 'server.js');
  fs.copyFileSync(SERVER_JS, file);
  // ADMIN_BYPASS_TOKEN сервер берёт ТОЛЬКО из runtime-файла (ensureAuthRuntime сам
  // допишет случайный, если файла нет) — кладём свой заранее, иначе сессию не получить.
  fs.writeFileSync(path.join(dir, '.runtime.json'), JSON.stringify({ ADMIN_BYPASS_TOKEN: 'e2e' }));
  return { dir, file };
}

async function startPortal(serverFile, stubPort, port) {
  const child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      PORT: String(port),
      NC_URL: `http://127.0.0.1:${stubPort}`,
      NC_TOKEN: 'test-token',                      // включает LIVE-режим
      PAYMENT_API_BASE: `http://127.0.0.1:${stubPort}`,
      PAYMENT_INGEST_KEY: 'pin_test',
      PAYMENT_LEGAL_ENTITY_ID: '4',
      BITRIX_WEBHOOK: `http://127.0.0.1:${stubPort}/bx`,
      ADMIN_BYPASS_TOKEN: 'e2e',
      RBAC_ENFORCE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return { child, logs };
}

// ── migrate-048 поверх той же заглушки NocoDB ───────────────────────────────
// Критерий 5 («повторная миграция дублей не создаёт») проверяется прогоном
// НАСТОЯЩЕГО скрипта миграции, а не чтением его исходника.
const MIGRATION = path.join(__dirname, '..', '..', 'nocodb', 'schema', 'migrate-048-payment-terms.mjs');
const PAY_TERM_TITLES = ['Ожидаемая дата оплаты', 'Тип оплаты', 'Процент аванса', 'Срок оплаты (портал)'];

function runMigration(stubPort, { apply }) {
  return new Promise((done) => {
    const ch = spawn(process.execPath, [MIGRATION], {
      env: {
        ...process.env,
        NC_URL: `http://127.0.0.1:${stubPort}`, NC_TOKEN: 'test-token',
        ...(apply ? { DRY_RUN: '0', APPLY_CONFIRM: 'YES' } : { DRY_RUN: '1', APPLY_CONFIRM: '' }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    ch.on('close', (code) => done({ code, out }));
  });
}

// ── мини-раннер ─────────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { PASS++; results.push(`  ✔ ${name}`); }
  else { FAIL++; results.push(`  ✘ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function group(title) { results.push(`\n${title}`); }

const inv = () => S.rows.tblInv[0];
const znz = () => S.rows.tblZnz[0];

async function main() {
  const stub = stubServer();
  const stubPort = await listen(stub);
  const portalPort = 4100 + Math.floor(Math.random() * 400);
  resetDb();
  const iso = isolatedServerCopy();
  const { child, logs } = await startPortal(iso.file, stubPort, portalPort);
  const B = `http://127.0.0.1:${portalPort}`;

  // сессия админ-обхода (нужна для initiatorEmail через Bitrix-заглушку)
  const auth = await fetch(`${B}/auth/admin?token=e2e`, { redirect: 'manual' });
  const cookie = String(auth.headers.get('set-cookie') || '').split(';')[0];
  if (!/pbs_sid=\w/.test(cookie)) throw new Error('Стенд не смог получить сессию админ-обхода: ' + cookie);
  const H = { 'Content-Type': 'application/json', Cookie: cookie };

  const pay = (body) => fetch(`${B}/api/purchase/pay`, { method: 'POST', headers: H, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));
  const refresh1 = (invoiceId) => fetch(`${B}/api/purchase/pay-status?znzId=7${invoiceId ? `&invoiceId=${invoiceId}` : ''}`, { headers: H })
    .then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));
  const refreshAll = () => fetch(`${B}/api/procurement/pay/refresh-all`, { method: 'POST', headers: H, body: '{}' })
    .then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

  const POST = (over = {}) => ({ znzId: 7, invoiceId: 1, departmentId: 1, amount: 100000, paymentType: 'POSTOPLATA', expectedPaymentDate: '2026-08-15', counterparty: { name: 'ООО Ромашка' }, ...over });
  const AVANS = (over = {}) => ({ znzId: 7, invoiceId: 1, departmentId: 1, amount: 100000, paymentType: 'AVANS', avansPercent: 30, counterparty: { name: 'ООО Ромашка' }, ...over });

  try {
    // ─────────────────────────────────────────────────────────────────────────
    group('Критерий 1 / D-2 — постоплата: у нас та дата, что УШЛА НАРУЖУ');
    resetDb(); S.portal.echoDate = '2026-09-30';           // портал возвращает ЧУЖУЮ дату
    let r = await pay(POST());
    check('платёж создан', r.status === 200 && r.j.ok, JSON.stringify(r.j));
    check('в payload ушло 2026-08-15', S.portal.calls[0]?.payload?.expectedPaymentDate === '2026-08-15');
    check('в базе 2026-08-15 (а не 2026-09-30 от портала)', inv()['Ожидаемая дата оплаты'] === '2026-08-15', `в базе: ${inv()['Ожидаемая дата оплаты']}`);
    check('расхождение с порталом не проглочено', /2026-09-30/.test(String(r.j.saveWarning || '')) || inv()['Срок оплаты (портал)'] === '2026-09-30',
      `saveWarning=${r.j.saveWarning} portal=${inv()['Срок оплаты (портал)']}`);
    check('тип «Постоплата»', inv()['Тип оплаты'] === 'Постоплата');
    check('процент аванса погашен', inv()['Процент аванса'] == null);

    resetDb(); S.portal.echoDate = '2020-01-01';           // дата из прошлого
    r = await pay(POST());
    check('дата из прошлого от портала не принята', inv()['Ожидаемая дата оплаты'] === '2026-08-15', `в базе: ${inv()['Ожидаемая дата оплаты']}`);

    // ─────────────────────────────────────────────────────────────────────────
    group('Критерий 2 / D-3 — предоплата: дата ПУСТА при любом ответе портала');
    for (const echo of ['2026-09-30', '2026-08-15', null]) {
      resetDb(); S.portal.echoDate = echo;
      r = await pay(AVANS());
      check(`создание, эхо=${echo}: дата пуста`, !inv()['Ожидаемая дата оплаты'], `в базе: ${inv()['Ожидаемая дата оплаты']}`);
      check(`создание, эхо=${echo}: процент 30`, Number(inv()['Процент аванса']) === 30);
      check(`создание, эхо=${echo}: тип «Предоплата»`, inv()['Тип оплаты'] === 'Предоплата');
      // и она обязана остаться пустой после опроса статуса
      await refresh1(1);
      check(`опрос, эхо=${echo}: дата всё ещё пуста`, !inv()['Ожидаемая дата оплаты'], `в базе: ${inv()['Ожидаемая дата оплаты']}`);
      const ra = await refreshAll();
      check(`массовый опрос, эхо=${echo}: дата всё ещё пуста`, !inv()['Ожидаемая дата оплаты'], `в базе: ${inv()['Ожидаемая дата оплаты']}`);
      void ra;
    }

    // ─────────────────────────────────────────────────────────────────────────
    group('Критерий 7 / D-1 — дата, поправленная человеком, переживает опросы');
    // сценарий QA: отправили срок 15.08 → человек перенёс его с поставщиком на 20.08
    // → нажал «Обновить статус» → в базе снова 15.08.
    resetDb(); S.portal.echoDate = '2026-08-15';
    await pay(POST());
    inv()['Ожидаемая дата оплаты'] = '2026-08-20';
    let r1 = await refresh1(1);
    check('одиночный опрос: дата человека цела', inv()['Ожидаемая дата оплаты'] === '2026-08-20', `в базе: ${inv()['Ожидаемая дата оплаты']}`);
    check('одиночный опрос: расхождение НЕ проглочено', !!(r1.j.saveWarning || r1.j.warning), JSON.stringify(r1.j));
    check('дата портала сохранена отдельно', inv()['Срок оплаты (портал)'] === '2026-08-15', `portal=${inv()['Срок оплаты (портал)']}`);
    // тот же сценарий, но расхождение ОБНАРУЖИВАЕТ массовый «⟳ Статусы оплат»
    resetDb(); S.portal.echoDate = '2026-08-15';
    await pay(POST());
    inv()['Ожидаемая дата оплаты'] = '2026-08-20';
    let ra = await refreshAll();
    check('массовый опрос: дата человека цела', inv()['Ожидаемая дата оплаты'] === '2026-08-20', `в базе: ${inv()['Ожидаемая дата оплаты']}`);
    check('массовый опрос: расхождение видно в ответе', (ra.j.warnings || 0) > 0 && (ra.j.warningList || []).length > 0, JSON.stringify(ra.j));
    check('массовый опрос: предупреждение подписано номером счёта', /СЧ-1/.test(String((ra.j.warningList || [])[0] || '')), JSON.stringify(ra.j.warningList));
    // Повторные опросы про ТО ЖЕ САМОЕ расхождение молчат намеренно: оно уже записано
    // в «Срок оплаты (портал)» и видно в карточке счёта. Иначе каждый массовый опрос
    // сотни счетов выдавал бы сотню одинаковых предупреждений и их перестали бы читать.
    ra = await refreshAll();
    check('повтор того же расхождения не шумит', (ra.j.warnings || 0) === 0, JSON.stringify(ra.j));
    // а вот НОВОЕ расхождение обязано прозвучать снова
    S.portal.echoDate = '2026-09-01';
    ra = await refreshAll();
    check('новое расхождение звучит снова', (ra.j.warnings || 0) > 0, JSON.stringify(ra.j));
    check('в отдельной колонке — новая дата портала', inv()['Срок оплаты (портал)'] === '2026-09-01', `portal=${inv()['Срок оплаты (портал)']}`);
    S.portal.echoDate = '2026-08-15';
    for (let i = 0; i < 5; i++) await refreshAll();
    check('пять опросов подряд: дата человека цела', inv()['Ожидаемая дата оплаты'] === '2026-08-20', `в базе: ${inv()['Ожидаемая дата оплаты']}`);
    // портал «догнал» наш срок → отметка о расхождении снимается сама
    S.portal.echoDate = '2026-08-20';
    await refreshAll();
    check('расхождение исчезло — отметка снята', !inv()['Срок оплаты (портал)'], `portal=${inv()['Срок оплаты (портал)']}`);
    check('наш срок при этом не тронут', inv()['Ожидаемая дата оплаты'] === '2026-08-20', `в базе: ${inv()['Ожидаемая дата оплаты']}`);

    // ─────────────────────────────────────────────────────────────────────────
    group('Критерий 9 / D-5 — календарно неверная дата не попадает в базу');
    for (const bad of ['2026-02-29', '9999-12-31', '1900-01-01', '2026-13-01', '15.08.2026', 'вчера']) {
      resetDb();
      r = await pay(POST({ expectedPaymentDate: bad }));
      check(`тело запроса «${bad}» отвергнуто (400)`, r.status === 400, `status=${r.status} ${JSON.stringify(r.j)}`);
      check(`тело запроса «${bad}»: наружу ничего не ушло`, S.portal.calls.length === 0);
      check(`тело запроса «${bad}»: в базе пусто`, !inv()['Ожидаемая дата оплаты']);
    }
    for (const bad of ['2026-02-29', '9999-12-31', '1900-01-01', '15.08.2026']) {
      resetDb(); S.portal.echoDate = null;
      await pay(POST());                                   // корректная постоплата 2026-08-15
      inv()['Ожидаемая дата оплаты'] = null;               // имитируем пустой срок у нас
      S.portal.echoDate = bad;
      const rr = await refresh1(1);
      check(`ответ портала «${bad}» не записан`, !inv()['Ожидаемая дата оплаты'], `в базе: ${inv()['Ожидаемая дата оплаты']}`);
      check(`ответ портала «${bad}»: сказано вслух`, !!(rr.j.saveWarning || rr.j.warning), JSON.stringify(rr.j));
    }

    // ─────────────────────────────────────────────────────────────────────────
    group('Критерий 8 / D-4 — одно негодное значение не уносит остальные');
    resetDb(); S.portal.echoDate = '15.08.2026';           // мусор для Date-колонки
    r = await pay(POST());
    check('платёж создан', r.status === 200 && r.j.ok);
    check('тип оплаты сохранён', inv()['Тип оплаты'] === 'Постоплата', `тип: ${inv()['Тип оплаты']}`);
    check('наша дата сохранена', inv()['Ожидаемая дата оплаты'] === '2026-08-15', `дата: ${inv()['Ожидаемая дата оплаты']}`);
    check('мусор портала не записан', inv()['Срок оплаты (портал)'] == null, `portal: ${inv()['Срок оплаты (портал)']}`);
    check('о мусоре сказано вслух', /15\.08\.2026/.test(String(r.j.saveWarning || '')), `saveWarning=${r.j.saveWarning}`);

    // «Тип оплаты» уже существует SingleSelect-ом с ЧУЖИМ словарём
    resetDb({ invTypeCol: { title: 'Тип оплаты', uidt: 'SingleSelect', colOptions: { options: [{ title: 'Аванс' }, { title: 'Отсрочка' }] } } });
    S.portal.echoDate = null;
    r = await pay(POST());
    check('чужой словарь: дата всё равно сохранена', inv()['Ожидаемая дата оплаты'] === '2026-08-15', `дата: ${inv()['Ожидаемая дата оплаты']}`);
    check('чужой словарь: тип НЕ записан', inv()['Тип оплаты'] == null, `тип: ${inv()['Тип оплаты']}`);
    check('чужой словарь: сказано вслух', /словар|Тип оплаты/i.test(String(r.j.saveWarning || '')), `saveWarning=${r.j.saveWarning}`);

    // ─────────────────────────────────────────────────────────────────────────
    group('D-6 — meta-API недоступен: не писать вслепую и не молчать');
    resetDb(); S.portal.echoDate = null;
    S.metaDown = true;
    r = await pay(POST());
    S.metaDown = false;
    check('платёж создан (регресса нет)', r.status === 200 && r.j.ok, JSON.stringify(r.j));
    check('вслепую не записано', !inv()['Ожидаемая дата оплаты'] && !inv()['Тип оплаты'], JSON.stringify(inv()));
    check('пользователь предупреждён', !!r.j.saveWarning, `saveWarning=${r.j.saveWarning}`);

    group('D-6б — колонок migrate-048 нет вовсе: тихой потери быть не должно');
    resetDb({ termCols: false }); S.portal.echoDate = null;
    r = await pay(POST());
    check('платёж создан', r.status === 200 && r.j.ok);
    check('пользователь предупреждён про миграцию', /migrate-048|миграц/i.test(String(r.j.saveWarning || '')), `saveWarning=${r.j.saveWarning}`);

    // ─────────────────────────────────────────────────────────────────────────
    group('D-7 — бэкофилл не создаёт дату без типа оплаты');
    resetDb(); S.portal.echoDate = '2026-08-15';
    // счёт, отправленный ДО migrate-048: есть externalRef, но тип оплаты пуст
    inv()['Оплата ExternalRef'] = 'ЗнЗ-0007/СЧ-1'; inv()['Статус оплаты'] = 'Ожидает оплаты';
    r1 = await refresh1(1);
    check('дата без типа НЕ записана', !inv()['Ожидаемая дата оплаты'], `дата: ${inv()['Ожидаемая дата оплаты']}`);
    check('об этом сказано', !!(r1.j.saveWarning || r1.j.warning), JSON.stringify(r1.j));
    // а при известном типе «Постоплата» и пустой дате — законный бэкофилл
    inv()['Тип оплаты'] = 'Постоплата';
    await refresh1(1);
    check('при типе «Постоплата» пустая дата дозаполняется', inv()['Ожидаемая дата оплаты'] === '2026-08-15', `дата: ${inv()['Ожидаемая дата оплаты']}`);

    // ─────────────────────────────────────────────────────────────────────────
    group('Критерий 3 — портал недоступен/ошибка: регресса нет');
    resetDb();
    S.portal.mode = 'error';
    r = await pay(POST());
    check('ошибка портала = ошибка отправки, а не тихий успех', r.status >= 400, `status=${r.status}`);
    check('в базу ничего не записано', !inv()['Ожидаемая дата оплаты'] && !inv()['Тип оплаты']);
    S.portal.mode = 'down';
    r = await pay(POST());
    check('портал недоступен → 502', r.status === 502, `status=${r.status} ${JSON.stringify(r.j)}`);
    S.portal.mode = 'ok';

    // ─────────────────────────────────────────────────────────────────────────
    group('Критерий 4 — запись к нам упала, платёж создан: платёж жив, неудача видна');
    resetDb(); S.portal.echoDate = null;
    S.ncWriteDown = true;
    r = await pay(POST());
    S.ncWriteDown = false;
    check('ответ ok (платёж во внешнем портале не отменяем)', r.status === 200 && r.j.ok, JSON.stringify(r.j));
    check('paymentId возвращён', !!(r.j.payment && r.j.payment.id));
    check('неудача записи видна', !!r.j.saveWarning, `saveWarning=${r.j.saveWarning}`);

    // ─────────────────────────────────────────────────────────────────────────
    group('Флоу «на всю ЗнЗ» (без счёта) — те же правила');
    resetDb(); S.portal.echoDate = '2026-09-30';
    r = await pay(POST({ invoiceId: undefined }));
    check('ЗнЗ: дата = то, что ушло наружу', znz()['Ожидаемая дата оплаты'] === '2026-08-15', `дата: ${znz()['Ожидаемая дата оплаты']}`);
    resetDb(); S.portal.echoDate = '2026-09-30';
    r = await pay(AVANS({ invoiceId: undefined }));
    check('ЗнЗ: предоплата — дата пуста', !znz()['Ожидаемая дата оплаты'], `дата: ${znz()['Ожидаемая дата оплаты']}`);
    znz()['Ожидаемая дата оплаты'] = null;
    await refresh1();
    check('ЗнЗ: опрос не создаёт дату у предоплаты', !znz()['Ожидаемая дата оплаты'], `дата: ${znz()['Ожидаемая дата оплаты']}`);

    // ─────────────────────────────────────────────────────────────────────────
    group('Критерий 6 / D-8 — старые счета без «undefined», мусор не превращается в «NaN»');
    resetDb();
    inv()['Процент аванса'] = '30%';                        // колонка оказалась текстовой
    const invShape = () => fetch(`${B}/api/procurement/invoices?znzId=7`, { headers: H })
      .then((x) => x.json()).then((d) => (d.invoices || []).find((x) => x.id === 1)).catch(() => null);
    let shaped = await invShape();
    check('avansPercent не NaN-подобен', !shaped || shaped.avansPercent === null || Number.isFinite(shaped.avansPercent), JSON.stringify(shaped));
    // счёт БЕЗ колонок migrate-048 (старый) — клиент рисует только заполненное, «undefined» взяться неоткуда
    resetDb({ termCols: false });
    shaped = await invShape();
    check('старый счёт: условия платежа пусты, не «undefined»',
      shaped && shaped.payType === '' && shaped.expectedPayDate === '' && shaped.avansPercent === null && shaped.portalPayDate === '',
      JSON.stringify(shaped));
    // расхождение сроков обязано доехать до карточки, а не жить только в тосте
    resetDb(); S.portal.echoDate = '2026-09-30';
    await pay(POST());
    shaped = await invShape();
    check('расхождение видно в карточке (portalPayDate)', shaped && shaped.portalPayDate === '2026-09-30', JSON.stringify(shaped));
    check('наш срок в карточке — тот, что ушёл наружу', shaped && String(shaped.expectedPayDate).slice(0, 10) === '2026-08-15', JSON.stringify(shaped));

    // ─────────────────────────────────────────────────────────────────────────
    group('Критерий 5 — migrate-048: повторный прогон дублей не создаёт');
    resetDb({ termCols: false });
    let mg = await runMigration(stubPort, { apply: true });
    check('первый APPLY создаёт 4 колонки в «Счета-К»', S.columns.tblInv.filter((c) => PAY_TERM_TITLES.includes(c.title)).length === 4, mg.out);
    check('первый APPLY создаёт 4 колонки в «Заявки ЗнЗ»', S.columns.tblZnz.filter((c) => PAY_TERM_TITLES.includes(c.title)).length === 4, mg.out);
    mg = await runMigration(stubPort, { apply: true });
    check('повторный APPLY не плодит дублей (Счета-К)', S.columns.tblInv.filter((c) => PAY_TERM_TITLES.includes(c.title)).length === 4, mg.out);
    check('повторный APPLY не плодит дублей (Заявки ЗнЗ)', S.columns.tblZnz.filter((c) => PAY_TERM_TITLES.includes(c.title)).length === 4, mg.out);
    check('повторный APPLY: 0 к созданию, 0 конфликтов', /к созданию: 0/.test(mg.out) && /конфликтов\/предупреждений: 0/.test(mg.out), mg.out);
    mg = await runMigration(stubPort, { apply: false });
    check('DRY_RUN на готовой схеме ничего не планирует', /к созданию: 0/.test(mg.out), mg.out);

    group('D-4 (миграция) — чужой словарь SingleSelect виден, а не «уже есть»');
    resetDb({ termCols: false });
    S.columns.tblInv.push({ title: 'Тип оплаты', uidt: 'SingleSelect', colOptions: { options: [{ title: 'Аванс' }, { title: 'Отсрочка' }] } });
    mg = await runMigration(stubPort, { apply: false });
    check('расхождение словаря названо конфликтом', /В СЛОВАРЕ НЕТ ВАРИАНТОВ/.test(mg.out), mg.out);
    check('конкретно перечислены недостающие варианты', /Предоплата/.test(mg.out) && /Постоплата/.test(mg.out), mg.out);
    check('конфликт поднимает код возврата', mg.code === 2, `code=${mg.code}`);
    check('чужая колонка НЕ тронута', (S.columns.tblInv.find((c) => c.title === 'Тип оплаты').colOptions.options || []).length === 2);
  } finally {
    child.kill('SIGKILL');
    stub.close();
    try { fs.rmSync(iso.dir, { recursive: true, force: true }); } catch {}
    if (process.env.SHOW_LOGS) console.log(logs.join(''));
  }

  console.log(results.join('\n'));
  console.log(`\n── Итог: пройдено ${PASS}, провалено ${FAIL} ──`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
