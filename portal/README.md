# Портал ИСМ ПБС — срез «Производственная доска + печать»

Тонкий вертикальный срез фронт-портала (Фаза F). Операторский экран поверх
NocoDB: заказы → позиции → задачи по участкам/статусам + печать ПЗ / Ф.13 / Ф.14
и актов контроля одной кнопкой. Токен NocoDB живёт только на сервере (BFF).

## Архитектура

- **BFF** — `portal/server.js`, zero-dep Node-сервер. Отдаёт статику и JSON-API,
  печать проксирует через `print/render-*.mjs` → Gotenberg.
- **SPA** — `portal/public/index.html`, Tailwind (CDN) + ванильный JS.
- **Режимы**: LIVE (есть `NC_TOKEN` + `nocodb/.state/schema-map.json`) читает NocoDB v2;
  иначе MOCK — демо-данные из `portal/mock/fixtures.json`.

## Локальный запуск (preview)

```
node portal/server.js            # MOCK (демо-данные), http://localhost:4173
```

LIVE локально (нужен доступ к NocoDB и копия schema-map):
```
NC_URL=http://192.168.1.10:8080 NC_TOKEN=<token> GOTENBERG_URL=... node portal/server.js
```

## Деплой на NAS

```
scp -O -r D:\pbs-portal\portal aleksandr-kirilyuk@192.168.1.10:/volume1/docker/pbs-portal/
scp -O D:\pbs-portal\compose.portal.yml aleksandr-kirilyuk@192.168.1.10:/volume1/docker/pbs-portal/
# на NAS:
sudo NC_TOKEN=<token> docker compose -f compose.portal.yml up -d
# → http://192.168.1.10:4173
```

## Дальше (не в этом срезе)

- Bitrix24 SSO (OAuth) + роли на BFF.
- Запись (смена статуса задачи, ввод параметров) — рабочее место рабочего.
- PWA + сканер QR/ШК.
- За Caddy (HTTPS), убрать прямой порт.
