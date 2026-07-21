const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const electronDir = path.resolve(__dirname, '..');
const rendererDir = path.join(electronDir, 'renderer');

async function main() {
  await fs.promises.mkdir(rendererDir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(electronDir, 'node_modules', 'jassub', 'dist', 'worker', 'worker.js')],
    outfile: path.join(rendererDir, 'jassub-worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome140',
    sourcemap: false
  });

  await esbuild.build({
    entryPoints: [path.join(rendererDir, 'ass-subtitles-entry.js')],
    outfile: path.join(rendererDir, 'ass-subtitles.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome140',
    sourcemap: false,
    loader: {
      '.wasm': 'dataurl',
      '.woff2': 'binary'
    }
  });
  await esbuild.build({
    entryPoints: [path.join(rendererDir, 'bitmap-subtitles-entry.js')],
    outfile: path.join(rendererDir, 'bitmap-subtitles.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome140',
    sourcemap: false,
    plugins: [{
      name: 'libbitsub-worker-wasm-url',
      setup(build) {
        build.onLoad({ filter: /[\\/]libbitsub[\\/]dist[\\/]ts[\\/]wasm\.js$/ }, async (args) => {
          const source = await fs.promises.readFile(args.path, 'utf8');
          return {
            contents: source.replaceAll('../../pkg/libbitsub_bg.wasm', './libbitsub_bg.wasm'),
            loader: 'js'
          };
        });
      }
    }]
  });
  await fs.promises.copyFile(
    path.join(electronDir, 'node_modules', 'libbitsub', 'pkg', 'libbitsub_bg.wasm'),
    path.join(rendererDir, 'libbitsub_bg.wasm')
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
