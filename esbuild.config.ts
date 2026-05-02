import { parseArgs } from 'node:util';
import esbuild from 'esbuild';

const { values } = parseArgs({
  options: {
    watch: { type: 'boolean', default: false },
  },
});
const watch = values.watch;

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node18',
    format: 'esm',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
    minify: false,
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
