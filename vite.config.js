import { defineConfig } from 'vite';

export default defineConfig({
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
