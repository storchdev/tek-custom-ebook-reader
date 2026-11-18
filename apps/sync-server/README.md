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

To update later: `git pull`, rebuild, copy again, then `sudo systemctl restart ttu-sync`.

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

HTTPS via Caddy (`/etc/caddy/Caddyfile`), which gets a certificate automatically:

```
reader.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

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
