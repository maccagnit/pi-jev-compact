import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export const piRoot = process.env.PI_PACKAGE_DIR || join(execFileSync('npm', ['root', '-g'], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(), '@earendil-works/pi-coding-agent');
// Tests never see this machine's pi-jev-compact.json or ~/.config/jev/typesafe.key: a key would make
// them call Jev. HOME moves only after npm has located Pi (npm's prefix may come from ~/.npmrc).
const agentDir = mkdtempSync(join(tmpdir(), 'pi-jev-agent-'));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = agentDir;
process.on('exit', () => rmSync(agentDir, { recursive: true, force: true }));
export const sdk = await import(pathToFileURL(join(piRoot, 'dist/index.js')).href);
export const ai = await import(pathToFileURL(join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
