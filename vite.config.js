import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const dataRoot = path.resolve(process.cwd(), 'public', 'data');
const mimeTypes = {
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function dataMiddleware() {
  return {
    name: 'serve-question-data',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/data/')) {
          next();
          return;
        }
        let relativePath;
        try {
          relativePath = decodeURIComponent(request.url.split('?')[0].slice('/data/'.length));
        } catch {
          response.statusCode = 400;
          response.end('Invalid data path');
          return;
        }
        const filePath = path.resolve(dataRoot, relativePath);
        if (!filePath.startsWith(`${dataRoot}${path.sep}`)) {
          response.statusCode = 403;
          response.end('Forbidden');
          return;
        }
        fs.stat(filePath, (error, stats) => {
          if (error || !stats.isFile()) {
            next();
            return;
          }
          const extension = path.extname(filePath).slice(1).toLowerCase();
          response.statusCode = 200;
          response.setHeader('Content-Type', mimeTypes[extension] || 'application/octet-stream');
          response.setHeader('Cache-Control', 'no-cache');
          fs.createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
        });
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  // Vite copies public/ for production. During development the custom data
  // middleware avoids scanning tens of thousands of question images.
  publicDir: command === 'build' ? 'public' : false,
  plugins: command === 'serve' ? [dataMiddleware()] : [],
  server: {
    watch: {
      ignored: ['**/申论题库/**', '**/综应题库/**', '**/行测题库/**', '**/公基题库/**', '**/public/data/**'],
    },
  },
}));
