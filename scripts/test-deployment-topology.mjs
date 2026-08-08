import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [
  compose,
  gateway,
  nginx,
  deploy,
  program,
  healthEndpoints,
  serviceRegistration,
  warmup,
  dbService,
  schema,
  modelGuardMigration,
  modelGuardIntegration,
] = await Promise.all([
  readFile(new URL('../backend/docker-compose.yml', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api-gateway/haproxy.cfg', import.meta.url), 'utf8'),
  readFile(new URL('../nginx.conf', import.meta.url), 'utf8'),
  readFile(new URL('./deploy-sbc-api-rolling.sh', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Program.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Endpoints/HealthEndpoints.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/ApiServiceRegistration.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/ApiWarmupService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/DbService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/schema.sql', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/migrations/0017_discovery_quality_model_guard.sql', import.meta.url), 'utf8'),
  readFile(new URL('./test-discovery-quality-model-guard.sql', import.meta.url), 'utf8'),
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
assert.match(program, /MapHealthEndpoints\(\)/);
assert.match(healthEndpoints, /MapGet\("\/api\/ready"/);
assert.match(healthEndpoints, /DisableRateLimiting\(\)/);
assert.match(program, /isTrustedGatewayProxy/);
assert.match(serviceRegistration, /AddHostedService<ApiWarmupService>/);
assert.match(warmup, /home-surge/);
assert.match(dbService, /CachedTrending/);
assert.match(dbService, /trending_cache_refresh_failed/);
assert.match(dbService, /CASE WHEN h\.recorded_at IS NULL\s+THEN NULL::double precision/);
assert.doesNotMatch(dbService, /surge_debug_sql/);
assert.ok(
  schema.includes('ADD COLUMN IF NOT EXISTS youtube_views')
    && schema.includes('songs_youtube_views_search_idx')
    &&
  schema.indexOf('ADD COLUMN IF NOT EXISTS youtube_views') < schema.indexOf('songs_youtube_views_search_idx'),
  'fresh schema must add external view columns before creating their indexes',
);
assert.match(schema, /song_discovery_quality_model_version_insert_guard/);
assert.match(schema, /song_discovery_quality_model_version_update_guard/);
assert.match(modelGuardMigration, /expected_model_version\s+TEXT NOT NULL/);
assert.match(modelGuardMigration, /expected_model_version = 'heuristic-v' \|\| expected_revision::text/);
assert.match(modelGuardMigration, /NEW\.expected_revision < OLD\.expected_revision/);
assert.match(modelGuardMigration, /FOR SHARE/);
assert.match(modelGuardMigration, /REFERENCING NEW TABLE AS new_quality_rows/);
assert.match(modelGuardMigration, /FROM new_quality_rows/);
assert.doesNotMatch(modelGuardMigration, /current_setting|set_config/);
assert.match(modelGuardMigration, /RAISE EXCEPTION[\s\S]+model version % is not allowed/);
assert.match(modelGuardIntegration, /ROLLBACK;/);
assert.match(modelGuardIntegration, /outdated model insert was not rejected/);
assert.match(modelGuardIntegration, /outdated model upsert was not rejected/);
assert.match(modelGuardIntegration, /outdated model update was not rejected/);
assert.match(modelGuardIntegration, /model policy downgrade was not rejected/);
assert.match(healthEndpoints, /postgres\.Ok && qdrantStatus\.Ok && discoveryQuality\.Ok/);
assert.match(dbService, /unexpected_model_version/);

console.log('PASS rolling deployment topology contract');
