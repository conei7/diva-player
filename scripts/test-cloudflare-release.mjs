import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  packageRelease,
  parseCompatibilityFlagsJson,
  verifyRelease,
} from './cloudflare-release-artifact.mjs';
import {
  inspectProjectContract,
  matchesReleaseDeployment,
  previewDeploymentPageComplete,
  releaseCommitMessage,
  rollbackReachedTarget,
  SENSITIVE_ENVIRONMENT_VARIABLES,
  validatePreviewBaseline,
  validateProjectContract,
  validateRollbackCandidate,
} from './cloudflare-pages-release.mjs';

const scriptsDirectory = fileURLToPath(new URL('.', import.meta.url));
const fixtureRoot = await mkdtemp(join(scriptsDirectory, '.cloudflare-release-test-'));
const projectRoot = join(fixtureRoot, 'project');
const releaseDirectory = join(projectRoot, '.cloudflare-release');
const commit = 'a'.repeat(40);
const workflow = (await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'))
  .replaceAll('\r\n', '\n');
const spaFallback = await readFile(new URL('../functions/[[path]].js', import.meta.url), 'utf8');
const productionRoutes = JSON.parse(await readFile(new URL('../public/_routes.json', import.meta.url), 'utf8'));
const compatibilityDate = '2026-08-20';
const compatibilityFlags = ['nodejs_compat'];
const workerSource = 'const worker = { fetch: (request, env) => env.ASSETS.fetch(request) }; export { worker as default };\n';
const githubRunId = '1234567890';
const githubRunAttempt = '2';
const releaseSha256 = 'b'.repeat(64);
const releaseMarker = releaseCommitMessage({ releaseSha256, githubRunId, githubRunAttempt });

function deployment(overrides = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    environment: 'production',
    url: 'https://11111111.diva-player.pages.dev/',
    created_on: '2026-08-29T00:00:00.000Z',
    modified_on: '2026-08-29T00:01:00.000Z',
    is_skipped: false,
    latest_stage: { status: 'success' },
    deployment_trigger: {
      metadata: {
        branch: 'main',
        commit_hash: commit,
        commit_message: releaseMarker,
      },
    },
    uses_functions: true,
    ...overrides,
  };
}

function environmentConfig() {
  return {
    compatibility_date: compatibilityDate,
    always_use_latest_compatibility_date: false,
    compatibility_flags: compatibilityFlags,
    env_vars: {
      PAGES_PROXY_KEY: { type: 'secret_text', value: '' },
      TUNNEL_SYNC_TOKEN: { type: 'secret_text', value: '' },
      TUNNEL_ORIGIN_PROOF_KEY: { type: 'secret_text', value: '' },
      DIVA_API_ORIGIN_MODE: { type: 'plain_text', value: 'quick' },
    },
    kv_namespaces: {
      TUNNEL_CONFIG: { namespace_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    },
  };
}

function project(overrides = {}) {
  return {
    name: 'diva-player',
    production_branch: 'main',
    source: { config: { production_deployments_enabled: false } },
    deployment_configs: {
      preview: environmentConfig(),
      production: environmentConfig(),
    },
    canonical_deployment: deployment(),
    ...overrides,
  };
}

function namedEnvironmentConfig() {
  const config = environmentConfig();
  config.env_vars.DIVA_API_ORIGIN_MODE.value = 'named';
  config.env_vars.CF_ACCESS_CLIENT_ID = { type: 'plain_text', value: 'pages-client-id' };
  config.env_vars.CF_ACCESS_CLIENT_SECRET = { type: 'secret_text', value: '' };
  config.env_vars.DIVA_NAMED_TUNNEL_ORIGIN = {
    type: 'plain_text',
    value: 'https://api-origin.example.net',
  };
  return config;
}

try {
  assert.equal(workflow.match(/npm run build:cloudflare/g)?.length, 1);
  assert.match(workflow, /build:\n\s+if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cloudflare_contract:\n\s+if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /Inspect live Cloudflare release contract[\s\S]*--github-output "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /build:\n\s+if: github\.ref == 'refs\/heads\/main'\n\s+needs: cloudflare_contract/);
  assert.match(workflow, /deploy-cloudflare:\n\s+needs: \[cloudflare_contract, build\]/);
  assert.equal(workflow.match(/cloudflare-release-artifact\.mjs build-worker/g)?.length, 1);
  assert.equal(workflow.match(/--no-bundle/g)?.length, 2);
  assert.match(workflow, /build-worker \\\n\s+--compatibility-date "\$COMPATIBILITY_DATE" \\\n\s+--compatibility-flags-json "\$COMPATIBILITY_FLAGS_JSON"/);
  assert.doesNotMatch(workflow, /2026-07-12/);
  assert.match(workflow, /Validate Cloudflare project release contract[\s\S]*--expected-compatibility-date "\$COMPATIBILITY_DATE"[\s\S]*--expected-compatibility-flags-json "\$COMPATIBILITY_FLAGS_JSON"/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40} # v7\.0\.1/);
  assert.match(workflow, /actions\/download-artifact@[a-f0-9]{40} # v8\.0\.1/);
  assert.match(workflow, /PREVIEW_BRANCH=release-candidate/);
  const baselineIndex = workflow.indexOf('Capture preview deployment baseline');
  const previewUploadIndex = workflow.indexOf('Deploy exact release to isolated preview');
  assert.ok(baselineIndex > 0 && baselineIndex < previewUploadIndex);
  assert.match(workflow, /capture-preview[\s\S]*--output "\$RUNNER_TEMP\/preview-before-upload\.json"/);
  assert.match(workflow, /Deploy exact release to isolated preview[\s\S]*--branch "\$PREVIEW_BRANCH"/);
  assert.equal(workflow.match(/--commit-message "artifact-sha256:\$\{RELEASE_SHA256\};github-run-id:\$\{GITHUB_RUN_ID\};github-run-attempt:\$\{GITHUB_RUN_ATTEMPT\}"/g)?.length, 2);
  assert.equal(workflow.match(/--github-run-id "\$GITHUB_RUN_ID"/g)?.length, 3);
  assert.equal(workflow.match(/--github-run-attempt "\$GITHUB_RUN_ATTEMPT"/g)?.length, 3);
  assert.match(workflow, /wait-preview[\s\S]*--excluded-ids-file "\$RUNNER_TEMP\/preview-before-upload\.json"/);
  assert.match(workflow, /Verify preview root, ready, health, and origin headers/);
  assert.match(
    workflow,
    /Verify preview root, ready, health, and origin headers[\s\S]*if npm run check:public-primary-health -- --base-url "\$PREVIEW_URL" --timeout-ms 15000 --interval-ms 5000 --allow-degraded-data; then[\s\S]*sleep 30[\s\S]*npm run check:public-primary-health -- --base-url "\$PREVIEW_URL" --timeout-ms 15000 --interval-ms 5000 --allow-degraded-data/,
    'preview health must retry the complete fail-closed contract once after edge propagation delay',
  );
  assert.equal(
    workflow.match(/--base-url https:\/\/diva-player\.pages\.dev[\s\S]*?--allow-degraded-data/g)?.length,
    3,
    'rollback candidate, post-deploy, and rollback production checks must allow stale data only through the explicit gate',
  );
  assert.match(workflow, /Seal verified last-known-good production/);
  assert.match(workflow, /Deploy the same verified release to production[\s\S]*--branch main/);
  assert.match(workflow, /id: production_deploy\n\s+continue-on-error: true/);
  assert.match(workflow, /canonical state will be reconciled before rollback/);
  assert.match(workflow, /last-known-good remained canonical, so rollback was unnecessary/);
  assert.match(workflow, /rollback-production[\s\S]*--target-file "\$RUNNER_TEMP\/last-known-good-production\.json"/);
  const releaseScript = await readFile(new URL('./cloudflare-pages-release.mjs', import.meta.url), 'utf8');
  assert.match(releaseScript, /canonical\.id === target\.id/);
  assert.match(releaseScript, /rollbackResponse[\s\S]*rollbackReachedTarget\(rollbackResponse, target\)/);
  const deployJob = workflow.slice(workflow.indexOf('  deploy-cloudflare:'));
  assert.doesNotMatch(deployJob, /npm run build:cloudflare/);
  assert.match(spaFallback, /env\.ASSETS\.fetch/);
  assert.deepEqual(SENSITIVE_ENVIRONMENT_VARIABLES, [
    'PAGES_PROXY_KEY',
    'TUNNEL_SYNC_TOKEN',
    'TUNNEL_ORIGIN_PROOF_KEY',
    'CF_ACCESS_CLIENT_SECRET',
  ]);
  for (const route of ['/backend-api/*', '/tunnel-admin/update', '/watch', '/playing', '/knowledge-map']) {
    assert.ok(productionRoutes.include.includes(route), `production _routes.json must include ${route}`);
  }

  await mkdir(join(projectRoot, 'dist', 'assets'), { recursive: true });
  await mkdir(join(projectRoot, '.cloudflare-functions-build'), { recursive: true });
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ devDependencies: { wrangler: '4.120.0' } }));
  await writeFile(join(projectRoot, 'dist', 'index.html'), '<main>DIVA</main>\n');
  await writeFile(join(projectRoot, 'dist', 'assets', 'app.js'), 'console.log("DIVA");\n');
  await writeFile(join(projectRoot, 'dist', '_routes.json'), JSON.stringify({
    version: 1,
    include: ['/backend-api/*', '/tunnel-admin/update', '/watch', '/playing', '/knowledge-map'],
    exclude: [],
  }));
  await writeFile(join(projectRoot, '.cloudflare-functions-build', 'index.js'), workerSource);
  await writeFile(join(projectRoot, '.cloudflare-functions-build', 'metadata.json'), JSON.stringify({
    schemaVersion: 1,
    compatibilityDate,
    compatibilityFlags,
    workerSha256: createHash('sha256').update(workerSource).digest('hex'),
  }));

  const manifest = await packageRelease({
    projectRoot,
    outputDirectory: releaseDirectory,
    gitCommit: commit,
    githubRunId: '123',
    githubRunAttempt: '2',
    generatedAt: '2026-08-29T00:00:00.000Z',
  });
  assert.equal(manifest.gitCommit, commit);
  assert.equal(manifest.files.length, 4);
  assert.ok(manifest.files.some(file => file.path === 'dist/_worker.js'));
  assert.ok(manifest.files.every(file => !file.path.startsWith('functions/')));
  assert.match(manifest.payloadSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.pagesFunctions, {
    compatibilityDate,
    compatibilityFlags,
    workerSha256: createHash('sha256').update(workerSource).digest('hex'),
  });
  assert.deepEqual((await verifyRelease({
    releaseDirectory,
    expectedCommit: commit,
    expectedCompatibilityDate: compatibilityDate,
    expectedCompatibilityFlags: compatibilityFlags,
  })).files, manifest.files);
  await assert.rejects(
    verifyRelease({
      releaseDirectory,
      expectedCommit: commit,
      expectedCompatibilityDate: '2026-08-19',
    }),
    /release compatibility date mismatch/,
  );

  await writeFile(join(releaseDirectory, 'payload', 'dist', 'index.html'), '<main>tampered</main>\n');
  await assert.rejects(
    verifyRelease({ releaseDirectory, expectedCommit: commit }),
    /release payload hash mismatch/,
  );
  await writeFile(join(releaseDirectory, 'payload', 'dist', 'index.html'), '<main>DIVA</main>\n');
  await writeFile(join(releaseDirectory, 'payload', 'unexpected.txt'), 'unexpected\n');
  await assert.rejects(
    verifyRelease({ releaseDirectory, expectedCommit: commit }),
    /release payload hash mismatch/,
  );

  const storedManifest = JSON.parse(await readFile(join(releaseDirectory, 'manifest.json'), 'utf8'));
  storedManifest.files[0].path = '../escape';
  await writeFile(join(releaseDirectory, 'manifest.json'), `${JSON.stringify(storedManifest)}\n`);
  await assert.rejects(
    verifyRelease({ releaseDirectory, expectedCommit: commit }),
    /unsafe path/,
  );

  assert.equal(validateProjectContract(project()).id, deployment().id);
  assert.deepEqual(inspectProjectContract(project()), {
    canonical: project().canonical_deployment,
    compatibilityDate,
    compatibilityFlags,
  });
  assert.deepEqual(parseCompatibilityFlagsJson('["nodejs_compat"]'), compatibilityFlags);
  assert.throws(() => parseCompatibilityFlagsJson('["nodejs_compat","nodejs_compat"]'), /duplicate flag/);
  assert.equal(releaseMarker, `artifact-sha256:${releaseSha256};github-run-id:${githubRunId};github-run-attempt:${githubRunAttempt}`);
  assert.throws(
    () => releaseCommitMessage({ releaseSha256, githubRunId: '0', githubRunAttempt }),
    /GitHub run ID is invalid/,
  );
  assert.throws(
    () => validateProjectContract(project({ source: { config: { production_deployments_enabled: true } } })),
    /automatic production branch deployments must be disabled/,
  );
  const mismatchedPreview = environmentConfig();
  mismatchedPreview.kv_namespaces.TUNNEL_CONFIG.namespace_id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.throws(
    () => validateProjectContract(project({
      deployment_configs: { production: environmentConfig(), preview: mismatchedPreview },
    })),
    /same TUNNEL_CONFIG namespace/,
  );
  const latestCompatibilityPreview = environmentConfig();
  latestCompatibilityPreview.always_use_latest_compatibility_date = true;
  assert.throws(
    () => validateProjectContract(project({
      deployment_configs: { production: environmentConfig(), preview: latestCompatibilityPreview },
    })),
    /latest compatibility date overrides must be disabled/,
  );
  const mismatchedCompatibilityPreview = environmentConfig();
  mismatchedCompatibilityPreview.compatibility_date = '2026-08-19';
  assert.throws(
    () => validateProjectContract(project({
      deployment_configs: { production: environmentConfig(), preview: mismatchedCompatibilityPreview },
    })),
    /compatibility dates must match/,
  );
  const missingPreviewSecret = environmentConfig();
  delete missingPreviewSecret.env_vars.PAGES_PROXY_KEY;
  assert.throws(
    () => validateProjectContract(project({
      deployment_configs: { production: environmentConfig(), preview: missingPreviewSecret },
    })),
    /preview PAGES_PROXY_KEY is missing/,
  );
  for (const sensitiveName of SENSITIVE_ENVIRONMENT_VARIABLES.slice(0, 3)) {
    for (const environment of ['production', 'preview']) {
      const production = environmentConfig();
      const preview = environmentConfig();
      const config = environment === 'production' ? production : preview;
      config.env_vars[sensitiveName] = { type: 'plain_text', value: 'must-not-be-plain' };
      assert.throws(
        () => validateProjectContract(project({ deployment_configs: { production, preview } })),
        new RegExp(`${environment} ${sensitiveName} must be secret_text`),
      );
    }
  }
  assert.equal(validateProjectContract(project()).id, deployment().id);

  const quickProductionWithAccess = environmentConfig();
  const quickPreviewWithAccess = environmentConfig();
  quickProductionWithAccess.env_vars.CF_ACCESS_CLIENT_SECRET = { type: 'secret_text', value: '' };
  quickPreviewWithAccess.env_vars.CF_ACCESS_CLIENT_SECRET = { type: 'secret_text', value: '' };
  assert.equal(validateProjectContract(project({
    deployment_configs: { production: quickProductionWithAccess, preview: quickPreviewWithAccess },
  })).id, deployment().id);

  quickProductionWithAccess.env_vars.CF_ACCESS_CLIENT_SECRET = { type: 'plain_text', value: 'unsafe' };
  quickPreviewWithAccess.env_vars.CF_ACCESS_CLIENT_SECRET = { type: 'plain_text', value: 'unsafe' };
  assert.throws(
    () => validateProjectContract(project({
      deployment_configs: { production: quickProductionWithAccess, preview: quickPreviewWithAccess },
    })),
    /production CF_ACCESS_CLIENT_SECRET must be secret_text/,
  );

  for (const environment of ['production', 'preview']) {
    const production = environmentConfig();
    const preview = environmentConfig();
    const config = environment === 'production' ? production : preview;
    config.env_vars.CF_ACCESS_CLIENT_SECRET = { type: 'secret_text', value: '' };
    assert.throws(
      () => validateProjectContract(project({ deployment_configs: { production, preview } })),
      /environment variable name sets must match exactly/,
    );
  }

  const previewOnlyVariable = environmentConfig();
  previewOnlyVariable.env_vars.PREVIEW_ONLY_BEHAVIOR = { type: 'plain_text', value: 'unsafe-drift' };
  assert.throws(
    () => validateProjectContract(project({
      deployment_configs: { production: environmentConfig(), preview: previewOnlyVariable },
    })),
    /environment variable name sets must match exactly/,
  );

  assert.equal(validateProjectContract(project({
    deployment_configs: { production: namedEnvironmentConfig(), preview: namedEnvironmentConfig() },
  })).id, deployment().id);
  const namedFields = ['CF_ACCESS_CLIENT_ID', 'DIVA_NAMED_TUNNEL_ORIGIN'];
  for (const field of namedFields) {
    const production = namedEnvironmentConfig();
    const preview = namedEnvironmentConfig();
    delete production.env_vars[field];
    delete preview.env_vars[field];
    assert.throws(
      () => validateProjectContract(project({ deployment_configs: { production, preview } })),
      new RegExp(`named origin requires ${field}`),
    );
  }
  const mismatchedNamedPreview = namedEnvironmentConfig();
  mismatchedNamedPreview.env_vars.DIVA_NAMED_TUNNEL_ORIGIN.value = 'https://different-origin.example.net';
  assert.throws(
    () => validateProjectContract(project({
      deployment_configs: { production: namedEnvironmentConfig(), preview: mismatchedNamedPreview },
    })),
    /DIVA_NAMED_TUNNEL_ORIGIN differs from production/,
  );
  const namedWithoutAccessProduction = namedEnvironmentConfig();
  const namedWithoutAccessPreview = namedEnvironmentConfig();
  delete namedWithoutAccessProduction.env_vars.CF_ACCESS_CLIENT_SECRET;
  delete namedWithoutAccessPreview.env_vars.CF_ACCESS_CLIENT_SECRET;
  assert.throws(
    () => validateProjectContract(project({
      deployment_configs: {
        production: namedWithoutAccessProduction,
        preview: namedWithoutAccessPreview,
      },
    })),
    /production CF_ACCESS_CLIENT_SECRET is missing/,
  );

  const priorPreviewId = '22222222-3333-4444-5555-666666666666';
  assert.deepEqual(validatePreviewBaseline({
    schemaVersion: 1,
    project: 'diva-player',
    branch: 'release-candidate',
    deploymentIds: [priorPreviewId],
  }, 'release-candidate'), [priorPreviewId]);
  assert.throws(
    () => validatePreviewBaseline({
      schemaVersion: 1,
      project: 'diva-player',
      branch: 'release-candidate',
      deploymentIds: [priorPreviewId, priorPreviewId],
    }, 'release-candidate'),
    /duplicate IDs/,
  );

  const fullPreviewPage = Array.from({ length: 20 }, () => ({}));
  assert.equal(previewDeploymentPageComplete(
    fullPreviewPage,
    { page: 1, per_page: 20, total_pages: 2 },
    1,
  ), false);
  assert.equal(previewDeploymentPageComplete(
    fullPreviewPage,
    { page: 2, per_page: 20, total_pages: 2 },
    2,
  ), true);
  assert.equal(previewDeploymentPageComplete([{}], null, 1), true);
  assert.throws(
    () => previewDeploymentPageComplete(
      fullPreviewPage,
      { page: 1, per_page: 100, total_pages: 1 },
      1,
    ),
    /pagination size is invalid/,
  );
  assert.throws(
    () => previewDeploymentPageComplete(
      fullPreviewPage,
      { page: 2, per_page: 20, total_pages: 2 },
      1,
    ),
    /pagination page is invalid/,
  );

  assert.equal(matchesReleaseDeployment(deployment(), {
    environment: 'production',
    branch: 'main',
    commitHash: commit,
    commitMessage: releaseMarker,
    excludedId: 'different-deployment',
  }), true);
  assert.equal(matchesReleaseDeployment(deployment(), {
    environment: 'production',
    branch: 'main',
    commitHash: commit,
    commitMessage: releaseCommitMessage({
      releaseSha256,
      githubRunId,
      githubRunAttempt: '1',
    }),
  }), false);
  assert.equal(matchesReleaseDeployment(deployment({ uses_functions: false }), {
    environment: 'production',
    branch: 'main',
    commitHash: commit,
    commitMessage: releaseMarker,
  }), false);
  assert.equal(matchesReleaseDeployment(deployment(), {
    environment: 'production',
    branch: 'main',
    commitHash: commit,
    commitMessage: releaseMarker,
    excludedIds: [deployment().id],
  }), false);

  const rollbackTarget = {
    id: deployment().id,
    url: deployment().url,
    commitHash: commit,
  };
  assert.equal(validateRollbackCandidate(rollbackTarget, deployment()).id, rollbackTarget.id);
  assert.equal(rollbackReachedTarget(deployment(), rollbackTarget), true);
  assert.equal(rollbackReachedTarget(deployment({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }), rollbackTarget), false);
  assert.throws(
    () => validateRollbackCandidate(rollbackTarget, deployment({ environment: 'preview' })),
    /expected a production deployment/,
  );
  assert.throws(
    () => validateRollbackCandidate({ ...rollbackTarget, commitHash: 'f'.repeat(40) }, deployment()),
    /no longer matches/,
  );

  console.log('PASS Cloudflare Pages release artifact and promotion contracts');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
