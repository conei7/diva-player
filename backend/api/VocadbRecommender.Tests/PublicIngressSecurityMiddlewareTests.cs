using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using System.Text.Json;
using VocadbRecommender;

namespace VocadbRecommender.Tests;

public sealed class PublicIngressSecurityMiddlewareTests
{
    private const string ProxyKey = "test-pages-proxy-key";

    [Fact]
    public async Task DirectCloudflareIngressWithoutCredential_IsRejected()
    {
        var nextCalls = 0;
        var middleware = CreateMiddleware(_ =>
        {
            Interlocked.Increment(ref nextCalls);
            return Task.CompletedTask;
        });
        var context = CreateContext();
        context.Request.Headers["CF-Connecting-IP"] = "203.0.113.7";
        context.Request.Headers["CF-Ray"] = "fixture-ray";

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode);
        Assert.Equal(0, Volatile.Read(ref nextCalls));
        AssertSecurityHeaders(context.Response.Headers);
        context.Response.Body.Position = 0;
        using var payload = await JsonDocument.ParseAsync(context.Response.Body);
        Assert.Equal("trusted Pages proxy required", payload.RootElement.GetProperty("error").GetString());
    }

    [Fact]
    public async Task CloudflareIngressWithPagesCredential_IsAllowed()
    {
        var nextCalls = 0;
        var middleware = CreateMiddleware(context =>
        {
            Interlocked.Increment(ref nextCalls);
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return Task.CompletedTask;
        });
        var context = CreateContext();
        context.Request.Headers["CF-Connecting-IP"] = "203.0.113.7";
        context.Request.Headers["X-Diva-Pages-Proxy"] = "1";
        context.Request.Headers["X-Diva-Pages-Proxy-Key"] = ProxyKey;

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
        Assert.Equal(1, Volatile.Read(ref nextCalls));
        AssertSecurityHeaders(context.Response.Headers);
    }

    [Fact]
    public async Task LanIngressWithoutCloudflareHeaders_RemainsAvailable()
    {
        var nextCalls = 0;
        var middleware = CreateMiddleware(context =>
        {
            Interlocked.Increment(ref nextCalls);
            context.Response.StatusCode = StatusCodes.Status200OK;
            return Task.CompletedTask;
        });
        var context = CreateContext();
        context.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("192.168.40.20");

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(1, Volatile.Read(ref nextCalls));
        AssertSecurityHeaders(context.Response.Headers);
    }

    [Theory]
    [InlineData("", "test-pages-proxy-key")]
    [InlineData("1", "")]
    [InlineData("1", "wrong-key")]
    public void InvalidPagesCredential_IsRejected(string marker, string suppliedKey)
    {
        var headers = new HeaderDictionary
        {
            ["X-Diva-Pages-Proxy"] = marker,
            ["X-Diva-Pages-Proxy-Key"] = suppliedKey,
        };

        Assert.False(PublicIngressSecurityMiddleware.HasValidPagesProxyCredential(headers, ProxyKey));
    }

    private static PublicIngressSecurityMiddleware CreateMiddleware(RequestDelegate next) =>
        new(next, NullLogger<PublicIngressSecurityMiddleware>.Instance, ProxyKey);

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/ready";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static void AssertSecurityHeaders(IHeaderDictionary headers)
    {
        Assert.Equal("nosniff", headers["X-Content-Type-Options"]);
        Assert.Equal("DENY", headers["X-Frame-Options"]);
        Assert.Equal("no-referrer", headers["Referrer-Policy"]);
        Assert.Contains("camera=()", headers["Permissions-Policy"].ToString());
    }
}
