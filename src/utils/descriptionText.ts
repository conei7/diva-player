export interface DescriptionTextToken {
  type: 'text' | 'url';
  value: string;
}

const URL_PATTERN = /https?:\/\/[^\s<]+/gi;
const TRAILING_URL_PUNCTUATION = /[.,!?;:、。！？；：)\]}」』】]+$/;

/**
 * VocaDBの説明文を表示用に正規化する。
 * APIによっては改行が実際の改行ではなく、文字列の "\\n" として返るため両方を扱う。
 */
export function normalizeDescriptionText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n');
}

/** URLを安全にリンク化するため、本文とURLをReactで別々に描画できる形へ分割する。 */
export function tokenizeDescriptionText(value: string): DescriptionTextToken[] {
  const normalized = normalizeDescriptionText(value);
  const tokens: DescriptionTextToken[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.type === 'text') {
      previous.value += text;
    } else {
      tokens.push({ type: 'text', value: text });
    }
  };
  let cursor = 0;

  for (const match of normalized.matchAll(URL_PATTERN)) {
    const rawUrl = match[0];
    const start = match.index ?? 0;
    if (start > cursor) pushText(normalized.slice(cursor, start));

    const trailing = rawUrl.match(TRAILING_URL_PUNCTUATION)?.[0] ?? '';
    const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
    if (url) tokens.push({ type: 'url', value: url });
    if (trailing) pushText(trailing);
    cursor = start + rawUrl.length;
  }

  if (cursor < normalized.length) pushText(normalized.slice(cursor));
  return tokens.length > 0 ? tokens : [{ type: 'text', value: normalized }];
}
