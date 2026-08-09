using System.Text.Json;

namespace VocadbRecommender.Services;

public sealed record NicoPlaylistCache(
    string SourceKind,
    string SourceId,
    string Title,
    string[] VideoIds,
    DateTimeOffset FetchedAt)
{
    public bool Truncated { get; init; }
}

public sealed record NicoPlaylistResponse(
    string SourceKind,
    string SourceId,
    string Title,
    int VideoCount,
    int MatchedCount,
    string[] UnmatchedVideoIds,
    string[] SongsJson,
    DateTimeOffset SourceFetchedAt,
    bool Stale,
    bool Truncated);

public sealed class NicoPlaylistException(string message, int statusCode = StatusCodes.Status502BadGateway)
    : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

public sealed class NicoPlaylistService
{
    private const int PageSize = 100;
    private const int MaxPages = 50;
    private static readonly TimeSpan MinimumForcedRefreshAge = TimeSpan.FromMinutes(5);
    private readonly HttpClient _http;
    private readonly DbService _db;
    private readonly TimeSpan _cacheTtl;

    public NicoPlaylistService(HttpClient http, DbService db, IConfiguration configuration)
    {
        _http = http;
        _db = db;
        _cacheTtl = TimeSpan.FromHours(
            double.TryParse(configuration["Recommender:NicoPlaylistCacheHours"], out var hours)
                ? Math.Clamp(hours, 1, 168)
                : 6);
    }

    public async Task<NicoPlaylistResponse> GetAsync(
        string sourceKind,
        string sourceId,
        bool forceRefresh,
        CancellationToken cancellationToken)
    {
        var cached = await _db.GetNicoPlaylistCacheAsync(sourceKind, sourceId, cancellationToken);
        var age = cached is null ? TimeSpan.MaxValue : DateTimeOffset.UtcNow - cached.FetchedAt;
        if (cached is not null && ((forceRefresh && age < MinimumForcedRefreshAge) || (!forceRefresh && age < _cacheTtl)))
            return await ResolveAsync(cached, stale: false, cancellationToken);

        try
        {
            var fetched = await FetchFromNicoAsync(sourceKind, sourceId, cancellationToken);
            await _db.UpsertNicoPlaylistCacheAsync(fetched, cancellationToken);
            return await ResolveAsync(fetched, stale: false, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (NicoPlaylistException)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (cached is not null) return await ResolveAsync(cached, stale: true, cancellationToken);
            throw;
        }
        catch (Exception exception) when (
            !cancellationToken.IsCancellationRequested
            && exception is HttpRequestException or TaskCanceledException or JsonException)
        {
            if (cached is not null) return await ResolveAsync(cached, stale: true, cancellationToken);
            throw new NicoPlaylistException($"NicoNico playlist request failed: {exception.Message}");
        }
    }

    private async Task<NicoPlaylistCache> FetchFromNicoAsync(
        string sourceKind,
        string sourceId,
        CancellationToken cancellationToken)
    {
        var videoIds = new List<string>();
        var seenVideoIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var title = sourceId;
        var truncated = false;

        for (var page = 1; page <= MaxPages; page++)
        {
            var path = sourceKind == "mylist"
                ? $"v2/mylists/{sourceId}?pageSize={PageSize}&page={page}"
                : $"v2/series/{sourceId}?pageSize={PageSize}&page={page}";
            using var document = await GetJsonAsync(path, cancellationToken);
            var data = document.RootElement.GetProperty("data");
            JsonElement items;
            var hasNext = false;
            var totalCount = 0;
            if (sourceKind == "mylist")
            {
                var mylist = data.GetProperty("mylist");
                if (page == 1 && mylist.TryGetProperty("name", out var name)) title = name.GetString() ?? sourceId;
                items = mylist.GetProperty("items");
                hasNext = mylist.TryGetProperty("hasNext", out var next) && next.GetBoolean();
                if (mylist.TryGetProperty("totalItemCount", out var total)) totalCount = total.GetInt32();
            }
            else
            {
                if (page == 1 && data.TryGetProperty("detail", out var detail)
                    && detail.TryGetProperty("title", out var seriesTitle)) title = seriesTitle.GetString() ?? sourceId;
                items = data.GetProperty("items");
                if (data.TryGetProperty("totalCount", out var total)) totalCount = total.GetInt32();
                hasNext = page * PageSize < totalCount;
            }

            foreach (var item in items.EnumerateArray())
            {
                string? videoId = null;
                if (item.TryGetProperty("watchId", out var watchId)) videoId = watchId.GetString();
                if (string.IsNullOrWhiteSpace(videoId)
                    && item.TryGetProperty("video", out var video)
                    && video.TryGetProperty("id", out var id)) videoId = id.GetString();
                if (string.IsNullOrWhiteSpace(videoId)
                    && item.TryGetProperty("meta", out var meta)
                    && meta.TryGetProperty("id", out var metaId)) videoId = metaId.GetString();
                if (!string.IsNullOrWhiteSpace(videoId) && seenVideoIds.Add(videoId)) videoIds.Add(videoId);
            }

            if (!hasNext || items.GetArrayLength() == 0) break;
            if (page == MaxPages) truncated = true;
        }

        return new NicoPlaylistCache(sourceKind, sourceId, title, [.. videoIds], DateTimeOffset.UtcNow)
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
            var status = response.StatusCode switch
            {
                System.Net.HttpStatusCode.NotFound => StatusCodes.Status404NotFound,
                System.Net.HttpStatusCode.Forbidden => StatusCodes.Status403Forbidden,
                _ => StatusCodes.Status502BadGateway,
            };
            var message = status is StatusCodes.Status403Forbidden or StatusCodes.Status404NotFound
                ? "NicoNico playlist was not found or is not public"
                : $"NicoNico returned {(int)response.StatusCode}";
            throw new NicoPlaylistException(message, status);
        }
        return JsonDocument.Parse(body);
    }

    private async Task<NicoPlaylistResponse> ResolveAsync(
        NicoPlaylistCache cache,
        bool stale,
        CancellationToken cancellationToken)
    {
        var songsByVideo = await _db.GetSongsByNicoVideoIdsAsync(cache.VideoIds, cancellationToken);
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
        return new NicoPlaylistResponse(
            cache.SourceKind,
            cache.SourceId,
            cache.Title,
            cache.VideoIds.Length,
            songs.Count,
            [.. unmatched],
            [.. songs],
            cache.FetchedAt,
            stale,
            cache.Truncated);
    }
}
