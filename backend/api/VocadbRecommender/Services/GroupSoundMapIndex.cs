namespace VocadbRecommender.Services;

/// <summary>Single-flight disk catalogue; refreshes keep the last good snapshot available.</summary>
internal sealed class GroupSoundMapIndex : IDisposable
{
    private readonly Func<CancellationToken, Task<GroupSoundMapCatalogue>> _load;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly ILogger<GroupSoundMapIndex> _logger;
    private readonly TimeProvider _time;
    private readonly object _sync = new();
    private Task<GroupSoundMapCatalogue>? _loading;
    private GroupSoundMapCatalogue? _current;
    private DateTimeOffset _loadedAt;
    private DateTimeOffset _retryAfter;
    private bool _disposed;
    internal const int MaximumSongs = 100_000;

    public GroupSoundMapIndex(QdrantService qdrant, IHostApplicationLifetime lifetime, ILogger<GroupSoundMapIndex> logger)
        : this(qdrant.ReadGroupSoundMapCatalogueAsync, lifetime, logger, TimeProvider.System) { }

    internal GroupSoundMapIndex(Func<CancellationToken, Task<GroupSoundMapCatalogue>> load,
        IHostApplicationLifetime lifetime, ILogger<GroupSoundMapIndex> logger, TimeProvider? time = null)
    {
        _load = load; _lifetime = lifetime; _logger = logger; _time = time ?? TimeProvider.System;
    }

    internal GroupSoundMapCatalogue.Lease? GetOrStart()
    {
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var now = _time.GetUtcNow();
            if (_loading is { IsCompletedSuccessfully: true })
            {
                var old = _current;
                _current = _loading.Result; _loading = null; _loadedAt = now;
                old?.Dispose();
            }
            if (_loading is { IsFaulted: true } or { IsCanceled: true })
            {
                _ = _loading.Exception; _loading = null; _retryAfter = now.AddSeconds(30);
            }
            if (_loading is null && (_current is null || now - _loadedAt >= TimeSpan.FromMinutes(30)))
            {
                if (now < _retryAfter)
                {
                    if (_current is null) throw new InvalidOperationException("Audio catalogue retry cooldown");
                }
                else _loading = LoadAsync();
            }
            return _current?.Acquire();
        }
    }

    private async Task<GroupSoundMapCatalogue> LoadAsync()
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.ApplicationStopping);
        timeout.CancelAfter(TimeSpan.FromMinutes(2));
        try { return await _load(timeout.Token); }
        catch (Exception error)
        {
            _logger.LogWarning(error, "Group sound map audio catalogue could not be loaded");
            throw;
        }
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed) return;
            _disposed = true; _current?.Dispose(); _current = null;
            if (_loading is not null)
                _ = _loading.ContinueWith(task => {
                    if (task.IsCompletedSuccessfully) task.Result.Dispose();
                    else _ = task.Exception;
                }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        }
    }

    /// <summary>Sum of squared pair distances separates by dimension; Welford avoids cancellation.</summary>
    internal static (int X, int Y) SelectAxes(IReadOnlyList<float[]> seeds)
    {
        if (seeds.Count is < 3 or > 20 || seeds.Any(v => v.Length != 1024 || v.Any(x => !float.IsFinite(x))))
            throw new ArgumentException("Expected 3–20 finite 1024-dimensional vectors", nameof(seeds));
        var scores = new double[1024];
        for (var d = 0; d < 1024; d++)
        {
            double mean = 0, m2 = 0;
            for (var i = 0; i < seeds.Count; i++)
            {
                var delta = seeds[i][d] - mean;
                mean += delta / (i + 1);
                m2 += delta * (seeds[i][d] - mean);
            }
            scores[d] = Math.Max(0, m2);
        }
        var axes = Enumerable.Range(0, 1024).OrderBy(d => scores[d]).ThenBy(d => d).Take(2).ToArray();
        return (axes[0], axes[1]);
    }
}
