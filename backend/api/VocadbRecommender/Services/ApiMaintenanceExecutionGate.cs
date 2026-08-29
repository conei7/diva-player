namespace VocadbRecommender.Services;

/// <summary>
/// Prevents periodic warmup and operational-health maintenance from running
/// at the same time. The database budget independently caps descendant work,
/// including cache refresh tasks that outlive this execution lease.
/// </summary>
public sealed class ApiMaintenanceExecutionGate
{
    private readonly SemaphoreSlim _execution = new(1, 1);

    internal async ValueTask<IDisposable> EnterAsync(CancellationToken cancellationToken)
    {
        await _execution.WaitAsync(cancellationToken);
        return new Lease(_execution);
    }

    private sealed class Lease(SemaphoreSlim execution) : IDisposable
    {
        private SemaphoreSlim? _execution = execution;

        public void Dispose() =>
            Interlocked.Exchange(ref _execution, null)?.Release();
    }
}
