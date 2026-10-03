// API-only deployment: no frontend checkout, admin folder or credentials needed.
import { mkdir, writeFile } from 'node:fs/promises';
const output = new URL('../dist/', import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL('index.html', output), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex"><title>ANRAF API</title><p>ANRAF API service</p></html>');
await writeFile(new URL('_headers', output), '/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src \'none\'; frame-ancestors \'none\'\n');
await writeFile(new URL('_routes.json', output), JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }));
console.log('Standalone backend built in dist/. Pages deploys functions/ alongside it.');
