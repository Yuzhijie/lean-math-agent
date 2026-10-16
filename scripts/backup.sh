#!/bin/sh
# Back up the app-data volume to ./backups/app-data-<time>.tar.gz: SQLite databases are copied
# consistently (better-sqlite3 online backup, safe while the app runs), everything else as is
# (question banks, session files, proof memory, invites).
#
# Run from the deployment directory, e.g. daily from cron:
#   0 3 * * * cd /srv/lean-math-agent && sh scripts/backup.sh && find backups -mtime +14 -delete
# Copy the backups off the server (another region or a bucket): a backup on the same disk is not one.
#
# Restore:
#   docker compose down
#   docker run --rm -v <project>_app-data:/data -v "$PWD/backups":/b debian:bookworm-slim \
#     sh -c 'cd /data && tar xzf /b/app-data-<time>.tar.gz'
#   docker compose up -d
set -eu
mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T web node -e '
const Database = require("better-sqlite3"); const fs = require("fs"); const path = require("path");
const src = "/app/data", dst = "/tmp/app-data-backup";
fs.rmSync(dst, { recursive: true, force: true });
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
(async () => {
  let dbs = 0, files = 0;
  for (const f of walk(src)) {
    if (/\.(db|sqlite)-(wal|shm|journal)$/.test(f)) continue;
    const out = path.join(dst, path.relative(src, f));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (/\.(db|sqlite)$/.test(f)) { const db = new Database(f, { readonly: true }); await db.backup(out); db.close(); dbs++; }
    else { fs.copyFileSync(f, out); files++; }
  }
  console.error(`snapshot: ${dbs} databases, ${files} files`);
})().catch((e) => { console.error(e); process.exit(1); });
'
docker compose exec -T web tar czf - -C /tmp/app-data-backup . > "backups/app-data-$stamp.tar.gz"
docker compose exec -T web rm -rf /tmp/app-data-backup
echo "backups/app-data-$stamp.tar.gz"
