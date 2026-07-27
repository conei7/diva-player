import { describe, expect, it } from 'vitest';
import { escapeCsvCell, serializeCsv } from './csv';

describe('csv utilities', () => {
  it('quotes commas, quotes, and line breaks and doubles embedded quotes', () => {
    expect(escapeCsvCell('曲, "名前"\n')).toBe('"曲, ""名前""\n"');
  });

  it('adds a UTF-8 BOM and keeps an empty table usable', () => {
    expect(serializeCsv(['列A', '列B'], [])).toBe('\uFEFF列A,列B\r\n');
  });

  it('serializes values and preserves row boundaries', () => {
    expect(serializeCsv(['id', 'value'], [[1, null], [2, 'a\rb']]))
      .toBe('\uFEFFid,value\r\n1,\r\n2,"a\rb"\r\n');
  });
});
