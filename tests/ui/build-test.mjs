/**
 * Test-only browser build (no Vite needed): esbuild for JS + the worker,
 * Tailwind's compile() API for CSS. Output: <outdir>/index.html etc.
 *
 *   node tests/ui/build-test.mjs /tmp/uibuild <node_modules dirs...>
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const [out, ...nodePaths] = process.argv.slice(2);
const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(join(nodePaths[0] ?? join(root, 'node_modules'), 'x.js'));
const { build } = require('esbuild');
mkdirSync(join(out, 'assets'), { recursive: true });
mkdirSync(join(out, 'workers'), { recursive: true });

const common = {
  bundle: true, format: 'esm', target: 'es2020', sourcemap: 'inline', nodePaths: [join(root, 'node_modules'), ...nodePaths],
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.PROD': 'false' }, jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'warning',
};
await build({ ...common, entryPoints: [join(root, 'src/main.tsx')], outfile: join(out, 'assets/main.js') });
await build({ ...common, entryPoints: [join(root, 'src/workers/archive.worker.ts')], outfile: join(out, 'workers/archive.worker.ts') });

// Tailwind v4: compile src/index.css against class-name candidates scraped from the sources.
const { compile } = require('tailwindcss');
const twDir = dirname(require.resolve('tailwindcss/package.json'));
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const candidates = new Set();
for (const f of walk(join(root, 'src')).filter((f) => /\.(tsx?|css)$/.test(f))) {
  for (const tok of readFileSync(f, 'utf8').split(/[\s"'`{}<>;]+/)) if (tok) candidates.add(tok); // commas allowed: max(a,b)
}
const compiler = await compile(readFileSync(join(root, 'src/index.css'), 'utf8'), {
  base: join(root, 'src'),
  loadStylesheet: async (id, base) => {
    const file = id === 'tailwindcss' ? join(twDir, 'index.css') : join(twDir, id.replace(/^tailwindcss\//, ''));
    return { path: file, base: dirname(file), content: readFileSync(file, 'utf8') };
  },
});
writeFileSync(join(out, 'assets/main.css'), compiler.build([...candidates]));

const html = readFileSync(join(root, 'index.html'), 'utf8')
  .replace('<script type="module" src="/src/main.tsx"></script>', '<link rel="stylesheet" href="./assets/main.css" /><script type="module" src="./assets/main.js"></script>');
writeFileSync(join(out, 'index.html'), html);
for (const f of readdirSync(join(root, 'public'))) copyFileSync(join(root, 'public', f), join(out, f));
console.log('test build written to', out);
