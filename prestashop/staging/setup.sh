#!/bin/sh
# Build the staging store from a copy of the live one. Live is only read (mysqldump + file copy).
set -eu
D=/root/onicindustries-staging
LIVE_FILES=/var/lib/docker/volumes/onicindustries_onicindustries_data/_data
DOMAIN=staging-store.onicindustries.com
cd $D
if [ ! -f .env ]; then
  umask 077
  printf 'STAGING_DB_ROOT_PASSWORD=%s\nSTAGING_DB_PASSWORD=%s\n' "$(openssl rand -hex 20)" "$(openssl rand -hex 20)" > .env
fi
. ./.env

echo "== 1. staging database container"
docker compose up -d mysql
i=0; until docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1" onicindustries' >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 60 ] && { echo "staging mysql did not come up"; exit 1; }; sleep 3; done

echo "== 2. dump live database (read-only, single transaction; visitor stats tables: structure only)"
{
  docker exec onicindustries-mysql-1 sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --quick --routines --triggers --no-tablespaces --ignore-table=onicindustries.oe_connections --ignore-table=onicindustries.oe_connections_source onicindustries'
  docker exec onicindustries-mysql-1 sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --no-data --no-tablespaces onicindustries oe_connections oe_connections_source'
} 2>/dev/null | gzip > live-dump.sql.gz
ls -la live-dump.sql.gz

echo "== 3. load into staging"
gunzip -c live-dump.sql.gz | docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" onicindustries' 2>&1 | grep -v "Using a password" || true

echo "== 4. copy files"
docker volume create onicindustries-staging_onicindustries_data >/dev/null
SF=$(docker volume inspect -f '{{.Mountpoint}}' onicindustries-staging_onicindustries_data)
cp -a "$LIVE_FILES/." "$SF/"
sed -i "s/'database_password' => '[^']*'/'database_password' => '$STAGING_DB_PASSWORD'/" "$SF/app/config/parameters.php"
rm -rf "$SF/var/cache/"*

echo "== 5. make staging safe: domain, no email, maintenance, outside-facing modules off"
docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" onicindustries' 2>&1 <<SQL | grep -v "Using a password" || true
UPDATE oe_shop_url SET domain='$DOMAIN', domain_ssl='$DOMAIN';
UPDATE oe_configuration SET value='$DOMAIN' WHERE name IN ('PS_SHOP_DOMAIN','PS_SHOP_DOMAIN_SSL');
UPDATE oe_configuration SET value='3' WHERE name='PS_MAIL_METHOD';
UPDATE oe_configuration SET value='0' WHERE name='PS_SHOP_ENABLE';
UPDATE oe_configuration SET value='1' WHERE name='PS_MAINTENANCE_ALLOW_ADMINS';
DELETE ms FROM oe_module_shop ms JOIN oe_module m ON m.id_module = ms.id_module
  WHERE m.name IN ('paypal','whatsappconnectng','ps_eventbus','ps_accounts','ps_mbo','ps_distributionapiclient','ps_googleanalytics');
UPDATE oe_module SET active=0
  WHERE name IN ('paypal','whatsappconnectng','ps_eventbus','ps_accounts','ps_mbo','ps_distributionapiclient','ps_googleanalytics');
SELECT name, value FROM oe_configuration WHERE name IN ('PS_SHOP_DOMAIN','PS_MAIL_METHOD','PS_SHOP_ENABLE');
SELECT COUNT(*) AS customers FROM oe_customer; SELECT COUNT(*) AS employees FROM oe_employee; SELECT COUNT(*) AS orders FROM oe_orders;
SQL

echo "== 6. start staging shop"
docker compose up -d onicindustries
rm -f live-dump.sql.gz
echo done
