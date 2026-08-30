using Qdrant.Client.Grpc;
using Grpc.Core;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class QdrantVectorCompatibilityTests
{
    [Fact]
    public void ReadDenseVector_AcceptsLegacyFlattenedEncoding()
    {
        var vector = new VectorOutput();
#pragma warning disable CS0612 // Deliberately simulate a response from Qdrant 1.9.
        vector.Data.Add([0.25f, -0.5f, 1f]);
#pragma warning restore CS0612

        Assert.Equal([0.25f, -0.5f, 1f], QdrantService.ReadDenseVector(vector));
    }

    [Fact]
    public void ReadDenseVector_AcceptsTypedDenseEncoding()
    {
        var vector = new VectorOutput { Dense = new DenseVector() };
        vector.Dense.Data.Add([0.25f, -0.5f, 1f]);

        Assert.Equal([0.25f, -0.5f, 1f], QdrantService.ReadDenseVector(vector));
    }

    [Fact]
    public void ReadDenseVector_ReturnsEmptyForMissingOrNonDenseVector()
    {
        Assert.Empty(QdrantService.ReadDenseVector(null));
        Assert.Empty(QdrantService.ReadDenseVector(new VectorOutput()));
        Assert.Empty(QdrantService.ReadDenseVector(new VectorOutput
        {
            Sparse = new SparseVector(),
        }));
    }

    [Theory]
    [InlineData(StatusCode.Unimplemented, true)]
    [InlineData(StatusCode.Unavailable, false)]
    [InlineData(StatusCode.PermissionDenied, false)]
    [InlineData(StatusCode.Cancelled, false)]
    public void LegacySearchFallback_IsLimitedToMissingQueryApi(
        StatusCode statusCode,
        bool expected)
    {
        var exception = new RpcException(new Status(statusCode, "test"));

        Assert.Equal(expected, QdrantService.IsLegacyQueryApiUnavailable(exception));
    }
}
