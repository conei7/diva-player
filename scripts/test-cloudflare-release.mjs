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
  rollbackReachedTarget,
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
        commit_message: `artifact-sha256:${'b'.repeat(64)}`,
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
  assert.match(workflow, /Deploy exact release to isolated preview[\s\S]*--branch "\$preview_branch"/);
  assert.match(workflow, /preview_branch="release-candidate"/);
  assert.match(workflow, /Verify preview root, ready, health, and origin headers/);
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

  assert.equal(matchesReleaseDeployment(deployment(), {
    environment: 'production',
    branch: 'main',
    commitHash: commit,
    commitMessage: `artifact-sha256:${'b'.repeat(64)}`,
    excludedId: 'different-deployment',
  }), true);
  assert.equal(matchesReleaseDeployment(deployment(), {
    environment: 'production',
    branch: 'main',
    commitHash: commit,
    commitMessage: `artifact-sha256:${'c'.repeat(64)}`,
  }), false);
  assert.equal(matchesReleaseDeployment(deployment({ uses_functions: false }), {
    environment: 'production',
    branch: 'main',
    commitHash: commit,
    commitMessage: `artifact-sha256:${'b'.repeat(64)}`,
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
