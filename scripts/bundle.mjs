import esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

esbuild.build({
  entryPoints: [path.join(__dirname, '..', 'src', 'server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(__dirname, '..', 'dist', 'server.js'),
  external: [],
  format: 'esm',
  banner: {
    js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
  },
}).then(() => {
  console.log('Build complete');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
