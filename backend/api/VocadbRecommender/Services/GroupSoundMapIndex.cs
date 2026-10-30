namespace VocadbRecommender.Services;

/// <summary>A shared, bounded audio catalogue, loaded only when the experimental group map is used.</summary>
internal sealed class GroupSoundMapIndex
{
    private readonly Func<CancellationToken, Task<IReadOnlyDictionary<int, Half[]>>> _load;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly ILogger<GroupSoundMapIndex> _logger;
    private readonly object _sync = new();
    private Task<IReadOnlyDictionary<int, Half[]>>? _loading;
    private DateTimeOffset _loadedAt;
    private DateTimeOffset _retryAfter;

    // At most ~196 MiB of dense data per snapshot. Never silently truncate the catalogue.
    internal const int MaximumSongs = 100_000;

    public GroupSoundMapIndex(QdrantService qdrant, IHostApplicationLifetime lifetime, ILogger<GroupSoundMapIndex> logger)
        : this(qdrant.ReadGroupSoundMapCatalogueAsync, lifetime, logger) { }

    internal GroupSoundMapIndex(Func<CancellationToken, Task<IReadOnlyDictionary<int, Half[]>>> load,
        IHostApplicationLifetime lifetime, ILogger<GroupSoundMapIndex> logger)
    {
        _load = load; _lifetime = lifetime; _logger = logger;
    }

    internal IReadOnlyDictionary<int, Half[]>? GetOrStart()
    {
        lock (_sync)
        {
            var now = DateTimeOffset.UtcNow;
            var ready = _loading is { IsCompletedSuccessfully: true } ? _loading.Result : null;
            if (_loading is { IsCompleted: false }) return null;
            if (_loading is { IsFaulted: true }) _ = _loading.Exception; // Observe the already logged background failure.
            if (ready is not null && now - _loadedAt < TimeSpan.FromMinutes(30)) return ready;
            if (now < _retryAfter) throw new InvalidOperationException("Audio catalogue retry cooldown");
            _loadedAt = now;
            _retryAfter = now.AddSeconds(30);
            _loading = LoadAsync();
            return null;
        }
    }

    private async Task<IReadOnlyDictionary<int, Half[]>> LoadAsync()
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.ApplicationStopping);
        timeout.CancelAfter(TimeSpan.FromMinutes(2));
        try { return await _load(timeout.Token); }
        catch (Exception error)
        {
            lock (_sync) _retryAfter = DateTimeOffset.UtcNow.AddSeconds(30);
            _logger.LogWarning(error, "Group sound map audio catalogue could not be loaded");
            throw;
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
