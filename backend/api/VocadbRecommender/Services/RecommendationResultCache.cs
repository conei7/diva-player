using System.Collections.Concurrent;

namespace VocadbRecommender.Services;

/// <summary>
/// Keeps whole recommendation answers and compact song cards in the bounded
/// object cache. Recommendations depend only on the seed, the request options
/// and the publication generation (never on the caller), so Home's pages, the
/// watch page and every listener share one computation per seed.
/// Concurrent misses for one key share a single computation.
/// </summary>
public sealed class RecommendationResultCache
{
    // Keys carry the publication generation, so a stored ranking never outlives the
    // data it was computed from; the lifetime only bounds memory between daily updates.
    internal static readonly TimeSpan ResultLifetime = TimeSpan.FromHours(24);
    internal static readonly TimeSpan EmptyResultLifetime = TimeSpan.FromMinutes(1);
    // Cards carry view counts, which change between publications.
    internal static readonly TimeSpan CardLifetime = TimeSpan.FromMinutes(30);
    internal const int MaxTrackedSeeds = 512;

    private readonly RecommendationObjectCache _cache;
    private readonly ConcurrentDictionary<string, Task<object>> _inFlight = new();
    private readonly ConcurrentDictionary<int, long> _recentSeeds = new();
    private readonly object _seedTrimGate = new();
    private long _seedClock;

    public RecommendationResultCache(RecommendationObjectCache cache)
    {
        _cache = cache;
    }

    /// <summary>
    /// Returns the cached value, or runs <paramref name="factory"/> once for
    /// every concurrent caller. The computation uses the first caller's token:
    /// a follower whose own request is still alive retries when that caller
    /// cancels, so one disconnect never fails another listener.
    /// </summary>
    public async Task<(T Value, bool Hit)> GetOrCreateAsync<T>(
        string key,
        Func<CancellationToken, Task<T>> factory,
        Func<T, TimeSpan> lifetime,
        Func<T, long> estimatedBytes,
        CancellationToken cancellationToken)
        where T : class
    {
        for (var attempt = 0; ; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_cache.TryGetValue<T>(key, out var cached) && cached is not null)
                return (cached, true);

            var created = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            var shared = _inFlight.GetOrAdd(key, created.Task);
            if (!ReferenceEquals(shared, created.Task))
            {
                try
                {
                    return ((T)await shared.WaitAsync(cancellationToken), false);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && attempt < 2)
                {
                    continue;
                }
            }

            T value;
            try
            {
                value = await factory(cancellationToken);
                _cache.Set(key, value, lifetime(value), estimatedBytes(value));
            }
            catch (Exception exception)
            {
                // Leave the in-flight slot before followers wake up, so a retrying
                // follower starts a new computation instead of re-awaiting this one.
                _inFlight.TryRemove(new KeyValuePair<string, Task<object>>(key, created.Task));
                if (exception is OperationCanceledException)
                    created.TrySetCanceled();
                else
                    created.TrySetException(exception);
                // Observe the shared task so a failure without followers is not unobserved.
                _ = created.Task.Exception;
                throw;
            }

            _inFlight.TryRemove(new KeyValuePair<string, Task<object>>(key, created.Task));
            created.SetResult(value);
            return (value, false);
        }
    }

    /// <summary>
    /// Compact card JSON by song ID, in the requested order. Cached cards are
    /// served from memory; only missing IDs reach PostgreSQL.
    /// </summary>
    public async Task<(IReadOnlyList<string> Cards, int Hits)> GetSongCardJsonAsync(
        DbService db,
        IReadOnlyList<int> orderedIds,
        CancellationToken cancellationToken)
    {
        var byId = new Dictionary<int, string>(orderedIds.Count);
        var missing = new List<int>();
        foreach (var id in orderedIds)
        {
            if (_cache.TryGetValue<string>(CardKey(id), out var json) && json is not null)
                byId[id] = json;
            else
                missing.Add(id);
        }

        var hits = byId.Count;
        if (missing.Count > 0)
        {
            var loaded = await db.GetSongsCardJsonByIdsAsync(missing.ToArray(), cancellationToken);
            foreach (var (id, json) in loaded)
            {
                byId[id] = json;
                _cache.Set(CardKey(id), json, CardLifetime, (long)json.Length * sizeof(char));
            }
        }

        return (orderedIds.Where(byId.ContainsKey).Select(id => byId[id]).ToArray(), hits);
    }

    /// <summary>Remembers a seed a listener asked for, so a new publication can recompute it ahead of them.</summary>
    public void NoteSeed(int songId)
    {
        _recentSeeds[songId] = Interlocked.Increment(ref _seedClock);
        if (_recentSeeds.Count <= MaxTrackedSeeds * 2) return;
        lock (_seedTrimGate)
        {
            if (_recentSeeds.Count <= MaxTrackedSeeds * 2) return;
            foreach (var stale in _recentSeeds.OrderByDescending(pair => pair.Value).Skip(MaxTrackedSeeds).ToArray())
                _recentSeeds.TryRemove(stale);
        }
    }

    /// <summary>The most recently requested seeds, newest first.</summary>
    public IReadOnlyList<int> RecentSeeds(int max) =>
        _recentSeeds.OrderByDescending(pair => pair.Value).Take(max).Select(pair => pair.Key).ToArray();

    private static string CardKey(int songId) => $"song-card-json:v1:{songId}";
}
