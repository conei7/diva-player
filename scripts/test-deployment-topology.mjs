import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [
  compose,
  gateway,
  nginx,
  deploy,
  program,
  healthEndpoints,
  songReadEndpoints,
  serviceRegistration,
  warmup,
  dbService,
  recommenderOptions,
  searchRequest,
  searchResponseCache,
  appsettings,
  workflow,
  apiTestsProject,
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
  readFile(new URL('../backend/api/VocadbRecommender/Endpoints/SongReadEndpoints.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/ApiServiceRegistration.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/ApiWarmupService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/DbService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/RecommenderOptions.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/SongSearchRequest.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/SearchResponseCache.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/appsettings.json', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender.Tests/VocadbRecommender.Tests.csproj', import.meta.url), 'utf8'),
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
assert.match(healthEndpoints, /warmupSnapshot\.Failures\.Count == 0/);
assert.match(program, /isTrustedGatewayProxy/);
assert.match(serviceRegistration, /AddHostedService<ApiWarmupService>/);
assert.match(warmup, /home-surge/);
assert.match(compose, /Recommender__SearchCacheSizeMiB: "64"/);
assert.match(compose, /Recommender__SearchCacheEntrySizeMiB: "8"/);
assert.match(appsettings, /"SearchCacheSizeMiB": 64/);
assert.match(appsettings, /"SearchCacheEntrySizeMiB": 8/);
assert.match(recommenderOptions, /SearchCacheSizeMiB \{ get; set; \} = 64/);
assert.match(recommenderOptions, /SearchCacheEntrySizeMiB \{ get; set; \} = 8/);
assert.match(serviceRegistration, /AddSingleton<SearchResponseCache>/);
assert.match(serviceRegistration, /SearchCacheEntrySizeMiB <= options\.SearchCacheSizeMiB/);
assert.match(searchRequest, /SHA256\.HashData\(canonicalJson\)/);
assert.match(searchRequest, /string\.IsNullOrWhiteSpace\(query\) \? null : query/);
assert.doesNotMatch(searchRequest, /\n            Query:.*(?:Trim|ToLower|Normalize)/);
assert.match(searchRequest, /normalizedInstrumentKeys is not null && instrumentMatchMode == "any"/);
assert.match(searchRequest, /normalizedTagIds is not null && tagMatchMode == "any"/);
assert.match(searchResponseCache, /MinimumEntryChargeBytes = 4 \* 1024/);
assert.match(searchResponseCache, /SizeLimit = sizeLimitBytes/);
assert.match(searchResponseCache, /FreshLifetime = TimeSpan\.FromMinutes\(1\)/);
assert.match(searchResponseCache, /StaleLifetime = TimeSpan\.FromHours\(6\)/);
assert.match(searchResponseCache, /RefreshFailureBackoff = TimeSpan\.FromSeconds\(30\)/);
assert.match(searchResponseCache, /AbsoluteExpirationRelativeToNow = StaleLifetime/);
assert.match(searchResponseCache, /chargeBytes > _maxEntryBytes/);
assert.match(searchResponseCache, /chargeBytes > _maxEntryBytes\)\s*\{\s*_cache\.Remove\(key\)/);
assert.match(searchResponseCache, /stale\.RefreshRetryAfterUtcTicks/);
assert.match(searchResponseCache, /LoadAfterCacheRecheckAsync/);
assert.match(dbService, /_searchCache\.GetOrCreateAsync/);
assert.doesNotMatch(dbService, /CachedSongSearch|song-search:v2|_searchRefreshes/);
assert.match(program, /!double\.IsFinite\(bpmFrom\.Value\)/);
assert.match(program, /!double\.IsFinite\(bpmTo\.Value\)/);
assert.match(apiTestsProject, /PackageReference Include="xunit"/);
assert.match(workflow, /dotnet test backend\/api\/VocadbRecommender\.Tests\/VocadbRecommender\.Tests\.csproj --configuration Release/);
const externalViewsEndpoint = songReadEndpoints.match(
  /private static async Task<IResult> GetExternalViewsAsync\([\s\S]*?\n    }\n\n    private static async Task<IResult> GetViewHistoryAsync/,
)?.[0];
assert.ok(externalViewsEndpoint, 'external views endpoint contract was not found');
assert.match(externalViewsEndpoint, /rawIds\.Length > 500/);
assert.match(externalViewsEndpoint, /CancellationToken cancellationToken/);
assert.match(externalViewsEndpoint, /GetExternalViewCountsAsync\(idList, cancellationToken\)/);
assert.doesNotMatch(externalViewsEndpoint, /GetSongInfoBatchAsync/);
const externalViewsQuery = dbService.match(
  /public async Task<Dictionary<int, ExternalViewCounts>> GetExternalViewCountsAsync\([\s\S]*?\n    }\n\n    public async Task<SongInfo\?>/,
)?.[0];
assert.ok(externalViewsQuery, 'lightweight external views query contract was not found');
assert.match(externalViewsQuery, /SELECT id, youtube_views, nico_views\s+FROM songs\s+WHERE id = ANY\(\$1\)/);
assert.match(externalViewsQuery, /OpenAsync\(cancellationToken\)/);
assert.match(externalViewsQuery, /ExecuteReaderAsync\(cancellationToken\)/);
assert.match(externalViewsQuery, /ReadAsync\(cancellationToken\)/);
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
