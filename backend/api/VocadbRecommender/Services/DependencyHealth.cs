namespace VocadbRecommender.Services;

public sealed record DependencyHealth(bool Ok, long LatencyMs, string? Error = null);

public sealed record DiscoveryQualityHealth(
    bool Ok,
    long LatencyMs,
    long Total,
    double AverageQuality,
    double ShortRatio,
    double NicoRatio,
    double DiscoveryEligibleRatio,
    DateTimeOffset? LatestComputedAt,
    string? Error = null);

public sealed record AudioFeatureHealth(
    bool Ok,
    long LatencyMs,
    long TargetCount,
    long ComputedCount,
    long PendingCount,
    double ComputedRatio,
    long ActionableTargetCount,
    long ActionableComputedCount,
    long ActionablePendingCount,
    double ActionableComputedRatio,
    DateTimeOffset? LatestComputedAt,
    double? LatestAgeHours,
    string? Error = null);
