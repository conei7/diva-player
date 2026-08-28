import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [
  compose,
  gateway,
  nginx,
  provisioner,
  deploy,
  watchdog,
  watchdogTimer,
  tunnelRunner,
  tunnelUnit,
  tunnelSync,
  tunnelSyncHelper,
  tunnelInstaller,
  pagesProxy,
  tunnelAdmin,
] = await Promise.all([
  readFile(new URL('../backend/docker-compose.dr-standby.yml', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api-gateway/haproxy.dr-standby.cfg', import.meta.url), 'utf8'),
  readFile(new URL('../nginx.dr-standby.conf', import.meta.url), 'utf8'),
  readFile(new URL('./provision-wsl-dr-api-role.sh', import.meta.url), 'utf8'),
  readFile(new URL('./deploy-wsl-dr-standby.sh', import.meta.url), 'utf8'),
  readFile(new URL('./check-wsl-dr-standby.sh', import.meta.url), 'utf8'),
  readFile(new URL('./diva-wsl-dr-watchdog.timer', import.meta.url), 'utf8'),
  readFile(new URL('./run-wsl-dr-quick-tunnel.sh', import.meta.url), 'utf8'),
  readFile(new URL('./diva-wsl-dr-quick-tunnel.service', import.meta.url), 'utf8'),
  readFile(new URL('./sync-quick-tunnel-to-cloudflare.sh', import.meta.url), 'utf8'),
  readFile(new URL('./sync-quick-tunnel-to-cloudflare.py', import.meta.url), 'utf8'),
  readFile(new URL('./install-wsl-dr-quick-tunnel.sh', import.meta.url), 'utf8'),
  readFile(new URL('../functions/backend-api/[[path]].js', import.meta.url), 'utf8'),
  readFile(new URL('../functions/tunnel-admin/update.js', import.meta.url), 'utf8'),
]);

assert.match(compose, /container_name: diva_dr_api_a/);
assert.match(compose, /container_name: diva_dr_api_b/);
assert.match(compose, /container_name: diva_dr_api_gateway/);
assert.match(compose, /container_name: diva_dr_web/);
// The shared API anchor applies one host-network declaration to both slots;
// gateway and Web carry their own declarations.
assert.equal((compose.match(/network_mode: host/g) ?? []).length, 3);
assert.doesNotMatch(compose, /^\s+ports:/m);
assert.match(compose, /Host=127\.0\.0\.1;Port=5432;Database=diva_standby/);
assert.match(compose, /Recommender__QdrantEndpoint: "http:\/\/127\.0\.0\.1:16334"/);
assert.match(compose, /Recommender__QdrantRestEndpoint: "http:\/\/127\.0\.0\.1:16333"/);
assert.match(compose, /DIVA_API_DB_PASSWORD:\?DIVA_API_DB_PASSWORD is required/);
assert.match(compose, /PAGES_PROXY_KEY:\?PAGES_PROXY_KEY is required/);
assert.doesNotMatch(compose, /DIVA_DB_ADMIN_PASSWORD/);
assert.doesNotMatch(compose, /postgres_data|qdrant_data/);
assert.match(compose, /cap_drop:\s*\n\s+- ALL/);
assert.match(compose, /no-new-privileges=true/);
assert.match(gateway, /bind 127\.0\.0\.1:15000/);
assert.match(gateway, /server api_a 127\.0\.0\.1:15001 check/);
assert.match(gateway, /server api_b 127\.0\.0\.1:15002 check/);
assert.match(nginx, /listen 127\.0\.0\.1:18080/);
assert.match(nginx, /absolute_redirect off/);
assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:15000\//);

assert.match(provisioner, /0018_runtime_database_roles\.sql/);
assert.match(provisioner, /root:root/);
assert.match(provisioner, /8#\$env_mode & 077/);
assert.match(provisioner, /diva_api_login_\[a-z0-9\]/);
assert.match(provisioner, /SET LOCAL log_statement = 'none'/);
assert.match(provisioner, /PGPASSFILE="\$passfile"/);
assert.doesNotMatch(provisioner, /echo .*api_password|printf .*api_password/);
assert.match(deploy, /config --quiet/);
assert.match(deploy, /backend-api\/api\/ready/);

assert.match(watchdog, /pg_isready/);
assert.match(watchdog, /127\.0\.0\.1:16333\/healthz/);
assert.match(watchdog, /Repair one slot per run/);
assert.match(watchdogTimer, /OnUnitActiveSec=1min/);
assert.match(tunnelRunner, /backend-api\/api\/ready/);
assert.match(tunnelRunner, /--no-autoupdate/);
assert.match(tunnelUnit, /ProtectSystem=strict/);
assert.match(tunnelUnit, /User=diva-dr-tunnel/);
assert.match(tunnelUnit, /ExecStartPost=\+.*sync-wsl-dr-origin-to-cloudflare\.sh/);
assert.match(tunnelUnit, /TimeoutStartSec=3min/);
assert.match(tunnelUnit, /CapabilityBoundingSet=/);
assert.match(tunnelSync, /DIVA_TUNNEL_ORIGIN_ROLE/);
assert.doesNotMatch(tunnelSync, /\. "\$ENV_FILE"|Authorization: Bearer/);
assert.match(tunnelSyncHelper, /NoRedirectHandler/);
assert.match(tunnelSyncHelper, /RETRYABLE_HTTP_CODES.*424/);
assert.match(tunnelSyncHelper, /outside the fixed Pages update endpoint/);
assert.match(tunnelSyncHelper, /must not be accessible by group\/other/);
assert.match(tunnelInstaller, /useradd --system --user-group/);
assert.match(tunnelInstaller, /systemctl enable --now diva-wsl-dr-quick-tunnel\.service/);
assert.match(pagesProxy, /quick_tunnel_primary_url/);
assert.match(pagesProxy, /quick_tunnel_standby_url/);
assert.match(pagesProxy, /firstResponse\.status < 500/);
assert.match(tunnelAdmin, /originRole/);
assert.match(tunnelAdmin, /quick_tunnel_standby_url/);

console.log('PASS isolated WSL DR standby topology contract');
