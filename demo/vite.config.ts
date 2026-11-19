import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({command,isPreview})=>({
  root:fileURLToPath(new URL('./',import.meta.url)),
  publicDir:fileURLToPath(new URL('../public',import.meta.url)),
  base:command==='build'||isPreview?'/Next-Portaria/':'/',
  plugins:[react()],
  server:{host:'127.0.0.1',port:4173,strictPort:true},
  build:{outDir:fileURLToPath(new URL('../dist-demo',import.meta.url)),emptyOutDir:true},
}));
