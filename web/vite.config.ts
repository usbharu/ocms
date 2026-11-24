import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

function buildVersion(): string {
  const version = process.env.OCMS_VERSION?.trim();
  if (version) return version;

  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: new URL('.', import.meta.url),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '開発ビルド';
  }
}

export default defineConfig({
  define: { __OCMS_VERSION__: JSON.stringify(buildVersion()) },
  plugins: [
    tailwindcss(),
    {
      name: 'ocms-offline-worker',
      apply: 'build',
      generateBundle() {
        const worker = readFileSync(
          new URL('./service-worker.js', import.meta.url),
          'utf8',
        );
        const version = createHash('sha256')
          .update(worker)
          .update(
            readFileSync(new URL('./public/offline.html', import.meta.url)),
          )
          .update(
            readFileSync(new URL('./public/offline.css', import.meta.url)),
          )
          .digest('hex')
          .slice(0, 16);
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: worker.replace('__VERSION__', version),
        });
      },
    },
    {
      name: 'pdfjs-local-assets',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url?.startsWith('/pdfjs/')) {
            request.url = request.url.replace(
              '/pdfjs/',
              '/node_modules/pdfjs-dist/',
            );
          }
          next();
        });
      },
      generateBundle() {
        for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
          const root = new URL(
            `./node_modules/pdfjs-dist/${directory}/`,
            import.meta.url,
          );
          for (const name of readdirSync(root)) {
            this.emitFile({
              type: 'asset',
              fileName: `pdfjs/${directory}/${name}`,
              source: readFileSync(join(root.pathname, name)),
            });
          }
        }
      },
    },
  ],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
});
