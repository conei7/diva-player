using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;

namespace VocadbRecommender.Tests;

public sealed class ApiDatabaseConnectionBudgetTests
{
    [Theory]
    [InlineData(16, 4, 12)]
    [InlineData(8, 3, 5)]
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
    public async Task WorkOutsideRequestScope_DoesNotConsumeForegroundBudget()
    {
        var budget = new ApiDatabaseConnectionBudget(CreateOptions(poolSize: 8, reserve: 3));

        var permit = await budget.AcquireConnectionAsync(CancellationToken.None);

        Assert.Null(permit);
    }

    [Fact]
    public async Task RequestSpawnedLoader_InheritsForegroundBudget()
    {
        var budget = new ApiDatabaseConnectionBudget(CreateOptions(poolSize: 3, reserve: 2));
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
        var budget = new ApiDatabaseConnectionBudget(CreateOptions(poolSize: 3, reserve: 2));
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
