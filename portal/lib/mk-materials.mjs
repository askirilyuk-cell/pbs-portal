// ============================================================================
//  «Входящие материалы» операции МК — разбор и человекочитаемый вид.
//
//  ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. В этом LongText-поле, кроме свободного текста технолога,
//  лежат ДВА вида служебного JSON:
//    • {blank:true} — заготовка (рекомендация технолога, норма расхода) на ПЕРВОЙ
//      операции маршрута;
//    • {coop:true}  — блок внешней кооперации на кооперационной операции, а внутри
//      него — coop.onec: СВЯЗКА С 1С (идентификатор ИСМ-ид, ссылки Ref_Key, номера
//      документов бухгалтерии).
//  Ни то, ни другое нельзя показывать человеку сырым: рабочему в цехе сырой JSON
//  бесполезен, а в случае coop-JSON это ещё и утечка внутренних ключей 1С в бумагу,
//  уходящую на участок.
//
//  Преобразование было продублировано в BFF (portal/server.js) и НЕ доехало до
//  печатной формы Ф.14 (print/render-task.mjs) — та печатала фолбэком сырое поле
//  операции (найдено QA). Поэтому единственная копия логики живёт ЗДЕСЬ, а BFF и
//  рендеры печати её импортируют: разъехаться больше нечему.
//  Зависимостей нет — модуль чистый, его можно звать из любого скрипта.
// ============================================================================

// ── Заготовка (МК, этап 1) — рекомендация технолога + резерв металла на складе ──────────────
// Хранение БЕЗ новой колонки: JSON кладём в «Входящие материалы» ПЕРВОЙ операции маршрута — поле
// изначально заведено под «что взять на операцию» (см. schema.json note на operations/tasks), UI для
// него раньше не было, поэтому конфликта с реальными данными технологов нет. Маркер {blank:true}
// отличает наши данные от возможного будущего свободного текста (тогда просто не распарсится — ok).
export function mkBlankParse(raw) {
  const s = String(raw || '').trim();
  if (!s || s[0] !== '{') return null;
  try { const j = JSON.parse(s); return (j && j.blank === true) ? j : null; } catch { return null; }
}
// человекочитаемая строка для карточки МК / карты задания Ф.14 («Взять: …»)
export function mkBlankText(b) {
  if (!b) return '';
  let name;
  if (b.mode === 'free') name = String(b.freeText || '').trim();
  else if (b.mode === 'stock') {
    // этап 3: технолог указал КОНКРЕТНУЮ живую карточку склада (не канон-рекомендацию) — код
    // карточки обязателен в тексте, чтобы кладовщик/оператор не путали с «просто такая же марка».
    const code = String(b.stockCode || '').trim();
    const desc = String(b.name || '').trim();
    name = code ? (desc ? `${code} · ${desc} (указана технологом)` : `${code} (указана технологом)`) : '';
  } else name = String(b.name || [b.kind, b.grade, b.size].filter(Boolean).join(' ')).trim();
  if (!name) return '';
  const unit = String(b.unit || 'кг').trim() || 'кг';
  const norm = Number(b.norm);
  const parts = [`Заготовка: ${name}`];
  if (norm > 0) parts.push(`норма ${norm} ${unit}/дет`);
  const ppb = Number(b.partsPerBlank);
  if (ppb > 1) parts.push(`${ppb} дет. из заготовки`);
  return parts.join(' · ');
}
// ── Внешняя кооперация (МК, этап 4) — у нас нет термообработки: детали готовим сами и везём
// подрядчику (юрлицо, договор + спецификация), после возврата — приёмка по каждой детали (ВК).
// Хранение — БЕЗ новой колонки: JSON кладём в «Входящие материалы» операции (тот же LongText,
// тот же паттерн, что и заготовка/mkBlankParse), но НЕ первой операции маршрута (там — заготовка).
// Маркер {coop:true} отличает от {blank:true} и от свободного текста (не распарсится — ok, null).
export function mkCoopParse(raw) {
  const s = String(raw || '').trim();
  if (!s || s[0] !== '{') return null;
  try { const j = JSON.parse(s); return (j && j.coop === true) ? j : null; } catch { return null; }
}
// сводный статус кооперации: сколько отправлено/закрыто (принято ГОДЕН + признано браком) по
// КАЖДОЙ детали (parts[]) против фактических приёмок возврата (returned[].items[]) — сопоставление
// по имени детали (без учёта регистра/пробелов); «завершено» — когда по всем деталям закрыто ≥ отправлено.
// Просрочка считается только пока не завершено и «План возврата» уже в прошлом.
export function mkCoopStatus(c) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const parts = Array.isArray(c && c.parts) ? c.parts : [];
  const acc = new Map();
  parts.forEach((p) => { const k = norm(p.name); if (!k) return; const v = acc.get(k) || { sent: 0, closed: 0 }; v.sent += Number(p.qty) || 0; acc.set(k, v); });
  (Array.isArray(c && c.returned) ? c.returned : []).forEach((r) => {
    (Array.isArray(r.items) ? r.items : []).forEach((it) => {
      const k = norm(it.name); if (!k) return;
      const v = acc.get(k) || { sent: 0, closed: 0 };
      v.closed += (Number(it.qtyAccepted) || 0) + (Number(it.qtyScrap) || 0);
      acc.set(k, v);
    });
  });
  let sentTotal = 0, closedTotal = 0, done = acc.size > 0;
  for (const v of acc.values()) {
    sentTotal += v.sent; closedTotal += Math.min(v.sent, v.closed);
    if (v.closed + 1e-9 < v.sent) done = false;
  }
  let overdueDays = 0;
  const returnPlan = String((c && c.returnPlan) || '').slice(0, 10);
  if (!done && returnPlan) {
    const today = new Date().toISOString().slice(0, 10);
    if (returnPlan < today) overdueDays = Math.max(0, Math.round((Date.parse(today) - Date.parse(returnPlan)) / 86400000));
  }
  return { sentTotal, closedTotal, done, overdueDays };
}
// человекочитаемая строка для карточки МК (аналог mkBlankText)
export function mkCoopText(c, status) {
  if (!c) return '';
  const st = status || mkCoopStatus(c);
  const bits = [`🤝 Кооперация: ${c.contractor || '—'}`];
  if (c.contractNo) bits.push(`дог. №${c.contractNo}`);
  if (c.specNo) bits.push(`спец. №${c.specNo}`);
  if (c.sentDate) bits.push(`отправлено ${c.sentDate.split('-').reverse().join('.')}`);
  if (st.done) bits.push('возврат завершён');
  else if (c.returnPlan) bits.push(`возврат до ${String(c.returnPlan).split('-').reverse().join('.')}`);
  return bits.join(' · ');
}
// ЕДИНАЯ точка «показать человеку»: заготовка → «Заготовка: …», кооперация → «🤝 Кооперация: …»,
// всё остальное — как есть (свободный текст технолога). Служебный JSON наружу не выходит НИКОГДА:
// если поле распозналось как {blank:true}/{coop:true}, сырой строкой оно уже не вернётся.
export function mkMaterialsHuman(raw) {
  const blank = mkBlankParse(raw);
  if (blank) return mkBlankText(blank);
  const coop = mkCoopParse(raw);
  if (coop) return mkCoopText(coop);
  return String(raw == null ? '' : raw);
}
