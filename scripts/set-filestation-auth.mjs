// ============================================================================
//  Кладёт креды сервисной учётки DSM в portal/.runtime.json контейнера.
//
//  Пароль берётся ТОЛЬКО из переменных окружения — в этот файл, в git, в чат и
//  в историю команд он не попадает. Запускать ИЗНУТРИ контейнера (там root,
//  а .runtime.json root-owned и снаружи пользователем не пишется).
//
//  Запуск (пароль подставит DSM-оболочка, не сохраняя в истории — обрати
//  внимание на ПРОБЕЛ в начале строки, с ним bash не пишет её в history):
//
//     sudo -n /usr/local/bin/docker cp scripts/set-filestation-auth.mjs \
//          pbs-portal-app:/app/portal/set-fs-auth.mjs
//
//      sudo -n /usr/local/bin/docker exec \
//          -e FS_USER='portal-fs' -e FS_PASS='ПАРОЛЬ' \
//          pbs-portal-app node /app/portal/set-fs-auth.mjs
//
//     sudo -n /usr/local/bin/docker exec pbs-portal-app rm /app/portal/set-fs-auth.mjs
//     sudo -n /usr/local/bin/docker restart pbs-portal-app
//
//  Проверка после рестарта: зарегистрировать ЗП через UI и убедиться, что папка
//  появилась в Synology Drive на клиенте сама, без переименования (~15 секунд).
//  Если в логах контейнера появится «FileStation … не удалось» — значит портал
//  свалился на прямую запись в ФС (прежнее поведение), смотри код ошибки.
// ============================================================================

import fs from 'node:fs';

const FILE = '/app/portal/.runtime.json';

const user = process.env.FS_USER || '';
const pass = process.env.FS_PASS || '';
const url = process.env.FS_URL || '';                 // необязательно, дефолт в cfg()
const recPath = process.env.FS_RECORDS_PATH || '';    // необязательно, дефолт /06-Записи-ПБС

if (!user || !pass) {
  console.error('Не заданы FS_USER и/или FS_PASS в окружении. Ничего не записано.');
  process.exit(1);
}

let cur = {};
try { cur = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch (e) { console.error(`Не читается ${FILE}: ${e.message}. Ничего не записано.`); process.exit(1); }

const next = { ...cur, FS_USER: user, FS_PASS: pass };
if (url) next.FS_URL = url;
if (recPath) next.FS_RECORDS_PATH = recPath;

// бэкап рядом, на случай отката
const bak = FILE + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
try { fs.copyFileSync(FILE, bak); } catch (e) { console.error(`Не сделался бэкап: ${e.message}. Ничего не записано.`); process.exit(1); }

fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');

// показываем ЧТО записано, но не пароль
const shown = Object.fromEntries(Object.keys(next).map((k) => [k, /PASS|TOKEN|SECRET/i.test(k) ? '***' : next[k]]));
console.log('Записано в', FILE);
console.log(JSON.stringify(shown, null, 2));
console.log('Бэкап:', bak);
console.log('\nТеперь нужен рестарт контейнера — рантайм читается один раз при старте.');
