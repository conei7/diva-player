import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [
  compose,
  gateway,
  nginx,
  deploy,
  program,
  publicationMiddleware,
  publicationGuard,
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
  qdrantService,
  recommendService,
  digDiscoveryService,
  markovService,
  youtubePlaylistService,
  nicoPlaylistService,
  appsettings,
  workflow,
  apiTestsProject,
  schema,
  modelGuardMigration,
  modelGuardIntegration,
  readinessProbeService,
  runtimeTelemetryService,
  namedTunnelRunner,
  namedTunnelUnit,
  tunnelAdmin,
  quickTunnelSync,
  runtimeRoleMigration,
  apiSettings,
  backendEnvExample,
  discoveryEligibleLookupMigration,
] = await Promise.all([
  readFile(new URL('../backend/docker-compose.yml', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api-gateway/haproxy.cfg', import.meta.url), 'utf8'),
  readFile(new URL('../nginx.conf', import.meta.url), 'utf8'),
  readFile(new URL('./deploy-sbc-api-rolling.sh', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Program.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/RecommendationPublicationMiddleware.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/RecommendationPublicationGuard.cs', import.meta.url), 'utf8'),
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
  readFile(new URL('../backend/api/VocadbRecommender/Services/QdrantService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/RecommendService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/DigDiscoveryService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/MarkovService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/YouTubePlaylistService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/NicoPlaylistService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/appsettings.json', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender.Tests/VocadbRecommender.Tests.csproj', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/schema.sql', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/migrations/0017_discovery_quality_model_guard.sql', import.meta.url), 'utf8'),
  readFile(new URL('./test-discovery-quality-model-guard.sql', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/ApiReadinessProbeService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/ApiRuntimeTelemetryService.cs', import.meta.url), 'utf8'),
  readFile(new URL('./run-cloudflare-named-tunnel.sh', import.meta.url), 'utf8'),
  readFile(new URL('./diva-cloudflare-named-tunnel.service', import.meta.url), 'utf8'),
  readFile(new URL('../functions/tunnel-admin/update.js', import.meta.url), 'utf8'),
  readFile(new URL('./sync-quick-tunnel-to-cloudflare.sh', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/migrations/0018_runtime_database_roles.sql', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/appsettings.json', import.meta.url), 'utf8'),
  readFile(new URL('../backend/.env.example', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/migrations/0021_discovery_eligible_song_lookup.sql', import.meta.url), 'utf8'),
]);

assert.match(compose, /api_a:/);
assert.match(compose, /api_b:/);
assert.match(compose, /api_gateway:/);
assert.doesNotMatch(compose, /\n  api:\s*\n/);
assert.match(compose, /image: "\$\{DIVA_API_IMAGE:-diva-player-api:local\}"/);
assert.match(compose, /image: "\$\{DIVA_GATEWAY_IMAGE:-diva-player-api-gateway:local\}"/);
assert.match(compose, /image: "\$\{DIVA_WEB_IMAGE:-diva-player-web:local\}"/);
assert.match(compose, /Maximum Pool Size=16/);
assert.match(compose, /DIVA_API_DB_USER:\?DIVA_API_DB_USER is required/);
assert.match(compose, /DIVA_API_DB_PASSWORD:\?DIVA_API_DB_PASSWORD is required/);
assert.match(compose, /DIVA_DB_ADMIN_PASSWORD:\?DIVA_DB_ADMIN_PASSWORD is required/);
assert.match(compose, /PAGES_PROXY_KEY:\?PAGES_PROXY_KEY is required/);
assert.doesNotMatch(compose, /vocadb_secret/);
assert.doesNotMatch(apiSettings, /vocadb_secret|Password=/);
assert.doesNotMatch(backendEnvExample, /vocadb_secret/);
assert.match(
  schema,
  /CREATE INDEX IF NOT EXISTS song_discovery_eligible_song_idx\s+ON song_discovery_quality \(song_id\)\s+WHERE discovery_eligible;/,
);
assert.match(
  discoveryEligibleLookupMigration,
  /CREATE INDEX CONCURRENTLY IF NOT EXISTS song_discovery_eligible_song_idx\s+ON song_discovery_quality \(song_id\)\s+WHERE discovery_eligible;/,
);
assert.doesNotMatch(discoveryEligibleLookupMigration, /\b(?:DROP|DELETE|UPDATE|GRANT|REVOKE)\b/i);
assert.match(discoveryEligibleLookupMigration, /index_state\.indisvalid/);
assert.match(discoveryEligibleLookupMigration, /index_state\.indisready/);
assert.match(discoveryEligibleLookupMigration, /pg_get_expr\(index_state\.indpred, index_state\.indrelid, FALSE\) = 'discovery_eligible'/);
assert.match(discoveryEligibleLookupMigration, /invalid or unexpected semantics/);
assert.match(workflow, /backend\/database\/migrations\/0021_discovery_eligible_song_lookup\.sql/);
assert.match(workflow, /DROP INDEX song_discovery_eligible_song_idx/);
assert.match(workflow, /indisvalid AND indisready/);
assert.match(apiSettings, /"CollectionHybrid": "song_hybrid_active"/);
assert.match(apiSettings, /"CollectionMetadata": "song_metadata_active"/);
assert.match(apiSettings, /"CollectionAudio": "song_audio"/);
assert.match(apiSettings, /"CollectionNamed": "songs_v2_active"/);
assert.match(qdrantService, /GetCollectionInfoAsync\(collectionName, cancellationToken\)/);
assert.match(qdrantService, /ListAliasesAsync\(cancellationToken\)/);
assert.match(qdrantService, /ValidateRecommendationAliasTargets/);
assert.match(qdrantService, /RecommendationAliasGenerationMismatch/);
assert.match(qdrantService, /db\.ReadRecommendationPublicationGenerationUncachedAsync/);
assert.match(qdrantService, /RecommendationPublicationGenerationInvalid/);
assert.match(qdrantService, /_opts\.CollectionNamed[\s\S]*_opts\.CollectionHybrid[\s\S]*_opts\.CollectionMetadata[\s\S]*_opts\.CollectionAudio/);
const audioOnlySearch = qdrantService.match(
  /public async Task<List<\(int SongId, double Score\)>> SearchAudioOnlyAsync[\s\S]*?public async Task<List<\(int SongId, double Score\)>> SearchMetadataSimilarAsync/,
)?.[0];
assert.ok(audioOnlySearch, 'audio-only Qdrant search contract was not found');
assert.match(audioOnlySearch, /collectionName: _opts\.CollectionAudio/);
assert.doesNotMatch(audioOnlySearch, /collectionName: _opts\.CollectionNamed/);
assert.doesNotMatch(audioOnlySearch, /vectorName: "audio"/);
assert.match(qdrantService, /CollectionUnavailable:/);
assert.match(serviceRegistration, /collection names must be non-empty and distinct/);
assert.match(serviceRegistration, /AddSingleton<RecommendationPublicationGuard>/);
assert.match(dbService, /recommendation_publication_generation/);
assert.match(dbService, /ReadRecommendationPublicationGenerationUncachedAsync/);
assert.match(dbService, /RecommendationPublicationGenerationCacheDuration[\s\S]*TimeSpan\.FromSeconds\(5\)/);
const audioHealthSelector = dbService.match(
  /public async Task<AudioFeatureHealth> CheckAudioFeatureHealthAsync[\s\S]*?public Task<SongSearchExecution> SearchSongsAsync/,
)?.[0];
assert.ok(audioHealthSelector, 'audio feature health selector contract was not found');
assert.match(audioHealthSelector, /AND " \+ AudioHealthActionablePvPredicateSql \+ @"/);
assert.match(
  dbService,
  /AudioHealthActionablePvPredicateSql = """[\s\S]*?p\.disabled = FALSE[\s\S]*?p\.pv_type IN \('Original', 'Reprint'\)[\s\S]*?p\.service IN \('Youtube', 'NicoNicoDouga'\)[\s\S]*?NULLIF\(BTRIM\(p\.pv_id\), ''\) IS NOT NULL[\s\S]*?""";/,
);
assert.match(dbService, /_publicationGenerationLock\.WaitAsync\(cancellationToken\)/);
assert.match(dbService, /ObserveRecommendationPublicationGenerationAsync/);
assert.match(dbService, /RecommendationCacheKey\(publicationGeneration, \$"song:\{id\}"\)/);
assert.match(dbService, /RecommendationCacheKey\(publicationGeneration, "markov_matrix"\)/);
assert.match(program, /UseMiddleware<RecommendationPublicationMiddleware>/);
assert.match(publicationMiddleware, /path\.StartsWithSegments\("\/api\/recommend"\)/);
assert.match(publicationMiddleware, /await using \(lease\)[\s\S]*await next\(context\)/);
assert.match(publicationMiddleware, /recommendation_publication_in_progress/);
assert.match(publicationMiddleware, /StatusCodes\.Status503ServiceUnavailable/);
assert.match(publicationGuard, /pg_advisory_lock_shared/);
assert.match(publicationGuard, /pg_advisory_unlock_shared/);
assert.match(publicationGuard, /recommendation_publication_in_progress/);
assert.match(publicationGuard, /ReadSnapshotAsync[\s\S]*ObserveRecommendationPublicationGenerationAsync|_observeGeneration/);
assert.match(compose, /max-size: "10m"/);
assert.match(compose, /max-file: "5"/);
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
assert.match(deploy, /API_A_ROLLBACK_IMAGE="diva-player-api:rollback-api-a"/);
assert.match(deploy, /GATEWAY_ROLLBACK_IMAGE="diva-player-api-gateway:rollback"/);
assert.match(deploy, /api_a\.old_image/);
assert.match(deploy, /migration\.rollback.*not-attempted-forward-only/);
assert.match(deploy, /validate_candidate_gateway/);
assert.match(deploy, /validate_candidate_api/);
assert.match(deploy, /api\.candidate/);
assert.match(deploy, /validate_candidate_web/);
assert.match(deploy, /rollback_web/);
assert.match(deploy, /container_compose_config_hash/);
assert.match(deploy, /gateway\.candidate_config_hash/);
assert.match(deploy, /rollback_updated_slots/);
assert.match(deploy, /DEPLOY_LOCK_DIR="\$STATE_ROOT\/deploy\.lock"/);
assert.match(deploy, /acquire_deploy_lock/);
assert.match(deploy, /Refusing to enable unhealthy \$slot/);
assert.match(deploy, /apply_gateway_image "\$OLD_GATEWAY_IMAGE" "\$NEW_GATEWAY_IMAGE"/);
assert.match(program, /MapHealthEndpoints\(\)/);
assert.match(healthEndpoints, /MapGet\("\/api\/ready"/);
assert.match(healthEndpoints, /DisableRateLimiting\(\)/);
assert.match(healthEndpoints, /warmupSnapshot\.Failures\.Count == 0/);
assert.match(program, /isTrustedGatewayProxy/);
assert.match(serviceRegistration, /AddHostedService<ApiWarmupService>/);
assert.match(serviceRegistration, /AddHostedService<ApiReadinessProbeService>/);
assert.match(serviceRegistration, /AddHostedService<ApiRuntimeTelemetryService>/);
assert.match(readinessProbeService, /MaximumSnapshotAge = TimeSpan\.FromSeconds\(15\)/);
assert.match(healthEndpoints, /ApiReadinessProbeService\.MaximumSnapshotAge/);
const readinessHandler = healthEndpoints.match(
  /private static IResult GetReadinessAsync\([\s\S]*?internal static ReadinessEndpointResponse/,
)?.[0];
assert.ok(readinessHandler, 'readiness snapshot handler contract was not found');
assert.doesNotMatch(readinessHandler, /CheckHealthAsync/);
assert.match(runtimeTelemetryService, /api_runtime_metrics/);
assert.match(namedTunnelRunner, /run --token-file "\$TOKEN_FILE"/);
assert.doesNotMatch(namedTunnelRunner, /(?:^|\s)--token(?:\s|$)/m);
assert.match(namedTunnelRunner, /stat -c '%u'/);
assert.match(namedTunnelRunner, /token_mode % 100/);
assert.match(namedTunnelUnit, /run-cloudflare-named-tunnel\.sh/);
assert.match(namedTunnelUnit, /UMask=0077/);
assert.match(tunnelAdmin, /verifyOriginProof/);
assert.match(tunnelAdmin, /TUNNEL_ORIGIN_PROOF_KEY/);
assert.match(quickTunnelSync, /PAGES_ORIGIN_PROOF_KEY/);
assert.match(quickTunnelSync, /hmac\.new/);
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
assert.match(
  searchResponseCache,
  /chargeBytes > _maxEntryBytes\)[\s\S]*?flight\.TryPublish\(\(\) =>\s*\{\s*_cache\.Remove\(key\)/,
);
assert.match(searchResponseCache, /stale\.RefreshRetryAfterUtcTicks/);
assert.match(searchResponseCache, /LoadAfterCacheRecheckAsync/);
assert.match(searchResponseCache, /GetOrCreateRankingAsync/);
assert.match(searchResponseCache, /trending_cache_refresh_failed/);
assert.match(searchResponseCache, /sharedTask\.WaitAsync\(cancellationToken\)/);
assert.match(searchResponseCache, /ObserveColdLoadCompletionAsync/);
assert.match(searchResponseCache, /ObserveRankingColdLoadCompletionAsync/);
assert.match(recommendationObjectCache, /SizeLimit = sizeLimitBytes/);
assert.match(recommendationObjectCache, /MinimumEntryChargeBytes = 4 \* 1024/);
assert.match(dbService, /_searchCache\.GetOrCreateAsync/);
assert.match(dbService, /_searchCache\.GetOrCreateRankingAsync/);
assert.match(
  dbService,
  /cacheLoadCancellationToken\s*=>\s*ExecuteSongSearchAsync\(request, cacheLoadCancellationToken\)/,
);
assert.match(
  dbService,
  /cacheLoadCancellationToken\s*=>\s*ExecuteTrendingSongsJsonAsync\(request, cacheLoadCancellationToken\)/,
);
assert.doesNotMatch(dbService, /\bOpen(?:Async)?\(\)/);
assert.doesNotMatch(dbService, /\bExecute(?:Reader|Scalar|NonQuery)Async\(\)/);
assert.doesNotMatch(dbService, /\bReadAsync\(\)/);
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
assert.match(workflow, /npm run test:rolling-deployment/);
assert.match(workflow, /npm run test:runtime-health/);
assert.match(workflow, /actions\/setup-python@v5/);
assert.match(workflow, /python-version: '3\.10'/);
assert.match(workflow, /npm run test:runtime-health:python/);
assert.match(workflow, /npm run test:db-role-provisioning/);
assert.match(workflow, /0018_runtime_database_roles\.sql/);
assert.match(workflow, /test-database-role-contract\.sql/);
assert.match(workflow, /Validate Cloudflare credentials/);
assert.match(workflow, /Cloudflare deployment requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID/);
assert.doesNotMatch(workflow, /Cloudflare deployment skipped/);
assert.equal(workflow.match(/npm run test:e2e:pages-nico -- https:\/\/diva-player\.pages\.dev\//g)?.length, 2);
assert.match(workflow, /if npm run test:e2e:pages-nico[\s\S]*?sleep 15[\s\S]*?npm run test:e2e:pages-nico/);
const deployJobStart = workflow.indexOf('  deploy-cloudflare:');
const deployStepsStart = workflow.indexOf('\n    steps:', deployJobStart);
assert.notEqual(deployJobStart, -1);
assert.notEqual(deployStepsStart, -1);
assert.doesNotMatch(workflow.slice(deployJobStart, deployStepsStart), /^    env:/m);
assert.match(runtimeRoleMigration, /CREATE ROLE diva_api_runtime/);
assert.match(runtimeRoleMigration, /GRANT INSERT, UPDATE ON TABLE[\s\S]*youtube_playlist_cache/);
assert.match(runtimeRoleMigration, /GRANT TRUNCATE ON TABLE public\.markov_transitions/);
assert.match(runtimeRoleMigration, /GRANT TEMPORARY ON DATABASE %I TO diva_pipeline_runtime/);
for (const route of [
  '/api/recommend',
  '/api/recommend/producer',
  '/api/recommend/similar',
  '/api/recommend/metadata',
  '/api/recommend/audio',
  '/api/recommend/multi',
  '/api/recommend/dig',
  '/api/songs/trending',
  '/api/songs/search',
]) {
  const method = route === '/api/recommend/multi' || route === '/api/recommend/dig'
    ? 'MapPost'
    : 'MapGet';
  const start = program.indexOf(`app.${method}("${route}"`);
  assert.notEqual(start, -1, `${route} endpoint was not found`);
  const nextEndpoint = program.indexOf('\napp.Map', start + route.length + 2);
  const endpoint = program.slice(start, nextEndpoint === -1 ? program.length : nextEndpoint);
  assert.match(endpoint, /CancellationToken cancellationToken/, `${route} must bind RequestAborted`);
  assert.ok(
    (endpoint.match(/\bcancellationToken\b/g) ?? []).length >= 2,
    `${route} must pass RequestAborted to its service call`,
  );
}
for (const endpointName of ['GetSongsByIdsAsync', 'GetExternalViewsAsync', 'GetViewHistoryAsync']) {
  const marker = `private static async Task<IResult> ${endpointName}`;
  const start = songReadEndpoints.indexOf(marker);
  assert.notEqual(start, -1, `${endpointName} was not found`);
  const nextEndpoint = songReadEndpoints.indexOf('\n    private static async Task<IResult>', start + marker.length);
  const endpoint = songReadEndpoints.slice(
    start,
    nextEndpoint === -1 ? songReadEndpoints.length : nextEndpoint,
  );
  assert.match(endpoint, /CancellationToken cancellationToken/);
  assert.ok((endpoint.match(/\bcancellationToken\b/g) ?? []).length >= 2);
}
const qdrantCalls = qdrantService.match(/_client\.(?:Retrieve|Search)Async\([\s\S]*?\);/g) ?? [];
assert.ok(qdrantCalls.length > 0, 'Qdrant calls were not found');
for (const call of qdrantCalls)
  assert.match(call, /cancellationToken: cancellationToken/);
assert.match(qdrantService, /catch when \(!cancellationToken\.IsCancellationRequested\)/);
assert.match(recommendService, /RecommendAsync\([\s\S]*?CancellationToken cancellationToken\)/);
assert.match(digDiscoveryService, /DiscoverAsync\([\s\S]*?CancellationToken cancellationToken/);
assert.match(markovService, /FilterAsync\([\s\S]*?CancellationToken cancellationToken\)/);
for (const playlistService of [youtubePlaylistService, nicoPlaylistService]) {
  assert.match(playlistService, /catch \(OperationCanceledException\) when \(cancellationToken\.IsCancellationRequested\)/);
  assert.match(playlistService, /!cancellationToken\.IsCancellationRequested[\s\S]*TaskCanceledException/);
}
assert.match(warmup, /cancellationToken: stoppingToken/);
assert.match(warmup, /catch \(OperationCanceledException\) when \(stoppingToken\.IsCancellationRequested\)/);
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
