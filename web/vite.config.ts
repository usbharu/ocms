import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
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
