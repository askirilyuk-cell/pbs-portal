#!/bin/bash
# Создаёт дополнительные БД в одном экземпляре PostgreSQL при первой инициализации:
#   - $POSTGRES_DB  (nocodb)   — создаётся самим образом postgres
#   - $N8N_DB       (n8n)
#   - $METABASE_DB  (metabase)
# Скрипт выполняется образом postgres только при пустом томе данных.
set -e

create_db() {
  local db="$1"
  echo "  → проверка/создание БД: $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE "$db"'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
EOSQL
}

create_db "${N8N_DB:-n8n}"
create_db "${METABASE_DB:-metabase}"
echo "  ✓ дополнительные БД готовы"
