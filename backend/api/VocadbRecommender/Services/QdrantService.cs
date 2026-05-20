using Qdrant.Client;
using Qdrant.Client.Grpc;
using Microsoft.Extensions.Options;

namespace VocadbRecommender.Services;

/// <summary>Qdrant ベクトルデータベースサービス (ANN 近似最近傍探索)</summary>
public class QdrantService
{
    private readonly QdrantClient _client;
    private readonly RecommenderOptions _opts;

    public QdrantService(IOptions<RecommenderOptions> opts)
    {
        _opts = opts.Value;
        _client = new QdrantClient(new Uri(_opts.QdrantEndpoint));
    }

    /// <summary>
    /// Named Vectors コレクション (songs_v2) で ANN 探索を行う。
    /// audio と meta の両方のベクトルを使った加重平均スコアで結果をランキング。
    /// どちらかのベクトルが存在しない場合は利用可能な方のみで探索する。
    /// </summary>
    public async Task<List<(int SongId, double Score)>> SearchNamedVectorsAsync(
        int seedSongId,
        int topK,
        IEnumerable<int>? excludeIds = null,
        int offset = 0)
    {
        var excludeSet = excludeIds?.ToHashSet() ?? [];
        excludeSet.Add(seedSongId);

        // シード曲の Named Vectors を取得
        var retrieveResult = await _client.RetrieveAsync(
            collectionName: _opts.CollectionNamed,
            ids: new[] { new PointId { Num = (ulong)seedSongId } },
            withPayload: false,
            withVectors: true);

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

        // audio と meta の両方を検索してスコアをマージ
        var audioResults = new Dictionary<ulong, double>();
        var metaResults  = new Dictionary<ulong, double>();

        if (audioVec is not null && audioVec.Any(x => x != 0f))
        {
            var res = await _client.SearchAsync(
                collectionName: _opts.CollectionNamed,
                vector: audioVec,
                vectorName: "audio",
                limit: (ulong)fetch);
            foreach (var r in res)
                audioResults[r.Id.Num] = r.Score;
        }

        if (metaVec is not null && metaVec.Any(x => x != 0f))
        {
            var res = await _client.SearchAsync(
                collectionName: _opts.CollectionNamed,
                vector: metaVec,
                vectorName: "meta",
                limit: (ulong)fetch);
            foreach (var r in res)
                metaResults[r.Id.Num] = r.Score;
        }

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
        IEnumerable<int>? excludeIds = null,
        int offset = 0)
    {
        // Named Vectors コレクションが利用可能な場合はそちらを優先
        try
        {
            var namedResult = await SearchNamedVectorsAsync(seedSongId, topK, excludeIds, offset);
            if (namedResult.Count > 0)
                return namedResult;
        }
        catch { /* フォールバック */ }

        var excludeSet = excludeIds?.ToHashSet() ?? [];
        excludeSet.Add(seedSongId);

        // フォールバック: ハイブリッドコレクション
        var retrieveResult = await _client.RetrieveAsync(
            collectionName: _opts.CollectionHybrid,
            ids: new[] { new PointId { Num = (ulong)seedSongId } },
            withPayload: false,
            withVectors: true);

        var getResult = retrieveResult.FirstOrDefault();
        if (getResult is null || getResult.Vectors is null)
            return [];

        var seedVector = getResult.Vectors.Vector.Data.ToArray();

        var searchResult = await _client.SearchAsync(
            collectionName: _opts.CollectionHybrid,
            vector: seedVector,
            limit: (ulong)(offset + topK + excludeSet.Count + 10));

        return searchResult
            .Where(r => !excludeSet.Contains((int)r.Id.Num))
            .Skip(offset)
            .Take(topK)
            .Select(r => ((int)r.Id.Num, (double)r.Score))
            .ToList();
    }

    /// <summary>
    /// Named Vectors コレクションの audio ベクトルのみで探索 (deep dig)
    /// </summary>
    public async Task<List<(int SongId, double Score)>> SearchAudioOnlyAsync(
        int seedSongId,
        int topK,
        IEnumerable<int>? excludeIds = null,
        int offset = 0)
    {
        var excludeSet = excludeIds?.ToHashSet() ?? [];
        excludeSet.Add(seedSongId);

        var retrieveResult = await _client.RetrieveAsync(
            collectionName: _opts.CollectionNamed,
            ids: new[] { new PointId { Num = (ulong)seedSongId } },
            withPayload: false,
            withVectors: true);

        var seedPoint = retrieveResult.FirstOrDefault();
        if (seedPoint is null || seedPoint.Vectors is null)
            return [];

        var namedVecs = seedPoint.Vectors.Vectors_?.Vectors;
        if (namedVecs is null || !namedVecs.TryGetValue("audio", out var av))
            return [];

        var audioVec = av.Data.ToArray();
        if (!audioVec.Any(x => x != 0f))
            return []; // 音響特徴なし

        var fetch = (int)(offset + topK + excludeSet.Count + 10);
        var res = await _client.SearchAsync(
            collectionName: _opts.CollectionNamed,
            vector: audioVec,
            vectorName: "audio",
            limit: (ulong)fetch);

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
        IEnumerable<int>? excludeIds = null,
        int offset = 0)
    {
        var excludeSet = excludeIds?.ToHashSet() ?? [];
        excludeSet.Add(seedSongId);

        var retrieveResult = await _client.RetrieveAsync(
            collectionName: _opts.CollectionMetadata,
            ids: new[] { new PointId { Num = (ulong)seedSongId } },
            withPayload: false,
            withVectors: true);

        var getResult = retrieveResult.FirstOrDefault();
        if (getResult is null || getResult.Vectors is null)
            return [];

        var seedVector = getResult.Vectors.Vector.Data.ToArray();

        var searchResult = await _client.SearchAsync(
            collectionName: _opts.CollectionMetadata,
            vector: seedVector,
            limit: (ulong)(offset + topK + excludeSet.Count + 10));

        return searchResult
            .Where(r => !excludeSet.Contains((int)r.Id.Num))
            .Skip(offset)
            .Take(topK)
            .Select(r => ((int)r.Id.Num, (double)r.Score))
            .ToList();
    }
}
