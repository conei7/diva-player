/** An implicit binary treemap: O(n) compact storage, O(visible tiles) traversal.
 * No tail bucket or tile limit; zoom never changes the partition. */
export interface AtlasBox { x: number; y: number; width: number; height: number }
export interface AtlasRect extends AtlasBox { index: number; knownRatio: number }
export class KnowledgeAtlasIndex {
  readonly ids: Int32Array;
  readonly views: Float64Array;
  private readonly sums: Float64Array;
  private readonly knownSums: Float64Array;
  readonly length: number;
  constructor(pairs: readonly number[], known: ReadonlySet<number>, mode: 'all' | 'known' | 'unknown' = 'all') {
    if (pairs.length % 2) throw new Error('Invalid atlas pairs');
    const keep = (id: number) => mode === 'all' || known.has(id) === (mode === 'known');
    let count = 0;
    for (let p = 0; p < pairs.length; p += 2) {
      if (!Number.isInteger(pairs[p]) || pairs[p] <= 0 || pairs[p] > 2147483647
        || !Number.isSafeInteger(pairs[p + 1]) || pairs[p + 1] <= 0
        || (p > 0 && pairs[p + 1] > pairs[p - 1])) throw new Error('Invalid atlas data');
      if (keep(pairs[p])) count++;
    }
    this.length = count;
    this.ids = new Int32Array(count);
    this.views = new Float64Array(count);
    this.sums = new Float64Array(count + 1);
    this.knownSums = new Float64Array(count + 1);
    let index = 0;
    for (let p = 0; p < pairs.length; p += 2) {
      const id = pairs[p], views = pairs[p + 1];
      if (!keep(id)) continue;
      this.ids[index] = id; this.views[index] = views;
      this.sums[index + 1] = this.sums[index] + views;
      this.knownSums[index + 1] = this.knownSums[index] + (known.has(id) ? views : 0);
      index++;
    }
    if (!Number.isSafeInteger(this.sums[count])) throw new Error('Atlas total exceeds safe precision');
  }
  get totalViews() { return this.sums[this.length]; }
  private split(start: number, end: number) {
    // Stable unequal cuts avoid the repeated grid produced by halving every
    // similarly weighted group. Order and exact area still come from views.
    const target = this.sums[start] + (this.sums[end] - this.sums[start])
      * (0.34 + this.variation(start, end) * 0.32);
    let lo = start + 1, hi = end - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sums[mid] < target) lo = mid + 1; else hi = mid;
    }
    if (lo > start + 1 && Math.abs(this.sums[lo - 1] - target) < Math.abs(this.sums[lo] - target)) lo--;
    return lo;
  }
  private variation(start: number, end: number) {
    let value = Math.imul(this.ids[start] ^ (end - start), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  }
  private children(start: number, end: number, box: AtlasBox, aspect: number) {
    const mid = this.split(start, end);
    const fraction = (this.sums[mid] - this.sums[start]) / (this.sums[end] - this.sums[start]);
    if (box.width * aspect >= box.height * (0.7 + this.variation(start, end) * 0.6)) {
      const width = box.width * fraction;
      return { mid, first: { ...box, width }, second: { ...box, x: box.x + width, width: box.width - width } };
    }
    const height = box.height * fraction;
    return { mid, first: { ...box, height }, second: { ...box, y: box.y + height, height: box.height - height } };
  }
  /** Coalesces only fine paint, never data: hit() still reaches each individual song. */
  visible(view: AtlasBox, pixelWidth: number, pixelHeight: number, aspect: number, detailWidth = 20, detailHeight = 20): AtlasRect[] {
    const output: AtlasRect[] = [];
    const paintThreshold = Math.max(1, Math.sqrt(view.width * pixelWidth * view.height * pixelHeight / 600));
    const visit = (start: number, end: number, box: AtlasBox) => {
      if (box.x + box.width < view.x || box.y + box.height < view.y
        || box.x > view.x + view.width || box.y > view.y + view.height) return;
      const leaf = end - start === 1;
      if (leaf || box.width * pixelWidth < Math.min(detailWidth, paintThreshold)
        || box.height * pixelHeight < Math.min(detailHeight, paintThreshold)) {
        output.push({ ...box, index: leaf ? start : -1,
          knownRatio: (this.knownSums[end] - this.knownSums[start]) / (this.sums[end] - this.sums[start]) });
        return;
      }
      const { mid, first, second } = this.children(start, end, box, aspect);
      visit(start, mid, first); visit(mid, end, second);
    };
    if (this.length) visit(0, this.length, { x: 0, y: 0, width: 1, height: 1 });
    return output;
  }
  locate(index: number, aspect: number): AtlasRect | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return null;
    let start = 0, end = this.length, box: AtlasBox = { x: 0, y: 0, width: 1, height: 1 };
    while (end - start > 1) {
      const { mid, first, second } = this.children(start, end, box, aspect);
      if (index < mid) { end = mid; box = first; } else { start = mid; box = second; }
    }
    return { ...box, index, knownRatio: (this.knownSums[end] - this.knownSums[start]) / this.views[start] };
  }
  hit(x: number, y: number, aspect: number): AtlasRect | null {
    if (!this.length || x < 0 || y < 0 || x >= 1 || y >= 1) return null;
    let start = 0, end = this.length, box: AtlasBox = { x: 0, y: 0, width: 1, height: 1 };
    while (end - start > 1) {
      const { mid, first, second } = this.children(start, end, box, aspect);
      if (x < second.x || y < second.y) { end = mid; box = first; }
      else { start = mid; box = second; }
    }
    return { ...box, index: start, knownRatio: (this.knownSums[end] - this.knownSums[start]) / this.views[start] };
  }
}
