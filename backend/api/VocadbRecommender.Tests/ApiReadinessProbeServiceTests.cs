using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using System.Text.Json;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class ApiReadinessProbeServiceTests
{
    [Fact]
    public void InitialSnapshot_IsUnknownAndReadinessIs503AfterWarmup()
    {
        var state = new ApiReadinessProbeState();

        var snapshot = state.Snapshot;
        var response = HealthEndpoints.CreateReadinessResponse(
            new ApiWarmupSnapshot(true, 15, []),
            snapshot,
            DateTimeOffset.UtcNow,
            ApiReadinessProbeService.MaximumSnapshotAge);

        Assert.False(snapshot.Known);
        Assert.False(snapshot.Postgres.Ok);
        Assert.Equal("Unknown", snapshot.Postgres.Error);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, response.StatusCode);
        var payload = Assert.IsType<ReadinessPayload>(response.Payload);
        Assert.Equal("degraded", payload.Status);
        Assert.Equal("Unknown", payload.Dependencies.Qdrant.Error);
    }

    [Fact]
    public void IncompleteWarmup_PreservesWarmingPayloadContract()
    {
        var response = HealthEndpoints.CreateReadinessResponse(
            new ApiWarmupSnapshot(false, 0, []),
            new ApiReadinessProbeState().Snapshot,
            DateTimeOffset.UtcNow,
            ApiReadinessProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, response.StatusCode);
        var payload = Assert.IsType<WarmingReadinessPayload>(response.Payload);
        Assert.Equal("warming", payload.Status);
        Assert.False(payload.Warmup.Completed);
    }

    [Fact]
    public void WarmupFailure_RemainsDegradedEvenWhenDependenciesAreHealthy()
    {
        var response = HealthEndpoints.CreateReadinessResponse(
            new ApiWarmupSnapshot(true, 42, ["home-popular:InvalidOperationException"]),
            new ApiReadinessProbeSnapshot(
                true,
                new DependencyHealth(true, 1),
                new DependencyHealth(true, 2),
                DateTimeOffset.UtcNow),
            DateTimeOffset.UtcNow,
            ApiReadinessProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, response.StatusCode);
        var payload = Assert.IsType<ReadinessPayload>(response.Payload);
        Assert.Equal("degraded", payload.Status);
        Assert.Single(payload.Warmup.Failures);
    }

    [Fact]
    public void HealthySnapshotAndWarmup_ReturnReadyWithCompatibleDependencies()
    {
        var now = new DateTimeOffset(2026, 8, 10, 12, 0, 0, TimeSpan.Zero);
        var postgres = new DependencyHealth(true, 3);
        var qdrant = new DependencyHealth(true, 4);
        var response = HealthEndpoints.CreateReadinessResponse(
            new ApiWarmupSnapshot(true, 20, []),
            new ApiReadinessProbeSnapshot(true, postgres, qdrant, now),
            now,
            ApiReadinessProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status200OK, response.StatusCode);
        var payload = Assert.IsType<ReadinessPayload>(response.Payload);
        Assert.Equal("ready", payload.Status);
        Assert.Same(postgres, payload.Dependencies.Postgres);
        Assert.Same(qdrant, payload.Dependencies.Qdrant);
    }

    [Fact]
    public void ReadyPayload_DoesNotExposeSnapshotMetadataOrChangeJsonShape()
    {
        var now = new DateTimeOffset(2026, 8, 10, 12, 0, 0, TimeSpan.Zero);
        var response = HealthEndpoints.CreateReadinessResponse(
            new ApiWarmupSnapshot(true, 20, []),
            new ApiReadinessProbeSnapshot(
                true,
                new DependencyHealth(true, 3),
                new DependencyHealth(true, 4),
                now),
            now,
            ApiReadinessProbeService.MaximumSnapshotAge);

        var json = JsonSerializer.Serialize(
            response.Payload,
            response.Payload.GetType(),
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        using var document = JsonDocument.Parse(json);
        var rootNames = document.RootElement.EnumerateObject()
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var dependencyNames = document.RootElement.GetProperty("dependencies")
            .EnumerateObject()
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(["dependencies", "status", "warmup"], rootNames);
        Assert.Equal(["postgres", "qdrant"], dependencyNames);
        Assert.DoesNotContain("known", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("checkedAt", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void SnapshotAge_ChangesReadyToDegradedWithoutChangingPayloadShape()
    {
        var time = new MutableTimeProvider(
            new DateTimeOffset(2026, 8, 10, 12, 0, 0, TimeSpan.Zero));
        var snapshot = new ApiReadinessProbeSnapshot(
            true,
            new DependencyHealth(true, 1),
            new DependencyHealth(true, 2),
            time.GetUtcNow());
        var warmup = new ApiWarmupSnapshot(true, 10, []);

        var fresh = HealthEndpoints.CreateReadinessResponse(
            warmup,
            snapshot,
            time.GetUtcNow(),
            ApiReadinessProbeService.MaximumSnapshotAge);
        time.Advance(ApiReadinessProbeService.MaximumSnapshotAge + TimeSpan.FromTicks(1));
        var stale = HealthEndpoints.CreateReadinessResponse(
            warmup,
            snapshot,
            time.GetUtcNow(),
            ApiReadinessProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status200OK, fresh.StatusCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, stale.StatusCode);
        Assert.IsType<ReadinessPayload>(fresh.Payload);
        var stalePayload = Assert.IsType<ReadinessPayload>(stale.Payload);
        Assert.Equal("degraded", stalePayload.Status);
        Assert.True(stalePayload.Dependencies.Postgres.Ok);
    }

    [Fact]
    public void KnownSnapshotWithoutTimestamp_IsDegraded()
    {
        var now = new DateTimeOffset(2026, 8, 10, 12, 0, 0, TimeSpan.Zero);
        var response = HealthEndpoints.CreateReadinessResponse(
            new ApiWarmupSnapshot(true, 10, []),
            new ApiReadinessProbeSnapshot(
                true,
                new DependencyHealth(true, 1),
                new DependencyHealth(true, 1),
                null),
            now,
            ApiReadinessProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, response.StatusCode);
        Assert.Equal("degraded", Assert.IsType<ReadinessPayload>(response.Payload).Status);
    }

    [Fact]
    public void SnapshotFromTheFuture_IsDegraded()
    {
        var now = new DateTimeOffset(2026, 8, 10, 12, 0, 0, TimeSpan.Zero);
        var response = HealthEndpoints.CreateReadinessResponse(
            new ApiWarmupSnapshot(true, 10, []),
            new ApiReadinessProbeSnapshot(
                true,
                new DependencyHealth(true, 1),
                new DependencyHealth(true, 1),
                now.AddTicks(1)),
            now,
            ApiReadinessProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, response.StatusCode);
        Assert.Equal("degraded", Assert.IsType<ReadinessPayload>(response.Payload).Status);
    }

    [Fact]
    public async Task ProbeOnce_RunsDependenciesConcurrentlyAndPublishesOneSnapshot()
    {
        var state = new ApiReadinessProbeState();
        var postgresStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var qdrantStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var service = CreateService(
            async token =>
            {
                postgresStarted.SetResult();
                await release.Task.WaitAsync(token);
                return new DependencyHealth(true, 7);
            },
            async token =>
            {
                qdrantStarted.SetResult();
                await release.Task.WaitAsync(token);
                return new DependencyHealth(true, 9);
            },
            state);

        var probe = service.ProbeOnceAsync();
        await Task.WhenAll(postgresStarted.Task, qdrantStarted.Task).WaitAsync(TimeSpan.FromSeconds(2));
        release.SetResult();

        Assert.True(await probe);
        Assert.True(state.Snapshot.Known);
        Assert.Equal(7, state.Snapshot.Postgres.LatencyMs);
        Assert.Equal(9, state.Snapshot.Qdrant.LatencyMs);
        Assert.NotNull(state.Snapshot.CheckedAt);
    }

    [Fact]
    public async Task ConcurrentProbe_IsRejectedInsteadOfOverlapping()
    {
        var state = new ApiReadinessProbeState();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        async Task<DependencyHealth> Probe(CancellationToken token)
        {
            Interlocked.Increment(ref calls);
            started.TrySetResult();
            await release.Task.WaitAsync(token);
            return new DependencyHealth(true, 1);
        }
        var service = CreateService(Probe, Probe, state);

        var leader = service.ProbeOnceAsync();
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var follower = await service.ProbeOnceAsync();
        release.SetResult();

        Assert.False(follower);
        Assert.True(await leader);
        Assert.Equal(2, Volatile.Read(ref calls));
    }

    [Fact]
    public async Task ExplicitTimeout_PublishesDegradedSnapshot()
    {
        var state = new ApiReadinessProbeState();
        static async Task<DependencyHealth> Never(CancellationToken token)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            return new DependencyHealth(true, 0);
        }
        var service = CreateService(Never, Never, state, TimeSpan.FromMilliseconds(50));

        Assert.True(await service.ProbeOnceAsync().WaitAsync(TimeSpan.FromSeconds(2)));

        Assert.True(state.Snapshot.Known);
        Assert.Equal("Timeout", state.Snapshot.Postgres.Error);
        Assert.Equal("Timeout", state.Snapshot.Qdrant.Error);
    }

    [Fact]
    public async Task HostCancellation_DoesNotPublishCanceledProbe()
    {
        var state = new ApiReadinessProbeState();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        static async Task<DependencyHealth> WaitForever(
            CancellationToken token,
            TaskCompletionSource started)
        {
            started.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            return new DependencyHealth(true, 0);
        }
        var service = CreateService(
            token => WaitForever(token, started),
            token => WaitForever(token, started),
            state);
        using var stopping = new CancellationTokenSource();

        var probe = service.ProbeOnceAsync(stopping.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        stopping.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => probe);
        Assert.False(state.Snapshot.Known);
    }

    private static ApiReadinessProbeService CreateService(
        Func<CancellationToken, Task<DependencyHealth>> postgres,
        Func<CancellationToken, Task<DependencyHealth>> qdrant,
        ApiReadinessProbeState state,
        TimeSpan? timeout = null) =>
        new(
            postgres,
            qdrant,
            CreateConnectionBudget(),
            state,
            NullLogger<ApiReadinessProbeService>.Instance,
            TimeProvider.System,
            TimeSpan.FromSeconds(5),
            timeout ?? TimeSpan.FromSeconds(2));

    private static ApiDatabaseConnectionBudget CreateConnectionBudget() =>
        new(new ApiBulkheadOptions(
            AggregatePermitLimit: 4,
            DatabaseConnectionReserve: 4,
            DatabaseMaximumPoolSize: 8,
            HeavyPermitLimit: 4,
            HeavyQueueLimit: 0,
            StandardPermitLimit: 4,
            StandardQueueLimit: 0,
            ProviderPermitLimit: 1,
            ProviderQueueLimit: 0,
            QueueTimeoutMilliseconds: 100));

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan duration) => _now = _now.Add(duration);
    }
}
