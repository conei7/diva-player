using VocadbRecommender.Services;

internal sealed record SoundMapPoint(
    int SongId,
    string Name,
    string ArtistString,
    double X,
    double Y,
    double? Similarity,
    string? ThumbUrl,
    double? FeatureX = null,
    double? FeatureY = null);

internal sealed record SoundMapAxes(int X, int Y, int DimensionCount, double MinX, double MaxX, double MinY, double MaxY);

internal sealed record SoundMapResponse(
    string MapVersion,
    DateTimeOffset GeneratedAt,
    string Method,
    long CoordinateCount,
    string State,
    SoundMapPoint Origin,
    IReadOnlyList<SoundMapPoint> Items,
    SoundMapAxes? Axes = null);

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
        int? axisX,
        int? axisY,
        DbService db,
        QdrantService qdrant,
        CancellationToken cancellationToken)
    {
        if (seedSongId <= 0)
            return Results.BadRequest(new { error = "seedSongId must be a positive integer" });

        var requestedLimit = limit ?? DefaultLimit;
        if (requestedLimit is < 20 or > MaxLimit)
            return Results.BadRequest(new { error = $"limit must be between 20 and {MaxLimit}" });
        if (axisX.HasValue != axisY.HasValue || axisX is < 0 or >= 1024 || axisY is < 0 or >= 1024 ||
            (axisX.HasValue && axisX == axisY))
            return Results.BadRequest(new { error = "axisX and axisY must be distinct integers between 0 and 1023" });

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
        SoundMapAxes? axes = null;
        if (axisX.HasValue && axisY.HasValue)
        {
            try
            {
                var values = await qdrant.GetAudioFeatureAxesAsync(
                    items.Select(point => point.SongId).ToArray(), axisX.Value, axisY.Value, cancellationToken);
                if (!values.ContainsKey(seedSongId))
                    return Results.NotFound(new { error = "sound_map_features_unavailable", message = "The selected song has no usable 1024-dimensional audio features." });
                (items, axes) = ProjectFeatureAxes(items, values, axisX.Value, axisY.Value);
                originPoint = items.First(point => point.SongId == seedSongId);
                state = items.Length > 1 ? "ready" : "no_mapped_neighbors";
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                return Results.Json(new { error = "sound_map_dependency_unavailable", reason = exception.GetType().Name }, statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        }
        return Results.Ok(new SoundMapResponse(
            version.MapVersion,
            version.GeneratedAt,
            axes is null ? version.Method : "feature_axes",
            version.CoordinateCount,
            state,
            originPoint,
            items,
            axes));
    }

    internal static (SoundMapPoint[] Points, SoundMapAxes Axes) ProjectFeatureAxes(
        IReadOnlyList<SoundMapPoint> points, IReadOnlyDictionary<int, (double X, double Y)> values, int axisX, int axisY)
    {
        var available = points.Where(point => values.TryGetValue(point.SongId, out var pair) &&
            double.IsFinite(pair.X) && double.IsFinite(pair.Y)).ToArray();
        if (available.Length == 0) throw new InvalidOperationException("No usable feature axes");
        var minX = available.Min(point => values[point.SongId].X);
        var maxX = available.Max(point => values[point.SongId].X);
        var minY = available.Min(point => values[point.SongId].Y);
        var maxY = available.Max(point => values[point.SongId].Y);
        static double Scale(double value, double min, double max) => max > min ? 2 * (value - min) / (max - min) - 1 : 0;
        return (available.Select(point => point with
        {
            X = Scale(values[point.SongId].X, minX, maxX),
            Y = -Scale(values[point.SongId].Y, minY, maxY),
            FeatureX = values[point.SongId].X, FeatureY = values[point.SongId].Y,
        }).ToArray(), new SoundMapAxes(axisX, axisY, 1024, minX, maxX, minY, maxY));
    }

    private static SoundMapPoint ToPoint(SoundMapSong song, double? similarity) =>
        new(song.SongId, song.Name, song.ArtistString, song.X, song.Y, similarity, song.ThumbUrl);
}
