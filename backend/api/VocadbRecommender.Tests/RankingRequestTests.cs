using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class RankingRequestTests
{
    [Fact]
    public void Create_PreservesExistingNormalizationAndCacheIdentity()
    {
        var first = RankingRequest.Create(
            days: 999,
            start: -3,
            maxResults: 999,
            mode: "popular",
            ranking: "LEGACY",
            seed: 999,
            debug: true,
            minYoutubeViews: 0,
            minNicoViews: null,
            excludedSongTypes: ["Other", "Cover", "Other"]);
        var second = RankingRequest.Create(
            days: 1,
            start: 0,
            maxResults: 100,
            mode: "pace",
            ranking: null,
            seed: 0,
            debug: false,
            minYoutubeViews: null,
            minNicoViews: 0,
            excludedSongTypes: ["Cover", "Other"]);

        Assert.Equal(first.CacheKey, second.CacheKey);
        Assert.Equal("pace", first.Mode);
        Assert.Equal("quality", first.Ranking);
        Assert.Equal(0, first.Seed);
        Assert.False(first.Debug);
        Assert.Equal(["Cover", "Other"], first.ExcludedSongTypes);
    }

    [Fact]
    public void Create_KeepsInputsThatRemainPartOfExistingRankingKey()
    {
        Assert.Equal(
            Create(mode: "alltime", seed: 1).CacheKey,
            Create(mode: "alltime", seed: 2).CacheKey);
        Assert.NotEqual(
            Create(mode: "deep", seed: 1).CacheKey,
            Create(mode: "deep", seed: 2).CacheKey);
        Assert.NotEqual(
            Create(mode: "surge", debug: false).CacheKey,
            Create(mode: "surge", debug: true).CacheKey);
        Assert.NotEqual(
            Create(minYoutubeViews: null).CacheKey,
            Create(minYoutubeViews: 1).CacheKey);
        Assert.Equal("pace", Create(mode: "unknown").Mode);
        Assert.Equal("pace", Create(mode: "ALLTIME").Mode);
        Assert.Equal(
            Create(mode: "pace").CacheKey,
            Create(mode: null).CacheKey);
        Assert.Equal("legacy", Create(mode: "surge", ranking: "legacy").Ranking);
        Assert.Equal("quality", Create(mode: "surge", ranking: "LEGACY").Ranking);
        Assert.Equal(7, Create(mode: "surge").Days);
        Assert.Equal(
            Create(mode: "surge").CacheKey,
            RankingRequest.Create(365, 0, 24, "surge", null, 0, false, null, null, null).CacheKey);
    }

    private static RankingRequest Create(
        string? mode = null,
        string? ranking = null,
        int seed = 0,
        bool debug = false,
        long? minYoutubeViews = null)
        => RankingRequest.Create(
            days: 30,
            start: 0,
            maxResults: 24,
            mode,
            ranking,
            seed,
            debug,
            minYoutubeViews,
            minNicoViews: null,
            excludedSongTypes: null);
}
