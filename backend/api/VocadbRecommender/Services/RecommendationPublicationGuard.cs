using Npgsql;

namespace VocadbRecommender.Services;

internal sealed record RecommendationPublicationSnapshot(
    bool InProgress,
    string Generation);

internal interface IRecommendationPublicationSession : IAsyncDisposable
{
    Task<RecommendationPublicationSnapshot> ReadSnapshotAsync(
        CancellationToken cancellationToken);
}

/// <summary>
/// Coordinates vector-recommendation readers with the pipeline's cross-store
/// publication. Concurrent requests in one API process share one PostgreSQL
/// advisory-lock session, so exact draining costs at most one pool connection
/// per API slot rather than one connection per request.
/// </summary>
public sealed class RecommendationPublicationGuard : IAsyncDisposable
{
    internal const string AdvisoryLockName = "diva-recommendation-publication-v1";

    private readonly Func<CancellationToken, Task<IRecommendationPublicationSession>>
        _openSession;
    private readonly Func<string, CancellationToken, Task> _observeGeneration;
    private readonly ILogger<RecommendationPublicationGuard>? _logger;
    private readonly SemaphoreSlim _stateGate = new(1, 1);
    private IRecommendationPublicationSession? _session;
    private int _activeReaders;
    private bool _disposed;

    public RecommendationPublicationGuard(
        IConfiguration configuration,
        DbService db,
        ILogger<RecommendationPublicationGuard> logger)
        : this(
            cancellationToken => OpenPostgresSessionAsync(
                configuration.GetConnectionString("Postgres")
                    ?? throw new InvalidOperationException(
                        "ConnectionStrings:Postgres is not configured"),
                cancellationToken),
            db.ObserveRecommendationPublicationGenerationAsync,
            logger)
    {
    }

    internal RecommendationPublicationGuard(
        Func<CancellationToken, Task<IRecommendationPublicationSession>> openSession,
        Func<string, CancellationToken, Task> observeGeneration,
        ILogger<RecommendationPublicationGuard>? logger = null)
    {
        ArgumentNullException.ThrowIfNull(openSession);
        ArgumentNullException.ThrowIfNull(observeGeneration);
        _openSession = openSession;
        _observeGeneration = observeGeneration;
        _logger = logger;
    }

    public async Task<RecommendationPublicationLease?> TryEnterAsync(
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await _stateGate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _session ??= await _openSession(cancellationToken);
            var snapshot = await _session.ReadSnapshotAsync(cancellationToken);
            if (snapshot.InProgress)
            {
                if (_activeReaders == 0)
                    await DisposeSessionSafelyAsync("gate_rejection");
                return null;
            }

            await _observeGeneration(snapshot.Generation, cancellationToken);
            checked { _activeReaders++; }
            return new RecommendationPublicationLease(this);
        }
        catch
        {
            if (_activeReaders == 0)
                await DisposeSessionSafelyAsync("acquisition_failure");
            throw;
        }
        finally
        {
            _stateGate.Release();
        }
    }

    internal async ValueTask ExitAsync()
    {
        await _stateGate.WaitAsync();
        try
        {
            if (_activeReaders <= 0)
                throw new InvalidOperationException("Recommendation publication lease underflow");
            _activeReaders--;
            if (_activeReaders == 0)
                await DisposeSessionSafelyAsync("last_reader_release");
        }
        finally
        {
            _stateGate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _stateGate.WaitAsync();
        try
        {
            if (_disposed)
                return;
            _disposed = true;
            _activeReaders = 0;
            await DisposeSessionSafelyAsync("service_disposal");
        }
        finally
        {
            _stateGate.Release();
            _stateGate.Dispose();
        }
    }

    private async ValueTask DisposeSessionAsync()
    {
        if (_session is null)
            return;
        var session = _session;
        _session = null;
        await session.DisposeAsync();
    }

    private async ValueTask DisposeSessionSafelyAsync(string operation)
    {
        try
        {
            await DisposeSessionAsync();
        }
        catch (Exception exception)
        {
            // Closing the Npgsql connection in the session's finally block
            // releases the advisory lock even if the explicit unlock command
            // fails. Cleanup must not replace an endpoint's real exception or
            // turn an otherwise valid response into a transport failure.
            _logger?.LogError(
                exception,
                "recommendation_publication_session_cleanup_failed operation={Operation}",
                operation);
        }
    }

    private static async Task<IRecommendationPublicationSession>
        OpenPostgresSessionAsync(
            string connectionString,
            CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(connectionString);
        try
        {
            await connection.OpenAsync(cancellationToken);
            await using var command = new NpgsqlCommand(@"
                SELECT pg_advisory_lock_shared(
                    hashtextextended($1, 0))", connection);
            command.Parameters.AddWithValue(AdvisoryLockName);
            await command.ExecuteNonQueryAsync(cancellationToken);
            return new PostgresRecommendationPublicationSession(connection);
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    private sealed class PostgresRecommendationPublicationSession(
        NpgsqlConnection connection) : IRecommendationPublicationSession
    {
        private NpgsqlConnection? _connection = connection;

        public async Task<RecommendationPublicationSnapshot> ReadSnapshotAsync(
            CancellationToken cancellationToken)
        {
            var activeConnection = _connection
                ?? throw new ObjectDisposedException(nameof(PostgresRecommendationPublicationSession));
            await using var command = new NpgsqlCommand(@"
                SELECT EXISTS (
                           SELECT 1
                           FROM sync_state
                           WHERE key = 'recommendation_publication_in_progress'
                       ),
                       COALESCE(
                           (
                               SELECT NULLIF(value, '')
                               FROM sync_state
                               WHERE key = 'recommendation_publication_generation'
                           ),
                           'legacy')", activeConnection);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
                throw new InvalidOperationException(
                    "Recommendation publication state is unavailable");
            return new RecommendationPublicationSnapshot(
                reader.GetBoolean(0),
                reader.GetString(1));
        }

        public async ValueTask DisposeAsync()
        {
            if (_connection is null)
                return;
            var activeConnection = _connection;
            _connection = null;
            try
            {
                await using var command = new NpgsqlCommand(@"
                    SELECT pg_advisory_unlock_shared(
                        hashtextextended($1, 0))", activeConnection);
                command.Parameters.AddWithValue(AdvisoryLockName);
                await command.ExecuteNonQueryAsync(CancellationToken.None);
            }
            finally
            {
                await activeConnection.DisposeAsync();
            }
        }
    }
}

public sealed class RecommendationPublicationLease : IAsyncDisposable
{
    private RecommendationPublicationGuard? _owner;

    internal RecommendationPublicationLease(RecommendationPublicationGuard owner) =>
        _owner = owner;

    public async ValueTask DisposeAsync()
    {
        var owner = Interlocked.Exchange(ref _owner, null);
        if (owner is not null)
            await owner.ExitAsync();
    }
}
