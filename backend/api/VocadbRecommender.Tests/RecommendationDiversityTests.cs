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
