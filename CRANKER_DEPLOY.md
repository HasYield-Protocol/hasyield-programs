# Rebalance Cranker — VPS deploy

Runs `scripts/rebalance-cranker.ts --loop` on Contabo VPS under a systemd unit. Emits `run-log.jsonl` which a tiny nginx vhost serves back to the frontend so Chapter 02 can show "last run · next in …" from real data.

## 1. One-time setup on the VPS

```bash
ssh -i ~/.ssh/id_ed25519 root@77.237.243.126
mkdir -p /opt/hasyield/programs
# From your laptop:
scp -i ~/.ssh/id_ed25519 -r \
  hasyield-programs/{scripts,package.json,package-lock.json,tsconfig.json} \
  root@77.237.243.126:/opt/hasyield/programs/

# Solana keypair for the cranker
scp -i ~/.ssh/id_ed25519 ~/.config/solana/id.json \
  root@77.237.243.126:/root/.config/solana/id.json

# On the VPS
cd /opt/hasyield/programs
apt-get install -y nodejs npm
npm ci
npm i -g ts-node typescript
```

## 2. systemd service

`/etc/systemd/system/hasyield-cranker.service`:

```ini
[Unit]
Description=HasYield rebalance cranker
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/hasyield/programs
Environment=NODE_ENV=production
ExecStart=/usr/bin/ts-node scripts/rebalance-cranker.ts --loop --interval=21600
Restart=on-failure
RestartSec=60
StandardOutput=append:/var/log/hasyield-cranker.log
StandardError=append:/var/log/hasyield-cranker.log

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now hasyield-cranker
systemctl status hasyield-cranker
tail -f /var/log/hasyield-cranker.log
```

## 3. Expose run-log.jsonl via nginx

The frontend reads the last JSON line. Serve the file read-only:

`/etc/nginx/sites-available/hasyield-cranker`:

```nginx
server {
  listen 80;
  server_name cranker.robbyn.xyz;

  location = /status {
    default_type application/json;
    # Return {last, intervalSec} — the last line of run-log.jsonl plus interval
    alias /opt/hasyield/programs/run-log.jsonl;
    # Simpler: serve raw tail via a lightweight shim
    return 301 /tail;
  }

  # Simpler approach: serve the file; the Next.js API can tail it
  location /run-log.jsonl {
    alias /opt/hasyield/programs/run-log.jsonl;
    add_header Access-Control-Allow-Origin *;
    add_header Cache-Control "no-store";
  }
}
```

Even simpler: skip nginx, use the Next.js `/api/cranker/status` route with the full log fetched from nginx and parse server-side. Add a DNS A record for `cranker.robbyn.xyz → 77.237.243.126` in Cloudflare.

## 4. Point the frontend at the VPS

Set in the hasyield-app production env:

```
CRANKER_STATUS_REMOTE=https://cranker.robbyn.xyz/status
CRANKER_INTERVAL_SEC=21600
```

`/api/cranker/status` will prefer the remote and fall back to the local log file.

## 5. Log rotation

`/etc/logrotate.d/hasyield-cranker`:

```
/var/log/hasyield-cranker.log {
  weekly
  rotate 4
  compress
  missingok
  notifempty
}

/opt/hasyield/programs/run-log.jsonl {
  monthly
  rotate 6
  compress
  missingok
  notifempty
  copytruncate
}
```

## 6. Sanity check

```bash
# On the VPS
journalctl -u hasyield-cranker -n 50
tail -5 /opt/hasyield/programs/run-log.jsonl

# From anywhere
curl https://cranker.robbyn.xyz/run-log.jsonl | tail -1 | jq .
```
