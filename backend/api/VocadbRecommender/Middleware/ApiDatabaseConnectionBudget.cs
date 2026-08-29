using System.Data;
using System.Data.Common;

namespace VocadbRecommender;

/// <summary>
/// Keeps request-originated database fan-out below the Npgsql pool boundary.
/// Hosted probes and the publication guard do not enter a request scope, so
/// the configured reserve remains available even when one request starts many
/// parallel database operations.
/// </summary>
public sealed class ApiDatabaseConnectionBudget
{
    private readonly SemaphoreSlim _foregroundConnections;
    // AsyncLocal deliberately flows into child tasks. Request-created
    // single-flight/cache loaders therefore remain foreground work even if
    // they outlive the initiating middleware continuation.
    private readonly AsyncLocal<RequestScopeMarker?> _requestScope = new();

    internal ApiDatabaseConnectionBudget(ApiBulkheadOptions options)
    {
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

    internal IDisposable EnterRequestScope()
    {
        var previous = _requestScope.Value;
        _requestScope.Value = new RequestScopeMarker();
        return new RequestScope(this, previous);
    }

    internal async ValueTask<ConnectionPermit?> AcquireConnectionAsync(
        CancellationToken cancellationToken)
    {
        if (_requestScope.Value is null)
            return null;

        await _foregroundConnections.WaitAsync(cancellationToken);
        return new ConnectionPermit(_foregroundConnections);
    }

    private sealed class RequestScope(
        ApiDatabaseConnectionBudget owner,
        RequestScopeMarker? previous) : IDisposable
    {
        private ApiDatabaseConnectionBudget? _owner = owner;

        public void Dispose()
        {
            var activeOwner = Interlocked.Exchange(ref _owner, null);
            if (activeOwner is not null)
                activeOwner._requestScope.Value = previous;
        }
    }

    private sealed class RequestScopeMarker
    {
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
