namespace VocadbRecommender.Services;

/// <summary>
/// Ranks metadata candidates by several independent relationships. Vocalist identity
/// is deliberately not a relevance signal: it may still appear naturally through
/// tags, producer, era, album, and popularity, but cannot dominate by itself.
/// </summary>
public static class MetadataRelationshipRanking
{
    public static bool NeedsDiverseFallback(
        IEnumerable<SongInfo> candidateInfos,
        IEnumerable<SongInfo>? vocalistAssessmentInfos = null)
    {
        var eligibleInfos = candidateInfos
            .Where(DiscoveryEligibility.IsEligible)
            .ToArray();
        var producerInfos = eligibleInfos
            .Where(info => info.ProducerIds.Length > 0)
            .ToArray();
        // Newly ingested songs may not have a vector, tags, or another song by
        // the same producer yet. A sparse pool needs the same catalog fallback
        // as a producer-concentrated pool so these valid seeds do not return an
        // empty recommendation list.
        if (producerInfos.Length < 20) return true;

        var dominantProducerShare = producerInfos
            .SelectMany(info => info.ProducerIds.Distinct())
            .GroupBy(id => id)
            .Select(group => (double)group.Count() / producerInfos.Length)
            .DefaultIfEmpty(0)
            .Max();
        var distinctProducers = producerInfos
            .SelectMany(info => info.ProducerIds)
            .Distinct()
            .Count();

        // A pool can have hundreds of distinct producers and still consist of
        // one voice-synth catalog. MMR can downrank repetition, but it cannot
        // select another vocalist unless the candidate pool contains one.
        var vocalistInfos = (vocalistAssessmentInfos ?? eligibleInfos)
            .Where(DiscoveryEligibility.IsEligible)
            .Where(info => info.VocalistIds.Length > 0)
            .ToArray();
        if (vocalistInfos.Length < 20) return true;

        var dominantVocalistShare = vocalistInfos
            .SelectMany(info => info.VocalistIds.Distinct())
            .GroupBy(id => id)
            .Select(group => (double)group.Count() / vocalistInfos.Length)
            .DefaultIfEmpty(0)
            .Max();
        var distinctVocalists = vocalistInfos
            .SelectMany(info => info.VocalistIds)
            .Distinct()
            .Count();
        return dominantProducerShare >= 0.65
            || distinctProducers < 8
            || dominantVocalistShare >= 0.65
            || distinctVocalists < 8;
    }

    public static List<(int SongId, double Score)> RerankRelated(
        IEnumerable<(int SongId, double Score)> candidates,
        SongInfo seed,
        IEnumerable<SongInfo> candidateInfos,
        int desiredCount) =>
        RerankRelatedCore(candidates, seed, candidateInfos, desiredCount, null);

    internal static List<(int SongId, double Score)> RerankRelatedWithDiagnostics(
        IEnumerable<(int SongId, double Score)> candidates,
        SongInfo seed,
        IEnumerable<SongInfo> candidateInfos,
        int desiredCount,
        Action contextComparisonObserver) =>
        RerankRelatedCore(
            candidates,
            seed,
            candidateInfos,
            desiredCount,
            contextComparisonObserver ?? throw new ArgumentNullException(nameof(contextComparisonObserver)));

    private static List<(int SongId, double Score)> RerankRelatedCore(
        IEnumerable<(int SongId, double Score)> candidates,
        SongInfo seed,
        IEnumerable<SongInfo> candidateInfos,
        int desiredCount,
        Action? contextComparisonObserver)
    {
        var infoMap = candidateInfos.ToDictionary(info => info.Id);
        // Relationship sets are immutable for this request. Preparing them once
        // avoids rebuilding HashSets for every candidate/selected-song pair.
        var preparedInfoMap = infoMap.ToDictionary(
            pair => pair.Key,
            pair => new PreparedRelationships(pair.Value));
        var preparedSeed = new PreparedRelationships(seed);
        var remaining = candidates
            .Where(candidate => infoMap.ContainsKey(candidate.SongId))
            .Select(candidate => new RankedCandidate(
                candidate.SongId,
                RelatedScore(
                    preparedSeed,
                    preparedInfoMap[candidate.SongId],
                    candidate.Score),
                preparedInfoMap[candidate.SongId],
                desiredCount))
            .OrderByDescending(candidate => candidate.Score)
            .ThenBy(candidate => candidate.SongId)
            .ToList();

        var selected = new List<(int SongId, double Score)>(
            Math.Min(desiredCount, remaining.Count));
        var selectedProducerCounts = new Dictionary<int, int>();
        var selectedVocalistCounts = new Dictionary<int, int>();

        while (selected.Count < desiredCount && remaining.Count > 0)
        {
            var bestIndex = 0;
            var bestScore = double.NegativeInfinity;

            for (var index = 0; index < remaining.Count; index++)
            {
                var candidate = remaining[index];
                var redundancy = candidate.Redundancies.Count == 0
                    ? 0
                    : candidate.Redundancies[0] * 0.07
                        + candidate.Redundancies.Average() * 0.04;
                var info = candidate.Relationships.Info;
                var producerRepeats = info.ProducerIds.Length == 0 ? 0 : info.ProducerIds
                    .Max(id => selectedProducerCounts.GetValueOrDefault(id));
                var vocalistRepeats = info.VocalistIds.Length == 0 ? 0 : info.VocalistIds
                    .Max(id => selectedVocalistCounts.GetValueOrDefault(id));
                var diversityPenalty = 0.42 * (1.0 - Math.Exp(-0.8 * producerRepeats))
                    + 0.16 * (1.0 - Math.Exp(-0.45 * vocalistRepeats));
                var adjustedScore = candidate.Score - redundancy - diversityPenalty;
                if (adjustedScore <= bestScore) continue;

                bestIndex = index;
                bestScore = adjustedScore;
            }

            var best = remaining[bestIndex];
            selected.Add((best.SongId, bestScore));
            remaining.RemoveAt(bestIndex);
            IncrementSelectedRelationshipCounts(
                selectedProducerCounts,
                best.Relationships.Info.ProducerIds);
            IncrementSelectedRelationshipCounts(
                selectedVocalistCounts,
                best.Relationships.Info.VocalistIds);

            if (selected.Count >= desiredCount || remaining.Count == 0) continue;
            // Each candidate pair is evaluated once, when the newer item becomes
            // selected. RankedCandidate retains the legacy descending Average order.
            foreach (var candidate in remaining)
            {
                contextComparisonObserver?.Invoke();
                candidate.AddRedundancy(
                    ContextRedundancy(candidate.Relationships, best.Relationships));
            }
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

    private static double RelatedScore(
        PreparedRelationships seed,
        PreparedRelationships candidate,
        double vectorScore)
    {
        var values = new WeightedValues();
        if (vectorScore >= 0)
            values.Add(Math.Clamp(vectorScore, 0, 1), 0.18);

        values.Add(TagSimilarity(seed, candidate), 0.34);
        values.Add(AlbumSimilarity(seed, candidate), 0.24);
        values.Add(ProducerSimilarity(seed, candidate), 0.10);
        values.Add(EraSimilarity(seed.Info, candidate.Info), 0.15);
        values.Add(PopularitySimilarity(seed.Info, candidate.Info), 0.14);
        values.Add(FavoriteSimilarity(seed.Info, candidate.Info), 0.06);
        values.Add(SongTypeSimilarity(seed.Info, candidate.Info), 0.06);
        values.Add(LengthSimilarity(seed.Info, candidate.Info), 0.05);

        return values.Average * RecommendationQuality.EvidenceMultiplier(candidate.Info);
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

    private static double ContextRedundancy(
        PreparedRelationships first,
        PreparedRelationships second)
    {
        var values = new WeightedValues();
        values.Add(TagSimilarity(first, second), 0.46);
        values.Add(AlbumSimilarity(first, second), 0.24);
        values.Add(ProducerSimilarity(first, second), 0.14);
        values.Add(EraSimilarity(first.Info, second.Info), 0.08);
        values.Add(PopularitySimilarity(first.Info, second.Info), 0.08);
        return values.Average;
    }

    private static double? TagSimilarity(
        PreparedRelationships first,
        PreparedRelationships second)
    {
        if (first.Info.RelatedTagIds.Length == 0 || second.Info.RelatedTagIds.Length == 0)
            return null;
        var intersection = second.Info.RelatedTagIds.Count(first.RelatedTagIds.Contains);
        var union = first.RelatedTagIds.Count + second.RelatedTagDistinctCount - intersection;
        return union == 0 ? null : (double)intersection / union;
    }

    private static double? AlbumSimilarity(
        PreparedRelationships first,
        PreparedRelationships second)
    {
        if (first.Info.AlbumIds.Length == 0 || second.Info.AlbumIds.Length == 0)
            return null;
        return second.Info.AlbumIds.Any(first.AlbumIds.Contains) ? 1 : 0;
    }

    private static double? ProducerSimilarity(
        PreparedRelationships first,
        PreparedRelationships second)
    {
        if (first.Info.ProducerIds.Length == 0 || second.Info.ProducerIds.Length == 0)
            return null;
        return second.Info.ProducerIds.Any(first.ProducerIds.Contains) ? 1 : 0;
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

    private static void IncrementSelectedRelationshipCounts(
        Dictionary<int, int> counts,
        int[] relationshipIds)
    {
        for (var index = 0; index < relationshipIds.Length; index++)
        {
            var relationshipId = relationshipIds[index];
            var alreadyCounted = false;
            for (var previousIndex = 0; previousIndex < index; previousIndex++)
            {
                if (relationshipIds[previousIndex] != relationshipId) continue;
                alreadyCounted = true;
                break;
            }
            if (!alreadyCounted)
                counts[relationshipId] = counts.GetValueOrDefault(relationshipId) + 1;
        }
    }

    private sealed class PreparedRelationships
    {
        public PreparedRelationships(SongInfo info)
        {
            Info = info;
            RelatedTagIds = info.RelatedTagIds.ToHashSet();
            RelatedTagDistinctCount = RelatedTagIds.Count;
            AlbumIds = info.AlbumIds.ToHashSet();
            ProducerIds = info.ProducerIds.ToHashSet();
        }

        public SongInfo Info { get; }
        public HashSet<int> RelatedTagIds { get; }
        public int RelatedTagDistinctCount { get; }
        public HashSet<int> AlbumIds { get; }
        public HashSet<int> ProducerIds { get; }
    }

    private sealed class RankedCandidate
    {
        public RankedCandidate(
            int songId,
            double score,
            PreparedRelationships relationships,
            int desiredCount)
        {
            SongId = songId;
            Score = score;
            Relationships = relationships;
            Redundancies = new List<double>(Math.Max(0, desiredCount));
        }

        public int SongId { get; }
        public double Score { get; }
        public PreparedRelationships Relationships { get; }
        public List<double> Redundancies { get; }

        public void AddRedundancy(double value)
        {
            // LINQ OrderByDescending is stable. Insert after equal values so the
            // later Average performs floating-point additions in the same order.
            var index = 0;
            while (index < Redundancies.Count
                   && Comparer<double>.Default.Compare(Redundancies[index], value) >= 0)
            {
                index++;
            }
            Redundancies.Insert(index, value);
        }
    }

    private struct WeightedValues
    {
        private double _total;
        private double _totalWeight;

        public readonly double Average => _totalWeight == 0 ? 0 : _total / _totalWeight;

        public void Add(double value, double weight)
        {
            _total += Math.Clamp(value, 0, 1) * weight;
            _totalWeight += weight;
        }

        public void Add(double? value, double weight)
        {
            if (value is not null) Add(value.Value, weight);
        }
    }
}
