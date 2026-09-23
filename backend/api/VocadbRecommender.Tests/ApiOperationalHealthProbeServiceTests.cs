using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using System.Text.Json;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class ApiOperationalHealthProbeServiceTests
{
    [Fact]
    public void InitialSnapshot_IsDegradedAndPreservesHealthPayloadShape()
    {
        var response = HealthEndpoints.CreateOperationalHealthResponse(
            new ApiOperationalHealthProbeState().Snapshot,
            DateTimeOffset.UtcNow,
            ApiOperationalHealthProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, response.StatusCode);
        Assert.Equal("degraded", response.Payload.status);
        Assert.Equal("Unknown", response.Payload.dependencies.Postgres.Error);
        var json = JsonSerializer.Serialize(
            response.Payload,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        using var document = JsonDocument.Parse(json);
        var names = document.RootElement.EnumerateObject()
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(["audioFeatures", "dependencies", "discoveryQuality", "status"], names);
        Assert.DoesNotContain("checkedAt", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void FreshHealthySnapshot_ReturnsOk()
    {
        var now = new DateTimeOffset(2026, 8, 28, 0, 0, 0, TimeSpan.Zero);
        var snapshot = HealthySnapshot(now);

        var response = HealthEndpoints.CreateOperationalHealthResponse(
            snapshot,
            now,
            ApiOperationalHealthProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status200OK, response.StatusCode);
        Assert.Equal("ok", response.Payload.status);
        Assert.Equal(94, response.Payload.audioFeatures.ActionablePendingCount);
    }

    [Fact]
    public void FreshSnapshotWithAudioWarning_PreservesCoreHealthStatus()
    {
        var now = new DateTimeOffset(2026, 8, 28, 0, 0, 0, TimeSpan.Zero);
        var healthy = HealthySnapshot(now);
        var snapshot = healthy with
        {
            AudioFeatures = healthy.AudioFeatures with { Ok = false, Error = "Stale" },
        };

        var response = HealthEndpoints.CreateOperationalHealthResponse(
            snapshot,
            now,
            ApiOperationalHealthProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status200OK, response.StatusCode);
        Assert.Equal("ok", response.Payload.status);
        Assert.False(response.Payload.audioFeatures.Ok);
    }

    [Fact]
    public void StaleSnapshot_FailsClosedWhileRetainingLastMetrics()
    {
        var checkedAt = new DateTimeOffset(2026, 8, 28, 0, 0, 0, TimeSpan.Zero);
        var response = HealthEndpoints.CreateOperationalHealthResponse(
            HealthySnapshot(checkedAt),
            checkedAt + ApiOperationalHealthProbeService.MaximumSnapshotAge + TimeSpan.FromTicks(1),
            ApiOperationalHealthProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, response.StatusCode);
        Assert.Equal("degraded", response.Payload.status);
        Assert.False(response.Payload.dependencies.Postgres.Ok);
        Assert.Equal("Stale", response.Payload.dependencies.Postgres.Error);
        Assert.Equal(769_410, response.Payload.discoveryQuality.Total);
    }

    [Fact]
    public async Task ProbeOnce_RunsAllExpensiveChecksSequentially()
    {
        var state = new ApiOperationalHealthProbeState();
        var order = new List<int>();
        var service = CreateService(
            _ => { order.Add(0); return Task.FromResult(new DependencyHealth(true, 1)); },
            _ => { order.Add(1); return Task.FromResult(new DependencyHealth(true, 2)); },
            _ => { order.Add(2); return Task.FromResult(Discovery()); },
            _ => { order.Add(3); return Task.FromResult(Audio()); },
            state);

        Assert.True(await service.ProbeOnceAsync());
        Assert.Equal([0, 1, 2, 3], order);
        Assert.True(state.Snapshot.Known);
        Assert.Equal(2, state.Snapshot.Qdrant.LatencyMs);
        Assert.Equal(94, state.Snapshot.AudioFeatures.ActionablePendingCount);
    }

    [Fact]
    public async Task MaintenanceGateWait_UsesTheSharedProbeDeadline()
    {
        var state = new ApiOperationalHealthProbeState();
        var gate = new ApiMaintenanceExecutionGate();
        using var heldByWarmup = await gate.EnterAsync(CancellationToken.None);
        var calls = 0;
        Task<DependencyHealth> Dependency(CancellationToken _)
        {
            Interlocked.Increment(ref calls);
            return Task.FromResult(new DependencyHealth(true, 1));
        }
        var service = CreateService(
            Dependency,
            Dependency,
            _ => Task.FromResult(Discovery()),
            _ => Task.FromResult(Audio()),
            state,
            TimeSpan.FromMilliseconds(50),
            gate);

        Assert.True(await service.ProbeOnceAsync().WaitAsync(TimeSpan.FromSeconds(2)));

        Assert.Equal(0, Volatile.Read(ref calls));
        Assert.True(state.Snapshot.Known);
        Assert.Equal("Timeout", state.Snapshot.Postgres.Error);
        Assert.Equal("Timeout", state.Snapshot.AudioFeatures.Error);
    }

    [Fact]
    public async Task MaintenanceGateWait_PreservesKnownSnapshot()
    {
        var checkedAt = DateTimeOffset.UtcNow;
        var state = new ApiOperationalHealthProbeState();
        state.Publish(
            new DependencyHealth(true, 1),
            new DependencyHealth(true, 2),
            Discovery(),
            Audio(),
            checkedAt);
        var gate = new ApiMaintenanceExecutionGate();
        using var heldByWarmup = await gate.EnterAsync(CancellationToken.None);
        var calls = 0;
        Task<DependencyHealth> Dependency(CancellationToken _)
        {
            Interlocked.Increment(ref calls);
            return Task.FromResult(new DependencyHealth(false, 1, "unexpected"));
        }
        var service = CreateService(
            Dependency,
            Dependency,
            _ => Task.FromResult(Discovery()),
            _ => Task.FromResult(Audio()),
            state,
            TimeSpan.FromMilliseconds(50),
            gate);

        Assert.True(await service.ProbeOnceAsync().WaitAsync(TimeSpan.FromSeconds(2)));

        Assert.Equal(0, Volatile.Read(ref calls));
        Assert.True(state.Snapshot.Postgres.Ok);
        Assert.True(state.Snapshot.Qdrant.Ok);
        Assert.Equal(checkedAt, state.Snapshot.CheckedAt);
    }

    [Fact]
    public async Task ComponentTimeout_PreservesPreviousHealthyComponent()
    {
        var state = new ApiOperationalHealthProbeState();
        var checkedAt = DateTimeOffset.UtcNow;
        state.Publish(
            new DependencyHealth(true, 1),
            new DependencyHealth(true, 2),
            Discovery(),
            Audio(),
            checkedAt);

        static async Task<AudioFeatureHealth> Never(CancellationToken token)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            throw new InvalidOperationException();
        }

        var service = CreateService(
            _ => Task.FromResult(new DependencyHealth(true, 1)),
            _ => Task.FromResult(new DependencyHealth(true, 2)),
            _ => Task.FromResult(Discovery()),
            Never,
            state,
            TimeSpan.FromMilliseconds(50));

        Assert.True(await service.ProbeOnceAsync().WaitAsync(TimeSpan.FromSeconds(2)));

        Assert.True(state.Snapshot.AudioFeatures.Ok);
        Assert.Equal(94, state.Snapshot.AudioFeatures.ActionablePendingCount);
        Assert.Equal(checkedAt, state.Snapshot.AudioFeaturesLastSuccessfulAt);
    }

    [Fact]
    public async Task RepeatedComponentTimeouts_DoNotRefreshSuccessTimesAndEventuallyWarn()
    {
        var checkedAt = new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);
        var time = new MutableTimeProvider(checkedAt);
        var state = new ApiOperationalHealthProbeState();
        state.Publish(
            new DependencyHealth(true, 1),
            new DependencyHealth(true, 2),
            Discovery(),
            Audio(),
            checkedAt);

        static async Task<T> Never<T>(CancellationToken token)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            throw new InvalidOperationException();
        }

        var service = CreateService(
            Never<DependencyHealth>,
            Never<DependencyHealth>,
            Never<DiscoveryQualityHealth>,
            Never<AudioFeatureHealth>,
            state,
            TimeSpan.FromMilliseconds(40),
            timeProvider: time);

        time.Advance(TimeSpan.FromMinutes(5));
        Assert.True(await service.ProbeOnceAsync().WaitAsync(TimeSpan.FromSeconds(2)));
        time.Advance(TimeSpan.FromMinutes(11));
        Assert.True(await service.ProbeOnceAsync().WaitAsync(TimeSpan.FromSeconds(2)));

        var snapshot = state.Snapshot;
        Assert.Equal(time.GetUtcNow(), snapshot.CheckedAt);
        Assert.Equal(checkedAt, snapshot.PostgresLastSuccessfulAt);
        Assert.Equal(checkedAt, snapshot.QdrantLastSuccessfulAt);
        Assert.Equal(checkedAt, snapshot.DiscoveryQualityLastSuccessfulAt);
        Assert.Equal(checkedAt, snapshot.AudioFeaturesLastSuccessfulAt);

        var response = HealthEndpoints.CreateOperationalHealthResponse(
            snapshot,
            time.GetUtcNow(),
            ApiOperationalHealthProbeService.MaximumSnapshotAge);

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, response.StatusCode);
        Assert.Equal("Stale", response.Payload.dependencies.Postgres.Error);
        Assert.Equal("Stale", response.Payload.dependencies.Qdrant.Error);
        Assert.Equal("Stale", response.Payload.discoveryQuality.Error);
        Assert.Equal("Stale", response.Payload.audioFeatures.Error);
    }

    [Fact]
    public async Task FailedComponentProbe_DoesNotAdvanceItsLastSuccessfulTime()
    {
        var checkedAt = new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);
        var time = new MutableTimeProvider(checkedAt);
        var state = new ApiOperationalHealthProbeState();
        state.Publish(
            new DependencyHealth(true, 1),
            new DependencyHealth(true, 2),
            Discovery(),
            Audio(),
            checkedAt);

        var service = CreateService(
            _ => throw new InvalidOperationException("probe failed"),
            _ => Task.FromResult(new DependencyHealth(true, 2)),
            _ => Task.FromResult(Discovery()),
            _ => Task.FromResult(Audio()),
            state,
            timeProvider: time);

        time.Advance(TimeSpan.FromMinutes(1));
        Assert.True(await service.ProbeOnceAsync().WaitAsync(TimeSpan.FromSeconds(2)));

        Assert.Equal("InvalidOperationException", state.Snapshot.Postgres.Error);
        Assert.Equal(checkedAt, state.Snapshot.PostgresLastSuccessfulAt);
        Assert.Equal(time.GetUtcNow(), state.Snapshot.QdrantLastSuccessfulAt);
    }

    [Fact]
    public async Task Timeout_PublishesDegradedSnapshotInsteadOfBlockingEndpoint()
    {
        var state = new ApiOperationalHealthProbeState();
        static async Task<T> Never<T>(CancellationToken token)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            throw new InvalidOperationException();
        }
        var service = CreateService(
            Never<DependencyHealth>,
            Never<DependencyHealth>,
            Never<DiscoveryQualityHealth>,
            Never<AudioFeatureHealth>,
            state,
            TimeSpan.FromMilliseconds(50));

        Assert.True(await service.ProbeOnceAsync().WaitAsync(TimeSpan.FromSeconds(2)));

        Assert.True(state.Snapshot.Known);
        Assert.Equal("Timeout", state.Snapshot.Postgres.Error);
        Assert.Equal("Timeout", state.Snapshot.DiscoveryQuality.Error);
        Assert.Equal("Timeout", state.Snapshot.AudioFeatures.Error);
    }

    [Fact]
    public async Task HostCancellation_DoesNotPublishCanceledProbe()
    {
        var state = new ApiOperationalHealthProbeState();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task<T> Never<T>(CancellationToken token)
        {
            started.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            throw new InvalidOperationException();
        }
        var service = CreateService(
            Never<DependencyHealth>,
            Never<DependencyHealth>,
            Never<DiscoveryQualityHealth>,
            Never<AudioFeatureHealth>,
            state);
        using var stopping = new CancellationTokenSource();

        var probe = service.ProbeOnceAsync(stopping.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        stopping.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => probe);
        Assert.False(state.Snapshot.Known);
    }

    private static ApiOperationalHealthProbeSnapshot HealthySnapshot(DateTimeOffset checkedAt) =>
        new ApiOperationalHealthProbeSnapshot(
            true,
            new DependencyHealth(true, 1),
            new DependencyHealth(true, 2),
            Discovery(),
            Audio(),
            checkedAt)
        {
            PostgresLastSuccessfulAt = checkedAt,
            QdrantLastSuccessfulAt = checkedAt,
            DiscoveryQualityLastSuccessfulAt = checkedAt,
            AudioFeaturesLastSuccessfulAt = checkedAt,
        };

    private static DiscoveryQualityHealth Discovery() =>
        new(true, 100, 769_410, 0.64, 0.01, 0.57, 0.95, "heuristic-v3",
            new Dictionary<string, long> { ["heuristic-v3"] = 769_410 }, 0, DateTimeOffset.UtcNow);

    private static AudioFeatureHealth Audio() =>
        new(true, 200, 96_824, 63_101, 33_723, 0.65, 60_957, 60_863, 94, 0.998, DateTimeOffset.UtcNow, 12);

    private static ApiOperationalHealthProbeService CreateService(
        Func<CancellationToken, Task<DependencyHealth>> postgres,
        Func<CancellationToken, Task<DependencyHealth>> qdrant,
        Func<CancellationToken, Task<DiscoveryQualityHealth>> discovery,
        Func<CancellationToken, Task<AudioFeatureHealth>> audio,
        ApiOperationalHealthProbeState state,
        TimeSpan? timeout = null,
        ApiMaintenanceExecutionGate? maintenanceGate = null,
        TimeProvider? timeProvider = null) =>
        new(
            postgres,
            qdrant,
            discovery,
            audio,
            CreateConnectionBudget(),
            maintenanceGate ?? new ApiMaintenanceExecutionGate(),
            state,
            NullLogger<ApiOperationalHealthProbeService>.Instance,
            timeProvider ?? TimeProvider.System,
            TimeSpan.FromSeconds(30),
            timeout ?? TimeSpan.FromSeconds(2));

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan duration) => _utcNow += duration;
    }

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
}
