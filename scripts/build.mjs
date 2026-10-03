// Stage only public assets from the adjacent storefront; never publish the workspace root.
import { cp, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = new URL('../../',import.meta.url);
const output = new URL('../public/',import.meta.url);
await access(new URL('index.html',source));
await mkdir(output,{recursive:true});
await import('../../tools/update-csp.mjs');
for (const item of ['index.html','store.html','product.html','cart.html','checkout.html','order-confirmed.html','_headers','robots.txt','sitemap.xml','js','css','assets','data','admin']) {
  await cp(new URL(item,source),new URL(item,output),{recursive:true});
}
await import('./fetch-fallback.mjs');
console.log(`Public assets staged at ${fileURLToPath(output)}`);
