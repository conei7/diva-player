using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using VocadbRecommender.Services;

namespace VocadbRecommender.Tests;

public sealed class KnowledgeMapAtlasTests
{
    [Theory]
    [InlineData("")]
    [InlineData("Youtube")]
    [InlineData("nico_views")]
    [InlineData("youtube; DROP TABLE songs")]
    public async Task InvalidPlatformIsRejectedBeforeOpeningDatabase(string platform)
    {
        using var objects = ObjectCache();
        using var searches = SearchCache();
        var db = Service(objects, searches);
        await Assert.ThrowsAsync<ArgumentException>(() => db.GetKnowledgeMapAtlasAsync(platform, CancellationToken.None));
    }

    [Fact]
    public async Task CachedCatalogKeepsEveryIndividualPairAndSeparatesPlatforms()
    {
        using var objects = ObjectCache();
        using var searches = SearchCache();
        var db = Service(objects, searches);
        var pairs = Enumerable.Range(1, 5000).SelectMany(id => new long[] { id, 5001 - id }).ToArray();
        var youtube = new KnowledgeMapAtlasData("youtube", DateTimeOffset.UtcNow, pairs);
        var nico = new KnowledgeMapAtlasData("nico", DateTimeOffset.UtcNow, [123, 4]);
        objects.Set("knowledge_atlas_v1_youtube", youtube, TimeSpan.FromMinutes(15), pairs.LongLength * sizeof(long) + 512);
        objects.Set("knowledge_atlas_v1_nico", nico, TimeSpan.FromMinutes(15), 528);
        Assert.Same(youtube, await db.GetKnowledgeMapAtlasAsync("youtube", CancellationToken.None));
        Assert.Same(nico, await db.GetKnowledgeMapAtlasAsync("nico", CancellationToken.None));
        var json = JsonSerializer.SerializeToElement(youtube, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(10000, json.GetProperty("songs").GetArrayLength());
        Assert.Equal(5000, json.GetProperty("songs")[9998].GetInt32());
        Assert.Equal(1, json.GetProperty("songs")[9999].GetInt32());
        Assert.Equal(new[] { "generatedAt", "platform", "songs" }, json.EnumerateObject().Select(property => property.Name).Order().ToArray());
    }

    private static DbService Service(RecommendationObjectCache objects, SearchResponseCache searches)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Postgres"] = "Host=127.0.0.1;Port=1;Username=test;Password=test;Database=test;Timeout=1",
        }).Build();
        return new DbService(configuration, new ApiDatabaseConnectionBudget(ApiBulkheadOptions.FromConfiguration(configuration)), objects, searches, Options.Create(new RecommenderOptions()));
    }
    private static RecommendationObjectCache ObjectCache() => new(Options.Create(new RecommenderOptions()), NullLogger<RecommendationObjectCache>.Instance);
    private static SearchResponseCache SearchCache() => new(Options.Create(new RecommenderOptions()), NullLogger<SearchResponseCache>.Instance);
}
