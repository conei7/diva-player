using Microsoft.Extensions.Options;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class QdrantServiceCancellationTests
{
    [Fact]
    public void HealthEndpoint_UsesExplicitRestPortForNonstandardGrpcPort()
    {
        var uri = QdrantService.ResolveHealthUri(new RecommenderOptions
        {
            QdrantEndpoint = "http://127.0.0.1:16334",
            QdrantRestEndpoint = "http://127.0.0.1:16333",
        });

        Assert.Equal("http://127.0.0.1:16333/healthz", uri.AbsoluteUri);
    }

    [Fact]
    public void HealthEndpoint_PreservesConventionalQdrantPortPair()
    {
        var uri = QdrantService.ResolveHealthUri(new RecommenderOptions
        {
            QdrantEndpoint = "http://qdrant:6334",
        });

        Assert.Equal("http://qdrant:6333/healthz", uri.AbsoluteUri);
    }

    [Fact]
    public async Task PreCanceledRequest_StopsEveryQdrantReadBeforeFallback()
    {
        var service = new QdrantService(
            Options.Create(new RecommenderOptions
            {
                QdrantEndpoint = "http://127.0.0.1:6334",
            }),
            _ => Task.FromResult("legacy"));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        Func<Task>[] operations =
        [
            () => service.CheckHealthAsync(cancellation.Token),
            () => service.SearchNamedVectorsAsync(1, 10, cancellation.Token),
            () => service.SearchSimilarAsync(1, 10, cancellation.Token),
            () => service.SearchAudioOnlyAsync(1, 10, cancellation.Token),
            () => service.SearchMetadataSimilarAsync(1, 10, cancellation.Token),
        ];

        foreach (var operation in operations)
            await Assert.ThrowsAnyAsync<OperationCanceledException>(operation);
    }
}
