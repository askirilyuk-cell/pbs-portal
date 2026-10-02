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
const SERVER_INFO = { name: 'pbs-portal', title: 'Портал ИСМ ПБС', version: '1.2.0' };
const INSTRUCTIONS = [
  'Портал ИСМ ПБС (производство ПБС). Разделы: «Закупки» — заявки на закупку (ЗнЗ) с позициями, поставщики, счета; «Продажи» — запросы заказчиков (ЗП), КП и его результат, контрагенты.',
  'Номера: ЗнЗ-ГГГГ-NNN (заявка на закупку), ПЗ-ГГГГ-NNN (производственный заказ), ЗП-ГГГГ-NNN (запрос от заказчика).',
  'Одна ЗнЗ может содержать несколько позиций — материалы под один заказ заводите ОДНОЙ заявкой с позициями, а не отдельными заявками.',
  'Перед созданием ЗнЗ znz_create сам ищет дубли (тот же источник и похожие позиции) и останавливается — покажите их человеку и спросите, прежде чем повторять с allowDuplicate.',
  'Новый запрос ЗП: сначала найдите заказчика в контрагентах (counterparties_search), чтобы имя совпало с реестром; zp_create тоже ищет дубли.',
  'Все изменения пишутся в историю от имени владельца токена с пометкой «ИИ». Удаление, отправка на оплату, отправка КП заказчику и создание заказа — только в интерфейсе портала.',
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

// ── K-351: инструменты раздела «Продажи» ────────────────────────────────────
const CONTACT_SCHEMA = { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', description: 'ФИО' }, position: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, primary: { type: 'boolean', description: 'Основной контакт' } } };
const KP_RESULTS = ['Отправлено', 'Согласовано', 'Выиграли', 'Выиграли частично', 'Проиграли', 'Отказались'];
function salesTools() {
  async function findZp(api, ref) {
    const d = await api('GET', '/api/sales');
    const s = String(ref == null ? '' : ref).trim();
    const z = (d.requests || []).find((x) => String(x.numZp).toLowerCase() === s.toLowerCase()) || (d.requests || []).find((x) => String(x.id) === s);
    if (!z) throw new Error(`Запрос ${s} не найден.`);
    return { z, all: d.requests || [] };
  }
  const kpBrief = (kp) => (kp && typeof kp === 'object') ? { no: kp.ofNo && kp.ofNo !== '—' ? kp.ofNo : null, date: kp.date || null, result: kp.status || null } : null;
  const brief = (x) => ({
    numZp: x.numZp, received: x.received, customer: x.customer, name: x.name, kind: x.kind || null, deadline: x.deadline || null,
    status: x.status, owner: x.owner || null, sumKp: x.sumKpNum ?? null, kp: kpBrief(x.kp), kpOverdue: !!x.kpStale, wonSum: x.wonSum ?? null,
    orderNo: x.orderNo || null, productionOrders: (x.prodOrders || []).map((o) => o.numPz).filter(Boolean), hasChat: !!x.chat,
  });
  return [
    tool('zp_search', 'Найти запросы заказчиков',
      'Поиск запросов продаж (ЗП) по тексту (номер, заказчик, наименование, ответственный), статусу и виду обращения. Новые сверху.',
      {
        query: { type: 'string', description: 'Текст: «ЗП-2026-060», «ЗЭРС», «переводник»' },
        status: { type: 'string', description: 'Новый, КП готовится, КП отправлено, Выигран, Проигран, Принят…' },
        kind: { type: 'string', enum: ['Запрос предложений', 'Тендер'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      }, [], RO,
      async (api, a) => {
        const d = await api('GET', '/api/sales');
        let list = (d.requests || []).slice();
        const q = norm(a.query);
        if (q) list = list.filter((x) => norm([x.numZp, x.customer, x.name, x.owner, x.contact, x.note].join(' ')).includes(q));
        if (a.status) list = list.filter((x) => norm(x.status) === norm(a.status));
        if (a.kind) list = list.filter((x) => norm(x.kind) === norm(a.kind));
        list.sort((x, y) => String(y.numZp).localeCompare(String(x.numZp), 'ru'));
        return { total: list.length, items: list.slice(0, a.limit || 30).map(brief) };
      }),

    tool('zp_get', 'Карточка запроса заказчика',
      'Полная карточка ЗП: заказчик и контакт, предмет и количество, классификация, срок подачи, статус, КП (номер, дата, сумма, результат), выигранная часть, связанные заказы и ПЗ, примечание, история.',
      { zp: { type: 'string', description: 'Номер ЗП-ГГГГ-NNN (или id)' } }, ['zp'], RO,
      async (api, a) => {
        const { z } = await findZp(api, a.zp);
        return {
          ...brief(z), id: z.id, contact: z.contact || null, source: z.source || null, dealNature: z.dealNature || null, foreignTrade: !!z.ved,
          products: z.products || [], productLine: z.line || null, qty: z.qty || null, note: z.note || null, wonNote: z.wonNote || null,
          feasibility: z.lov || null, orderGateOpen: !!(z.gates && z.gates.order),
          productionOrders: (z.prodOrders || []).map((o) => ({ numPz: o.numPz, status: o.status, plan: o.plan || null })),
          history: (Array.isArray(z.history) ? z.history : []).slice(-20),
        };
      }),

    tool('zp_create', 'Зарегистрировать запрос заказчика',
      'Регистрирует новый запрос ЗП (Ф.1–З.1). Перед созданием ищет дубли: тот же заказчик с похожим наименованием за 60 дней — если нашёл, НЕ создаёт и возвращает их; повторяйте с allowDuplicate=true только после подтверждения человеком. Заказчика берите из counterparties_search.',
      {
        customer: { type: 'string', description: 'Заказчик — как в реестре контрагентов' },
        name: { type: 'string', description: 'Наименование запроса (что просят)' },
        received: { type: 'string', description: 'Дата поступления ГГГГ-ММ-ДД (по умолчанию сегодня)' },
        kind: { type: 'string', enum: ['Запрос предложений', 'Тендер'], default: 'Запрос предложений' },
        deadline: { type: 'string', description: 'Срок подачи (для тендера) «ГГГГ-ММ-ДД ЧЧ:ММ»' },
        tenderUrl: { type: 'string' }, contact: { type: 'string', description: 'Контактное лицо' }, contacts: { type: 'string', description: 'Телефон / email' },
        source: { type: 'string', description: 'Откуда пришёл запрос (почта, площадка, звонок…)' },
        dealNature: { type: 'string', description: 'Характер сделки (как в справочнике портала)' },
        productClass: { type: 'array', items: { type: 'string' }, description: 'Коды продуктовых подгрупп' },
        qty: { type: 'number', minimum: 0 }, unit: { type: 'string' }, owner: { type: 'string', description: 'Ответственный' },
        ism: { type: 'string', enum: ['ДА', 'НЕТ', 'ЧАСТИЧНО'], default: 'ДА', description: 'В области ИСМ' },
        note: { type: 'string' },
        allowDuplicate: { type: 'boolean', default: false },
      }, ['customer', 'name'], RW,
      async (api, a, ctx) => {
        if (!a.allowDuplicate) {
          const d = await api('GET', '/api/sales');
          const since = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
          const c = norm(a.customer), n = norm(a.name);
          const dups = (d.requests || []).filter((x) => String(x.received || '') >= since && norm(x.customer) === c && (norm(x.name).includes(n) || n.includes(norm(x.name))));
          if (dups.length) return { created: false, reason: 'Похожий запрос этого заказчика уже есть — проверьте, не дубль ли это. Создать всё равно можно с allowDuplicate=true после подтверждения человеком.', possibleDuplicates: dups.map(brief) };
        }
        const { allowDuplicate, ...body } = a;
        const j = await api('POST', '/api/sales/requests/create', { ...body, acceptedBy: ctx.user.fio });
        return { created: true, numZp: j.numZp, id: j.id, folderCreated: !!j.folderCreated };
      }),

    tool('zp_update', 'Обновить запрос заказчика',
      'Меняет статус, ответственного, сумму КП (если КП делали вне портала) или примечание ЗП. appendNote дописывает строку к примечанию с датой, не затирая его.',
      {
        zp: { type: 'string' }, status: { type: 'string' }, owner: { type: 'string' },
        sumKp: { type: 'number', minimum: 0, description: 'Сумма КП, руб.' },
        note: { type: 'string', description: 'Заменить примечание целиком' }, appendNote: { type: 'string', description: 'Дописать к примечанию' },
      }, ['zp'], RW,
      async (api, a, ctx) => {
        const { z } = await findZp(api, a.zp);
        const body = { zp: z.numZp };
        for (const k of ['status', 'owner', 'sumKp', 'note']) if (a[k] != null && a[k] !== '') body[k] = a[k];
        if (a.appendNote && body.note == null) body.note = [String(z.note || '').trim(), `[${new Date().toISOString().slice(0, 10)} ${ctx.user.fio}, ИИ] ${a.appendNote}`].filter(Boolean).join('\n');
        const j = await api('POST', '/api/sales/requests/update', body);
        return { ok: true, numZp: z.numZp, changed: Object.keys(j.patch || {}) };
      }),

    tool('zp_set_kp_result', 'Зафиксировать результат КП',
      `Фиксирует исход КП по запросу: ${KP_RESULTS.join(', ')}; пустая строка — снять результат. Портал сам переводит статус ЗП (например, «Проиграли» → «Проигран»). Для «Выиграли частично» укажите wonPartSum.`,
      {
        zp: { type: 'string' }, result: { type: 'string', enum: [...KP_RESULTS, ''] },
        wonPartSum: { type: 'number', minimum: 0, description: 'Сумма выигранной части, руб. (для «Выиграли частично»)' },
        wonPartNote: { type: 'string', description: 'Объём/примечание выигранной части' },
      }, ['zp', 'result'], RW,
      async (api, a) => {
        const { z } = await findZp(api, a.zp);
        await api('POST', '/api/sales/kp/result', { zp: z.numZp, result: a.result, wonPartSum: a.wonPartSum, wonPartNote: a.wonPartNote });
        const { z: after } = await findZp(api, z.numZp);
        return { ok: true, numZp: z.numZp, result: a.result || null, status: after.status };
      }),

    tool('counterparties_search', 'Найти контрагента',
      'Поиск в реестре контрагентов (заказчики, поставщики, партнёры) по названию, ИНН, региону; возвращает роли, контакты и сколько у контрагента запросов/заказов.',
      {
        query: { type: 'string' }, role: { type: 'string', enum: ['Заказчик', 'Поставщик', 'Партнёр'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      }, [], RO,
      async (api, a) => {
        const d = await api('GET', '/api/counterparties');
        const q = norm(a.query);
        let list = (d.counterparties || []).filter((c) => !q || norm([c.name, c.shortName, c.inn, c.region, c.industry].join(' ')).includes(q));
        if (a.role) list = list.filter((c) => (c.roles || []).includes(a.role));
        return { total: list.length, items: list.slice(0, a.limit || 20).map((c) => ({ counterpartyId: c.id, name: c.name, shortName: c.shortName || null, inn: c.inn || null, kpp: c.kpp || null, region: c.region || null, roles: c.roles || [], contactPersons: (c.contactsList || []).map((p) => ({ contactId: p.id, name: p.name, position: p.position || null, phone: p.phone || null, email: p.email || null, primary: !!p.primary })), salesRequests: (c.counts && c.counts.salesRequests) || 0, salesOrders: (c.counts && c.counts.salesOrders) || 0 })) };
      }),

    tool('counterparty_create', 'Завести контрагента',
      'Заводит контрагента в реестр. Если такой ИНН уже есть — новый не создаётся, существующему добавляется роль. Без ИНН сначала проверьте counterparties_search, чтобы не завести дубль по названию.',
      {
        name: { type: 'string', description: 'Полное наименование: ООО «…»' }, inn: { type: 'string', pattern: '^\\d{10}(\\d{2})?$' }, kpp: { type: 'string' },
        shortName: { type: 'string' }, role: { type: 'string', enum: ['Заказчик', 'Поставщик', 'Партнёр'], default: 'Заказчик' },
        region: { type: 'string' }, note: { type: 'string' },
        contactPersons: { type: 'array', items: CONTACT_SCHEMA, description: 'Контактные лица — заводятся вместе с контрагентом' },
      }, ['name'], RW,
      async (api, a) => {
        if (!a.inn) {
          const d = await api('GET', '/api/counterparties'); const n = norm(a.name);
          const same = (d.counterparties || []).filter((c) => norm(c.name) === n || (c.shortName && norm(c.shortName) === n));
          if (same.length) return { created: false, reason: 'Контрагент с таким названием уже есть.', existing: same.map((c) => ({ counterpartyId: c.id, name: c.name, inn: c.inn || null, roles: c.roles || [] })) };
        }
        const { contactPersons, ...cp } = a;
        const primary = (contactPersons || []).find((p) => p.primary) || (contactPersons || [])[0];
        const j = await api('POST', '/api/counterparties/create', { ...cp, contact: primary ? primary.name : undefined, contacts: primary ? [primary.phone, primary.email].filter(Boolean).join(', ') : undefined });
        const added = [];
        for (const p of contactPersons || []) { try { const r = await api('POST', '/api/counterparty/contact', { counterpartyId: j.id, ...p }); added.push({ contactId: r.id, name: p.name }); } catch (e) { added.push({ name: p.name, error: e.message }); } }
        return { created: !j.existed, existed: !!j.existed, counterpartyId: j.id, name: j.name, inn: j.inn || null, roles: j.roles || null, contactPersons: added };
      }),

    tool('counterparty_add_contact', 'Добавить контактное лицо',
      'Добавляет контактное лицо контрагенту (ФИО, должность, телефон, email, «основной»). Контрагента укажите counterpartyId из counterparties_search или ИНН. Если человек с таким ФИО у контрагента уже есть — не дублирует, а возвращает его (правьте через counterparty_update_contact).',
      {
        counterpartyId: { type: 'integer' }, inn: { type: 'string', description: 'ИНН контрагента — если нет counterpartyId' },
        name: { type: 'string', description: 'ФИО' }, position: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, primary: { type: 'boolean' },
      }, ['name'], RW,
      async (api, a) => {
        const d = await api('GET', '/api/counterparties');
        const c = (d.counterparties || []).find((x) => (a.counterpartyId != null && String(x.id) === String(a.counterpartyId)) || (a.inn && String(x.inn) === String(a.inn).trim()));
        if (!c) throw new Error('Контрагент не найден — укажите counterpartyId из counterparties_search или ИНН.');
        const same = (c.contactsList || []).find((p) => norm(p.name) === norm(a.name));
        if (same) return { added: false, reason: 'Такой контакт у контрагента уже есть.', contact: { contactId: same.id, name: same.name, position: same.position || null, phone: same.phone || null, email: same.email || null, primary: !!same.primary } };
        const { counterpartyId, inn, ...p } = a;
        const r = await api('POST', '/api/counterparty/contact', { counterpartyId: c.id, ...p });
        return { added: true, counterparty: c.name, contactId: r.id };
      }),

    tool('counterparty_update_contact', 'Изменить контактное лицо',
      'Правит контактное лицо контрагента (contactId из counterparties_search → contactPersons).',
      { contactId: { type: 'integer' }, name: { type: 'string' }, position: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, primary: { type: 'boolean' } }, ['contactId'], RW,
      async (api, a) => {
        const { contactId, ...p } = a;
        await api('PATCH', '/api/counterparty/contact', { id: contactId, ...p });
        return { ok: true, contactId, changed: Object.keys(p) };
      }),
  ];
}

// ── протокол ────────────────────────────────────────────────────────────────
// deps: { port, authenticate(req) → { sid, user:{id,fio}, tokenId } | null }
export function createMcpHandler(deps) {
  const tools = [...procurementTools(), ...salesTools()];
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
