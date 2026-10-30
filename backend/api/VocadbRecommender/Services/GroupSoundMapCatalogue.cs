using System.Runtime.InteropServices;

namespace VocadbRecommender.Services;

/// <summary>Unlinked, disk-backed blocks. Only the requested two columns enter managed memory.</summary>
internal sealed class GroupSoundMapCatalogue : IDisposable
{
    internal const string CacheDirectory = "/var/cache/diva-player/group-map";
    private sealed record Block(int[] Ids, long Offset);
    private readonly FileStream _file;
    private readonly Block[] _blocks;
    private int _references = 1;
    private int _ownerReleased;
    public int Count { get; }

    private GroupSoundMapCatalogue(FileStream file, Block[] blocks, int count)
    {
        _file = file; _blocks = blocks; Count = count;
    }

    internal Lease Acquire()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _ownerReleased) != 0, this);
        Interlocked.Increment(ref _references);
        return new Lease(this);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _ownerReleased, 1) == 0) Release();
    }

    private void Release()
    {
        if (Interlocked.Decrement(ref _references) == 0) _file.Dispose();
    }

    internal sealed class Lease(GroupSoundMapCatalogue owner) : IDisposable
    {
        private GroupSoundMapCatalogue? _owner = owner;
        public int Count => (_owner ?? throw new ObjectDisposedException(nameof(Lease))).Count;
        public GroupMapCoordinate[] ReadAxes(int x, int y) =>
            (_owner ?? throw new ObjectDisposedException(nameof(Lease))).ReadAxes(x, y);
        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Release();
    }

    private GroupMapCoordinate[] ReadAxes(int x, int y)
    {
        if (x is < 0 or >= 1024 || y is < 0 or >= 1024 || x == y) throw new ArgumentOutOfRangeException(nameof(x));
        var points = new GroupMapCoordinate[Count];
        Span<Half> xs = stackalloc Half[256];
        Span<Half> ys = stackalloc Half[256];
        var at = 0;
        foreach (var block in _blocks)
        {
            var n = block.Ids.Length;
            ReadExactly(MemoryMarshal.AsBytes(xs[..n]), block.Offset + x * n * 2L);
            ReadExactly(MemoryMarshal.AsBytes(ys[..n]), block.Offset + y * n * 2L);
            for (var i = 0; i < n; i++) points[at++] = new(block.Ids[i], 0, 0, (double)xs[i], (double)ys[i]);
        }
        return points;
    }

    private void ReadExactly(Span<byte> buffer, long offset)
    {
        while (!buffer.IsEmpty)
        {
            var read = RandomAccess.Read(_file.SafeFileHandle, buffer, offset);
            if (read == 0) throw new EndOfStreamException("Incomplete group map block");
            offset += read; buffer = buffer[read..];
        }
    }

    internal sealed class Builder : IDisposable
    {
        private FileStream? _file;
        private readonly List<Block> _blocks = [];
        private readonly Half[] _columns = new Half[256 * 1024];
        public int Count { get; private set; }

        public Builder(string directory)
        {
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, $"group-{Guid.NewGuid():N}.bin");
            _file = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite,
                FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.RandomAccess | FileOptions.DeleteOnClose);
            // No orphan catalogue after SIGKILL/OOM; the live handle owns the anonymous file.
            File.Delete(path);
        }

        public void Append(IReadOnlyList<(int Id, float[] Vector)> rows)
        {
            if (rows.Count == 0) return;
            if (rows.Count > 256 || Count + rows.Count > GroupSoundMapIndex.MaximumSongs)
                throw new InvalidOperationException("Group map catalogue exceeds its bounded disk budget");
            var file = _file ?? throw new ObjectDisposedException(nameof(Builder));
            for (var i = 0; i < rows.Count; i++)
            {
                if (rows[i].Vector.Length != 1024) throw new ArgumentException("Expected 1024 features");
                for (var d = 0; d < 1024; d++) _columns[d * rows.Count + i] = (Half)rows[i].Vector[d];
            }
            _blocks.Add(new(rows.Select(row => row.Id).ToArray(), file.Position));
            file.Write(MemoryMarshal.AsBytes(_columns.AsSpan(0, rows.Count * 1024)));
            Count += rows.Count;
        }

        public GroupSoundMapCatalogue Complete()
        {
            var file = _file ?? throw new ObjectDisposedException(nameof(Builder));
            file.Flush();
            _file = null;
            return new(file, _blocks.ToArray(), Count);
        }

        public void Dispose() => Interlocked.Exchange(ref _file, null)?.Dispose();
    }
}
