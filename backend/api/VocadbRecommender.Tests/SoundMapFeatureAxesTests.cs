namespace VocadbRecommender.Tests;

public sealed class SoundMapFeatureAxesTests
{
    private static SoundMapPoint Point(int id) => new(id, $"song {id}", "artist", 0, 0, .9, null);

    [Fact]
    public void SelectedFeaturesDriveCoordinatesAndPreserveRawValuesAndAudioSimilarity()
    {
        var (points, axes) = SoundMapEndpoints.ProjectFeatureAxes(
            [Point(1), Point(2), Point(3)],
            new Dictionary<int, (double, double)> { [1] = (.1, .8), [2] = (.3, .2), [3] = (.2, .5) }, 0, 1023);
        Assert.Equal(-1, points[0].X);
        Assert.Equal(-1, points[0].Y);
        Assert.Equal(1, points[1].X);
        Assert.Equal(1, points[1].Y);
        Assert.Equal(0, points[2].X, 10);
        Assert.Equal(.1, points[0].FeatureX);
        Assert.Equal(.9, points[0].Similarity);
        Assert.Equal(1023, axes.Y);
    }

    [Fact]
    public void ConstantFeaturesStayCenteredAndMissingOrNonfiniteCandidatesAreExcluded()
    {
        var (points, axes) = SoundMapEndpoints.ProjectFeatureAxes(
            [Point(1), Point(2), Point(3), Point(4)],
            new Dictionary<int, (double, double)> { [1] = (0, .2), [2] = (0, .2), [3] = (double.NaN, .2) }, 1, 2);
        Assert.Equal(2, points.Length);
        Assert.All(points, point => { Assert.Equal(0, point.X); Assert.Equal(0, point.Y); });
        Assert.Equal(axes.MinX, axes.MaxX);
    }
}
