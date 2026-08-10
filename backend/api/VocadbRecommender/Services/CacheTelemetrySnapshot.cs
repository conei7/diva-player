namespace VocadbRecommender.Services;

/// <summary>
/// Process-lifetime cache counters plus the current bounded-cache footprint.
/// The snapshot deliberately contains no cache keys or request dimensions.
/// </summary>
public sealed record CacheTelemetrySnapshot(
    long Hits,
    long Misses,
    long StaleHits,
    long Refreshes,
    long Followers,
    long Evictions,
    long OversizeSkips,
    int InFlight,
    int CurrentEntries,
    long EstimatedChargeBytes,
    long SizeLimitBytes);
