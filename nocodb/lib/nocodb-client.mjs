// ============================================================================
//  Тонкий клиент NocoDB Meta + Data API.
//  Цель — построение схемы/сидинг/представлений из кода (IaC).
//
//  Версия API: Meta v1 (/api/v1/db/meta/...) + Data v2 (/api/v2/tables/...).
//  Проверено против NocoDB CE (образ nocodb/nocodb:latest, API v1 meta стабилен).
//  Самая чувствительная к версии часть — создание связей (createLink); если
//  NocoDB сменит контракт, правьте только этот метод.
//
//  Авторизация: токен API (NC_TOKEN, заголовок xc-token) ИЛИ e-mail+пароль
//  суперадмина (NC_EMAIL/NC_PASSWORD → получаем xc-auth JWT).
// ============================================================================

const BASE = process.env.NC_URL || 'http://localhost:8080';
const TOKEN = process.env.NC_TOKEN || '';
const EMAIL = process.env.NC_EMAIL || '';
const PASSWORD = process.env.NC_PASSWORD || '';

let authToken = null; // xc-auth (JWT), если входим по email/паролю

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['xc-token'] = TOKEN;
  if (authToken) headers['xc-auth'] = authToken;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = typeof data === 'object' ? JSON.stringify(data) : data;
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

// --- авторизация ------------------------------------------------------------
export async function signin() {
  if (TOKEN) return; // токен не требует логина
  if (!EMAIL || !PASSWORD) {
    throw new Error('Задайте NC_TOKEN или NC_EMAIL+NC_PASSWORD в окружении.');
  }
  const r = await req('POST', '/api/v1/auth/user/signin', { email: EMAIL, password: PASSWORD });
  authToken = r.token;
}

export async function health() {
  return req('GET', '/api/v1/health');
}

// --- базы (projects) --------------------------------------------------------
export async function listBases() {
  const r = await req('GET', '/api/v1/db/meta/projects');
  return r.list || [];
}

export async function getBaseByTitle(title) {
  const list = await listBases();
  return list.find((b) => b.title === title) || null;
}

export async function createBase(title) {
  return req('POST', '/api/v1/db/meta/projects', { title });
}

// --- таблицы ----------------------------------------------------------------
export async function listTables(baseId) {
  const r = await req('GET', `/api/v1/db/meta/projects/${baseId}/tables?includeM2M=false`);
  return r.list || [];
}

export async function createTable(baseId, table) {
  // table: { table_name, title, columns: [...] }
  return req('POST', `/api/v1/db/meta/projects/${baseId}/tables`, table);
}

export async function getTable(tableId) {
  return req('GET', `/api/v1/db/meta/tables/${tableId}`);
}

export async function createColumn(tableId, column) {
  return req('POST', `/api/v1/db/meta/tables/${tableId}/columns`, column);
}

export async function updateColumn(columnId, column) {
  return req('PATCH', `/api/v1/db/meta/columns/${columnId}`, column);
}

// --- связи (LinkToAnotherRecord) -------------------------------------------
// Создаём hasMany со стороны «один» (parentTableId). NocoDB сам добавит
// обратную belongsTo-колонку на «многих». type: 'hm' | 'mm' | 'bt'
export async function createLink(parentTableId, { title, childTableId, type = 'hm' }) {
  return req('POST', `/api/v1/db/meta/tables/${parentTableId}/columns`, {
    uidt: 'LinkToAnotherRecord',
    title,
    parentId: parentTableId,
    childId: childTableId,
    type,
  });
}

// --- представления (views) --------------------------------------------------
export async function listViews(tableId) {
  const r = await req('GET', `/api/v1/db/meta/tables/${tableId}/views`);
  return r.list || [];
}

export async function createGridView(tableId, title) {
  return req('POST', `/api/v1/db/meta/tables/${tableId}/grids`, { title });
}

export async function createGalleryView(tableId, title) {
  return req('POST', `/api/v1/db/meta/tables/${tableId}/galleries`, { title });
}

export async function createFormView(tableId, title) {
  return req('POST', `/api/v1/db/meta/tables/${tableId}/forms`, { title });
}

// Kanban-доска: группировка по SingleSelect-колонке (fk_grp_col_id).
export async function createKanbanView(tableId, title, groupColumnId) {
  const body = groupColumnId ? { title, fk_grp_col_id: groupColumnId } : { title };
  return req('POST', `/api/v1/db/meta/tables/${tableId}/kanbans`, body);
}

export async function createFilter(viewId, filter) {
  // filter: { fk_column_id, comparison_op, value, logical_op }
  return req('POST', `/api/v1/db/meta/views/${viewId}/filters`, filter);
}

export async function createSort(viewId, sort) {
  // sort: { fk_column_id, direction: 'asc'|'desc' }
  return req('POST', `/api/v1/db/meta/views/${viewId}/sorts`, sort);
}

// --- данные (Data API v2, по tableId) ---------------------------------------
//  NocoDB 2026.06: v1 data API не резолвит таблицы по названию → используем v2.
export async function listRows(tableId, params = '') {
  const r = await req('GET', `/api/v2/tables/${tableId}/records?limit=1000${params}`);
  return r.list || [];
}

export async function createRow(tableId, row) {
  const r = await req('POST', `/api/v2/tables/${tableId}/records`, row);
  return Array.isArray(r) ? r[0] : r; // v2 может вернуть массив или объект
}

export async function updateRow(tableId, recordId, patch) {
  return req('PATCH', `/api/v2/tables/${tableId}/records`, [{ Id: recordId, ...patch }]);
}

export async function deleteRow(tableId, recordId) {
  return req('DELETE', `/api/v2/tables/${tableId}/records`, [{ Id: recordId }]);
}

// связать записи: в link-поле linkColumnId записи recordId добавить childIds[]
export async function linkRecords(tableId, linkColumnId, recordId, childIds) {
  const body = childIds.map((id) => ({ Id: id }));
  return req('POST', `/api/v2/tables/${tableId}/links/${linkColumnId}/records/${recordId}`, body);
}

// прочитать связанные записи (hm/bt/mm) поля linkColumnId записи recordId
export async function listLinkedRecords(tableId, linkColumnId, recordId) {
  const r = await req('GET', `/api/v2/tables/${tableId}/links/${linkColumnId}/records/${recordId}?limit=1000`);
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r.list)) return r.list;
  if (r && (r.Id ?? r.id) != null) return [r]; // belongsTo возвращает один объект
  return [];
}

export const config = { BASE, hasToken: !!TOKEN };
