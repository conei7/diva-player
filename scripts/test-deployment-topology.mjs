import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const normalizeNewlines = text => text.replaceAll('\r\n', '\n');

const [
  compose,
  gateway,
  nginx,
  deploy,
  program,
  qdrantBridgeTokenStore,
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
  apiProject,
  apiTestsProject,
  schema,
  modelGuardMigration,
  modelGuardIntegration,
  readinessProbeService,
  operationalHealthProbeService,
  runtimeTelemetryService,
  namedTunnelRunner,
  namedTunnelUnit,
  tunnelAdmin,
  quickTunnelSync,
  quickTunnelSyncHelper,
  quickTunnelUnit,
  runtimeRoleMigration,
  apiSettings,
  backendEnvExample,
  discoveryEligibleLookupMigration,
  ingressMiddleware,
  bulkheadMiddleware,
  databaseConnectionBudget,
  spaFallback,
  startDevSbc,
  bulkheadProbe,
  statefulHardening,
  backupAttester,
  qdrantDockerfile,
] = (await Promise.all([
  readFile(new URL('../backend/docker-compose.yml', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api-gateway/haproxy.cfg', import.meta.url), 'utf8'),
  readFile(new URL('../nginx.conf', import.meta.url), 'utf8'),
  readFile(new URL('./deploy-sbc-api-rolling.sh', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Program.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/QdrantBridgeProbeTokenStore.cs', import.meta.url), 'utf8'),
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
  readFile(new URL('../backend/api/VocadbRecommender/VocadbRecommender.csproj', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender.Tests/VocadbRecommender.Tests.csproj', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/schema.sql', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/migrations/0017_discovery_quality_model_guard.sql', import.meta.url), 'utf8'),
  readFile(new URL('./test-discovery-quality-model-guard.sql', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/ApiReadinessProbeService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/ApiOperationalHealthProbeService.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Services/ApiRuntimeTelemetryService.cs', import.meta.url), 'utf8'),
  readFile(new URL('./run-cloudflare-named-tunnel.sh', import.meta.url), 'utf8'),
  readFile(new URL('./diva-cloudflare-named-tunnel.service', import.meta.url), 'utf8'),
  readFile(new URL('../functions/tunnel-admin/update.js', import.meta.url), 'utf8'),
  readFile(new URL('./sync-quick-tunnel-to-cloudflare.sh', import.meta.url), 'utf8'),
  readFile(new URL('./sync-quick-tunnel-to-cloudflare.py', import.meta.url), 'utf8'),
  readFile(new URL('./diva-cloudflare-tunnel.service', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/migrations/0018_runtime_database_roles.sql', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/appsettings.json', import.meta.url), 'utf8'),
  readFile(new URL('../backend/.env.example', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/migrations/0021_discovery_eligible_song_lookup.sql', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/PublicIngressSecurityMiddleware.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Middleware/ApiBulkheadMiddleware.cs', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/Middleware/ApiDatabaseConnectionBudget.cs', import.meta.url), 'utf8'),
  readFile(new URL('../functions/[[path]].js', import.meta.url), 'utf8'),
  readFile(new URL('./start-dev-sbc.ps1', import.meta.url), 'utf8'),
  readFile(new URL('./probe-api-bulkhead.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./harden-sbc-stateful-services.sh', import.meta.url), 'utf8'),
  readFile(new URL('./attest-disaster-backup-payloads.py', import.meta.url), 'utf8'),
  readFile(new URL('../backend/qdrant/Dockerfile', import.meta.url), 'utf8'),
])).map(normalizeNewlines);
const staticHeaders = normalizeNewlines(await readFile(new URL('../public/_headers', import.meta.url), 'utf8'));
const sbcTrivyInstaller = normalizeNewlines(await readFile(
  new URL('./install-sbc-trivy.sh', import.meta.url),
  'utf8',
));
const sbcBridgePublisher = normalizeNewlines(await readFile(
  new URL('./sbc-api-bridge-publication.py', import.meta.url),
  'utf8',
));
const sbcBridgeProducer = normalizeNewlines(await readFile(
  new URL('./sbc-api-bridge-receipt.py', import.meta.url),
  'utf8',
));
const [
  webDockerfile,
  apiDockerfile,
  gatewayDockerfile,
  postgresDockerfile,
  postgresMigrateDockerfile,
  databaseDockerignore,
] = (await Promise.all([
  readFile(new URL('../Dockerfile.web', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/Dockerfile', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api-gateway/Dockerfile', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/Dockerfile.pgvector', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/Dockerfile.migrate', import.meta.url), 'utf8'),
  readFile(new URL('../backend/database/.dockerignore', import.meta.url), 'utf8'),
])).map(normalizeNewlines);
const [sdkContract, apiPackagesLock, apiTestPackagesLock] = await Promise.all([
  readFile(new URL('../global.json', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender/packages.lock.json', import.meta.url), 'utf8'),
  readFile(new URL('../backend/api/VocadbRecommender.Tests/packages.lock.json', import.meta.url), 'utf8'),
]);

assert.match(compose, /api_a:/);
assert.match(compose, /api_b:/);
assert.match(compose, /api_gateway:/);
assert.ok((compose.match(/cap_drop:\s*\n\s+- ALL/g) ?? []).length >= 5);
assert.ok((compose.match(/no-new-privileges=true/g) ?? []).length >= 6);
assert.ok((compose.match(/read_only: true/g) ?? []).length >= 5);
assert.match(compose, /web:[\s\S]*user: "101:101"[\s\S]*"8080:8080"/);
assert.match(compose, /http:\/\/127\.0\.0\.1:8080\/backend-api\/api\/ready/);
assert.match(compose, /image: "\$\{DIVA_POSTGRES_IMAGE:-diva-player-postgres:16\.15-pgvector-0\.8\.6-hardened-r1\}"/);
assert.match(compose, /postgres:[\s\S]*pull_policy: never/);
assert.doesNotMatch(compose, /pgvector\/pgvector|ccc6e83d/);
assert.match(compose, /postgres:[\s\S]*cap_drop:\s*- ALL[\s\S]*cap_add:[\s\S]*- CHOWN[\s\S]*- DAC_OVERRIDE[\s\S]*- FOWNER[\s\S]*- SETGID[\s\S]*- SETUID/);
assert.doesNotMatch(compose, /schema\.sql:\/docker-entrypoint-initdb\.d/);
assert.match(compose, /qdrant:[\s\S]*image: diva-player-qdrant:v1\.19\.0-hardened-r1[\s\S]*user: "1000:1000"[\s\S]*QDRANT__STORAGE__SNAPSHOTS_PATH: \/qdrant\/storage\/snapshots[\s\S]*QDRANT__TELEMETRY_DISABLED: "true"[\s\S]*read_only: true[\s\S]*pids_limit: 512/);
assert.match(compose, /qdrant_data:\s*\n\s+name: "\$\{DIVA_QDRANT_VOLUME:-backend_qdrant_data\}"/);
assert.match(compose, /migrate:[\s\S]*image: "\$\{DIVA_POSTGRES_MIGRATE_IMAGE:-diva-player-postgres-migrate:16\.15-hardened-r1\}"[\s\S]*pull_policy: never[\s\S]*user: "65534:65534"[\s\S]*\.\/database\/migrate\.sh:\/migrations\/migrate\.sh:ro[\s\S]*\.\/database\/migrations:\/migrations\/sql:ro[\s\S]*entrypoint: \["sh", "\/migrations\/migrate\.sh"\][\s\S]*read_only: true[\s\S]*pids_limit: 128/);
assert.doesNotMatch(compose, /postgres:16-alpine@sha256|cf78e766/);
assert.match(postgresDockerfile, /postgres:16-alpine3\.23@sha256:421b84e07a72bb8f3715f20501a1fdbe1219aad1fa4af7786a49d9a3f2480296/);
assert.match(postgresDockerfile, /PGVECTOR_COMMIT=8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c/);
assert.match(postgresDockerfile, /PGVECTOR_ARCHIVE_SHA256=d076a3098010905fd60256649327809651f6288327db6413f0938305f62ea299/);
assert.match(postgresDockerfile, /DIVA_POSTGRES_SOURCE_BUNDLE_SHA256/);
assert.match(postgresDockerfile, /COPY --chown=0:0 schema\.sql \/docker-entrypoint-initdb\.d\/01_schema\.sql/);
assert.match(postgresDockerfile, /sed -i 's\/\^postgres:x:70:70:\/postgres:x:999:999:\/' \/etc\/passwd/);
assert.match(postgresDockerfile, /runtime-contract="alpine-root-init-su-exec-uid999-v1"/);
assert.doesNotMatch(postgresDockerfile, /apk upgrade/);
assert.match(postgresMigrateDockerfile, /alpine:3\.23\.3@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659/);
assert.match(postgresMigrateDockerfile, /postgresql16-client=16\.15-r0/);
assert.match(postgresMigrateDockerfile, /USER 65534:65534/);
assert.match(postgresMigrateDockerfile, /ENTRYPOINT \["psql"\]/);
assert.doesNotMatch(postgresMigrateDockerfile, /COPY|apk upgrade/);
assert.match(postgresMigrateDockerfile, /test ! -e \/usr\/local\/bin\/gosu/);
assert.deepEqual(databaseDockerignore.trim().split('\n'), [
  '*',
  '!Dockerfile.pgvector',
  '!Dockerfile.migrate',
  '!schema.sql',
]);
assert.match(webDockerfile, /node:22\.22\.2-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f/);
assert.match(webDockerfile, /nginxinc\/nginx-unprivileged:alpine@sha256:901e944d1f4fc2bd077e8f5568b98c1f6f8cdacf6b97a87747c43134a339b9a7/);
assert.match(apiDockerfile, /aspnet:8\.0-alpine-extra@sha256:bfb8d74a4b0130c7e4abf88a4dede4f51929b91e26d76ae8ccf3f571a21db3b9/);
assert.match(apiDockerfile, /sdk:8\.0-alpine@sha256:8a80a27ddac789b4cb6d09d244f9c8d840da599c5ad22f7233c04be470e55261/);
assert.match(gatewayDockerfile, /haproxy:3\.0-alpine@sha256:34cc7d1f6142464d7d2b73e2a1eef7392556dbf304160aef543e513cfd9e5162/);
assert.doesNotMatch(webDockerfile, /apk upgrade/u);
assert.doesNotMatch(apiDockerfile, /apk (?:add|upgrade)/u);
assert.match(apiDockerfile, /test "\$\(dotnet --version\)" = "8\.0\.424"/u);
assert.match(apiDockerfile, /COPY \["VocadbRecommender\/VocadbRecommender\.csproj", "VocadbRecommender\/packages\.lock\.json"/u);
assert.match(apiDockerfile, /dotnet restore [^\n]* --locked-mode/u);
assert.doesNotMatch(gatewayDockerfile, /apk upgrade/u);
assert.match(gatewayDockerfile, /apk add --no-cache socat=1\.8\.1\.3-r0/u);
assert.doesNotMatch(gatewayDockerfile, /\bcurl\b/u);
assert.match(compose, /wget -q -T 5 -O \/dev\/null http:\/\/127\.0\.0\.1:5000\/api\/ready/u);
assert.deepEqual(JSON.parse(sdkContract), {
  sdk: { version: '8.0.424', rollForward: 'disable', allowPrerelease: false },
});
assert.equal(JSON.parse(apiPackagesLock).version, 1);
assert.equal(JSON.parse(apiTestPackagesLock).version, 1);
assert.match(apiProject, /<RestorePackagesWithLockFile>true<\/RestorePackagesWithLockFile>/u);
assert.match(apiProject, /<RestoreLockedMode>true<\/RestoreLockedMode>/u);
assert.match(apiTestsProject, /<RestorePackagesWithLockFile>true<\/RestorePackagesWithLockFile>/u);
assert.match(apiTestsProject, /<RestoreLockedMode>true<\/RestoreLockedMode>/u);
assert.doesNotMatch(compose, /\n  api:\s*\n/);
assert.match(compose, /image: "\$\{DIVA_API_IMAGE:-diva-player-api:local\}"/);
assert.match(compose, /image: "\$\{DIVA_GATEWAY_IMAGE:-diva-player-api-gateway:local\}"/);
assert.match(compose, /image: "\$\{DIVA_WEB_IMAGE:-diva-player-web:local\}"/);
assert.match(compose, /Maximum Pool Size=16/);
assert.match(compose, /Recommender__Bulkhead__AggregatePermitLimit: "\$\{DIVA_API_AGGREGATE_CONCURRENCY:-6\}"/);
assert.match(compose, /Recommender__Bulkhead__DatabaseConnectionReserve: "\$\{DIVA_API_DB_CONNECTION_RESERVE:-4\}"/);
assert.match(compose, /Recommender__Bulkhead__HeavyPermitLimit: "\$\{DIVA_API_HEAVY_CONCURRENCY:-6\}"/);
assert.match(compose, /mem_limit: "768m"/);
assert.match(compose, /pids_limit: 256/);
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
assert.match(apiProject, /PackageReference Include="Qdrant\.Client" Version="1\.19\.0"/);
assert.match(qdrantService, /GetDenseVector\(\)/);
assert.match(
  qdrantService,
  /var points = await _client\.QueryAsync\([\s\S]*?return \(points, "query"\);/,
);
assert.match(
  qdrantService,
  /catch \(RpcException exception\) when \(IsLegacyQueryApiUnavailable\(exception\)\)[\s\S]*?var points = await _client\.SearchAsync\([\s\S]*?return \(points, "legacy-search-fallback"\);/,
);
assert.match(qdrantService, /exception\.StatusCode == StatusCode\.Unimplemented/);
assert.match(qdrantService, /ProbeReadCompatibilityAsync/);
assert.match(qdrantService, /ListCollectionsAsync\(cancellationToken\)/);
assert.match(qdrantService, /ListAliasesAsync\(cancellationToken\)/);
assert.match(qdrantService, /GetCollectionInfoAsync\(collection, cancellationToken\)/);
assert.match(qdrantService, /withoutPayloadFieldCount/i);
assert.match(qdrantService, /"named-audio"[\s\S]*"named-meta"[\s\S]*"hybrid-default"[\s\S]*"metadata-default"[\s\S]*"audio-default"/);
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
assert.match(gateway, /server api_a api_a:5000 maxconn 128 check/);
assert.match(gateway, /server api_b api_b:5000 maxconn 128 check/);
assert.match(gateway, /stats socket \/tmp\/haproxy-admin\.sock/);
assert.match(gateway, /maxconn 512/);
assert.match(gateway, /timeout queue 3s/);
assert.match(gateway, /frontend api_front[\s\S]*maxconn 256/);
assert.match(gateway, /balance hdr\(X-Diva-Balance-Key\)/);
assert.match(gateway, /X-Diva-Api-Slot/);
assert.match(nginx, /proxy_pass http:\/\/api_gateway:5000\//);
assert.match(nginx, /listen 8080/);
assert.match(nginx, /location \^~ \/diva-player\/assets\//);
assert.match(nginx, /Cache-Control "public, max-age=31536000, immutable"/);
assert.match(nginx, /location = \/diva-player\/index\.html[\s\S]*Cache-Control "no-cache"/);
assert.match(staticHeaders, /\/assets\/\*[\s\S]*Cache-Control: public, max-age=31536000, immutable/);
assert.match(staticHeaders, /\/index\.html[\s\S]*Cache-Control: no-cache/);
assert.match(deploy, /disable server api_nodes\/\$slot/);
assert.match(deploy, /wait_slot_sessions "\$slot"/);
assert.match(deploy, /enable server api_nodes\/\$slot/);
assert.match(deploy, /create_managed_service_container "\$slot" "\$expected_config_hash"/);
assert.match(deploy, /docker-create-\$service-returned-invalid-container-id/);
assert.doesNotMatch(deploy, /--force-recreate "\$slot"/);
assert.match(deploy, /haproxy -c -f \/usr\/local\/etc\/haproxy\/haproxy\.cfg/);
assert.match(deploy, /API_A_ROLLBACK_IMAGE="diva-player-api:rollback-api-a"/);
assert.match(deploy, /GATEWAY_ROLLBACK_IMAGE="diva-player-api-gateway:rollback"/);
assert.match(deploy, /api_a\.old_image/);
assert.match(deploy, /migration\.rollback.*not-attempted-forward-only/);
assert.match(deploy, /validate_candidate_gateway/);
assert.match(deploy, /validate_candidate_api/);
assert.match(deploy, /api_a\.candidate/);
assert.match(deploy, /api_b\.candidate/);
assert.match(deploy, /validate_candidate_web/);
assert.match(deploy, /rollback_web/);
assert.match(deploy, /WEB_PREVIOUS_CONTAINER="diva_web_previous_\$DEPLOYMENT_ID"/);
assert.match(deploy, /API_CANDIDATE_IMAGE="diva-player-api:candidate-\$DEPLOYMENT_ID"/);
assert.match(deploy, /GATEWAY_CANDIDATE_IMAGE="diva-player-api-gateway:candidate-\$DEPLOYMENT_ID"/);
assert.match(deploy, /Candidate \$service API image changed during validation/);
assert.match(deploy, /Candidate \$service API config changed during validation/);
assert.match(deploy, /New gateway image\/config changed after readiness/);
assert.match(deploy, /query_container_id|container ls -a --no-trunc/);
assert.match(deploy, /rename "\$OLD_WEB_CONTAINER_ID" "\$WEB_CONTAINER"/);
assert.doesNotMatch(deploy, /WEB_ROLLBACK_IMAGE/);
assert.match(deploy, /container_compose_config_hash/);
assert.match(deploy, /gateway\.candidate_config_hash/);
assert.match(deploy, /rollback_updated_slots/);
assert.match(deploy, /DEPLOY_LOCK_DIR="\$STATE_ROOT\/deploy\.lock"/);
assert.match(deploy, /acquire_deploy_lock/);
assert.match(deploy, /STATEFUL_LOCK_DIR="\$STATE_ROOT\/stateful-hardening\.lock"/);
assert.match(deploy, /HEALTH_ATTEMPTS=\$\{DIVA_DEPLOY_HEALTH_ATTEMPTS:-180\}/);
assert.match(deploy, /Refusing to enable unhealthy \$slot/);
assert.match(deploy, /apply_gateway_image "\$OLD_GATEWAY_IMAGE" "\$NEW_GATEWAY_IMAGE"/);
assert.match(deploy, /--bootstrap-legacy-qdrant-bridge/u);
assert.match(deploy, /canonical API bridge receipt already exists; bootstrap is one-time/u);
const bridgeCommitStart = deploy.indexOf('The explicit bridge bootstrap is intentionally API-only.');
const normalGatewayUpdate = deploy.indexOf('record_state "deployment.status" "updating-gateway"', bridgeCommitStart);
assert.ok(bridgeCommitStart > 0 && normalGatewayUpdate > bridgeCommitStart);
const bridgeCommitBranch = deploy.slice(bridgeCommitStart, normalGatewayUpdate);
assert.match(bridgeCommitBranch, /verify_bridge_legacy_contract/u);
assert.match(bridgeCommitBranch, /commit_bridge_api_restart_policies/u);
assert.match(bridgeCommitBranch, /prepare_and_publish_bridge_receipt/u);
assert.match(bridgeCommitBranch, /API_CANDIDATE_TAG_CREATED=false/u);
assert.match(bridgeCommitBranch, /exit 0/u);
assert.doesNotMatch(bridgeCommitBranch, /apply_gateway_image|validate_candidate_web|replace_web|migrat(?:e|ion) container/iu);
assert.match(deploy, /production host\/daemon platform is not native linux\/aarch64/u);
assert.match(deploy, /DOCKER_DEFAULT_PLATFORM/u);
assert.match(sbcBridgePublisher, /os\.link\(prepared, canonical, follow_symlinks=False\)/u);
assert.match(sbcBridgePublisher, /os\.unlink\(prepared\)/u);
assert.match(sbcBridgePublisher, /info\.st_nlink not in links/u);
assert.match(sbcBridgePublisher, /links=\{1\}/u);
assert.match(sbcBridgePublisher, /prepared_info\.st_dev, prepared_info\.st_ino/u);
assert.match(sbcBridgeProducer, /old Qdrant is not version 1\.9\.4/u);
assert.match(sbcBridgeProducer, /API A\/B semantics differ/u);
assert.match(sbcBridgeProducer, /linux\|arm64/u);
assert.match(qdrantDockerfile, /qdrant\/qdrant:v1\.19\.0-unprivileged@sha256:a0e04fe623cb064502cd869cefc1dc7ce359d8edd481063b5bd351c0a0a2c91e/);
assert.match(qdrantDockerfile, /FROM scratch AS audit-tools/);
assert.match(qdrantDockerfile, /FROM scratch AS runtime/);
assert.match(qdrantDockerfile, /runtime-packages\.tsv/);
assert.match(qdrantDockerfile, /qdrant-binary\.sha256/);
assert.match(qdrantDockerfile, /qdrant-config-tree\.sha256/);
assert.match(qdrantDockerfile, /rootless-readonly-scratch-v3/);
assert.match(qdrantDockerfile, /QDRANT__STORAGE__SNAPSHOTS_PATH="\/qdrant\/storage\/snapshots"/);
assert.match(qdrantDockerfile, /QDRANT__TELEMETRY_DISABLED="true"/);
assert.match(qdrantDockerfile, /ENTRYPOINT \["\/qdrant\/qdrant"\]/);
assert.match(qdrantDockerfile, /CMD \["--config-path", "\/qdrant\/config\/production\.yaml"\]/);
assert.doesNotMatch(qdrantDockerfile, /apt-get|dpkg-inventory\.tsv/);
assert.match(qdrantDockerfile, /USER 1000:1000/);
assert.match(workflow, /docker volume create[\s\S]*diva-player-ci-qdrant-audit:current[\s\S]*--user 1000:1000[\s\S]*--read-only/);
assert.match(workflow, /\/collections\/diva_ci_smoke\/points\?wait=true/);
assert.match(workflow, /\/collections\/diva_ci_smoke\/points\/query/);
assert.match(workflow, /\/collections\/diva_ci_smoke\/snapshots\?wait=true/);
const qdrantImageSmokeStep = workflow.match(
  /      - name: Build deployable container images[\s\S]*?      - name: Install pinned Trivy scanner/u,
)?.[0] ?? '';
assert.match(
  qdrantImageSmokeStep,
  /resolve_qdrant_smoke_url\(\) \{[\s\S]*port_binding=\$\(docker port "\$qdrant_smoke_container" 6333\/tcp\)[\s\S]*\[\[ "\$port_binding" =~ \^127\\\.0\\\.0\\\.1:\(\[0-9\]\+\)\$ \]\][\s\S]*qdrant_smoke_url="http:\/\/127\.0\.0\.1:\$port"/u,
);
assert.equal(
  (qdrantImageSmokeStep.match(/^          resolve_qdrant_smoke_url$/gm) ?? []).length,
  2,
  'the dynamic Qdrant endpoint must be resolved after both container starts',
);
assert.equal(
  (qdrantImageSmokeStep.match(/docker port "\$qdrant_smoke_container" 6333\/tcp/g) ?? []).length,
  1,
  'dynamic port lookup must stay centralized in the endpoint helper',
);
const firstQdrantStart = qdrantImageSmokeStep.indexOf(
  'docker start "$qdrant_smoke_container"',
);
const firstQdrantEndpointResolution = qdrantImageSmokeStep.indexOf(
  'resolve_qdrant_smoke_url',
  firstQdrantStart,
);
const firstQdrantReadiness = qdrantImageSmokeStep.indexOf(
  '"$qdrant_smoke_url/readyz"',
  firstQdrantEndpointResolution,
);
const qdrantPersistenceStop = qdrantImageSmokeStep.indexOf(
  'docker stop --time 30 "$qdrant_smoke_container"',
  firstQdrantReadiness,
);
const secondQdrantStart = qdrantImageSmokeStep.indexOf(
  'docker start "$qdrant_smoke_container"',
  qdrantPersistenceStop,
);
const secondQdrantEndpointResolution = qdrantImageSmokeStep.indexOf(
  'resolve_qdrant_smoke_url',
  secondQdrantStart,
);
const secondQdrantReadiness = qdrantImageSmokeStep.indexOf(
  '"$qdrant_smoke_url/readyz"',
  secondQdrantEndpointResolution,
);
assert.ok(
  firstQdrantStart >= 0
    && firstQdrantEndpointResolution > firstQdrantStart
    && firstQdrantReadiness > firstQdrantEndpointResolution
    && qdrantPersistenceStop > firstQdrantReadiness
    && secondQdrantStart > qdrantPersistenceStop
    && secondQdrantEndpointResolution > secondQdrantStart
    && secondQdrantReadiness > secondQdrantEndpointResolution,
  'each Qdrant start must refresh its dynamic endpoint before readiness checks',
);
assert.match(workflow, /\.result\.points_count == 2/);
assert.match(statefulHardening, /DIVA_VERIFIED_POSTGRES_BACKUP_RUN_ID/);
assert.match(statefulHardening, /DIVA_VERIFIED_QDRANT_BACKUP_RUN_ID/);
assert.match(statefulHardening, /DIVA_VERIFIED_POSTGRES_BACKUP_STATUS_SHA256/);
assert.match(statefulHardening, /DIVA_VERIFIED_QDRANT_BACKUP_MANIFEST_SHA256/);
assert.match(statefulHardening, /DIVA_VERIFIED_BACKUP_PAYLOAD_ATTESTATION_SHA256/);
assert.match(statefulHardening, /payloadBytesRehashed/);
assert.match(statefulHardening, /diva_stateful_maintenance_login_roles/);
assert.match(statefulHardening, /ALTER ROLE %I NOLOGIN/);
assert.match(statefulHardening, /Qdrant collection is not green/);
assert.match(statefulHardening, /"pointsCount": points_count/);
assert.match(backupAttester, /os\.fstat\(descriptor\)/);
assert.match(backupAttester, /_reject_reparse_ancestors/);
assert.match(backupAttester, /payloadBytesRehashed/);
assert.match(backupAttester, /--postgres-root/);
assert.match(statefulHardening, /validate_backup_evidence postgres_disaster_backup/);
assert.match(statefulHardening, /manifest digest is not bound to status/);
assert.match(statefulHardening, /QDRANT_PREVIOUS_CONTAINER="diva_qdrant_previous_\$RUN_ID"/);
assert.match(statefulHardening, /POSTGRES_PREVIOUS_CONTAINER="diva_postgres_previous_\$RUN_ID"/);
assert.match(statefulHardening, /qdrant_fingerprint/);
assert.match(statefulHardening, /postgres_fingerprint/);
assert.match(statefulHardening, /verify_qdrant_runtime/);
assert.match(statefulHardening, /verify_postgres_runtime/);
assert.match(statefulHardening, /com\.diva\.qdrant\.dockerfile-sha256/);
assert.match(statefulHardening, /run_bounded_data_mutation/);
assert.match(statefulHardening, /QDRANT_AUDIT_TOOL_IMAGE="diva-player-qdrant-audit:candidate-\$RUN_ID"/);
assert.match(statefulHardening, /--audit-image-id "\$NEW_QDRANT_AUDIT_ID"/);
assert.match(statefulHardening, /trivy-0\.74\.0/);
assert.match(statefulHardening, /--scanners vuln/);
assert.match(statefulHardening, /--severity HIGH,CRITICAL --format json --list-all-pkgs --exit-code 1/);
assert.match(statefulHardening, /validate_trivy_scan_report/);
assert.match(statefulHardening, /wait_stateful_daemon_stable/);
assert.match(statefulHardening, /daemon\.reconciliation fail-stop-manual-intervention-required/);
assert.match(statefulHardening, /DAEMON_MUTATION_IN_FLIGHT=true/);
assert.match(statefulHardening, /backup evidence is stale/);
assert.match(statefulHardening, /merge-base --is-ancestor/);
assert.match(statefulHardening, /wait_container_mapping "\$QDRANT_CONTAINER" "\$NEW_QDRANT_CONTAINER_ID"/);
assert.match(statefulHardening, /rename "\$OLD_QDRANT_ID" "\$QDRANT_CONTAINER"/);
assert.match(statefulHardening, /rename "\$recovery_id" "\$POSTGRES_CONTAINER"/);
assert.match(statefulHardening, /QDRANT_ROLLBACK_IMAGE="diva-player-qdrant:rollback-\$RUN_ID"/u);
assert.match(statefulHardening, /verify_qdrant_rollback_assets/u);
assert.match(statefulHardening, /remove_verified_qdrant_previous_container_if_present/u);
assert.match(statefulHardening, /\[ "\$current" = "\$OLD_QDRANT_ID" \] \|\| return 1/u);
assert.match(statefulHardening, /qdrant\.rollback_retained/u);
assert.match(program, /MapHealthEndpoints\(\)/);
assert.match(program, /const string qdrantBridgeProbeTokenPath = "\/tmp\/\.diva-qdrant-bridge-probe-token"/u);
assert.match(program, /QdrantBridgeProbeTokenStore\.CleanupStaleClaim\(qdrantBridgeProbeTokenPath\)/u);
assert.match(program, /MapGet\("\/api\/internal\/qdrant-compatibility-token-status"/u);
assert.match(program, /MapDelete\("\/api\/internal\/qdrant-compatibility-token"/u);
assert.match(program, /MapGet\("\/api\/internal\/qdrant-compatibility-matrix"/u);
assert.match(program, /QdrantBridgeProbeTokenStore\.TryConsume\(qdrantBridgeProbeTokenPath, suppliedToken\)/u);
assert.doesNotMatch(program, /qdrant-compatibility-matrix[\s\S]{0,400}\.DisableRateLimiting\(\)/u);
assert.doesNotMatch(compose, /DIVA_QDRANT_BRIDGE_PROBE_TOKEN/u);
assert.match(qdrantBridgeTokenStore, /private static readonly object ConsumeGate = new\(\)/u);
assert.match(qdrantBridgeTokenStore, /File\.Move\(path, claimPath, overwrite: false\)/u);
assert.match(qdrantBridgeTokenStore, /File\.GetUnixFileMode\(path\) != UnixFileMode\.UserRead/u);
assert.match(qdrantBridgeTokenStore, /enforceUnixFileContract && !OperatingSystem\.IsLinux\(\)/u);
assert.match(qdrantBridgeTokenStore, /CleanupStaleClaim/u);
assert.match(qdrantBridgeTokenStore, /DeleteExactClaim/u);
assert.match(healthEndpoints, /MapGet\("\/api\/ready"/);
assert.match(healthEndpoints, /DisableRateLimiting\(\)/);
assert.match(healthEndpoints, /warmupSnapshot\.Failures\.Count == 0/);
assert.match(program, /isTrustedGatewayProxy/);
assert.match(program, /MaxRequestBodySize = 1 \* 1024 \* 1024/);
assert.match(program, /UseMiddleware<PublicIngressSecurityMiddleware>\(pagesProxyKey\)/);
assert.match(program, /UseMiddleware<ApiBulkheadMiddleware>\(\)/);
assert.ok(
  program.indexOf('app.UseRateLimiter();') < program.indexOf('app.UseMiddleware<ApiBulkheadMiddleware>();'),
  'client rate limiting must run before aggregate load shedding',
);
assert.match(bulkheadMiddleware, /DefaultAggregatePermitLimit = 6/);
assert.match(bulkheadMiddleware, /DefaultDatabaseConnectionReserve = 4/);
assert.match(bulkheadMiddleware, /postgres\.MaxPoolSize/);
assert.match(bulkheadMiddleware, /_aggregateExecution/);
assert.match(bulkheadMiddleware, /_databaseConnectionBudget\.EnterRequestScope\(\)/);
assert.match(databaseConnectionBudget, /ForegroundConnectionLimit/);
assert.match(databaseConnectionBudget, /RequiredConnectionReserve/);
assert.match(databaseConnectionBudget, /EnterReadinessScope/);
assert.match(databaseConnectionBudget, /EnterMaintenanceScope/);
assert.match(databaseConnectionBudget, /AcquireConnectionAsync/);
assert.match(databaseConnectionBudget, /connection\.StateChange \+= OnStateChange/);
assert.match(dbService, /_connectionBudget\.AcquireConnectionAsync\(cancellationToken\)/);
assert.match(bulkheadMiddleware, /StatusCodes\.Status503ServiceUnavailable/);
assert.match(bulkheadMiddleware, /error = "server_busy"/);
assert.match(bulkheadMiddleware, /QueueTimeoutMilliseconds/);
assert.match(bulkheadProbe, /probeBypass\('\/api\/ready', 'ready'\)/);
assert.match(bulkheadProbe, /probeBypass\('\/api\/health', 'ok'\)/);
assert.match(bulkheadProbe, /Promise\.all\(\[burst, probes\]\)/);
assert.match(ingressMiddleware, /CF-Connecting-IP/);
assert.match(ingressMiddleware, /CF-Ray/);
assert.match(ingressMiddleware, /X-Diva-Pages-Proxy-Key/);
assert.match(ingressMiddleware, /FixedTimeEquals/);
assert.match(ingressMiddleware, /StatusCodes\.Status403Forbidden/);
assert.match(serviceRegistration, /AddHostedService<ApiWarmupService>/);
assert.match(serviceRegistration, /AddSingleton<ApiMaintenanceExecutionGate>/);
assert.match(serviceRegistration, /AddHostedService<ApiReadinessProbeService>/);
assert.match(serviceRegistration, /AddSingleton<ApiOperationalHealthProbeState>/);
assert.match(serviceRegistration, /AddHostedService<ApiOperationalHealthProbeService>/);
assert.match(serviceRegistration, /AddHostedService<ApiRuntimeTelemetryService>/);
assert.match(readinessProbeService, /MaximumSnapshotAge = TimeSpan\.FromSeconds\(15\)/);
assert.match(readinessProbeService, /EnterReadinessScope\(\)/);
assert.match(operationalHealthProbeService, /EnterMaintenanceScope\(\)/);
assert.match(operationalHealthProbeService, /_maintenanceGate\.EnterAsync\(timeout\.Token\)/);
assert.match(warmup, /EnterMaintenanceScope\(\)/);
assert.match(warmup, /maintenanceGate\.EnterAsync\(cancellationToken\)/);
assert.match(healthEndpoints, /ApiReadinessProbeService\.MaximumSnapshotAge/);
const readinessHandler = healthEndpoints.match(
  /private static IResult GetReadinessAsync\([\s\S]*?internal static ReadinessEndpointResponse/,
)?.[0];
assert.ok(readinessHandler, 'readiness snapshot handler contract was not found');
assert.doesNotMatch(readinessHandler, /CheckHealthAsync/);
assert.match(operationalHealthProbeService, /ProbeInterval = TimeSpan\.FromMinutes\(5\)/);
assert.match(operationalHealthProbeService, /MaximumSnapshotAge = TimeSpan\.FromMinutes\(15\)/);
const operationalHealthHandler = healthEndpoints.match(
  /private static IResult GetHealth\([\s\S]*?internal static OperationalHealthEndpointResponse/,
)?.[0];
assert.ok(operationalHealthHandler, 'operational health snapshot handler contract was not found');
assert.doesNotMatch(operationalHealthHandler, /CheckHealthAsync|CheckDiscoveryQualityAsync|CheckAudioFeatureHealthAsync/);
assert.match(runtimeTelemetryService, /api_runtime_metrics/);
assert.match(namedTunnelRunner, /run --token-file "\$TOKEN_FILE"/);
assert.doesNotMatch(namedTunnelRunner, /(?:^|\s)--token(?:\s|$)/m);
assert.match(namedTunnelRunner, /stat -c '%u'/);
assert.match(namedTunnelRunner, /token_mode % 100/);
assert.match(namedTunnelUnit, /run-cloudflare-named-tunnel\.sh/);
assert.match(namedTunnelUnit, /UMask=0077/);
assert.match(tunnelAdmin, /verifyOriginProof/);
assert.match(tunnelAdmin, /TUNNEL_ORIGIN_PROOF_KEY/);
assert.match(tunnelAdmin, /'x-diva-pages-proxy-key': env\.PAGES_PROXY_KEY/);
assert.match(tunnelAdmin, /\/backend-api\/api\/ready/);
assert.doesNotMatch(tunnelAdmin, /\/backend-api\/api\/health/);
assert.doesNotMatch(quickTunnelSync, /PAGES_ORIGIN_PROOF_KEY|Authorization: Bearer/);
assert.match(quickTunnelSyncHelper, /PAGES_ORIGIN_PROOF_KEY/);
assert.match(quickTunnelSyncHelper, /hmac\.new/);
assert.doesNotMatch(quickTunnelSync, /origin updated: \$tunnel_url/);
assert.match(quickTunnelUnit, /SuccessExitStatus=143/);
assert.match(startDevSbc, /PagesApiBase = "https:\/\/diva-player\.pages\.dev\/backend-api"/);
assert.match(startDevSbc, /\$apiTarget = \$PagesApiBase\.TrimEnd\('\/'\)/);
assert.doesNotMatch(startDevSbc, /\$apiTarget = "\$cloudflareUrl\/backend-api"/);
assert.match(staticHeaders, /Content-Security-Policy: default-src 'self'/);
assert.match(staticHeaders, /frame-ancestors 'none'/);
assert.match(staticHeaders, /X-Frame-Options: DENY/);
assert.match(staticHeaders, /Permissions-Policy: camera=\(\)/);
assert.match(spaFallback, /content-security-policy/);
assert.match(spaFallback, /frame-ancestors 'none'/);
assert.match(warmup, /home-surge/);
assert.match(warmup, /home-weekly/);
assert.match(compose, /Recommender__SearchCacheSizeMiB: "64"/);
assert.match(compose, /start_period: 180s/);
assert.match(compose, /Recommender__SearchCacheEntrySizeMiB: "8"/);
assert.match(compose, /Recommender__ObjectCacheSizeMiB: "64"/);
assert.match(compose, /Recommender__ObjectCacheEntrySizeMiB: "16"/);
assert.match(appsettings, /"SearchCacheSizeMiB": 64/);
assert.match(appsettings, /"SearchCacheEntrySizeMiB": 8/);
assert.match(appsettings, /"ObjectCacheSizeMiB": 64/);
assert.match(appsettings, /"ObjectCacheEntrySizeMiB": 16/);
assert.match(appsettings, /"AggregatePermitLimit": 6/);
assert.match(appsettings, /"DatabaseConnectionReserve": 4/);
assert.match(backendEnvExample, /DIVA_API_AGGREGATE_CONCURRENCY=6/);
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
assert.match(rankingRequest, /"surge" => 7/);
assert.match(rankingRequest, /Order\(StringComparer\.Ordinal\)/);
assert.match(searchResponseCache, /MinimumEntryChargeBytes = 4 \* 1024/);
assert.match(searchResponseCache, /SizeLimit = sizeLimitBytes/);
assert.match(searchResponseCache, /FreshLifetime = TimeSpan\.FromMinutes\(1\)/);
assert.match(searchResponseCache, /RankingFreshLifetime = TimeSpan\.FromMinutes\(5\)/);
assert.match(searchResponseCache, /StaleLifetime = TimeSpan\.FromHours\(6\)/);
assert.match(searchResponseCache, /RankingStaleLifetime = TimeSpan\.FromDays\(30\)/);
assert.match(searchResponseCache, /RefreshFailureBackoff = TimeSpan\.FromSeconds\(30\)/);
assert.match(searchResponseCache, /AbsoluteExpirationRelativeToNow = absoluteLifetime \?\? StaleLifetime/);
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
assert.match(
  workflow,
  /  build:\n[\s\S]*?      - uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n        with:\n          fetch-depth: 2\n/u,
);
assert.match(workflow, /dotnet-version: '8\.0\.424'/u);
assert.match(workflow, /dotnet restore diva-player\.sln --locked-mode/u);
assert.match(workflow, /dotnet build backend\/api\/VocadbRecommender\/VocadbRecommender\.csproj --configuration Release --no-restore/u);
assert.match(workflow, /dotnet test backend\/api\/VocadbRecommender\.Tests\/VocadbRecommender\.Tests\.csproj --configuration Release --no-restore/u);
assert.match(workflow, /python -B scripts\/test-container-image-scan-validator\.py/u);
assert.match(workflow, /trivy_\$\{TRIVY_VERSION\}_Linux-64bit\.tar\.gz/u);
assert.match(workflow, /2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a/u);
assert.match(workflow, /d89bcc6510a267f11b773398cbf1be5520ce39f9e8b6633178c4487f05b7d791/u);
assert.match(
  workflow,
  /name: Preserve deployable image scan evidence\s+if: always\(\)\s+uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a[\s\S]*?scanner\.identity[\s\S]*?cache\/db\/metadata\.json[\s\S]*?\/report\.json[\s\S]*?\/receipt\.json[\s\S]*?retention-days: 30/u,
);
assert.doesNotMatch(
  workflow.match(/name: Preserve deployable image scan evidence[\s\S]*?retention-days: 30/u)?.[0] ?? '',
  /trivy\.db/u,
);
assert.match(sbcTrivyInstaller, /trivy_0\.74\.0_Linux-ARM64\.tar\.gz/u);
assert.match(sbcTrivyInstaller, /b94ce1976bbf3c15b514b605ee88be7c6d94a29be2302847ff01cb794d47aad5/u);
assert.match(sbcTrivyInstaller, /fed2c9ca7d27191ada34524b5eaf5216a845c6d6f3246143c3b475552ffe5358/u);
assert.match(sbcTrivyInstaller, /02:00:b7:00/u);
assert.match(statefulHardening, /Docker daemon must be linux\/arm64/u);
assert.match(statefulHardening, /\[ "\$architecture" = arm64 \]/u);
assert.match(workflow, /npm run test:rolling-deployment/);
assert.match(workflow, /npm run test:runtime-health/);
assert.match(workflow, /actions\/setup-python@[0-9a-f]{40} # v7\.0\.0/);
assert.doesNotMatch(workflow, /uses: actions\/[a-z-]+@v\d/);
assert.match(workflow, /npm audit --audit-level=high/);
assert.match(workflow, /package --vulnerable --include-transitive/);
assert.match(workflow, /python-version: '3\.10'/);
assert.match(workflow, /npm run test:runtime-health:python/);
assert.match(workflow, /npm run test:db-role-provisioning/);
assert.match(workflow, /0018_runtime_database_roles\.sql/);
assert.match(workflow, /test-database-role-contract\.sql/);
const databaseRoleContractStep = workflow.match(
  /      - name: Database schema and model guard contract[\s\S]*?      - name: Remove PostgreSQL CI runtime/u,
)?.[0] ?? '';
assert.equal(
  (databaseRoleContractStep.match(/0018_runtime_database_roles\.sql/g) ?? []).length,
  2,
  'the runtime-role migration must be reapplied twice before ACL reconciliation',
);
assert.equal(
  (databaseRoleContractStep.match(/0025_reconcile_runtime_role_migration_history_acl\.sql/g) ?? []).length,
  1,
  'the migration-history ACL reconciliation must run once after role reapplication',
);
assert.match(databaseRoleContractStep, /grep -qx '25\|25\|0'/);
const secondRuntimeRoleReapply = databaseRoleContractStep.lastIndexOf(
  '0018_runtime_database_roles.sql',
);
const runtimeRoleAclReconciliation = databaseRoleContractStep.indexOf(
  '0025_reconcile_runtime_role_migration_history_acl.sql',
);
const runtimeRoleContract = databaseRoleContractStep.indexOf(
  'test-database-role-contract.sql',
);
assert.ok(
  secondRuntimeRoleReapply >= 0
    && runtimeRoleAclReconciliation > secondRuntimeRoleReapply
    && runtimeRoleContract > runtimeRoleAclReconciliation,
  'role reapplication must converge before the database role contract runs',
);
assert.match(workflow, /Validate Cloudflare credentials/);
assert.match(workflow, /Cloudflare deployment requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID/);
assert.doesNotMatch(workflow, /Cloudflare deployment skipped/);
assert.ok((workflow.match(/npm run test:e2e:pages-nico -- https:\/\/diva-player\.pages\.dev\//g)?.length ?? 0) >= 4);
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
assert.match(warmup, /cancellationToken: cancellationToken/);
assert.match(warmup, /catch \(OperationCanceledException\) when \(cancellationToken\.IsCancellationRequested\)/);
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
assert.match(warmup, /home-weekly/);
assert.match(warmup, /home-pace/);
assert.match(warmup, /home-surge/);
assert.match(warmup, /home-recent/);
assert.match(warmup, /home-deep/);
assert.match(warmup, /PeriodicTimer\(RefreshInterval\)/);
assert.match(warmup, /forceRefresh: true/);
const rankingQueryStart = dbService.indexOf('private async Task<string> ExecuteTrendingSongsJsonAsync(');
const rankingQueryEnd = dbService.indexOf('public async Task<List<(int SongId, string Name, string ArtistString)>> GetSongsByProducerAsync(', rankingQueryStart);
assert.ok(rankingQueryStart >= 0 && rankingQueryEnd > rankingQueryStart, 'ranking query contract was not found');
const rankingQuery = dbService.slice(rankingQueryStart, rankingQueryEnd);
assert.match(rankingQuery, /history_observation_groups AS MATERIALIZED/);
assert.match(rankingQuery, /CASE WHEN h\.youtube_observed THEN h\.youtube_views END AS youtube_views/);
assert.match(rankingQuery, /CASE WHEN h\.nico_observed THEN h\.nico_views END AS nico_views/);
assert.match(rankingQuery, /history_filled AS MATERIALIZED/);
assert.match(rankingQuery, /MAX\(h\.youtube_views\) OVER \(\s*PARTITION BY h\.song_id\s*ORDER BY h\.recorded_at, h\.observation_id/);
assert.match(rankingQuery, /MAX\(h\.nico_views\) OVER \(\s*PARTITION BY h\.song_id\s*ORDER BY h\.recorded_at, h\.observation_id/);
assert.match(rankingQuery, /latest AS \([\s\S]*?FROM history_filled h/);
assert.doesNotMatch(rankingQuery, /COALESCE\(h\.(?:youtube|nico)_views, 0\) AS (?:youtube|nico)_views/);
assert.doesNotMatch(rankingQuery, /NULLIF\(h\.(?:youtube|nico)_views, 0\)/);
assert.match(dbService, /history_windows AS MATERIALIZED/);
assert.match(dbService, /weekly_candidates AS/);
assert.match(dbService, /average_daily_growth DESC/);
assert.match(dbService, /publish_date BETWEEN CURRENT_DATE - interval '7 days' AND CURRENT_DATE/);
assert.match(dbService, /RANGE BETWEEN interval '10 days' PRECEDING AND interval '7 days' PRECEDING/);
assert.match(dbService, /baseline\.previous_observed_at IS NULL\s+THEN NULL::double precision/);
assert.match(dbService, /cmd\.CommandTimeout = normalizedMode is "weekly" or "surge" \? 90 : 30/);
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
assert.match(healthEndpoints, /snapshot\.Postgres\.Ok[\s\S]*snapshot\.Qdrant\.Ok[\s\S]*snapshot\.DiscoveryQuality\.Ok/);
assert.match(dbService, /unexpected_model_version/);

console.log('PASS rolling deployment topology contract');
