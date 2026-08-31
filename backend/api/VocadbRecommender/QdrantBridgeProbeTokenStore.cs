using System.Security.Cryptography;
using System.Text;

namespace VocadbRecommender;

internal static class QdrantBridgeProbeTokenStore
{
    private const int TokenLength = 64;
    private const int TokenFileLength = TokenLength + 1;
    private const string ClaimSuffix = ".consuming";
    private static readonly object ConsumeGate = new();

    internal static string? Read(string path, bool enforceUnixFileContract = true)
    {
        try
        {
            using var stream = OpenValidated(path, enforceUnixFileContract);
            return stream is null ? null : ReadToken(stream);
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    internal static bool TryConsume(
        string path,
        string suppliedToken,
        bool enforceUnixFileContract = true)
    {
        if (!IsToken(suppliedToken)) return false;
        lock (ConsumeGate)
        {
            return TryConsumeCore(path, suppliedToken, enforceUnixFileContract);
        }
    }

    private static bool TryConsumeCore(
        string path,
        string suppliedToken,
        bool enforceUnixFileContract)
    {
        var claimPath = path + ClaimSuffix;
        var claimed = false;
        try
        {
            File.Move(path, claimPath, overwrite: false);
            claimed = true;
            var stream = OpenValidated(claimPath, enforceUnixFileContract);
            if (stream is null) return false;
            string? expectedToken;
            using (stream)
            {
                expectedToken = ReadToken(stream);
            }
            if (expectedToken is null) return false;
            if (!FixedTimeEquals(suppliedToken, expectedToken))
            {
                File.Move(claimPath, path, overwrite: false);
                claimed = false;
                return false;
            }
            File.Delete(claimPath);
            if (!IsAbsentAndNotLink(claimPath)) return false;
            claimed = false;
            return true;
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
        finally
        {
            if (claimed) DeleteExactClaim(claimPath, enforceUnixFileContract);
        }
    }

    internal static bool CleanupStaleClaim(
        string path,
        bool enforceUnixFileContract = true)
    {
        var claimPath = path + ClaimSuffix;
        if (IsAbsentAndNotLink(claimPath)) return true;
        return DeleteExactClaim(claimPath, enforceUnixFileContract);
    }

    private static FileStream? OpenValidated(string path, bool enforceUnixFileContract)
    {
        if (enforceUnixFileContract && !OperatingSystem.IsLinux()) return null;
        var before = new FileInfo(path);
        before.Refresh();
        if (!before.Exists || before.LinkTarget is not null || before.Length != TokenFileLength)
            return null;
        if (enforceUnixFileContract
            && File.GetUnixFileMode(path) != UnixFileMode.UserRead)
            return null;
        var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.None,
            bufferSize: TokenFileLength,
            FileOptions.SequentialScan);
        var after = new FileInfo(path);
        after.Refresh();
        if (!after.Exists || after.LinkTarget is not null || after.Length != TokenFileLength
            || stream.Length != TokenFileLength
            || (enforceUnixFileContract
                && File.GetUnixFileMode(path) != UnixFileMode.UserRead))
        {
            stream.Dispose();
            return null;
        }
        return stream;
    }

    private static string? ReadToken(Stream stream)
    {
        Span<byte> buffer = stackalloc byte[TokenFileLength + 1];
        var total = 0;
        while (total < buffer.Length)
        {
            var read = stream.Read(buffer[total..]);
            if (read == 0) break;
            total += read;
        }
        if (total != TokenFileLength || buffer[TokenLength] != (byte)'\n') return null;
        var token = Encoding.ASCII.GetString(buffer[..TokenLength]);
        return IsToken(token) ? token : null;
    }

    private static bool DeleteExactClaim(string claimPath, bool enforceUnixFileContract)
    {
        try
        {
            var stream = OpenValidated(claimPath, enforceUnixFileContract);
            if (stream is null) return false;
            string? token;
            using (stream)
            {
                token = ReadToken(stream);
            }
            if (token is null) return false;
            File.Delete(claimPath);
            return IsAbsentAndNotLink(claimPath);
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool IsAbsentAndNotLink(string path)
    {
        if (File.Exists(path) || Directory.Exists(path)) return false;
        try
        {
            return new FileInfo(path).LinkTarget is null;
        }
        catch (FileNotFoundException)
        {
            return true;
        }
        catch (DirectoryNotFoundException)
        {
            return true;
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool IsToken(string token) =>
        token.Length == TokenLength
        && token.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool FixedTimeEquals(string left, string right) =>
        left.Length == right.Length
        && CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(left),
            Encoding.ASCII.GetBytes(right));
}
