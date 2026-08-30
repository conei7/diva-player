namespace VocadbRecommender.Services;

/// <summary>appsettings.json の Recommender セクション</summary>
public class RecommenderOptions
{
    public string QdrantEndpoint     { get; set; } = "http://localhost:6333";
    /// <summary>
    /// Optional REST endpoint used by health probes. Leave empty only when the
    /// gRPC endpoint uses Qdrant's conventional 6334/6333 port pair.
    /// </summary>
    public string QdrantRestEndpoint { get; set; } = "";
    public string CollectionHybrid   { get; set; } = "song_hybrid_active";
    public string CollectionMetadata { get; set; } = "song_metadata_active";
    /// <summary>Canonical audio-only vector collection updated by audio extraction.</summary>
    public string CollectionAudio    { get; set; } = "song_audio";
    /// <summary>Named Vectors コレクション (audio + meta を1つに格納)</summary>
    public string CollectionNamed    { get; set; } = "songs_v2_active";
    public int    AnnCandidates      { get; set; } = 240;  // ANN探索候補数
    public int    GraphWalkSteps     { get; set; } = 40;   // ランダムウォークステップ数
    public double GraphBias          { get; set; } = 0.85; // 同一プロデューサー側に留まる確率
    public double GraphScoreWeight   { get; set; } = 0.32; // 飽和後の知識グラフ寄与
    public double RelationshipScoreWeight { get; set; } = 0.24; // 非歌手タグ関係候補の寄与
    public double DiverseFallbackScoreWeight { get; set; } = 0.58; // 候補Pが極端に偏る場合の補完寄与
    public int    MarkovTopK         { get; set; } = 10;   // マルコフで残す上位K状態
    public double BaseDiversity      { get; set; } = 0.5;  // MMR基本多様性パラメータ λ
    public double ProducerDiversityWeight { get; set; } = 0.90;
    public double VocalistDiversityWeight { get; set; } = 0.60;
    /// <summary>Search and ranking response cache capacity in MiB.</summary>
    public int SearchCacheSizeMiB { get; set; } = 64;
    /// <summary>Maximum estimated size of one cached response in MiB.</summary>
    public int SearchCacheEntrySizeMiB { get; set; } = 8;
    /// <summary>Dedicated recommendation object cache capacity in MiB.</summary>
    public int ObjectCacheSizeMiB { get; set; } = 64;
    /// <summary>Maximum estimated size of one recommendation object cache entry in MiB.</summary>
    public int ObjectCacheEntrySizeMiB { get; set; } = 16;
    /// <summary>
    /// Maximum age of discovery-quality data before operational health fails.
    /// The primary keeps the 48-hour default; a snapshot-based DR environment
    /// may set a bounded value that matches its documented recovery-point objective.
    /// </summary>
    public int DiscoveryQualityMaxAgeHours { get; set; } = 48;
    /// <summary>Maximum age of incomplete audio-feature data before health fails.</summary>
    public int AudioFeatureMaxAgeHours { get; set; } = 72;
    /// <summary>Named Vectors ハイブリッド検索の音響重み (0〜1)</summary>
    public double AudioWeight        { get; set; } = 0.4;
    /// <summary>Named Vectors ハイブリッド検索のメタ重み (0〜1)</summary>
    public double MetaWeight         { get; set; } = 0.6;
}
