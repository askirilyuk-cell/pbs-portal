// ============================================================================
//  K-349: MCP-сервер портала ИСМ ПБС (Model Context Protocol, Streamable HTTP).
//  POST /mcp — JSON-RPC 2.0, ответ application/json (без SSE). Вход — личный токен
//  «Authorization: Bearer …» из «Настройки → Доступ для ИИ»; токен = сотрудник Bitrix,
//  права = его права в портале. Инструменты ходят в ОБЫЧНЫЙ API портала под внутренней
//  сессией этого сотрудника — те же проверки RBAC, история изменений, уведомления в чаты.
//  Наружу портал не публикуется: доступ из локальной сети и Tailscale (как сам портал).
//  Сознательно НЕТ инструментов удаления и отправки на оплату — это делает человек в UI.
// ============================================================================

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'pbs-portal', title: 'Портал ИСМ ПБС', version: '1.0.0' };
const INSTRUCTIONS = [
  'Портал ИСМ ПБС (производство ПБС). Сейчас доступен раздел «Закупки»: заявки на закупку (ЗнЗ) с позициями, поставщики, счета.',
  'Номера: ЗнЗ-ГГГГ-NNN (заявка на закупку), ПЗ-ГГГГ-NNN (производственный заказ), ЗП-ГГГГ-NNN (запрос от заказчика).',
  'Одна ЗнЗ может содержать несколько позиций — материалы под один заказ заводите ОДНОЙ заявкой с позициями, а не отдельными заявками.',
  'Перед созданием ЗнЗ znz_create сам ищет дубли (тот же источник и похожие позиции) и останавливается — покажите их человеку и спросите, прежде чем повторять с allowDuplicate.',
  'Все изменения пишутся в историю от имени владельца токена с пометкой «ИИ». Удаление и отправка на оплату — только в интерфейсе портала.',
].join('\n');

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,;:()]/g, ' ').replace(/\s+/g, ' ').trim();
const ZNZ_RE = /^ЗнЗ-\d{4}-\d{3}$/i;

function tool(name, title, description, properties, required, annotations, run) {
  return { def: { name, title, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations }, run };
}
const RO = { readOnlyHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

// ── инструменты раздела «Закупки» ───────────────────────────────────────────
function procurementTools() {
  // ЗнЗ по номеру или id (из реестра /api/procurement)
  async function findZnz(api, ref) {
    const d = await api('GET', '/api/procurement');
    const all = d.requests || [];
    const s = String(ref == null ? '' : ref).trim();
    const z = all.find((x) => String(x.numZnz).toLowerCase() === s.toLowerCase()) || all.find((x) => String(x.id) === s);
    if (!z) throw new Error(`Заявка ${s} не найдена.`);
    return { z, all };
  }
  const brief = (x) => ({
    numZnz: x.numZnz, name: x.name, status: x.status, type: x.type, created: x.created, duePlan: x.duePlan || null,
    sourceRef: x.sourceRef || null, initiator: x.initiator || null, assignee: (x.assignee && x.assignee.fio) || null,
    supplier: x.supplier || null, positions: x.itemsCount || 0, invoices: x.invoicesCount || 0,
    invoicesSum: x.invoicesSum != null ? Math.round(x.invoicesSum * 100) / 100 : null,
    paidSum: x.invPaidSum ? Math.round(x.invPaidSum * 100) / 100 : 0,
  });

  return [
    tool('znz_search', 'Найти заявки на закупку',
      'Поиск заявок на закупку (ЗнЗ) по тексту (номер, наименование, поставщик, источник ПЗ/ЗП), статусу и источнику. Возвращает краткие карточки, новые сверху.',
      {
        query: { type: 'string', description: 'Текст поиска: «уголок», «ЗнЗ-2026-013», «Гленар», «ПЗ-2026-013»' },
        status: { type: 'string', description: 'Статус: Новая, В работе, Размещена, В пути, Принята, Закрыта, Отменена' },
        sourceRef: { type: 'string', description: 'Источник: ПЗ-ГГГГ-NNN, ЗП-ГГГГ-NNN или «склад»' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      }, [], RO,
      async (api, a) => {
        const d = await api('GET', '/api/procurement');
        let list = (d.requests || []).slice();
        const q = norm(a.query);
        if (q) list = list.filter((x) => norm([x.numZnz, x.name, x.supplier, x.sourceRef, x.initiator, x.note].join(' ')).includes(q));
        if (a.status) list = list.filter((x) => norm(x.status) === norm(a.status));
        if (a.sourceRef) list = list.filter((x) => norm(x.sourceRef).includes(norm(a.sourceRef)));
        list.sort((x, y) => String(y.numZnz).localeCompare(String(x.numZnz), 'ru'));
        return { total: list.length, items: list.slice(0, a.limit || 30).map(brief) };
      }),

    tool('znz_get', 'Карточка заявки на закупку',
      'Полная карточка ЗнЗ: реквизиты, позиции (с поставщиком, сроком, статусом и принятым количеством), счета (с оплатой и общими счетами), последние записи истории.',
      { znz: { type: 'string', description: 'Номер ЗнЗ-ГГГГ-NNN (или id)' } }, ['znz'], RO,
      async (api, a) => {
        const { z } = await findZnz(api, a.znz);
        const [it, inv] = await Promise.all([
          api('GET', '/api/procurement/znz/items?znzId=' + encodeURIComponent(z.id)),
          api('GET', '/api/procurement/invoices?znzId=' + encodeURIComponent(z.id)),
        ]);
        return {
          ...brief(z), id: z.id, category: z.category || null, urgency: z.urgency || null, deliveryPlace: z.deliveryPlace || null, note: z.note || null,
          positions: (it.items || []).map((i) => ({ positionId: i.id, name: i.name, qty: i.qty, unit: i.unit, category: i.category || null, status: i.status, supplier: i.supplier || null, due: i.due || null, accepted: i.accepted ?? null, note: i.note || null })),
          invoices: (inv.invoices || []).map((v) => ({ invoiceId: v.id, invoiceNo: v.invoiceNo, supplier: v.supplier, inn: v.inn, amount: v.amount, vatRate: v.vatRate, date: v.date, payStatus: v.payStatus, payId: v.payId || null, znzNums: v.znzNums || [], positionIds: v.itemIds || [] })),
          history: (Array.isArray(z.history) ? z.history : []).slice(-20),
        };
      }),

    tool('znz_create', 'Создать заявку на закупку',
      'Создаёт ОДНУ ЗнЗ сразу со всеми позициями. Перед созданием ищет дубли (тот же источник с похожими позициями, либо такие же позиции за последние 30 дней) и, если нашёл, НЕ создаёт, а возвращает их — покажите человеку и повторяйте с allowDuplicate=true только после его подтверждения. Уведомления уходят в чат закупок и в чаты заказа/запроса из источника.',
      {
        positions: {
          type: 'array', minItems: 1, description: 'Позиции заявки',
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'qty'],
            properties: {
              name: { type: 'string', description: 'Наименование с размером и маркой: «Лист г/к 3×1250×2500, Ст3»' },
              qty: { type: 'number', exclusiveMinimum: 0 }, unit: { type: 'string', description: 'шт, пог. м, кг, м²…' },
              category: { type: 'string', description: 'Металл, Инструмент, Комплектующие, Прочее…' }, note: { type: 'string' },
            },
          },
        },
        sourceRef: { type: 'string', description: 'Для чего: ПЗ-ГГГГ-NNN, ЗП-ГГГГ-NNN или «склад»; несколько — через запятую' },
        duePlan: { type: 'string', description: 'Нужна к, ГГГГ-ММ-ДД' },
        type: { type: 'string', enum: ['Плановая', 'Цеховая'], default: 'Плановая' },
        category: { type: 'string', description: 'Категория заявки (по умолчанию — категория первой позиции)' },
        urgency: { type: 'string', description: 'Срочность, напр. «Срочная»' },
        deliveryPlace: { type: 'string', description: 'Куда доставка (как в справочнике мест доставки портала)' },
        note: { type: 'string', description: 'Основание/комментарий для закупщика' },
        initiator: { type: 'string', description: 'Заявитель; по умолчанию — владелец токена' },
        allowDuplicate: { type: 'boolean', default: false, description: 'true — создать, даже если найдены похожие заявки (только после подтверждения человеком)' },
      }, ['positions'], RW,
      async (api, a, ctx) => {
        const d = await api('GET', '/api/procurement');
        const all = (d.requests || []).filter((x) => !/отмен/i.test(x.status || ''));
        if (!a.allowDuplicate) {
          const names = a.positions.map((p) => norm(p.name)).filter(Boolean);
          const src = norm(a.sourceRef);
          const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
          const cand = all.filter((x) => (src && norm(x.sourceRef).includes(src)) || String(x.created || '') >= since);
          const dups = [];
          for (const x of cand) {
            const it = await api('GET', '/api/procurement/znz/items?znzId=' + encodeURIComponent(x.id));
            const theirs = [x.name, ...(it.items || []).map((i) => i.name)].map(norm);
            const hit = names.filter((n) => theirs.some((t) => t && (t.includes(n) || n.includes(t))));
            if (hit.length && (src ? norm(x.sourceRef).includes(src) : true)) dups.push({ ...brief(x), matchedPositions: hit });
          }
          if (dups.length) return { created: false, reason: 'Найдены похожие заявки — проверьте, не дубль ли это. Чтобы всё равно создать, повторите с allowDuplicate=true после подтверждения человеком.', possibleDuplicates: dups };
        }
        const body = {
          type: a.type === 'Цеховая' ? 'Цеховая (Ф.4–К)' : 'Плановая (Ф.1–К)',
          initiator: a.initiator || ctx.user.fio, category: a.category || a.positions[0].category || '',
          sourceRef: a.sourceRef || '', duePlan: a.duePlan || '', urgency: a.urgency || '', deliveryPlace: a.deliveryPlace || '', note: a.note || '',
          positions: a.positions,
        };
        const j = await api('POST', '/api/procurement/znz/create', body);
        return { created: true, numZnz: j.numZnz, id: j.id, status: j.status, positionsCreated: j.itemsCreated, purchaseChatNotified: !!(j.notified && j.notified.ok), orderChats: (j.orderChatNotified && [...(j.orderChatNotified.orders || []), ...(j.orderChatNotified.requests || [])]) || [] };
      }),

    tool('znz_add_position', 'Добавить позицию в заявку',
      'Добавляет позицию в существующую ЗнЗ.',
      {
        znz: { type: 'string', description: 'Номер ЗнЗ-ГГГГ-NNN' }, name: { type: 'string' }, qty: { type: 'number', exclusiveMinimum: 0 },
        unit: { type: 'string' }, category: { type: 'string' }, supplier: { type: 'string' }, due: { type: 'string', description: 'ГГГГ-ММ-ДД' }, note: { type: 'string' },
      }, ['znz', 'name', 'qty'], RW,
      async (api, a) => {
        const { z } = await findZnz(api, a.znz);
        const { znz, ...rest } = a;
        const j = await api('POST', '/api/procurement/znz/items', { znzId: z.id, ...rest });
        return { ok: true, znz: z.numZnz, positionId: j.id ?? (j.item && j.item.id) ?? null };
      }),

    tool('znz_update_position', 'Изменить позицию заявки',
      'Меняет наименование, количество, ед., поставщика, срок, статус или примечание позиции. Если позиция уже размещена у поставщика, портал требует причину (reason) — она попадёт в историю и в чат закупок.',
      {
        positionId: { type: 'integer', description: 'positionId из znz_get' }, name: { type: 'string' }, qty: { type: 'number', exclusiveMinimum: 0 },
        unit: { type: 'string' }, category: { type: 'string' }, supplier: { type: 'string' }, due: { type: 'string', description: 'ГГГГ-ММ-ДД' },
        status: { type: 'string' }, note: { type: 'string' }, reason: { type: 'string', description: 'Причина изменения размещённой позиции' },
      }, ['positionId'], RW,
      async (api, a) => {
        const { positionId, ...rest } = a;
        await api('PATCH', '/api/procurement/znz/items', { id: positionId, ...rest });
        return { ok: true, positionId, changed: Object.keys(rest).filter((k) => k !== 'reason') };
      }),

    tool('znz_set_source', 'Указать источник заявки',
      'Привязывает ЗнЗ к заказу/запросу (ПЗ-…, ЗП-…, «склад»; несколько — через запятую). При привязке в чат заказа/запроса уходит сообщение о размещённой заявке.',
      { znz: { type: 'string' }, sourceRef: { type: 'string' } }, ['znz', 'sourceRef'], RW,
      async (api, a) => {
        const { z } = await findZnz(api, a.znz);
        const j = await api('POST', '/api/procurement/znz/source', { id: z.id, sourceRef: a.sourceRef });
        const oc = j.orderChatNotified || {};
        return { ok: true, znz: z.numZnz, sourceRef: j.sourceRef, unchanged: !!j.unchanged, chatsNotified: [...(oc.orders || []), ...(oc.requests || [])] };
      }),

    tool('suppliers_search', 'Найти поставщика',
      'Поиск в реестре одобренных поставщиков (контрагенты с ролью «Поставщик»/РОП) по названию, ИНН или категории продукции.',
      { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, [], RO,
      async (api, a) => {
        const d = await api('GET', '/api/procurement/suppliers');
        const q = norm(a.query);
        const list = (d.suppliers || []).filter((s) => !q || norm([s.name, s.inn, s.productCat, s.region].join(' ')).includes(q));
        return { total: list.length, items: list.slice(0, a.limit || 20).map((s) => ({ supplierId: s.id, name: s.name, inn: s.inn || null, productCat: s.productCat || null, ropCategory: s.category || null, score: s.score ?? null, region: s.region || null })) };
      }),

    tool('invoice_update', 'Изменить счёт',
      'Правка реквизитов счёта (поставщик, ИНН, №, сумма, НДС, дата, комментарий) и общего счёта: alsoZnz — полный список ДРУГИХ ЗнЗ, которые покрывает счёт (основная заявка не меняется). Статус оплаты и отправку на оплату не меняет.',
      {
        invoiceId: { type: 'integer', description: 'invoiceId из znz_get' }, invoiceNo: { type: 'string' }, supplier: { type: 'string' }, inn: { type: 'string' },
        amount: { type: 'number', minimum: 0 }, vatRate: { type: 'string', enum: ['22%', '20%', '10%', '0%', 'Без НДС'] }, vatAmount: { type: 'number', minimum: 0 },
        date: { type: 'string', description: 'ГГГГ-ММ-ДД' }, note: { type: 'string' },
        alsoZnz: { type: 'array', items: { type: 'string' }, description: 'Номера других ЗнЗ общего счёта; [] — снять общий счёт' },
      }, ['invoiceId'], RW,
      async (api, a) => {
        if (a.alsoZnz) for (const n of a.alsoZnz) if (!ZNZ_RE.test(String(n).trim())) throw new Error(`«${n}» — не номер ЗнЗ (нужно ЗнЗ-ГГГГ-NNN).`);
        const { invoiceId, ...rest } = a;
        const j = await api('PATCH', '/api/procurement/invoices', { id: invoiceId, ...rest });
        return { ok: true, invoiceId, changed: j.patched || [], unchanged: !!j.unchanged };
      }),
  ];
}

// ── протокол ────────────────────────────────────────────────────────────────
// deps: { port, authenticate(req) → { sid, user:{id,fio}, tokenId } | null }
export function createMcpHandler(deps) {
  const tools = procurementTools();
  const byName = new Map(tools.map((t) => [t.def.name, t]));

  const apiFor = (sid) => async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${deps.port}${path}`, {
      method, headers: { cookie: `pbs_sid=${sid}`, 'Content-Type': 'application/json', 'X-Mcp': '1' },
      body: body == null || method === 'GET' ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const e = new Error(j.error || `HTTP ${r.status}`);
      e.code = j.code; e.status = r.status; throw e;
    }
    return j;
  };

  async function rpc(msg, ctx) {
    const { id, method, params } = msg || {};
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return err(-32600, 'Invalid Request');
    if (id === undefined) return null; // уведомление (notifications/initialized и т.п.) — ответа нет
    if (method === 'initialize') {
      const want = params && params.protocolVersion;
      return ok({ protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: tools.map((t) => t.def) });
    if (method === 'tools/call') {
      const t = byName.get(params && params.name);
      if (!t) return err(-32602, `Нет инструмента ${params && params.name}`);
      const args = (params && params.arguments) || {};
      try {
        const out = await t.run(apiFor(ctx.sid), args, ctx);
        return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out, isError: false });
      } catch (e) {
        const hint = e.code === 'reason_required' ? ' Укажите reason — причину изменения размещённой позиции.' : (e.status === 403 ? ' Недостаточно прав в портале.' : '');
        return ok({ content: [{ type: 'text', text: `Ошибка: ${String(e.message).replace(/\.+$/, '')}.${hint}` }], isError: true });
      }
    }
    return err(-32601, `Метод ${method} не поддерживается`);
  }

  return async function handleMcp(req, res, readBody) {
    const send = (status, obj, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(obj == null ? '' : JSON.stringify(obj)); };
    if (req.method !== 'POST') return send(405, { error: 'MCP: только POST (Streamable HTTP без SSE).' }, { Allow: 'POST' });
    const ctx = await deps.authenticate(req);
    if (!ctx) return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Нужен личный токен портала: Authorization: Bearer … (Настройки → Доступ для ИИ).' } }, { 'WWW-Authenticate': 'Bearer realm="pbs-portal"' });
    let body;
    try { body = await readBody(req); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => rpc(m, ctx)))).filter(Boolean);
      return out.length ? send(200, out) : send(202, null);
    }
    const out = await rpc(body, ctx);
    return out ? send(200, out) : send(202, null);
  };
}
