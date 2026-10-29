import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Tests never read this machine's pi-jev-compact.json: a configured key file would make them call Jev.
const agentDir = mkdtempSync(join(tmpdir(), 'pi-jev-agent-'));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on('exit', () => rmSync(agentDir, { recursive: true, force: true }));
export const piRoot = process.env.PI_PACKAGE_DIR || join(execFileSync('npm', ['root', '-g'], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(), '@earendil-works/pi-coding-agent');
export const sdk = await import(pathToFileURL(join(piRoot, 'dist/index.js')).href);
export const ai = await import(pathToFileURL(join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
