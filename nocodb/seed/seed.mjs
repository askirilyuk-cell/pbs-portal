// ============================================================================
//  Сидинг производственного модуля.
//
//  Заполняет:
//    • Участки         ← data/uchastki.json   (из Ф.1–П)
//    • Типы операций   ← data/op_types.json    (+ связь с участком)
//    • Параметры типов ← data/op_params.json   (+ связь с типом операции)
//    • Сотрудники      ← data/employees.json
//    • Заказы+Позиции  ← data/sample_orders.json (демо-данные для видов/печати)
//
//  Идемпотентность: записи ищутся по «ключу» (код/№); существующие пропускаются.
//
//  Запуск:  NC_URL=... NC_TOKEN=... node nocodb/seed/seed.mjs
//  Требует предварительно выполненного build-schema.mjs (schema-map.json).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nc from '../lib/nocodb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.state', 'schema-map.json'), 'utf-8'));
const baseId = map.baseId;
const load = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf-8'));

const TID = (key) => map.tables[key].id;          // id таблицы для Data API v2
const COL = (key, title) => map.tables[key].columns[title]; // id колонки (для связей)

// индекс существующих строк по значению поля-ключа
async function indexBy(key, field) {
  const rows = await nc.listRows(TID(key));
  const idx = new Map();
  for (const r of rows) idx.set(String(r[field]), r);
  return idx;
}

// связать строку: parent-сторона hasMany по id link-колонки
async function link(tableKey, rowId, linkTitle, childId) {
  const colId = COL(tableKey, linkTitle);
  await nc.linkRecords(TID(tableKey), colId, rowId, [childId]);
}

const log = (...a) => console.log('  ', ...a);

async function main() {
  await nc.signin();
  console.log('Сидинг → база', map.base);

  // 1) Участки --------------------------------------------------------------
  console.log('Участки');
  const secByCode = new Map();
  {
    const idx = await indexBy('sections', 'Код');
    for (const u of load('uchastki.json')) {
      let row = idx.get(u.code);
      if (!row) {
        row = await nc.createRow(TID('sections'), {
          'Код': u.code,
          'Участок': u.name,
          'Описание': u.description,
          'Основное оборудование': u.equipment,
          'Тип': u.kind,
          'Должность ответственного': u.position,
        });
        log('+', u.code, u.name);
      }
      secByCode.set(u.code, row.Id ?? row.id);
    }
  }

  // 2) Типы операций --------------------------------------------------------
  console.log('Типы операций');
  const opByCode = new Map();
  {
    const idx = await indexBy('op_types', 'Код типа');
    for (const o of load('op_types.json')) {
      let row = idx.get(o.code);
      if (!row) {
        row = await nc.createRow(TID('op_types'), {
          'Код типа': o.code,
          'Наименование': o.name,
          'РИ': o.ri,
        });
        log('+', o.code, o.name);
      }
      const id = row.Id ?? row.id;
      opByCode.set(o.code, id);
      // связь с участком — со стороны «Участки» (hm «Типы операций»), идемпотентно
      const secId = secByCode.get(o.section_code);
      if (secId) await link('sections', secId, 'Типы операций', id)
        .catch((e) => log('  связь участок?', e.message));
    }
  }

  // 3) Параметры типов ------------------------------------------------------
  console.log('Параметры типов');
  {
    // ключ параметра = «код типа | параметр» (уникальность в рамках типа)
    const rows = await nc.listRows(TID('op_params'));
    const seen = new Set(rows.map((r) => `${r['Параметр']}`)); // грубо, см. ниже
    const existsByPair = new Set();
    // точный ключ требует знания типа — перечитаем со связью недёшево;
    // для демо достаточно: пропускаем, если параметр с тем же именем уже привязан.
    for (const p of load('op_params.json')) {
      const pairKey = `${p.op_type_code}|${p.param}`;
      if (existsByPair.has(pairKey)) continue;
      // создаём всегда при пустой таблице; при повторном прогоне — пропуск по имени+типу
      const already = rows.find((r) => r['Параметр'] === p.param &&
        // эвристика: единица совпадает
        (r['Единица'] || '') === (p.unit || ''));
      if (already) { existsByPair.add(pairKey); continue; }
      const row = await nc.createRow(TID('op_params'), {
        'Параметр': p.param,
        'Единица': p.unit,
        'Тип значения': p.value_type,
        'Варианты': (p.options || []).join(', '),
        'Обязательный': p.required,
      });
      const opId = opByCode.get(p.op_type_code);
      if (opId) await link('op_types', opId, 'Параметры', row.Id ?? row.id)
        .catch((e) => log('  связь тип?', e.message));
      existsByPair.add(pairKey);
      log('+', p.op_type_code, p.param);
    }
  }

  // 4) Сотрудники -----------------------------------------------------------
  console.log('Сотрудники');
  const empByName = new Map();
  {
    const idx = await indexBy('employees', 'ФИО');
    for (const e of load('employees.json')) {
      let row = idx.get(e.full_name);
      if (!row) {
        row = await nc.createRow(TID('employees'), { 'ФИО': e.full_name, 'Роль': e.role });
        log('+', e.full_name, e.role);
        const secId = secByCode.get(e.section_code);
        if (secId) await link('sections', secId, 'Сотрудники участка', row.Id ?? row.id)
          .catch(() => {});
      }
      empByName.set(e.full_name, row.Id ?? row.id);
    }
  }

  // 5) Заказы + Позиции (демо) ---------------------------------------------
  console.log('Заказы и позиции (демо)');
  {
    const ordIdx = await indexBy('orders', '№ ПЗ');
    for (const o of load('sample_orders.json')) {
      let order = ordIdx.get(o.num_pz);
      if (!order) {
        order = await nc.createRow(TID('orders'), {
          '№ ПЗ': o.num_pz,
          '№ ЗП': o.num_zp,
          'Тип заказа': o.order_type,
          'Заказчик / Инициатор': o.customer,
          'Тип продукции': o.product_type,
          'Договор / основание': o.basis,
          'Дата размещения': o.date_placed,
          'Плановый срок': o.date_plan,
          'Статус': o.status,
          'Приоритет': o.priority,
          'Условия': o.terms,
          'Выдал (менеджер)': o.approve_issued,
          'Принял (ДпП)': o.approve_accepted,
          'Утвердил (технолог)': o.approve_approved,
        });
        log('+ ПЗ', o.num_pz);
        // ответственный — связь с сотрудником по роли
        const respName = [...empByName.keys()].find((n) =>
          load('employees.json').find((e) => e.full_name === n && e.role === o.responsible_role));
        const respId = respName ? empByName.get(respName) : null;
        if (respId) await link('employees', respId, 'Ответственный за заказы', order.Id ?? order.id)
          .catch(() => {});

        for (const p of o.positions) {
          const pos = await nc.createRow(TID('positions'), {
            'Позиция': `${o.num_pz} · поз. ${p.pos_num}`,
            '№ позиции': p.pos_num,
            'Наименование / обозначение': p.name,
            'Чертёж / ТУ': p.drawing,
            'Ед.': p.unit,
            'Кол-во': p.qty,
            'Срок готовности': p.date_ready,
            'Статус': p.status,
          });
          await link('orders', order.Id ?? order.id, 'Позиции', pos.Id ?? pos.id).catch(() => {});
          log('    + позиция', p.pos_num, p.name);
        }
      }
    }
  }

  console.log('\n✓ Сидинг завершён.');
}

main().catch((e) => { console.error('✗ Ошибка сидинга:', e.message); process.exit(1); });
