using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace VocadbRecommender.Services;

/// <summary>
/// Validated search inputs in the exact form used by both SQL generation and
/// cache identity. Only inputs that are provably no-ops or order-insensitive
/// are canonicalized here.
/// </summary>
public sealed record SongSearchRequest(
    string? Query,
    int[]? ArtistIds,
    int[]? AnyArtistIds,
    int[][]? ArtistIdGroups,
    string? ArtistRole,
    string[]? SongTypes,
    string Sort,
    string Order,
    int Start,
    int MaxResults,
    int? PublishYearFrom,
    int? PublishYearTo,
    int? LengthMinSeconds,
    int? LengthMaxSeconds,
    string? PvService,
    string? AudioComputed,
    float? BpmFrom,
    float? BpmTo,
    string[]? InstrumentKeys,
    string InstrumentMatchMode,
    long? MinYoutubeViews,
    long? MinNicoViews,
    bool OnlyWithPVs,
    string[]? ExcludedSongTypes,
    bool VoiceSynthOnly,
    bool DiscoveryOnly,
    long? MaxYoutubeViews,
    long? MaxNicoViews,
    int? MinFavoritedTimes,
    int? MaxFavoritedTimes,
    int[]? TagIds,
    string TagMatchMode,
    int? CreditArtistId,
    string? CreditArtistRole,
    int RandomSeed,
    int[]? ExactVocalistIds,
    string? LyricsQuery,
    bool SelfCoverOnly,
    bool ChorusOnly)
{
    [JsonIgnore]
    public string CacheKey
    {
        get
        {
            var canonicalJson = JsonSerializer.SerializeToUtf8Bytes(this);
            return $"song-search:v3:{Convert.ToHexString(SHA256.HashData(canonicalJson))}";
        }
    }

    public static SongSearchRequest Create(
        string? query,
        IEnumerable<int>? artistIds,
        IEnumerable<int>? anyArtistIds,
        IEnumerable<IEnumerable<int>>? artistIdGroups,
        string? artistRole,
        IEnumerable<string>? songTypes,
        string sort,
        string order,
        int start,
        int maxResults,
        int? publishYearFrom = null,
        int? publishYearTo = null,
        int? lengthMinSeconds = null,
        int? lengthMaxSeconds = null,
        string? pvService = null,
        string? audioComputed = null,
        double? bpmFrom = null,
        double? bpmTo = null,
        IEnumerable<string>? instrumentKeys = null,
        string instrumentMatchMode = "all",
        long? minYoutubeViews = null,
        long? minNicoViews = null,
        bool onlyWithPVs = false,
        IEnumerable<string>? excludedSongTypes = null,
        bool voiceSynthOnly = false,
        bool discoveryOnly = false,
        long? maxYoutubeViews = null,
        long? maxNicoViews = null,
        int? minFavoritedTimes = null,
        int? maxFavoritedTimes = null,
        IEnumerable<int>? tagIds = null,
        string tagMatchMode = "all",
        int? creditArtistId = null,
        string? creditArtistRole = null,
        int randomSeed = 0,
        IEnumerable<int>? exactVocalistIds = null,
        string? lyricsQuery = null,
        bool selfCoverOnly = false,
        bool chorusOnly = false)
    {
        if (bpmFrom.HasValue && !double.IsFinite(bpmFrom.Value)
            || bpmTo.HasValue && !double.IsFinite(bpmTo.Value))
            throw new ArgumentOutOfRangeException(nameof(bpmFrom), "BPM values must be finite.");

        var normalizedSort = sort switch
        {
            "YoutubeViews" => "YoutubeViews",
            "NicoViews" => "NicoViews",
            "TotalViews" => "TotalViews",
            "FavoritedTimes" => "FavoritedTimes",
            "RatingScore" => "RatingScore",
            "PublishDate" => "PublishDate",
            "AdditionDate" => "AdditionDate",
            "Name" => "Name",
            "Random" => "Random",
            _ => "FavoritedTimes",
        };
        var normalizedCreditArtistId = creditArtistId;
        var normalizedInstrumentKeys = NormalizeStrings(instrumentKeys);
        var normalizedTagIds = NormalizeIds(tagIds);

        return new SongSearchRequest(
            Query: string.IsNullOrWhiteSpace(query) ? null : query,
            ArtistIds: NormalizeIds(artistIds),
            AnyArtistIds: NormalizeIds(anyArtistIds),
            ArtistIdGroups: NormalizeGroups(artistIdGroups),
            ArtistRole: string.IsNullOrWhiteSpace(artistRole) ? null : artistRole,
            SongTypes: NormalizeStrings(songTypes),
            Sort: normalizedSort,
            Order: string.Equals(order, "asc", StringComparison.OrdinalIgnoreCase) ? "asc" : "desc",
            Start: start,
            MaxResults: maxResults,
            PublishYearFrom: publishYearFrom,
            PublishYearTo: publishYearTo,
            LengthMinSeconds: lengthMinSeconds,
            LengthMaxSeconds: lengthMaxSeconds,
            PvService: pvService is "youtube" or "niconico" or "both" ? pvService : null,
            AudioComputed: audioComputed is "yes" or "no" ? audioComputed : null,
            BpmFrom: bpmFrom.HasValue ? (float)bpmFrom.Value : null,
            BpmTo: bpmTo.HasValue ? (float)bpmTo.Value : null,
            InstrumentKeys: normalizedInstrumentKeys,
            InstrumentMatchMode: normalizedInstrumentKeys is not null && instrumentMatchMode == "any" ? "any" : "all",
            MinYoutubeViews: minYoutubeViews is > 0 ? minYoutubeViews : null,
            MinNicoViews: minNicoViews is > 0 ? minNicoViews : null,
            OnlyWithPVs: onlyWithPVs,
            ExcludedSongTypes: NormalizeStrings(excludedSongTypes),
            VoiceSynthOnly: voiceSynthOnly,
            DiscoveryOnly: discoveryOnly,
            MaxYoutubeViews: maxYoutubeViews,
            MaxNicoViews: maxNicoViews,
            MinFavoritedTimes: minFavoritedTimes,
            MaxFavoritedTimes: maxFavoritedTimes,
            TagIds: normalizedTagIds,
            TagMatchMode: normalizedTagIds is not null && tagMatchMode == "any" ? "any" : "all",
            CreditArtistId: normalizedCreditArtistId,
            CreditArtistRole: normalizedCreditArtistId.HasValue && !string.IsNullOrWhiteSpace(creditArtistRole)
                ? creditArtistRole
                : null,
            RandomSeed: normalizedSort == "Random" ? randomSeed : 0,
            ExactVocalistIds: NormalizeIds(exactVocalistIds),
            LyricsQuery: NormalizeLyricsQuery(lyricsQuery),
            SelfCoverOnly: selfCoverOnly,
            ChorusOnly: chorusOnly);
    }

    private static int[]? NormalizeIds(IEnumerable<int>? values)
    {
        if (values is null) return null;
        var normalized = values.Distinct().Order().ToArray();
        return normalized.Length == 0 ? null : normalized;
    }

    private static string[]? NormalizeStrings(IEnumerable<string>? values)
    {
        if (values is null) return null;
        var normalized = values.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        return normalized.Length == 0 ? null : normalized;
    }

    private static int[][]? NormalizeGroups(IEnumerable<IEnumerable<int>>? groups)
    {
        if (groups is null) return null;
        var normalized = groups
            .Select(group => group.Distinct().Order().ToArray())
            .Where(group => group.Length > 0)
            .Order(ArrayLexicographicComparer.Instance)
            .ToArray();
        if (normalized.Length == 0) return null;

        var unique = new List<int[]>(normalized.Length);
        foreach (var group in normalized)
        {
            if (unique.Count == 0 || !unique[^1].SequenceEqual(group))
                unique.Add(group);
        }
        return [.. unique];
    }

    private static string? NormalizeLyricsQuery(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var normalized = value.Normalize(NormalizationForm.FormKC).ToLowerInvariant();
        return string.Join(' ', normalized.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }

    private sealed class ArrayLexicographicComparer : IComparer<int[]>
    {
        public static readonly ArrayLexicographicComparer Instance = new();

        public int Compare(int[]? left, int[]? right)
        {
            if (ReferenceEquals(left, right)) return 0;
            if (left is null) return -1;
            if (right is null) return 1;
            var sharedLength = Math.Min(left.Length, right.Length);
            for (var index = 0; index < sharedLength; index++)
            {
                var comparison = left[index].CompareTo(right[index]);
                if (comparison != 0) return comparison;
            }
            return left.Length.CompareTo(right.Length);
        }
    }
}
