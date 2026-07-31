using VocadbRecommender.Services;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.RateLimiting;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

// --- 設定 ---
builder.Services.Configure<RecommenderOptions>(
    builder.Configuration.GetSection("Recommender"));

// --- サービス登録 ---
builder.Services.AddMemoryCache();
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(["application/json"]);
});
builder.Services.AddSingleton<DbService>();
builder.Services.AddSingleton<QdrantService>();
builder.Services.AddSingleton<MarkovService>();
builder.Services.AddScoped<RecommendService>();
builder.Services.AddHttpClient<YouTubePlaylistService>(client =>
{
    client.BaseAddress = new Uri("https://www.googleapis.com/youtube/v3/");
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("DIVA-Player/1.0");
});

var allowedOrigins = builder.Configuration
    .GetSection("Recommender:AllowedOrigins")
    .Get<string[]>()
    ?? [
        "https://diva-player.pages.dev",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://192.168.40.79:8080",
    ];

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
        var isExternalViews = path.Equals("/api/songs/views", StringComparison.OrdinalIgnoreCase);
        var isYouTubePlaylist = path.StartsWithSegments("/api/youtube/playlists");
        context.HttpContext.Response.Headers.RetryAfter = "60";
        context.HttpContext.Response.Headers["X-Diva-Rate-Limit"] = isExternalViews
            ? "views;600/min"
            : isYouTubePlaylist ? "youtube;20/min" : "default;120/min";
        var logger = context.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>()
            .CreateLogger("DivaRateLimit");
        logger.LogWarning(
            "rate_limit_rejected path={Path} scope={Scope} traceId={TraceId}",
            path.Value,
            isExternalViews ? "views" : isYouTubePlaylist ? "youtube" : "default",
            context.HttpContext.TraceIdentifier);
        return ValueTask.CompletedTask;
    };
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(httpContext =>
    {
        if (httpContext.Request.Path.Equals("/api/health", StringComparison.OrdinalIgnoreCase))
            return RateLimitPartition.GetNoLimiter("health");

        var clientKey = httpContext.Request.Headers["X-Diva-Client-Key"].ToString();
        if (string.IsNullOrWhiteSpace(clientKey))
            clientKey = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";

        var isExternalViews = httpContext.Request.Path.Equals(
            "/api/songs/views",
            StringComparison.OrdinalIgnoreCase);
        var isYouTubePlaylist = httpContext.Request.Path.StartsWithSegments("/api/youtube/playlists");
        var scope = isExternalViews ? "views" : isYouTubePlaylist ? "youtube" : "default";
        var partitionKey = $"{scope}:{clientKey}";

        return RateLimitPartition.GetFixedWindowLimiter(partitionKey, _ => new FixedWindowRateLimiterOptions
        {
            // External view counts are a cheap batch lookup and are loaded by
            // several independent UI sections. Keep them from exhausting the
            // recommendation/search budget while retaining abuse protection.
            PermitLimit = isExternalViews ? 600 : isYouTubePlaylist ? 20 : 120,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
            AutoReplenishment = true,
        });
    });
});

var app = builder.Build();
app.UseResponseCompression();
app.UseCors("AllowFrontend");
app.UseRateLimiter();

app.MapGet("/api/youtube/playlists/{playlistId}/songs", async (
    string playlistId,
    bool? refresh,
    YouTubePlaylistService service,
    CancellationToken cancellationToken) =>
{
    if (!Regex.IsMatch(playlistId, "^[A-Za-z0-9_-]{8,100}$"))
        return Results.BadRequest("invalid playlist id");
    try
    {
        var response = await service.GetAsync(playlistId, refresh == true, cancellationToken);
        return Results.Ok(new
        {
            response.PlaylistId,
            response.Title,
            response.VideoCount,
            response.MatchedCount,
            response.UnmatchedVideoIds,
            songs = response.SongsJson
                .Select(json => JsonSerializer.Deserialize<JsonElement>(json))
                .ToArray(),
            response.SourceFetchedAt,
            response.Stale,
            response.Truncated,
        });
    }
    catch (YouTubePlaylistException exception)
    {
        return Results.Problem(exception.Message, statusCode: exception.StatusCode);
    }
});

app.MapGet("/api/recommend", async (
    int songId,
    int count,
    int? offset,
    double sessionProgress,
    RecommendService svc) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");

    // offset をサポート: 十分な候補を取得して offset 分スキップ
    if (offset is < 0)
        return Results.BadRequest("offset must be non-negative");

    int take = count;
    int skip = offset ?? 0;
    const int maxRecommendationWindow = 500;
    var requestedTotal = (long)take + skip;
    if (skip >= maxRecommendationWindow)
        return Results.Ok(new RecommendResponse([], null));

    int total = (int)Math.Min(requestedTotal, maxRecommendationWindow);
    var result = await svc.RecommendAsync(songId, total, sessionProgress);

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
    DbService db) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");
    if (offset is < 0)
        return Results.BadRequest("offset must be non-negative");

    int skip = offset ?? 0;
    var songs = await db.GetSongsByProducerAsync(songId, count + skip);
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
    DbService db) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");

    int skip = offset ?? 0;

    // ハイブリッドコレクション優先、なければメタデータコレクション
    const int fetchCount = 400;
    var results = await qdrant.SearchSimilarAsync(songId, fetchCount, null, 0);
    if (results.Count == 0)
        results = await qdrant.SearchMetadataSimilarAsync(songId, fetchCount, null, 0);

    if (results.Count == 0)
        return Results.Ok(new { items = Array.Empty<object>() });

    var seed = await db.GetSongInfoAsync(songId);
    var infos = await db.GetSongInfoBatchAsync(results.Select(r => r.SongId));
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
    DbService db) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");

    int skip = offset ?? 0;
    const int vectorCandidateCount = 400;
    const int tagCandidateCount = 600;
    var vectorTask = qdrant.SearchMetadataSimilarAsync(songId, vectorCandidateCount, null, 0);
    var tagTask = db.GetMetadataRelationshipCandidateIdsAsync(songId, tagCandidateCount);
    var seedTask = db.GetSongInfoAsync(songId);
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
        100))
        candidateScores.TryAdd(candidateId, -1);

    var results = candidateScores
        .Select(candidate => (SongId: candidate.Key, Score: candidate.Value))
        .ToList();
    if (results.Count == 0)
        return Results.Ok(new { items = Array.Empty<object>() });

    var infos = await db.GetSongInfoBatchAsync(results.Select(r => r.SongId));
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
    DbService db) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");

    int skip = offset ?? 0;
    const int fetchCount = 200;
    var results = await qdrant.SearchAudioOnlyAsync(songId, fetchCount, null, 0);

    if (results.Count == 0)
        return Results.Ok(new { items = Array.Empty<object>() });

    var infos = await db.GetSongInfoBatchAsync(results.Select(r => r.SongId));
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
        })
        .ToList();

    return Results.Ok(new { items });
});

// GET /api/health
app.MapGet("/api/health", async (DbService db, QdrantService qdrant, CancellationToken cancellationToken) =>
{
    var postgresTask = db.CheckHealthAsync(cancellationToken);
    var qdrantTask = qdrant.CheckHealthAsync(cancellationToken);
    var discoveryTask = db.CheckDiscoveryQualityAsync(cancellationToken);
    var audioFeatureTask = db.CheckAudioFeatureHealthAsync(cancellationToken);
    await Task.WhenAll(postgresTask, qdrantTask, discoveryTask, audioFeatureTask);
    var postgres = await postgresTask;
    var qdrantStatus = await qdrantTask;
    var discoveryQuality = await discoveryTask;
    var audioFeatures = await audioFeatureTask;
    var ready = postgres.Ok && qdrantStatus.Ok;

    return Results.Json(
        new
        {
            status = ready ? "ok" : "degraded",
            dependencies = new { postgres, qdrant = qdrantStatus },
            discoveryQuality,
            audioFeatures,
        },
        statusCode: ready ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable);
});

app.MapPost("/api/recommend/multi", async (
    MultiRecommendRequest request,
    RecommendService svc) =>
{
    if (request.Seeds is null || request.Seeds.Count is < 1 or > 8)
        return Results.BadRequest("seeds must contain between 1 and 8 items");
    if (request.Count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");
    if (request.SessionProgress is < 0 or > 1)
        return Results.BadRequest("sessionProgress must be between 0 and 1");
    if (request.Offset is < 0 or > 10_000)
        return Results.BadRequest("offset must be between 0 and 10000");
    if (request.ExcludeSongIds?.Count > 500)
        return Results.BadRequest("excludeSongIds must contain at most 500 items");

    var seeds = request.Seeds
        .Where(seed => seed.SongId > 0 && seed.Weight > 0)
        .Select(seed => new RecommendSeed(seed.SongId, seed.Weight))
        .ToList();
    var excluded = request.ExcludeSongIds?.Where(id => id > 0).ToHashSet() ?? [];
    var result = await svc.RecommendFromSeedsAsync(seeds, request.Count, request.SessionProgress, excluded, request.Offset);
    return Results.Ok(result);
});

// GET /api/songs/views?ids=1,2,3
app.MapGet("/api/songs/views", async (string ids, DbService db) =>
{
    if (string.IsNullOrWhiteSpace(ids)) return Results.Ok(new Dictionary<int, object>());

    var idList = ids.Split(',')
        .Where(x => int.TryParse(x, out _))
        .Select(int.Parse)
        .Distinct()
        .ToList();

    if (idList.Count == 0) return Results.Ok(new Dictionary<int, object>());

    var infos = await db.GetSongInfoBatchAsync(idList);
    var result = infos.ToDictionary(i => i.Id, i => new
    {
        youtubeViews = i.YoutubeViews,
        nicoViews = i.NicoViews
    });

    return Results.Ok(result);
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
    DbService db) =>
{
    if (minYoutubeViews is < 0 || minNicoViews is < 0)
        return Results.BadRequest(new { error = "view thresholds must be non-negative" });

    var excludedTypes = ParseCsv(excludeSongTypes);
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
        excludedTypes);
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
    string? artistIds,
    string? anyArtistIds,
    string? artistIdGroups,
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
    long? minYoutubeViews,
    long? minNicoViews,
    bool? onlyWithPVs,
    string? excludeSongTypes,
    bool? voiceSynthOnly,
    bool? discoveryOnly,
    HttpContext http,
    DbService db) =>
{
    var requestStopwatch = Stopwatch.StartNew();
    const long maxPublishYear = 5_874_896;
    const long maxLengthSeconds = int.MaxValue;
    if (publishYearFrom is < 1 or > maxPublishYear || publishYearTo is < 1 or > maxPublishYear)
        return Results.BadRequest(new { error = "publish year must be between 1 and 5874896" });
    if (lengthMinSeconds is < 0 or > maxLengthSeconds || lengthMaxSeconds is < 0 or > maxLengthSeconds)
        return Results.BadRequest(new { error = "length seconds must be between 0 and 2147483647" });
    if (publishYearFrom.HasValue && publishYearTo.HasValue && publishYearFrom > publishYearTo)
        return Results.BadRequest(new { error = "publish year range is invalid" });
    if (lengthMinSeconds.HasValue && lengthMaxSeconds.HasValue && lengthMinSeconds > lengthMaxSeconds)
        return Results.BadRequest(new { error = "length range is invalid" });
    if (minYoutubeViews is < 0 || minNicoViews is < 0)
        return Results.BadRequest(new { error = "view thresholds must be non-negative" });

    if (!TryParseIntegerList(artistIds, out var aIds))
        return Results.BadRequest(new { error = "artistIds must be comma-separated integers" });
    if (!TryParseIntegerList(anyArtistIds, out var anyAIds))
        return Results.BadRequest(new { error = "anyArtistIds must be comma-separated integers" });
    if (!TryParseIntegerGroups(artistIdGroups, out var aIdGroups))
        return Results.BadRequest(new { error = "artistIdGroups must contain pipe-separated integer lists" });

    var validArtistRoles = new HashSet<string>(StringComparer.Ordinal)
    {
        "Default", "Vocalist", "Composer", "Lyricist", "Arranger", "Illustrator", "Animator",
        "Instrumentalist", "Mixer", "Mastering", "Publisher", "Distributor", "Encoder", "Chorus",
        "Other", "VoiceDataProvider", "VocalDataProvider", "VoiceManipulator",
    };
    if (!string.IsNullOrWhiteSpace(artistRole) && !validArtistRoles.Contains(artistRole))
        return Results.BadRequest(new { error = "unknown artist role" });

    var sTypes = ParseCsv(songTypes);
    var excludedTypes = ParseCsv(excludeSongTypes);
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
        minYoutubeViews,
        minNicoViews,
        onlyWithPVs ?? false,
        excludedTypes,
        voiceSynthOnly ?? false,
        discoveryOnly ?? false
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

// GET /api/songs/{id}/history
app.MapGet("/api/songs/{id}/history", async (int id, string? range, string? bucket, DbService db) =>
{
    if (!string.IsNullOrWhiteSpace(range))
    {
        var normalizedRange = range is "7d" or "30d" or "90d" or "all" ? range : "30d";
        var normalizedBucket = bucket is "day" or "week" or "month"
            ? bucket
            : normalizedRange switch
            {
                "90d" => "week",
                "all" => "month",
                _ => "day",
            };
        var windowed = await db.GetViewHistoryWindowAsync(id, normalizedRange, normalizedBucket);
        return Results.Ok(windowed);
    }

    var history = await db.GetViewHistoryAsync(id);
    return Results.Ok(history);
});

app.Run();

public record MultiRecommendRequest(
    List<MultiRecommendSeed>? Seeds,
    int Count = 60,
    double SessionProgress = 0,
    List<int>? ExcludeSongIds = null,
    int Offset = 0
);

public record MultiRecommendSeed(int SongId, double Weight);
