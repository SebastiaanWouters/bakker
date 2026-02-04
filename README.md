# Bakker

Lightweight, self-hosted MariaDB/MySQL backup service with a small web UI, REST API, and cron-based scheduling. Runs fully in Docker and stores backups/config on a mounted `/data` volume.

**What it does**
- Schedules database dumps via cron and keeps a rolling retention per database.
- Exposes a web UI + API to manage config, templates, and passwords.
- Encrypts stored database passwords at rest using AES-256-GCM.
- Provides backup listing, download, delete, and manual trigger endpoints.

## Quick Start (Docker)

```bash
docker run --name bakker \
  -p 3500:3500 \
  -v bakker-data:/data \
  -e AUTH_TOKEN=change-me \
  -e ENCRYPTION_SECRET=change-me-too \
  -e HOST=:: \
  sebaswouters/bakker:latest
```

Then open `http://localhost:3500` and configure databases + schedules.
If you want IPv6 connectivity, ensure Docker IPv6 is enabled on your daemon and publish IPv6 ports accordingly.

## Docker Compose

```yaml
services:
  bakker:
    image: sebaswouters/bakker:latest
    ports:
      - "3500:3500"
    volumes:
      - bakker-data:/data
    environment:
      AUTH_TOKEN: "change-me"
      ENCRYPTION_SECRET: "change-me-too"
      PORT: "3500"
      HOST: "::"
volumes:
  bakker-data:
```

## Configuration

Data is stored under `/data` (mounted volume recommended):
- `/data/config/config.json` - main config
- `/data/config/passwords.enc` - encrypted password store
- `/data/backups` - `.sql.gz` backups
- `/data/logs/backup.log` - cron + backup logs

`config.json` schema:

```json
{
  "retention": 5,
  "databases": {
    "prod": {
      "db_host": "db",
      "db_port": "3306",
      "db_name": "app",
      "db_user": "backup",
      "ignored_tables": ["audit_log"],
      "structure_only_tables": ["sessions"]
    }
  },
  "schedules": [
    { "database": "prod", "cron": "0 */6 * * *" }
  ]
}
```

## Environment Variables

- `PORT` (default `3500`) - HTTP server port.
- `HOST` (default `::`) - HTTP server bind address. Use `::` for IPv6, `0.0.0.0` for IPv4.
- `AUTH_TOKEN` - if set, all `/api/*` endpoints require `Authorization: Bearer <token>`.
- `ENCRYPTION_SECRET` - required to store and retrieve encrypted DB passwords.

If `ENCRYPTION_SECRET` is not set, the password store is disabled and backups can only run if `DB_PASSWORD` is provided to the backup script directly. For scheduled/cron backups, set `ENCRYPTION_SECRET` and use the API/UI to store passwords.

## API Summary

All `/api/*` routes require auth if `AUTH_TOKEN` is set.

- `GET /api/config` - read config
- `PUT /api/config` - update config (validates cron + database references)
- `GET /api/backups` - list backups grouped by database
- `GET /api/backups/:filename` - download backup
- `DELETE /api/backups/:filename` - delete backup
- `POST /api/backups/trigger` - manual backup trigger
- `GET /api/passwords` - list configs with stored passwords
- `POST /api/passwords/:configName` - store password
- `DELETE /api/passwords/:configName` - delete password
- `GET /api/logs` - tail backup log
- `GET /api/status` - current backup status
- `GET /api/templates` - list templates
- `POST /api/templates` / `PUT /api/templates/:name` / `DELETE /api/templates/:name`

## How Backups Work

Backups are created by `/app/scripts/backup.sh` using `mariadb-dump` and gzip. Each backup is saved as:

```
/data/backups/<config>_YYYYMMDD_HHMMSS.sql.gz
```

Retention is enforced after each backup via `/app/scripts/cleanup.sh`.

## Development (Local)

You can run the server locally with Bun:

```bash
bun run server/index.ts
```

Make sure the `/data` paths exist or update them if you’re developing without Docker.

## Troubleshooting

- **Backups fail to run via cron**: confirm `AUTH_TOKEN` and `ENCRYPTION_SECRET` are set and that passwords are stored via the API/UI.
- **`decryptionFailed: true`**: the `ENCRYPTION_SECRET` doesn’t match the existing `passwords.enc` file.
- **No logs**: check `/data/logs/backup.log` and container output.
