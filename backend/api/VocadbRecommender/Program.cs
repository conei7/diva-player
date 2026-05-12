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

// --- エンドポイント ---

// GET /api/recommend?songId={id}&count={n}&sessionId={uuid}&sessionProgress={0.0-1.0}
app.MapGet("/api/recommend", async (
    int songId,
    int count,
    string? sessionId,
    double sessionProgress,
    RecommendService svc) =>
{
    if (count is < 1 or > 50)
        return Results.BadRequest("count must be between 1 and 50");

    var result = await svc.RecommendAsync(songId, count, sessionId, sessionProgress);
    return Results.Ok(result);
});

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

app.Run();
