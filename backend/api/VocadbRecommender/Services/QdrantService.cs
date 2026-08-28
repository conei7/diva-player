using Qdrant.Client;
using Qdrant.Client.Grpc;
using Microsoft.Extensions.Options;
using System.Diagnostics;

namespace VocadbRecommender.Services;

/// <summary>Qdrant ベクトルデータベースサービス (ANN 近似最近傍探索)</summary>
public class QdrantService
{
    private readonly QdrantClient _client;
    private readonly RecommenderOptions _opts;
    private readonly Func<CancellationToken, Task<string>> _readPublicationGeneration;
    private readonly HttpClient _healthClient;
    private readonly Uri _healthUri;

    public QdrantService(IOptions<RecommenderOptions> opts, DbService db)
        : this(opts, db.ReadRecommendationPublicationGenerationUncachedAsync)
    {
    }

    internal QdrantService(
        IOptions<RecommenderOptions> opts,
        Func<CancellationToken, Task<string>> readPublicationGeneration)
    {
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentNullException.ThrowIfNull(readPublicationGeneration);
        _opts = opts.Value;
        _readPublicationGeneration = readPublicationGeneration;
        _client = new QdrantClient(new Uri(_opts.QdrantEndpoint));
        _healthUri = ResolveHealthUri(_opts);
        _healthClient = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
    }

    internal static Uri ResolveHealthUri(RecommenderOptions options)
    {
        var grpcEndpoint = new Uri(options.QdrantEndpoint);
        var configuredRestEndpoint = string.IsNullOrWhiteSpace(options.QdrantRestEndpoint)
            ? null
            : new Uri(options.QdrantRestEndpoint);
        var restEndpoint = configuredRestEndpoint ?? new UriBuilder(
            grpcEndpoint.Scheme,
            grpcEndpoint.Host,
            grpcEndpoint.Port == 6334 ? 6333 : grpcEndpoint.Port).Uri;
        return new UriBuilder(
            restEndpoint.Scheme,
            restEndpoint.Host,
            restEndpoint.Port,
            "healthz").Uri;
    }

    public async Task<DependencyHealth> CheckHealthAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var stopwatch = Stopwatch.StartNew();
        try
        {
            using var response = await _healthClient.GetAsync(_healthUri, cancellationToken);
            if (!response.IsSuccessStatusCode)
                return new DependencyHealth(false, stopwatch.ElapsedMilliseconds, $"HTTP {(int)response.StatusCode}");

            // A healthy Qdrant process is not sufficient for this API to serve
            // recommendations. Verify the stable aliases/collections used by
            // every search path so rolling-deployment candidates fail before
            // replacing a live slot when publication was not bootstrapped.
            var requiredCollections = new[]
            {
                _opts.CollectionNamed,
                _opts.CollectionHybrid,
                _opts.CollectionMetadata,
                _opts.CollectionAudio,
            }
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Distinct(StringComparer.Ordinal)
            .ToArray();

            var aliasError = await ProbeRecommendationAliasGenerationAsync(
                _readPublicationGeneration,
                ReadAliasTargetsAsync,
                _opts.CollectionMetadata,
                _opts.CollectionNamed,
                _opts.CollectionHybrid,
                cancellationToken);
            if (aliasError is not null)
            {
                return new DependencyHealth(
                    false,
                    stopwatch.ElapsedMilliseconds,
                    aliasError);
            }

            var collectionChecks = requiredCollections.Select(async collectionName =>
            {
                try
                {
                    await _client.GetCollectionInfoAsync(collectionName, cancellationToken);
                    return (CollectionName: collectionName, Error: (string?)null);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    return (CollectionName: collectionName, Error: exception.GetType().Name);
                }
            });

            var unavailable = (await Task.WhenAll(collectionChecks))
                .FirstOrDefault(result => result.Error is not null);
            return unavailable.Error is null
                ? new DependencyHealth(true, stopwatch.ElapsedMilliseconds)
                : new DependencyHealth(
                    false,
                    stopwatch.ElapsedMilliseconds,
                    $"CollectionUnavailable:{unavailable.CollectionName}:{unavailable.Error}");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return new DependencyHealth(false, stopwatch.ElapsedMilliseconds, exception.GetType().Name);
        }
    }

    private async Task<IReadOnlyDictionary<string, string>> ReadAliasTargetsAsync(
        CancellationToken cancellationToken)
    {
        var aliases = await _client.ListAliasesAsync(cancellationToken);
        return aliases.ToDictionary(
            alias => alias.AliasName,
            alias => alias.CollectionName,
            StringComparer.Ordinal);
    }

    internal static async Task<string?> ProbeRecommendationAliasGenerationAsync(
        Func<CancellationToken, Task<string>> readPublicationGeneration,
        Func<CancellationToken, Task<IReadOnlyDictionary<string, string>>> readAliasTargets,
        string metadataAlias,
        string namedAlias,
        string hybridAlias,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(readPublicationGeneration);
        ArgumentNullException.ThrowIfNull(readAliasTargets);
        cancellationToken.ThrowIfCancellationRequested();

        // Both stores belong to one logical readiness probe. A publication
        // boundary observed between these reads can only produce a mismatch,
        // so it fails closed until the next bounded background probe.
        var generationTask = readPublicationGeneration(cancellationToken);
        var aliasesTask = readAliasTargets(cancellationToken);
        await Task.WhenAll(generationTask, aliasesTask);
        return ValidateRecommendationAliasTargets(
            await aliasesTask,
            metadataAlias,
            namedAlias,
            hybridAlias,
            await generationTask);
    }

    internal static string? ValidateRecommendationAliasTargets(
        IReadOnlyDictionary<string, string> aliasTargets,
        string metadataAlias,
        string namedAlias,
        string hybridAlias,
        string publicationGeneration)
    {
        if (!aliasTargets.TryGetValue(metadataAlias, out var metadataTarget)
            || !aliasTargets.TryGetValue(namedAlias, out var namedTarget)
            || !aliasTargets.TryGetValue(hybridAlias, out var hybridTarget))
        {
            return "RecommendationAliasMissing";
        }

        // The bootstrap maps all stable aliases to the three legacy physical
        // collections. Later publications use one build-specific suffix for
        // all three. Any mixed/foreign target set is fail-closed: existence
        // alone cannot prove a coherent recommendation generation.
        var legacyTargets = metadataTarget == "song_metadata"
            && namedTarget == "songs_v2"
            && hybridTarget == "song_hybrid";
        if (string.Equals(publicationGeneration, "legacy", StringComparison.Ordinal))
        {
            return legacyTargets
                ? null
                : "RecommendationAliasGenerationMismatch";
        }

        static bool IsLowerHex(string value) => value.All(character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');
        const int basisIdLength = 64;
        const int buildIdLength = 32;
        if (string.IsNullOrEmpty(publicationGeneration)
            || publicationGeneration.Length != basisIdLength + 1 + buildIdLength
            || publicationGeneration[basisIdLength] != ':'
            || !IsLowerHex(publicationGeneration[..basisIdLength])
            || !IsLowerHex(publicationGeneration[(basisIdLength + 1)..]))
        {
            return "RecommendationPublicationGenerationInvalid";
        }

        if (legacyTargets)
            return "RecommendationAliasGenerationMismatch";

        const string metadataPrefix = "song_metadata_basis_";
        const string namedPrefix = "songs_v2_basis_";
        const string hybridPrefix = "song_hybrid_basis_";
        if (!metadataTarget.StartsWith(metadataPrefix, StringComparison.Ordinal)
            || !namedTarget.StartsWith(namedPrefix, StringComparison.Ordinal)
            || !hybridTarget.StartsWith(hybridPrefix, StringComparison.Ordinal))
        {
            return "RecommendationAliasTargetInvalid";
        }

        var metadataSuffix = metadataTarget[metadataPrefix.Length..];
        var namedSuffix = namedTarget[namedPrefix.Length..];
        var hybridSuffix = hybridTarget[hybridPrefix.Length..];
        if (metadataSuffix.Length != 21
            || metadataSuffix[12] != '_'
            || !IsLowerHex(metadataSuffix[..12])
            || !IsLowerHex(metadataSuffix[13..])
            || !string.Equals(metadataSuffix, namedSuffix, StringComparison.Ordinal)
            || !string.Equals(metadataSuffix, hybridSuffix, StringComparison.Ordinal))
        {
            return "RecommendationAliasGenerationMismatch";
        }

        var buildIdStart = basisIdLength + 1;
        var expectedSuffix =
            $"{publicationGeneration[..12]}_{publicationGeneration[buildIdStart..(buildIdStart + 8)]}";
        if (!string.Equals(metadataSuffix, expectedSuffix, StringComparison.Ordinal))
            return "RecommendationAliasGenerationMismatch";

        return null;
    }

    /// <summary>
    /// Named Vectors コレクション (songs_v2) で ANN 探索を行う。
    /// audio と meta の両方のベクトルを使った加重平均スコアで結果をランキング。
    /// どちらかのベクトルが存在しない場合は利用可能な方のみで探索する。
    /// </summary>
    public async Task<List<(int SongId, double Score)>> SearchNamedVectorsAsync(
        int seedSongId,
        int topK,
        CancellationToken cancellationToken,
        IEnumerable<int>? excludeIds = null,
        int offset = 0)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var excludeSet = excludeIds?.ToHashSet() ?? [];
        excludeSet.Add(seedSongId);

        // シード曲の Named Vectors を取得
        var retrieveResult = await _client.RetrieveAsync(
            collectionName: _opts.CollectionNamed,
            ids: new[] { new PointId { Num = (ulong)seedSongId } },
            withPayload: false,
            withVectors: true,
            cancellationToken: cancellationToken);

        var seedPoint = retrieveResult.FirstOrDefault();
        if (seedPoint is null || seedPoint.Vectors is null)
            return [];

        float[]? audioVec = null;
        float[]? metaVec  = null;

        if (seedPoint.Vectors.Vectors_?.Vectors.TryGetValue("audio", out var av) == true)
            audioVec = av.Data.ToArray();
        if (seedPoint.Vectors.Vectors_?.Vectors.TryGetValue("meta", out var mv) == true)
            metaVec = mv.Data.ToArray();

        var fetch = (int)(offset + topK + excludeSet.Count + 10);

        // The two named-vector searches are independent. Keep their result
        // dictionaries separate so the existing deterministic merge is unchanged.
        async Task<Dictionary<ulong, double>> SearchNamedVectorAsync(
            float[]? vector,
            string vectorName)
        {
            var results = new Dictionary<ulong, double>();
            if (vector is null || !vector.Any(value => value != 0f))
                return results;

            var response = await _client.SearchAsync(
                collectionName: _opts.CollectionNamed,
                vector: vector,
                vectorName: vectorName,
                limit: (ulong)fetch,
                cancellationToken: cancellationToken);
            foreach (var point in response)
                results[point.Id.Num] = point.Score;
            return results;
        }

        var audioSearchTask = SearchNamedVectorAsync(audioVec, "audio");
        var metaSearchTask = SearchNamedVectorAsync(metaVec, "meta");
        await Task.WhenAll(audioSearchTask, metaSearchTask);
        var audioResults = await audioSearchTask;
        var metaResults = await metaSearchTask;

        // スコアをマージ (audio × AudioWeight + meta × MetaWeight)
        var allIds = audioResults.Keys.Union(metaResults.Keys);
        var merged = allIds
            .Where(id => !excludeSet.Contains((int)id))
            .Select(id =>
            {
                double score = 0;
                double w = 0;
                if (audioResults.TryGetValue(id, out var aScore))
                { score += aScore * _opts.AudioWeight; w += _opts.AudioWeight; }
                if (metaResults.TryGetValue(id, out var mScore))
                { score += mScore * _opts.MetaWeight; w += _opts.MetaWeight; }
                return ((int)id, w > 0 ? score / w : 0.0);
            })
            .OrderByDescending(x => x.Item2)
            .Skip(offset)
            .Take(topK)
            .ToList();

        return merged;
    }

    /// <summary>
    /// ハイブリッドコレクションで ANN 探索を行い、
    /// 類似度スコア付きの候補 (songId, score) リストを返す。
    /// songs_v2 が利用可能な場合は Named Vectors を優先使用する。
    /// </summary>
    public async Task<List<(int SongId, double Score)>> SearchSimilarAsync(
        int seedSongId,
        int topK,
        CancellationToken cancellationToken,
        IEnumerable<int>? excludeIds = null,
        int offset = 0)
    {
        cancellationToken.ThrowIfCancellationRequested();
        // Named Vectors コレクションが利用可能な場合はそちらを優先
        try
        {
            var namedResult = await SearchNamedVectorsAsync(
                seedSongId,
                topK,
                cancellationToken,
                excludeIds,
                offset);
            if (namedResult.Count > 0)
                return namedResult;
        }
        catch when (!cancellationToken.IsCancellationRequested) { /* フォールバック */ }

        var excludeSet = excludeIds?.ToHashSet() ?? [];
        excludeSet.Add(seedSongId);

        // フォールバック: ハイブリッドコレクション
        var retrieveResult = await _client.RetrieveAsync(
            collectionName: _opts.CollectionHybrid,
            ids: new[] { new PointId { Num = (ulong)seedSongId } },
            withPayload: false,
            withVectors: true,
            cancellationToken: cancellationToken);

        var getResult = retrieveResult.FirstOrDefault();
        if (getResult is null || getResult.Vectors is null)
            return [];

        var seedVector = getResult.Vectors.Vector.Data.ToArray();

        var searchResult = await _client.SearchAsync(
            collectionName: _opts.CollectionHybrid,
            vector: seedVector,
            limit: (ulong)(offset + topK + excludeSet.Count + 10),
            cancellationToken: cancellationToken);

        return searchResult
            .Where(r => !excludeSet.Contains((int)r.Id.Num))
            .Skip(offset)
            .Take(topK)
            .Select(r => ((int)r.Id.Num, (double)r.Score))
            .ToList();
    }

    /// <summary>
    /// Canonical audio vector collectionで探索 (deep dig)
    /// </summary>
    public async Task<List<(int SongId, double Score)>> SearchAudioOnlyAsync(
        int seedSongId,
        int topK,
        CancellationToken cancellationToken,
        IEnumerable<int>? excludeIds = null,
        int offset = 0)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var excludeSet = excludeIds?.ToHashSet() ?? [];
        excludeSet.Add(seedSongId);

        // Audio extraction publishes to the canonical song_audio collection
        // before the generation-scoped named collection is incrementally
        // refreshed. Querying the canonical source avoids returning an empty
        // result for newly analyzed songs during that safe publication gap.
        var retrieveResult = await _client.RetrieveAsync(
            collectionName: _opts.CollectionAudio,
            ids: new[] { new PointId { Num = (ulong)seedSongId } },
            withPayload: false,
            withVectors: true,
            cancellationToken: cancellationToken);

        var seedPoint = retrieveResult.FirstOrDefault();
        if (seedPoint is null || seedPoint.Vectors is null)
            return [];

        var audioVec = seedPoint.Vectors.Vector?.Data.ToArray() ?? [];
        if (!audioVec.Any(x => x != 0f))
            return []; // 音響特徴なし

        var fetch = (int)(offset + topK + excludeSet.Count + 10);
        var res = await _client.SearchAsync(
            collectionName: _opts.CollectionAudio,
            vector: audioVec,
            limit: (ulong)fetch,
            cancellationToken: cancellationToken);

        return res
            .Where(r => !excludeSet.Contains((int)r.Id.Num))
            .Skip(offset)
            .Take(topK)
            .Select(r => ((int)r.Id.Num, (double)r.Score))
            .ToList();
    }

    /// <summary>
    /// メタデータコレクションを使った探索 (音響未処理曲のフォールバック)
    /// </summary>
    public async Task<List<(int SongId, double Score)>> SearchMetadataSimilarAsync(
        int seedSongId,
        int topK,
        CancellationToken cancellationToken,
        IEnumerable<int>? excludeIds = null,
        int offset = 0)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var excludeSet = excludeIds?.ToHashSet() ?? [];
        excludeSet.Add(seedSongId);

        var retrieveResult = await _client.RetrieveAsync(
            collectionName: _opts.CollectionMetadata,
            ids: new[] { new PointId { Num = (ulong)seedSongId } },
            withPayload: false,
            withVectors: true,
            cancellationToken: cancellationToken);

        var getResult = retrieveResult.FirstOrDefault();
        if (getResult is null || getResult.Vectors is null)
            return [];

        var seedVector = getResult.Vectors.Vector.Data.ToArray();

        var searchResult = await _client.SearchAsync(
            collectionName: _opts.CollectionMetadata,
            vector: seedVector,
            limit: (ulong)(offset + topK + excludeSet.Count + 10),
            cancellationToken: cancellationToken);

        return searchResult
            .Where(r => !excludeSet.Contains((int)r.Id.Num))
            .Skip(offset)
            .Take(topK)
            .Select(r => ((int)r.Id.Num, (double)r.Score))
            .ToList();
    }
}
