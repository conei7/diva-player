using System.Runtime.CompilerServices;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class RecommendationConcurrencyContractTests
{
    [Fact]
    public void ProducerBatchCacheKey_IsOrderInsensitiveAndDeterministic()
    {
        Assert.Equal("3,7,11", RecommendService.ProducerBatchCacheKey([11, 3, 7]));
        Assert.Equal(
            RecommendService.ProducerBatchCacheKey([3, 7, 11]),
            RecommendService.ProducerBatchCacheKey([11, 7, 3]));
    }

    [Fact]
    public void RecommendAsync_StartsEveryIndependentColdSourceBeforeAwaitingAnn()
    {
        var source = ReadServiceSource("RecommendService.cs");

        AssertAppearsInOrder(
            source,
            "var annTask = _qdrant.SearchSimilarAsync(",
            "var graphTask = KnowledgeGraphWalkAsync(",
            "var relationshipTask = _db.GetMetadataRelationshipCandidateIdsAsync(",
            "await Task.WhenAll(annTask, graphTask, relationshipTask);",
            "var annCandidates = await annTask;",
            "var graphCandidates = await graphTask;");
        Assert.DoesNotContain(
            "var annCandidates = await _qdrant.SearchSimilarAsync(",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void NamedVectorSearch_StartsAudioAndMetadataBeforeAwaitingEither()
    {
        var source = ReadServiceSource("QdrantService.cs");

        AssertAppearsInOrder(
            source,
            "var audioSearchTask = SearchNamedVectorAsync(audioVec, \"audio\");",
            "var metaSearchTask = SearchNamedVectorAsync(metaVec, \"meta\");",
            "await Task.WhenAll(audioSearchTask, metaSearchTask);",
            "var audioResults = await audioSearchTask;",
            "var metaResults = await metaSearchTask;");
    }

    private static void AssertAppearsInOrder(string source, params string[] fragments)
    {
        var previousIndex = -1;
        foreach (var fragment in fragments)
        {
            var index = source.IndexOf(fragment, StringComparison.Ordinal);
            Assert.True(index >= 0, $"Expected source fragment was not found: {fragment}");
            Assert.True(
                index > previousIndex,
                $"Source fragment appeared out of order: {fragment}");
            previousIndex = index;
        }
    }

    private static string ReadServiceSource(
        string fileName,
        [CallerFilePath] string testSourcePath = "")
    {
        var testsDirectory = Path.GetDirectoryName(testSourcePath)
            ?? throw new InvalidOperationException("Unable to locate test source directory.");
        var servicePath = Path.GetFullPath(Path.Combine(
            testsDirectory,
            "..",
            "VocadbRecommender",
            "Services",
            fileName));
        return File.ReadAllText(servicePath);
    }
}
