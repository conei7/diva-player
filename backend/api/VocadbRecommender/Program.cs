using VocadbRecommender.Services;
using Npgsql;

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

// --- DB マイグレーション: 暗黙的フィードバック用カラムを追加 ---
try
{
    var cfg = app.Services.GetRequiredService<IConfiguration>();
    var connStr = cfg.GetConnectionString("Postgres");
    if (connStr is not null)
    {
        await using var conn = new NpgsqlConnection(connStr);
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandTimeout = 30;
        cmd.CommandText = @"
            ALTER TABLE song_features ADD COLUMN IF NOT EXISTS implicit_score  REAL    DEFAULT 0;
            ALTER TABLE song_features ADD COLUMN IF NOT EXISTS implicit_count  INTEGER DEFAULT 0;";
        await cmd.ExecuteNonQueryAsync();
        app.Logger.LogInformation("DB migration: implicit feedback columns ready.");
    }
}
catch (Exception ex)
{
    app.Logger.LogWarning("DB migration skipped: {Msg}", ex.Message);
}

// --- エンドポイント ---

// GET /api/recommend?songId={id}&count={n}&offset={0}&sessionId={uuid}&sessionProgress={0.0-1.0}&ratedSongs={id1:r1,...}
app.MapGet("/api/recommend", async (
    int songId,
    int count,
    int? offset,
    string? sessionId,
    double sessionProgress,
    string? ratedSongs,
    RecommendService svc) =>
{
    if (count is < 1 or > 100)
        return Results.BadRequest("count must be between 1 and 100");

    var ratings = ParseRatedSongs(ratedSongs);
    // offset をサポート: 十分な候補を取得して offset 分スキップ
    int take   = count;
    int skip   = offset ?? 0;
    int total  = take + skip;
    var result = await svc.RecommendAsync(songId, Math.Min(total, 100), sessionId, sessionProgress, ratings);

    // offset 適用
    var pagedItems = result.Items.Skip(skip).Take(take).ToList();
    return Results.Ok(new RecommendResponse(pagedItems, result.Error));
});

static Dictionary<int, int> ParseRatedSongs(string? ratedSongs)
{
    if (string.IsNullOrEmpty(ratedSongs)) return [];
    var result = new Dictionary<int, int>();
    foreach (var part in ratedSongs.Split(','))
    {
        var idx = part.IndexOf(':');
        if (idx < 0) continue;
        if (int.TryParse(part[..idx], out var id) &&
            int.TryParse(part[(idx + 1)..], out var rating) &&
            rating is >= 1 and <= 5)
        {
            result[id] = rating;
        }
    }
    return result;
}

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

    int skip = offset ?? 0;

    var songs = await db.GetSongsByProducerAsync(songId, count + skip);
    var paged  = songs.Skip(skip).Take(count).ToList();

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
    var results = await qdrant.SearchSimilarAsync(songId, count, null, skip);
    if (results.Count == 0)
        results = await qdrant.SearchMetadataSimilarAsync(songId, count, null, skip);

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
    var results = await qdrant.SearchMetadataSimilarAsync(songId, count, null, skip);

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
app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

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

// POST /api/session  → セッションIDを発行
app.MapPost("/api/session", async (DbService db) =>
{
    var sessionId = await db.CreateSessionAsync();
    return Results.Ok(new { sessionId });
});

// POST /api/session/{sessionId}/play  → 再生記録
app.MapPost("/api/session/{sessionId}/play", async (
    string sessionId, int songId, DbService db) =>
{
    await db.RecordPlayAsync(sessionId, songId);
    return Results.Ok();
});

// POST /api/feedback  → 暗黙的フィードバック (再生完了率 / キュー削除)
// Body: { songId: int, completionRate: double, action?: string }
// action: null/"play_complete" = 再生完了率フィードバック
//         "queue_remove"      = キューから削除（強いネガティブシグナル）
app.MapPost("/api/feedback", async (FeedbackRequest req, DbService db) =>
{
    if (req.SongId <= 0)
        return Results.BadRequest("invalid songId");

    double completionRate;
    if (req.Action == "queue_remove")
    {
        // キューから削除 = 聴く前に拒否した → 強いネガティブ (-0.7 相当)
        completionRate = -0.7;
    }
    else
    {
        if (req.CompletionRate is < 0.0 or > 1.0)
            return Results.BadRequest("completionRate must be 0.0-1.0");
        completionRate = req.CompletionRate;
    }

    await db.UpdateImplicitScoreAsync(req.SongId, completionRate);
    return Results.Ok();
});

app.Run();

record FeedbackRequest(int SongId, double CompletionRate, string? Action = null);
