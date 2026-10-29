import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export const piRoot = process.env.PI_PACKAGE_DIR || join(execFileSync('npm', ['root', '-g'], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(), '@earendil-works/pi-coding-agent');
export const sdk = await import(pathToFileURL(join(piRoot, 'dist/index.js')).href);
export const ai = await import(pathToFileURL(join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
