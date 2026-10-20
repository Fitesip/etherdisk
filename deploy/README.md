# Развёртывание в Docker

Три контейнера: **nginx** (HTTPS, etherdisk.app) → **web** (Next.js) и **server** (Rust, API на `/api/`).
Сайт и API на одном домене, поэтому сайту CORS не нужен; приложению для ПК (`desktop/`) его разрешает `CORS_ORIGINS` в `server.env`. Порядок выхода в mainnet — в `docs/LAUNCH.md`.

## 1. Подготовка хоста

- Docker с плагином compose (2.24.4 или новее), открыты порты 80 и 443 (если они заняты — см. «Порты 80 и 443 заняты»), DNS `etherdisk.app` и `www.etherdisk.app` указывают на хост.
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

Несколько массивов — см. «Добавить хранилище» ниже (`storage.yml`, `docker-compose.yml` править не нужно).

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

## Порты 80 и 443 заняты

Наружу открыт только nginx: сайт (3000) и API (8787) доступны лишь внутри сети compose. Другие порты для nginx — `HTTP_PORT` и `HTTPS_PORT` в `.env`.

Если 80 и 443 держит nginx, уже установленный на хосте, TLS остаётся у него, а он пересылает etherdisk.app в контейнеры:

1. В `deploy/.env`:

   ```
   COMPOSE_FILE=docker-compose.yml:behind-proxy.yml
   HTTP_PORT=127.0.0.1:8880
   ```

   nginx в контейнере тогда слушает только `127.0.0.1:8880`, без TLS (`nginx/etherdisk.behind-proxy.conf`). Порт можно взять любой свободный, но только на `127.0.0.1`: адрес клиента контейнер берёт из `X-Forwarded-For`.

2. `nginx/host-etherdisk.conf` скопировать в `/etc/nginx/sites-available/etherdisk.conf` и включить (порт в `proxy_pass` — тот же, что в `HTTP_PORT`). Пока сертификата нет, оставьте в нём только первый блок `server` (порт 80):

   ```bash
   sudo ln -s /etc/nginx/sites-available/etherdisk.conf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. Сертификат выпускает certbot хоста (шаг 3 с контейнерным certbot не нужен), потом верните в конфиг остальные блоки и снова `nginx -t` и `reload`:

   ```bash
   sudo mkdir -p /var/www/certbot
   sudo certbot certonly --webroot -w /var/www/certbot -d etherdisk.app -d www.etherdisk.app
   ```

   В этих блоках журнал пишется без IP-адресов, как обещает политика конфиденциальности.

4. `docker compose up -d --build` и проверка: `curl -I https://etherdisk.app`.

## Резерв места под диски

Каждый купленный диск держит свой неиспользованный объём **на томе как настоящее занятое место**: файл `.reserve` в папке диска, выделенный сразу (`fallocate`, без записи нулей). При минте резервируется весь объём, при загрузке файлов резерв уменьшается ровно на их размер, при удалении — растёт обратно, при форматировании возвращается целиком. Поэтому:

- запись файлов в купленный диск никогда не упрётся в полный том;
- `df` и `/status` показывают как «свободно» то, что **ещё никому не продано**: это и есть запас для новых дисков. Сколько держится под диски — «зарезервировано за дисками» в `/status`;
- новый диск попадает на том, где помещается весь его объём; резерв никогда не забирает последние 5 % тома (там могут жить система и база);
- не хватило места на резерв — тревога в Telegram «Не хватает места на резерв дисков» с номерами дисков: пора добавить хранилище и закрыть продажи. Такой диск хранит только то, что за ним зарезервировано (если места нет совсем — 0 байт): сайт показывает купленный объём зачёркнутым и рядом доступный, загрузки сверх него не проходят, а последние 5 % тома остаются нетронутыми. После расширения хранилища полный объём возвращается сам: освободилось место на томе диска — резерв дорастает (мониторинг проверяет раз в минуту), появился новый массив с местом под весь объём — диск переезжает туда вместе с файлами (на время копирования его загрузки ждут);
- «Мало места» (меньше 15 % свободно) теперь значит «пора планировать расширение»: непроданного запаса осталось мало.

`RESERVE_SPACE=false` в `server.env` выключает резерв (только для разработки). Резерв дисков, купленных раньше, сервер выставляет сам при запуске.

## Добавить хранилище (новый RAID-массив)

Новые диски идут на массив, где для них есть место; купленные остаются там, где были, кроме урезанных (не хватило места на резерв): они сами переезжают на новый массив, если там помещается весь их объём.

1. **Найти новые диски:** `lsblk` (например `sdb`, `sdc`, `sdd`; на них не должно быть ничего нужного).
2. **Собрать массив** (RAID5 из 3+ дисков; от 5–6 дисков надёжнее RAID6, `--level=6`):
   ```bash
   sudo mdadm --create /dev/md1 --level=5 --raid-devices=3 /dev/sdb /dev/sdc /dev/sdd
   sudo mdadm --detail --scan | sudo tee -a /etc/mdadm/mdadm.conf
   sudo update-initramfs -u
   ```
   Первичная синхронизация идёт часами (`cat /proc/mdstat`); пользоваться массивом можно сразу.
3. **Файловая система** без резерва для root (это том данных): `sudo mkfs.ext4 -m 0 /dev/md1`.
4. **Точка монтирования, защищённая от записи без массива**, и автомонтирование по UUID:
   ```bash
   sudo mkdir -p /mnt/raid2 && sudo chattr +i /mnt/raid2
   echo "UUID=$(sudo blkid -s UUID -o value /dev/md1) /mnt/raid2 ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
   sudo mount /mnt/raid2
   ```
5. **Папка для Etherdisk** и права для пользователя контейнера (от `etherdisk`, с rootless Docker):
   ```bash
   sudo mkdir /mnt/raid2/etherdisk && sudo chown etherdisk:etherdisk /mnt/raid2/etherdisk
   docker run --rm -v /mnt/raid2/etherdisk:/d alpine chown 10001:10001 /d
   ```
6. **Подключить к серверу:** `cp storage.yml.example storage.yml` (путь в нём — `/mnt/raid2/etherdisk`), в `.env` добавить `storage.yml` в `COMPOSE_FILE` (например `docker-compose.yml:behind-proxy.yml:storage.yml`), в `server.env` — `DATA_DIR=/mnt/volume1,/mnt/volume2`. Затем `docker compose up -d server`.
7. **Проверить:** в логе (`docker compose logs server | grep "storage volume"`) — оба тома; `/status` в Telegram показывает оба с их свободным местом.

Порядок томов в `DATA_DIR` можно менять: каждый том помнит свой id (файл `.etherdisk-volume`). Убирать том из `DATA_DIR`, пока на нём есть диски, нельзя: сервер сообщит, что они недоступны.

## Резервные копии

База — один файл SQLite в `DB_DIR` (плюс `-wal`/`-shm`). Копировать её на ходу — `sqlite3 etherdisk.db ".backup /куда/etherdisk.db"`. Тома с файлами защищает RAID, но не от удаления, пожара или ошибки контроллера: для них нужна отдельная копия.
