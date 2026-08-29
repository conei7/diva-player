using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Logging.Abstractions;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class ApiDatabaseConnectionBudgetTests
{
    [Theory]
    [InlineData(16, 4, 12)]
    [InlineData(8, 4, 4)]
    public async Task SingleEightSeedRequest_CannotConsumeReservedPoolConnections(
        int poolSize,
        int reserve,
        int expectedForegroundLimit)
    {
        const int worstCaseFanout = 8 * 2;
        var options = CreateOptions(poolSize, reserve);
        var budget = new ApiDatabaseConnectionBudget(options);
        var foregroundLimitReached = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var active = 0;
        var peak = 0;

        using var requestScope = budget.EnterRequestScope();
        var operations = Enumerable.Range(0, worstCaseFanout).Select(async _ =>
        {
            var permit = await budget.AcquireConnectionAsync(CancellationToken.None);
            Assert.NotNull(permit);
            using (permit)
            {
                var current = Interlocked.Increment(ref active);
                UpdateMaximum(ref peak, current);
                if (current == expectedForegroundLimit)
                    foregroundLimitReached.TrySetResult();
                try
                {
                    await release.Task;
                }
                finally
                {
                    Interlocked.Decrement(ref active);
                }
            }
        }).ToArray();

        await foregroundLimitReached.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(expectedForegroundLimit, budget.ForegroundConnectionLimit);
        Assert.Equal(expectedForegroundLimit, Volatile.Read(ref active));
        Assert.Equal(reserve, poolSize - Volatile.Read(ref active));

        release.TrySetResult();
        await Task.WhenAll(operations).WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(expectedForegroundLimit, Volatile.Read(ref peak));
        Assert.Equal(0, Volatile.Read(ref active));
    }

    [Fact]
    public async Task WorkOutsideExplicitScope_UsesBoundedMaintenanceBudget()
    {
        var budget = new ApiDatabaseConnectionBudget(CreateOptions(poolSize: 8, reserve: 4));
        var firstPermit = await budget.AcquireConnectionAsync(CancellationToken.None);
        Assert.NotNull(firstPermit);

        var secondAttempt = budget.AcquireConnectionAsync(CancellationToken.None).AsTask();
        Assert.False(secondAttempt.IsCompleted);

        firstPermit.Dispose();
        using var secondPermit = await secondAttempt.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.NotNull(secondPermit);
    }

    [Theory]
    [InlineData(16, 4, 12)]
    [InlineData(8, 4, 4)]
    public async Task ForegroundSaturation_WithOperationalReadinessAndGuard_FitsPool(
        int poolSize,
        int reserve,
        int foregroundLimit)
    {
        var budget = new ApiDatabaseConnectionBudget(CreateOptions(poolSize, reserve));
        using var physicalPool = new SemaphoreSlim(poolSize, poolSize);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var foregroundEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var maintenanceEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var readinessEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var activeForeground = 0;
        var activeReadiness = 0;
        var operationalCalls = 0;
        var guardHeld = false;

        async Task HoldAsync(
            Action entered,
            CancellationToken cancellationToken = default)
        {
            using var permit = await budget.AcquireConnectionAsync(cancellationToken);
            Assert.NotNull(permit);
            await physicalPool.WaitAsync(cancellationToken);
            try
            {
                entered();
                await release.Task.WaitAsync(cancellationToken);
            }
            finally
            {
                physicalPool.Release();
            }
        }

        Task[] foreground;
        using (budget.EnterRequestScope())
        {
            foreground = Enumerable.Range(0, foregroundLimit)
                .Select(_ => HoldAsync(() =>
                {
                    if (Interlocked.Increment(ref activeForeground) == foregroundLimit)
                        foregroundEntered.TrySetResult();
                }))
                .ToArray();
        }
        await foregroundEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        // RecommendationPublicationGuard owns one raw Npgsql session outside
        // DbService's classified budget.
        await physicalPool.WaitAsync(CancellationToken.None);
        guardHeld = true;

        async Task<DependencyHealth> OperationalDependency(CancellationToken token)
        {
            var call = Interlocked.Increment(ref operationalCalls);
            await HoldAsync(() =>
            {
                if (call == 1)
                    maintenanceEntered.TrySetResult();
            }, token);
            return new DependencyHealth(true, 1);
        }
        async Task<DiscoveryQualityHealth> OperationalDiscovery(CancellationToken token)
        {
            Interlocked.Increment(ref operationalCalls);
            await HoldAsync(() => { }, token);
            return Discovery();
        }
        async Task<AudioFeatureHealth> OperationalAudio(CancellationToken token)
        {
            Interlocked.Increment(ref operationalCalls);
            await HoldAsync(() => { }, token);
            return Audio();
        }
        async Task<DependencyHealth> ReadinessDependency(CancellationToken token)
        {
            await HoldAsync(() =>
            {
                if (Interlocked.Increment(ref activeReadiness)
                    == ApiDatabaseConnectionBudget.ReadinessConnectionLimit)
                {
                    readinessEntered.TrySetResult();
                }
            }, token);
            return new DependencyHealth(true, 1);
        }

        var operationalState = new ApiOperationalHealthProbeState();
        var operationalService = new ApiOperationalHealthProbeService(
            OperationalDependency,
            OperationalDependency,
            OperationalDiscovery,
            OperationalAudio,
            budget,
            new ApiMaintenanceExecutionGate(),
            operationalState,
            NullLogger<ApiOperationalHealthProbeService>.Instance,
            TimeProvider.System,
            TimeSpan.FromMinutes(5),
            TimeSpan.FromSeconds(2));
        var readinessState = new ApiReadinessProbeState();
        var readinessService = new ApiReadinessProbeService(
            ReadinessDependency,
            ReadinessDependency,
            budget,
            readinessState,
            NullLogger<ApiReadinessProbeService>.Instance,
            TimeProvider.System,
            TimeSpan.FromSeconds(5),
            TimeSpan.FromSeconds(2));
        var operational = operationalService.ProbeOnceAsync();
        await maintenanceEntered.Task.WaitAsync(TimeSpan.FromSeconds(1));
        var readiness = readinessService.ProbeOnceAsync();

        try
        {
            // Both readiness probes must get physical connections before the
            // HAProxy check window even with foreground, guard, and operational
            // maintenance already occupying every other pool slot.
            await readinessEntered.Task.WaitAsync(TimeSpan.FromSeconds(1));
            Assert.Equal(foregroundLimit, Volatile.Read(ref activeForeground));
            Assert.Equal(2, Volatile.Read(ref activeReadiness));
            Assert.Equal(1, Volatile.Read(ref operationalCalls));
            Assert.Equal(0, physicalPool.CurrentCount);
        }
        finally
        {
            release.TrySetResult();
            if (guardHeld)
            {
                physicalPool.Release();
                guardHeld = false;
            }
            await Task.WhenAll(foreground.Append(operational).Append(readiness))
                .WaitAsync(TimeSpan.FromSeconds(2));
        }

        Assert.True(await operational);
        Assert.True(await readiness);
        Assert.True(operationalState.Snapshot.Known);
        Assert.True(readinessState.Snapshot.Known);
        Assert.Equal(4, Volatile.Read(ref operationalCalls));
    }

    private static DiscoveryQualityHealth Discovery() =>
        new(
            true,
            1,
            1,
            1,
            1,
            1,
            1,
            "test",
            new Dictionary<string, long> { ["test"] = 1 },
            0,
            DateTimeOffset.UtcNow);

    private static AudioFeatureHealth Audio() =>
        new(
            true,
            1,
            1,
            1,
            0,
            1,
            1,
            1,
            0,
            1,
            DateTimeOffset.UtcNow,
            0);

    [Fact]
    public async Task MaintenanceSpawnedLoader_RemainsBoundedAfterScopeEnds()
    {
        var budget = new ApiDatabaseConnectionBudget(CreateOptions(poolSize: 8, reserve: 4));
        var maintenanceGate = new ApiMaintenanceExecutionGate();
        var startLoader = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var loaderEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseLoader = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        Task loader;
        using (await maintenanceGate.EnterAsync(CancellationToken.None))
        using (budget.EnterMaintenanceScope())
        {
            loader = Task.Run(async () =>
            {
                await startLoader.Task;
                using var permit = await budget.AcquireConnectionAsync(CancellationToken.None);
                Assert.NotNull(permit);
                loaderEntered.TrySetResult();
                await releaseLoader.Task;
            });
        }

        startLoader.TrySetResult();
        await loaderEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        using var nextExecutionLease = await maintenanceGate.EnterAsync(CancellationToken.None);
        var nextMaintenance = budget.AcquireConnectionAsync(CancellationToken.None).AsTask();
        Assert.False(nextMaintenance.IsCompleted);

        releaseLoader.TrySetResult();
        await loader.WaitAsync(TimeSpan.FromSeconds(2));
        using var nextPermit = await nextMaintenance.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.NotNull(nextPermit);
    }

    [Fact]
    public async Task RequestSpawnedLoader_InheritsForegroundBudget()
    {
        var budget = new ApiDatabaseConnectionBudget(CreateOptions(poolSize: 5, reserve: 4));
        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        using var requestScope = budget.EnterRequestScope();
        var first = Task.Run(async () =>
        {
            using var permit = await budget.AcquireConnectionAsync(CancellationToken.None);
            Assert.NotNull(permit);
            firstEntered.TrySetResult();
            await release.Task;
        });
        await firstEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var secondAttempting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = Task.Run(async () =>
        {
            secondAttempting.TrySetResult();
            using var permit = await budget.AcquireConnectionAsync(CancellationToken.None);
            Assert.NotNull(permit);
            secondEntered.TrySetResult();
        });
        await secondAttempting.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.False(secondEntered.Task.IsCompleted);

        release.TrySetResult();
        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(2));
        Assert.True(secondEntered.Task.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task ConnectionStateRaceAfterSubscription_ReleasesPermit()
    {
        var budget = new ApiDatabaseConnectionBudget(CreateOptions(poolSize: 5, reserve: 4));
        using var requestScope = budget.EnterRequestScope();
        var firstPermit = await budget.AcquireConnectionAsync(CancellationToken.None);
        Assert.NotNull(firstPermit);

        firstPermit.ReleaseWhenClosed(new SilentlyClosingConnection());

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        using var secondPermit = await budget.AcquireConnectionAsync(timeout.Token);
        Assert.NotNull(secondPermit);
    }

    private static ApiBulkheadOptions CreateOptions(int poolSize, int reserve) =>
        new(
            AggregatePermitLimit: Math.Min(3, poolSize - reserve),
            DatabaseConnectionReserve: reserve,
            DatabaseMaximumPoolSize: poolSize,
            HeavyPermitLimit: Math.Min(3, poolSize - reserve),
            HeavyQueueLimit: 0,
            StandardPermitLimit: Math.Min(3, poolSize - reserve),
            StandardQueueLimit: 0,
            ProviderPermitLimit: 1,
            ProviderQueueLimit: 0,
            QueueTimeoutMilliseconds: 100);

    private static void UpdateMaximum(ref int target, int candidate)
    {
        var current = Volatile.Read(ref target);
        while (candidate > current)
        {
            var observed = Interlocked.CompareExchange(ref target, candidate, current);
            if (observed == current)
                return;
            current = observed;
        }
    }

    private sealed class SilentlyClosingConnection : DbConnection
    {
        private int _stateReads;

        [AllowNull]
        public override string ConnectionString { get; set; } = string.Empty;
        public override string Database => "test";
        public override string DataSource => "test";
        public override string ServerVersion => "test";
        public override ConnectionState State =>
            Interlocked.Increment(ref _stateReads) == 1
                ? ConnectionState.Open
                : ConnectionState.Closed;

        public override void ChangeDatabase(string databaseName)
        {
        }

        public override void Close()
        {
        }

        public override void Open()
        {
        }

        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel) =>
            throw new NotSupportedException();

        protected override DbCommand CreateDbCommand() =>
            throw new NotSupportedException();
    }
}
