using VocadbRecommender.Services;

internal sealed record KnowledgeMapRequest(int[]? KnownSongIds);

internal sealed record KnowledgeMapTile(
    int SongId,
    string Name,
    string ArtistString,
    long Views,
    string? ThumbUrl,
    bool Known);

internal sealed record PlatformKnowledgeMapResponse(
    string Platform,
    long TotalViews,
    long KnownViews,
    double CoverageRatio,
    long TotalSongCount,
    int KnownSongCount,
    long KnownRemainderViews,
    long UnknownRemainderViews,
    IReadOnlyList<KnowledgeMapTile> Tiles);

internal sealed record KnowledgeMapResponse(
    DateTimeOffset GeneratedAt,
    int HistorySongCount,
    int MatchedHistorySongCount,
    long EligibleSongCount,
    PlatformKnowledgeMapResponse Youtube,
    PlatformKnowledgeMapResponse Nico);

internal static class KnowledgeMapEndpoints
{
    private const int MaxKnownSongIds = 50_000;
    private const int KnownTileLimit = 48;

    public static IEndpointRouteBuilder MapKnowledgeMapEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/discovery/knowledge-map", GetKnowledgeMapAsync);
        return endpoints;
    }

    private static async Task<IResult> GetKnowledgeMapAsync(
        KnowledgeMapRequest? request,
        DbService db,
        CancellationToken cancellationToken)
    {
        var knownSongIds = (request?.KnownSongIds ?? [])
            .Where(static id => id > 0)
            .Distinct()
            .ToArray();
        if (knownSongIds.Length > MaxKnownSongIds)
        {
            return Results.BadRequest(new
            {
                error = $"knownSongIds must contain at most {MaxKnownSongIds} distinct positive ids",
            });
        }

        var catalog = await db.GetKnowledgeMapCatalogAsync(cancellationToken);
        var knownSongs = await db.GetKnowledgeMapSongsAsync(knownSongIds, cancellationToken);
        var knownSet = knownSongs.Select(static song => song.SongId).ToHashSet();

        return Results.Ok(new KnowledgeMapResponse(
            catalog.GeneratedAt,
            knownSongIds.Length,
            knownSongs.Count,
            catalog.EligibleSongCount,
            BuildPlatformResponse(
                "youtube",
                catalog.YoutubeViews,
                catalog.YoutubeSongCount,
                catalog.YoutubeTopSongs,
                knownSongs,
                knownSet,
                static song => song.YoutubeViews),
            BuildPlatformResponse(
                "nico",
                catalog.NicoViews,
                catalog.NicoSongCount,
                catalog.NicoTopSongs,
                knownSongs,
                knownSet,
                static song => song.NicoViews)));
    }

    private static PlatformKnowledgeMapResponse BuildPlatformResponse(
        string platform,
        long totalViews,
        long totalSongCount,
        IReadOnlyList<KnowledgeMapSong> publicTopSongs,
        IReadOnlyList<KnowledgeMapSong> knownSongs,
        IReadOnlySet<int> knownSet,
        Func<KnowledgeMapSong, long> getViews)
    {
        var knownWithViews = knownSongs
            .Where(song => getViews(song) > 0)
            .OrderByDescending(getViews)
            .ThenBy(static song => song.SongId)
            .ToArray();
        var knownViews = knownWithViews.Sum(getViews);

        var visibleSongs = publicTopSongs
            .Concat(knownWithViews.Take(KnownTileLimit))
            .DistinctBy(static song => song.SongId)
            .Where(song => getViews(song) > 0)
            .OrderByDescending(getViews)
            .ThenBy(static song => song.SongId)
            .ToArray();
        var tiles = visibleSongs
            .Select(song => new KnowledgeMapTile(
                song.SongId,
                song.Name,
                song.ArtistString,
                getViews(song),
                song.ThumbUrl,
                knownSet.Contains(song.SongId)))
            .ToArray();

        var visibleKnownViews = tiles.Where(static tile => tile.Known).Sum(static tile => tile.Views);
        var visibleUnknownViews = tiles.Where(static tile => !tile.Known).Sum(static tile => tile.Views);
        var unknownViews = Math.Max(0, totalViews - knownViews);

        return new PlatformKnowledgeMapResponse(
            platform,
            totalViews,
            knownViews,
            totalViews > 0 ? (double)knownViews / totalViews : 0,
            totalSongCount,
            knownWithViews.Length,
            Math.Max(0, knownViews - visibleKnownViews),
            Math.Max(0, unknownViews - visibleUnknownViews),
            tiles);
    }
}
