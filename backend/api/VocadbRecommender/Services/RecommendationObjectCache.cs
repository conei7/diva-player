using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using System.Collections.Concurrent;

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
    private readonly object _trackingGate = new();
    private readonly ConcurrentDictionary<string, TrackedEntry> _trackedEntries = new();
    private long _lastOversizeWarningUtcTicks;
    private long _nextEntryId;
    private long _estimatedChargeBytes;
    private long _hits;
    private long _misses;
    private long _evictions;
    private long _oversizeSkips;

    private sealed record TrackedEntry(long Id, long ChargeBytes);
    private sealed record EvictionCallbackState(
        RecommendationObjectCache Owner,
        string Key,
        TrackedEntry Entry);

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

    public CacheTelemetrySnapshot TelemetrySnapshot
    {
        get
        {
            int currentEntries;
            long estimatedChargeBytes;
            lock (_trackingGate)
            {
                currentEntries = _trackedEntries.Count;
                estimatedChargeBytes = _estimatedChargeBytes;
            }

            return new CacheTelemetrySnapshot(
                Interlocked.Read(ref _hits),
                Interlocked.Read(ref _misses),
                StaleHits: 0,
                Refreshes: 0,
                Followers: 0,
                Interlocked.Read(ref _evictions),
                Interlocked.Read(ref _oversizeSkips),
                InFlight: 0,
                currentEntries,
                estimatedChargeBytes,
                SizeLimitBytes);
        }
    }

    public bool TryGetValue<T>(string key, out T? value)
        where T : class
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        var found = _cache.TryGetValue(key, out value);
        if (found)
            Interlocked.Increment(ref _hits);
        else
            Interlocked.Increment(ref _misses);
        return found;
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
            Interlocked.Increment(ref _oversizeSkips);
            _cache.Remove(key);
            LogOversizeSkip(chargeBytes);
            return false;
        }

        StoreTracked(key, value, lifetime, chargeBytes);
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

    private void LogOversizeSkip(long chargeBytes)
    {
        var nowTicks = DateTimeOffset.UtcNow.UtcTicks;
        var lastTicks = Volatile.Read(ref _lastOversizeWarningUtcTicks);
        if (lastTicks != 0 && nowTicks - lastTicks < TimeSpan.FromMinutes(1).Ticks)
            return;
        if (Interlocked.CompareExchange(ref _lastOversizeWarningUtcTicks, nowTicks, lastTicks) != lastTicks)
            return;

        _logger.LogWarning(
            "recommendation_object_cache_entry_skipped estimatedBytes={EstimatedBytes} maxBytes={MaxBytes}",
            chargeBytes,
            _maxEntryBytes);
    }

    private void StoreTracked<T>(string key, T value, TimeSpan lifetime, long chargeBytes)
        where T : class
    {
        var tracked = new TrackedEntry(Interlocked.Increment(ref _nextEntryId), chargeBytes);
        var callbackState = new EvictionCallbackState(this, key, tracked);
        lock (_trackingGate)
        {
            if (_trackedEntries.TryGetValue(key, out var previous))
                Interlocked.Add(ref _estimatedChargeBytes, -previous.ChargeBytes);
            _trackedEntries[key] = tracked;
            Interlocked.Add(ref _estimatedChargeBytes, chargeBytes);

            try
            {
                _cache.Set(
                    key,
                    value,
                    new MemoryCacheEntryOptions
                    {
                        AbsoluteExpirationRelativeToNow = lifetime,
                        Size = chargeBytes,
                    }.RegisterPostEvictionCallback(
                        static (_, _, _, state) =>
                        {
                            var callback = (EvictionCallbackState)state!;
                            callback.Owner.OnEntryEvicted(callback.Key, callback.Entry);
                        },
                        callbackState));
            }
            catch
            {
                UntrackEntry(key, tracked);
                throw;
            }
        }
    }

    private void OnEntryEvicted(string key, TrackedEntry entry)
    {
        Interlocked.Increment(ref _evictions);
        lock (_trackingGate)
            UntrackEntry(key, entry);
    }

    private void UntrackEntry(string key, TrackedEntry expected)
    {
        if (_trackedEntries.TryGetValue(key, out var current)
            && current.Id == expected.Id
            && _trackedEntries.TryRemove(key, out _))
        {
            Interlocked.Add(ref _estimatedChargeBytes, -expected.ChargeBytes);
        }
    }

    public void Dispose() => _cache.Dispose();
}
