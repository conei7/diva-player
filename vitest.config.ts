import { mergeConfig } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default defineConfig(async configEnv => mergeConfig(await viteConfig(configEnv), {
  test: {
    exclude: [
      ...configDefaults.exclude,
      '**/.worktrees/**',
      '**/.npm-cache/**',
      '**/.quota-pipeline-docs/**',
    ],
  },
}));
