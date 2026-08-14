using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class MetadataRelationshipRankingTests
{
    [Fact]
    public void RerankRelated_MatchesReferenceBitForBitAcrossRandomizedCatalogs()
    {
        for (var scenario = 0; scenario < 24; scenario++)
        {
            var random = new Random(7_301 + scenario);
            var candidateCount = random.Next(8, 90);
            var seed = RandomSong(random, 1);
            var infos = Enumerable.Range(2, candidateCount)
                .Select(id => RandomSong(random, id))
                .ToArray();
            var scoreChoices = new[] { -1.0, 0.0, 0.25, 0.5, 0.75, 1.0, 1.25 };
            var candidates = infos
                .Select(info => (
                    SongId: info.Id,
                    Score: scoreChoices[random.Next(scoreChoices.Length)]))
                .ToList();

            // Missing hydration rows are ignored, while duplicate candidate IDs
            // remain distinct ranking entries in the legacy implementation.
            candidates.Insert(random.Next(candidates.Count), (900_000 + scenario, 0.75));
            candidates.Insert(random.Next(candidates.Count), candidates[random.Next(candidates.Count)]);
            var desiredCount = random.Next(0, Math.Min(30, candidates.Count) + 1);

            var expected = ReferenceRerankRelated(candidates, seed, infos, desiredCount);
            var actual = MetadataRelationshipRanking.RerankRelated(
                candidates,
                seed,
                infos,
                desiredCount);

            AssertExact(expected, actual, $"scenario={scenario}");
        }
    }

    [Fact]
    public void RerankRelated_ComputesEachSelectedCandidateRelationshipOnlyOnce()
    {
        const int candidateCount = 120;
        const int desiredCount = 40;
        var random = new Random(91_337);
        var seed = RandomSong(random, 1);
        var infos = Enumerable.Range(2, candidateCount)
            .Select(id => RandomSong(random, id))
            .ToArray();
        var candidates = infos
            .Select((info, index) => (
                SongId: info.Id,
                Score: 1.0 - index / (double)(candidateCount + 1)))
            .ToArray();
        var contextComparisons = 0;

        var actual = MetadataRelationshipRanking.RerankRelatedWithDiagnostics(
            candidates,
            seed,
            infos,
            desiredCount,
            () => contextComparisons++);

        var expectedComparisons = (desiredCount - 1) * candidateCount
            - desiredCount * (desiredCount - 1) / 2;
        Assert.Equal(desiredCount, actual.Count);
        Assert.Equal(expectedComparisons, contextComparisons);
    }

    private static List<(int SongId, double Score)> ReferenceRerankRelated(
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
                Score: ReferenceRelatedScore(
                    seed,
                    infoMap[candidate.SongId],
                    candidate.Score)))
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
                    .Select(item => ReferenceContextRedundancy(
                        infoMap[candidate.SongId],
                        infoMap[item.SongId]))
                    .OrderByDescending(value => value)
                    .ToArray();
                var redundancy = redundancies.Length == 0
                    ? 0
                    : redundancies[0] * 0.07 + redundancies.Average() * 0.04;
                var selectedInfos = selected.Select(item => infoMap[item.SongId]).ToArray();
                var info = infoMap[candidate.SongId];
                var producerRepeats = info.ProducerIds.Length == 0 ? 0 : info.ProducerIds
                    .Max(id => selectedInfos.Count(item => item.ProducerIds.Contains(id)));
                var vocalistRepeats = info.VocalistIds.Length == 0 ? 0 : info.VocalistIds
                    .Max(id => selectedInfos.Count(item => item.VocalistIds.Contains(id)));
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
        }

        return selected;
    }

    private static double ReferenceRelatedScore(
        SongInfo seed,
        SongInfo candidate,
        double vectorScore)
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

    private static double ReferenceContextRedundancy(SongInfo first, SongInfo second)
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

    private static SongInfo RandomSong(Random random, int id)
    {
        var songTypes = new[] { "", "Original", "Cover", "Remix", "MusicPV" };
        return new SongInfo(
            Id: id,
            Name: $"Song {id}",
            ArtistString: $"Artist {random.Next(30)}",
            LengthSeconds: random.Next(5) == 0 ? 0 : random.Next(60, 480),
            SongType: songTypes[random.Next(songTypes.Length)],
            FavoritedTimes: random.Next(4) == 0 ? 0 : random.Next(1, 100_000),
            StateCluster: random.Next(-1, 8),
            ProducerIds: RandomRelationships(random, 20, 4),
            VocalistIds: RandomRelationships(random, 10, 3),
            YoutubeViews: random.Next(4) == 0 ? 0 : random.NextInt64(1, 10_000_000),
            NicoViews: random.Next(4) == 0 ? 0 : random.NextInt64(1, 2_000_000),
            PublishDate: random.Next(4) == 0
                ? null
                : new DateTime(2007, 1, 1).AddDays(random.Next(0, 7_000)),
            RelatedTagIds: RandomRelationships(random, 40, 10),
            AlbumIds: RandomRelationships(random, 15, 4),
            HasCoreVoiceSynthVocalist: true,
            HasPlayablePv: true,
            DiscoveryEligible: true,
            QualityScore: random.NextDouble(),
            HasAudioFeatures: random.Next(2) == 0,
            HasOriginalPv: random.Next(2) == 0);
    }

    private static int[] RandomRelationships(
        Random random,
        int distinctDomain,
        int maximumLength) =>
        Enumerable.Range(0, random.Next(maximumLength + 1))
            .Select(_ => random.Next(1, distinctDomain + 1))
            .ToArray();

    private static void AssertExact(
        IReadOnlyList<(int SongId, double Score)> expected,
        IReadOnlyList<(int SongId, double Score)> actual,
        string context)
    {
        Assert.Equal(expected.Count, actual.Count);
        for (var index = 0; index < expected.Count; index++)
        {
            Assert.True(
                expected[index].SongId == actual[index].SongId,
                $"{context}, index={index}: expected song {expected[index].SongId}, actual {actual[index].SongId}");
            Assert.True(
                BitConverter.DoubleToInt64Bits(expected[index].Score)
                    == BitConverter.DoubleToInt64Bits(actual[index].Score),
                $"{context}, index={index}, song={expected[index].SongId}: expected {expected[index].Score:R}, actual {actual[index].Score:R}");
        }
    }
}
