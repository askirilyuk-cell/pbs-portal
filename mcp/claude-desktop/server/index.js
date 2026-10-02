#!/usr/bin/env node
// K-349: мост Claude Desktop ↔ MCP портала ИСМ ПБС.
// Claude Desktop подключает коннекторы по адресу через облако Anthropic — до портала
// (локальная сеть / Tailscale) оно не достанет. Поэтому расширение запускает этот мост
// локально: JSON-RPC из stdin → POST {PORTAL_MCP_URL} с личным токеном → ответ в stdout.
// Без зависимостей, Node 18+ (Claude Desktop поставляет свой Node).
'use strict';
const readline = require('node:readline');

const URL_ = String(process.env.PORTAL_MCP_URL || 'http://nas-pbs:4173/mcp').trim();
const TOKEN = String(process.env.PORTAL_TOKEN || '').trim();
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const fail = (id, message) => { if (id !== undefined && id !== null) out({ jsonrpc: '2.0', id, error: { code: -32000, message } }); };

async function forward(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const id = Array.isArray(msg) ? undefined : msg.id;
  if (!TOKEN) return fail(id, 'Не задан личный токен портала: Настройки расширения «Портал ИСМ ПБС» в Claude Desktop.');
  let r;
  try {
    r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${TOKEN}` }, body: line, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    return fail(id, `Портал недоступен (${URL_}): проверьте, что включён Tailscale или вы в сети офиса. ${e.message || e}`);
  }
  if (r.status === 202) return;
  const text = await r.text();
  if (r.status === 401) return fail(id, 'Портал не принял токен: он неверный или отозван. Попросите новый у администратора портала.');
  try { const j = JSON.parse(text); if (Array.isArray(j)) j.forEach(out); else out(j); }
  catch { fail(id, `Портал ответил HTTP ${r.status}: ${text.slice(0, 200)}`); }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
rl.on('line', (line) => { if (line.trim()) chain = chain.then(() => forward(line)); });
rl.on('close', () => { chain.then(() => process.exit(0)); });
