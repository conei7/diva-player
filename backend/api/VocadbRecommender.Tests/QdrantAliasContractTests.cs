using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class QdrantAliasContractTests
{
    private const string MetadataAlias = "song_metadata_active";
    private const string NamedAlias = "songs_v2_active";
    private const string HybridAlias = "song_hybrid_active";
    private const string BasisId =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private const string BuildId = "89abcdef0123456789abcdef01234567";
    private const string BuildGeneration = $"{BasisId}:{BuildId}";

    [Fact]
    public async Task Probe_ReadsBothStoresConcurrentlyWithTheCallerToken()
    {
        var generationStarted = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var aliasesStarted = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        CancellationToken generationToken = default;
        CancellationToken aliasesToken = default;
        using var cancellation = new CancellationTokenSource();

        async Task<string> ReadGenerationAsync(CancellationToken cancellationToken)
        {
            generationToken = cancellationToken;
            generationStarted.TrySetResult(true);
            await aliasesStarted.Task.WaitAsync(cancellationToken);
            return BuildGeneration;
        }

        async Task<IReadOnlyDictionary<string, string>> ReadAliasesAsync(
            CancellationToken cancellationToken)
        {
            aliasesToken = cancellationToken;
            aliasesStarted.TrySetResult(true);
            await generationStarted.Task.WaitAsync(cancellationToken);
            const string suffix = "0123456789ab_89abcdef";
            return Targets(
                $"song_metadata_basis_{suffix}",
                $"songs_v2_basis_{suffix}",
                $"song_hybrid_basis_{suffix}");
        }

        var error = await ProbeAsync(
            ReadGenerationAsync,
            ReadAliasesAsync,
            cancellation.Token);

        Assert.Null(error);
        Assert.Equal(cancellation.Token, generationToken);
        Assert.Equal(cancellation.Token, aliasesToken);
    }

    [Fact]
    public async Task Probe_DoesNotCacheTheDatabaseGeneration()
    {
        var generationReads = 0;
        const string suffix = "0123456789ab_89abcdef";
        var targets = Targets(
            $"song_metadata_basis_{suffix}",
            $"songs_v2_basis_{suffix}",
            $"song_hybrid_basis_{suffix}");

        Task<string> ReadGenerationAsync(CancellationToken _) =>
            Task.FromResult(Interlocked.Increment(ref generationReads) == 1
                ? BuildGeneration
                : "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210:76543210fedcba9876543210fedcba98");
        Task<IReadOnlyDictionary<string, string>> ReadAliasesAsync(CancellationToken _) =>
            Task.FromResult<IReadOnlyDictionary<string, string>>(targets);

        Assert.Null(await ProbeAsync(
            ReadGenerationAsync,
            ReadAliasesAsync,
            CancellationToken.None));
        Assert.Equal(
            "RecommendationAliasGenerationMismatch",
            await ProbeAsync(
                ReadGenerationAsync,
                ReadAliasesAsync,
                CancellationToken.None));
        Assert.Equal(2, generationReads);
    }

    [Fact]
    public async Task Probe_PreCanceledRequest_DoesNotStartEitherStoreRead()
    {
        var generationReads = 0;
        var aliasReads = 0;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        Task<string> ReadGenerationAsync(CancellationToken _)
        {
            Interlocked.Increment(ref generationReads);
            return Task.FromResult("legacy");
        }

        Task<IReadOnlyDictionary<string, string>> ReadAliasesAsync(CancellationToken _)
        {
            Interlocked.Increment(ref aliasReads);
            return Task.FromResult<IReadOnlyDictionary<string, string>>(
                Targets("song_metadata", "songs_v2", "song_hybrid"));
        }

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ProbeAsync(
            ReadGenerationAsync,
            ReadAliasesAsync,
            cancellation.Token));
        Assert.Equal(0, generationReads);
        Assert.Equal(0, aliasReads);
    }

    [Fact]
    public void LegacyBootstrapTargets_AreAccepted()
    {
        var targets = Targets("song_metadata", "songs_v2", "song_hybrid");

        Assert.Null(Validate(targets, "legacy"));
    }

    [Fact]
    public void OneBuildSpecificGeneration_IsAccepted()
    {
        const string suffix = "0123456789ab_89abcdef";
        var targets = Targets(
            $"song_metadata_basis_{suffix}",
            $"songs_v2_basis_{suffix}",
            $"song_hybrid_basis_{suffix}");

        Assert.Null(Validate(targets, BuildGeneration));
    }

    [Fact]
    public void LegacyAliases_WithBuildDatabaseGeneration_AreRejected()
    {
        var targets = Targets("song_metadata", "songs_v2", "song_hybrid");

        Assert.Equal(
            "RecommendationAliasGenerationMismatch",
            Validate(targets, BuildGeneration));
    }

    [Fact]
    public void BuildAliases_WithLegacyDatabaseGeneration_AreRejected()
    {
        const string suffix = "0123456789ab_89abcdef";
        var targets = Targets(
            $"song_metadata_basis_{suffix}",
            $"songs_v2_basis_{suffix}",
            $"song_hybrid_basis_{suffix}");

        Assert.Equal(
            "RecommendationAliasGenerationMismatch",
            Validate(targets, "legacy"));
    }

    [Fact]
    public void InternallyCoherentAliases_FromAnotherDatabaseGeneration_AreRejected()
    {
        const string suffix = "fedcba987654_76543210";
        var targets = Targets(
            $"song_metadata_basis_{suffix}",
            $"songs_v2_basis_{suffix}",
            $"song_hybrid_basis_{suffix}");

        Assert.Equal(
            "RecommendationAliasGenerationMismatch",
            Validate(targets, BuildGeneration));
    }

    [Theory]
    [InlineData("")]
    [InlineData("LEGACY")]
    [InlineData(" legacy")]
    [InlineData("0123456789abcdef:89abcdef")]
    [InlineData("0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef:89abcdef0123456789abcdef01234567")]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:89ABCDEF0123456789abcdef01234567")]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef-89abcdef0123456789abcdef01234567")]
    public void MalformedDatabaseGeneration_IsRejected(string generation)
    {
        const string suffix = "0123456789ab_89abcdef";
        var targets = Targets(
            $"song_metadata_basis_{suffix}",
            $"songs_v2_basis_{suffix}",
            $"song_hybrid_basis_{suffix}");

        Assert.Equal(
            "RecommendationPublicationGenerationInvalid",
            Validate(targets, generation));
    }

    [Fact]
    public void MissingAlias_IsRejected()
    {
        var targets = Targets("song_metadata", "songs_v2", "song_hybrid");
        targets.Remove(HybridAlias);

        Assert.Equal("RecommendationAliasMissing", Validate(targets, "legacy"));
    }

    [Fact]
    public void MixedLegacyAndBuildTargets_AreRejected()
    {
        const string suffix = "0123456789ab_89abcdef";
        var targets = Targets(
            "song_metadata",
            $"songs_v2_basis_{suffix}",
            $"song_hybrid_basis_{suffix}");

        Assert.Equal("RecommendationAliasTargetInvalid", Validate(targets, BuildGeneration));
    }

    [Fact]
    public void DifferentBuildSuffixes_AreRejected()
    {
        var targets = Targets(
            "song_metadata_basis_0123456789ab_89abcdef",
            "songs_v2_basis_0123456789ab_89abcdef",
            "song_hybrid_basis_0123456789ab_76543210");

        Assert.Equal("RecommendationAliasGenerationMismatch", Validate(targets, BuildGeneration));
    }

    [Theory]
    [InlineData("0123456789AB_89abcdef")]
    [InlineData("0123456789ab-89abcdef")]
    [InlineData("0123456789ab_89abcde")]
    [InlineData("0123456789ab_89abcdef0")]
    public void InvalidBuildSuffix_IsRejected(string suffix)
    {
        var targets = Targets(
            $"song_metadata_basis_{suffix}",
            $"songs_v2_basis_{suffix}",
            $"song_hybrid_basis_{suffix}");

        Assert.Equal("RecommendationAliasGenerationMismatch", Validate(targets, BuildGeneration));
    }

    private static Dictionary<string, string> Targets(
        string metadata,
        string named,
        string hybrid) => new(StringComparer.Ordinal)
    {
        [MetadataAlias] = metadata,
        [NamedAlias] = named,
        [HybridAlias] = hybrid,
    };

    private static string? Validate(
        IReadOnlyDictionary<string, string> targets,
        string publicationGeneration) =>
        QdrantService.ValidateRecommendationAliasTargets(
            targets,
            MetadataAlias,
            NamedAlias,
            HybridAlias,
            publicationGeneration);

    private static Task<string?> ProbeAsync(
        Func<CancellationToken, Task<string>> readPublicationGeneration,
        Func<CancellationToken, Task<IReadOnlyDictionary<string, string>>> readAliasTargets,
        CancellationToken cancellationToken) =>
        QdrantService.ProbeRecommendationAliasGenerationAsync(
            readPublicationGeneration,
            readAliasTargets,
            MetadataAlias,
            NamedAlias,
            HybridAlias,
            cancellationToken);
}
