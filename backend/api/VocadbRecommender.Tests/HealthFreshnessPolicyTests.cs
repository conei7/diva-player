using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class HealthFreshnessPolicyTests
{
    [Fact]
    public void FreshnessBoundaryIsInclusiveAndBounded()
    {
        var now = new DateTimeOffset(2026, 8, 30, 0, 0, 0, TimeSpan.Zero);
        var maximumAge = TimeSpan.FromHours(216);

        Assert.True(DbService.IsWithinMaximumAge(now - maximumAge, now, maximumAge));
        Assert.False(DbService.IsWithinMaximumAge(now - maximumAge - TimeSpan.FromTicks(1), now, maximumAge));
        Assert.False(DbService.IsWithinMaximumAge(null, now, maximumAge));
        Assert.False(DbService.IsWithinMaximumAge(now, now, TimeSpan.Zero));
        Assert.True(DbService.IsWithinMaximumAge(now + TimeSpan.FromMinutes(5), now, maximumAge));
        Assert.False(DbService.IsWithinMaximumAge(now + TimeSpan.FromMinutes(5) + TimeSpan.FromTicks(1), now, maximumAge));
    }

    [Fact]
    public void PrimaryDefaultsRemainStrict()
    {
        var options = new RecommenderOptions();

        Assert.Equal(48, options.DiscoveryQualityMaxAgeHours);
        Assert.Equal(72, options.AudioFeatureMaxAgeHours);
    }
}
