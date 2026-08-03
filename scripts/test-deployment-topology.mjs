import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [compose, gateway, nginx, deploy, program] = await Promise.all([
  readFile(new URL('../backend/docker-compose.yml', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api-gateway/haproxy.cfg', import.meta.url), 'utf8'),
  readFile(new URL('../nginx.conf', import.meta.url), 'utf8'),
  readFile(new URL('./deploy-sbc-api-rolling.sh', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Program.cs', import.meta.url), 'utf8'),
]);

assert.match(compose, /api_a:/);
assert.match(compose, /api_b:/);
assert.match(compose, /api_gateway:/);
assert.doesNotMatch(compose, /\n  api:\s*\n/);
assert.match(compose, /Maximum Pool Size=16/);
assert.match(compose, /http:\/\/127\.0\.0\.1:5000\/api\/ready/);
assert.match(gateway, /server api_a api_a:5000 check/);
assert.match(gateway, /server api_b api_b:5000 check/);
assert.match(gateway, /stats socket \/tmp\/haproxy-admin\.sock/);
assert.match(gateway, /balance hdr\(X-Diva-Balance-Key\)/);
assert.match(gateway, /X-Diva-Api-Slot/);
assert.match(nginx, /proxy_pass http:\/\/api_gateway:5000\//);
assert.match(deploy, /disable server api_nodes\/\$slot/);
assert.match(deploy, /wait_slot_sessions "\$slot"/);
assert.match(deploy, /enable server api_nodes\/\$slot/);
assert.match(deploy, /--force-recreate "\$slot"/);
assert.match(deploy, /haproxy -c -f \/usr\/local\/etc\/haproxy\/haproxy\.cfg/);
assert.match(program, /MapGet\("\/api\/ready"/);
assert.match(program, /DisableRateLimiting\(\)/);
assert.match(program, /isTrustedGatewayProxy/);

console.log('PASS rolling deployment topology contract');
