const baseUrl = process.argv[2] || 'http://192.168.40.79:5000';
const durationMs = Number(process.argv[3] || 120_000);
const intervalMs = Number(process.argv[4] || 500);
const endpoint = new URL('/api/ready', baseUrl);
const deadline = Date.now() + durationMs;
let requests = 0;
let failures = 0;
let maxLatencyMs = 0;

while (Date.now() < deadline) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(endpoint, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) failures += 1;
    await response.arrayBuffer();
  } catch {
    failures += 1;
  } finally {
    clearTimeout(timeout);
  }
  requests += 1;
  maxLatencyMs = Math.max(maxLatencyMs, Math.round(performance.now() - startedAt));
  await new Promise(resolve => setTimeout(resolve, intervalMs));
}

if (failures > 0) {
  throw new Error(`API availability failed ${failures}/${requests} requests (max ${maxLatencyMs}ms)`);
}

console.log(`PASS API availability ${requests}/${requests} requests (max ${maxLatencyMs}ms)`);
