namespace VocadbRecommender.Services;

/// <summary>
/// Normalized ranking inputs shared by the cache identity and SQL execution.
/// </summary>
internal sealed record RankingRequest(
    int Days,
    int Start,
    int MaxResults,
    string Mode,
    string Ranking,
    int Seed,
    bool Debug,
    long MinYoutubeViews,
    long MinNicoViews,
    string[] ExcludedSongTypes)
{
    public string CacheKey =>
        $"trending:{Mode}:{Ranking}:{Seed}:{Debug}:{Days}:{Start}:{MaxResults}:{MinYoutubeViews}:{MinNicoViews}:{string.Join(',', ExcludedSongTypes)}";

    public static RankingRequest Create(
        int days,
        int start,
        int maxResults,
        string? mode,
        string? ranking,
        int seed,
        bool debug,
        long? minYoutubeViews,
        long? minNicoViews,
        IReadOnlyCollection<string>? excludedSongTypes)
    {
        var normalizedMode = mode switch
        {
            "alltime" => "alltime",
            "pace" or "popular" => "pace",
            "surge" => "surge",
            "recent" => "recent",
            "deep" => "deep",
            _ => "growth",
        };
        var normalizedExcludedTypes = (excludedSongTypes ?? [])
            .Where(type => !string.IsNullOrWhiteSpace(type))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var normalizedDays = normalizedMode is "alltime" or "pace" or "recent" or "deep"
            ? 30
            : Math.Clamp(days, 1, 365);
        var normalizedSeed = normalizedMode is "alltime" or "pace" or "surge" or "recent"
            ? 0
            : Math.Clamp(seed, 0, 63);
        var normalizedRanking = normalizedMode == "surge" && ranking == "legacy"
            ? "legacy"
            : "quality";

        return new RankingRequest(
            Days: normalizedDays,
            Start: Math.Max(0, start),
            MaxResults: Math.Clamp(maxResults, 1, 100),
            Mode: normalizedMode,
            Ranking: normalizedRanking,
            Seed: normalizedSeed,
            Debug: normalizedMode == "surge" && debug,
            MinYoutubeViews: minYoutubeViews is > 0 ? minYoutubeViews.Value : 0,
            MinNicoViews: minNicoViews is > 0 ? minNicoViews.Value : 0,
            ExcludedSongTypes: normalizedExcludedTypes);
    }
}
