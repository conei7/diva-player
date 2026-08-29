import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_PROJECT = 'diva-player';
const RELEASE_COMPATIBILITY_DATE = '2026-07-12';
const DEFAULT_ATTEMPTS = 8;
const DEFAULT_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DEPLOYMENT_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function positiveInteger(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function deploymentSummary(deployment) {
  return {
    id: deployment.id,
    environment: deployment.environment,
    url: deployment.url,
    createdOn: deployment.created_on,
    modifiedOn: deployment.modified_on,
    stageStatus: deployment.latest_stage?.status,
    branch: deployment.deployment_trigger?.metadata?.branch,
    commitHash: deployment.deployment_trigger?.metadata?.commit_hash,
    commitMessage: deployment.deployment_trigger?.metadata?.commit_message,
    usesFunctions: deployment.uses_functions === true,
  };
}

function assertDeploymentId(value, label = 'deployment ID') {
  if (!DEPLOYMENT_ID_PATTERN.test(value || '')) throw new Error(`${label} is invalid`);
}

function assertSuccessfulDeployment(deployment, environment) {
  if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment)) {
    throw new Error(`${environment} deployment is missing`);
  }
  assertDeploymentId(deployment.id, `${environment} deployment ID`);
  if (deployment.environment !== environment) {
    throw new Error(`expected a ${environment} deployment, received ${deployment.environment || 'unknown'}`);
  }
  if (deployment.is_skipped) throw new Error(`${environment} deployment was skipped`);
  if (deployment.latest_stage?.status !== 'success') {
    throw new Error(`${environment} deployment is not successful (${deployment.latest_stage?.status || 'unknown'})`);
  }
  if (deployment.uses_functions !== true) throw new Error(`${environment} deployment does not contain Pages Functions`);
  const url = new URL(deployment.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
    throw new Error(`${environment} deployment URL is invalid`);
  }
  return deployment;
}

function environmentContract(config, environment) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Cloudflare ${environment} deployment configuration is missing`);
  }
  if (!config.kv_namespaces?.TUNNEL_CONFIG?.namespace_id) {
    throw new Error(`Cloudflare ${environment} TUNNEL_CONFIG binding is missing`);
  }
  if (!config.env_vars?.PAGES_PROXY_KEY) {
    throw new Error(`Cloudflare ${environment} PAGES_PROXY_KEY is missing`);
  }
  return config;
}

export function validateProjectContract(project, expectedProductionBranch = 'main') {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('Cloudflare project is missing');
  if (project.name !== DEFAULT_PROJECT) throw new Error(`unexpected Cloudflare project: ${project.name || 'unknown'}`);
  if (project.production_branch !== expectedProductionBranch) {
    throw new Error(`Cloudflare production branch must be ${expectedProductionBranch}`);
  }
  const sourceConfig = project.source?.config;
  if (sourceConfig && sourceConfig.production_deployments_enabled !== false) {
    throw new Error('Cloudflare automatic production branch deployments must be disabled before release promotion');
  }

  const production = environmentContract(project.deployment_configs?.production, 'production');
  const preview = environmentContract(project.deployment_configs?.preview, 'preview');
  const productionCompatibilityDate = String(production.compatibility_date || '').slice(0, 10);
  const previewCompatibilityDate = String(preview.compatibility_date || '').slice(0, 10);
  if (
    productionCompatibilityDate !== RELEASE_COMPATIBILITY_DATE
    || previewCompatibilityDate !== RELEASE_COMPATIBILITY_DATE
  ) throw new Error(`Cloudflare preview and production compatibility date must be ${RELEASE_COMPATIBILITY_DATE}`);
  if (
    production.always_use_latest_compatibility_date !== false
    || preview.always_use_latest_compatibility_date !== false
  ) throw new Error('Cloudflare latest compatibility date overrides must be disabled');
  const productionFlags = [...(production.compatibility_flags || [])].sort();
  const previewFlags = [...(preview.compatibility_flags || [])].sort();
  if (JSON.stringify(productionFlags) !== JSON.stringify(previewFlags)) {
    throw new Error('Cloudflare preview and production compatibility flags must match');
  }
  if (
    production.kv_namespaces.TUNNEL_CONFIG.namespace_id
    !== preview.kv_namespaces.TUNNEL_CONFIG.namespace_id
  ) throw new Error('Cloudflare preview and production must use the same TUNNEL_CONFIG namespace');

  const productionVars = production.env_vars || {};
  const previewVars = preview.env_vars || {};
  for (const [name, productionValue] of Object.entries(productionVars)) {
    const previewValue = previewVars[name];
    if (!previewValue) throw new Error(`Cloudflare preview environment variable ${name} is missing`);
    if (productionValue.type !== previewValue.type) {
      throw new Error(`Cloudflare preview environment variable ${name} has a different type`);
    }
    if (productionValue.type === 'plain_text' && productionValue.value !== previewValue.value) {
      throw new Error(`Cloudflare preview environment variable ${name} differs from production`);
    }
  }

  const canonical = assertSuccessfulDeployment(project.canonical_deployment, 'production');
  const canonicalMetadata = canonical.deployment_trigger?.metadata || {};
  if (canonicalMetadata.branch !== expectedProductionBranch) {
    throw new Error(`canonical Cloudflare production deployment must belong to ${expectedProductionBranch}`);
  }
  if (!GIT_COMMIT_PATTERN.test(canonicalMetadata.commit_hash || '')) {
    throw new Error('canonical Cloudflare production deployment has invalid commit provenance');
  }
  return canonical;
}

export function matchesReleaseDeployment(deployment, {
  environment,
  branch,
  commitHash,
  commitMessage,
  excludedId = null,
}) {
  try {
    assertSuccessfulDeployment(deployment, environment);
  } catch {
    return false;
  }
  const metadata = deployment.deployment_trigger?.metadata || {};
  return (
    (!excludedId || deployment.id !== excludedId)
    && metadata.branch === branch
    && metadata.commit_hash === commitHash
    && metadata.commit_message === commitMessage
  );
}

export function validateRollbackCandidate(target, deployment) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('rollback target is invalid');
  assertDeploymentId(target.id, 'rollback deployment ID');
  const candidate = assertSuccessfulDeployment(deployment, 'production');
  const summary = deploymentSummary(candidate);
  if (
    summary.id !== target.id
    || summary.commitHash !== target.commitHash
    || summary.url !== target.url
  ) throw new Error('rollback target no longer matches the verified production deployment');
  return candidate;
}

function requireCloudflareEnvironment() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  if (!accountId || accountId.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(accountId)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is missing or invalid');
  }
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is missing');
  return { accountId, token };
}

async function cloudflareRequest(path, { method = 'GET', body = null } = {}) {
  const { token } = requireCloudflareEnvironment();
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === null ? {} : { 'content-type': 'application/json' }),
      'user-agent': 'diva-player-release/1',
    },
    body: body === null ? null : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Cloudflare API returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok || payload?.success !== true) {
    const messages = Array.isArray(payload?.errors)
      ? payload.errors.map(error => `${error.code || 'unknown'}:${error.message || 'unknown'}`).join(', ')
      : 'unknown';
    throw new Error(`Cloudflare API failed with HTTP ${response.status} (${messages})`);
  }
  return payload.result;
}

function projectPath(project) {
  const { accountId } = requireCloudflareEnvironment();
  if (project !== DEFAULT_PROJECT) throw new Error(`project must be ${DEFAULT_PROJECT}`);
  return `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}`;
}

async function getProject(project) {
  return cloudflareRequest(projectPath(project));
}

async function getDeployment(project, deploymentId) {
  assertDeploymentId(deploymentId);
  return cloudflareRequest(`${projectPath(project)}/deployments/${encodeURIComponent(deploymentId)}`);
}

async function getPreviewDeployments(project) {
  return cloudflareRequest(`${projectPath(project)}/deployments?env=preview&page=1&per_page=25`);
}

async function waitFor(check, { attempts, intervalMs, description }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await check();
      if (result) return result;
      lastError = new Error(`${description} has not converged`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${description} failed after ${attempts} attempts: ${lastError?.message || 'unknown'}`);
}

async function writeSummary(output, summary) {
  if (output) await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify(summary, null, 2));
}

async function appendGitHubOutput(output, entries) {
  if (!output) return;
  const lines = Object.entries(entries).map(([name, value]) => `${name}=${value}\n`).join('');
  await writeFile(output, lines, { encoding: 'utf8', flag: 'a' });
}

function parseArguments(argv) {
  const command = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || value === undefined) throw new Error(`unsupported or incomplete option: ${option}`);
    if (values.has(option)) throw new Error(`duplicate option: ${option}`);
    values.set(option, value);
  }
  return { command, values };
}

function releaseExpectation(values, environment) {
  const branch = values.get('--branch') || '';
  const commitHash = values.get('--commit-hash') || '';
  const releaseHash = values.get('--release-sha256') || '';
  if (!branch || branch.length > 63 || !/^[a-z0-9-]+$/.test(branch)) throw new Error('branch is invalid');
  if (!GIT_COMMIT_PATTERN.test(commitHash)) throw new Error('commit hash is invalid');
  if (!SHA256_PATTERN.test(releaseHash)) throw new Error('release SHA-256 is invalid');
  return {
    environment,
    branch,
    commitHash,
    commitMessage: `artifact-sha256:${releaseHash}`,
    excludedId: values.get('--excluded-id') || null,
  };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  const project = values.get('--project') || DEFAULT_PROJECT;
  const attempts = positiveInteger(values.get('--attempts') || `${DEFAULT_ATTEMPTS}`, '--attempts');
  const intervalMs = positiveInteger(values.get('--interval-ms') || `${DEFAULT_INTERVAL_MS}`, '--interval-ms');

  if (command === 'inspect-project') {
    const current = validateProjectContract(await getProject(project));
    await writeSummary(values.get('--output'), deploymentSummary(current));
    return;
  }

  if (command === 'capture-production') {
    const current = validateProjectContract(await getProject(project));
    const summary = deploymentSummary(current);
    await writeSummary(values.get('--output'), summary);
    await appendGitHubOutput(values.get('--github-output'), {
      production_deployment_id: summary.id,
      production_commit_hash: summary.commitHash,
    });
    return;
  }

  if (command === 'assert-production') {
    const expectedId = values.get('--expected-id') || '';
    assertDeploymentId(expectedId, 'expected deployment ID');
    const current = validateProjectContract(await getProject(project));
    if (current.id !== expectedId) throw new Error('production changed while the rollback candidate was being verified');
    await writeSummary(values.get('--output'), deploymentSummary(current));
    return;
  }

  if (command === 'wait-preview') {
    const expectation = releaseExpectation(values, 'preview');
    const deployment = await waitFor(async () => {
      const deployments = await getPreviewDeployments(project);
      if (!Array.isArray(deployments)) throw new Error('Cloudflare preview deployment list is invalid');
      return deployments.find(candidate => matchesReleaseDeployment(candidate, expectation)) || null;
    }, { attempts, intervalMs, description: 'preview deployment' });
    const summary = deploymentSummary(deployment);
    await writeSummary(values.get('--output'), summary);
    await appendGitHubOutput(values.get('--github-output'), {
      preview_deployment_id: summary.id,
      preview_url: summary.url,
    });
    return;
  }

  if (command === 'wait-production') {
    const expectation = releaseExpectation(values, 'production');
    const deployment = await waitFor(async () => {
      const current = validateProjectContract(await getProject(project));
      return matchesReleaseDeployment(current, expectation) ? current : null;
    }, { attempts, intervalMs, description: 'production deployment' });
    await writeSummary(values.get('--output'), deploymentSummary(deployment));
    return;
  }

  if (command === 'rollback-production') {
    const targetFile = values.get('--target-file');
    if (!targetFile) throw new Error('--target-file is required');
    const target = JSON.parse(await readFile(targetFile, 'utf8'));
    assertDeploymentId(target.id, 'rollback deployment ID');
    validateRollbackCandidate(target, await getDeployment(project, target.id));
    await cloudflareRequest(
      `${projectPath(project)}/deployments/${encodeURIComponent(target.id)}/rollback`,
      { method: 'POST' },
    );
    const restored = await waitFor(async () => {
      const current = validateProjectContract(await getProject(project));
      return current.id === target.id ? current : null;
    }, { attempts, intervalMs, description: 'production rollback' });
    await writeSummary(values.get('--output'), deploymentSummary(restored));
    return;
  }

  throw new Error(`unsupported command: ${command || '(missing)'}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(`Cloudflare Pages release error: ${error.message}`);
    process.exitCode = 1;
  });
}
