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
