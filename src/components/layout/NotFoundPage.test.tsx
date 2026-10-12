/** The page for unknown paths: one line and the way home, rendered inside the frame (App's path="*"). */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import NotFoundPage from './NotFoundPage';

describe('NotFoundPage', () => {
  it('says the page was not found and links home, without a description', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/no-such-page']}>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(html).toContain('<h1 class="text-xl font-medium leading-7">ページが見つかりません</h1>');
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>ホームに戻る<\/a>/);
    expect(html).not.toContain('role="alert"');
    expect(html.match(/<p[\s>]/g)).toBeNull();
  });
});
