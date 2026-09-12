using VocadbRecommender.Services;

internal sealed record SoundMapPoint(
    int SongId,
    string Name,
    string ArtistString,
    double X,
    double Y,
    double? Similarity,
    string? ThumbUrl);

internal sealed record SoundMapResponse(
    string MapVersion,
    DateTimeOffset GeneratedAt,
    string Method,
    long CoordinateCount,
    string State,
    SoundMapPoint Origin,
    IReadOnlyList<SoundMapPoint> Items);

internal static class SoundMapEndpoints
{
    private const int DefaultLimit = 120;
    private const int MaxLimit = 200;
    private const int CandidateMultiplier = 5;

    public static IEndpointRouteBuilder MapSoundMapEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/discovery/sound-map", GetSoundMapAsync);
        return endpoints;
    }

    private static async Task<IResult> GetSoundMapAsync(
        int seedSongId,
        int? limit,
        string? mapVersion,
        DbService db,
        QdrantService qdrant,
        CancellationToken cancellationToken)
    {
        if (seedSongId <= 0)
            return Results.BadRequest(new { error = "seedSongId must be a positive integer" });

        var requestedLimit = limit ?? DefaultLimit;
        if (requestedLimit is < 20 or > MaxLimit)
            return Results.BadRequest(new { error = $"limit must be between 20 and {MaxLimit}" });

        var version = await db.GetSoundMapVersionAsync(mapVersion, cancellationToken);
        if (version is null)
        {
            return Results.Json(
                new { error = "sound_map_unavailable", message = "A ready sound-map version is not published." },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        var origin = (await db.GetSoundMapSongsAsync(version.MapVersion, [seedSongId], cancellationToken))
            .FirstOrDefault();
        if (origin is null)
            return Results.NotFound(new { error = "seed_not_mapped", message = "The selected song is not in the current sound map." });

        List<(int SongId, double Score)> neighbors;
        try
        {
            neighbors = await qdrant.SearchAudioOnlyAsync(
                seedSongId,
                Math.Min(MaxLimit * CandidateMultiplier, requestedLimit * CandidateMultiplier),
                cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return Results.Json(
                new { error = "sound_map_dependency_unavailable", reason = exception.GetType().Name },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        var scoreById = neighbors.ToDictionary(static item => item.SongId, static item => item.Score);
        var ids = new List<int>(requestedLimit * CandidateMultiplier + 1) { seedSongId };
        ids.AddRange(neighbors.Select(static item => item.SongId));
        var mapped = await db.GetSoundMapSongsAsync(version.MapVersion, ids.Distinct().ToArray(), cancellationToken);
        var originPoint = ToPoint(origin, null);
        var items = mapped
            .Where(song => song.SongId != seedSongId && scoreById.ContainsKey(song.SongId))
            .OrderByDescending(song => scoreById[song.SongId])
            .ThenBy(song => song.SongId)
            .Take(requestedLimit)
            .Select(song => ToPoint(song, scoreById[song.SongId]))
            .Prepend(originPoint)
            .ToArray();

        var hasAudio = neighbors.Count > 0;
        if (!hasAudio)
        {
            try
            {
                hasAudio = await qdrant.HasAudioVectorAsync(seedSongId, cancellationToken);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                return Results.Json(
                    new { error = "sound_map_dependency_unavailable", reason = exception.GetType().Name },
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        }
        var state = !hasAudio ? "no_audio" : items.Length == 1 ? "no_mapped_neighbors" : "ready";
        return Results.Ok(new SoundMapResponse(
            version.MapVersion,
            version.GeneratedAt,
            version.Method,
            version.CoordinateCount,
            state,
            originPoint,
            items));
    }

    private static SoundMapPoint ToPoint(SoundMapSong song, double? similarity) =>
        new(song.SongId, song.Name, song.ArtistString, song.X, song.Y, similarity, song.ThumbUrl);
}
