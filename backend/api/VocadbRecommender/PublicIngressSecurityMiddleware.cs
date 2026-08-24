using System.Security.Cryptography;
using System.Text;

namespace VocadbRecommender;

internal sealed class PublicIngressSecurityMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<PublicIngressSecurityMiddleware> _logger;
    private readonly string _pagesProxyKey;

    public PublicIngressSecurityMiddleware(
        RequestDelegate next,
        ILogger<PublicIngressSecurityMiddleware> logger,
        string pagesProxyKey)
    {
        _next = next;
        _logger = logger;
        _pagesProxyKey = pagesProxyKey;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        ApplyApiSecurityHeaders(context.Response.Headers);

        if (IsCloudflareIngress(context.Request.Headers)
            && !HasValidPagesProxyCredential(context.Request.Headers, _pagesProxyKey))
        {
            _logger.LogWarning(
                "cloudflare_ingress_rejected path={Path} traceId={TraceId}",
                context.Request.Path.Value,
                context.TraceIdentifier);
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new { error = "trusted Pages proxy required" });
            return;
        }

        await _next(context);
    }

    internal static bool IsCloudflareIngress(IHeaderDictionary headers) =>
        HasValue(headers, "CF-Connecting-IP")
        || HasValue(headers, "CF-Ray")
        || HasValue(headers, "CF-Visitor");

    internal static bool HasValidPagesProxyCredential(
        IHeaderDictionary headers,
        string pagesProxyKey)
    {
        if (string.IsNullOrEmpty(pagesProxyKey)
            || !string.Equals(headers["X-Diva-Pages-Proxy"], "1", StringComparison.Ordinal))
            return false;

        var suppliedKey = headers["X-Diva-Pages-Proxy-Key"].ToString();
        if (suppliedKey.Length != pagesProxyKey.Length) return false;
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(suppliedKey),
            Encoding.UTF8.GetBytes(pagesProxyKey));
    }

    private static bool HasValue(IHeaderDictionary headers, string name) =>
        !string.IsNullOrWhiteSpace(headers[name].ToString());

    private static void ApplyApiSecurityHeaders(IHeaderDictionary headers)
    {
        headers["X-Content-Type-Options"] = "nosniff";
        headers["X-Frame-Options"] = "DENY";
        headers["Referrer-Policy"] = "no-referrer";
        headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
    }
}
