using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using System.Collections.Concurrent;
using System.Diagnostics;

namespace VocadbRecommender.Services;

/// <summary>
/// A bounded cache dedicated to search response JSON. It intentionally does
/// not share capacity with SongInfo and recommendation caches.
/// </summary>
public sealed class SearchResponseCache : IDisposable
{
    internal const long MinimumEntryChargeBytes = 4 * 1024;
    internal const long EstimatedEntryOverheadBytes = 512;
    internal static readonly TimeSpan FreshLifetime = TimeSpan.FromMinutes(1);
    internal static readonly TimeSpan StaleLifetime = TimeSpan.FromHours(6);
    internal static readonly TimeSpan RefreshFailureBackoff = TimeSpan.FromSeconds(30);

    private readonly MemoryCache _cache;
    private readonly long _maxEntryBytes;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<SearchResponseCache> _logger;
    private readonly Func<Task>? _beforeColdLoadRegistration;
    private readonly ConcurrentDictionary<string, Lazy<Task<SongSearchExecution>>> _loads = new();
    private long _lastOversizeWarningUtcTicks;

    private sealed record CachedSearchResponse(
        string ItemsJson,
        int TotalCount,
        DateTimeOffset FreshUntil,
        DateTimeOffset StaleUntil)
    {
        public long RefreshRetryAfterUtcTicks;
    }

    public SearchResponseCache(
        IOptions<RecommenderOptions> options,
        ILogger<SearchResponseCache> logger)
        : this(
            checked(options.Value.SearchCacheSizeMiB * 1024L * 1024L),
            checked(options.Value.SearchCacheEntrySizeMiB * 1024L * 1024L),
            TimeProvider.System,
            logger,
            null)
    {
    }

    internal SearchResponseCache(
        long sizeLimitBytes,
        long maxEntryBytes,
        TimeProvider timeProvider,
        ILogger<SearchResponseCache> logger,
        Func<Task>? beforeColdLoadRegistration = null)
    {
        if (sizeLimitBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(sizeLimitBytes));
        if (maxEntryBytes <= 0 || maxEntryBytes > sizeLimitBytes)
            throw new ArgumentOutOfRangeException(nameof(maxEntryBytes));

        SizeLimitBytes = sizeLimitBytes;
        _maxEntryBytes = maxEntryBytes;
        _timeProvider = timeProvider;
        _logger = logger;
        _beforeColdLoadRegistration = beforeColdLoadRegistration;
        _cache = new MemoryCache(new MemoryCacheOptions
        {
            SizeLimit = sizeLimitBytes,
            CompactionPercentage = 0.25,
        });
    }

    internal long SizeLimitBytes { get; }
    internal long MaxEntryBytes => _maxEntryBytes;

    public async Task<SongSearchExecution> GetOrCreateAsync(
        string key,
        Func<Task<SongSearchExecution>> loader,
        bool forceRefresh = false)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentNullException.ThrowIfNull(loader);

        var stopwatch = Stopwatch.StartNew();
        if (!forceRefresh && TryGetCached(key, out var cached))
        {
            if (cached.FreshUntil <= _timeProvider.GetUtcNow())
                StartBackgroundRefresh(key, cached, loader);

            stopwatch.Stop();
            return new SongSearchExecution(
                cached.ItemsJson,
                cached.TotalCount,
                0,
                0,
                0,
                stopwatch.ElapsedMilliseconds,
                true);
        }

        if (!forceRefresh && _beforeColdLoadRegistration is not null)
            await _beforeColdLoadRegistration();
        return await LoadSingleFlightAsync(key, loader, forceRefresh);
    }

    internal static long EstimateEntryChargeBytes(string key, string itemsJson)
    {
        var estimated = (long)key.Length * sizeof(char)
            + (long)itemsJson.Length * sizeof(char)
            + EstimatedEntryOverheadBytes;
        return Math.Max(MinimumEntryChargeBytes, estimated);
    }

    internal bool HasInFlightLoad(string key) => _loads.ContainsKey(key);

    private async Task<SongSearchExecution> LoadSingleFlightAsync(
        string key,
        Func<Task<SongSearchExecution>> loader,
        bool forceRefresh)
    {
        var lazy = _loads.GetOrAdd(
            key,
            _ => new Lazy<Task<SongSearchExecution>>(
                () => LoadAfterCacheRecheckAsync(key, loader, forceRefresh),
                LazyThreadSafetyMode.ExecutionAndPublication));
        try
        {
            return await lazy.Value;
        }
        finally
        {
            RemoveLoad(key, lazy);
        }
    }

    private void StartBackgroundRefresh(
        string key,
        CachedSearchResponse stale,
        Func<Task<SongSearchExecution>> loader)
    {
        if (Volatile.Read(ref stale.RefreshRetryAfterUtcTicks) > _timeProvider.GetUtcNow().UtcTicks)
            return;

        var lazy = new Lazy<Task<SongSearchExecution>>(
            () => Task.Run(() => LoadAfterCacheRecheckAsync(key, loader, forceRefresh: false)),
            LazyThreadSafetyMode.ExecutionAndPublication);
        if (!_loads.TryAdd(key, lazy)) return;
        _ = ObserveBackgroundRefreshAsync(key, stale, lazy);
    }

    private async Task ObserveBackgroundRefreshAsync(
        string key,
        CachedSearchResponse stale,
        Lazy<Task<SongSearchExecution>> lazy)
    {
        try
        {
            await lazy.Value;
        }
        catch (Exception exception)
        {
            Volatile.Write(
                ref stale.RefreshRetryAfterUtcTicks,
                _timeProvider.GetUtcNow().Add(RefreshFailureBackoff).UtcTicks);
            _logger.LogWarning(
                exception,
                "song_search_cache_refresh_failed key={CacheKey}",
                key);
        }
        finally
        {
            RemoveLoad(key, lazy);
        }
    }

    private async Task<SongSearchExecution> LoadAndStoreAsync(
        string key,
        Func<Task<SongSearchExecution>> loader)
    {
        var execution = await loader();
        var chargeBytes = EstimateEntryChargeBytes(key, execution.ItemsJson);
        if (chargeBytes > _maxEntryBytes)
        {
            _cache.Remove(key);
            LogOversizeSkip(key, chargeBytes);
            return execution;
        }

        var now = _timeProvider.GetUtcNow();
        _cache.Set(
            key,
            new CachedSearchResponse(
                execution.ItemsJson,
                execution.TotalCount,
                now.Add(FreshLifetime),
                now.Add(StaleLifetime)),
            new MemoryCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = StaleLifetime,
                Size = chargeBytes,
            });
        return execution;
    }

    private Task<SongSearchExecution> LoadAfterCacheRecheckAsync(
        string key,
        Func<Task<SongSearchExecution>> loader,
        bool forceRefresh)
    {
        // A leader may have populated and removed its in-flight entry after
        // this caller's initial miss but before GetOrAdd. Recheck inside the
        // new leader factory so that race cannot start a duplicate DB query.
        if (!forceRefresh
            && TryGetCached(key, out var cached)
            && cached.FreshUntil > _timeProvider.GetUtcNow())
        {
            return Task.FromResult(new SongSearchExecution(
                cached.ItemsJson,
                cached.TotalCount,
                0,
                0,
                0,
                0,
                true));
        }

        return LoadAndStoreAsync(key, loader);
    }

    private bool TryGetCached(string key, out CachedSearchResponse cached)
    {
        if (!_cache.TryGetValue(key, out CachedSearchResponse? candidate) || candidate is null)
        {
            cached = null!;
            return false;
        }

        if (candidate.StaleUntil <= _timeProvider.GetUtcNow())
        {
            _cache.Remove(key);
            cached = null!;
            return false;
        }

        cached = candidate;
        return true;
    }

    private void LogOversizeSkip(string key, long chargeBytes)
    {
        var nowTicks = _timeProvider.GetUtcNow().UtcTicks;
        var lastTicks = Volatile.Read(ref _lastOversizeWarningUtcTicks);
        if (lastTicks != 0 && nowTicks - lastTicks < TimeSpan.FromMinutes(1).Ticks)
            return;
        if (Interlocked.CompareExchange(ref _lastOversizeWarningUtcTicks, nowTicks, lastTicks) != lastTicks)
            return;

        _logger.LogWarning(
            "song_search_cache_entry_skipped key={CacheKey} estimatedBytes={EstimatedBytes} maxBytes={MaxBytes}",
            key,
            chargeBytes,
            _maxEntryBytes);
    }

    private void RemoveLoad(string key, Lazy<Task<SongSearchExecution>> expected)
    {
        if (_loads.TryGetValue(key, out var current) && ReferenceEquals(current, expected))
            _loads.TryRemove(key, out _);
    }

    public void Dispose() => _cache.Dispose();
}
