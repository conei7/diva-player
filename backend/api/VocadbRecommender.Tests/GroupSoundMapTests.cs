using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.AspNetCore.Http;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class GroupSoundMapTests
{
    [Theory]
    [InlineData("1,2", null, null, null)]
    [InlineData("1,1,2", null, null, null)]
    [InlineData("1,2,0", null, null, null)]
    [InlineData("1,2,3.0", null, null, null)]
    [InlineData("1,2,3", .2, null, 1d)]
    [InlineData("1,2,3", double.NaN, 0d, 1d)]
    [InlineData("1,2,3", 0d, 0d, double.PositiveInfinity)]
    [InlineData("1,2,3", 0d, 0d, 257d)]
    public async Task InvalidQueriesAreRejectedBeforeAnyCatalogueOrDatabaseAccess(string ids, double? x, double? y, double? zoom)
    {
        var result = await GroupSoundMapEndpoints.GetAsync(ids, x, y, zoom, null,
            null!, null!, null!, new DefaultHttpContext().Response, CancellationToken.None);
        Assert.Equal(400, ((IStatusCodeHttpResult)result).StatusCode);
    }

    [Fact]
    public void SelectedPairMinimizesAllPairSquaredDistancesWithoutPairEnumeration()
    {
        var random = new Random(724);
        var seeds = Enumerable.Range(0, 7).Select(_ => Enumerable.Range(0, 1024).Select(_ => (float)random.NextDouble()).ToArray()).ToArray();
        var (x, y) = GroupSoundMapIndex.SelectAxes(seeds);
        double Cost(int d)
        {
            double cost = 0;
            for (var a = 0; a < seeds.Length; a++)
                for (var b = a + 1; b < seeds.Length; b++)
                    cost += Math.Pow((double)seeds[a][d] - seeds[b][d], 2);
            return cost;
        }
        var costs = Enumerable.Range(0, 1024).Select(Cost).ToArray();
        var minimum = double.PositiveInfinity;
        for (var a = 0; a < 1024; a++)
            for (var b = a + 1; b < 1024; b++) minimum = Math.Min(minimum, costs[a] + costs[b]);
        Assert.NotEqual(x, y);
        Assert.Equal(minimum, costs[x] + costs[y], 10);
    }

    [Fact]
    public void UniformDimensionsAndTiesAreRetainedRatherThanReplacingTheUsersCriterion()
    {
        var seeds = Enumerable.Range(1, 3).Select(i => Enumerable.Repeat((float)i, 1024).ToArray()).ToArray();
        foreach (var v in seeds) { v[17] = 0; v[822] = .25f; }
        Assert.Equal((17, 822), GroupSoundMapIndex.SelectAxes(seeds));
        Assert.Equal((0, 1), GroupSoundMapIndex.SelectAxes([new float[1024], new float[1024], new float[1024]]));
        seeds[0][100] = float.NaN;
        Assert.Throws<ArgumentException>(() => GroupSoundMapIndex.SelectAxes(seeds));
        Assert.Throws<ArgumentException>(() => GroupSoundMapIndex.SelectAxes([new float[1024], new float[1024]]));
    }

    [Fact]
    public void SamplingKeepsDistantSongsAndZoomCanRevealAnOmittedSong()
    {
        var points = Enumerable.Range(1, 10_000).Select(i => new GroupMapCoordinate(i,
            (i % 100) / 50d - 1, (i / 100) / 50d - 1, 0, 0)).ToArray();
        var sampled = GroupSoundMapEndpoints.Sample(points, 0, 0, 1.1).ToArray();
        Assert.InRange(sampled.Length, 300, 876);
        Assert.Contains(sampled, p => p.X < -.9 && p.Y < -.9);
        Assert.Contains(sampled, p => p.X > .8 && p.Y > .8);
        var omitted = points.First(p => !sampled.Any(s => s.SongId == p.SongId));
        var zoomed = points.Where(p => Math.Abs(p.X - omitted.X) < .02 && Math.Abs(p.Y - omitted.Y) < .02).ToArray();
        Assert.Contains(GroupSoundMapEndpoints.Sample(zoomed, omitted.X, omitted.Y, .02), p => p.SongId == omitted.SongId);
    }

    [Fact]
    public async Task CatalogueRequestsShareOneLoadAndCompletedData()
    {
        var completion = new TaskCompletionSource<IReadOnlyDictionary<int, Half[]>>(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var index = new GroupSoundMapIndex(_ => { calls++; return completion.Task; }, new Lifetime(), NullLogger<GroupSoundMapIndex>.Instance);
        for (var i = 0; i < 20; i++) Assert.Null(index.GetOrStart());
        Assert.Equal(1, calls);
        IReadOnlyDictionary<int, Half[]> catalogue = new Dictionary<int, Half[]> { [3] = [(Half).5] };
        completion.SetResult(catalogue);
        for (var i = 0; i < 100 && index.GetOrStart() is null; i++) await Task.Delay(5);
        Assert.Same(catalogue, index.GetOrStart());
        Assert.Equal(1, calls);
    }

    [Fact]
    public void FailedLoadsHaveACooldownInsteadOfStartingOneScanPerRequest()
    {
        var calls = 0;
        var index = new GroupSoundMapIndex(_ => { calls++; throw new InvalidOperationException("test"); }, new Lifetime(), NullLogger<GroupSoundMapIndex>.Instance);
        Assert.Null(index.GetOrStart());
        Assert.Throws<InvalidOperationException>(() => index.GetOrStart());
        Assert.Equal(1, calls);
    }

    private sealed class Lifetime : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => CancellationToken.None;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() { }
    }
}
