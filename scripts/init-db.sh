#!/bin/sh
set -eu
for migration in /migrations/*.sql; do
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_password="$APP_DB_PASSWORD" -f "$migration"
done
