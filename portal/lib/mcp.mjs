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
const SERVER_INFO = { name: 'pbs-portal', title: 'Портал ИСМ ПБС', version: '1.5.0' };
const INSTRUCTIONS = [
  'Портал ИСМ ПБС (производство ПБС). Разделы: «Закупки» — заявки на закупку (ЗнЗ) с позициями, поставщики, счета; «Продажи» — запросы заказчиков (ЗП), КП и его результат, контрагенты; «Техподготовка и цех» — оборудование, инструмент и оснастка, каталог державок/пластин/кулачков, карты наладки (КН), маршрутные карты (МК), металл, задания участков, производственные заказы (ПЗ), КД.',
  'МК и карты наладки: ИИ составляет и правит только ЧЕРНОВИКИ (setup_card_save, route_save), копии — всегда новый черновик (setup_card_copy, route_copy). Перед составлением МК посмотрите route_catalog (типы операций) и похожие МК (routes_search/route_get); карту наладки — по карточке станка (equipment_get) и каталогу (tool_catalog_search). Отправку на согласование и утверждение делает человек в портале.',
  'Инструменты доступны по правам владельца токена: если раздел у человека закрыт в портале, инструмент вернёт «нет доступа» — это нормально, скажите об этом пользователю.',
  'Номера: ЗнЗ-ГГГГ-NNN (заявка на закупку), ПЗ-ГГГГ-NNN (производственный заказ), ЗП-ГГГГ-NNN (запрос от заказчика).',
  'Одна ЗнЗ может содержать несколько позиций — материалы под один заказ заводите ОДНОЙ заявкой с позициями, а не отдельными заявками.',
  'Перед созданием ЗнЗ znz_create сам ищет дубли (тот же источник и похожие позиции) и останавливается — покажите их человеку и спросите, прежде чем повторять с allowDuplicate.',
  'Файлы: если пользователь бросил файл в чат и просит приложить его к ЗнЗ/ЗП — вызовите znz_attach_file/zp_attach_file с точным именем файла в fileName: локальный мост найдёт его на компьютере пользователя.',
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

// ── K-353: файлы — общее для ЗнЗ и ЗП ───────────────────────────────────────
// Источник файла: contentBase64+fileName (так их присылает локальный мост, прочитав файл с диска
// пользователя по localPath или найдя по имени в «Загрузках»/«Рабочем столе»/«Документах») или url
// (портал скачивает сам). localPath/имя без содержимого при прямом HTTP-подключении не сработают.
const FILE_MAX = 20 * 1024 * 1024;
const fileSourceProps = {
  fileName: { type: 'string', description: 'Имя файла. Без localPath/url локальный мост сам найдёт файл с таким именем в «Загрузках», на «Рабочем столе» или в «Документах» — удобно, когда пользователь бросил файл в чат (передайте его точное имя)' },
  localPath: { type: 'string', description: 'Полный путь к файлу на компьютере пользователя (читает локальный мост)' },
  url: { type: 'string', description: 'Ссылка https на файл — портал скачает его сам' },
  contentBase64: { type: 'string', description: 'Содержимое файла в base64 — только для маленьких файлов' },
};
function isPrivateHost(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.ts.net')) return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|fc|fd)/.test(h);
}
async function resolveFileSource(a) {
  if (a.contentBase64) {
    const buf = Buffer.from(String(a.contentBase64), 'base64');
    if (!buf.length) throw new Error('Пустой файл.');
    if (!a.fileName) throw new Error('Укажите fileName вместе с contentBase64.');
    return { buf, name: a.fileName };
  }
  if (a.url) {
    let u; try { u = new URL(a.url); } catch { throw new Error('Некорректная ссылка url.'); }
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) throw new Error('По ссылке можно взять только файл из интернета (http/https, не внутренний адрес).');
    const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`Не удалось скачать файл: HTTP ${r.status}.`);
    const len = Number(r.headers.get('content-length') || 0); if (len > FILE_MAX) throw new Error('Файл больше 20 МБ.');
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > FILE_MAX) throw new Error('Файл больше 20 МБ.');
    const cd = r.headers.get('content-disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
    const fromUrl = decodeURIComponent(u.pathname.split('/').pop() || '');
    return { buf, name: a.fileName || (m ? decodeURIComponent(m[1]) : '') || fromUrl || 'файл' };
  }
  if (a.localPath || a.fileName) throw new Error('Файл с компьютера пользователя передаёт локальный мост портала (расширение Claude Desktop или мост для Claude Code/Qwen Code). При прямом подключении по HTTP дайте url.');
  throw new Error('Укажите источник файла: fileName/localPath (через мост) или url.');
}
const fileList = (j, base, kindParam, num) => ({
  folder: j.folder || null, path: j.path || null, stages: j.stages || [], warning: j.warning || null,
  files: (j.files || []).map((f) => ({ stage: f.stage || '(корень)', name: f.name, sizeKb: f.size != null ? Math.round(f.size / 1024) : null, link: base ? `${base}${kindParam}${encodeURIComponent(num)}&rel=${encodeURIComponent(f.rel)}` : null })),
});

// ── инструменты раздела «Закупки» ───────────────────────────────────────────
function procurementTools(deps) {
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

    tool('znz_files', 'Файлы заявки на закупку',
      'Список файлов в папке ЗнЗ на NAS по этапам (заявка, предложения и счета, сертификаты, входной контроль, переписка) со ссылками для открытия в портале.',
      { znz: { type: 'string' } }, ['znz'], RO,
      async (api, a) => {
        const { z } = await findZnz(api, a.znz);
        const j = await api('GET', '/api/procurement/znz/rec-files?znz=' + encodeURIComponent(z.numZnz));
        return { znz: z.numZnz, ...fileList(j, deps.portalBase(), '/api/procurement/znz/rec-file?znz=', z.numZnz) };
      }),

    tool('znz_attach_file', 'Приложить файл к заявке на закупку',
      `Кладёт файл в папку ЗнЗ на NAS, в выбранный этап: ${deps.stages.znz.join(', ')}. Источник — fileName (мост найдёт файл в «Загрузках»/«Рабочем столе»/«Документах»), localPath или url. До 20 МБ. ZIP распаковывается. Счёт для оплаты по-прежнему заводится в карточке ЗнЗ (с распознаванием) — здесь только файл в папку.`,
      { znz: { type: 'string' }, stage: { type: 'string', enum: deps.stages.znz }, ...fileSourceProps }, ['znz', 'stage'], RW,
      async (api, a) => {
        const { z } = await findZnz(api, a.znz);
        const f = await resolveFileSource(a);
        const j = await api.upload('/api/procurement/znz/rec-upload', { znz: z.numZnz, stage: a.stage }, f.name, f.buf);
        return { ok: true, znz: z.numZnz, stage: a.stage, saved: j.saved || [], skipped: j.skipped || [] };
      }),
  ];
}

// ── K-351: инструменты раздела «Продажи» ────────────────────────────────────
const CONTACT_SCHEMA = { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', description: 'ФИО' }, position: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, primary: { type: 'boolean', description: 'Основной контакт' } } };
const KP_RESULTS = ['Отправлено', 'Согласовано', 'Выиграли', 'Выиграли частично', 'Проиграли', 'Отказались'];
function salesTools(deps) {
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

    tool('zp_files', 'Файлы запроса заказчика',
      'Список файлов в папке ЗП на NAS по этапам (запрос, оценка, КП, договор, оплата, переписка) со ссылками для открытия в портале.',
      { zp: { type: 'string' } }, ['zp'], RO,
      async (api, a) => {
        const { z } = await findZp(api, a.zp);
        const j = await api('GET', '/api/sales/files?zp=' + encodeURIComponent(z.numZp));
        return { zp: z.numZp, ...fileList(j, deps.portalBase(), '/api/sales/file?zp=', z.numZp) };
      }),

    tool('zp_attach_file', 'Приложить файл к запросу заказчика',
      `Кладёт файл в папку ЗП на NAS, в выбранный этап: ${deps.stages.zp.join(', ')}. Источник — fileName (мост найдёт файл в «Загрузках»/«Рабочем столе»/«Документах»), localPath или url. До 20 МБ. ZIP распаковывается.`,
      { zp: { type: 'string' }, stage: { type: 'string', enum: deps.stages.zp }, ...fileSourceProps }, ['zp', 'stage'], RW,
      async (api, a) => {
        const { z } = await findZp(api, a.zp);
        const f = await resolveFileSource(a);
        const j = await api.upload('/api/sales/upload', { zp: z.numZp, stage: a.stage }, f.name, f.buf);
        return { ok: true, zp: z.numZp, stage: a.stage, saved: j.saved || [], skipped: j.skipped || [] };
      }),
  ];
}

// ── K-354: инструменты «Техподготовка и цех» (роли Инструментальщик / Технолог / Цех) ──
// Оборудование, инструмент и оснастка, каталог державок/пластин/кулачков, карты наладки, маршрутные
// карты (МК), металл, задания участков и заказы (ПЗ), КД. Запись — только безопасное: движение и
// карточка инструмента, привязка карты наладки к операции МК, ход задания на участке. Создание и правка
// самих МК и карт наладки, согласование, удаление — только в интерфейсе.
function techTools(deps) {
  const q = (x) => norm(x);
  const like = (obj, fields, query) => !query || q(fields.map((f) => obj[f]).join(' ')).includes(q(query));
  const slim = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null && o[k] !== '' && !(Array.isArray(o[k]) && !o[k].length)).map((k) => [k, o[k]]));
  const lim = (a, n) => (a || []).slice(0, n || 30);
  const must = (d, label, ref) => { if (!d || !d.item) throw new Error(`${label} «${ref}» не найден(а).`); return d.item; };
  async function findBy(api, path, key, ref, fields, label) {
    const d = await api('GET', path);
    const s = String(ref == null ? '' : ref).trim();
    const arr = d[key] || [];
    const hit = arr.find((x) => fields.some((f) => String(x[f] ?? '').toLowerCase() === s.toLowerCase()));
    if (!hit) throw new Error(`${label} «${s}» не найден(а).`);
    return hit;
  }
  const EQ_BRIEF = ['id', 'invNo', 'name', 'model', 'category', 'subtype', 'status', 'responsible', 'sectionName', 'location', 'isCnc', 'cncControl', 'to1Next', 'inspectionNext', 'taskCount'];
  const TOOL_BRIEF = ['id', 'code', 'name', 'type', 'category', 'subcategory', 'unit', 'balance', 'minStock', 'belowMin', 'cell', 'where', 'status', 'invNo', 'calNext', 'calOverdue', 'responsible'];
  const TASK_BRIEF = ['id', 'num', 'title', 'status', 'priority', 'sectionCode', 'sectionName', 'opNum', 'mk', 'partName', 'drawing', 'qtyPlan', 'factQty', 'plan', 'orderDue', 'executors', 'equip', 'normTime', 'setupCardNo', 'numPz', 'posNo', 'startedAt', 'finishedAt', 'pauseReason'];
  const allTasks = (board) => (board.orders || []).flatMap((o) => (o.tasks || []).map((t) => ({ ...t, numPz: t.numPz || o.numPz })));

  return [
    tool('equipment_search', 'Найти оборудование',
      'Станки и оборудование: инв. №, модель, статус, ответственный, участок, ЧПУ, ближайшее ТО/поверка, сколько заданий.',
      { query: { type: 'string', description: 'Инв. №, название, модель, ответственный' }, cncOnly: { type: 'boolean' }, status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, [], RO,
      async (api, a) => {
        const d = await api('GET', '/api/equipment');
        let list = (d.items || []).filter((x) => like(x, ['invNo', 'name', 'model', 'responsible', 'sectionName', 'subtype'], a.query));
        if (a.cncOnly) list = list.filter((x) => x.isCnc);
        if (a.status) list = list.filter((x) => q(x.status) === q(a.status));
        return { total: list.length, items: lim(list, a.limit).map((x) => slim(x, EQ_BRIEF)) };
      }),

    tool('equipment_get', 'Карточка оборудования',
      'Полная карточка станка: ТТХ (головка, патрон, ЧПУ), ТО, документы, текущие задания, карты наладки этого станка и последние фактические наладки.',
      { equipment: { type: 'string', description: 'Инв. № (ПБС-ОБ-021) или id' } }, ['equipment'], RO,
      async (api, a) => {
        const d = await api('GET', '/api/equipment/item?id=' + encodeURIComponent(a.equipment));
        const it = must(d, 'Оборудование', a.equipment);
        const [cards, runs] = await Promise.all([api('GET', '/api/setup-cards'), api('GET', '/api/setup-cards/runs?machineId=' + encodeURIComponent(it.id)).catch(() => ({ runs: [] }))]);
        return {
          ...slim(it, Object.keys(it).filter((k) => k !== 'docs')), docs: it.docs || d.docs || null,
          tasks: lim(d.tasks, 30),
          setupCards: (cards.items || []).filter((c) => String(c.machineId) === String(it.id)).map((c) => slim(c, ['id', 'no', 'name', 'status', 'part', 'operationKind', 'date'])),
          recentSetupRuns: lim(runs.runs, 10).map((r) => slim(r, ['when', 'who', 'no', 'part', 'note'])),
        };
      }),

    tool('tools_search', 'Найти инструмент и оснастку',
      'Реестр инструмента, оснастки и СИ: код ИН-…, наименование, категория, остаток и минимум, ячейка/где находится, статус, поверка. Можно отобрать только позиции ниже минимума.',
      { query: { type: 'string' }, category: { type: 'string' }, belowMinOnly: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, [], RO,
      async (api, a) => {
        const d = await api('GET', '/api/tools');
        let list = (d.items || []).filter((x) => like(x, ['code', 'name', 'category', 'subcategory', 'gost', 'cell', 'invNo', 'code1c'], a.query));
        if (a.category) list = list.filter((x) => q(x.category) === q(a.category));
        if (a.belowMinOnly) list = list.filter((x) => x.belowMin);
        return { total: list.length, items: lim(list, a.limit).map((x) => slim(x, TOOL_BRIEF)), belowMinTotal: (d.items || []).filter((x) => x.belowMin).length };
      }),

    tool('tool_get', 'Карточка инструмента',
      'Позиция инструмента/оснастки и журнал движений (последние 30): кто, когда, сколько, основание, остаток после.',
      { tool: { type: 'string', description: 'Код ИН-NNNN или id' } }, ['tool'], RO,
      async (api, a) => {
        const d = await api('GET', '/api/tools/item?id=' + encodeURIComponent(a.tool));
        must(d, 'Позиция инструмента', a.tool);
        return { item: d.item, balance: d.balance, belowMin: !!d.belowMin, journal: (d.journal || []).slice(-30).reverse() };
      }),

    tool('tool_catalog_search', 'Каталог державок, пластин и кулачков',
      'Поиск в каталоге: пластины (ISO, сплав, режимы ap/f/vc), державки (ISO и совместимые пластины), комплекты кулачков (под какой патрон/станок, состояние).',
      { kind: { type: 'string', enum: ['inserts', 'holders', 'jaws'] }, query: { type: 'string', description: 'ISO-код, производитель, сплав, № комплекта' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, ['kind'], RO,
      async (api, a) => {
        if (a.kind === 'jaws') {
          const d = await api('GET', '/api/chuck-jaws');
          const list = (d.items || []).filter((x) => like(x, ['setNo', 'jawType', 'compat', 'station', 'chuckInv', 'location', 'material'], a.query));
          return { total: list.length, items: lim(list, a.limit).map((x) => slim(x, ['id', 'setNo', 'jawType', 'jawCount', 'clampDia', 'material', 'compat', 'station', 'chuckInv', 'condition', 'location', 'boredFor', 'note'])) };
        }
        const d = await api('GET', '/api/tool-catalog/' + a.kind);
        const list = (d.items || []).filter((x) => like(x, ['iso', 'maker', 'makerCode', 'grade', 'holderType', 'material', 'isoGroups'], a.query));
        return { total: list.length, items: lim(list, a.limit).map((x) => ({ ...slim(x, ['id', 'iso', 'grade', 'chipbreaker', 'holderType', 'maker', 'makerCode', 'isoGroups', 'ap', 'fn', 'vc', 'material', 'procType', 'status', 'note']), ...(x.compat ? { compatibleInserts: x.compat.map((c) => c.iso + (c.grade ? ' ' + c.grade : '')) } : {}) })) };
      }),

    tool('setup_cards_search', 'Найти карты наладки',
      'Карты наладки (КН): №, станок, деталь, статус, вид операции, к каким операциям МК привязаны.',
      { query: { type: 'string', description: '№ КН, деталь, станок' }, machine: { type: 'string', description: 'Инв. № или название станка' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, [], RO,
      async (api, a) => {
        const d = await api('GET', '/api/setup-cards');
        let list = (d.items || []).filter((x) => like(x, ['no', 'name', 'part', 'machine', 'author'], a.query));
        if (a.machine) list = list.filter((x) => q([x.machine, x.machineModel].join(' ')).includes(q(a.machine)));
        return { total: list.length, items: lim(list, a.limit).map((x) => ({ ...slim(x, ['id', 'no', 'name', 'status', 'machine', 'part', 'operationKind', 'author', 'date']), usedIn: (x.usedIn || []).map((u) => `${u.mk} оп.${u.opN}`) })) };
      }),

    tool('setup_card_get', 'Карта наладки',
      'Полная карта наладки: станок и головка, позиции инструмента (державка, пластина, вылет, корректоры), патрон и кулачки, нулевая точка, привязки к МК, фактические наладки, история.',
      { card: { type: 'string', description: '№ КН или id' } }, ['card'], RO,
      async (api, a) => {
        const d = await api('GET', '/api/setup-card?id=' + encodeURIComponent(a.card));
        must(d, 'Карта наладки', a.card);
        return { item: d.item, lines: (d.lines || []).map((l) => slim(l, ['pos', 'toolPos', 'toolKind', 'holderIso', 'insertIso', 'insertGrade', 'overhang', 'lenX', 'lenZ', 'radius', 'width', 'edgePos', 'params', 'note'])) };
      }),

    tool('setup_card_link', 'Привязать карту наладки к операции МК',
      'Привязывает (или отвязывает, unlink=true) карту наладки к операции маршрутной карты. Если к операции уже привязана другая КН — портал откажет: сначала отвяжите её.',
      { card: { type: 'string', description: '№ КН или id' }, mk: { type: 'string', description: '№ МК, как в route_get' }, opN: { type: 'string', description: '№ операции' }, unlink: { type: 'boolean', default: false } }, ['card', 'mk', 'opN'], RW,
      async (api, a) => {
        const d = await api('GET', '/api/setup-card?id=' + encodeURIComponent(a.card));
        must(d, 'Карта наладки', a.card);
        const j = await api('POST', '/api/setup-card/link', { id: d.item.id, mk: a.mk, opN: String(a.opN), unlink: !!a.unlink });
        return { ok: true, card: j.no, mk: j.mk, opN: j.opN, linked: j.linked };
      }),

    tool('routes_search', 'Найти маршрутные карты',
      'Маршрутные карты (МК): №, изделие и обозначение, статус МК, автор, согласующий, число операций, кооперация, изменения КД.',
      { query: { type: 'string', description: '№ МК, наименование, обозначение' }, status: { type: 'string', description: 'Статус МК' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, [], RO,
      async (api, a) => {
        const d = await api('GET', '/api/routes');
        let list = (d.routes || []).filter((x) => like(x, ['mk', 'name', 'designation', 'author', 'productType'], a.query));
        if (a.status) list = list.filter((x) => q(x.statusMk || x.status) === q(a.status));
        return { total: list.length, items: lim(list, a.limit).map((x) => slim(x, ['id', 'mk', 'type', 'name', 'designation', 'revision', 'statusMk', 'author', 'approverName', 'opCount', 'hasCoop', 'kdChanged', 'variant', 'isMain'])) };
      }),

    tool('route_get', 'Маршрутная карта',
      'МК целиком: заготовка и материал, операции по порядку (участок, оборудование, параметры, норма времени, оснастка, карта наладки, файлы УП ЧПУ, кооперация, задания), комплектующие.',
      { mk: { type: 'string', description: '№ МК или id' } }, ['mk'], RO,
      async (api, a) => {
        const r = await findBy(api, '/api/routes', 'routes', a.mk, ['mk', 'id'], 'МК');
        const d = await api('GET', '/api/route?id=' + encodeURIComponent(r.id));
        const rt = d.route || {};
        return {
          route: slim(rt, ['id', 'mk', 'type', 'name', 'designation', 'productType', 'revision', 'statusMk', 'material', 'author', 'blankText', 'bomText', 'kdChanged', 'normsFixed']),
          operations: (d.operations || []).map((o) => ({ ...slim(o, ['n', 'name', 'opType', 'section', 'equip', 'params', 'norm', 'tooling', 'setupCard', 'control', 'comment', 'coopText', 'planText']), ncFiles: (o.ncFiles || []).map((f) => (f && (f.name || f.rel)) || f), tasks: (o.tasks || []).map((t) => `${t.num} ${t.status}`) })),
          components: d.components || [],
        };
      }),

    tool('metal_search', 'Остатки металла и заготовки',
      'Металл на складе: вид проката, марка, размер, остаток/резерв/доступно, ячейка; деловые остатки. С rollType+grade+sizeFrom подбирает заготовку (точный размер и больше).',
      { query: { type: 'string', description: 'Марка, размер, код МС-…' }, rollType: { type: 'string', description: 'Лист, Круг, Труба…' }, grade: { type: 'string' }, sizeFrom: { type: 'number', description: 'Для подбора заготовки: минимальный размер (толщина/диаметр), мм' }, inStockOnly: { type: 'boolean', default: true }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, [], RO,
      async (api, a) => {
        if (a.rollType && a.grade && a.sizeFrom) {
          const d = await api('GET', `/api/metal/find-blank?rollType=${encodeURIComponent(a.rollType)}&grade=${encodeURIComponent(a.grade)}&sizeFrom=${encodeURIComponent(a.sizeFrom)}`);
          return { mode: 'подбор заготовки', candidates: d.candidates || [], remnants: d.remnants || [] };
        }
        const d = await api('GET', '/api/metal');
        let list = (d.items || []).filter((x) => like(x, ['code', 'grade', 'rollType', 'size', 'gost', 'cell', 'name1c'], a.query));
        if (a.rollType) list = list.filter((x) => q(x.rollType) === q(a.rollType));
        if (a.grade) list = list.filter((x) => q(x.grade).includes(q(a.grade)));
        if (a.inStockOnly !== false) list = list.filter((x) => Number(x.balance) > 0);
        const rem = (d.remnants || []).filter((x) => like(x, ['code', 'grade', 'rollType', 'sizes', 'location'], a.query) && (!a.rollType || q(x.rollType) === q(a.rollType)));
        return { total: list.length, items: lim(list, a.limit).map((x) => slim(x, ['id', 'code', 'rollType', 'grade', 'size', 'unit', 'balance', 'reserved', 'available', 'cell', 'warehouse', 'belowMin'])), remnants: lim(rem, 20).map((x) => slim(x, ['code', 'rollType', 'grade', 'sizes', 'weight', 'status', 'location'])) };
      }),

    tool('tasks_search', 'Задания участков',
      'Задания (операции по МК) на участках: статус, участок, деталь и чертёж, количество план/факт, срок, оборудование, норма, карта наладки, ПЗ. Удобно для «что сейчас в очереди на участке», «что в работе по ПЗ-…».',
      { section: { type: 'string', description: 'Код или название участка' }, status: { type: 'string', enum: ['В очереди', 'В работе', 'Выполнено', 'Приостановлено'] }, numPz: { type: 'string' }, query: { type: 'string', description: 'Деталь, чертёж, № МК, оборудование' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, [], RO,
      async (api, a) => {
        const d = await api('GET', '/api/board');
        let list = allTasks(d).filter((t) => like(t, ['partName', 'drawing', 'mk', 'title', 'equip', 'num'], a.query));
        if (a.section) list = list.filter((t) => q([t.sectionCode, t.sectionName, t.section].join(' ')).includes(q(a.section)));
        if (a.status) list = list.filter((t) => t.status === a.status);
        if (a.numPz) list = list.filter((t) => q(t.numPz) === q(a.numPz));
        list.sort((x, y) => (Number(x.queueOrder) || 9999) - (Number(y.queueOrder) || 9999));
        return { total: list.length, items: lim(list, a.limit).map((t) => slim(t, TASK_BRIEF)) };
      }),

    tool('task_update', 'Отметить ход задания',
      'Ход задания на участке: статус (В очереди / В работе / Выполнено / Приостановлено), количество факт, время факт (ч), причина паузы, самоконтроль, примечание. «Выполнено» ставит дату факта; статус ПЗ портал пересчитает сам. Результат ОТК здесь не ставится.',
      { taskId: { type: 'integer', description: 'id из tasks_search' }, status: { type: 'string', enum: ['В очереди', 'В работе', 'Выполнено', 'Приостановлено'] }, factQty: { type: 'number', minimum: 0 }, factTime: { type: 'number', minimum: 0, description: 'Время факт., ч' }, pauseReason: { type: 'string' }, selfControl: { type: 'string' }, note: { type: 'string' } }, ['taskId'], RW,
      async (api, a, ctx) => {
        const { taskId, ...p } = a;
        if (!Object.keys(p).length) throw new Error('Нечего менять: укажите статус, количество, время или примечание.');
        if (p.note) p.note = `${p.note} [${ctx.user.fio}, ИИ]`;
        const j = await api('POST', '/api/task/update', { id: taskId, ...p });
        return { ok: true, taskId, changed: Object.keys(j.patch || p) };
      }),

    tool('orders_search', 'Производственные заказы (ПЗ)',
      'ПЗ: заказчик, тип, статус, приоритет, плановый срок, позиции (изделие, чертёж, кол-во, статус, МК) и сводка заданий по статусам.',
      { query: { type: 'string', description: '№ ПЗ, заказчик, изделие' }, status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, [], RO,
      async (api, a) => {
        const d = await api('GET', '/api/board');
        let list = (d.orders || []).filter((o) => like({ ...o, pos: (o.positions || []).map((p) => p.name + ' ' + p.drawing).join(' ') }, ['numPz', 'customer', 'brief', 'pos', 'numZp'], a.query));
        if (a.status) list = list.filter((o) => q(o.status) === q(a.status));
        list.sort((x, y) => String(y.numPz).localeCompare(String(x.numPz), 'ru'));
        return { total: list.length, items: lim(list, a.limit).map((o) => {
          const byStatus = {}; for (const t of o.tasks || []) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
          return { ...slim(o, ['numPz', 'customer', 'orderType', 'status', 'priority', 'plan', 'numZp', 'brief']), positions: (o.positions || []).map((p) => slim(p, ['numPos', 'name', 'drawing', 'qty', 'unit', 'status', 'dateReady', 'mk'])), tasks: byStatus };
        }) };
      }),

    tool('kd_search', 'Найти КД (чертежи)',
      'Конструкторская документация: обозначение, наименование, материал, литера, статус, ревизия, файлы (чертёж/СБ/СП) и в каких МК используется.',
      { query: { type: 'string', description: 'Обозначение или наименование детали' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, ['query'], RO,
      async (api, a) => {
        const d = await api('GET', '/api/design');
        const list = (d.kd || []).filter((x) => like(x, ['docNo', 'name', 'material', 'projectNo'], a.query));
        const base = deps.portalBase();
        return { total: list.length, items: lim(list, a.limit).map((x) => ({ ...slim(x, ['docNo', 'name', 'kind', 'material', 'litera', 'status', 'rev', 'projectNo', 'toProduction', 'qty']), files: (x.files || []).map((f) => ({ kind: f.kind, link: base ? `${base}/api/design/kd/file?doc=${encodeURIComponent(x.docNo)}&kind=${encodeURIComponent(f.kind)}` : null })), usedInMk: (x.mks || []).map((m) => m.mk) })) };
      }),

    tool('tool_move', 'Движение инструмента',
      `Проводит движение по позиции инструмента/оснастки: ${deps.toolOps.join(', ')}. Выдача требует получателя (recipient) и не больше остатка; Перемещение и Передача на участок — куда (to); Списание — основание (basis). Повтор одного и того же вызова не задвоит движение.`,
      {
        tool: { type: 'string', description: 'Код ИН-NNNN или id' }, operation: { type: 'string', enum: deps.toolOps },
        qty: { type: 'number', exclusiveMinimum: 0, description: 'Для Выдача/Пополнение/Возврат/Поступление' },
        recipient: { type: 'string', description: 'Кому выдано (для Выдачи)' }, basis: { type: 'string', description: 'Основание: ПЗ/МК/заявка/причина списания' },
        to: { type: 'string', description: 'Куда (Перемещение, Передача на участок)' }, cell: { type: 'string', description: 'Ячейка при возврате на склад' },
        batch: { type: 'string' }, date: { type: 'string', description: 'ГГГГ-ММ-ДД' }, note: { type: 'string' },
        opKey: { type: 'string', description: 'Ключ операции для защиты от повтора (если не задан — формируется из параметров)' },
      }, ['tool', 'operation'], RW,
      async (api, a, ctx) => {
        const it = must(await api('GET', '/api/tools/item?id=' + encodeURIComponent(a.tool)), 'Позиция инструмента', a.tool);
        const key = a.opKey || ['mcp', ctx.tokenId || ctx.user.id, it.id, a.operation, a.qty ?? '', a.recipient || '', a.to || '', a.basis || '', new Date().toISOString().slice(0, 13)].join('|');
        const body = { itemId: it.id, operation: a.operation, qty: a.qty, recipient: a.recipient, basis: a.basis, reason: a.basis, to: a.to, shopArea: a.to, cell: a.cell, batch: a.batch, date: a.date, note: [a.note, `[${ctx.user.fio}, ИИ]`].filter(Boolean).join(' '), clientOpId: key };
        const j = await api('POST', '/api/tools/move', body);
        return { ok: true, code: j.code || it.code, operation: j.operation, qty: j.qty ?? null, balance: j.balance ?? null, status: j.status || null, where: j.where || j.location || null, warning: j.warning || null };
      }),

    tool('tool_save', 'Завести или изменить позицию инструмента',
      'Новая позиция (без tool) — нужен name; портал сам присвоит код ИН-… и инв. № для оснастки/СИ. Изменение — укажите tool (код или id) и меняемые поля. Остаток задаётся только при заведении; дальше — через tool_move.',
      {
        tool: { type: 'string', description: 'Код ИН-NNNN или id — для изменения' }, name: { type: 'string' },
        type: { type: 'string', description: 'Расходный / Специальный' }, category: { type: 'string', description: 'Резцы, Пластины, Свёрла, Фрезы, Метчики, Оправки, Мерительный/СИ, …' },
        subcategory: { type: 'string' }, gost: { type: 'string' }, unit: { type: 'string' }, minStock: { type: 'number', minimum: 0 }, balance: { type: 'number', minimum: 0, description: 'Только при заведении' },
        cell: { type: 'string' }, location: { type: 'string' }, responsible: { type: 'string' }, code1c: { type: 'string' }, note: { type: 'string' },
      }, [], RW,
      async (api, a) => {
        const { tool: ref, ...f } = a;
        let body = f;
        if (ref) { const it = must(await api('GET', '/api/tools/item?id=' + encodeURIComponent(ref)), 'Позиция инструмента', ref); delete body.balance; body = { id: it.id, code: it.code, ...body }; }
        else if (!a.name) throw new Error('Для новой позиции нужен name.');
        const j = await api('POST', '/api/tools/save', body);
        return { ok: true, created: !!j.created, id: j.id, code: j.code };
      }),
  ];
}

// ── K-355: составление МК и карт наладки (только ЧЕРНОВИКИ) ─────────────────
// Портал при сохранении КН заменяет ВСЕ позиции, а МК требует ПОЛНЫЙ набор операций (не переданное
// стирается). Поэтому инструменты сначала читают документ, накладывают только просимые изменения и
// отправляют целиком. Правило «ИИ правит только черновики» проверяется здесь — для всех, включая
// администратора (сервер админу разрешает править и утверждённое). Копия — всегда новый черновик.
// Согласование/утверждение, генерация заданий, удаление — только человек в портале.
const isoHolderKey = (iso) => { const c = String(iso || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); const m = c.match(/^([A-Z])([A-Z])([A-Z])([A-Z])([A-Z])(\d{2,4})([A-Z])(\d{2})/); return m ? { shape: m[2], clr: m[4], size: m[8] } : null; };
const isoInsertKey = (iso) => { const c = String(iso || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); const m = c.match(/^([A-Z])([A-Z])([A-Z])([A-Z])(\d{2})(\d{2})(\d{2})/); return m ? { shape: m[1], clr: m[2], size: m[5] } : null; };
const isoCompatible = (h, i) => { const a = isoHolderKey(h), b = isoInsertKey(i); if (!a || !b) return null; return a.shape === b.shape && a.clr === b.clr && a.size === b.size; }; // K-313, как в UI
const SC_LINE_FIELDS = ['toolPos', 'toolKind', 'edgePos', 'overhang', 'params', 'note', 'lenX', 'lenZ', 'radius', 'width'];
const OP_SAVE_FIELDS = ['opTypeId', 'name', 'equipment', 'materials', 'planMaterials', 'control', 'whatControl', 'si', 'tolerance', 'norm', 'paramPlan', 'comment', 'tooling', 'setupCardNo', 'components'];
const scPositionSchema = {
  type: 'object', additionalProperties: false, required: ['slot'],
  properties: {
    slot: { type: 'integer', minimum: 1, description: 'Позиция револьверной головки (гнездо)' },
    toolKind: { type: 'string', description: 'наружный резец, торцовый / подрезной, канавочный / отрезной, резьбовой наружный, расточной резец, сверло, центровочное сверло, резьбовой внутренний, развёртка, метчик' },
    holderIso: { type: 'string', description: 'ISO державки — найдётся в каталоге; нет в каталоге — запишется как есть' },
    insertIso: { type: 'string', description: 'ISO пластины — найдётся в каталоге; нет в каталоге — запишется как есть' },
    overhang: { type: 'string', description: 'Вылет, мм' }, edgePos: { type: 'string', description: 'Положение режущей кромки 1–8 (Sinumerik)' },
    lenX: { type: 'string', description: 'Корректор длины X' }, lenZ: { type: 'string', description: 'Корректор длины Z' }, radius: { type: 'string' }, width: { type: 'string' },
    params: { type: 'string', description: 'Режимы: ap, f, vc, n…' }, note: { type: 'string' }, toolPos: { type: 'string', description: 'Обозначение позиции (по умолчанию T<slot>)' },
  },
};
const opSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    opType: { type: 'string', description: 'Тип операции — код или название из route_catalog (токарная ЧПУ, фрезерная, отрезка…)' },
    name: { type: 'string', description: 'Наименование операции (по умолчанию — имя типа)' }, equipment: { type: 'string', description: 'Оборудование (инв. № / модель)' },
    norm: { type: 'number', minimum: 0, description: 'Норма времени, ч' }, tooling: { type: 'string', description: 'Оснастка' }, setupCardNo: { type: 'string', description: '№ карты наладки' },
    control: { type: 'string', enum: ['нет', 'С', 'ОТК'] }, whatControl: { type: 'string' }, si: { type: 'string', description: 'Средства измерения' }, tolerance: { type: 'string' },
    comment: { type: 'string', description: 'Комментарий оператору' },
    paramPlan: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, norm: { type: 'string' }, tol: { type: 'string' } } }, description: 'Параметры по плану' },
    planMaterials: { type: 'array', items: { type: 'object' }, description: 'Материалы по плану; заготовка первой операции — запись с role «Заготовка» (name, unit, norm…)' },
    components: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, qty: { type: 'number' }, src: { type: 'string' } } } },
  },
};

function authoringTools(deps) {
  const must = (d, label, ref) => { if (!d || !d.item) throw new Error(`${label} «${ref}» не найден(а).`); return d.item; };
  // ── карты наладки ──
  async function catalogs(api) {
    const [h, i] = await Promise.all([api('GET', '/api/tool-catalog/holders'), api('GET', '/api/tool-catalog/inserts')]);
    return { holders: h.items || [], inserts: i.items || [] };
  }
  const isoEq = (a, b) => String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // позиции из ответа портала → формат сохранения (pos → slot; id каталога приоритетнее ISO)
  const linesFromCard = (lines) => (lines || []).map((l) => ({ slot: Number(l.pos), holderId: l.holderId ?? null, insertId: l.insertId ?? null, holderIso: l.holderId ? '' : (l.holderIso || ''), insertIso: l.insertId ? '' : (l.insertIso || ''), ...Object.fromEntries(SC_LINE_FIELDS.map((k) => [k, l[k] ?? ''])) })).filter((l) => Number.isFinite(l.slot));
  // позиция из запроса ИИ → формат сохранения + проверки по каталогу
  function lineFromArg(p, cat, warnings) {
    const out = { slot: p.slot, holderId: null, insertId: null, holderIso: '', insertIso: '' };
    for (const k of SC_LINE_FIELDS) if (p[k] != null) out[k] = String(p[k]);
    let hIso = p.holderIso, iIso = p.insertIso;
    if (hIso) { const h = cat.holders.find((x) => isoEq(x.iso, hIso)); if (h) { out.holderId = h.id; hIso = h.iso; } else { out.holderIso = String(hIso).slice(0, 60); warnings.push(`Поз. ${p.slot}: державки ${hIso} нет в каталоге — записана как есть.`); } }
    if (iIso) { const i = cat.inserts.find((x) => isoEq(x.iso, iIso)); if (i) { out.insertId = i.id; iIso = i.iso; } else { out.insertIso = String(iIso).slice(0, 60); warnings.push(`Поз. ${p.slot}: пластины ${iIso} нет в каталоге — записана как есть.`); } }
    if (hIso && iIso && isoCompatible(hIso, iIso) === false) warnings.push(`Поз. ${p.slot}: державка ${hIso} и пластина ${iIso} не совпадают по ISO (форма/задний угол/длина кромки) — проверьте.`);
    return out;
  }
  async function machineById(api, ref) {
    const d = await api('GET', '/api/equipment/item?id=' + encodeURIComponent(ref));
    return must(d, 'Станок', ref);
  }
  async function saveCard(api, body, warnings) {
    const j = await api('POST', '/api/setup-card/save', body);
    return { ok: true, id: j.id, no: j.no, positions: j.lines, status: 'Черновик', warnings };
  }

  // ── МК ──
  async function routeCatalog(api) { return api('GET', '/api/routes/catalog'); }
  function opTypeId(cat, ref) {
    if (ref == null || ref === '') return null;
    const s = norm(ref); const t = (cat.opTypes || []);
    const hit = t.find((x) => norm(x.code) === s) || t.find((x) => norm(x.name) === s) || t.find((x) => (x.names || []).some((n) => norm(n) === s)) || t.find((x) => norm(x.name).includes(s));
    if (!hit) throw new Error(`Тип операции «${ref}» не найден — посмотрите route_catalog.`);
    return hit;
  }
  function opFromArg(o, cat) {
    const out = {};
    if (o.opType != null) { const t = opTypeId(cat, o.opType); out.opTypeId = t.id; if (!o.name) out.name = t.name; }
    for (const k of ['name', 'equipment', 'norm', 'tooling', 'setupCardNo', 'control', 'whatControl', 'si', 'tolerance', 'comment', 'paramPlan', 'planMaterials', 'components']) if (o[k] !== undefined) out[k] = o[k];
    return out;
  }
  const opToSave = (o) => Object.fromEntries(OP_SAVE_FIELDS.map((k) => [k, o[k] ?? (['planMaterials', 'paramPlan', 'components'].includes(k) ? [] : '')]));
  const stripCoopReturns = (materials) => { try { const j = JSON.parse(materials); if (j && j.coop) { delete j.returned; return JSON.stringify(j); } } catch {} return materials; };
  async function routeEditFor(api, ref) {
    const list = await api('GET', '/api/routes');
    const s = String(ref == null ? '' : ref).trim();
    const r = (list.routes || []).find((x) => String(x.mk).toLowerCase() === s.toLowerCase() || String(x.id) === s);
    if (!r) throw new Error(`МК «${s}» не найдена.`);
    const d = await api('GET', '/api/route/edit?id=' + encodeURIComponent(r.id));
    if (!d || !d.route) throw new Error(`МК «${s}» не открылась для правки.`);
    return d;
  }
  const headerFrom = (rt) => ({ type: rt.type, name: rt.name, designation: rt.designation, productType: rt.productType, revision: rt.revision, material: rt.material, bom: rt.bom || [], projectDecNo: rt.projectDecNo, kdDrawings: rt.kdDrawings || [], variant: rt.variant, isMain: rt.isMain });
  const routeOut = (j, warnings) => ({ ok: true, id: j.id, mk: j.mk, operations: j.operations, status: 'Черновик', blankReserve: j.blankReserve || null, warnings: warnings || [] });

  return [
    tool('route_catalog', 'Справочники МК',
      'Справочники для составления МК: типы операций (код, название, участок, параметры, оборудование), типы продукции, типы МК, точки контроля, исполнители кооперации и сохранённые шаблоны операций.',
      {}, [], RO,
      async (api) => {
        const [c, t] = await Promise.all([routeCatalog(api), api('GET', '/api/route/op-templates').catch(() => ({ items: [] }))]);
        return { opTypes: (c.opTypes || []).map((x) => ({ code: x.code, name: x.name, section: x.section, ri: x.ri || null, params: (x.params || []).map((p) => p.name + (p.unit ? ', ' + p.unit : '')), equipment: x.equipment || [] })), productTypes: c.productTypes, mkTypes: c.mkTypes, controlPoints: c.controlPoints, contractors: (c.contractors || []).map((x) => x.name), opTemplates: (t.items || []).map((x) => ({ name: x.name, op: x.op })) };
      }),

    tool('setup_card_save', 'Составить или изменить карту наладки (черновик)',
      'Без card — новая КН (черновик): нужен станок (machine), номер портал присвоит сам (КН-<станок>-NNN). С card — правка ЧЕРНОВИКА: меняются только переданные поля; positions по умолчанию ДОПОЛНЯЮТ/заменяют указанные гнёзда (positionsMode=merge), removeSlots — убрать гнёзда, positionsMode=replace — задать весь набор. Державки/пластины ищутся в каталоге по ISO; несовместимость по ISO вернётся предупреждением. Утверждённую КН не правит — используйте setup_card_copy.',
      {
        card: { type: 'string', description: '№ КН или id — для правки черновика' },
        machine: { type: 'string', description: 'Инв. № или id станка (обязателен для новой КН)' },
        name: { type: 'string' }, part: { type: 'string', description: 'Деталь (обозначение/наименование)' }, purpose: { type: 'string' },
        operationKind: { type: 'string', enum: ['Токарная', 'Фрезерная', 'Наплавка', 'Плазменная резка'] },
        positions: { type: 'array', items: scPositionSchema }, positionsMode: { type: 'string', enum: ['merge', 'replace'], default: 'merge' },
        removeSlots: { type: 'array', items: { type: 'integer' } },
        jaw: { type: 'object', description: 'Патрон и кулачки: chuckType, jawTypeCard, jawSetNo, jawClampDia, jawLen, jawForce, workpieceOverhang, jawSupport, jawRunout, jawNote, chuckSetId' },
        zero: { type: 'object', description: 'Нулевая точка: zeroOffset, zeroZMethod, zeroZ, zeroXMethod, zeroX, zeroBase, zeroNote' },
        tail: { type: 'object', description: 'Задняя бабка: tailKind, tailTaper, tailTool, tailQuill, tailForce, tailNote' },
      }, [], RW,
      async (api, a, ctx) => {
        const cat = await catalogs(api); const warnings = [];
        if (!a.card) {
          if (!a.machine) throw new Error('Для новой карты наладки укажите станок (machine).');
          const m = await machineById(api, a.machine);
          const lines = (a.positions || []).map((p) => lineFromArg(p, cat, warnings));
          const slots = Number(m.revolverSlots) || 0; for (const l of lines) if (slots && l.slot > slots) warnings.push(`Поз. ${l.slot}: у станка ${slots} позиций головки.`);
          return saveCard(api, { machineId: m.id, name: a.name || '', part: a.part || '', purpose: a.purpose || '', author: ctx.user.fio, operationKind: a.operationKind, lines, jaw: a.jaw, zero: a.zero, tail: a.tail }, warnings);
        }
        const d = await api('GET', '/api/setup-card?id=' + encodeURIComponent(a.card)); const it = must(d, 'Карта наладки', a.card);
        if (it.status && it.status !== 'Черновик') throw new Error(`КН ${it.no} в статусе «${it.status}» — ИИ правит только черновики. Сделайте копию (setup_card_copy) и правьте её.`);
        let lines = linesFromCard(d.lines);
        const incoming = (a.positions || []).map((p) => lineFromArg(p, cat, warnings));
        if (a.positionsMode === 'replace') lines = incoming;
        else {
          // merge: переданные поля гнезда поверх текущих; державку/пластину меняем, только если её ISO передан
          const bySlot = new Map(lines.map((l) => [l.slot, l]));
          (a.positions || []).forEach((p, i) => {
            const inc = incoming[i];
            const cur = { ...(bySlot.get(p.slot) || { slot: p.slot, holderId: null, insertId: null, holderIso: '', insertIso: '' }) };
            for (const k of SC_LINE_FIELDS) if (p[k] != null) cur[k] = inc[k];
            if (p.holderIso != null) { cur.holderId = inc.holderId; cur.holderIso = inc.holderIso; }
            if (p.insertIso != null) { cur.insertId = inc.insertId; cur.insertIso = inc.insertIso; }
            bySlot.set(p.slot, cur);
          });
          lines = [...bySlot.values()];
        }
        if (a.removeSlots) lines = lines.filter((l) => !a.removeSlots.includes(l.slot));
        lines.sort((x, y) => x.slot - y.slot);
        const machineId = a.machine ? (await machineById(api, a.machine)).id : it.machineId;
        return saveCard(api, { id: it.id, status: 'Черновик', machineId, name: a.name ?? it.name, part: a.part ?? it.part ?? '', purpose: a.purpose ?? it.purpose ?? '', operationKind: a.operationKind || it.operationKind, headType: a.machine ? undefined : it.headType, revolverSlots: a.machine ? undefined : it.revolverSlots, lines, jaw: a.jaw ? { ...(it.jaw || {}), ...a.jaw } : it.jaw, zero: a.zero ? { ...(it.zero || {}), ...a.zero } : it.zero, tail: a.tail ? { ...(it.tail || {}), ...a.tail } : it.tail }, warnings);
      }),

    tool('setup_card_copy', 'Копировать карту наладки',
      'Создаёт НОВУЮ карту наладки (черновик) на основе существующей: все позиции, патрон/кулачки, ноль, задняя бабка. Можно сразу сменить станок, деталь или наименование. Исходная КН не меняется, файлы не копируются.',
      { card: { type: 'string', description: '№ КН или id исходной' }, machine: { type: 'string', description: 'Другой станок (инв. №/id)' }, part: { type: 'string' }, name: { type: 'string' } }, ['card'], RW,
      async (api, a, ctx) => {
        const d = await api('GET', '/api/setup-card?id=' + encodeURIComponent(a.card)); const it = must(d, 'Карта наладки', a.card);
        const m = a.machine ? await machineById(api, a.machine) : null;
        const jaw = { ...(it.jaw || {}) }; if (m) delete jaw.chuckSetId; // комплект кулачков привязан к патрону станка
        const r = await saveCard(api, { machineId: m ? m.id : it.machineId, name: a.name || '', part: a.part ?? it.part ?? '', purpose: it.purpose || '', author: ctx.user.fio, operationKind: it.operationKind, headType: m ? undefined : it.headType, revolverSlots: m ? undefined : it.revolverSlots, lines: linesFromCard(d.lines), jaw, zero: it.zero, tail: it.tail }, m ? ['Станок сменён: проверьте вылеты, корректоры и кулачки под новый станок.'] : []);
        return { ...r, copiedFrom: it.no };
      }),

    tool('route_save', 'Составить или изменить маршрутную карту (черновик)',
      'Без mk — новая МК (черновик): нужны type (КОМ — компонент/деталь, СБР — сборка) и name; номер МК-<тип>-<год>-NNN портал присвоит сам. С mk — правка ЧЕРНОВИКА: шапка — только переданные поля; операции: operations — задать весь список заново, либо точечно opsPatch (по № операции), opsInsert (после № операции; 0 — в начало), opsDelete (№) — все номера в ИСХОДНОЙ нумерации, портал перенумерует по порядку. Типы операций — из route_catalog. Заготовку указывайте в planMaterials первой операции (role «Заготовка»). Утверждённую МК не правит — route_copy или вернуть в черновик через согласующего.',
      {
        mk: { type: 'string', description: '№ МК или id — для правки черновика' },
        type: { type: 'string', enum: ['КОМ', 'СБР'] }, name: { type: 'string', description: 'Наименование изделия/компонента' }, designation: { type: 'string', description: 'Обозначение (децимальный №/чертёж)' },
        productType: { type: 'string' }, revision: { type: 'string' }, material: { type: 'string' },
        operations: { type: 'array', items: opSchema, description: 'Полный список операций по порядку' },
        opsPatch: { type: 'array', items: { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 }, ...opSchema.properties } } },
        opsInsert: { type: 'array', items: { type: 'object', required: ['after', 'op'], properties: { after: { type: 'integer', minimum: 0 }, op: opSchema } } },
        opsDelete: { type: 'array', items: { type: 'integer', minimum: 1 } },
      }, [], RW,
      async (api, a) => {
        const cat = await routeCatalog(api);
        if (!a.mk) {
          if (!a.type || !a.name) throw new Error('Для новой МК нужны type (КОМ/СБР) и name.');
          const ops = (a.operations || []).map((o) => opToSave(opFromArg(o, cat)));
          const j = await api('POST', '/api/routes/save', { id: null, type: a.type, name: a.name, designation: a.designation || '', productType: a.productType || '', revision: a.revision || '', material: a.material || '', operations: ops });
          return routeOut(j);
        }
        const d = await routeEditFor(api, a.mk); const rt = d.route;
        if (rt.statusMk !== 'Черновик') throw new Error(`${rt.mk} в статусе «${rt.statusMk}» — ИИ правит только черновики. Сделайте копию (route_copy) или верните МК в черновик через согласующего.`);
        // opsPatch / opsInsert / opsDelete — все номера в ИСХОДНОЙ нумерации МК
        let rows = (a.operations ? a.operations.map((o) => opToSave(opFromArg(o, cat))) : (d.operations || []).map((o) => opToSave(o))).map((o, i) => ({ o, n: i + 1 }));
        const total = rows.length, chk = (n) => { if (!(n >= 1 && n <= total)) throw new Error(`Операции №${n} нет (всего ${total}).`); };
        for (const p of a.opsPatch || []) { chk(p.n); const { n, ...rest } = p; const r = rows.find((x) => x.n === n); r.o = { ...r.o, ...opFromArg(rest, cat) }; }
        for (const ins of a.opsInsert || []) { if (ins.after !== 0) chk(ins.after); }
        const out = []; const at = (n) => (a.opsInsert || []).filter((x) => x.after === n).map((x) => ({ o: opToSave(opFromArg(x.op, cat)), n: null }));
        out.push(...at(0)); for (const r of rows) { if (!(a.opsDelete || []).includes(r.n)) out.push(r); out.push(...at(r.n)); }
        for (const n of a.opsDelete || []) chk(n);
        let ops = out.map((x) => x.o);
        const header = { ...headerFrom(rt) }; for (const k of ['type', 'name', 'designation', 'productType', 'revision', 'material']) if (a[k] != null) header[k] = a[k];
        const j = await api('POST', '/api/routes/save', { id: rt.id, ...header, operations: ops });
        return routeOut(j, (a.opsDelete || a.opsInsert) ? ['Номера операций пересчитаны по порядку.'] : []);
      }),

    tool('route_copy', 'Копировать маршрутную карту',
      'Создаёт НОВУЮ МК-черновик из существующей. asVariant=true — другой способ изготовления того же изделия (вариант с тем же обозначением, variantName обязателен); иначе — отдельная МК, можно задать новое name/designation (например, похожая деталь). Операции, параметры, нормы, материалы и заготовка копируются; файлы УП и отметки о возврате кооперации — нет. keepSetupCards=false — очистить № карт наладки. Исходная МК не меняется, к позициям ПЗ копия не привязывается.',
      { mk: { type: 'string', description: '№ МК или id исходной' }, asVariant: { type: 'boolean', default: false }, variantName: { type: 'string' }, name: { type: 'string' }, designation: { type: 'string' }, keepSetupCards: { type: 'boolean', default: true } }, ['mk'], RW,
      async (api, a) => {
        const d = await routeEditFor(api, a.mk); const rt = d.route;
        if (a.asVariant && !a.variantName) throw new Error('Для варианта укажите variantName (например, «Из трубы»).');
        const ops = (d.operations || []).map((o) => ({ ...opToSave(o), materials: stripCoopReturns(o.materials || ''), setupCardNo: a.keepSetupCards === false ? '' : (o.setupCardNo || '') }));
        const header = headerFrom(rt);
        if (a.asVariant) Object.assign(header, { variant: a.variantName, isMain: false, variantOf: rt.id });
        else Object.assign(header, { variant: '', isMain: false, name: a.name || rt.name, designation: a.designation ?? rt.designation });
        const j = await api('POST', '/api/routes/save', { id: null, ...header, operations: ops });
        return { ...routeOut(j), copiedFrom: rt.mk, asVariant: !!a.asVariant };
      }),
  ];
}

// ── протокол ────────────────────────────────────────────────────────────────
// deps: { port, authenticate(req) → { sid, user:{id,fio}, tokenId } | null, stages:{znz,zp}, portalBase() }
export function createMcpHandler(deps) {
  const tools = [...procurementTools(deps), ...salesTools(deps), ...techTools(deps), ...authoringTools(deps)];
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
  const apiWithUpload = (sid) => {
    const api = apiFor(sid);
    api.upload = async (path, fields, fileName, buf) => {
      if (buf.length > FILE_MAX) throw new Error('Файл больше 20 МБ.');
      const b = '----pbsmcp' + Math.random().toString(16).slice(2);
      const safe = String(fileName || 'файл').normalize('NFC').replace(/[\r\n"]/g, '_').replace(/^.*[\\/]/, '');
      const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`));
      const r = await fetch(`http://127.0.0.1:${deps.port}${path}`, { method: 'POST', headers: { cookie: `pbs_sid=${sid}`, 'Content-Type': `multipart/form-data; boundary=${b}`, 'X-Mcp': '1' }, body: Buffer.concat(parts) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
      return j;
    };
    return api;
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
        const out = await t.run(apiWithUpload(ctx.sid), args, ctx);
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
    try { body = await readBody(req); } catch (e) { return send(/лимит/i.test(String(e && e.message)) ? 413 : 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: /лимит/i.test(String(e && e.message)) ? 'Запрос слишком большой (файл больше 20 МБ?).' : 'Parse error' } }); }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => rpc(m, ctx)))).filter(Boolean);
      return out.length ? send(200, out) : send(202, null);
    }
    const out = await rpc(body, ctx);
    return out ? send(200, out) : send(202, null);
  };
}
