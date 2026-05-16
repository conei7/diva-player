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
            .WithOrigins(
                "https://conei7.github.io",
                "http://localhost:5173",
                "http://localhost:5174",
                "http://localhost:4173")
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

// GET /api/health
app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

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

// POST /api/feedback  → 暗黙的フィードバック (再生完了率)
// Body: { songId: int, completionRate: double }
app.MapPost("/api/feedback", async (FeedbackRequest req, DbService db) =>
{
    if (req.CompletionRate is < 0.0 or > 1.0)
        return Results.BadRequest("completionRate must be 0.0-1.0");
    if (req.SongId <= 0)
        return Results.BadRequest("invalid songId");

    await db.UpdateImplicitScoreAsync(req.SongId, req.CompletionRate);
    return Results.Ok();
});

app.Run();

record FeedbackRequest(int SongId, double CompletionRate);
