using VocadbRecommender.Services;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.RateLimiting;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

// --- 設定 ---
builder.Services.AddDivaApiServices(builder.Configuration);

// --- サービス登録 ---

var pagesProxyKey = builder.Configuration["Recommender:PagesProxyKey"]?.Trim() ?? string.Empty;

var allowedOrigins = builder.Configuration
    .GetSection("Recommender:AllowedOrigins")
    .Get<string[]>()
    ?? [
        "https://diva-player.pages.dev",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://192.168.40.79:8080",
    ];
const int healthPermitLimit = 60;

// --- CORS: 公開Web、SBC LAN、ローカル開発だけを許可 ---
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowFrontend", policy =>
        policy
            .WithOrigins(allowedOrigins)
            .WithMethods("GET", "POST", "OPTIONS")
            .WithHeaders("Accept", "Content-Type", "Cache-Control")
            .WithExposedHeaders("Server-Timing", "X-Diva-Search-Cache", "Retry-After", "X-Diva-Rate-Limit"));
});

// 推薦・検索APIは高コストなDB/Qdrant処理を含むため、クライアントIP単位で抑制する。
// Pages proxyは信頼できるCloudflareヘッダーからX-Diva-Client-Keyを付与し、
// 直接SBCへ到達した場合は接続元アドレスへフォールバックする。
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.OnRejected = (context, _) =>
    {
        var path = context.HttpContext.Request.Path;
        var isHealth = path.Equals("/api/health", StringComparison.OrdinalIgnoreCase);
        var isExternalViews = path.Equals("/api/songs/views", StringComparison.OrdinalIgnoreCase);
        var isPlaylistImport = path.StartsWithSegments("/api/youtube/playlists")
            || path.StartsWithSegments("/api/nico/playlists");
        context.HttpContext.Response.Headers.RetryAfter = "60";
        context.HttpContext.Response.Headers["X-Diva-Rate-Limit"] = isExternalViews
            ? "views;600/min"
            : isHealth ? $"health;{healthPermitLimit}/min"
            : isPlaylistImport ? "playlist;20/min" : "default;120/min";
        var logger = context.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>()
            .CreateLogger("DivaRateLimit");
        logger.LogWarning(
            "rate_limit_rejected path={Path} scope={Scope} traceId={TraceId}",
            path.Value,
            isExternalViews ? "views" : isHealth ? "health" : isPlaylistImport ? "playlist" : "default",
            context.HttpContext.TraceIdentifier);
        return ValueTask.CompletedTask;
    };
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(httpContext =>
    {
        var isHealth = httpContext.Request.Path.Equals("/api/health", StringComparison.OrdinalIgnoreCase);
        var isExternalViews = httpContext.Request.Path.Equals(
            "/api/songs/views",
            StringComparison.OrdinalIgnoreCase);
        var isPlaylistImport = httpContext.Request.Path.StartsWithSegments("/api/youtube/playlists")
            || httpContext.Request.Path.StartsWithSegments("/api/nico/playlists");
        var scope = isHealth ? "health" : isExternalViews ? "views" : isPlaylistImport ? "playlist" : "default";

        var remoteIp = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var cloudflareIp = httpContext.Request.Headers["CF-Connecting-IP"].ToString();
        var suppliedClientKey = httpContext.Request.Headers["X-Diva-Client-Key"].ToString();
        var suppliedProxyKey = httpContext.Request.Headers["X-Diva-Pages-Proxy-Key"].ToString();
        var proxyMarker = httpContext.Request.Headers["X-Diva-Pages-Proxy"].ToString();
        var suppliedGatewayKey = httpContext.Request.Headers["X-Diva-Gateway-Proxy-Key"].ToString();
        var gatewayMarker = httpContext.Request.Headers["X-Diva-Gateway-Proxy"].ToString();
        var forwardedClientIp = httpContext.Request.Headers["X-Forwarded-For"].ToString()
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .FirstOrDefault() ?? string.Empty;
        // Only a Pages Function that knows the deployment secret may select the
        // Cloudflare client identity. Without the secret, fall back to the
        // transport peer so direct callers cannot spoof arbitrary partitions.
        var validProxyKey = !string.IsNullOrEmpty(pagesProxyKey)
            && FixedTimeEquals(suppliedProxyKey, pagesProxyKey);
        var isTrustedPagesProxy = proxyMarker == "1"
            && !string.IsNullOrWhiteSpace(cloudflareIp)
            && suppliedClientKey == cloudflareIp
            && validProxyKey;
        // HAProxy owns the public/LAN API port and overwrites both this marker
        // and X-Forwarded-For. The shared secret prevents another container or
        // direct caller from selecting arbitrary rate-limit partitions.
        var isTrustedGatewayProxy = gatewayMarker == "1"
            && !string.IsNullOrWhiteSpace(forwardedClientIp)
            && !string.IsNullOrEmpty(pagesProxyKey)
            && FixedTimeEquals(suppliedGatewayKey, pagesProxyKey);
        var clientKey = isTrustedPagesProxy
            ? cloudflareIp
            : isTrustedGatewayProxy ? forwardedClientIp : remoteIp;
        var partitionKey = $"{scope}:{clientKey}";

        return RateLimitPartition.GetFixedWindowLimiter(partitionKey, _ => new FixedWindowRateLimiterOptions
        {
            // External view counts are a cheap batch lookup and are loaded by
            // several independent UI sections. Keep them from exhausting the
            // recommendation/search budget while retaining abuse protection.
            PermitLimit = isHealth ? healthPermitLimit : isExternalViews ? 600 : isPlaylistImport ? 20 : 120,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
            AutoReplenishment = true,
        });
    });
});

static bool FixedTimeEquals(string left, string right)
{
    if (left.Length != right.Length) return false;
    return CryptographicOperations.FixedTimeEquals(
        Encoding.UTF8.GetBytes(left),
        Encoding.UTF8.GetBytes(right));
}

var app = builder.Build();
app.UseResponseCompression();
app.UseCors("AllowFrontend");
app.UseRateLimiter();

const int maxSearchStart = 100_000;
const int maxSearchResults = 200;
const int maxSearchQueryLength = 200;
const int maxSearchArtistIds = 100;
const int maxSearchArtistGroups = 20;

app.MapHealthEndpoints();
app.MapSongReadEndpoints();
app.MapKnowledgeMapEndpoints();

app.MapPlaylistImportEndpoints();

app.MapGet("/api/recommend", async (
    int songId,
    int count,
    int? offset,
    double sessionProgress,
    RecommendService svc,
    CancellationToken cancellationToken) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");

    // offset をサポート: 十分な候補を取得して offset 分スキップ
    if (offset is < 0 or > 10_000)
        return Results.BadRequest("offset must be between 0 and 10000");
    if (!double.IsFinite(sessionProgress) || sessionProgress is < 0 or > 1)
        return Results.BadRequest("sessionProgress must be between 0 and 1");

    int take = count;
    int skip = offset ?? 0;
    const int maxRecommendationWindow = 500;
    var requestedTotal = (long)take + skip;
    if (skip >= maxRecommendationWindow)
        return Results.Ok(new RecommendResponse([], null));

    int total = (int)Math.Min(requestedTotal, maxRecommendationWindow);
    var result = await svc.RecommendAsync(
        songId,
        total,
        sessionProgress,
        cancellationToken);

    // offset 適用
    var pagedItems = result.Items.Skip(skip).Take(take).ToList();
    return Results.Ok(new RecommendResponse(pagedItems, result.Error));
});


// GET /api/recommend/producer?songId={id}&count={n}&offset={0}
// 同一プロデューサーの楽曲をDBから取得
app.MapGet("/api/recommend/producer", async (
    int songId,
    int count,
    int? offset,
    DbService db,
    CancellationToken cancellationToken) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");
    if (offset is < 0 or > 10_000)
        return Results.BadRequest("offset must be between 0 and 10000");

    int skip = offset ?? 0;
    var songs = await db.GetSongsByProducerAsync(
        songId,
        count + skip,
        cancellationToken);
    var paged = songs
        .Skip(skip)
        .Take(count)
        .Select(song => new
        {
            songId = song.SongId,
            name = song.Name,
            artistString = song.ArtistString,
        })
        .ToList();

    return Results.Ok(new { items = paged });
});

// GET /api/recommend/similar?songId={id}&count={n}&offset={0}
// Qdrant ハイブリッドベクトルによる純粋な音響類似検索
app.MapGet("/api/recommend/similar", async (
    int songId,
    int count,
    int? offset,
    QdrantService qdrant,
    DbService db,
    CancellationToken cancellationToken) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");
    if (offset is < 0 or > 10_000)
        return Results.BadRequest("offset must be between 0 and 10000");

    int skip = offset ?? 0;

    // ハイブリッドコレクション優先、なければメタデータコレクション
    const int fetchCount = 400;
    var results = await qdrant.SearchSimilarAsync(
        songId,
        fetchCount,
        cancellationToken,
        null,
        0);
    if (results.Count == 0)
        results = await qdrant.SearchMetadataSimilarAsync(
            songId,
            fetchCount,
            cancellationToken,
            null,
            0);

    if (results.Count == 0)
        return Results.Ok(new { items = Array.Empty<object>() });

    var seed = await db.GetSongInfoAsync(songId, cancellationToken);
    var infos = await db.GetSongInfoBatchAsync(
        results.Select(r => r.SongId),
        cancellationToken);
    var infoMap = infos.ToDictionary(i => i.Id);
    results = results
        .Where(result => infoMap.TryGetValue(result.SongId, out var info) && DiscoveryEligibility.IsEligible(info))
        .ToList();
    if (seed is not null)
    {
        results = MetadataRelationshipRanking.CorrectSingerOnlyBias(
            results,
            seed,
            infos);
        results = RecommendationQuality.ApplyEvidencePenalty(results, infos);
    }

    results = results.Skip(skip).Take(count).ToList();

    var items = results
        .Where(r => infoMap.ContainsKey(r.SongId))
        .Select(r => new
        {
            songId = r.SongId,
            name   = infoMap[r.SongId].Name,
            artist = infoMap[r.SongId].ArtistString,
            score  = r.Score,
            producerIds = infoMap[r.SongId].ProducerIds,
            vocalistIds = infoMap[r.SongId].VocalistIds,
            youtubeViews = infoMap[r.SongId].YoutubeViews,
            nicoViews = infoMap[r.SongId].NicoViews,
        })
        .ToList();

    return Results.Ok(new { items });
});

// GET /api/recommend/metadata?songId={id}&count={n}&offset={0}
// メタデータベクトルのみによる類似検索 (関連曲タブ)
app.MapGet("/api/recommend/metadata", async (
    int songId,
    int count,
    int? offset,
    QdrantService qdrant,
    DbService db,
    CancellationToken cancellationToken) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");

    if (offset is < 0 or > 10_000)
        return Results.BadRequest("offset must be between 0 and 10000");

    int skip = offset ?? 0;
    const int vectorCandidateCount = 400;
    const int tagCandidateCount = 600;
    var vectorTask = qdrant.SearchMetadataSimilarAsync(
        songId,
        vectorCandidateCount,
        cancellationToken,
        null,
        0);
    var tagTask = db.GetMetadataRelationshipCandidateIdsAsync(
        songId,
        tagCandidateCount,
        cancellationToken);
    var seedTask = db.GetSongInfoAsync(songId, cancellationToken);
    await Task.WhenAll(vectorTask, tagTask, seedTask);

    var seed = await seedTask;
    if (seed is null)
        return Results.Ok(new { items = Array.Empty<object>() });

    var candidateScores = (await vectorTask)
        .ToDictionary(candidate => candidate.SongId, candidate => candidate.Score);
    foreach (var candidateId in await tagTask)
        candidateScores.TryAdd(candidateId, -1);
    foreach (var candidateId in await db.GetSongsByProducersAsync(
        seed.ProducerIds,
        seed.Id,
        100,
        cancellationToken))
        candidateScores.TryAdd(candidateId, -1);

    var results = candidateScores
        .Select(candidate => (SongId: candidate.Key, Score: candidate.Value))
        .ToList();

    var infos = await db.GetSongInfoBatchAsync(
        results.Select(r => r.SongId),
        cancellationToken);
    if (MetadataRelationshipRanking.NeedsDiverseFallback(infos))
    {
        foreach (var candidateId in await db.GetDiverseFallbackCandidateIdsAsync(
            songId,
            100,
            cancellationToken))
            candidateScores.TryAdd(candidateId, -1);
        results = candidateScores
            .Select(candidate => (SongId: candidate.Key, Score: candidate.Value))
            .ToList();
        infos = await db.GetSongInfoBatchAsync(
            results.Select(result => result.SongId),
            cancellationToken);
    }
    if (results.Count == 0)
        return Results.Ok(new { items = Array.Empty<object>() });
    var infoMap = infos.ToDictionary(i => i.Id);
    results = results
        .Where(result => infoMap.TryGetValue(result.SongId, out var info) && DiscoveryEligibility.IsEligible(info))
        .ToList();
    results = MetadataRelationshipRanking.RerankRelated(
        results,
        seed,
        infos,
        Math.Min(results.Count, count + skip));

    results = results.Skip(skip).Take(count).ToList();

    var items = results
        .Where(r => infoMap.ContainsKey(r.SongId))
        .Select(r => new
        {
            songId = r.SongId,
            name   = infoMap[r.SongId].Name,
            artist = infoMap[r.SongId].ArtistString,
            score  = r.Score,
            producerIds = infoMap[r.SongId].ProducerIds,
            vocalistIds = infoMap[r.SongId].VocalistIds,
            youtubeViews = infoMap[r.SongId].YoutubeViews,
            nicoViews = infoMap[r.SongId].NicoViews,
        })
        .ToList();

    return Results.Ok(new { items });
});

// GET /api/recommend/audio?songId={id}&count={n}&offset={0}
// 音響ベクトルのみによる類似検索 (deep dig タブ)
app.MapGet("/api/recommend/audio", async (
    int songId,
    int count,
    int? offset,
    QdrantService qdrant,
    DbService db,
    CancellationToken cancellationToken) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");

    if (offset is < 0 or > 10_000)
        return Results.BadRequest("offset must be between 0 and 10000");

    int skip = offset ?? 0;
    const int fetchCount = 200;
    var results = await qdrant.SearchAudioOnlyAsync(
        songId,
        fetchCount,
        cancellationToken,
        null,
        0);

    if (results.Count == 0)
        return Results.Ok(new { items = Array.Empty<object>() });

    var infos = await db.GetSongInfoBatchAsync(
        results.Select(r => r.SongId),
        cancellationToken);
    var infoMap = infos.ToDictionary(i => i.Id);
    results = results
        .Where(result => infoMap.TryGetValue(result.SongId, out var info) && DiscoveryEligibility.IsEligible(info))
        .Skip(skip)
        .Take(count)
        .ToList();

    var items = results
        .Where(r => infoMap.ContainsKey(r.SongId))
        .Select(r => new
        {
            songId = r.SongId,
            name   = infoMap[r.SongId].Name,
            artist = infoMap[r.SongId].ArtistString,
            score  = r.Score,
            producerIds = infoMap[r.SongId].ProducerIds,
            vocalistIds = infoMap[r.SongId].VocalistIds,
            youtubeViews = infoMap[r.SongId].YoutubeViews,
            nicoViews = infoMap[r.SongId].NicoViews,
        })
        .ToList();

    return Results.Ok(new { items });
});

app.MapPost("/api/recommend/multi", async (
    MultiRecommendRequest request,
    RecommendService svc,
    CancellationToken cancellationToken) =>
{
    if (request.Seeds is null || request.Seeds.Count is < 1 or > 8)
        return Results.BadRequest("seeds must contain between 1 and 8 items");
    if (request.Count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");
    if (!double.IsFinite(request.SessionProgress) || request.SessionProgress is < 0 or > 1)
        return Results.BadRequest("sessionProgress must be between 0 and 1");
    if (request.Offset is < 0 or > 10_000)
        return Results.BadRequest("offset must be between 0 and 10000");
    if (request.ExcludeSongIds?.Count > 500)
        return Results.BadRequest("excludeSongIds must contain at most 500 items");

    var seeds = request.Seeds
        .Where(seed => seed.SongId > 0 && double.IsFinite(seed.Weight) && seed.Weight > 0)
        .Select(seed => new RecommendSeed(seed.SongId, seed.Weight))
        .ToList();
    var excluded = request.ExcludeSongIds?.Where(id => id > 0).ToHashSet() ?? [];
    var result = await svc.RecommendFromSeedsAsync(
        seeds,
        request.Count,
        request.SessionProgress,
        cancellationToken,
        excluded,
        request.Offset);
    return Results.Ok(result);
});

app.MapPost("/api/recommend/dig", async (
    DigRecommendRequest request,
    DigDiscoveryService dig,
    DbService db,
    CancellationToken cancellationToken) =>
{
    if (request.Seeds is { Count: > 24 })
        return Results.BadRequest("seeds must contain at most 24 items");
    if (request.FavoriteProducerIds is { Count: > 20 })
        return Results.BadRequest("favoriteProducerIds must contain at most 20 items");
    if (request.Count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");
    if (request.Offset is < 0 or > 10_000)
        return Results.BadRequest("offset must be between 0 and 10000");
    if (request.ExcludeSongIds?.Count > 500)
        return Results.BadRequest("excludeSongIds must contain at most 500 items");
    if (request.MinYoutubeViews < 0 || request.MinNicoViews < 0)
        return Results.BadRequest("view thresholds must be non-negative");
    if (request.ExcludedSongTypes?.Count > 20 || request.VocalistFilters?.Count > 50)
        return Results.BadRequest("global filters are too large");
    if (request.VocalistFilters?.Any(filter => filter.Id <= 0) == true)
        return Results.BadRequest("vocalist ids must be positive");
    if (request.VocalistMatchMode is not ("Any" or "All" or "Exact"))
        return Results.BadRequest("unknown vocalist match mode");

    var excluded = request.ExcludeSongIds?.Where(id => id > 0).ToHashSet() ?? [];
    var validSeeds = (request.Seeds ?? [])
        .Where(seed => seed.SongId > 0 && double.IsFinite(seed.Weight) && seed.Weight > 0)
        .GroupBy(seed => seed.SongId)
        .Select(group => new RecommendSeed(group.Key, Math.Min(1.0, group.Max(seed => seed.Weight))))
        .ToList();
    var validSongTypes = new HashSet<string>(StringComparer.Ordinal)
    {
        "Original", "Remaster", "Remix", "Cover", "Arrangement", "Instrumental",
        "Mashup", "MusicPV", "DramaPV", "Other", "Unspecified"
    };
    var excludedSongTypes = (request.ExcludedSongTypes ?? [])
        .Where(validSongTypes.Contains)
        .ToHashSet(StringComparer.Ordinal);
    var vocalistFilters = request.VocalistFilters ?? [];
    var vocalistGroups = request.VocalistMatchMode == "Any"
        ? (vocalistFilters.Count > 0 ? new[] { vocalistFilters.Select(filter => filter.Id).Distinct().ToArray() } : [])
        : vocalistFilters
            .GroupBy(filter => string.IsNullOrWhiteSpace(filter.VariantGroup) ? $"id:{filter.Id}" : $"group:{filter.VariantGroup}")
            .Select(group => group.Select(filter => filter.Id).Distinct().ToArray())
            .ToArray();
    var globalFilters = new DigGlobalFilterSettings(
        request.MinYoutubeViews,
        request.MinNicoViews,
        excludedSongTypes,
        vocalistGroups,
        request.VocalistMatchMode);
    // FavoriteProducerIds remains accepted for wire compatibility with older
    // clients, but Dig deliberately uses no producer/catalog candidate source.
    var discovery = await dig.DiscoverAsync(
        validSeeds,
        excluded,
        request.GenerationSeed,
        request.Count,
        request.Offset,
        cancellationToken,
        globalFilters);
    var orderedIds = discovery.SongIds;
    var songsById = await db.GetSongsJsonByIdsAsync(orderedIds, cancellationToken);
    var items = orderedIds
        .Where(songsById.ContainsKey)
        .Select(id => JsonSerializer.Deserialize<JsonElement>(songsById[id]))
        .ToArray();
    return Results.Ok(new { items, totalCount = discovery.TotalCount });
});

// GET /api/songs/trending?days=30&start=0&maxResults=24
app.MapGet("/api/songs/trending", async (
    int? days,
    int? start,
    int? maxResults,
    string? mode,
    string? ranking,
    int? seed,
    bool? debug,
    long? minYoutubeViews,
    long? minNicoViews,
    string? excludeSongTypes,
    DbService db,
    CancellationToken cancellationToken) =>
{
    if (minYoutubeViews is < 0 || minNicoViews is < 0)
        return Results.BadRequest(new { error = "view thresholds must be non-negative" });
    if (start is < 0 or > maxSearchStart)
        return Results.BadRequest(new { error = "start must be between 0 and 100000" });
    if (maxResults is < 1 or > 100)
        return Results.BadRequest(new { error = "maxResults must be between 1 and 100" });
    if (excludeSongTypes is { Length: > 16_384 })
        return Results.BadRequest(new { error = "song type filters are too long" });

    var excludedTypes = ParseCsv(excludeSongTypes);
    if (excludedTypes.Count > 20)
        return Results.BadRequest(new { error = "song type filters are too large" });
    var validSongTypes = new HashSet<string>(StringComparer.Ordinal)
    {
        "Original", "Remaster", "Remix", "Cover", "Arrangement", "Instrumental",
        "Mashup", "MusicPV", "DramaPV", "Other", "Unspecified",
    };
    if (excludedTypes.Any(type => !validSongTypes.Contains(type)))
        return Results.BadRequest(new { error = "unknown song type" });

    var itemsJson = await db.GetTrendingSongsJsonAsync(
        days ?? 30,
        start ?? 0,
        maxResults ?? 24,
        mode,
        ranking,
        seed ?? 0,
        debug ?? false,
        minYoutubeViews,
        minNicoViews,
        excludedTypes,
        cancellationToken: cancellationToken);
    var json = $$"""
    {
      "items": {{itemsJson}},
      "totalCount": 0
    }
    """;

    return Results.Content(json, "application/json");
});

// GET /api/songs/search?query=...&artistIds=1,2&anyArtistIds=3,4&artistIdGroups=5,6|7,8&songTypes=Original&sort=YoutubeViews&order=desc&start=0&maxResults=24&voiceSynthOnly=true&discoveryOnly=true
app.MapGet("/api/songs/search", async (
    string? query,
    string? lyricsQuery,
    string? artistIds,
    string? anyArtistIds,
    string? artistIdGroups,
    string? exactVocalistIds,
    string? artistRole,
    string? songTypes,
    string sort,
    string order,
    int? start,
    int? maxResults,
    long? publishYearFrom,
    long? publishYearTo,
    long? lengthMinSeconds,
    long? lengthMaxSeconds,
    string? pvService,
    string? audioComputed,
    double? bpmFrom,
    double? bpmTo,
    string? instrumentKeys,
    string? instrumentMatchMode,
    long? minYoutubeViews,
    long? minNicoViews,
    long? maxYoutubeViews,
    long? maxNicoViews,
    int? minFavoritedTimes,
    int? maxFavoritedTimes,
    string? tagIds,
    string? tagMatchMode,
    int? creditArtistId,
    string? creditArtistRole,
    int? randomSeed,
    bool? onlyWithPVs,
    string? excludeSongTypes,
    bool? voiceSynthOnly,
    bool? discoveryOnly,
    bool? selfCover,
    bool? chorusOnly,
    HttpContext http,
    DbService db,
    CancellationToken cancellationToken) =>
{
    var requestStopwatch = Stopwatch.StartNew();
    const long maxPublishYear = 5_874_896;
    const long maxLengthSeconds = int.MaxValue;
    const int maxFilterStringLength = 16_384;
    if (query is { Length: > maxSearchQueryLength })
        return Results.BadRequest(new { error = "query is too long" });
    if (lyricsQuery is { Length: > maxSearchQueryLength })
        return Results.BadRequest(new { error = "lyricsQuery is too long" });
    if (artistIds is { Length: > maxFilterStringLength }
        || anyArtistIds is { Length: > maxFilterStringLength }
        || artistIdGroups is { Length: > maxFilterStringLength }
        || exactVocalistIds is { Length: > maxFilterStringLength }
        || songTypes is { Length: > maxFilterStringLength }
        || tagIds is { Length: > maxFilterStringLength }
        || instrumentKeys is { Length: > maxFilterStringLength }
        || excludeSongTypes is { Length: > maxFilterStringLength })
        return Results.BadRequest(new { error = "search filters are too long" });
    if (start is < 0 or > maxSearchStart)
        return Results.BadRequest(new { error = "start must be between 0 and 100000" });
    if (maxResults is < 1 or > maxSearchResults)
        return Results.BadRequest(new { error = "maxResults must be between 1 and 200" });
    if (publishYearFrom is < 1 or > maxPublishYear || publishYearTo is < 1 or > maxPublishYear)
        return Results.BadRequest(new { error = "publish year must be between 1 and 5874896" });
    if (lengthMinSeconds is < 0 or > maxLengthSeconds || lengthMaxSeconds is < 0 or > maxLengthSeconds)
        return Results.BadRequest(new { error = "length seconds must be between 0 and 2147483647" });
    if (publishYearFrom.HasValue && publishYearTo.HasValue && publishYearFrom > publishYearTo)
        return Results.BadRequest(new { error = "publish year range is invalid" });
    if (lengthMinSeconds.HasValue && lengthMaxSeconds.HasValue && lengthMinSeconds > lengthMaxSeconds)
        return Results.BadRequest(new { error = "length range is invalid" });
    if (bpmFrom.HasValue && !double.IsFinite(bpmFrom.Value)
        || bpmTo.HasValue && !double.IsFinite(bpmTo.Value)
        || bpmFrom is < 20 or > 400
        || bpmTo is < 20 or > 400)
        return Results.BadRequest(new { error = "BPM must be between 20 and 400" });
    if (bpmFrom.HasValue && bpmTo.HasValue && bpmFrom > bpmTo)
        return Results.BadRequest(new { error = "BPM range is invalid" });
    if (minYoutubeViews is < 0 || minNicoViews is < 0 || maxYoutubeViews is < 0 || maxNicoViews is < 0)
        return Results.BadRequest(new { error = "view thresholds must be non-negative" });
    if (minFavoritedTimes is < 0 || maxFavoritedTimes is < 0)
        return Results.BadRequest(new { error = "favorite thresholds must be non-negative" });
    if (minYoutubeViews.HasValue && maxYoutubeViews.HasValue && minYoutubeViews > maxYoutubeViews
        || minNicoViews.HasValue && maxNicoViews.HasValue && minNicoViews > maxNicoViews
        || minFavoritedTimes.HasValue && maxFavoritedTimes.HasValue && minFavoritedTimes > maxFavoritedTimes)
        return Results.BadRequest(new { error = "numeric range is invalid" });
    if (creditArtistId is <= 0)
        return Results.BadRequest(new { error = "credit artist id must be positive" });

    if (!TryParseIntegerList(artistIds, out var aIds))
        return Results.BadRequest(new { error = "artistIds must be comma-separated integers" });
    if (!TryParseIntegerList(anyArtistIds, out var anyAIds))
        return Results.BadRequest(new { error = "anyArtistIds must be comma-separated integers" });
    if (!TryParseIntegerGroups(artistIdGroups, out var aIdGroups))
        return Results.BadRequest(new { error = "artistIdGroups must contain pipe-separated integer lists" });
    if (!TryParseIntegerList(exactVocalistIds, out var exactVIds))
        return Results.BadRequest(new { error = "exactVocalistIds must be comma-separated integers" });
    if (!TryParseIntegerList(tagIds, out var parsedTagIds))
        return Results.BadRequest(new { error = "tagIds must be comma-separated integers" });
    if (aIds.Count > maxSearchArtistIds || anyAIds.Count > maxSearchArtistIds || exactVIds.Count > maxSearchArtistIds)
        return Results.BadRequest(new { error = "artist id filters are too large" });
    if (aIdGroups.Count > maxSearchArtistGroups || aIdGroups.Any(group => group.Count > maxSearchArtistIds))
        return Results.BadRequest(new { error = "artist id groups are too large" });
    if (parsedTagIds.Count > 20 || parsedTagIds.Any(id => id <= 0))
        return Results.BadRequest(new { error = "tag filters are invalid or too large" });
    var normalizedTagMatchMode = string.Equals(tagMatchMode, "any", StringComparison.OrdinalIgnoreCase) ? "any" : "all";
    var parsedInstrumentKeys = ParseCsv(instrumentKeys);
    if (parsedInstrumentKeys.Count > 12)
        return Results.BadRequest(new { error = "too many instrument filters" });
    var validInstrumentKeys = new HashSet<string>(StringComparer.Ordinal)
    {
        "piano", "electric_piano", "organ", "harpsichord", "guitar", "acoustic_guitar",
        "electric_guitar", "bass_guitar", "steel_guitar", "ukulele", "banjo", "mandolin",
        "zither", "violin", "viola", "cello", "double_bass", "string_section", "bowed_strings",
        "harp", "flute", "clarinet", "saxophone", "oboe", "bassoon", "recorder", "trumpet",
        "trombone", "brass", "french_horn", "accordion", "harmonica", "bagpipes", "didgeridoo",
        "shofar", "theremin", "drum_kit", "drums", "snare_drum", "bass_drum", "timpani",
        "tabla", "percussion", "cymbal", "hi_hat", "tambourine", "maraca", "gong",
        "mallet_percussion", "marimba_xylophone", "glockenspiel", "vibraphone", "steelpan",
        "synthesizer", "drum_machine", "sampler", "orchestra",
    };
    if (parsedInstrumentKeys.Any(key => !validInstrumentKeys.Contains(key)))
        return Results.BadRequest(new { error = "unknown instrument key" });
    var normalizedInstrumentMatchMode = string.Equals(instrumentMatchMode, "any", StringComparison.OrdinalIgnoreCase) ? "any" : "all";

    var validArtistRoles = new HashSet<string>(StringComparer.Ordinal)
    {
        "Default", "Vocalist", "Composer", "Lyricist", "Arranger", "Illustrator", "Animator",
        "Instrumentalist", "Mixer", "Mastering", "Publisher", "Distributor", "Encoder", "Chorus",
        "Other", "VoiceDataProvider", "VocalDataProvider", "VoiceManipulator",
    };
    if (!string.IsNullOrWhiteSpace(artistRole) && !validArtistRoles.Contains(artistRole))
        return Results.BadRequest(new { error = "unknown artist role" });
    if (!string.IsNullOrWhiteSpace(creditArtistRole) && !validArtistRoles.Contains(creditArtistRole))
        return Results.BadRequest(new { error = "unknown credit artist role" });

    var sTypes = ParseCsv(songTypes);
    var excludedTypes = ParseCsv(excludeSongTypes);
    if (sTypes.Count > 20 || excludedTypes.Count > 20)
        return Results.BadRequest(new { error = "song type filters are too large" });
    var validSongTypes = new HashSet<string>(StringComparer.Ordinal)
    {
        "Original", "Remaster", "Remix", "Cover", "Arrangement", "Instrumental",
        "Mashup", "MusicPV", "DramaPV", "Other", "Unspecified",
    };
    if (sTypes.Any(type => !validSongTypes.Contains(type)) || excludedTypes.Any(type => !validSongTypes.Contains(type)))
        return Results.BadRequest(new { error = "unknown song type" });

    var execution = await db.SearchSongsAsync(
        query,
        aIds,
        anyAIds,
        aIdGroups,
        artistRole,
        sTypes,
        sort,
        order ?? "desc",
        start ?? 0,
        maxResults ?? 24,
        (int?)publishYearFrom,
        (int?)publishYearTo,
        (int?)lengthMinSeconds,
        (int?)lengthMaxSeconds,
        pvService,
        audioComputed,
        bpmFrom,
        bpmTo,
        parsedInstrumentKeys,
        normalizedInstrumentMatchMode,
        minYoutubeViews,
        minNicoViews,
        onlyWithPVs ?? false,
        excludedTypes,
        voiceSynthOnly ?? false,
        discoveryOnly ?? false,
        maxYoutubeViews,
        maxNicoViews,
        minFavoritedTimes,
        maxFavoritedTimes,
        parsedTagIds,
        normalizedTagMatchMode,
        creditArtistId,
        creditArtistRole,
        randomSeed ?? 0,
        exactVIds,
        lyricsQuery,
        selfCover ?? false,
        chorusOnly ?? false,
        cancellationToken: cancellationToken
    );
    requestStopwatch.Stop();
    static string Duration(long milliseconds) => milliseconds.ToString(CultureInfo.InvariantCulture);
    http.Response.Headers["Server-Timing"] =
        $"db-open;dur={Duration(execution.ConnectionMs)}, " +
        $"db-count;dur={Duration(execution.CountMs)}, " +
        $"db-data;dur={Duration(execution.DataMs)}, " +
        $"api-total;dur={Duration(requestStopwatch.ElapsedMilliseconds)}";
    http.Response.Headers["X-Diva-Search-Cache"] = execution.CacheHit ? "hit" : "miss";
    http.Response.Headers["Timing-Allow-Origin"] = "*";

    // itemsJsonは文字列としてのJSON配列 "[{...}, {...}]" なので、
    // Content() を使ってそのまま application/json で返す
    var json = $$"""
    {
      "items": {{execution.ItemsJson}},
      "totalCount": {{execution.TotalCount}}
    }
    """;

    return Results.Content(json, "application/json");
});

app.MapGet("/api/search/tags", async (
    string? query,
    int? maxResults,
    DbService db,
    CancellationToken cancellationToken) =>
{
    var normalized = query?.Trim() ?? string.Empty;
    if (normalized.Length is < 1 or > 100) return Results.BadRequest(new { error = "query length must be between 1 and 100" });
    var take = Math.Clamp(maxResults ?? 12, 1, 30);
    return Results.Ok(new { items = await db.SearchTagsAsync(normalized, take, cancellationToken) });
});

static List<string> ParseCsv(string? value) => string.IsNullOrWhiteSpace(value)
    ? []
    : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

static bool TryParseIntegerList(string? value, out List<int> result)
{
    result = [];
    if (string.IsNullOrWhiteSpace(value)) return true;
    foreach (var item in ParseCsv(value))
    {
        if (!int.TryParse(item, out var parsed)) return false;
        result.Add(parsed);
    }
    return true;
}

static bool TryParseIntegerGroups(string? value, out List<List<int>> result)
{
    result = [];
    if (string.IsNullOrWhiteSpace(value)) return true;
    foreach (var group in value.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
    {
        if (!TryParseIntegerList(group, out var parsed) || parsed.Count == 0) return false;
        result.Add(parsed);
    }
    return true;
}

app.Run();

public record MultiRecommendRequest(
    List<MultiRecommendSeed>? Seeds,
    int Count = 60,
    double SessionProgress = 0,
    List<int>? ExcludeSongIds = null,
    int Offset = 0
);

public record MultiRecommendSeed(int SongId, double Weight);

public record DigRecommendRequest(
    List<MultiRecommendSeed>? Seeds,
    List<int>? FavoriteProducerIds = null,
    int Count = 100,
    int Offset = 0,
    int GenerationSeed = 0,
    List<int>? ExcludeSongIds = null,
    long MinYoutubeViews = 0,
    long MinNicoViews = 0,
    List<string>? ExcludedSongTypes = null,
    List<DigVocalistFilter>? VocalistFilters = null,
    string VocalistMatchMode = "Any"
);

public record DigVocalistFilter(int Id, string? VariantGroup = null);
