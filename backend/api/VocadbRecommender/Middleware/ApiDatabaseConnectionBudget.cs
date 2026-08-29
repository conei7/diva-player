using System.Data;
using System.Data.Common;

namespace VocadbRecommender;

/// <summary>
/// Keeps each class of database work inside its share of the Npgsql pool.
/// Foreground fan-out cannot consume the reserved connections, readiness has
/// two dedicated permits, and operational/warmup maintenance shares one. The
/// remaining reserved connection belongs to the publication advisory-lock
/// session, which intentionally opens its connection outside this budget.
/// </summary>
public sealed class ApiDatabaseConnectionBudget
{
    internal const int ReadinessConnectionLimit = 2;
    internal const int MaintenanceConnectionLimit = 1;
    internal const int PublicationGuardConnectionLimit = 1;
    internal const int RequiredConnectionReserve =
        ReadinessConnectionLimit
        + MaintenanceConnectionLimit
        + PublicationGuardConnectionLimit;

    private readonly SemaphoreSlim _foregroundConnections;
    private readonly SemaphoreSlim _readinessConnections = new(ReadinessConnectionLimit);
    private readonly SemaphoreSlim _maintenanceConnections = new(MaintenanceConnectionLimit);
    // AsyncLocal deliberately flows into child tasks. Request-created and
    // maintenance-created single-flight/cache loaders therefore retain their
    // originating budget even if they outlive the initiating continuation.
    private readonly AsyncLocal<ConnectionScopeMarker?> _connectionScope = new();

    internal ApiDatabaseConnectionBudget(ApiBulkheadOptions options)
    {
        if (options.DatabaseConnectionReserve < RequiredConnectionReserve)
        {
            throw new InvalidOperationException(
                $"The PostgreSQL pool reserve must be at least {RequiredConnectionReserve} "
                + "connections (readiness 2, maintenance 1, publication guard 1).");
        }
        ForegroundConnectionLimit = checked(
            options.DatabaseMaximumPoolSize - options.DatabaseConnectionReserve);
        if (ForegroundConnectionLimit < 1)
        {
            throw new InvalidOperationException(
                "The PostgreSQL pool must retain at least one foreground connection after its reserve.");
        }
        _foregroundConnections = new SemaphoreSlim(ForegroundConnectionLimit);
    }

    internal int ForegroundConnectionLimit { get; }

    internal IDisposable EnterRequestScope() => EnterScope(ConnectionWorkload.Foreground);

    internal IDisposable EnterReadinessScope() => EnterScope(ConnectionWorkload.Readiness);

    internal IDisposable EnterMaintenanceScope() => EnterScope(ConnectionWorkload.Maintenance);

    internal async ValueTask<ConnectionPermit?> AcquireConnectionAsync(
        CancellationToken cancellationToken)
    {
        var semaphore = _connectionScope.Value?.Workload switch
        {
            ConnectionWorkload.Foreground => _foregroundConnections,
            ConnectionWorkload.Readiness => _readinessConnections,
            ConnectionWorkload.Maintenance => _maintenanceConnections,
            // Future hosted/background callers fail into the bounded lane
            // instead of silently bypassing the pool reserve.
            _ => _maintenanceConnections,
        };

        await semaphore.WaitAsync(cancellationToken);
        return new ConnectionPermit(semaphore);
    }

    private IDisposable EnterScope(ConnectionWorkload workload)
    {
        var previous = _connectionScope.Value;
        _connectionScope.Value = new ConnectionScopeMarker(workload);
        return new ConnectionScope(this, previous);
    }

    private sealed class ConnectionScope(
        ApiDatabaseConnectionBudget owner,
        ConnectionScopeMarker? previous) : IDisposable
    {
        private ApiDatabaseConnectionBudget? _owner = owner;

        public void Dispose()
        {
            var activeOwner = Interlocked.Exchange(ref _owner, null);
            if (activeOwner is not null)
                activeOwner._connectionScope.Value = previous;
        }
    }

    private sealed record ConnectionScopeMarker(ConnectionWorkload Workload);

    private enum ConnectionWorkload
    {
        Foreground,
        Readiness,
        Maintenance,
    }

    internal sealed class ConnectionPermit(SemaphoreSlim semaphore) : IDisposable
    {
        private DbConnection? _connection;
        private int _released;

        internal void ReleaseWhenClosed(DbConnection connection)
        {
            ArgumentNullException.ThrowIfNull(connection);
            if (connection.State != ConnectionState.Open)
                throw new InvalidOperationException("A database permit can only track an open connection.");
            if (Volatile.Read(ref _released) != 0 || _connection is not null)
                throw new InvalidOperationException("The database permit is no longer attachable.");

            _connection = connection;
            connection.StateChange += OnStateChange;
            connection.Disposed += OnDisposed;

            // The provider can report a transport failure between the initial
            // state check and event subscription. Recheck after both handlers
            // are attached, and also detach if a handler already released us
            // while the subscriptions were being installed.
            if (Volatile.Read(ref _released) != 0)
            {
                connection.StateChange -= OnStateChange;
                connection.Disposed -= OnDisposed;
                return;
            }
            if (connection.State != ConnectionState.Open)
                Dispose();
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) != 0)
                return;

            var connection = Interlocked.Exchange(ref _connection, null);
            if (connection is not null)
            {
                connection.StateChange -= OnStateChange;
                connection.Disposed -= OnDisposed;
            }
            semaphore.Release();
        }

        private void OnStateChange(object? sender, StateChangeEventArgs args)
        {
            if (args.CurrentState is ConnectionState.Closed or ConnectionState.Broken)
                Dispose();
        }

        private void OnDisposed(object? sender, EventArgs args) => Dispose();
    }
}
