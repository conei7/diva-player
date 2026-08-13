using System.Runtime.CompilerServices;

namespace VocadbRecommender.Tests;

public sealed class DiscoveryEligibilityContractTests
{
    [Fact]
    public void Response_PreservesEligibleCoverAndFailsClosedForExcludedOrMissingRows()
    {
        var items = SongReadEndpoints.BuildDiscoveryEligibilityItems(
            [566566, 933455, 123456],
            new Dictionary<int, bool>
            {
                [566566] = true,
                [933455] = false,
            });

        Assert.Collection(
            items,
            item =>
            {
                Assert.Equal(566566, item.SongId);
                Assert.True(item.DiscoveryEligible);
            },
            item =>
            {
                Assert.Equal(933455, item.SongId);
                Assert.False(item.DiscoveryEligible);
            },
            item =>
            {
                Assert.Equal(123456, item.SongId);
                Assert.False(item.DiscoveryEligible);
            });
    }

    [Fact]
    public void DatabaseLookup_IsBoundedAuthoritativeAndFailClosed()
    {
        var dbSource = ReadRepositoryFile(
            "backend", "api", "VocadbRecommender", "Services", "DbService.cs");
        var endpointSource = ReadRepositoryFile(
            "backend", "api", "VocadbRecommender", "Endpoints", "SongReadEndpoints.cs");

        Assert.Contains(".Take(500)", dbSource);
        Assert.Contains("COALESCE(quality.discovery_eligible, FALSE)", dbSource);
        Assert.Contains("LEFT JOIN song_discovery_quality quality", dbSource);
        Assert.Contains("rawIds.Length > 500", endpointSource);
        Assert.Contains("Headers.CacheControl = \"no-store\"", endpointSource);
    }

    private static string ReadRepositoryFile(
        string firstRelativeSegment,
        params string[] remainingRelativeSegments)
    {
        var relativeSegments = new[] { firstRelativeSegment }
            .Concat(remainingRelativeSegments)
            .ToArray();
        return ReadRepositoryFile(relativeSegments);
    }

    private static string ReadRepositoryFile(
        string[] relativeSegments,
        [CallerFilePath] string testSourcePath = "")
    {
        var testsDirectory = Path.GetDirectoryName(testSourcePath)
            ?? throw new InvalidOperationException("Unable to locate test source directory.");
        var repositoryRoot = Path.GetFullPath(Path.Combine(testsDirectory, "..", "..", ".."));
        return File.ReadAllText(Path.Combine([repositoryRoot, .. relativeSegments]))
            .Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}
