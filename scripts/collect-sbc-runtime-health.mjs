import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_CONTAINERS = ['vocadb_api_a', 'vocadb_api_b', 'vocadb_api_gateway', 'vocadb_postgres', 'vocadb_qdrant'];

export function parseByteSize(value) {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?i?b)\s*$/i.exec(value || '');
  if (!match) return null;
  const units = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4 };
  const multiplier = units[match[2].toLowerCase()];
  return multiplier ? Number(match[1]) * multiplier : null;
}

export function parseDockerStats(output) {
  return output.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try {
      const raw = JSON.parse(line);
      const [used = '', limit = ''] = String(raw.MemUsage || '').split('/').map(value => value.trim());
      return [{
        name: raw.Name,
        cpuPercent: Number.parseFloat(raw.CPUPerc) || 0,
        memoryUsedBytes: parseByteSize(used),
        memoryLimitBytes: parseByteSize(limit),
        memoryPercent: Number.parseFloat(raw.MemPerc) || 0,
        pids: Number.parseInt(raw.PIDs, 10) || 0,
      }];
    } catch {
      return [];
    }
  });
}

export function parseContainerHealth(output) {
  return Object.fromEntries(output.split(/\r?\n/).filter(Boolean).map(line => {
    const [name, status] = line.replace(/^\//, '').split('\t');
    return [name, status || 'unknown'];
  }));
}

export function parsePostgresActivity(output) {
  const applications = output.split(/\r?\n/).filter(Boolean).map(line => {
    const [applicationName, active, total] = line.split('\t');
    return {
      applicationName,
      active: Number.parseInt(active, 10) || 0,
      total: Number.parseInt(total, 10) || 0,
    };
  });
  return {
    applications,
    active: applications.reduce((sum, item) => sum + item.active, 0),
    total: applications.reduce((sum, item) => sum + item.total, 0),
  };
}

export function parseHaProxyStats(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].replace(/^#\s*/, '').split(',');
  const index = Object.fromEntries(header.map((name, position) => [name, position]));
  return lines.slice(1).map(line => line.split(',')).filter(columns => columns[index.pxname] === 'api_nodes')
    .filter(columns => columns[index.svname] === 'api_a' || columns[index.svname] === 'api_b')
    .map(columns => ({
      slot: columns[index.svname],
      status: columns[index.status] || 'UNKNOWN',
      currentSessions: Number.parseInt(columns[index.scur], 10) || 0,
    }));
}

export function parseHostMemory(meminfoOutput, vmstatOutput, pressureOutput = '') {
  const meminfo = Object.fromEntries(meminfoOutput.split(/\r?\n/).flatMap(line => {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/.exec(line.trim());
    return match ? [[match[1], Number(match[2]) * 1024]] : [];
  }));
  const required = ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'];
  const missing = required.filter(name => !Number.isFinite(meminfo[name]));
  if (missing.length > 0) throw new Error(`missing /proc/meminfo fields: ${missing.join(', ')}`);
  const vmstat = Object.fromEntries(vmstatOutput.split(/\r?\n/).flatMap(line => {
    const [name, value, ...rest] = line.trim().split(/\s+/);
    return rest.length === 0 && (name === 'pswpin' || name === 'pswpout')
      ? [[name, Number(value)]]
      : [];
  }));
  const pressure = Object.fromEntries(pressureOutput.split(/\r?\n/).flatMap(line => {
    const [kind, ...columns] = line.trim().split(/\s+/);
    if (kind !== 'some' && kind !== 'full') return [];
    const raw = Object.fromEntries(columns.flatMap(column => {
      const [name, value, ...rest] = column.split('=');
      return rest.length === 0 && value !== undefined ? [[name, Number(value)]] : [];
    }));
    return [[kind, {
      avg10Percent: Number.isFinite(raw.avg10) ? raw.avg10 : null,
      avg60Percent: Number.isFinite(raw.avg60) ? raw.avg60 : null,
      avg300Percent: Number.isFinite(raw.avg300) ? raw.avg300 : null,
      totalMicros: Number.isFinite(raw.total) ? raw.total : null,
    }]];
  }));
  const totalBytes = meminfo.MemTotal;
  const availableBytes = meminfo.MemAvailable;
  const swapTotalBytes = meminfo.SwapTotal;
  const swapUsedBytes = Math.max(0, swapTotalBytes - meminfo.SwapFree);
  return {
    totalBytes,
    availableBytes,
    availablePercent: totalBytes > 0 ? Number(((availableBytes / totalBytes) * 100).toFixed(2)) : null,
    swapTotalBytes,
    swapUsedBytes,
    swapUsedPercent: swapTotalBytes > 0 ? Number(((swapUsedBytes / swapTotalBytes) * 100).toFixed(2)) : 0,
    swapInPages: Number.isFinite(vmstat.pswpin) ? vmstat.pswpin : null,
    swapOutPages: Number.isFinite(vmstat.pswpout) ? vmstat.pswpout : null,
    pressure: Object.keys(pressure).length > 0 ? pressure : null,
  };
}

export function evaluateRuntimeSnapshot(snapshot, previous = {}, thresholds = {}) {
  const apiRssWarnMiB = thresholds.apiRssWarnMiB ?? 384;
  const dbConnectionsWarn = thresholds.dbConnectionsWarn ?? 28;
  const diskUsedWarnPercent = thresholds.diskUsedWarnPercent ?? 85;
  const hostAvailableWarnPercent = thresholds.hostAvailableWarnPercent ?? 10;
  const violations = [];

  for (const error of snapshot.collectionErrors || []) {
    violations.push({
      id: `collector:${error.source}`,
      message: `${error.source} collection failed: ${error.error}`,
    });
  }

  for (const container of snapshot.containers) {
    if (container.health !== 'healthy' && container.health !== 'running') {
      violations.push({ id: `container:${container.name}`, message: `${container.name} is ${container.health}` });
    }
    if ((container.name === 'vocadb_api_a' || container.name === 'vocadb_api_b')
      && container.memoryUsedBytes !== null
      && container.memoryUsedBytes > apiRssWarnMiB * 1024 ** 2) {
      violations.push({ id: `memory:${container.name}`, message: `${container.name} container memory exceeds ${apiRssWarnMiB} MiB` });
    }
  }
  for (const slot of snapshot.haproxy) {
    if (!slot.status.startsWith('UP')) {
      violations.push({ id: `haproxy:${slot.slot}`, message: `${slot.slot} is ${slot.status}` });
    }
  }
  for (const requiredSlot of ['api_a', 'api_b']) {
    if (!snapshot.haproxy.some(slot => slot.slot === requiredSlot)) {
      violations.push({ id: `haproxy:${requiredSlot}`, message: `${requiredSlot} is missing from HAProxy stats` });
    }
  }
  if (Number.isFinite(snapshot.postgres.total) && snapshot.postgres.total > dbConnectionsWarn) {
    violations.push({ id: 'postgres:connections', message: `API DB connections exceed ${dbConnectionsWarn}` });
  }
  if (Number.isFinite(snapshot.disk.usedPercent) && snapshot.disk.usedPercent > diskUsedWarnPercent) {
    violations.push({ id: 'disk:used', message: `disk use exceeds ${diskUsedWarnPercent}%` });
  }
  if (Number.isFinite(snapshot.hostMemory?.availablePercent)
    && snapshot.hostMemory.availablePercent < hostAvailableWarnPercent) {
    violations.push({ id: 'host:memory-available', message: `host available memory is below ${hostAvailableWarnPercent}%` });
  }

  const priorCounts = previous.consecutiveViolations || {};
  const consecutiveViolations = Object.fromEntries(violations.map(item => [item.id, (priorCounts[item.id] || 0) + 1]));
  const critical = violations.filter(item => consecutiveViolations[item.id] >= 2);
  return {
    ...snapshot,
    status: critical.length > 0 ? 'critical' : violations.length > 0 ? 'warning' : 'ok',
    violations,
    critical,
    consecutiveViolations,
  };
}

function spawnWithInput(command, args, input, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
      }
    });
    child.stdin.end(input);
  });
}

async function collectSnapshot() {
  const inspectFormat = '{{.Name}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}';
  const settle = async (source, promise) => {
    try {
      return { source, ok: true, value: await promise, stdout: '' };
    } catch (error) {
      return {
        source,
        ok: false,
        value: null,
        stdout: typeof error?.stdout === 'string' ? error.stdout : '',
        error: String(error?.message || error || 'unknown error').slice(0, 300),
      };
    }
  };
  const [statsResult, healthResult, postgresResult, haproxyResult, hostMemoryResult, diskResult] = await Promise.all([
    settle('docker-stats', execFileAsync(
      'docker',
      ['stats', '--no-stream', '--format', '{{json .}}', ...DEFAULT_CONTAINERS],
      { timeout: 20_000 },
    )),
    settle('docker-inspect', execFileAsync(
      'docker',
      ['inspect', '--format', inspectFormat, ...DEFAULT_CONTAINERS],
      { timeout: 10_000 },
    )),
    settle('postgres', execFileAsync('docker', [
      'exec', 'vocadb_postgres', 'psql', '-U', 'vocadb', '-d', 'vocadb_recommender', '-At', '-F', '\t', '-c',
      "SELECT application_name, count(*) FILTER (WHERE state = 'active'), count(*) FROM pg_stat_activity WHERE application_name LIKE 'diva-api-%' GROUP BY application_name ORDER BY application_name",
    ], { timeout: 10_000 })),
    settle(
      'haproxy',
      spawnWithInput(
        'docker',
        ['exec', '-i', 'vocadb_api_gateway', 'socat', '-', 'UNIX-CONNECT:/tmp/haproxy-admin.sock'],
        'show stat\n',
      ),
    ),
    settle('host-memory', Promise.all([
      readFile('/proc/meminfo', 'utf8'),
      readFile('/proc/vmstat', 'utf8'),
      readFile('/proc/pressure/memory', 'utf8'),
    ]).then(([meminfo, vmstat, pressure]) => parseHostMemory(meminfo, vmstat, pressure))),
    settle('disk', statfs('/')),
  ]);

  const results = [statsResult, healthResult, postgresResult, haproxyResult, diskResult];
  const collectionErrors = results
    .filter(result => !result.ok)
    .map(result => ({ source: result.source, error: result.error }));
  const outputOf = result => result.ok
    ? typeof result.value === 'string' ? result.value : result.value?.stdout || ''
    : result.stdout;
  const stats = parseDockerStats(outputOf(statsResult));
  const statsByName = new Map(stats.map(container => [container.name, container]));
  const health = parseContainerHealth(outputOf(healthResult));
  const postgres = parsePostgresActivity(outputOf(postgresResult));
  if (!postgresResult.ok) postgres.error = postgresResult.error;
  const haproxy = parseHaProxyStats(outputOf(haproxyResult));
  const hostMemory = hostMemoryResult.ok ? hostMemoryResult.value : {
    totalBytes: null,
    availableBytes: null,
    availablePercent: null,
    swapTotalBytes: null,
    swapUsedBytes: null,
    swapUsedPercent: null,
    swapInPages: null,
    swapOutPages: null,
    pressure: null,
    error: hostMemoryResult.error,
  };
  const disk = diskResult.ok ? diskResult.value : null;
  return {
    checkedAt: new Date().toISOString(),
    collectionErrors,
    containers: DEFAULT_CONTAINERS.map(name => ({
      name,
      cpuPercent: null,
      memoryUsedBytes: null,
      memoryLimitBytes: null,
      memoryPercent: null,
      pids: null,
      ...statsByName.get(name),
      health: health[name] || 'missing',
    })),
    postgres,
    haproxy,
    hostMemory,
    disk: {
      totalBytes: disk ? disk.blocks * disk.bsize : null,
      availableBytes: disk ? disk.bavail * disk.bsize : null,
      usedPercent: disk && disk.blocks > 0
        ? Number((((disk.blocks - disk.bavail) / disk.blocks) * 100).toFixed(2))
        : null,
      ...(diskResult.ok ? {} : { error: diskResult.error }),
    },
  };
}

async function loadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export async function rotateHistoryIfNeeded(path, maximumBytes) {
  if (!Number.isFinite(maximumBytes) || maximumBytes <= 0) {
    throw new Error('DIVA_RUNTIME_HISTORY_MAX_BYTES must be a positive number');
  }
  try {
    const current = await stat(path);
    if (current.size < maximumBytes) return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  const rotated = `${path}.1`;
  await rm(rotated, { force: true });
  await rename(path, rotated);
  return true;
}

async function applyCriticalNotification(snapshot, previous) {
  const webhook = process.env.DIVA_ALERT_WEBHOOK_URL;
  const currentIds = new Set(snapshot.critical.map(item => item.id));
  const previousNotifiedIds = Array.isArray(previous.notifiedCriticalIds)
    ? previous.notifiedCriticalIds
    : [];
  const notifiedIds = new Set(
    previousNotifiedIds.filter(id => currentIds.has(id)),
  );
  const newlyCritical = snapshot.critical.filter(item => !notifiedIds.has(item.id));
  if (!webhook) {
    return { ...snapshot, notifiedCriticalIds: [...notifiedIds], notificationStatus: 'disabled' };
  }
  if (newlyCritical.length === 0) {
    return { ...snapshot, notifiedCriticalIds: [...notifiedIds], notificationStatus: 'up-to-date' };
  }
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'diva_runtime_health', status: snapshot.status, checkedAt: snapshot.checkedAt, critical: newlyCritical }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    for (const item of newlyCritical) notifiedIds.add(item.id);
    return { ...snapshot, notifiedCriticalIds: [...notifiedIds], notificationStatus: 'sent' };
  } catch (error) {
    return {
      ...snapshot,
      notifiedCriticalIds: [...notifiedIds],
      notificationStatus: 'failed',
      notificationError: String(error?.message || error || 'unknown error').slice(0, 300),
    };
  }
}

export async function main() {
  const stateDir = process.env.DIVA_RUNTIME_STATE_DIR || join(homedir(), '.local', 'state', 'diva-player');
  const latestPath = join(stateDir, 'runtime_health_latest.json');
  const historyPath = join(stateDir, 'runtime_health_history.jsonl');
  const previous = await loadJson(latestPath);
  let snapshot = evaluateRuntimeSnapshot(await collectSnapshot(), previous, {
    apiRssWarnMiB: Number(process.env.DIVA_RUNTIME_API_RSS_WARN_MIB || 384),
    dbConnectionsWarn: Number(process.env.DIVA_RUNTIME_DB_CONNECTIONS_WARN || 28),
    diskUsedWarnPercent: Number(process.env.DIVA_RUNTIME_DISK_USED_WARN_PERCENT || 85),
    hostAvailableWarnPercent: Number(process.env.DIVA_RUNTIME_HOST_AVAILABLE_WARN_PERCENT || 10),
  });
  // Notification failures are recorded without suppressing the local state.
  // notifiedCriticalIds advances only after delivery, so the next timer run
  // retries while still avoiding duplicate alerts after a successful send.
  snapshot = await applyCriticalNotification(snapshot, previous);
  await writeJsonAtomic(latestPath, snapshot);
  await rotateHistoryIfNeeded(
    historyPath,
    Number(process.env.DIVA_RUNTIME_HISTORY_MAX_BYTES || 20 * 1024 * 1024),
  );
  await appendFile(historyPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  if (snapshot.status === 'critical') process.exitCode = 2;
  else if (snapshot.notificationStatus === 'failed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
