// ============================================================================
//  Построение схемы производственного модуля в NocoDB (идемпотентно).
//
//  Запуск (с NAS или машины с доступом к NocoDB):
//    NC_URL=http://192.168.1.10:8080 NC_TOKEN=<api-token> \
//      node nocodb/schema/build-schema.mjs
//  либо вместо токена:  NC_EMAIL=admin@... NC_PASSWORD=...
//
//  Результат: база «Производство ПБС», 8 таблиц, select-словари, связи.
//  Карта id таблиц/колонок сохраняется в nocodb/.state/schema-map.json
//  (её читают seed.mjs и build-views.mjs).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nc from '../lib/nocodb-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf-8'));
const stateDir = path.join(__dirname, '..', '.state');
const mapPath = path.join(stateDir, 'schema-map.json');

// --- транслитерация для column_name (БД любит latin-имена) ------------------
const RU = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function slug(s) {
  const base = [...s.toLowerCase()].map((ch) => RU[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return base || 'col';
}

function toApiColumn(c, isDisplay, used) {
  let name = slug(c.title);
  let n = name, i = 2;
  while (used.has(n)) n = `${name}_${i++}`;
  used.add(n);

  const col = { title: c.title, column_name: n, uidt: c.uidt };
  if (isDisplay) col.pv = true;
  if (c.uidt === 'SingleSelect' || c.uidt === 'MultiSelect') {
    col.colOptions = { options: (c.options || []).map((o) => ({ title: o })) };
    // dtxp дублирует варианты — некоторые версии NocoDB читают именно его
    col.dtxp = (c.options || []).map((o) => `'${o.replace(/'/g, "''")}'`).join(',');
  }
  return col;
}

const log = (...a) => console.log('  ', ...a);

async function main() {
  console.log(`NocoDB: ${nc.config.BASE} (${nc.config.hasToken ? 'token' : 'email/pwd'})`);
  await nc.signin();
  await nc.health();

  // 1) база ------------------------------------------------------------------
  let base = await nc.getBaseByTitle(schema.base);
  if (!base) {
    console.log(`Создаю базу «${schema.base}»`);
    base = await nc.createBase(schema.base);
  } else {
    console.log(`База «${schema.base}» уже есть (${base.id})`);
  }
  const baseId = base.id;

  const map = { base: schema.base, baseId, tables: {} };

  // 2) таблицы + колонки -----------------------------------------------------
  let existing = await nc.listTables(baseId);
  for (const t of schema.tables) {
    let tbl = existing.find((x) => x.title === t.title);
    const used = new Set();
    if (!tbl) {
      console.log(`Таблица «${t.title}»: создаю`);
      const columns = t.columns.map((c) => toApiColumn(c, c.title === t.display, used));
      const created = await nc.createTable(baseId, {
        table_name: t.table_name,
        title: t.title,
        columns,
      });
      tbl = created;
    } else {
      console.log(`Таблица «${t.title}»: уже есть (${tbl.id})`);
    }

    // дочитываем актуальные колонки, добиваем отсутствующие
    const full = await nc.getTable(tbl.id);
    const haveTitles = new Set(full.columns.map((c) => c.title));
    full.columns.forEach((c) => used.add(c.column_name));
    for (const c of t.columns) {
      if (!haveTitles.has(c.title)) {
        log(`+ колонка «${c.title}»`);
        await nc.createColumn(tbl.id, toApiColumn(c, false, used));
      }
    }

    const fresh = await nc.getTable(tbl.id);
    map.tables[t.key] = {
      id: tbl.id,
      title: t.title,
      table_name: t.table_name,
      display: t.display,
      columns: Object.fromEntries(fresh.columns.map((c) => [c.title, c.id])),
    };
  }

  // 3) связи -----------------------------------------------------------------
  for (const l of schema.links) {
    const parent = map.tables[l.parent];
    const child = map.tables[l.child];
    const cur = await nc.getTable(parent.id);
    if (cur.columns.some((c) => c.title === l.title)) {
      console.log(`Связь «${parent.title} → ${l.title}»: уже есть`);
      continue;
    }
    console.log(`Связь «${parent.title} → ${child.title}» (${l.type}) как «${l.title}»`);
    await nc.createLink(parent.id, { title: l.title, childTableId: child.id, type: l.type });
  }

  // 4) перечитать карту колонок (появились link-колонки и обратные bt) -------
  for (const key of Object.keys(map.tables)) {
    const fresh = await nc.getTable(map.tables[key].id);
    map.tables[key].columns = Object.fromEntries(fresh.columns.map((c) => [c.title, c.id]));
  }

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));
  console.log(`\n✓ Схема готова. Карта сохранена: ${path.relative(process.cwd(), mapPath)}`);
}

main().catch((e) => { console.error('✗ Ошибка:', e.message); process.exit(1); });
