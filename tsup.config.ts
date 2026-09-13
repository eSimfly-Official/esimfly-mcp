import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', server: 'src/server.ts' },
  format: ['esm'],
  dts: { entry: { server: 'src/server.ts' } },
  sourcemap: true,
  clean: true,
  target: 'node18',
  platform: 'node',
  banner: ({ format }) => (format === 'esm' ? { js: '' } : {}),
  esbuildOptions(options, { entry }) {
    // Only the CLI entry gets the shebang.
    options.banner = undefined;
  },
  onSuccess: 'node -e "const fs=require(\'fs\');const p=\'dist/index.js\';const s=fs.readFileSync(p,\'utf8\');if(!s.startsWith(\'#!\'))fs.writeFileSync(p,\'#!/usr/bin/env node\\n\'+s);fs.chmodSync(p,0o755)"',
});
