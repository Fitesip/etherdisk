# Deploying with Docker

Three containers: **nginx** (HTTPS, etherdisk.app) → **web** (Next.js) and **server** (Rust, the API at `/api/`).
The site and the API share one domain, so the site needs no CORS; the desktop app (`desktop/`) is allowed by `CORS_ORIGINS` in `server.env`. The order of a mainnet launch is in `docs/LAUNCH.md`.

## 1. Preparing the host

- Docker with the compose plugin (2.24.4 or newer), ports 80 and 443 open (if they are taken, see "Ports 80 and 443 are taken"), DNS for `etherdisk.app` and `www.etherdisk.app` pointing at the host.
- Folders for the database and the volumes (RAID arrays). The server in its container runs as UID 10001:

```bash
sudo mkdir -p /srv/etherdisk/db /mnt/raid1/etherdisk
sudo chown -R 10001:10001 /srv/etherdisk/db /mnt/raid1/etherdisk
```

- If the array is mounted at `/mnt/raid1`, make the empty mount point read-only **before** mounting (`sudo chattr +i /mnt/raid1`): then without the array the server doesn't start, instead of writing drives to the system partition.

## 2. Settings

```bash
cd deploy
cp .env.example .env               # contract address, RPC, database and volume paths
cp server.env.example server.env   # CHAIN_ID, START_BLOCK, Telegram, moderators
```

Several arrays: see "Adding storage" below (`storage.yml`; no need to edit `docker-compose.yml`).

## 3. Certificate (the first time)

nginx won't start without a certificate, so certbot gets the first one by itself, on port 80:

```bash
docker compose run --rm -p 80:80 certbot certonly --standalone \
  -d etherdisk.app -d www.etherdisk.app --agree-tos -m <your email> --no-eff-email
```

Renewal (daily from cron; certbot decides whether it is due):

```bash
docker compose run --rm certbot renew --webroot -w /var/www/certbot && docker compose exec nginx nginx -s reload
```

## 4. Starting and updating

```bash
docker compose up -d --build      # first build: ~10–20 minutes (Rust and WASM)
docker compose logs -f server     # the server's log: volumes, monitoring, indexer
```

To update after `git pull`: `docker compose up -d --build` again. `NEXT_PUBLIC_*` are baked into the site's image at build time: changing them needs a rebuild.

## Ports 80 and 443 are taken

Only nginx is exposed: the site (3000) and the API (8787) are reachable only inside the compose network. Other ports for nginx: `HTTP_PORT` and `HTTPS_PORT` in `.env`.

If an nginx already installed on the host holds 80 and 443, TLS stays with it and it forwards etherdisk.app to the containers:

1. In `deploy/.env`:

   ```
   COMPOSE_FILE=docker-compose.yml:behind-proxy.yml
   HTTP_PORT=127.0.0.1:8880
   ```

   The container's nginx then listens on `127.0.0.1:8880` only, without TLS (`nginx/etherdisk.behind-proxy.conf`). Any free port works, but on `127.0.0.1` only: the container takes the client's address from `X-Forwarded-For`.

2. Copy `nginx/host-etherdisk.conf` to `/etc/nginx/sites-available/etherdisk.conf` and enable it (the port in `proxy_pass` is the one in `HTTP_PORT`). Until there is a certificate, keep only its first `server` block (port 80):

   ```bash
   sudo ln -s /etc/nginx/sites-available/etherdisk.conf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. The host's certbot gets the certificate (step 3 with the container's certbot isn't needed); then put the other blocks back and run `nginx -t` and `reload` again:

   ```bash
   sudo mkdir -p /var/www/certbot
   sudo certbot certonly --webroot -w /var/www/certbot -d etherdisk.app -d www.etherdisk.app
   ```

   These blocks log without IP addresses, as the privacy policy promises.

4. `docker compose up -d --build`, then check: `curl -I https://etherdisk.app`.

## Space reserved for drives

Every drive sold keeps its unused capacity **on its volume as real used space**: a `.reserve` file in the drive's folder, allocated at once (`fallocate`, without writing zeros). A mint reserves the whole capacity, an upload takes exactly its size from the reservation, deleting gives it back, and a format returns all of it. So:

- writing files to a bought drive never hits a full volume;
- `df` and `/status` show as "free" what **hasn't been sold to anyone yet**: that is the stock for new drives. How much is held for drives is "reserved for drives" in `/status`;
- a new drive goes to a volume that fits its whole capacity; the reservation never takes a volume's last 5% (the system and the database may live there);
- when there is no room left to reserve, Telegram gets "Not enough space to reserve for drives" with the drive numbers: time to add storage and close sales. Such a drive stores only what is reserved for it (0 bytes if nothing): the site shows the bought capacity struck through next to the usable one, uploads beyond it fail, and a volume's last 5% stays untouched. Once storage grows, the full capacity comes back by itself: space freed on the drive's volume grows its reservation (the monitor checks every minute), and a new array with room for the whole capacity gets the drive moved there with its files (its uploads wait during the copy);
- "Low on space" (under 15% free) now means "time to plan more storage": little unsold stock is left.

`RESERVE_SPACE=false` in `server.env` turns the reservation off (for development only). The server sets up the reservation of drives bought earlier by itself at startup.

## Adding storage (a new RAID array)

New drives go to an array with room for them; bought ones stay where they are, except short ones (no room for their reservation): they move to the new array by themselves if it fits their whole capacity.

1. **Find the new disks:** `lsblk` (say `sdb`, `sdc`, `sdd`; nothing on them must be needed).
2. **Build the array** (RAID5 of 3+ disks; with 5–6 disks RAID6 is safer, `--level=6`):
   ```bash
   sudo mdadm --create /dev/md1 --level=5 --raid-devices=3 /dev/sdb /dev/sdc /dev/sdd
   sudo mdadm --detail --scan | sudo tee -a /etc/mdadm/mdadm.conf
   sudo update-initramfs -u
   ```
   The initial sync takes hours (`cat /proc/mdstat`); the array can be used right away.
3. **A file system** without a root reserve (it is a data volume): `sudo mkfs.ext4 -m 0 /dev/md1`.
4. **A mount point that can't be written without the array**, and mounting by UUID at boot:
   ```bash
   sudo mkdir -p /mnt/raid2 && sudo chattr +i /mnt/raid2
   echo "UUID=$(sudo blkid -s UUID -o value /dev/md1) /mnt/raid2 ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
   sudo mount /mnt/raid2
   ```
5. **A folder for Etherdisk** and permissions for the container's user (as `etherdisk`, with rootless Docker):
   ```bash
   sudo mkdir /mnt/raid2/etherdisk && sudo chown etherdisk:etherdisk /mnt/raid2/etherdisk
   docker run --rm -v /mnt/raid2/etherdisk:/d alpine chown 10001:10001 /d
   ```
6. **Connect it to the server:** `cp storage.yml.example storage.yml` (the path in it is `/mnt/raid2/etherdisk`), add `storage.yml` to `COMPOSE_FILE` in `.env` (say `docker-compose.yml:behind-proxy.yml:storage.yml`) and set `DATA_DIR=/mnt/volume1,/mnt/volume2` in `server.env`. Then `docker compose up -d server`.
7. **Check:** the log (`docker compose logs server | grep "storage volume"`) lists both volumes; `/status` in Telegram shows both with their free space.

The order of volumes in `DATA_DIR` can change: each volume remembers its id (the `.etherdisk-volume` file). A volume can't be taken out of `DATA_DIR` while drives live on it: the server reports them unavailable.

## Backups

The database is one SQLite file in `DB_DIR` (plus `-wal`/`-shm`). To copy it while running: `sqlite3 etherdisk.db ".backup /somewhere/etherdisk.db"`. RAID protects the file volumes, but not against deletion, fire or a controller failure: they need a separate copy.
