using System.Text.Json;
using System.Text.RegularExpressions;
using VocadbRecommender.Services;

internal static partial class PlaylistImportEndpoints
{
    [GeneratedRegex("^[A-Za-z0-9_-]{8,100}$")]
    private static partial Regex YouTubePlaylistIdPattern();

    [GeneratedRegex("^[0-9]{1,20}$")]
    private static partial Regex NicoSourceIdPattern();

    public static IEndpointRouteBuilder MapPlaylistImportEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/youtube/playlists/{playlistId}/songs", GetYouTubePlaylistAsync);
        endpoints.MapGet("/api/nico/playlists/{sourceKind}/{sourceId}/songs", GetNicoPlaylistAsync);
        return endpoints;
    }

    private static async Task<IResult> GetYouTubePlaylistAsync(
        string playlistId,
        bool? refresh,
        YouTubePlaylistService service,
        CancellationToken cancellationToken)
    {
        if (!YouTubePlaylistIdPattern().IsMatch(playlistId))
            return Results.BadRequest("invalid playlist id");
        try
        {
            var response = await service.GetAsync(playlistId, refresh == true, cancellationToken);
            return Results.Ok(new
            {
                response.PlaylistId,
                response.Title,
                response.VideoCount,
                response.MatchedCount,
                response.UnmatchedVideoIds,
                songs = response.SongsJson
                    .Select(json => JsonSerializer.Deserialize<JsonElement>(json))
                    .ToArray(),
                response.SourceFetchedAt,
                response.Stale,
                response.Truncated,
            });
        }
        catch (YouTubePlaylistException exception)
        {
            return Results.Problem(exception.Message, statusCode: exception.StatusCode);
        }
    }

    private static async Task<IResult> GetNicoPlaylistAsync(
        string sourceKind,
        string sourceId,
        bool? refresh,
        NicoPlaylistService service,
        CancellationToken cancellationToken)
    {
        sourceKind = sourceKind.ToLowerInvariant();
        if (sourceKind is not ("mylist" or "series") || !NicoSourceIdPattern().IsMatch(sourceId))
            return Results.BadRequest("invalid NicoNico playlist source");
        try
        {
            var response = await service.GetAsync(sourceKind, sourceId, refresh == true, cancellationToken);
            return Results.Ok(new
            {
                response.SourceKind,
                response.SourceId,
                response.Title,
                response.VideoCount,
                response.MatchedCount,
                response.UnmatchedVideoIds,
                songs = response.SongsJson
                    .Select(json => JsonSerializer.Deserialize<JsonElement>(json))
                    .ToArray(),
                response.SourceFetchedAt,
                response.Stale,
                response.Truncated,
            });
        }
        catch (NicoPlaylistException exception)
        {
            return Results.Problem(exception.Message, statusCode: exception.StatusCode);
        }
    }
}
