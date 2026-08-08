using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class SongSearchRequestTests
{
    [Fact]
    public void Create_CanonicalizesOnlyOrderInsensitiveInputs()
    {
        var first = Create(
            query: "%Miku_ ",
            artistIds: [9, 3, 9],
            anyArtistIds: [7, 2, 7],
            artistIdGroups: [[8, 4, 8], [3], [4, 8]],
            songTypes: ["Original", "Cover", "Original"],
            instrumentKeys: ["piano", "guitar", "piano"],
            excludedSongTypes: ["DramaPV", "Other", "DramaPV"],
            tagIds: [12, 5, 12],
            exactVocalistIds: [90, 20, 90],
            minYoutubeViews: 0,
            minNicoViews: 0,
            randomSeed: 42,
            creditArtistRole: "Composer");
        var second = Create(
            query: "%Miku_ ",
            artistIds: [3, 9],
            anyArtistIds: [2, 7],
            artistIdGroups: [[3], [4, 8]],
            songTypes: ["Cover", "Original"],
            instrumentKeys: ["guitar", "piano"],
            excludedSongTypes: ["Other", "DramaPV"],
            tagIds: [5, 12],
            exactVocalistIds: [20, 90],
            randomSeed: 7,
            creditArtistRole: "Lyricist");

        Assert.Equal(first.CacheKey, second.CacheKey);
        Assert.NotNull(first.ArtistIds);
        Assert.NotNull(first.AnyArtistIds);
        Assert.NotNull(first.ArtistIdGroups);
        Assert.NotNull(first.SongTypes);
        Assert.Equal([3, 9], first.ArtistIds);
        Assert.Equal([2, 7], first.AnyArtistIds);
        Assert.Equal(new[] { new[] { 3 }, new[] { 4, 8 } }, first.ArtistIdGroups);
        Assert.Equal(["Cover", "Original"], first.SongTypes);
        Assert.Equal("%Miku_ ", first.Query);
        Assert.Null(first.MinYoutubeViews);
        Assert.Null(first.MinNicoViews);
        Assert.Equal(0, first.RandomSeed);
        Assert.Null(first.CreditArtistRole);
    }

    [Fact]
    public void Create_PreservesMeaningfulQueryTextAndNumericZeroes()
    {
        Assert.NotEqual(Create(query: "Miku").CacheKey, Create(query: "miku").CacheKey);
        Assert.NotEqual(Create(query: "Miku").CacheKey, Create(query: " Miku ").CacheKey);
        Assert.Equal(Create(query: null).CacheKey, Create(query: " \t ").CacheKey);
        Assert.Equal("%_", Create(query: "%_").Query);

        Assert.NotEqual(Create(maxYoutubeViews: null).CacheKey, Create(maxYoutubeViews: 0).CacheKey);
        Assert.NotEqual(Create(minFavoritedTimes: null).CacheKey, Create(minFavoritedTimes: 0).CacheKey);
        Assert.NotEqual(Create(lengthMinSeconds: null).CacheKey, Create(lengthMinSeconds: 0).CacheKey);
    }

    [Fact]
    public void Create_PreservesArtistGroupAndFallbackSemantics()
    {
        Assert.NotEqual(
            Create(artistIdGroups: [[1, 2], [3]]).CacheKey,
            Create(artistIdGroups: [[1, 2, 3]]).CacheKey);

        var fallback = Create(
            sort: "youtubeviews",
            order: "ASC",
            pvService: "YouTube",
            audioComputed: "YES",
            instrumentMatchMode: "ANY",
            tagMatchMode: "ANY");
        Assert.Equal("FavoritedTimes", fallback.Sort);
        Assert.Equal("asc", fallback.Order);
        Assert.Null(fallback.PvService);
        Assert.Null(fallback.AudioComputed);
        Assert.Equal("all", fallback.InstrumentMatchMode);
        Assert.Equal("all", fallback.TagMatchMode);

        Assert.Equal(
            Create(sort: "unknown", randomSeed: 1).CacheKey,
            Create(sort: "FavoritedTimes", randomSeed: 99).CacheKey);
        Assert.NotEqual(
            Create(sort: "Random", randomSeed: 1).CacheKey,
            Create(sort: "Random", randomSeed: 2).CacheKey);
    }

    [Fact]
    public void Create_DropsMatchModesWhenTheirFilterIsEmpty()
    {
        var defaults = Create();
        var noOpModes = Create(instrumentMatchMode: "any", tagMatchMode: "any");

        Assert.Equal(defaults.CacheKey, noOpModes.CacheKey);
        Assert.Equal("all", noOpModes.InstrumentMatchMode);
        Assert.Equal("all", noOpModes.TagMatchMode);
        Assert.NotEqual(
            Create(instrumentKeys: ["piano"], instrumentMatchMode: "all").CacheKey,
            Create(instrumentKeys: ["piano"], instrumentMatchMode: "any").CacheKey);
        Assert.NotEqual(
            Create(tagIds: [1], tagMatchMode: "all").CacheKey,
            Create(tagIds: [1], tagMatchMode: "any").CacheKey);
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    public void Create_RejectsNonFiniteBpm(double value)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => Create(bpmFrom: value));
        Assert.Throws<ArgumentOutOfRangeException>(() => Create(bpmTo: value));
    }

    private static SongSearchRequest Create(
        string? query = null,
        IEnumerable<int>? artistIds = null,
        IEnumerable<int>? anyArtistIds = null,
        IEnumerable<IEnumerable<int>>? artistIdGroups = null,
        IEnumerable<string>? songTypes = null,
        string sort = "FavoritedTimes",
        string order = "desc",
        int? lengthMinSeconds = null,
        string? pvService = null,
        string? audioComputed = null,
        double? bpmFrom = null,
        double? bpmTo = null,
        IEnumerable<string>? instrumentKeys = null,
        string instrumentMatchMode = "all",
        long? minYoutubeViews = null,
        long? minNicoViews = null,
        IEnumerable<string>? excludedSongTypes = null,
        long? maxYoutubeViews = null,
        int? minFavoritedTimes = null,
        IEnumerable<int>? tagIds = null,
        string tagMatchMode = "all",
        int? creditArtistId = null,
        string? creditArtistRole = null,
        int randomSeed = 0,
        IEnumerable<int>? exactVocalistIds = null)
        => SongSearchRequest.Create(
            query,
            artistIds,
            anyArtistIds,
            artistIdGroups,
            artistRole: null,
            songTypes,
            sort,
            order,
            start: 0,
            maxResults: 24,
            lengthMinSeconds: lengthMinSeconds,
            pvService: pvService,
            audioComputed: audioComputed,
            bpmFrom: bpmFrom,
            bpmTo: bpmTo,
            instrumentKeys: instrumentKeys,
            instrumentMatchMode: instrumentMatchMode,
            minYoutubeViews: minYoutubeViews,
            minNicoViews: minNicoViews,
            excludedSongTypes: excludedSongTypes,
            maxYoutubeViews: maxYoutubeViews,
            minFavoritedTimes: minFavoritedTimes,
            tagIds: tagIds,
            tagMatchMode: tagMatchMode,
            creditArtistId: creditArtistId,
            creditArtistRole: creditArtistRole,
            randomSeed: randomSeed,
            exactVocalistIds: exactVocalistIds);
}
