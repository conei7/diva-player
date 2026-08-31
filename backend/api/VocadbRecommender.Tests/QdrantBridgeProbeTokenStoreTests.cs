using VocadbRecommender;

namespace VocadbRecommender.Tests;

public sealed class QdrantBridgeProbeTokenStoreTests
{
    private const string Token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    [Fact]
    public async Task TryConsume_ParallelCallersHaveExactlyOneWinner()
    {
        using var fixture = new TokenFixture();
        fixture.WriteToken();
        using var start = new ManualResetEventSlim(false);
        var attempts = Enumerable.Range(0, 32).Select(_ => Task.Run(() =>
        {
            start.Wait();
            return QdrantBridgeProbeTokenStore.TryConsume(
                fixture.TokenPath, Token, enforceUnixFileContract: false);
        })).ToArray();

        start.Set();
        var results = await Task.WhenAll(attempts);

        Assert.Single(results, result => result);
        Assert.False(File.Exists(fixture.TokenPath));
        Assert.False(File.Exists(fixture.ClaimPath));
        Assert.Null(QdrantBridgeProbeTokenStore.Read(
            fixture.TokenPath, enforceUnixFileContract: false));
        Assert.False(QdrantBridgeProbeTokenStore.TryConsume(
            fixture.TokenPath, Token, enforceUnixFileContract: false));
    }

    [Fact]
    public void TryConsume_WrongTokenRestoresTheUnclaimedToken()
    {
        using var fixture = new TokenFixture();
        fixture.WriteToken();

        Assert.False(QdrantBridgeProbeTokenStore.TryConsume(
            fixture.TokenPath, new string('a', 64), enforceUnixFileContract: false));
        Assert.Equal(Token, QdrantBridgeProbeTokenStore.Read(
            fixture.TokenPath, enforceUnixFileContract: false));
        Assert.False(File.Exists(fixture.ClaimPath));
        Assert.True(QdrantBridgeProbeTokenStore.TryConsume(
            fixture.TokenPath, Token, enforceUnixFileContract: false));
    }

    [Fact]
    public void CleanupStaleClaim_RemovesOnlyAnExactTokenClaim()
    {
        using var fixture = new TokenFixture();
        fixture.WriteToken();
        File.Move(fixture.TokenPath, fixture.ClaimPath, overwrite: false);

        Assert.True(QdrantBridgeProbeTokenStore.CleanupStaleClaim(
            fixture.TokenPath, enforceUnixFileContract: false));
        Assert.False(File.Exists(fixture.ClaimPath));

        File.WriteAllText(fixture.ClaimPath, "malformed\n");
        Assert.False(QdrantBridgeProbeTokenStore.CleanupStaleClaim(
            fixture.TokenPath, enforceUnixFileContract: false));
        Assert.True(File.Exists(fixture.ClaimPath));
    }

    private sealed class TokenFixture : IDisposable
    {
        private readonly string _directory = Path.Combine(
            Path.GetTempPath(), $"diva-qdrant-bridge-token-{Guid.NewGuid():N}");

        internal TokenFixture() => Directory.CreateDirectory(_directory);

        internal string TokenPath => Path.Combine(_directory, "probe-token");
        internal string ClaimPath => TokenPath + ".consuming";

        internal void WriteToken() => File.WriteAllText(TokenPath, Token + "\n");

        public void Dispose() => Directory.Delete(_directory, recursive: true);
    }
}
