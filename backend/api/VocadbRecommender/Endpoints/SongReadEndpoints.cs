using System.Text.Json;
using VocadbRecommender.Services;

internal static class SongReadEndpoints
{
    public static IEndpointRouteBuilder MapSongReadEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/songs/batch", (
            string ids,
            DbService db) => GetSongsByIdsAsync(ids, db, compact: true));
        endpoints.MapGet("/api/songs/details", (
            string ids,
            DbService db) => GetSongsByIdsAsync(ids, db, compact: false));
        endpoints.MapGet("/api/songs/views", GetExternalViewsAsync);
        endpoints.MapGet("/api/songs/{id}/history", GetViewHistoryAsync);
        return endpoints;
    }

    private static async Task<IResult> GetSongsByIdsAsync(string ids, DbService db, bool compact)
    {
        if (string.IsNullOrWhiteSpace(ids))
            return Results.Ok(new { items = Array.Empty<object>() });

        var rawIds = ids.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (rawIds.Length > 100)
            return Results.BadRequest(new { error = "ids must contain at most 100 items" });

        var orderedIds = rawIds
            .Select(value => int.TryParse(value, out var id) ? id : 0)
            .Where(id => id > 0)
            .Distinct()
            .ToArray();
        if (orderedIds.Length == 0)
            return Results.Ok(new { items = Array.Empty<object>() });

        var songsById = compact
            ? await db.GetSongsCardJsonByIdsAsync(orderedIds)
            : await db.GetSongsJsonByIdsAsync(orderedIds);
        var items = orderedIds
            .Where(songsById.ContainsKey)
            .Select(id => JsonSerializer.Deserialize<JsonElement>(songsById[id]))
            .ToArray();
        return Results.Ok(new { items });
    }

    private static async Task<IResult> GetExternalViewsAsync(string ids, DbService db)
    {
        if (string.IsNullOrWhiteSpace(ids))
            return Results.Ok(new Dictionary<int, object>());

        var rawIds = ids.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (rawIds.Length > 500)
            return Results.BadRequest(new { error = "ids must contain at most 500 items" });

        var idList = rawIds
            .Where(value => int.TryParse(value, out _))
            .Select(int.Parse)
            .Distinct()
            .ToList();
        if (idList.Count == 0)
            return Results.Ok(new Dictionary<int, object>());

        var infos = await db.GetSongInfoBatchAsync(idList);
        return Results.Ok(infos.ToDictionary(info => info.Id, info => new
        {
            youtubeViews = info.YoutubeViews,
            nicoViews = info.NicoViews,
        }));
    }

    private static async Task<IResult> GetViewHistoryAsync(
        int id,
        string? range,
        string? bucket,
        DbService db)
    {
        if (!string.IsNullOrWhiteSpace(range))
        {
            var normalizedRange = range is "7d" or "30d" or "90d" or "all" ? range : "30d";
            var normalizedBucket = bucket is "day" or "week" or "month"
                ? bucket
                : normalizedRange switch
                {
                    "90d" => "week",
                    "all" => "month",
                    _ => "day",
                };
            return Results.Ok(await db.GetViewHistoryWindowAsync(id, normalizedRange, normalizedBucket));
        }

        return Results.Ok(await db.GetViewHistoryAsync(id));
    }
}
