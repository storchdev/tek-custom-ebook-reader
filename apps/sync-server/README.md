# ttu-sync

A tiny self-hosted sync server: one ~6 MB static binary, a few MB of RAM. It serves

- a password-protected WebDAV share at `/dav/` that the reader syncs books, progress,
  highlights/notes, statistics and goals to, and
- optionally the reader itself at `/`, so the app and your data share one origin (no CORS setup).

Any other WebDAV server works too (Nextcloud, `rclone serve webdav`, ...) as long as it allows
CORS from wherever you load the reader.

## Get the code and build

You need Node.js 20+ (with `corepack` for pnpm) and Go 1.22+.

```sh
git clone https://github.com/storchdev/tek-custom-ebook-reader.git
cd tek-custom-ebook-reader
corepack enable && pnpm install

(cd apps/web && pnpm build)                                         # the reader -> apps/web/build
(cd apps/sync-server && CGO_ENABLED=0 go build -ldflags="-s -w" -o ttu-sync .)

sudo mkdir -p /opt/ttu-sync
sudo cp apps/sync-server/ttu-sync /opt/ttu-sync/
sudo cp -r apps/web/build /opt/ttu-sync/build
```

Building the reader needs about 1 GB of RAM. On a very small VPS, run the same build on your
own computer instead and copy the results over (for an ARM VPS add `GOARCH=arm64` to the Go build):

```sh
rsync -a apps/sync-server/ttu-sync apps/web/build you@your-vps:/opt/ttu-sync/
```

To update later: `git pull`, rebuild (with the same `VITE_PAGE_PATH` if you use one), copy again,
then `sudo systemctl restart ttu-sync`.

## Run on a VPS

`/etc/systemd/system/ttu-sync.service`:

```ini
[Unit]
Description=ttu reader sync
After=network.target

[Service]
DynamicUser=yes
StateDirectory=ttu-sync
Environment=TTU_USER=me
Environment=TTU_PASS=change-me-to-something-long
ExecStart=/opt/ttu-sync/ttu-sync -addr 127.0.0.1:8080 -data /var/lib/ttu-sync -app /opt/ttu-sync/build
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then put it behind HTTPS with Caddy or nginx (below).

### Caddy

`/etc/caddy/Caddyfile` (Caddy gets a certificate automatically):

```
reader.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

### nginx, on its own domain (`https://reader.example.com`)

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name reader.example.com;
    ssl_certificate     /etc/letsencrypt/live/reader.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/reader.example.com/privkey.pem;

    client_max_body_size 500m;          # nginx refuses bodies over 1 MB by default; books are bigger

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $http_host;   # required, see below
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

### nginx, under a path (`https://example.com/reader/`)

Build the reader for that path, and let nginx serve it directly. Then ttu-sync only does the
WebDAV part, so drop `-app` and pass `-prefix /reader/dav/` in the systemd unit instead:

```sh
(cd apps/web && VITE_PAGE_PATH=/reader pnpm build)
sudo mkdir -p /var/www/reader && sudo rsync -a --delete apps/web/build/ /var/www/reader/
```

```ini
ExecStart=/opt/ttu-sync/ttu-sync -addr 127.0.0.1:8080 -data /var/lib/ttu-sync -prefix /reader/dav/
```

Add this to the existing `server { ... }` block for example.com:

```nginx
    client_max_body_size 500m;

    location = /reader { return 301 /reader/; }

    location /reader/dav/ {
        proxy_pass http://127.0.0.1:8080;   # no trailing slash: keep the /reader/dav/ path
        proxy_set_header Host $http_host;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /reader/ {
        root /var/www;
        try_files $uri $uri.html $uri/ /reader/404.html;
    }
```

In the reader the Server URL is then `https://example.com/reader/dav/`.

Why `Host $http_host`: syncing renames files with WebDAV `MOVE`, and the server refuses a move
whose destination host differs from the request's host (502 "invalid destination"). nginx sends
`127.0.0.1:8080` by default; `$host` would drop a non-default port.

Always put it behind HTTPS: the reader sends the WebDAV password with every request.

## Connect the reader

On each device open `https://reader.example.com`, then Settings → Data → Storage Sources → Add:

- Type: **WebDAV (self-hosted)**
- Server URL: `https://reader.example.com/dav/`
- WebDAV username / password: `TTU_USER` / `TTU_PASS`
- Tick **Is Sync Target** and **Is Source Default**
- Password / Confirm Password encrypts these credentials in the browser (or tick "Disable Password
  Encryption" to never be asked)

Then set **Auto Import/Export** to `All`. Opening a book pulls its progress and highlights;
reading, highlighting, editing notes and deleting highlights push them (batched every minute, or
tap the cloud icon in the reader footer). In the book manager, switch the storage source to
WebDAV to see and download books added on other devices.

### Using the public reader.ttsu.app-style hosting instead

If you load the reader from a different origin than the server, allow it explicitly:

```sh
ttu-sync -cors https://your-reader-origin.example
```

## Options

| flag      | env                | default  |                                          |
| --------- | ------------------ | -------- | ---------------------------------------- |
| `-addr`   | `TTU_ADDR`         | `:8080`  | listen address                           |
| `-data`   | `TTU_DATA`         | `./data` | where synced files are stored            |
| `-app`    | `TTU_APP`          |          | built reader to serve at `/`             |
| `-prefix` | `TTU_PREFIX`       | `/dav/`  | WebDAV path                              |
| `-cors`   | `TTU_CORS_ORIGINS` |          | comma separated origins allowed via CORS |
|           | `TTU_USER`         |          | required                                 |
|           | `TTU_PASS`         |          | required                                 |

Back up the data directory like any other folder; it is the same layout the reader writes to
Google Drive / OneDrive (`ttu-reader-data/<book title>/...`).
