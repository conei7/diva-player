using Microsoft.Extensions.Logging.Abstractions;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class RecommendationResultCacheTests
{
    [Fact]
    public async Task GetOrCreateAsync_SharesOneComputationAndThenServesTheCachedValue()
    {
        var results = CreateResults();
        var calls = 0;
        var release = new TaskCompletionSource();
        async Task<int[]> Compute(CancellationToken _)
        {
            Interlocked.Increment(ref calls);
            await release.Task;
            return [1, 2, 3];
        }

        var first = results.GetOrCreateAsync("k", Compute, _ => TimeSpan.FromMinutes(1), _ => 64, CancellationToken.None);
        var second = results.GetOrCreateAsync("k", Compute, _ => TimeSpan.FromMinutes(1), _ => 64, CancellationToken.None);
        release.SetResult();

        var firstValue = (await first).Value;
        var secondValue = (await second).Value;
        Assert.Equal(new[] { 1, 2, 3 }, firstValue);
        Assert.Same(firstValue, secondValue);
        var third = await results.GetOrCreateAsync("k", Compute, _ => TimeSpan.FromMinutes(1), _ => 64, CancellationToken.None);
        Assert.True(third.Hit);
        Assert.Equal(1, calls);
    }

    [Fact]
    public void RecentSeeds_ListsNewestFirstAndStaysBounded()
    {
        var results = CreateResults();
        for (var id = 1; id <= RecommendationResultCache.MaxTrackedSeeds * 2 + 1; id++)
        {
            results.NoteSeed(id);
        }
        results.NoteSeed(5);

        var recent = results.RecentSeeds(RecommendationResultCache.MaxTrackedSeeds * 4);
        Assert.Equal(5, recent[0]);
        Assert.True(recent.Count <= RecommendationResultCache.MaxTrackedSeeds + 1);
        Assert.Contains(RecommendationResultCache.MaxTrackedSeeds * 2 + 1, recent);
        Assert.DoesNotContain(1, recent);
    }

    [Fact]
    public async Task GetOrCreateAsync_FollowerRecomputesWhenTheFirstCallerDisconnects()
    {
        var results = CreateResults();
        var calls = 0;
        var firstStarted = new TaskCompletionSource();
        using var firstCaller = new CancellationTokenSource();
        async Task<int[]> Compute(CancellationToken token)
        {
            if (Interlocked.Increment(ref calls) == 1)
            {
                firstStarted.SetResult();
                await Task.Delay(Timeout.Infinite, token);
            }
            return [7];
        }

        var first = results.GetOrCreateAsync("k", Compute, _ => TimeSpan.FromMinutes(1), _ => 64, firstCaller.Token);
        await firstStarted.Task;
        var follower = results.GetOrCreateAsync("k", Compute, _ => TimeSpan.FromMinutes(1), _ => 64, CancellationToken.None);
        firstCaller.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        var followerValue = (await follower).Value;
        Assert.Equal(new[] { 7 }, followerValue);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task GetOrCreateAsync_DoesNotCacheFailures()
    {
        var results = CreateResults();
        var calls = 0;
        Task<int[]> Compute(CancellationToken _) =>
            Interlocked.Increment(ref calls) == 1
                ? Task.FromException<int[]>(new InvalidOperationException("down"))
                : Task.FromResult(new[] { 9 });

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            results.GetOrCreateAsync("k", Compute, _ => TimeSpan.FromMinutes(1), _ => 64, CancellationToken.None));
        var retried = await results.GetOrCreateAsync("k", Compute, _ => TimeSpan.FromMinutes(1), _ => 64, CancellationToken.None);

        Assert.False(retried.Hit);
        Assert.Equal(new[] { 9 }, retried.Value);
    }

    [Fact]
    public void MmrRerank_ShorterRankingIsAPrefixOfTheFullWindow()
    {
        // The API computes one 500-item ranking per seed and slices pages from it.
        // That is only equivalent if MMR selection is greedy and prefix-stable.
        var candidates = Enumerable.Range(1, 300)
            .Select(index => (SongId: index, Score: 1.0 / Math.Sqrt(index)))
            .ToList();
        var infos = candidates
            .Select(candidate => Song(candidate.SongId, producerId: candidate.SongId % 17, vocalistId: candidate.SongId % 5))
            .ToArray();

        var full = RecommendService.MmrRerank(candidates, infos, RecommendationWindow.MaxItems, 0.6, 0.9, 0.6);
        foreach (var count in new[] { 1, 24, 60, 96 })
        {
            var page = RecommendService.MmrRerank(candidates, infos, count, 0.6, 0.9, 0.6);
            Assert.Equal(full.Take(count), page);
        }
    }

    private static RecommendationResultCache CreateResults() => new(
        new RecommendationObjectCache(1024 * 1024, 256 * 1024, NullLogger<RecommendationObjectCache>.Instance));

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
