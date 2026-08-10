using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using System.Text.Json;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class RecommendationPublicationGuardTests
{
    [Fact]
    public async Task ConcurrentLeases_ShareOneSession_AndReleaseItOnlyAfterLastReader()
    {
        var session = FakeSession.Ready("basis-a:build-a");
        var openCount = 0;
        var observed = new List<string>();
        await using var guard = CreateGuard(
            _ =>
            {
                Interlocked.Increment(ref openCount);
                return Task.FromResult<IRecommendationPublicationSession>(session);
            },
            (generation, _) =>
            {
                lock (observed)
                    observed.Add(generation);
                return Task.CompletedTask;
            });

        var firstTask = guard.TryEnterAsync(CancellationToken.None);
        var secondTask = guard.TryEnterAsync(CancellationToken.None);
        var leases = await Task.WhenAll(firstTask, secondTask);
        var first = Assert.IsType<RecommendationPublicationLease>(leases[0]);
        var second = Assert.IsType<RecommendationPublicationLease>(leases[1]);

        Assert.Equal(1, Volatile.Read(ref openCount));
        Assert.Equal(2, session.ReadCount);
        Assert.Equal(["basis-a:build-a", "basis-a:build-a"], observed);
        Assert.Equal(0, session.DisposeCount);

        await first.DisposeAsync();
        Assert.Equal(0, session.DisposeCount);

        await second.DisposeAsync();
        Assert.Equal(1, session.DisposeCount);
    }

    [Fact]
    public async Task GatePresent_ReturnsNullAndDisposesSessionImmediately()
    {
        var session = FakeSession.FromSnapshot(
            new RecommendationPublicationSnapshot(true, "basis-a:build-a"));
        var observed = 0;
        await using var guard = CreateGuard(
            _ => Task.FromResult<IRecommendationPublicationSession>(session),
            (_, _) =>
            {
                Interlocked.Increment(ref observed);
                return Task.CompletedTask;
            });

        var lease = await guard.TryEnterAsync(CancellationToken.None);

        Assert.Null(lease);
        Assert.Equal(1, session.ReadCount);
        Assert.Equal(1, session.DisposeCount);
        Assert.Equal(0, Volatile.Read(ref observed));
    }

    [Fact]
    public async Task CanceledWaiter_DoesNotReleaseLeaderSessionOrBreakLaterAcquisition()
    {
        var readStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var allowFirstRead = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var readNumber = 0;
        var session = new FakeSession(async cancellationToken =>
        {
            if (Interlocked.Increment(ref readNumber) == 1)
            {
                readStarted.TrySetResult();
                await allowFirstRead.Task.WaitAsync(cancellationToken);
            }

            return new RecommendationPublicationSnapshot(false, "basis-a:build-a");
        });
        await using var guard = CreateGuard(
            _ => Task.FromResult<IRecommendationPublicationSession>(session));

        var leaderTask = guard.TryEnterAsync(CancellationToken.None);
        await readStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        using var canceled = new CancellationTokenSource();
        var waiterTask = guard.TryEnterAsync(canceled.Token);
        canceled.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiterTask);
        Assert.Equal(0, session.DisposeCount);

        allowFirstRead.TrySetResult();
        var leader = Assert.IsType<RecommendationPublicationLease>(
            await leaderTask.WaitAsync(TimeSpan.FromSeconds(2)));
        var follower = Assert.IsType<RecommendationPublicationLease>(
            await guard.TryEnterAsync(CancellationToken.None));

        Assert.Equal(2, session.ReadCount);
        Assert.Equal(0, session.DisposeCount);
        await follower.DisposeAsync();
        Assert.Equal(0, session.DisposeCount);
        await leader.DisposeAsync();
        Assert.Equal(1, session.DisposeCount);
    }

    [Fact]
    public async Task CancellationDuringSnapshot_DisposesSessionAndNextAcquireUsesFreshSession()
    {
        var readStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var canceledSession = new FakeSession(async cancellationToken =>
        {
            readStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return new RecommendationPublicationSnapshot(false, "unreachable");
        });
        var readySession = FakeSession.Ready("basis-b:build-b");
        var openCount = 0;
        await using var guard = CreateGuard(_ =>
        {
            var call = Interlocked.Increment(ref openCount);
            return Task.FromResult<IRecommendationPublicationSession>(
                call == 1 ? canceledSession : readySession);
        });
        using var canceled = new CancellationTokenSource();

        var acquire = guard.TryEnterAsync(canceled.Token);
        await readStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        canceled.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => acquire);
        Assert.Equal(1, canceledSession.DisposeCount);

        var lease = Assert.IsType<RecommendationPublicationLease>(
            await guard.TryEnterAsync(CancellationToken.None));
        Assert.Equal(2, Volatile.Read(ref openCount));
        Assert.Equal(1, readySession.ReadCount);
        await lease.DisposeAsync();
        Assert.Equal(1, readySession.DisposeCount);
    }

    [Fact]
    public async Task GuardedMiddleware_WhenGatePresent_Returns503WithoutCallingNext()
    {
        var session = FakeSession.FromSnapshot(
            new RecommendationPublicationSnapshot(true, "basis-a:build-a"));
        await using var guard = CreateGuard(
            _ => Task.FromResult<IRecommendationPublicationSession>(session));
        var nextCalls = 0;
        var middleware = CreateMiddleware(_ =>
        {
            Interlocked.Increment(ref nextCalls);
            return Task.CompletedTask;
        });
        using var services = CreateRequestServices();
        var context = CreateHttpContext("/api/recommend/123", services);

        await middleware.InvokeAsync(context, guard);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
        Assert.Equal("5", context.Response.Headers.RetryAfter);
        Assert.Equal(0, Volatile.Read(ref nextCalls));
        Assert.Equal(1, session.DisposeCount);
        context.Response.Body.Position = 0;
        using var payload = await JsonDocument.ParseAsync(context.Response.Body);
        Assert.Equal(
            "recommendation_publication_in_progress",
            payload.RootElement.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task GuardedMiddleware_DownstreamExceptionPropagatesUnchangedAndReleasesLease()
    {
        var session = FakeSession.Ready("basis-a:build-a");
        await using var guard = CreateGuard(
            _ => Task.FromResult<IRecommendationPublicationSession>(session));
        var expected = new DownstreamTestException("endpoint failed");
        var middleware = CreateMiddleware(_ => Task.FromException(expected));
        using var services = CreateRequestServices();
        var context = CreateHttpContext("/api/recommend/dig", services);

        var actual = await Assert.ThrowsAsync<DownstreamTestException>(
            () => middleware.InvokeAsync(context, guard));

        Assert.Same(expected, actual);
        Assert.Equal(1, session.DisposeCount);
    }

    [Fact]
    public async Task GuardedMiddleware_UnlockFailureDoesNotMaskDownstreamException()
    {
        var session = new FakeSession(
            _ => Task.FromResult(
                new RecommendationPublicationSnapshot(false, "basis-a:build-a")),
            () => ValueTask.FromException(
                new InvalidOperationException("explicit advisory unlock failed")));
        await using var guard = CreateGuard(
            _ => Task.FromResult<IRecommendationPublicationSession>(session));
        var expected = new DownstreamTestException("endpoint failed");
        var middleware = CreateMiddleware(_ => Task.FromException(expected));
        using var services = CreateRequestServices();
        var context = CreateHttpContext("/api/recommend/123", services);

        var actual = await Assert.ThrowsAsync<DownstreamTestException>(
            () => middleware.InvokeAsync(context, guard));

        Assert.Same(expected, actual);
        Assert.Equal(1, session.DisposeCount);
    }

    [Fact]
    public async Task NonGuardedMiddleware_BypassesGuard()
    {
        var openCount = 0;
        await using var guard = CreateGuard(_ =>
        {
            Interlocked.Increment(ref openCount);
            throw new InvalidOperationException("guard must not be opened");
        });
        var nextCalls = 0;
        var middleware = CreateMiddleware(_ =>
        {
            Interlocked.Increment(ref nextCalls);
            return Task.CompletedTask;
        });
        using var services = CreateRequestServices();
        var context = CreateHttpContext("/api/health", services);

        await middleware.InvokeAsync(context, guard);

        Assert.Equal(1, Volatile.Read(ref nextCalls));
        Assert.Equal(0, Volatile.Read(ref openCount));
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
    }

    [Theory]
    [InlineData("/api/recommend", true)]
    [InlineData("/api/recommend/42", true)]
    [InlineData("/api/recommend/dig/", true)]
    [InlineData("/API/RECOMMEND/42", true)]
    [InlineData("/api/discovery/dig", false)]
    [InlineData("/api/recommendation", false)]
    [InlineData("/api/recommendations/42", false)]
    [InlineData("/api/discovery/digger", false)]
    [InlineData("/api/discovery", false)]
    [InlineData("/api/health", false)]
    public void GuardedPathCoverage_MatchesOnlyRecommendationFamilyAndDiscoveryDig(
        string path,
        bool expected)
    {
        Assert.Equal(
            expected,
            RecommendationPublicationMiddleware.IsGuardedPath(new PathString(path)));
    }

    private static RecommendationPublicationGuard CreateGuard(
        Func<CancellationToken, Task<IRecommendationPublicationSession>> openSession,
        Func<string, CancellationToken, Task>? observeGeneration = null) =>
        new(
            openSession,
            observeGeneration ?? ((_, _) => Task.CompletedTask));

    private static RecommendationPublicationMiddleware CreateMiddleware(
        RequestDelegate next) =>
        new(next, NullLogger<RecommendationPublicationMiddleware>.Instance);

    private static ServiceProvider CreateRequestServices() =>
        new ServiceCollection()
            .AddLogging()
            .AddOptions()
            .BuildServiceProvider();

    private static DefaultHttpContext CreateHttpContext(
        string path,
        IServiceProvider requestServices)
    {
        var context = new DefaultHttpContext
        {
            RequestServices = requestServices
        };
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private sealed class FakeSession(
        Func<CancellationToken, Task<RecommendationPublicationSnapshot>> readSnapshot,
        Func<ValueTask>? dispose = null)
        : IRecommendationPublicationSession
    {
        private int _readCount;
        private int _disposeCount;

        public int ReadCount => Volatile.Read(ref _readCount);
        public int DisposeCount => Volatile.Read(ref _disposeCount);

        public static FakeSession Ready(string generation) =>
            FromSnapshot(new RecommendationPublicationSnapshot(false, generation));

        public static FakeSession FromSnapshot(
            RecommendationPublicationSnapshot snapshot) =>
            new(_ => Task.FromResult(snapshot));

        public async Task<RecommendationPublicationSnapshot> ReadSnapshotAsync(
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _readCount);
            return await readSnapshot(cancellationToken);
        }

        public ValueTask DisposeAsync()
        {
            Interlocked.Increment(ref _disposeCount);
            return dispose?.Invoke() ?? ValueTask.CompletedTask;
        }
    }

    private sealed class DownstreamTestException(string message) : Exception(message);
}
