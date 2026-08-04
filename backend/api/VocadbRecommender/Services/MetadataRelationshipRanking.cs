namespace VocadbRecommender.Services;

/// <summary>
/// Ranks metadata candidates by several independent relationships. Vocalist identity
/// is deliberately not a relevance signal: it may still appear naturally through
/// tags, producer, era, album, and popularity, but cannot dominate by itself.
/// </summary>
public static class MetadataRelationshipRanking
{
    public static List<(int SongId, double Score)> RerankRelated(
        IEnumerable<(int SongId, double Score)> candidates,
        SongInfo seed,
        IEnumerable<SongInfo> candidateInfos,
        int desiredCount)
    {
        var infoMap = candidateInfos.ToDictionary(info => info.Id);
        var remaining = candidates
            .Where(candidate => infoMap.ContainsKey(candidate.SongId))
            .Select(candidate => (
                candidate.SongId,
                Score: RelatedScore(seed, infoMap[candidate.SongId], candidate.Score)))
            .OrderByDescending(candidate => candidate.Score)
            .ThenBy(candidate => candidate.SongId)
            .ToList();

        var selected = new List<(int SongId, double Score)>(
            Math.Min(desiredCount, remaining.Count));

        while (selected.Count < desiredCount && remaining.Count > 0)
        {
            var bestIndex = 0;
            var bestScore = double.NegativeInfinity;

            for (var index = 0; index < remaining.Count; index++)
            {
                var candidate = remaining[index];
                var redundancies = selected
                    .Select(item => ContextRedundancy(infoMap[candidate.SongId], infoMap[item.SongId]))
                    .OrderByDescending(value => value)
                    .ToArray();
                var redundancy = redundancies.Length == 0
                    ? 0
                    : redundancies[0] * 0.07 + redundancies.Average() * 0.04;
                var adjustedScore = candidate.Score - redundancy;
                if (adjustedScore <= bestScore) continue;

                bestIndex = index;
                bestScore = adjustedScore;
            }

            var best = remaining[bestIndex];
            selected.Add((best.SongId, bestScore));
            remaining.RemoveAt(bestIndex);
        }

        return selected;
    }

    /// <summary>
    /// Smoothly reduces candidates whose only obvious link to the seed is a shared
    /// vocalist. This is a score correction, not a per-artist result cap.
    /// </summary>
    public static List<(int SongId, double Score)> CorrectSingerOnlyBias(
        IEnumerable<(int SongId, double Score)> candidates,
        SongInfo seed,
        IEnumerable<SongInfo> candidateInfos)
    {
        var infoMap = candidateInfos.ToDictionary(info => info.Id);
        return candidates
            .Where(candidate => infoMap.ContainsKey(candidate.SongId))
            .Select(candidate =>
            {
                var info = infoMap[candidate.SongId];
                if (!SharesAny(seed.VocalistIds, info.VocalistIds))
                    return candidate;

                var independentContext = IndependentContextScore(seed, info);
                var multiplier = 0.78 + independentContext * 0.22;
                return (candidate.SongId, candidate.Score * multiplier);
            })
            .OrderByDescending(candidate => candidate.Item2)
            .ThenBy(candidate => candidate.SongId)
            .Select(candidate => (candidate.SongId, Score: candidate.Item2))
            .ToList();
    }

    private static double RelatedScore(SongInfo seed, SongInfo candidate, double vectorScore)
    {
        var values = new List<(double Value, double Weight)>();
        if (vectorScore >= 0)
            values.Add((Math.Clamp(vectorScore, 0, 1), 0.18));

        AddIfAvailable(values, TagSimilarity(seed, candidate), 0.34);
        AddIfAvailable(values, AlbumSimilarity(seed, candidate), 0.24);
        AddIfAvailable(values, ProducerSimilarity(seed, candidate), 0.10);
        AddIfAvailable(values, EraSimilarity(seed, candidate), 0.15);
        AddIfAvailable(values, PopularitySimilarity(seed, candidate), 0.14);
        AddIfAvailable(values, FavoriteSimilarity(seed, candidate), 0.06);
        AddIfAvailable(values, SongTypeSimilarity(seed, candidate), 0.06);
        AddIfAvailable(values, LengthSimilarity(seed, candidate), 0.05);

        return WeightedAverage(values) * RecommendationQuality.EvidenceMultiplier(candidate);
    }

    private static double IndependentContextScore(SongInfo seed, SongInfo candidate)
    {
        var values = new List<(double Value, double Weight)>();
        AddIfAvailable(values, TagSimilarity(seed, candidate), 0.32);
        AddIfAvailable(values, AlbumSimilarity(seed, candidate), 0.24);
        AddIfAvailable(values, ProducerSimilarity(seed, candidate), 0.14);
        AddIfAvailable(values, EraSimilarity(seed, candidate), 0.12);
        AddIfAvailable(values, PopularitySimilarity(seed, candidate), 0.10);
        AddIfAvailable(values, FavoriteSimilarity(seed, candidate), 0.03);
        AddIfAvailable(values, SongTypeSimilarity(seed, candidate), 0.03);
        AddIfAvailable(values, LengthSimilarity(seed, candidate), 0.02);
        return values.Count == 0 ? 0 : WeightedAverage(values);
    }

    private static double ContextRedundancy(SongInfo first, SongInfo second)
    {
        var values = new List<(double Value, double Weight)>();
        AddIfAvailable(values, TagSimilarity(first, second), 0.46);
        AddIfAvailable(values, AlbumSimilarity(first, second), 0.24);
        AddIfAvailable(values, ProducerSimilarity(first, second), 0.14);
        AddIfAvailable(values, EraSimilarity(first, second), 0.08);
        AddIfAvailable(values, PopularitySimilarity(first, second), 0.08);
        return values.Count == 0 ? 0 : WeightedAverage(values);
    }

    private static double? TagSimilarity(SongInfo first, SongInfo second) =>
        Jaccard(first.RelatedTagIds, second.RelatedTagIds);

    private static double? AlbumSimilarity(SongInfo first, SongInfo second)
    {
        if (first.AlbumIds.Length == 0 || second.AlbumIds.Length == 0) return null;
        return SharesAny(first.AlbumIds, second.AlbumIds) ? 1 : 0;
    }

    private static double? ProducerSimilarity(SongInfo first, SongInfo second)
    {
        if (first.ProducerIds.Length == 0 || second.ProducerIds.Length == 0) return null;
        return SharesAny(first.ProducerIds, second.ProducerIds) ? 1 : 0;
    }

    private static double? EraSimilarity(SongInfo first, SongInfo second)
    {
        if (first.PublishDate is null || second.PublishDate is null) return null;
        var years = Math.Abs((first.PublishDate.Value - second.PublishDate.Value).TotalDays) / 365.25;
        return Math.Exp(-years / 4.0);
    }

    private static double? PopularitySimilarity(SongInfo first, SongInfo second)
    {
        var firstViews = Math.Max(0, first.YoutubeViews) + Math.Max(0, first.NicoViews);
        var secondViews = Math.Max(0, second.YoutubeViews) + Math.Max(0, second.NicoViews);
        if (firstViews == 0 && secondViews == 0) return null;
        var distance = Math.Abs(Math.Log(1.0 + firstViews) - Math.Log(1.0 + secondViews));
        return Math.Exp(-distance / 2.5);
    }

    private static double? FavoriteSimilarity(SongInfo first, SongInfo second)
    {
        if (first.FavoritedTimes == 0 && second.FavoritedTimes == 0) return null;
        var distance = Math.Abs(
            Math.Log(1.0 + Math.Max(0, first.FavoritedTimes))
            - Math.Log(1.0 + Math.Max(0, second.FavoritedTimes)));
        return Math.Exp(-distance / 2.0);
    }

    private static double? SongTypeSimilarity(SongInfo first, SongInfo second)
    {
        if (string.IsNullOrWhiteSpace(first.SongType)
            || string.IsNullOrWhiteSpace(second.SongType))
            return null;
        return string.Equals(first.SongType, second.SongType, StringComparison.OrdinalIgnoreCase)
            ? 1
            : 0;
    }

    private static double? LengthSimilarity(SongInfo first, SongInfo second)
    {
        if (first.LengthSeconds <= 0 || second.LengthSeconds <= 0) return null;
        return Math.Exp(-Math.Abs(first.LengthSeconds - second.LengthSeconds) / 120.0);
    }

    private static double? Jaccard(int[] first, int[] second)
    {
        if (first.Length == 0 || second.Length == 0) return null;
        var firstSet = first.ToHashSet();
        var intersection = second.Count(firstSet.Contains);
        var union = firstSet.Count + second.Distinct().Count() - intersection;
        return union == 0 ? null : (double)intersection / union;
    }

    private static bool SharesAny(int[] first, int[] second)
    {
        if (first.Length == 0 || second.Length == 0) return false;
        var firstSet = first.ToHashSet();
        return second.Any(firstSet.Contains);
    }

    private static void AddIfAvailable(
        ICollection<(double Value, double Weight)> values,
        double? value,
        double weight)
    {
        if (value is not null) values.Add((Math.Clamp(value.Value, 0, 1), weight));
    }

    private static double WeightedAverage(IEnumerable<(double Value, double Weight)> values)
    {
        var totalWeight = 0.0;
        var total = 0.0;
        foreach (var (value, weight) in values)
        {
            total += value * weight;
            totalWeight += weight;
        }
        return totalWeight == 0 ? 0 : total / totalWeight;
    }
}
