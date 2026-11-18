/* global process */
import adapter from '@sveltejs/adapter-static';
import preprocess from 'svelte-preprocess';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    immutable: true
  },

  // Consult https://github.com/sveltejs/svelte-preprocess
  // for more information about preprocessors
  preprocess: [
    preprocess({
      postcss: true
    })
  ],

  kit: {
    adapter: adapter({
      fallback: '404.html'
    }),
    paths: {
      // build with VITE_PAGE_PATH=/reader to host the reader under example.com/reader
      base: process.env.VITE_PAGE_PATH || ''
    }
  }
};

export default config;
