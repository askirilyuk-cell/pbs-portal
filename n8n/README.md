# n8n — автоматизации производственного модуля

Три workflow (раздел 7 ТЗ):

| Файл | Что делает | Триггер (вебхук NocoDB) |
|---|---|---|
| `01-pz-autonumber.json` | Сквозная нумерация ПЗ по году и серии: `ПЗ-ГГГГ-NNN` (клиент) / `ПЗ-ГГГГ-СNNN` (внутр.) | Заказы — **After Insert** |
| `02-status-rollup.json` | Агрегация статусов: Задача → Позиция → Заказ | Задачи на участки — **After Insert / After Update** |
| `03-task-params-populate.json` | При создании задачи копирует набор параметров её Типа операции в дочернюю таблицу «Значения параметров задачи» | Задачи на участки — **After Insert** |

## Предпосылки (переменные окружения n8n)

Workflow читают окружение контейнера n8n (заданы в `docker-compose.yml` из `.env`):

- `NOCODB_INTERNAL_URL` = `http://nocodb:8080`
- `NC_TOKEN` — API-токен NocoDB (UI → правый верх → аккаунт → **Tokens** → создать)
- `NC_BASE_ID` — `baseId` из `nocodb/.state/schema-map.json`

После заполнения `NC_TOKEN` и `NC_BASE_ID` в `.env`: `docker compose up -d n8n`.

## Импорт

1. Открыть n8n: `http://192.168.1.10:5678` (Basic Auth из `.env`).
2. **Workflows → Import from File** — импортировать каждый JSON.
3. Открыть, проверить, **активировать** (toggle Active).
4. Скопировать **Production URL** вебхука каждого workflow (например `…/webhook/pz-autonumber`).

## Подключение вебхуков NocoDB

В NocoDB: открыть таблицу → **Details → Webhooks → Add**:

| Workflow | Таблица | Событие | URL |
|---|---|---|---|
| автонумерация | Заказы | After Insert | `http://n8n:5678/webhook/pz-autonumber` |
| агрегация статусов | Задачи на участки | After Insert **и** After Update | `http://n8n:5678/webhook/status-rollup` |
| параметры задачи | Задачи на участки | After Insert | `http://n8n:5678/webhook/task-params-populate` |

> Внутри docker-сети адрес n8n — `http://n8n:5678`. Если NocoDB и n8n в одной сети `pbs` (так в compose), используйте это имя; иначе — `http://192.168.1.10:5678`.

Тело вебхука — «Records» (по умолчанию). Workflow устойчивы к форме payload (`data.rows[]` или `data`).

## Замечания по версиям API

- Запросы данных идут через **Data API v1** (`/api/v1/db/data/noco/{baseId}/{tableName}`), имена таблиц — кириллицей.
- Привязка дочерних строк (`03-…`) использует ссылочный эндпоинт
  `/{table}/{rowId}/mm/{linkColumnId}/{childId}`. Путь связывания —
  **самая чувствительная к версии часть**; при ошибке сверьте формат в Swagger
  вашего NocoDB (`/api/v1/db/meta/...` → раздел data/link) и поправьте в Code-ноде.
- Id link-колонки `03-…` находит сам через Meta API — править вручную не нужно.
