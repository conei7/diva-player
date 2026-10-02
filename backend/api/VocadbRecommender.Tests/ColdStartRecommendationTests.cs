using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class ColdStartRecommendationTests
{
    [Fact]
    public void PublishedVectorEvidence_PreservesScoresOrderAndCandidateList()
    {
        var candidates = new List<(int SongId, double Score)> { (3, 1.2), (2, 0.9) };
        var result = RecommendService.ApplyMetadataContextIfNoVectorEvidence(
            candidates, Song(1, 10), [Song(2, 10), Song(3, 20)], true);
        Assert.Same(candidates, result);
    }

    [Fact]
    public void MissingVectors_UsesSeedProducerInsteadOfGlobalFallbackRank()
    {
        var candidates = new List<(int SongId, double Score)> { (2, 1), (3, 0.01) };
        var infos = new[] { Song(2, 20), Song(3, 10) };
        var first = RecommendService.ApplyMetadataContextIfNoVectorEvidence(
            candidates, Song(1, 10), infos, false);
        var second = RecommendService.ApplyMetadataContextIfNoVectorEvidence(
            candidates, Song(1, 20), infos, false);
        Assert.Equal(3, first[0].SongId);
        Assert.Equal(2, second[0].SongId);
        Assert.Equal(new[] { 2, 3 }, first.Select(x => x.SongId).Order());
    }

    [Fact]
    public void SparseSeed_UsesKnownSongTypeDateAndPopularityWithoutInventingTags()
    {
        var seed = Song(1, 10) with { ProducerIds = [], SongType = "Cover", YoutubeViews = 135 };
        var related = Song(3, 30) with { SongType = "Cover", YoutubeViews = 150 };
        var unrelated = Song(2, 20) with { YoutubeViews = 10_000_000, PublishDate = new DateTime(2010, 1, 1) };
        var result = RecommendService.ApplyMetadataContextIfNoVectorEvidence(
            [(2, 1), (3, 0.01)], seed, [unrelated, related], false);
        Assert.Equal(3, result[0].SongId);
        Assert.All(result, item => Assert.InRange(item.Score, 0, 1));
    }

    [Fact]
    public void NoVectorScoring_LeavesEvidencePenaltyToHybridPipelineOnce()
    {
        var info = Song(2, 10) with { HasAudioFeatures = false, QualityScore = 0.5 };
        var raw = MetadataRelationshipRanking.ScoreWithoutVectorEvidence([(2, 1)], Song(1, 10), [info]);
        var penalized = RecommendationQuality.ApplyEvidencePenalty(raw, [info]);
        var metadata = MetadataRelationshipRanking.RerankRelated([(2, -1)], Song(1, 10), [info], 1);
        Assert.Equal(metadata[0].Score, penalized[0].Score);
        Assert.True(raw[0].Score > penalized[0].Score);
    }

    [Fact]
    public void MissingHydrationIsOmitted_AndEqualContextsHaveStableIdOrder()
    {
        var result = MetadataRelationshipRanking.ScoreWithoutVectorEvidence(
            [(99, 1), (3, 1), (2, 0.01)], Song(1, 10), [Song(2, 20), Song(3, 20)]);
        Assert.Equal(new[] { 2, 3 }, result.Select(item => item.SongId));
    }

    private static SongInfo Song(int id, int producer) => new(
        Id: id, Name: $"Song {id}", ArtistString: $"Artist {producer}",
        LengthSeconds: 180, SongType: "Original", FavoritedTimes: 10,
        StateCluster: -1, ProducerIds: [producer], VocalistIds: [100],
        YoutubeViews: 10_000, NicoViews: 0, PublishDate: new DateTime(2026, 10, 1),
        RelatedTagIds: [], AlbumIds: [], HasCoreVoiceSynthVocalist: true,
        HasPlayablePv: true, DiscoveryEligible: true, QualityScore: 1,
        HasAudioFeatures: false, HasOriginalPv: true);
}
