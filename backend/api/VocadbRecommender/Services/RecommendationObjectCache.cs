using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace VocadbRecommender.Services;

/// <summary>
/// Bounded partition for SongInfo and other recommendation-side objects.
/// Response JSON uses the separate SearchResponseCache partition.
/// </summary>
public sealed class RecommendationObjectCache : IDisposable
{
    internal const long MinimumEntryChargeBytes = 4 * 1024;
    internal const long EstimatedEntryOverheadBytes = 512;

    private readonly MemoryCache _cache;
    private readonly long _maxEntryBytes;
    private readonly ILogger<RecommendationObjectCache> _logger;
    private long _lastOversizeWarningUtcTicks;

    public RecommendationObjectCache(
        IOptions<RecommenderOptions> options,
        ILogger<RecommendationObjectCache> logger)
        : this(
            checked(options.Value.ObjectCacheSizeMiB * 1024L * 1024L),
            checked(options.Value.ObjectCacheEntrySizeMiB * 1024L * 1024L),
            logger)
    {
    }

    internal RecommendationObjectCache(
        long sizeLimitBytes,
        long maxEntryBytes,
        ILogger<RecommendationObjectCache> logger)
    {
        if (sizeLimitBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(sizeLimitBytes));
        if (maxEntryBytes <= 0 || maxEntryBytes > sizeLimitBytes)
            throw new ArgumentOutOfRangeException(nameof(maxEntryBytes));

        SizeLimitBytes = sizeLimitBytes;
        _maxEntryBytes = maxEntryBytes;
        _logger = logger;
        _cache = new MemoryCache(new MemoryCacheOptions
        {
            SizeLimit = sizeLimitBytes,
            CompactionPercentage = 0.25,
        });
    }

    internal long SizeLimitBytes { get; }
    internal long MaxEntryBytes => _maxEntryBytes;
    internal int EntryCount => _cache.Count;

    public bool TryGetValue<T>(string key, out T? value)
        where T : class
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        return _cache.TryGetValue(key, out value);
    }

    public bool Set<T>(
        string key,
        T value,
        TimeSpan lifetime,
        long estimatedPayloadBytes)
        where T : class
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentNullException.ThrowIfNull(value);
        if (lifetime <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(lifetime));
        if (estimatedPayloadBytes < 0)
            throw new ArgumentOutOfRangeException(nameof(estimatedPayloadBytes));

        var chargeBytes = EstimateEntryChargeBytes(key, estimatedPayloadBytes);
        if (chargeBytes > _maxEntryBytes)
        {
            _cache.Remove(key);
            LogOversizeSkip(key, chargeBytes);
            return false;
        }

        _cache.Set(
            key,
            value,
            new MemoryCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = lifetime,
                Size = chargeBytes,
            });
        return true;
    }

    internal static long EstimateEntryChargeBytes(string key, long estimatedPayloadBytes)
    {
        var fixedBytes = (long)key.Length * sizeof(char) + EstimatedEntryOverheadBytes;
        var estimated = estimatedPayloadBytes > long.MaxValue - fixedBytes
            ? long.MaxValue
            : fixedBytes + estimatedPayloadBytes;
        return Math.Max(MinimumEntryChargeBytes, estimated);
    }

    private void LogOversizeSkip(string key, long chargeBytes)
    {
        var nowTicks = DateTimeOffset.UtcNow.UtcTicks;
        var lastTicks = Volatile.Read(ref _lastOversizeWarningUtcTicks);
        if (lastTicks != 0 && nowTicks - lastTicks < TimeSpan.FromMinutes(1).Ticks)
            return;
        if (Interlocked.CompareExchange(ref _lastOversizeWarningUtcTicks, nowTicks, lastTicks) != lastTicks)
            return;

        _logger.LogWarning(
            "recommendation_object_cache_entry_skipped key={CacheKey} estimatedBytes={EstimatedBytes} maxBytes={MaxBytes}",
            key,
            chargeBytes,
            _maxEntryBytes);
    }

    public void Dispose() => _cache.Dispose();
}
