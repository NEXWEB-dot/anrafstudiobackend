import {writeFile} from 'node:fs/promises';
import {sanityURL,normalizeSanity} from '../shared/sanity-source.js';
const response=await fetch(sanityURL(process.env),{signal:AbortSignal.timeout(12000)});
if (!response.ok) throw new Error(`Sanity backup failed: ${response.status}`);
const catalog=normalizeSanity((await response.json()).result,process.env);
await writeFile(new URL('../backups/sanity.snapshot.json',import.meta.url),JSON.stringify(catalog,null,2)+'\n');
console.log(`Backed up ${catalog.products.length} published products.`);
