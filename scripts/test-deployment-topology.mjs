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
  rankingRequest,
  searchResponseCache,
  recommendationObjectCache,
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
  readFile(new URL('../backend/api/VocadbRecommender/Services/RankingRequest.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/SearchResponseCache.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/RecommendationObjectCache.cs', import.meta.url), 'utf8'),
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
assert.match(compose, /Recommender__ObjectCacheSizeMiB: "64"/);
assert.match(compose, /Recommender__ObjectCacheEntrySizeMiB: "16"/);
assert.match(appsettings, /"SearchCacheSizeMiB": 64/);
assert.match(appsettings, /"SearchCacheEntrySizeMiB": 8/);
assert.match(appsettings, /"ObjectCacheSizeMiB": 64/);
assert.match(appsettings, /"ObjectCacheEntrySizeMiB": 16/);
assert.match(recommenderOptions, /SearchCacheSizeMiB \{ get; set; \} = 64/);
assert.match(recommenderOptions, /SearchCacheEntrySizeMiB \{ get; set; \} = 8/);
assert.match(recommenderOptions, /ObjectCacheSizeMiB \{ get; set; \} = 64/);
assert.match(recommenderOptions, /ObjectCacheEntrySizeMiB \{ get; set; \} = 16/);
assert.match(serviceRegistration, /AddSingleton<SearchResponseCache>/);
assert.match(serviceRegistration, /AddSingleton<RecommendationObjectCache>/);
assert.match(serviceRegistration, /SearchCacheEntrySizeMiB <= options\.SearchCacheSizeMiB/);
assert.match(serviceRegistration, /ObjectCacheEntrySizeMiB <= options\.ObjectCacheSizeMiB/);
assert.doesNotMatch(serviceRegistration, /AddMemoryCache/);
assert.match(searchRequest, /SHA256\.HashData\(canonicalJson\)/);
assert.match(searchRequest, /string\.IsNullOrWhiteSpace\(query\) \? null : query/);
assert.doesNotMatch(searchRequest, /\n            Query:.*(?:Trim|ToLower|Normalize)/);
assert.match(searchRequest, /normalizedInstrumentKeys is not null && instrumentMatchMode == "any"/);
assert.match(searchRequest, /normalizedTagIds is not null && tagMatchMode == "any"/);
assert.match(rankingRequest, /"pace" or "popular" => "pace"/);
assert.match(rankingRequest, /normalizedMode is "alltime" or "pace" or "surge" or "recent"/);
assert.match(rankingRequest, /Order\(StringComparer\.Ordinal\)/);
assert.match(searchResponseCache, /MinimumEntryChargeBytes = 4 \* 1024/);
assert.match(searchResponseCache, /SizeLimit = sizeLimitBytes/);
assert.match(searchResponseCache, /FreshLifetime = TimeSpan\.FromMinutes\(1\)/);
assert.match(searchResponseCache, /RankingFreshLifetime = TimeSpan\.FromMinutes\(5\)/);
assert.match(searchResponseCache, /StaleLifetime = TimeSpan\.FromHours\(6\)/);
assert.match(searchResponseCache, /RefreshFailureBackoff = TimeSpan\.FromSeconds\(30\)/);
assert.match(searchResponseCache, /AbsoluteExpirationRelativeToNow = StaleLifetime/);
assert.match(searchResponseCache, /chargeBytes > _maxEntryBytes/);
assert.match(searchResponseCache, /chargeBytes > _maxEntryBytes\)\s*\{\s*_cache\.Remove\(key\)/);
assert.match(searchResponseCache, /stale\.RefreshRetryAfterUtcTicks/);
assert.match(searchResponseCache, /LoadAfterCacheRecheckAsync/);
assert.match(searchResponseCache, /GetOrCreateRankingAsync/);
assert.match(searchResponseCache, /trending_cache_refresh_failed/);
assert.match(recommendationObjectCache, /SizeLimit = sizeLimitBytes/);
assert.match(recommendationObjectCache, /MinimumEntryChargeBytes = 4 \* 1024/);
assert.match(dbService, /_searchCache\.GetOrCreateAsync/);
assert.match(dbService, /_searchCache\.GetOrCreateRankingAsync/);
assert.match(dbService, /RecommendationObjectCache _objectCache/);
assert.match(dbService, /platform_view_weight_profile/);
assert.match(dbService, /knowledge_map_catalog_v1/);
assert.match(dbService, /\$"song:\{id\}"/);
assert.match(dbService, /\$"metadata-relationship:\{seedSongId\}:\{normalizedLimit\}"/);
assert.match(dbService, /\$"diverse-fallback:\{seedSongId\}:\{normalizedLimit\}"/);
assert.match(dbService, /markov_matrix/);
assert.doesNotMatch(dbService, /_cache\.(?:TryGetValue|Set)/);
assert.match(dbService, /TimeSpan\.FromMinutes\(30\)/);
assert.match(dbService, /TimeSpan\.FromMinutes\(15\)/);
assert.match(dbService, /TimeSpan\.FromHours\(1\)/);
assert.doesNotMatch(dbService, /CachedSongSearch|song-search:v2|_searchRefreshes|CachedTrending|_trendingRefreshes|\bIMemoryCache\b/);
assert.doesNotMatch(program, /X-Diva-Ranking-Cache/);
assert.match(program, /!double\.IsFinite\(bpmFrom\.Value\)/);
assert.match(program, /!double\.IsFinite\(bpmTo\.Value\)/);
assert.match(apiTestsProject, /PackageReference Include="xunit"/);
assert.match(workflow, /dotnet test backend\/api\/VocadbRecommender\.Tests\/VocadbRecommender\.Tests\.csproj --configuration Release/);
const rankingEndpoint = program.match(
  /app\.MapGet\("\/api\/songs\/trending"[\s\S]*?app\.MapGet\("\/api\/songs\/search"/,
)?.[0];
assert.ok(rankingEndpoint, 'ranking endpoint contract was not found');
assert.ok(
  rankingEndpoint.indexOf('excludedTypes.Count > 20') < rankingEndpoint.indexOf('GetTrendingSongsJsonAsync'),
  'raw ranking filter validation must run before canonical cache normalization',
);
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
const audioHealthQuery = dbService.match(
  /public async Task<AudioFeatureHealth> CheckAudioFeatureHealthAsync\([\s\S]*?\n    }\n\n    public Task<SongSearchExecution>/,
)?.[0];
assert.ok(audioHealthQuery, 'audio feature health query contract was not found');
assert.match(audioHealthQuery, /s\.original_version_id/);
assert.match(audioHealthQuery, /h\.original_version_id IS NOT NULL/);
assert.match(audioHealthQuery, /sa_orig\.song_id = h\.original_version_id/);
assert.doesNotMatch(audioHealthQuery, /raw_json/);
assert.match(warmup, /home-popular/);
assert.match(warmup, /home-pace/);
assert.match(warmup, /home-surge/);
assert.match(warmup, /home-recent/);
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
