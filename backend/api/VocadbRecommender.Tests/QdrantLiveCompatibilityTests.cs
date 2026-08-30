using Microsoft.Extensions.Options;
using Qdrant.Client;
using Qdrant.Client.Grpc;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class QdrantLiveCompatibilityTests
{
    private static Vectors CreateVectors(bool useLegacyWireEncoding, params float[] values)
    {
        if (!useLegacyWireEncoding)
            return values;

        var vector = new Vector();
#pragma warning disable CS0612 // Exercise the Qdrant 1.9 wire representation.
        vector.Data.Add(values);
#pragma warning restore CS0612
        return new Vectors { Vector = vector };
    }

    [Fact]
    [Trait("Category", "ExternalIntegration")]
    public async Task MetadataSearch_WorksAcrossSupportedRollingUpgradeBoundary()
    {
        var endpoint = Environment.GetEnvironmentVariable("DIVA_TEST_QDRANT_GRPC_ENDPOINT");
        if (string.IsNullOrWhiteSpace(endpoint))
            return;
        var useLegacyWireEncoding = string.Equals(
            Environment.GetEnvironmentVariable("DIVA_TEST_QDRANT_LEGACY_WIRE"),
            "true",
            StringComparison.OrdinalIgnoreCase);

        var collectionName = $"diva_api_compat_{Guid.NewGuid():N}";
        using var client = new QdrantClient(new Uri(endpoint));
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var collectionCreated = false;
        Exception? primaryFailure = null;

        try
        {
            await client.CreateCollectionAsync(
                collectionName,
                new VectorParams { Size = 2, Distance = Distance.Cosine },
                cancellationToken: cancellation.Token);
            collectionCreated = true;
            await client.UpsertAsync(
                collectionName,
                [
                    new PointStruct { Id = 1, Vectors = CreateVectors(useLegacyWireEncoding, 1f, 0f) },
                    new PointStruct { Id = 2, Vectors = CreateVectors(useLegacyWireEncoding, 0.9f, 0.1f) },
                    new PointStruct { Id = 3, Vectors = CreateVectors(useLegacyWireEncoding, 0f, 1f) },
                ],
                cancellationToken: cancellation.Token);

            var service = new QdrantService(
                Options.Create(new RecommenderOptions
                {
                    QdrantEndpoint = endpoint,
                    CollectionMetadata = collectionName,
                }),
                _ => Task.FromResult("compatibility-test"));

            var result = await service.SearchMetadataSimilarAsync(
                seedSongId: 1,
                topK: 1,
                cancellationToken: cancellation.Token);

            Assert.Collection(result, point => Assert.Equal(2, point.SongId));
        }
        catch (Exception exception)
        {
            primaryFailure = exception;
            throw;
        }
        finally
        {
            if (collectionCreated)
            {
                try
                {
                    using var cleanupCancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                    await client.DeleteCollectionAsync(
                        collectionName,
                        cancellationToken: cleanupCancellation.Token);
                }
                catch (Exception cleanupFailure) when (primaryFailure is not null)
                {
                    primaryFailure.Data["QdrantCompatibilityCleanupFailure"] =
                        cleanupFailure.ToString();
                }
            }
        }
    }
}
