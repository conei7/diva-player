using VocadbRecommender.Services;

var builder = WebApplication.CreateBuilder(args);

// --- 設定 ---
builder.Services.Configure<RecommenderOptions>(
    builder.Configuration.GetSection("Recommender"));

// --- サービス登録 ---
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<DbService>();
builder.Services.AddSingleton<QdrantService>();
builder.Services.AddSingleton<MarkovService>();
builder.Services.AddScoped<RecommendService>();

// --- CORS: GitHub Pages + localhost ---
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowFrontend", policy =>
        policy
            .AllowAnyOrigin()
            .AllowAnyMethod()
            .AllowAnyHeader());
});

var app = builder.Build();
app.UseCors("AllowFrontend");

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
    const int fetchCount = 200;
    var results = await qdrant.SearchSimilarAsync(songId, fetchCount, null, 0);
    if (results.Count == 0)
        results = await qdrant.SearchMetadataSimilarAsync(songId, fetchCount, null, 0);

    if (results.Count == 0)
        return Results.Ok(new { items = Array.Empty<object>() });

    var seed = await db.GetSongInfoAsync(songId);
    var infos = await db.GetSongInfoBatchAsync(results.Select(r => r.SongId));
    if (seed is not null)
    {
        results = RecommendationDiversity.ApplySeedArtistCaps(
            results,
            seed,
            infos,
            maxSameProducer: 2,
            maxSameVocalist: 4,
            minimumResults: count + skip);
    }

    results = results.Skip(skip).Take(count).ToList();
    var infoMap = infos.ToDictionary(i => i.Id);

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
    const int fetchCount = 200;
    var results = await qdrant.SearchMetadataSimilarAsync(songId, fetchCount, null, 0);

    if (results.Count == 0)
        return Results.Ok(new { items = Array.Empty<object>() });

    var seed = await db.GetSongInfoAsync(songId);
    var infos = await db.GetSongInfoBatchAsync(results.Select(r => r.SongId));
    if (seed is not null)
    {
        results = RecommendationDiversity.ApplySeedArtistCaps(
            results,
            seed,
            infos,
            maxSameProducer: 2,
            maxSameVocalist: 4,
            minimumResults: count + skip);
    }

    results = results.Skip(skip).Take(count).ToList();
    var infoMap = infos.ToDictionary(i => i.Id);

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
    var results = await qdrant.SearchAudioOnlyAsync(songId, count, null, skip);

    if (results.Count == 0)
        return Results.Ok(new { items = Array.Empty<object>() });

    var infos = await db.GetSongInfoBatchAsync(results.Select(r => r.SongId));
    var infoMap = infos.ToDictionary(i => i.Id);

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
    var checks = await Task.WhenAll(
        db.CheckHealthAsync(cancellationToken),
        qdrant.CheckHealthAsync(cancellationToken));
    var postgres = checks[0];
    var qdrantStatus = checks[1];
    var ready = postgres.Ok && qdrantStatus.Ok;

    return Results.Json(
        new
        {
            status = ready ? "ok" : "degraded",
            dependencies = new { postgres, qdrant = qdrantStatus },
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
    if (request.ExcludeSongIds?.Count > 500)
        return Results.BadRequest("excludeSongIds must contain at most 500 items");

    var seeds = request.Seeds
        .Where(seed => seed.SongId > 0 && seed.Weight > 0)
        .Select(seed => new RecommendSeed(seed.SongId, seed.Weight))
        .ToList();
    var excluded = request.ExcludeSongIds?.Where(id => id > 0).ToHashSet() ?? [];
    var result = await svc.RecommendFromSeedsAsync(seeds, request.Count, request.SessionProgress, excluded);
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
    string? platform,
    DbService db) =>
{
    var itemsJson = await db.GetTrendingSongsJsonAsync(days ?? 30, start ?? 0, maxResults ?? 24, mode, platform);
    var json = $$"""
    {
      "items": {{itemsJson}},
      "totalCount": 0
    }
    """;

    return Results.Content(json, "application/json");
});

// GET /api/songs/search?query=...&artistIds=1,2&songTypes=Original&sort=YoutubeViews&order=desc&start=0&maxResults=24
app.MapGet("/api/songs/search", async (
    string? query,
    string? artistIds,
    string? songTypes,
    string sort,
    string order,
    int? start,
    int? maxResults,
    int? publishYearFrom,
    int? publishYearTo,
    int? lengthMinSeconds,
    int? lengthMaxSeconds,
    string? pvService,
    string? audioComputed,
    DbService db) =>
{
    var aIds = !string.IsNullOrWhiteSpace(artistIds) 
        ? artistIds.Split(',').Select(int.Parse).ToList() 
        : new List<int>();
        
    var sTypes = !string.IsNullOrWhiteSpace(songTypes)
        ? songTypes.Split(',').ToList()
        : new List<string>();

    var (itemsJson, totalCount) = await db.SearchSongsAsync(
        query,
        aIds,
        sTypes,
        sort,
        order ?? "desc",
        start ?? 0,
        maxResults ?? 24,
        publishYearFrom,
        publishYearTo,
        lengthMinSeconds,
        lengthMaxSeconds,
        pvService,
        audioComputed
    );

    // itemsJsonは文字列としてのJSON配列 "[{...}, {...}]" なので、
    // Content() を使ってそのまま application/json で返す
    var json = $$"""
    {
      "items": {{itemsJson}},
      "totalCount": {{totalCount}}
    }
    """;

    return Results.Content(json, "application/json");
});

// GET /api/songs/{id}/history
app.MapGet("/api/songs/{id}/history", async (int id, DbService db) =>
{
    var history = await db.GetViewHistoryAsync(id);
    return Results.Ok(history);
});

app.Run();

public record MultiRecommendRequest(
    List<MultiRecommendSeed>? Seeds,
    int Count = 60,
    double SessionProgress = 0,
    List<int>? ExcludeSongIds = null
);

public record MultiRecommendSeed(int SongId, double Weight);
