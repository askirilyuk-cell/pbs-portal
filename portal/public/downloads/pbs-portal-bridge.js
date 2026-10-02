#!/usr/bin/env node
// K-349: мост Claude Desktop ↔ MCP портала ИСМ ПБС.
// Claude Desktop подключает коннекторы по адресу через облако Anthropic — до портала
// (локальная сеть / Tailscale) оно не достанет. Поэтому расширение запускает этот мост
// локально: JSON-RPC из stdin → POST {PORTAL_MCP_URL} с личным токеном → ответ в stdout.
// Подходит любому MCP-клиенту с локальными (stdio) серверами: Claude Code, Qwen Code, LM Studio…
// K-353: для znz_attach_file/zp_attach_file мост сам читает файл с этого компьютера —
// по localPath или по имени (fileName) в «Загрузках», на «Рабочем столе», в «Документах» —
// и передаёт содержимое порталу. Без зависимостей, Node 18+ (Claude Desktop поставляет свой Node).
'use strict';
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const URL_ = String(process.env.PORTAL_MCP_URL || 'http://nas-pbs:4173/mcp').trim();
const TOKEN = String(process.env.PORTAL_TOKEN || '').trim();
const FILE_MAX = 20 * 1024 * 1024;
const ATTACH_TOOLS = new Set(['znz_attach_file', 'zp_attach_file']);
const SEARCH_DIRS = ['Downloads', 'Desktop', 'Documents'].map((d) => path.join(os.homedir(), d));
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const fail = (id, message) => { if (id !== undefined && id !== null) out({ jsonrpc: '2.0', id, error: { code: -32000, message } }); };
const toolError = (id, text) => out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
const nfc = (s) => String(s || '').normalize('NFC');

// поиск файла по точному имени (без учёта регистра и формы Юникода) в папках пользователя, до 3 уровней вглубь
function findByName(name) {
  const want = nfc(path.basename(name)).toLowerCase();
  const found = [];
  const walk = (dir, depth) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isFile() && nfc(e.name).toLowerCase() === want) found.push(p);
      else if (e.isDirectory() && depth < 3 && found.length < 20) walk(p, depth + 1);
    }
  };
  for (const d of SEARCH_DIRS) walk(d, 1);
  return found;
}

// подставить содержимое файла в аргументы инструмента вложения; null — всё ок, строка — текст ошибки
function resolveAttachment(args) {
  if (!args || args.contentBase64 || args.url) return null;
  let file = null;
  if (args.localPath) {
    file = String(args.localPath).replace(/^~(?=$|[\\/])/, os.homedir());
    if (!fs.existsSync(file)) return `Файл не найден: ${file}`;
  } else if (args.fileName) {
    const hits = findByName(args.fileName);
    if (!hits.length) return `Файл «${args.fileName}» не найден в «Загрузках», на «Рабочем столе» и в «Документах». Сохраните его туда или укажите полный путь (localPath).`;
    if (hits.length > 1) {
      const sizes = new Set(hits.map((p) => { try { return fs.statSync(p).size; } catch { return -1; } }));
      if (sizes.size > 1) return `Нашлось несколько разных файлов «${args.fileName}»:\n${hits.slice(0, 6).join('\n')}\nУточните, какой — полным путём (localPath).`;
      hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); // одинаковые копии — берём свежую
    }
    file = hits[0];
  } else return null;
  let st; try { st = fs.statSync(file); } catch (e) { return `Не удалось прочитать файл: ${e.message}`; }
  if (!st.isFile()) return `Это не файл: ${file}`;
  if (st.size > FILE_MAX) return `Файл больше 20 МБ (${Math.round(st.size / 1048576)} МБ): ${file}`;
  args.contentBase64 = fs.readFileSync(file).toString('base64');
  args.fileName = nfc(path.basename(file));
  delete args.localPath;
  return null;
}

async function forward(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const id = Array.isArray(msg) ? undefined : msg.id;
  if (!TOKEN) return fail(id, 'Не задан личный токен портала: Настройки расширения «Портал ИСМ ПБС» (или переменная PORTAL_TOKEN).');
  if (!Array.isArray(msg) && msg.method === 'tools/call' && msg.params && ATTACH_TOOLS.has(msg.params.name)) {
    const err = resolveAttachment(msg.params.arguments || (msg.params.arguments = {}));
    if (err) return toolError(id, err);
    line = JSON.stringify(msg);
  }
  let r;
  try {
    r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${TOKEN}` }, body: line, signal: AbortSignal.timeout(120000) });
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
