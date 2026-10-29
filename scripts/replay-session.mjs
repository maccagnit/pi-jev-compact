// Offline regression against a private copy. Never modifies or transmits the source session.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sdk } from './pi-sdk.mjs';
import { MARKER, tokens } from '../compact.ts';
const source=process.argv[2];if(!source) throw Error('Usage: node scripts/replay-session.mjs /path/to/session.jsonl');
const digest=b=>createHash('sha256').update(b).digest('hex');
const originalHash=digest(await readFile(source));
const dir=await mkdtemp(join(tmpdir(),'jev-replay-'));
const key=process.env.TYPESAFE_API_KEY;delete process.env.TYPESAFE_API_KEY;
let session;
try {
 const copied=join(dir,'session.jsonl');await copyFile(source,copied);
 const manager=sdk.SessionManager.open(copied);
 const beforeBranch=structuredClone(manager.getBranch());
 const previous=[...beforeBranch].reverse().find(e=>e.type==='compaction');
 const settings=sdk.SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:20000}});
 const runtime=await sdk.ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,modelsStorePath:join(dir,'models-store.json'),refreshOnCreate:false});
 runtime.registerProvider('offline',{api:'openai-completions',baseUrl:'http://127.0.0.1:1',apiKey:'synthetic',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:65536,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
 runtime.streamSimple=()=>{throw Error('Unexpected model request during offline replay')};
 const loader=new sdk.DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,additionalExtensionPaths:[resolve('index.ts')],noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
 await loader.reload();
 const created=await sdk.createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel('offline','fixture'),sessionManager:manager,settingsManager:settings,resourceLoader:loader});
 session=created.session;assert.deepEqual(created.extensionsResult.errors,[]);await session.bindExtensions({mode:'json'});
 const contextSize=()=>sdk.buildSessionContext(manager.getBranch()).messages.reduce((n,m)=>n+sdk.estimateTokens(m),0);
 const before=contextSize();
 const result=await session.compact();assert.equal(result.details.engine,MARKER);
 assert(result.summary.includes(previous.summary),'Prior native summary must remain exact');
 const after=contextSize();assert(after<before);
 for(const e of beforeBranch) assert.deepEqual(manager.getEntry(e.id),e);
 const restored=sdk.SessionManager.open(copied);
 assert.equal(restored.getBranch().at(-1).summary,result.summary);
 const seenCalls=new Set();let pairs=0;
 for(const m of sdk.buildSessionContext(manager.getBranch()).messages){
   if(m.role==='assistant') for(const c of m.content) if(c.type==='toolCall') seenCalls.add(c.id);
   if(m.role==='toolResult'){assert(seenCalls.has(m.toolCallId));pairs++}
 }
 assert.equal(digest(await readFile(source)),originalHash,'Source session changed during replay');
 console.log(JSON.stringify({copiedSessionOnly:true,sourceUnchanged:true,priorCheckpointChars:previous.summary.length,priorCheckpointEstimate:tokens(previous.summary),rawEntriesPreserved:beforeBranch.length,toolPairsValidated:pairs,piBeforeEstimate:before,piAfterEstimate:after,piSavedEstimate:before-after,reloadedCheckpoint:true,metrics:result.details.metrics},null,2));
} finally {
 session?.dispose();if(key===undefined) delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=key;
 await rm(dir,{recursive:true,force:true});
}
