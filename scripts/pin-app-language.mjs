/** Make language-sensitive E2E selectors deterministic regardless of runner locale. */
export async function pinAppLanguage(page, language = 'ja') {
  await page.evaluateOnNewDocument((value) => {
    if (window !== window.top) return;
    localStorage.setItem('diva_uiLanguage', JSON.stringify(value));
  }, language);
}
