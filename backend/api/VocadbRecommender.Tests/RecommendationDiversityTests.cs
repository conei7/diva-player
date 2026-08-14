using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class RecommendationDiversityTests
{
    [Fact]
    public void VocalistDominantPool_RequestsFallbackDespiteDiverseProducers()
    {
        var candidates = Enumerable.Range(1, 30)
            .Select(index => Song(index, producerId: 1_000 + index, vocalistId: 1))
            .ToArray();

        Assert.True(MetadataRelationshipRanking.NeedsDiverseFallback(candidates));
    }

    [Fact]
    public void ProducerDominantPool_StillRequestsFallback()
    {
        var candidates = Enumerable.Range(1, 30)
            .Select(index => Song(index, producerId: 1, vocalistId: 1_000 + index))
            .ToArray();

        Assert.True(MetadataRelationshipRanking.NeedsDiverseFallback(candidates));
    }

    [Fact]
    public void ProducerAndVocalistDiversePool_DoesNotRequestFallback()
    {
        var candidates = Enumerable.Range(1, 30)
            .Select(index => Song(
                index,
                producerId: 1_000 + index,
                vocalistId: 2_000 + index % 10))
            .ToArray();

        Assert.False(MetadataRelationshipRanking.NeedsDiverseFallback(candidates));
    }

    [Fact]
    public void VocalistDominantRelevanceHead_IsNotMaskedByADiverseLongTail()
    {
        var relevanceHead = Enumerable.Range(1, 100)
            .Select(index => Song(index, producerId: 1_000 + index, vocalistId: 1))
            .ToArray();
        var diverseTail = Enumerable.Range(101, 300)
            .Select(index => Song(
                index,
                producerId: 1_000 + index,
                vocalistId: 2_000 + index % 30))
            .ToArray();

        Assert.True(MetadataRelationshipRanking.NeedsDiverseFallback(
            relevanceHead.Concat(diverseTail),
            relevanceHead));
    }

    [Fact]
    public void MmrRerank_CannotInventVocalistsMissingFromTheCandidatePool()
    {
        var candidates = Enumerable.Range(1, 20)
            .Select(index => (SongId: index, Score: 1.0 - index * 0.001))
            .ToList();
        var infos = candidates
            .Select(candidate => Song(
                candidate.SongId,
                producerId: 1_000 + candidate.SongId,
                vocalistId: 1))
            .ToArray();

        var selected = RecommendService.MmrRerank(
            candidates,
            infos,
            count: 20,
            lambda: 0.52,
            producerDiversityWeight: 0.90,
            vocalistDiversityWeight: 0.60);

        Assert.Equal(20, selected.Count);
        Assert.All(selected, item =>
            Assert.Contains(1, infos.Single(info => info.Id == item.SongId).VocalistIds));
    }

    [Fact]
    public void DiverseFallback_PromotesWeakExistingCandidatesWithoutLoweringStrongOnes()
    {
        var scores = new Dictionary<int, double>
        {
            [1] = 0.10,
            [2] = 0.90,
            [3] = 0.05,
        };

        RecommendService.MergeDiverseFallbackCandidates(
            scores,
            fallbackIds: [1, 2, 3, 4],
            excludedSongIds: new HashSet<int> { 3 },
            maximumScore: 1,
            fallbackScoreWeight: 0.58);

        Assert.Equal(0.58, scores[1], precision: 12);
        Assert.Equal(0.90, scores[2], precision: 12);
        Assert.Equal(0.05, scores[3], precision: 12);
        Assert.Equal(0.58 / Math.Pow(4, 0.15), scores[4], precision: 12);
    }

    [Fact]
    public void MmrRerank_WithDiverseFallbackPool_BoundsTwentyItemVocalistShare()
    {
        const int dominantCandidateCount = 240;
        const int fallbackCandidateCount = RecommendService.DiverseFallbackCandidateCount;
        var dominant = Enumerable.Range(1, dominantCandidateCount)
            .Select(index => (SongId: index, Score: 1.0 - index * 0.001))
            .ToArray();
        var fallback = Enumerable.Range(1, fallbackCandidateCount)
            .Select(index => (
                SongId: dominantCandidateCount + index,
                Score: 0.58 / Math.Pow(index, 0.15)))
            .ToArray();
        var candidates = dominant.Concat(fallback).ToList();
        var infos = dominant
            .Select(candidate => Song(
                candidate.SongId,
                producerId: 1_000 + candidate.SongId,
                vocalistId: 1))
            .Concat(fallback.Select((candidate, index) => Song(
                candidate.SongId,
                producerId: 10_000 + candidate.SongId,
                vocalistId: 2 + index)))
            .ToArray();

        var selected = RecommendService.MmrRerank(
            candidates,
            infos,
            count: 20,
            lambda: 0.52,
            producerDiversityWeight: 0.90,
            vocalistDiversityWeight: 0.60);
        var infoMap = infos.ToDictionary(info => info.Id);
        var dominantVocalistShare = selected.Count(item =>
            infoMap[item.SongId].VocalistIds.Contains(1)) / (double)selected.Count;

        Assert.Equal(20, selected.Count);
        Assert.True(
            dominantVocalistShare <= 0.85,
            $"Expected vocalist share <= 0.85, observed {dominantVocalistShare:F3}");
    }

    [Fact]
    public void MmrRerank_MatchesReferenceBitForBitAcrossRandomizedPools()
    {
        for (var scenario = 0; scenario < 24; scenario++)
        {
            var random = new Random(19_871 + scenario);
            var candidateCount = random.Next(5, 100);
            var infos = Enumerable.Range(1, candidateCount)
                .Where(_ => random.Next(6) != 0)
                .Select(id => RandomMmrSong(random, id))
                .ToArray();
            var scoreChoices = new[] { -0.5, 0.0, 0.2, 0.5, 0.8, 1.0, 1.5 };
            var candidates = Enumerable.Range(1, candidateCount)
                .Select(id => (
                    SongId: id,
                    Score: scoreChoices[random.Next(scoreChoices.Length)]))
                .ToList();
            candidates.Insert(random.Next(candidates.Count), candidates[random.Next(candidates.Count)]);
            var count = random.Next(0, Math.Min(30, candidateCount) + 1);
            var lambda = random.NextDouble();
            var producerWeight = random.NextDouble() * 1.8 - 0.4;
            var vocalistWeight = random.NextDouble() * 1.8 - 0.4;

            var expected = ReferenceMmrRerank(
                candidates,
                infos,
                count,
                lambda,
                producerWeight,
                vocalistWeight);
            var actual = RecommendService.MmrRerank(
                candidates,
                infos,
                count,
                lambda,
                producerWeight,
                vocalistWeight);

            Assert.Equal(expected.Count, actual.Count);
            for (var index = 0; index < expected.Count; index++)
            {
                Assert.Equal(expected[index].SongId, actual[index].SongId);
                Assert.Equal(expected[index].Reason, actual[index].Reason);
                Assert.Equal(
                    BitConverter.DoubleToInt64Bits(expected[index].Score),
                    BitConverter.DoubleToInt64Bits(actual[index].Score));
            }
        }
    }

    [Fact]
    public void MmrRerank_MatchesReferenceWithNaNAndPositiveInfinityScores()
    {
        var infos = Enumerable.Range(1, 5)
            .Select(index => Song(
                index,
                producerId: 1_000 + index % 2,
                vocalistId: 2_000 + index % 3))
            .ToArray();
        var pools = new[]
        {
            new List<(int SongId, double Score)>
            {
                (1, 1.0),
                (2, double.PositiveInfinity),
                (3, 0.5),
                (4, double.NaN),
                (5, double.NegativeInfinity),
            },
            new List<(int SongId, double Score)>
            {
                (1, double.NaN),
                (2, 0.5),
                (3, double.PositiveInfinity),
                (4, double.NegativeInfinity),
                (5, 1.0),
            },
        };

        foreach (var candidates in pools)
        {
            var expected = ReferenceMmrRerank(
                candidates,
                infos,
                count: candidates.Count,
                lambda: 0.52,
                producerDiversityWeight: 0.90,
                vocalistDiversityWeight: 0.60);
            var actual = RecommendService.MmrRerank(
                candidates,
                infos,
                count: candidates.Count,
                lambda: 0.52,
                producerDiversityWeight: 0.90,
                vocalistDiversityWeight: 0.60);

            Assert.Equal(expected.Count, actual.Count);
            for (var index = 0; index < expected.Count; index++)
            {
                Assert.Equal(expected[index].SongId, actual[index].SongId);
                Assert.Equal(expected[index].Reason, actual[index].Reason);
                Assert.Equal(
                    BitConverter.DoubleToInt64Bits(expected[index].Score),
                    BitConverter.DoubleToInt64Bits(actual[index].Score));
            }
        }
    }

    private static List<(int SongId, double Score, string Reason)> ReferenceMmrRerank(
        List<(int SongId, double Score)> candidates,
        SongInfo[] infos,
        int count,
        double lambda,
        double producerDiversityWeight,
        double vocalistDiversityWeight)
    {
        var infoMap = infos.ToDictionary(info => info.Id);
        var selected = new List<(int SongId, double Score, string Reason)>();
        var remaining = new List<(int SongId, double Score)>(candidates);
        var maximumRelevance = Math.Max(
            1e-9,
            remaining.Count == 0 ? 0 : remaining.Max(item => Math.Max(0, item.Score)));
        producerDiversityWeight = Math.Clamp(producerDiversityWeight, 0, 1);
        vocalistDiversityWeight = Math.Clamp(vocalistDiversityWeight, 0, 1);

        while (selected.Count < count && remaining.Count > 0)
        {
            (int SongId, double Score, string Reason) best = default;
            var bestMmr = double.NegativeInfinity;
            foreach (var (songId, relevance) in remaining)
            {
                var normalizedRelevance = Math.Clamp(relevance / maximumRelevance, 0, 1);
                var redundancy = 0.0;
                if (selected.Count > 0 && infoMap.TryGetValue(songId, out var info))
                {
                    var selectedInfos = selected
                        .Select(item => infoMap.GetValueOrDefault(item.SongId))
                        .Where(item => item is not null)
                        .Cast<SongInfo>()
                        .ToArray();
                    var producerRepeats = info.ProducerIds.Length == 0 ? 0 : info.ProducerIds
                        .Max(id => selectedInfos.Count(item => item.ProducerIds.Contains(id)));
                    var vocalistRepeats = info.VocalistIds.Length == 0 ? 0 : info.VocalistIds
                        .Max(id => selectedInfos.Count(item => item.VocalistIds.Contains(id)));
                    var producerRedundancy = 1.0 - Math.Exp(-0.9 * producerRepeats);
                    var vocalistRedundancy = 1.0 - Math.Exp(-0.55 * vocalistRepeats);
                    redundancy = Math.Min(
                        1.0,
                        producerDiversityWeight * producerRedundancy
                        + vocalistDiversityWeight * vocalistRedundancy);
                }

                var mmr = lambda * normalizedRelevance - (1.0 - lambda) * redundancy;
                if (!(mmr > bestMmr)) continue;
                bestMmr = mmr;
                best = (songId, mmr, ReferenceDetermineReason(songId, selected, infoMap));
            }

            if (best == default) break;
            selected.Add(best);
            remaining.RemoveAll(candidate => candidate.SongId == best.SongId);
        }

        return selected;
    }

    private static string ReferenceDetermineReason(
        int candidateId,
        List<(int SongId, double Score, string Reason)> selected,
        Dictionary<int, SongInfo> infoMap)
    {
        if (selected.Count == 0) return "similar";
        if (!infoMap.TryGetValue(candidateId, out var info)) return "similar";
        foreach (var (selectedId, _, _) in selected)
        {
            if (!infoMap.TryGetValue(selectedId, out var selectedInfo)) continue;
            if (info.ProducerIds.Intersect(selectedInfo.ProducerIds).Any())
                return "same_producer";
            if (info.VocalistIds.Intersect(selectedInfo.VocalistIds).Any())
                return "same_vocalist";
        }
        return "similar";
    }

    private static SongInfo RandomMmrSong(Random random, int id) => new(
        Id: id,
        Name: $"Song {id}",
        ArtistString: $"Artist {random.Next(20)}",
        LengthSeconds: 180,
        SongType: "Original",
        FavoritedTimes: 10,
        StateCluster: 1,
        ProducerIds: RandomRelationships(random, 15, 4),
        VocalistIds: RandomRelationships(random, 8, 3),
        YoutubeViews: 10_000,
        NicoViews: 0,
        PublishDate: new DateTime(2024, 1, 1),
        RelatedTagIds: [1, 2],
        AlbumIds: [],
        HasCoreVoiceSynthVocalist: true,
        HasPlayablePv: true,
        DiscoveryEligible: true,
        QualityScore: 1,
        HasAudioFeatures: true,
        HasOriginalPv: true);

    private static int[] RandomRelationships(
        Random random,
        int distinctDomain,
        int maximumLength) =>
        Enumerable.Range(0, random.Next(maximumLength + 1))
            .Select(_ => random.Next(1, distinctDomain + 1))
            .ToArray();

    private static SongInfo Song(int id, int producerId, int vocalistId) => new(
        Id: id,
        Name: $"Song {id}",
        ArtistString: $"Artist {producerId}",
        LengthSeconds: 180,
        SongType: "Original",
        FavoritedTimes: 10,
        StateCluster: 1,
        ProducerIds: [producerId],
        VocalistIds: [vocalistId],
        YoutubeViews: 10_000,
        NicoViews: 0,
        PublishDate: new DateTime(2024, 1, 1),
        RelatedTagIds: [1, 2],
        AlbumIds: [],
        HasCoreVoiceSynthVocalist: true,
        HasPlayablePv: true,
        DiscoveryEligible: true,
        QualityScore: 1,
        HasAudioFeatures: true,
        HasOriginalPv: true);
}
