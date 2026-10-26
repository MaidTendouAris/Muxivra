import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: {index:resolve('src/main/index.ts'),'hardware-worker':resolve('src/main/hardware-worker.ts'),'metadata-worker':resolve('src/main/metadata-worker.ts'),'player-render-worker':resolve('src/main/player/render-worker.ts')},output:{entryFileNames:'[name].js'} } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: {index:resolve('src/preload/index.ts'),'source-editor':resolve('src/preload/source-editor.ts')} } }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [{
      // Monaco 0.57 also vendors DOMPurify 3.4.15 inside its ESM tree. The npm
      // override alone does not replace that copy; bundle the patched upstream.
      name:'monaco-patched-sanitizer',enforce:'pre',
      resolveId(source,importer){if(importer?.replaceAll('\\','/').includes('/monaco-editor/')&&source==='./dompurify/dompurify.js')return resolve('node_modules/dompurify/dist/purify.es.mjs')}
    },react(), tailwindcss()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
