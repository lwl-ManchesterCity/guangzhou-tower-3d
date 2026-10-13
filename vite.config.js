import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 高德的地点数据允许查询、不允许再分发，所以快照留在 data/（public/ 之外），dev 服务器按名字放行这一个文件：
// vite build 的产物里没有它，线上页面也就不会请求它，合并卡片自动退回「相邻建筑群」的写法。
const served = new Set(['jingtai-amap-names.json']);
const dataDir = fileURLToPath(new URL('./data', import.meta.url));

function localDataOnly() {
  return {
    name: 'local-data-only',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
        if (!path.startsWith('/local/')) return next();
        const name = path.slice('/local/'.length);
        // 名字取自白名单而不是请求，所以这里既没有目录穿越，也不会把 data/ 的其它原始快照暴露出来。
        if (!served.has(name)) {
          response.statusCode = 404;
          return response.end('not found');
        }
        try {
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.setHeader('cache-control', 'no-store');
          response.end(await readFile(`${dataDir}/${name}`));
        } catch {
          response.statusCode = 404;
          response.end('not found');
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [localDataOnly()],
  build: {
    rollupOptions: {
      output: {
        // 两个渲染器各自一块，页面代码第三块：MapLibre 与 three 都是几百 KB 的第三方，跟应用代码捆在一起时
        // 改一行应用代码就要让用户重下一整包；分开之后应用代码变了只重下自己那块。
        // three 那块本来就是按需的（`?engine=three` 才动态 import），这里钉住名字，别让它被并进主包。
        advancedChunks: {
          groups: [
            { name: 'maplibre', test: /node_modules[/\\]maplibre-gl/ },
            { name: 'three', test: /node_modules[/\\]three/ },
          ],
        },
      },
    },
  },
});
