# Развёртывание в Docker

Три контейнера: **nginx** (HTTPS, etherdisk.app) → **web** (Next.js) и **server** (Rust, API на `/api/`).
Сайт и API на одном домене, поэтому CORS не нужен. Порядок выхода в mainnet — в `docs/LAUNCH.md`.

## 1. Подготовка хоста

- Docker с плагином compose, открыты порты 80 и 443, DNS `etherdisk.app` и `www.etherdisk.app` указывают на хост.
- Папки для базы и томов (RAID-массивов). Сервер в контейнере работает от пользователя с UID 10001:

```bash
sudo mkdir -p /srv/etherdisk/db /mnt/raid1/etherdisk
sudo chown -R 10001:10001 /srv/etherdisk/db /mnt/raid1/etherdisk
```

- Если массив монтируется в `/mnt/raid1`, защитите пустую точку монтирования от записи **до** монтирования (`sudo chattr +i /mnt/raid1`): тогда без массива сервер не стартует, а не начнёт писать диски на системный раздел.

## 2. Настройки

```bash
cd deploy
cp .env.example .env               # адрес контракта, RPC, пути к базе и томам
cp server.env.example server.env   # CHAIN_ID, START_BLOCK, Telegram, модераторы
```

Несколько массивов: в `.env` — `VOLUME_2=...`, в `docker-compose.yml` под `server.volumes` — строка `- ${VOLUME_2}:/mnt/volume2`, в `server.env` — `DATA_DIR=/mnt/volume1,/mnt/volume2`.

## 3. Сертификат (первый раз)

nginx не запустится без сертификата, поэтому первый выпускает certbot сам, на порту 80:

```bash
docker compose run --rm -p 80:80 certbot certonly --standalone \
  -d etherdisk.app -d www.etherdisk.app --agree-tos -m <ваша почта> --no-eff-email
```

Продление (раз в день по cron; certbot сам решает, пора ли):

```bash
docker compose run --rm certbot renew --webroot -w /var/www/certbot && docker compose exec nginx nginx -s reload
```

## 4. Запуск и обновление

```bash
docker compose up -d --build      # первая сборка: ~10–20 минут (Rust и WASM)
docker compose logs -f server     # лог сервера: тома, мониторинг, индексатор
```

Обновление после `git pull`: снова `docker compose up -d --build`. `NEXT_PUBLIC_*` вшиваются в образ сайта при сборке: после их изменения нужна пересборка.

## Резервные копии

База — один файл SQLite в `DB_DIR` (плюс `-wal`/`-shm`). Копировать её на ходу — `sqlite3 etherdisk.db ".backup /куда/etherdisk.db"`. Тома с файлами защищает RAID, но не от удаления, пожара или ошибки контроллера: для них нужна отдельная копия.
