using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using System.Text.Json;

namespace VocadbRecommender.Tests;

public sealed class ApiBulkheadMiddlewareTests
{
    [Theory]
    [InlineData("/api/ready", "Bypass")]
    [InlineData("/api/health", "Bypass")]
    [InlineData("/api/recommend", "Heavy")]
    [InlineData("/api/recommend/audio", "Heavy")]
    [InlineData("/api/songs/search", "Heavy")]
    [InlineData("/api/discovery/knowledge-map", "Heavy")]
    [InlineData("/api/youtube/playlists/abc/songs", "Provider")]
    [InlineData("/api/nico/playlists/series/1/songs", "Provider")]
    [InlineData("/api/songs/batch", "Standard")]
    public void Classify_UsesBoundedLanes(string path, string expected)
    {
        Assert.Equal(expected, ApiBulkheadMiddleware.Classify(path).ToString());
    }

    [Fact]
    public void Options_UseMeasuredDefaultsAndRejectUnsafeValues()
    {
        var defaults = ApiBulkheadOptions.FromConfiguration(new ConfigurationBuilder().Build());
        Assert.Equal(12, defaults.HeavyPermitLimit);
        Assert.Equal(12, defaults.HeavyQueueLimit);
        Assert.Equal(2_000, defaults.QueueTimeoutMilliseconds);

        var invalid = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Recommender:Bulkhead:HeavyPermitLimit"] = "0",
            })
            .Build();
        Assert.Throws<InvalidOperationException>(() => ApiBulkheadOptions.FromConfiguration(invalid));
    }

    [Fact]
    public async Task CapacityExhaustion_ReturnsBounded503WithoutStartingMoreWork()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var middleware = CreateMiddleware(
            async _ =>
            {
                Interlocked.Increment(ref calls);
                entered.TrySetResult();
                await release.Task;
            },
            permitLimit: 1,
            queueLimit: 0,
            timeoutMilliseconds: 100);

        var first = CreateContext("/api/recommend");
        var firstTask = middleware.InvokeAsync(first);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var rejected = CreateContext("/api/recommend/metadata");
        await middleware.InvokeAsync(rejected);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, rejected.Response.StatusCode);
        Assert.Equal("1", rejected.Response.Headers.RetryAfter);
        Assert.Equal("concurrency;heavy", rejected.Response.Headers["X-Diva-Rate-Limit"]);
        Assert.Equal(1, Volatile.Read(ref calls));
        rejected.Response.Body.Position = 0;
        using (var document = await JsonDocument.ParseAsync(rejected.Response.Body))
        {
            Assert.Equal("server_busy", document.RootElement.GetProperty("error").GetString());
        }

        release.TrySetResult();
        await firstTask;
    }

    [Fact]
    public async Task QueueTimeout_ReleasesAdmissionForTheNextRequest()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var middleware = CreateMiddleware(
            async _ =>
            {
                var call = Interlocked.Increment(ref calls);
                if (call == 1)
                {
                    entered.TrySetResult();
                    await release.Task;
                }
            },
            permitLimit: 1,
            queueLimit: 1,
            timeoutMilliseconds: 100);

        var firstTask = middleware.InvokeAsync(CreateContext("/api/recommend"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var timedOut = CreateContext("/api/recommend");
        await middleware.InvokeAsync(timedOut);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, timedOut.Response.StatusCode);
        Assert.Equal(1, Volatile.Read(ref calls));

        release.TrySetResult();
        await firstTask;
        var next = CreateContext("/api/recommend");
        await middleware.InvokeAsync(next);
        Assert.Equal(StatusCodes.Status200OK, next.Response.StatusCode);
        Assert.Equal(2, Volatile.Read(ref calls));
    }

    [Fact]
    public async Task ReadinessBypassesAnExhaustedHeavyLane()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var middleware = CreateMiddleware(
            async context =>
            {
                if (context.Request.Path == "/api/recommend")
                {
                    entered.TrySetResult();
                    await release.Task;
                }
            },
            permitLimit: 1,
            queueLimit: 0,
            timeoutMilliseconds: 100);

        var heavyTask = middleware.InvokeAsync(CreateContext("/api/recommend"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var ready = CreateContext("/api/ready");
        await middleware.InvokeAsync(ready);
        Assert.Equal(StatusCodes.Status200OK, ready.Response.StatusCode);

        release.TrySetResult();
        await heavyTask;
    }

    private static ApiBulkheadMiddleware CreateMiddleware(
        RequestDelegate next,
        int permitLimit,
        int queueLimit,
        int timeoutMilliseconds)
    {
        var options = new ApiBulkheadOptions(
            permitLimit,
            queueLimit,
            permitLimit,
            queueLimit,
            permitLimit,
            queueLimit,
            timeoutMilliseconds);
        return new ApiBulkheadMiddleware(
            next,
            options,
            NullLogger<ApiBulkheadMiddleware>.Instance);
    }

    private static DefaultHttpContext CreateContext(string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        return context;
    }
}
