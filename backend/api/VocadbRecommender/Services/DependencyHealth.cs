namespace VocadbRecommender.Services;

public sealed record DependencyHealth(bool Ok, long LatencyMs, string? Error = null);
