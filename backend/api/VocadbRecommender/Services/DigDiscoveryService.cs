using System.Text.Json;

namespace VocadbRecommender.Services;

/// <summary>
/// Builds the generated discovery mix from audio-vector neighbours only.
/// Producer relationships and favorite-producer catalogs are intentionally not
/// candidate sources here: producer repetition is handled as a soft sampling
/// preference, never as an inclusion cap.
/// </summary>
public sealed class DigDiscoveryService
{
    private const int MaxSeeds = 8;
    private const int CandidatesPerSeed = 240;
    private const double SamplingTemperature = 0.075;
    private const double RepeatProducerMultiplier = 0.55;

    private readonly DbService _db;
    private readonly QdrantService _qdrant;

    public DigDiscoveryService(DbService db, QdrantService qdrant)
    {
        _db = db;
        _qdrant = qdrant;
    }

    public async Task<DigDiscoveryResult> DiscoverAsync(
        IReadOnlyList<RecommendSeed> rawSeeds,
        IReadOnlySet<int> excludedSongIds,
        int generationSeed,
        int count,
        int offset,
        CancellationToken cancellationToken,
        DigGlobalFilterSettings? globalFilters = null)
    {
        var selectedSeeds = await SelectSeedsAsync(
            rawSeeds,
            generationSeed,
            cancellationToken);
        var scores = new Dictionary<int, double>();

        if (selectedSeeds.Count > 0)
        {
            var searches = await Task.WhenAll(selectedSeeds.Select(async seed => new
            {
                Seed = seed,
                Items = await _qdrant.SearchAudioOnlyAsync(
                    seed.SongId,
                    CandidatesPerSeed,
                    cancellationToken,
                    excludedSongIds),
            }));

            foreach (var search in searches)
            {
                // Use the best audio affinity to any taste seed. Summing across
                // seeds would favor catalog-dense artists that occur in several
                // neighbourhoods even when no individual match is exceptional.
                var seedStrength = 0.75 + Math.Clamp(search.Seed.Weight, 0.0, 1.0) * 0.25;
                foreach (var candidate in search.Items)
                {
                    if (excludedSongIds.Contains(candidate.SongId)) continue;
                    var affinity = candidate.Score * seedStrength;
                    scores[candidate.SongId] = Math.Max(
                        scores.GetValueOrDefault(candidate.SongId, double.NegativeInfinity),
                        affinity);
                }
            }
        }

        if (scores.Count == 0)
            scores = await LoadColdStartCandidatesAsync(
                excludedSongIds,
                cancellationToken);

        if (scores.Count == 0)
            return new DigDiscoveryResult([], 0);

        var infos = await _db.GetSongInfoBatchAsync(scores.Keys, cancellationToken);
        var eligibleInfos = infos
            .Where(info => DiscoveryEligibility.IsEligible(info)
                && info.HasAudioFeatures
                && MatchesGlobalFilters(info, globalFilters))
            .ToDictionary(info => info.Id);
        var eligibleScores = scores
            .Where(entry => eligibleInfos.ContainsKey(entry.Key))
            .ToDictionary(entry => entry.Key, entry => entry.Value);
        if (eligibleScores.Count == 0)
            return new DigDiscoveryResult([], 0);

        var orderedIds = SampleWithoutReplacement(
            eligibleScores,
            eligibleInfos,
            generationSeed,
            Math.Min(eligibleScores.Count, count + offset));
        return new DigDiscoveryResult(orderedIds.Skip(offset).Take(count).ToArray(), eligibleScores.Count);
    }

    private async Task<List<RecommendSeed>> SelectSeedsAsync(
        IReadOnlyList<RecommendSeed> rawSeeds,
        int generationSeed,
        CancellationToken cancellationToken)
    {
        var normalized = rawSeeds
            .Where(seed => seed.SongId > 0 && double.IsFinite(seed.Weight) && seed.Weight > 0)
            .GroupBy(seed => seed.SongId)
            .Select(group => new RecommendSeed(group.Key, Math.Clamp(group.Max(seed => seed.Weight), 0.05, 1.0)))
            .Take(24)
            .ToList();
        if (normalized.Count == 0) return [];

        var infos = await _db.GetSongInfoBatchAsync(
            normalized.Select(seed => seed.SongId),
            cancellationToken);
        var infoById = infos.ToDictionary(info => info.Id);

        // Weighted random keys make each generation explore different rated
        // seeds while retaining one representative per audio/state cluster.
        return normalized
            .Where(seed => infoById.TryGetValue(seed.SongId, out var info) && info.HasAudioFeatures)
            .Select(seed => new
            {
                Seed = seed,
                Cluster = infoById[seed.SongId].StateCluster >= 0
                    ? $"cluster:{infoById[seed.SongId].StateCluster}"
                    : $"song:{seed.SongId}",
                Key = WeightedRandomKey(generationSeed, seed.SongId, seed.Weight),
            })
            .GroupBy(item => item.Cluster)
            .Select(group => group.OrderBy(item => item.Key).First())
            .OrderBy(item => item.Key)
            .Take(MaxSeeds)
            .Select(item => item.Seed)
            .ToList();
    }

    private async Task<Dictionary<int, double>> LoadColdStartCandidatesAsync(
        IReadOnlySet<int> excludedSongIds,
        CancellationToken cancellationToken)
    {
        var fallback = await _db.SearchSongsAsync(
            query: null,
            artistIds: null,
            anyArtistIds: null,
            artistIdGroups: null,
            artistRole: null,
            songTypes: null,
            sort: "FavoritedTimes",
            order: "desc",
            start: 0,
            maxResults: 300,
            onlyWithPVs: true,
            voiceSynthOnly: true,
            discoveryOnly: true,
            cancellationToken: cancellationToken);
        var items = JsonSerializer.Deserialize<JsonElement[]>(fallback.ItemsJson) ?? [];
        return items.Select((item, index) => new
            {
                Id = item.TryGetProperty("id", out var idValue) && idValue.TryGetInt32(out var id) ? id : 0,
                // A shallow popularity curve keeps cold start dependable without
                // turning it into the same top-songs list on every generation.
                Score = 1.0 - Math.Min(0.45, index / 600.0),
            })
            .Where(item => item.Id > 0 && !excludedSongIds.Contains(item.Id))
            .ToDictionary(item => item.Id, item => item.Score);
    }

    private static int[] SampleWithoutReplacement(
        IReadOnlyDictionary<int, double> scores,
        IReadOnlyDictionary<int, SongInfo> infos,
        int generationSeed,
        int take)
    {
        var remaining = scores.Keys.OrderBy(id => id).ToList();
        var selected = new List<int>(take);
        var producerCounts = new Dictionary<int, int>();
        var maxScore = scores.Values.Max();

        for (var position = 0; position < take && remaining.Count > 0; position++)
        {
            var weighted = new List<(int SongId, double Weight)>(remaining.Count);
            double totalWeight = 0;
            foreach (var songId in remaining)
            {
                var info = infos[songId];
                var relevance = Math.Exp((scores[songId] - maxScore) / SamplingTemperature);
                var quality = Math.Sqrt(RecommendationQuality.EvidenceMultiplier(info));
                var popularity = SoftPopularityMultiplier(info);
                var repeatCount = info.ProducerIds
                    .Select(id => producerCounts.GetValueOrDefault(id))
                    .DefaultIfEmpty(0)
                    .Max();
                var novelty = Math.Pow(RepeatProducerMultiplier, repeatCount);
                var weight = Math.Max(1e-12, relevance * quality * popularity * novelty);
                weighted.Add((songId, weight));
                totalWeight += weight;
            }

            var threshold = SeededUnit(generationSeed, position + 1) * totalWeight;
            var cumulative = 0.0;
            var chosen = weighted[^1].SongId;
            foreach (var item in weighted)
            {
                cumulative += item.Weight;
                if (threshold <= cumulative)
                {
                    chosen = item.SongId;
                    break;
                }
            }

            selected.Add(chosen);
            remaining.Remove(chosen);
            foreach (var producerId in infos[chosen].ProducerIds.Distinct())
                producerCounts[producerId] = producerCounts.GetValueOrDefault(producerId) + 1;
        }

        return [.. selected];
    }

    // Popularity is only a tie-break-like prior: the logarithmic curve and
    // narrow 0.90-1.10 range keep obscure songs viable while making broadly
    // heard songs modestly more likely among similarly close audio matches.
    private static double SoftPopularityMultiplier(SongInfo info)
    {
        var effectiveViews = Math.Max(0L, info.YoutubeViews) + Math.Max(0L, info.NicoViews) * 3.0;
        var logViews = Math.Log10(1.0 + effectiveViews);
        var normalized = Math.Clamp((logViews - 3.0) / 3.0, 0.0, 1.0);
        return 0.90 + normalized * 0.20;
    }

    private static bool MatchesGlobalFilters(SongInfo info, DigGlobalFilterSettings? settings)
    {
        if (settings is null) return true;
        if (settings.MinYoutubeViews > 0 && info.YoutubeViews < settings.MinYoutubeViews) return false;
        if (settings.MinNicoViews > 0 && info.NicoViews < settings.MinNicoViews) return false;
        if (settings.ExcludedSongTypes.Contains(info.SongType)) return false;
        if (settings.VocalistGroups.Count == 0) return true;

        var vocalistIds = info.VocalistIds.ToHashSet();
        var matches = settings.VocalistGroups
            .Select(group => group.Any(vocalistIds.Contains))
            .ToArray();
        if (settings.VocalistMatchMode == "Any") return matches.Any(match => match);
        if (matches.Any(match => !match)) return false;
        if (settings.VocalistMatchMode != "Exact") return true;
        var allowedIds = settings.VocalistGroups.SelectMany(group => group).ToHashSet();
        return vocalistIds.All(allowedIds.Contains);
    }

    private static double WeightedRandomKey(int seed, int id, double weight) =>
        -Math.Log(Math.Max(1e-12, SeededUnit(seed ^ 0x51ed270b, id))) / Math.Max(0.05, weight);

    private static double SeededUnit(int seed, int value)
    {
        unchecked
        {
            var state = (uint)(seed * 1103515245 + value * 12345 + 0x6d2b79f5);
            state ^= state >> 15;
            state *= 2246822519u;
            state ^= state >> 13;
            return (state + 1.0) / (uint.MaxValue + 2.0);
        }
    }
}

public sealed record DigDiscoveryResult(int[] SongIds, int TotalCount);

public sealed record DigGlobalFilterSettings(
    long MinYoutubeViews,
    long MinNicoViews,
    IReadOnlySet<string> ExcludedSongTypes,
    IReadOnlyList<int[]> VocalistGroups,
    string VocalistMatchMode);
