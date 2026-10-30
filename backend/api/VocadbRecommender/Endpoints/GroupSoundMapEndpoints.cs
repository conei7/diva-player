using System.Globalization;
using VocadbRecommender.Services;

internal sealed record GroupMapCoordinate(int SongId, double X, double Y, double RawX, double RawY);

internal static class GroupSoundMapEndpoints
{
    internal static async Task<IResult> GetAsync(
        string songIds, double? centerX, double? centerY, double? zoom, string? mapVersion,
        DbService db, QdrantService qdrant, GroupSoundMapIndex index,
        HttpResponse response, CancellationToken cancellationToken)
    {
        var parts = songIds.Split(',');
        if (parts.Length is < 3 or > 20 || parts.Any(p => !int.TryParse(p, NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0))
            return Results.BadRequest(new { error = "group_song_ids_invalid" });
        var ids = parts.Select(int.Parse).Distinct().ToArray();
        if (ids.Length < 3 || centerX.HasValue != centerY.HasValue ||
            (centerX.HasValue && (!double.IsFinite(centerX.Value) || !double.IsFinite(centerY!.Value) || Math.Abs(centerX.Value) > 10 || Math.Abs(centerY.Value) > 10)) ||
            (zoom.HasValue && (!double.IsFinite(zoom.Value) || zoom is < .75 or > 256)))
            return Results.BadRequest(new { error = "group_map_parameters_invalid" });
        response.Headers.CacheControl = "no-store";
        try
        {
            var version = await db.GetSoundMapVersionAsync(mapVersion, cancellationToken);
            if (version is null) return Results.Json(new { error = "sound_map_unavailable" }, statusCode: 503);
            var seeds = await qdrant.GetGroupSoundMapSeedsAsync(ids, cancellationToken);
            var mappedSeeds = await db.GetSoundMapSongsAsync(version.MapVersion, ids, cancellationToken);
            var missing = ids.Where(id => !seeds.ContainsKey(id) || !mappedSeeds.Any(s => s.SongId == id)).ToArray();
            if (missing.Length > 0)
                return Results.UnprocessableEntity(new { error = "group_songs_unavailable", songIds = missing });
            var catalogue = index.GetOrStart();
            if (catalogue is null)
            {
                response.Headers.RetryAfter = "2";
                return Results.Json(new { state = "preparing" }, statusCode: 202);
            }
            var (axisX, axisY) = GroupSoundMapIndex.SelectAxes(ids.Select(id => seeds[id]).ToArray());
            var raw = catalogue.Select(entry => new GroupMapCoordinate(entry.Key, 0, 0,
                (double)entry.Value[axisX], (double)entry.Value[axisY])).ToDictionary(p => p.SongId);
            // The group's original float32 vectors determine both axes and their displayed positions.
            foreach (var id in ids) raw[id] = new(id, 0, 0, seeds[id][axisX], seeds[id][axisY]);
            var minX = raw.Values.Min(p => p.RawX); var maxX = raw.Values.Max(p => p.RawX);
            var minY = raw.Values.Min(p => p.RawY); var maxY = raw.Values.Max(p => p.RawY);
            var span = Math.Max(Math.Max(maxX - minX, maxY - minY), 1e-9);
            // One scale for BOTH axes: independent stretching would change the chosen distances.
            var points = raw.Values.Select(p => p with
            {
                X = 2 * (p.RawX - (minX + maxX) / 2) / span,
                Y = -2 * (p.RawY - (minY + maxY) / 2) / span,
            }).ToArray();
            var group = points.Where(p => seeds.ContainsKey(p.SongId)).ToArray();
            var groupX = group.Average(p => p.X); var groupY = group.Average(p => p.Y);
            var initialZoom = Math.Clamp(2 / Math.Max(.0078125,
                Math.Max(group.Max(p => p.X) - group.Min(p => p.X), group.Max(p => p.Y) - group.Min(p => p.Y)) * 3), .75, 256);
            var x = centerX ?? groupX; var y = centerY ?? groupY; var z = zoom ?? initialZoom;
            // Square + margin also covers wide desktop/tall phone SVG viewports.
            var radius = 2.5 / z;
            var visible = points.Where(p => Math.Abs(p.X - x) <= radius && Math.Abs(p.Y - y) <= radius).ToArray();
            var sampled = Sample(visible, x, y, radius).Concat(group).DistinctBy(p => p.SongId).ToArray();
            var mapped = await db.GetSoundMapSongsAsync(version.MapVersion, sampled.Select(p => p.SongId).ToArray(), cancellationToken);
            var byId = mapped.ToDictionary(p => p.SongId);
            var items = sampled.Where(p => byId.ContainsKey(p.SongId))
                .OrderBy(p => Math.Pow(p.X - groupX, 2) + Math.Pow(p.Y - groupY, 2)).ThenBy(p => p.SongId)
                .Select(p => new SoundMapPoint(p.SongId, byId[p.SongId].Name, byId[p.SongId].ArtistString,
                    p.X, p.Y, null, byId[p.SongId].ThumbUrl, p.RawX, p.RawY)).ToArray();
            return Results.Ok(new
            {
                version.MapVersion, version.GeneratedAt, method = "group_feature_axes", state = "ready",
                coordinateCount = catalogue.Count, matchingCount = visible.Length,
                items, origin = items.First(p => p.SongId == ids[0]), groupSongIds = ids,
                axes = new SoundMapAxes(axisX, axisY, 1024, minX, maxX, minY, maxY),
                initialViewport = new { centerX = groupX, centerY = groupY, zoom = initialZoom },
            });
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            return Results.Json(new { error = "sound_map_dependency_unavailable", reason = error.GetType().Name }, statusCode: 503);
        }
    }

    // Preserve outlying dots as well as central discoveries without sending/rendering 68k SVG nodes.
    internal static IEnumerable<GroupMapCoordinate> Sample(GroupMapCoordinate[] points, double x, double y, double radius)
    {
        if (points.Length <= 876) return points;
        return points.GroupBy(p => (
                X: Math.Clamp((int)((p.X - x + radius) / (2 * radius) * 24), 0, 23),
                Y: Math.Clamp((int)((p.Y - y + radius) / (2 * radius) * 24), 0, 23)))
            .Select(bin => bin.MinBy(p => p.SongId)!)
            .Concat(points.OrderBy(p => Math.Pow(p.X - x, 2) + Math.Pow(p.Y - y, 2)).ThenBy(p => p.SongId).Take(300))
            .DistinctBy(p => p.SongId);
    }
}
