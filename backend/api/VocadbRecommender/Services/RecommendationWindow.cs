using System.Diagnostics;
using System.Globalization;

namespace VocadbRecommender.Services;

/// <summary>Where compact card JSON is cached once the app is built.</summary>
public static class CompactSongCards
{
    public static RecommendationResultCache? Cache { get; set; }
}

/// <summary>
/// The full recommendation ranking for one seed. MMR selection is greedy, so
/// the first N items of a 500-item ranking equal a ranking computed for N:
/// every page is a slice of one cached computation.
/// </summary>
public static class RecommendationWindow
{
    public const int MaxItems = 500;

    public static async Task<(RecommendResponse Result, bool Hit)> GetAsync(
        RecommendService svc,
        DbService db,
        RecommendationResultCache results,
        int songId,
        double sessionProgress,
        CancellationToken cancellationToken)
    {
        var generation = await db.GetRecommendationPublicationGenerationAsync(cancellationToken);
        var key = string.Create(
            CultureInfo.InvariantCulture,
            $"recommend:v1:{generation}:{songId}:{sessionProgress:R}");
        return await results.GetOrCreateAsync(
            key,
            token => svc.RecommendAsync(songId, MaxItems, sessionProgress, token),
            result => result.Items.Count == 0
                ? RecommendationResultCache.EmptyResultLifetime
                : RecommendationResultCache.ResultLifetime,
            result => result.Items.Count * 256L,
            cancellationToken);
    }
}

public sealed record AudioSimilarItem(
    int songId,
    string name,
    string artist,
    double score,
    int[] producerIds,
    int[] vocalistIds,
    long youtubeViews,
    long nicoViews);

/// <summary>Audio-only neighbours of one seed, already filtered for discovery.</summary>
public static class AudioSimilarity
{
    private const int FetchCount = 200;

    public static async Task<(IReadOnlyList<AudioSimilarItem> Items, bool Hit)> GetAsync(
        QdrantService qdrant,
        DbService db,
        RecommendationResultCache results,
        int songId,
        CancellationToken cancellationToken)
    {
        var generation = await db.GetRecommendationPublicationGenerationAsync(cancellationToken);
        var key = string.Create(CultureInfo.InvariantCulture, $"recommend-audio:v1:{generation}:{songId}");
        var (items, hit) = await results.GetOrCreateAsync<AudioSimilarItem[]>(
            key,
            async token =>
            {
                var found = await qdrant.SearchAudioOnlyAsync(songId, FetchCount, token, null, 0);
                if (found.Count == 0) return [];
                var infos = await db.GetSongInfoBatchAsync(found.Select(r => r.SongId), token);
                var infoMap = infos.ToDictionary(i => i.Id);
                return found
                    .Where(r => infoMap.TryGetValue(r.SongId, out var info) && DiscoveryEligibility.IsEligible(info))
                    .Select(r =>
                    {
                        var info = infoMap[r.SongId];
                        return new AudioSimilarItem(
                            r.SongId, info.Name, info.ArtistString, r.Score,
                            info.ProducerIds, info.VocalistIds, info.YoutubeViews, info.NicoViews);
                    })
                    .ToArray();
            },
            found => found.Length == 0
                ? RecommendationResultCache.EmptyResultLifetime
                : RecommendationResultCache.ResultLifetime,
            found => found.Length * 256L,
            cancellationToken);
        return (items, hit);
    }
}

/// <summary>Adds Server-Timing entries so slow requests can be attributed from the browser.</summary>
public static class ServerTiming
{
    public static void Append(HttpContext context, string name, TimeSpan duration, string? description = null)
    {
        if (context.Response.HasStarted) return;
        var value = string.Create(
            CultureInfo.InvariantCulture,
            $"{name};dur={duration.TotalMilliseconds:0.#}");
        if (description is not null) value += $";desc=\"{description}\"";
        context.Response.Headers.Append("Server-Timing", value);
    }

    public static TimeSpan Since(long startTimestamp) => Stopwatch.GetElapsedTime(startTimestamp);
}

/// <summary>
/// Marks a response that depends only on its URL (never on the caller) as safe
/// for the Cloudflare Pages proxy to keep briefly. Browsers still revalidate.
/// </summary>
public static class EdgeCache
{
    internal const string PublicShortLived = "public, max-age=0, s-maxage=120";

    public static void MarkPublic(HttpContext context)
    {
        if (!context.Response.HasStarted)
            context.Response.Headers.CacheControl = PublicShortLived;
    }
}
