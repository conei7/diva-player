import puppeteer from 'puppeteer';

const PAGE_TIMEOUT_MS = 45_000;
const BUDGETS_MS = {
  'home.load': 15_000,
  'home.paint': 15_000,
  'search.paint': 15_000,
};

function getBaseUrl() {
  const provided = process.argv[2] ?? process.env.PERF_BUDGET_BASE_URL ?? 'http://127.0.0.1:4173/diva-player/';
  const url = new URL(provided);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForMetric(page, name) {
  await page.waitForFunction(metricName =>
    window.__DIVA_PERFORMANCE__?.getMetrics().some(metric => metric.name === metricName), name,
  );
  return page.evaluate(metricName => {
    const metrics = window.__DIVA_PERFORMANCE__?.getMetrics() ?? [];
    return metrics.filter(metric => metric.name === metricName).at(-1) ?? null;
  }, name);
}

async function main() {
  const baseUrl = getBaseUrl();
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href*="/watch?v="]');
    const homeLoad = await waitForMetric(page, 'home.load');
    const homePaint = await waitForMetric(page, 'home.paint');

    await page.goto(`${baseUrl}?q=Tell%20Your%20World`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href*="/watch?v="]');
    const searchPaint = await waitForMetric(page, 'search.paint');

    const metrics = { 'home.load': homeLoad, 'home.paint': homePaint, 'search.paint': searchPaint };
    for (const [name, metric] of Object.entries(metrics)) {
      assert(metric && Number.isFinite(metric.durationMs), `${name} was not recorded.`);
      const budget = BUDGETS_MS[name];
      assert(metric.durationMs <= budget, `${name} exceeded ${budget}ms (${Math.round(metric.durationMs)}ms).`);
      console.log(`PASS ${name}: ${Math.round(metric.durationMs)}ms / ${budget}ms`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`Performance budget test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
