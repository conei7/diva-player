using System.Text.Json;

namespace VocadbRecommender.Services;

public sealed record YouTubePlaylistCache(
    string PlaylistId,
    string Title,
    string[] VideoIds,
    string? Etag,
    DateTimeOffset FetchedAt)
{
    public bool Truncated { get; init; }
}

public sealed record YouTubePlaylistResponse(
    string PlaylistId,
    string Title,
    int VideoCount,
    int MatchedCount,
    string[] UnmatchedVideoIds,
    string[] SongsJson,
    DateTimeOffset SourceFetchedAt,
    bool Stale,
    bool Truncated);

public sealed class YouTubePlaylistException(string message, int statusCode = StatusCodes.Status502BadGateway)
    : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

public sealed class YouTubePlaylistService
{
    private const int MaxPages = 50;
    private static readonly TimeSpan MinimumForcedRefreshAge = TimeSpan.FromMinutes(5);
    private readonly HttpClient _http;
    private readonly DbService _db;
    private readonly string _apiKey;
    private readonly TimeSpan _cacheTtl;

    public YouTubePlaylistService(HttpClient http, DbService db, IConfiguration configuration)
    {
        _http = http;
        _db = db;
        _apiKey = configuration["Recommender:YouTubeApiKey"]?.Trim() ?? string.Empty;
        _cacheTtl = TimeSpan.FromHours(
            double.TryParse(configuration["Recommender:YouTubePlaylistCacheHours"], out var hours)
                ? Math.Clamp(hours, 1, 168)
                : 6);
    }

    public async Task<YouTubePlaylistResponse> GetAsync(
        string playlistId,
        bool forceRefresh,
        CancellationToken cancellationToken)
    {
        var cached = await _db.GetYouTubePlaylistCacheAsync(playlistId, cancellationToken);
        var cacheIsFresh = cached is not null && DateTimeOffset.UtcNow - cached.FetchedAt < _cacheTtl;
        var refreshIsTooSoon = cached is not null
            && DateTimeOffset.UtcNow - cached.FetchedAt < MinimumForcedRefreshAge;
        if (cached is not null && forceRefresh && refreshIsTooSoon)
            return await ResolveAsync(cached, stale: false, truncated: cached.Truncated, cancellationToken);
        if (cached is not null && !forceRefresh && cacheIsFresh)
            return await ResolveAsync(cached, stale: false, truncated: cached.Truncated, cancellationToken);

        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            if (cached is not null) return await ResolveAsync(cached, stale: true, truncated: cached.Truncated, cancellationToken);
            throw new YouTubePlaylistException("YouTube API key is not configured", StatusCodes.Status503ServiceUnavailable);
        }

        try
        {
            var fetched = await FetchFromYouTubeAsync(playlistId, cancellationToken);
            await _db.UpsertYouTubePlaylistCacheAsync(fetched, cancellationToken);
            return await ResolveAsync(fetched, stale: false, truncated: fetched.Truncated, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (YouTubePlaylistException)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (cached is not null) return await ResolveAsync(cached, stale: true, truncated: cached.Truncated, cancellationToken);
            throw;
        }
        catch (Exception exception) when (
            !cancellationToken.IsCancellationRequested
            && exception is HttpRequestException or TaskCanceledException or JsonException)
        {
            if (cached is not null) return await ResolveAsync(cached, stale: true, truncated: cached.Truncated, cancellationToken);
            throw new YouTubePlaylistException($"YouTube playlist request failed: {exception.Message}");
        }
    }

    private async Task<YouTubePlaylistCache> FetchFromYouTubeAsync(
        string playlistId,
        CancellationToken cancellationToken)
    {
        var metadata = await GetJsonAsync(
            $"playlists?part=snippet,contentDetails&id={Uri.EscapeDataString(playlistId)}&key={Uri.EscapeDataString(_apiKey)}",
            cancellationToken);
        var metadataItem = metadata.RootElement.GetProperty("items").EnumerateArray().FirstOrDefault();
        if (metadataItem.ValueKind == JsonValueKind.Undefined)
            throw new YouTubePlaylistException("YouTube playlist was not found", StatusCodes.Status404NotFound);
        var title = metadataItem.GetProperty("snippet").GetProperty("title").GetString() ?? playlistId;
        var videoIds = new List<string>();
        string? pageToken = null;
        string? etag = metadata.RootElement.TryGetProperty("etag", out var metadataEtag) ? metadataEtag.GetString() : null;
        var truncated = false;

        for (var page = 0; page < MaxPages; page++)
        {
            var query = $"playlistItems?part=snippet,contentDetails&maxResults=50&playlistId={Uri.EscapeDataString(playlistId)}&key={Uri.EscapeDataString(_apiKey)}";
            if (!string.IsNullOrWhiteSpace(pageToken)) query += $"&pageToken={Uri.EscapeDataString(pageToken)}";
            var response = await GetJsonAsync(query, cancellationToken);
            foreach (var item in response.RootElement.GetProperty("items").EnumerateArray())
            {
                if (!item.TryGetProperty("snippet", out var snippet)
                    || !snippet.TryGetProperty("resourceId", out var resourceId)
                    || resourceId.GetProperty("kind").GetString() != "youtube#video") continue;
                var videoId = resourceId.GetProperty("videoId").GetString();
                if (!string.IsNullOrWhiteSpace(videoId)) videoIds.Add(videoId);
            }

            pageToken = response.RootElement.TryGetProperty("nextPageToken", out var next) ? next.GetString() : null;
            if (string.IsNullOrWhiteSpace(pageToken)) break;
            if (page == MaxPages - 1) truncated = true;
        }

        return new YouTubePlaylistCache(playlistId, title, [.. videoIds.Distinct()], etag, DateTimeOffset.UtcNow)
        {
            Truncated = truncated,
        };
    }

    private async Task<JsonDocument> GetJsonAsync(string relativePath, CancellationToken cancellationToken)
    {
        using var response = await _http.GetAsync(relativePath, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var detail = body.Length > 180 ? body[..180] : body;
            var status = response.StatusCode == System.Net.HttpStatusCode.NotFound
                ? StatusCodes.Status404NotFound
                : response.StatusCode == System.Net.HttpStatusCode.Forbidden
                    ? StatusCodes.Status403Forbidden
                    : StatusCodes.Status502BadGateway;
            throw new YouTubePlaylistException($"YouTube returned {(int)response.StatusCode}: {detail}", status);
        }
        return JsonDocument.Parse(body);
    }

    private async Task<YouTubePlaylistResponse> ResolveAsync(
        YouTubePlaylistCache cache,
        bool stale,
        bool truncated,
        CancellationToken cancellationToken)
    {
        var songsByVideo = await _db.GetSongsByYouTubeVideoIdsAsync(cache.VideoIds, cancellationToken);
        var songs = new List<string>();
        var seenSongIds = new HashSet<int>();
        var unmatched = new List<string>();
        foreach (var videoId in cache.VideoIds)
        {
            if (!songsByVideo.TryGetValue(videoId, out var songJson))
            {
                unmatched.Add(videoId);
                continue;
            }
            using var document = JsonDocument.Parse(songJson);
            if (!document.RootElement.TryGetProperty("id", out var idElement) || !idElement.TryGetInt32(out var songId)) continue;
            if (seenSongIds.Add(songId)) songs.Add(songJson);
        }
        return new YouTubePlaylistResponse(
            cache.PlaylistId,
            cache.Title,
            cache.VideoIds.Length,
            songs.Count,
            [.. unmatched],
            [.. songs],
            cache.FetchedAt,
            stale,
            truncated);
    }
}
