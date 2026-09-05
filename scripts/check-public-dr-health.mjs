import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://diva-player.pages.dev';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 30_000;
const PROBE_PATHS = ['/', '/backend-api/api/ready', '/backend-api/api/health'];
const API_PATHS = PROBE_PATHS.filter(path => path !== '/');
const ORIGIN_ROLES = new Set(['primary', 'standby', 'named']);
const STANDBY_STATES = new Set(['fresh', 'stale', 'missing', 'unknown']);
const EXPECTED_ORIGIN_ROLE = 'primary';
const EXPECTED_STANDBY_STATE = 'missing';
const MAX_API_RESPONSE_BYTES = 1024 * 1024;

function positiveInteger(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    baseUrl: process.env.DIVA_PUBLIC_BASE_URL || DEFAULT_BASE_URL,
    reportFile: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    allowDegradedData: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === '--base-url' && value) options.baseUrl = value;
    else if (option === '--report-file' && value) options.reportFile = value;
    else if (option === '--timeout-ms' && value) options.timeoutMs = positiveInteger(value, option);
    else if (option === '--interval-ms' && value) options.intervalMs = positiveInteger(value, option);
    else if (option === '--allow-degraded-data') options.allowDegradedData = true;
    else throw new Error(`unsupported or incomplete option: ${option}`);
    index += 1;
  }
  const baseUrl = new URL(options.baseUrl);
  if (
    baseUrl.protocol !== 'https:'
    || baseUrl.username
    || baseUrl.password
    || baseUrl.pathname !== '/'
    || baseUrl.search
    || baseUrl.hash
  ) throw new Error('--base-url must be a credential-free HTTPS origin');
  options.baseUrl = baseUrl.origin;
  return options;
}

function isAcceptedDegradedHealthPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.status !== 'degraded') {
    return false;
  }
  const dependencies = payload.dependencies;
  if (!dependencies?.postgres?.ok || !dependencies?.qdrant?.ok) return false;
  for (const key of ['discoveryQuality', 'audioFeatures']) {
    const section = payload[key];
    if (section && section.ok === false && section.error !== 'stale') return false;
  }
  return ['discoveryQuality', 'audioFeatures'].some(key => payload[key]?.ok === false && payload[key]?.error === 'stale');
}

function publicHeader(value, allowed) {
  return allowed.has(value) ? value : null;
}

async function readBoundedJson(response) {
  const declaredLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_BYTES) {
    throw new Error('response-too-large');
  }
  if (!response.body) throw new Error('response-body-missing');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_API_RESPONSE_BYTES) {
        await reader.cancel('response-too-large').catch(() => {});
        throw new Error('response-too-large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function probeEndpoint(baseUrl, path, round, timeoutMs, allowDegradedData) {
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL(path, baseUrl), {
      headers: { 'user-agent': 'diva-player-public-primary-monitor/1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payloadValid = true;
    let degradedDataAccepted = false;
    if (API_PATHS.includes(path)) {
      try {
        const payload = await readBoundedJson(response);
        const expectedStatus = path.endsWith('/ready') ? 'ready' : 'ok';
        payloadValid = Boolean(
          payload
          && typeof payload === 'object'
          && !Array.isArray(payload)
          && payload.status === expectedStatus
        );
        degradedDataAccepted = path.endsWith('/health')
          && allowDegradedData
          && response.status === 503
          && isAcceptedDegradedHealthPayload(payload);
        payloadValid ||= degradedDataAccepted;
      } catch {
        payloadValid = false;
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
    const result = {
      round,
      path,
      ok: (response.status === 200 && payloadValid) || degradedDataAccepted,
      status: response.status,
      durationMs: Date.now() - startedAt,
      originRole: publicHeader(response.headers.get('x-diva-origin-role'), ORIGIN_ROLES),
      standbyState: publicHeader(response.headers.get('x-diva-standby-state'), STANDBY_STATES),
      error: degradedDataAccepted ? 'degraded-data-accepted' : (payloadValid ? null : 'invalid-api-payload'),
      degradedDataAccepted,
    };
    return result;
  } catch (error) {
    return {
      round,
      path,
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      originRole: null,
      standbyState: null,
      error: error?.name === 'TimeoutError' ? 'timeout' : 'request-failed',
    };
  }
}

export function evaluatePublicPrimaryHealth(probes) {
  const issues = [];
  for (const path of PROBE_PATHS) {
    const pathProbes = probes.filter(probe => probe.path === path);
    const latestProbe = pathProbes.find(probe => probe.round === 2);
    if (pathProbes.length !== 2 || !latestProbe?.ok) {
      issues.push(`${path}: latest public endpoint probe did not succeed`);
    }
  }

  // The root is a static Pages asset. Routing headers are authoritative only
  // on backend API Function responses, so enforce the primary-only contract
  // on ready and health while the root remains an HTTP availability probe.
  for (const path of API_PATHS) {
    const pathProbes = probes
      .filter(probe => probe.path === path && probe.ok)
      .sort((left, right) => left.round - right.round);
    for (const probe of pathProbes) {
      if (probe.originRole !== EXPECTED_ORIGIN_ROLE) {
        issues.push(
          `${path}: expected primary origin role (${probe.originRole ?? 'missing-header'})`,
        );
      }
      if (probe.standbyState !== EXPECTED_STANDBY_STATE) {
        issues.push(
          `${path}: expected primary-only standby state (${probe.standbyState ?? 'missing-header'})`,
        );
      }
    }
  }
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

export async function runPublicPrimaryHealth(options) {
  const probes = [];
  for (let round = 1; round <= 2; round += 1) {
    probes.push(...await Promise.all(PROBE_PATHS.map(path => (
      probeEndpoint(options.baseUrl, path, round, options.timeoutMs, options.allowDegradedData)
    ))));
    if (round === 1) {
      await new Promise(resolve => setTimeout(resolve, options.intervalMs));
    }
  }
  const evaluation = evaluatePublicPrimaryHealth(probes);
  return {
    checkedAt: new Date().toISOString(),
    baseOrigin: new URL(options.baseUrl).origin,
    routingContract: {
      mode: 'primary-only',
      originRole: EXPECTED_ORIGIN_ROLE,
      standbyState: EXPECTED_STANDBY_STATE,
    },
    ok: evaluation.ok,
    issues: evaluation.issues,
    probes,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runPublicPrimaryHealth(options);
  if (options.reportFile) {
    await writeFile(options.reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(`Public primary health check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
