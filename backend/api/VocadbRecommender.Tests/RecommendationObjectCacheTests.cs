using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class RecommendationObjectCacheTests
{
    [Fact]
    public void DefaultOptions_ConfigureSeparateSixtyFourMiBPartition()
    {
        using var cache = new RecommendationObjectCache(
            Options.Create(new RecommenderOptions()),
            NullLogger<RecommendationObjectCache>.Instance);

        Assert.Equal(64L * 1024 * 1024, cache.SizeLimitBytes);
        Assert.Equal(16L * 1024 * 1024, cache.MaxEntryBytes);
    }

    [Fact]
    public void SetAndTryGetValue_PreserveTypedObjects()
    {
        using var cache = CreateCache();
        var value = new[] { 3, 7, 11 };

        Assert.True(cache.Set("ids", value, TimeSpan.FromMinutes(15), value.Length * sizeof(int)));
        Assert.True(cache.TryGetValue("ids", out int[]? cached));
        Assert.Same(value, cached);
    }

    [Fact]
    public void SharedCapacity_PreventsTwoMinimumChargeEntriesFromAccumulating()
    {
        using var cache = CreateCache(
            sizeLimitBytes: RecommendationObjectCache.MinimumEntryChargeBytes,
            maxEntryBytes: RecommendationObjectCache.MinimumEntryChargeBytes);

        cache.Set("first", new object(), TimeSpan.FromMinutes(1), 1);
        cache.Set("second", new object(), TimeSpan.FromMinutes(1), 1);

        Assert.True(cache.EntryCount <= 1);
    }

    [Fact]
    public void OversizedReplacement_RemovesOldValueAndIsNotStored()
    {
        using var cache = CreateCache(sizeLimitBytes: 16 * 1024, maxEntryBytes: 4 * 1024);
        Assert.True(cache.Set("key", "old", TimeSpan.FromMinutes(1), 16));

        var stored = cache.Set("key", "new", TimeSpan.FromMinutes(1), 8 * 1024);

        Assert.False(stored);
        Assert.False(cache.TryGetValue("key", out string? _));
    }

    [Fact]
    public void EntryCharge_AccountsForUtf16KeyAndMinimumCharge()
    {
        Assert.Equal(
            RecommendationObjectCache.MinimumEntryChargeBytes,
            RecommendationObjectCache.EstimateEntryChargeBytes("key", 1));
        Assert.Equal(
            (long)100 * sizeof(char) + 5_000 + RecommendationObjectCache.EstimatedEntryOverheadBytes,
            RecommendationObjectCache.EstimateEntryChargeBytes(new string('k', 100), 5_000));
    }

    private static RecommendationObjectCache CreateCache(
        long sizeLimitBytes = 64 * 1024,
        long maxEntryBytes = 16 * 1024)
        => new(
            sizeLimitBytes,
            maxEntryBytes,
            NullLogger<RecommendationObjectCache>.Instance);
}
