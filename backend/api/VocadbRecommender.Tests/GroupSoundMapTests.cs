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
    public async Task TwentySeedsAreSupportedAndTwentyOneAreRejectedBeforeIo()
    {
        var seeds = Enumerable.Range(0, 20).Select(_ => new float[1024]).ToArray();
        Assert.Equal((0, 1), GroupSoundMapIndex.SelectAxes(seeds));
        var result = await GroupSoundMapEndpoints.GetAsync(string.Join(',', Enumerable.Range(1, 21)), null, null, null, null,
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
        var completion = new TaskCompletionSource<GroupSoundMapCatalogue>(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        using var index = new GroupSoundMapIndex(_ => { calls++; return completion.Task; }, new Lifetime(), NullLogger<GroupSoundMapIndex>.Instance);
        for (var i = 0; i < 20; i++) Assert.Null(index.GetOrStart());
        Assert.Equal(1, calls);
        completion.SetResult(Catalogue(3));
        GroupSoundMapCatalogue.Lease? lease = null;
        for (var i = 0; i < 100 && lease is null; i++) { lease = index.GetOrStart(); if (lease is null) await Task.Delay(5); }
        using (lease) Assert.Equal(3, Assert.Single(lease!.ReadAxes(0, 1)).SongId);
        Assert.Equal(1, calls);
    }

    [Fact]
    public void FailedLoadsHaveACooldownInsteadOfStartingOneScanPerRequest()
    {
        var calls = 0;
        using var index = new GroupSoundMapIndex(_ => { calls++; throw new InvalidOperationException("test"); }, new Lifetime(), NullLogger<GroupSoundMapIndex>.Instance);
        Assert.Null(index.GetOrStart());
        Assert.Throws<InvalidOperationException>(() => index.GetOrStart());
        Assert.Equal(1, calls);
    }

    [Fact]
    public void RefreshServesOldDataAndActiveReadersSurviveSnapshotReplacement()
    {
        var clock = new Clock();
        var next = new TaskCompletionSource<GroupSoundMapCatalogue>();
        var calls = 0;
        using var index = new GroupSoundMapIndex(_ => ++calls == 1 ? Task.FromResult(Catalogue(3)) : next.Task,
            new Lifetime(), NullLogger<GroupSoundMapIndex>.Instance, clock);
        Assert.Null(index.GetOrStart());
        using var original = index.GetOrStart();
        clock.Now += TimeSpan.FromMinutes(31);
        using var refreshing = index.GetOrStart();
        Assert.Equal(3, Assert.Single(refreshing!.ReadAxes(0, 1)).SongId);
        next.SetResult(Catalogue(7));
        using var replaced = index.GetOrStart();
        Assert.Equal(7, Assert.Single(replaced!.ReadAxes(0, 1)).SongId);
        Assert.Equal(3, Assert.Single(original!.ReadAxes(0, 1)).SongId);
        Assert.Equal(2, calls);
    }

    [Fact]
    public void FailedRefreshKeepsLastGoodDataWithoutARescanStorm()
    {
        var clock = new Clock();
        var calls = 0;
        using var index = new GroupSoundMapIndex(_ => ++calls == 1 ? Task.FromResult(Catalogue(3)) : Task.FromException<GroupSoundMapCatalogue>(new IOException("test")),
            new Lifetime(), NullLogger<GroupSoundMapIndex>.Instance, clock);
        Assert.Null(index.GetOrStart());
        using var initial = index.GetOrStart();
        clock.Now += TimeSpan.FromMinutes(31);
        for (var i = 0; i < 10; i++)
        {
            using var lease = index.GetOrStart();
            Assert.Equal(3, Assert.Single(lease!.ReadAxes(0, 1)).SongId);
        }
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task DiskCatalogueReadsOnlyTwoColumnsWithinABoundedAllocation()
    {
        using var builder = new GroupSoundMapCatalogue.Builder(Path.GetTempPath());
        var vector = Enumerable.Range(0, 1024).Select(d => d / 1024f).ToArray();
        for (var start = 0; start < 10_000; start += 256)
            builder.Append(Enumerable.Range(start, Math.Min(256, 10_000-start)).Select(id => (id+1, vector)).ToArray());
        using var catalogue = builder.Complete();
        using var lease = catalogue.Acquire();
        _ = lease.ReadAxes(0, 1023);
        var before = GC.GetAllocatedBytesForCurrentThread();
        var points = lease.ReadAxes(17, 822);
        Assert.True(GC.GetAllocatedBytesForCurrentThread() - before < 1_000_000, "Two-column read must not reconstruct the full dense catalogue");
        Assert.Equal(10_000, points.Length);
        Assert.Equal(10_000, points[^1].SongId);
        Assert.All(points, p => {
            Assert.Equal((double)(Half)vector[17], p.RawX);
            Assert.Equal((double)(Half)vector[822], p.RawY);
        });
        await Task.WhenAll(Enumerable.Range(0, 4).Select(worker => Task.Run(() => {
            using var reader = catalogue.Acquire();
            var x = worker * 100; var y = x + 99;
            for (var repeat = 0; repeat < 10; repeat++)
            {
                var batch = reader.ReadAxes(x, y);
                Assert.Equal((double)(Half)vector[x], batch[^1].RawX);
                Assert.Equal((double)(Half)vector[y], batch[0].RawY);
            }
        })));
    }

    private static GroupSoundMapCatalogue Catalogue(int id)
    {
        using var builder = new GroupSoundMapCatalogue.Builder(Path.GetTempPath());
        builder.Append([(id, Enumerable.Repeat(.5f, 1024).ToArray())]);
        return builder.Complete();
    }

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class Lifetime : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => CancellationToken.None;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() { }
    }
}
