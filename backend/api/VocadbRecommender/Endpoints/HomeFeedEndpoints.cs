using System.Diagnostics;
using System.Text.Json;
using VocadbRecommender.Services;

/// <summary>
/// One request for Home's personal sources. The browser used to check every
/// history and library song, then ask the recommender per seed, then check
/// the candidates again: three dependent round trips through the tunnel. Here
/// the same steps run next to PostgreSQL and Qdrant. Ranking stays in the
/// browser, which keeps the listener's ratings and history on the device.
/// The path is under /api/recommend so the publication guard and the heavy
/// bulkhead lane apply exactly as for the single-seed endpoints.
/// </summary>
internal static class HomeFeedEndpoints
{
    internal const int MaxKnownIds = 5_000;
    internal const int MaxSeedCandidates = 12;
    internal const int MaxDiscoverySeeds = 2;
    internal const int MaxWindow = 100;
    private const int EligibilityChunkSize = 500;

    public static IEndpointRouteBuilder MapHomeFeedEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/recommend/home-feed", GetHomeFeedAsync);
        return endpoints;
    }

    internal sealed record HomeFeedRequest(
        int[]? KnownIds,
        int[]? SeedCandidates,
        int? Window);

    private static async Task<IResult> GetHomeFeedAsync(
        HomeFeedRequest request,
        RecommendService recommender,
        QdrantService qdrant,
        DbService db,
        RecommendationResultCache results,
        HttpContext httpContext,
        CancellationToken cancellationToken)
    {
        httpContext.Response.Headers.CacheControl = "no-store";
        var knownIds = (request.KnownIds ?? []).Where(id => id > 0).Distinct().ToArray();
        var seedCandidates = (request.SeedCandidates ?? []).Where(id => id > 0).Distinct().ToArray();
        var window = request.Window ?? 96;
        if (knownIds.Length > MaxKnownIds)
            return Results.BadRequest(new { error = $"knownIds must contain at most {MaxKnownIds} items" });
        if (seedCandidates.Length > MaxSeedCandidates)
            return Results.BadRequest(new { error = $"seedCandidates must contain at most {MaxSeedCandidates} items" });
        if (window is < 1 or > MaxWindow)
            return Results.BadRequest(new { error = $"window must be between 1 and {MaxWindow}" });

        var timing = Stopwatch.StartNew();
        var checkIds = knownIds.Concat(seedCandidates).Distinct().ToArray();
        var eligibility = new Dictionary<int, bool>(checkIds.Length);
        foreach (var chunk in checkIds.Chunk(EligibilityChunkSize))
        {
            foreach (var (id, eligible) in await db.GetDiscoveryEligibilityBySongIdsAsync(chunk, cancellationToken))
                eligibility[id] = eligible;
        }
        ServerTiming.Append(httpContext, "eligibility", timing.Elapsed);

        // The browser orders its candidates exactly as it used to pick seeds; the
        // first eligible ones are the seeds it would have chosen after its own check.
        var seeds = seedCandidates
            .Where(id => eligibility.GetValueOrDefault(id))
            .Take(MaxDiscoverySeeds)
            .ToArray();

        timing.Restart();
        var recommendTasks = seeds
            .Select(seed => RecommendationWindow.GetAsync(recommender, db, results, seed, 0.0, cancellationToken))
            .ToArray();
        var audioTask = seeds.Length == 0
            ? Task.FromResult<(IReadOnlyList<AudioSimilarItem> Items, bool Hit)>(([], true))
            : AudioSimilarity.GetAsync(qdrant, db, results, seeds[0], cancellationToken);
        await Task.WhenAll(recommendTasks.Cast<Task>().Append(audioTask));
        var recommended = recommendTasks.Select(task => task.Result).ToArray();
        var audio = audioTask.Result;
        var hits = recommended.Count(item => item.Hit) + (audio.Hit ? 1 : 0);
        ServerTiming.Append(httpContext, "recommend", timing.Elapsed, $"{hits}/{recommended.Length + 1} cached");

        var recommendIds = recommended
            .Select(item => item.Result.Items.Take(window).Select(entry => entry.SongId).ToArray())
            .ToArray();
        var audioIds = audio.Items.Take(window).Select(item => item.songId).ToArray();

        timing.Restart();
        var cardIds = recommendIds.SelectMany(ids => ids).Concat(audioIds).Distinct().ToArray();
        var (cardJson, cardHits) = await results.GetSongCardJsonAsync(db, cardIds, cancellationToken);
        ServerTiming.Append(httpContext, "cards", timing.Elapsed, $"{cardHits}/{cardIds.Length} cached");

        return Results.Ok(new
        {
            seeds,
            // Unknown songs count as ineligible, as on /api/songs/discovery-eligibility.
            ineligibleIds = checkIds.Where(id => !eligibility.GetValueOrDefault(id)).ToArray(),
            recommendations = seeds.Select((seed, index) => new { seed, ids = recommendIds[index] }).ToArray(),
            audio = new { seed = seeds.FirstOrDefault(), ids = audioIds },
            cards = cardJson.Select(json => JsonSerializer.Deserialize<JsonElement>(json)).ToArray(),
        });
    }
}
