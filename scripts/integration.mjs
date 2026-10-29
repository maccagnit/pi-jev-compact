import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sdk, ai, piRoot } from './pi-sdk.mjs';
import { recall, MARKER } from '../compact.ts';

const { SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime, createAgentSession, estimateTokens } = sdk;
const dir = await mkdtemp(join(tmpdir(), 'pi-jev-test-'));
const originalKey = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
let session;
const usage = {input:1200,output:50,cacheRead:0,cacheWrite:0,totalTokens:1250,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant = content => ({id:randomUUID(),role:'assistant',content,api:'openai-completions',provider:'test',model:'fixture',stopReason:'stop',usage,timestamp:Date.now()});
try {
  const manager = SessionManager.create(dir, dir);
  const originals = [];
  function appendBatch(n, constraint) {
    manager.appendMessage({id:randomUUID(),role:'user',content:constraint,timestamp:Date.now()});
    for(let i=0;i<n;i++) {
      const callId=randomUUID();
      manager.appendMessage(assistant([{type:'toolCall',id:callId,name:'read',arguments:{path:`/fixture/${i}.txt`}}]));
      manager.appendMessage({id:randomUUID(),role:'toolResult',toolCallId:callId,toolName:'read',content:[{type:'text',text:`fixture ${i}\n`+'test output safe\n'.repeat(500)+`END_SENTINEL_${i}`}],isError:false,timestamp:Date.now()});
    }
    manager.appendMessage(assistant([{type:'text',text:'Finished inspection; tests are next.'}]));
  }
  appendBatch(25, 'Preserve ACCOUNT_0017. Never deploy without approval.');
  const hiddenId = manager.appendMessage({id:randomUUID(),role:'user',content:'OMITTED_POISON',timestamp:Date.now()});
  manager.appendContextEdit(hiddenId, null);
  manager.appendMessage({id:randomUUID(),role:'user',content:'Check tests next.',timestamp:Date.now()});
  manager.appendMessage(assistant([{type:'text',text:'Ready to test.'}]));
  originals.push(...manager.getBranch().filter(e=>e.type==='message'));
  const settings = SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:8000}});
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,modelsStorePath:join(dir,'models-store.json'),refreshOnCreate:false});
  runtime.registerProvider('test',{api:'openai-completions',baseUrl:'http://127.0.0.1:1',apiKey:'synthetic',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:65536,maxTokens:4096,cost:usage.cost}]});
  const model=runtime.getModel('test','fixture');assert(model);
  let calls=0;
  const outputLimits=[];
  runtime.streamSimple = (_model,context,options) => {
    calls++;outputLimits.push(options.maxTokens);assert(!JSON.stringify(context).includes('OMITTED_POISON'));
    const stream=ai.createAssistantMessageEventStream();
    const response=assistant([{type:'text',text:'Inspected fixture files. Pending task: run tests. Deployment still requires approval.'}]);
    queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message:response});stream.end(response)});
    return stream;
  };
  const loader = new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,additionalExtensionPaths:[resolve('index.ts')],noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'Synthetic integration fixture.'});
  await loader.reload();
  const created=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model,sessionManager:manager,settingsManager:settings,resourceLoader:loader});
  session=created.session;assert.deepEqual(created.extensionsResult.errors,[]);
  await session.bindExtensions({mode:'json',onError:e=>{throw Error(JSON.stringify(e))}});
  assert(created.extensionsResult.extensions.some(e=>e.tools.has('jev_recall')));
  const before=sdk.buildSessionContext(manager.getBranch()).messages.reduce((s,m)=>s+estimateTokens(m),0);
  const result=await session.compact();
  assert.equal(result.details.engine,MARKER);assert.equal(calls,0);
  assert.equal(result.details.metrics.mode,'extractive');
  assert(result.summary.includes('ACCOUNT_0017'));assert(!result.summary.includes('OMITTED_POISON'));
  const after=sdk.buildSessionContext(manager.getBranch()).messages.reduce((s,m)=>s+estimateTokens(m),0);
  for (const entry of originals) assert.deepEqual(manager.getEntry(entry.id),entry);
  // Every surviving tool result must retain its preceding call.
  function checkPairs() {
    const calls=new Set();
    for(const m of sdk.buildSessionContext(manager.getBranch()).messages) {
      if(m.role==='assistant') for(const c of m.content) if(c.type==='toolCall') calls.add(c.id);
      if(m.role==='toolResult') assert(calls.has(m.toolCallId));
    }
  }
  checkPairs();
  appendBatch(12,'Also preserve INVOICE_991.');
  await session.prompt('/jev-compact summary');
  const second=await session.compact();assert.equal(calls,1);
  assert(second.summary.includes('ACCOUNT_0017'));assert(second.summary.includes('INVOICE_991'));checkPairs();
  const found=recall(manager.getBranch(),{query:'END_SENTINEL_3'});assert(found.total>=1);
  // Reload from the real persisted JSONL, recover an entry across both compactions.
  const restored=SessionManager.open(manager.getSessionFile());
  const recovered=recall(restored.getBranch(),{id:found.matches[0].id});assert.equal(recovered.id,found.matches[0].id);
  assert(restored.getBranch().filter(e=>e.type==='compaction').length===2);
  // A custom budget refusal must fall through to Pi, not cancel compaction.
  session.dispose();
  const fallbackManager=SessionManager.create(dir,dir);
  fallbackManager.appendMessage({id:randomUUID(),role:'user',content:'Too little history to reclaim. '.repeat(30),timestamp:Date.now()});
  fallbackManager.appendMessage(assistant([{type:'text',text:'Recent tail.'}]));
  const fallbackSettings=SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:0}});
  const fallbackLoader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:fallbackSettings,additionalExtensionPaths:[resolve('index.ts')],noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
  await fallbackLoader.reload();
  const fallbackSession=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model,sessionManager:fallbackManager,settingsManager:fallbackSettings,resourceLoader:fallbackLoader});
  session=fallbackSession.session;assert.deepEqual(fallbackSession.extensionsResult.errors,[]);
  await session.bindExtensions({mode:'json',onError:e=>{throw Error(JSON.stringify(e))}});
  const nativeResult=await session.compact();
  assert(nativeResult.summary);assert.notEqual(nativeResult.details.engine,MARKER);assert.equal(calls,2);
  assert.equal(fallbackManager.getBranch().filter(e=>e.type==='compaction').length,1);
  // The fall-through is recorded in the session (notices are invisible in print/json mode).
  const record=fallbackManager.getBranch().find(e=>e.type==='custom'&&e.customType==='pi-jev-compact-fallback');
  assert.deepEqual(record?.data,{version:JSON.parse(await readFile(resolve('package.json'),'utf8')).version,reason:'too_little_to_reclaim',jevKey:'none'});
  // Pi <1.4 passed the model maxTokens to native summaries; 1.4 leaves it to the provider.
  assert.equal(outputLimits[0],1000);assert([4096,undefined].includes(outputLimits[1]));
  // Only a user's actual abort cancels the host; ordinary exceptions fall through.
  const extension=fallbackSession.extensionsResult.extensions.find(e=>e.tools.has('jev_recall'));
  const hook=extension.handlers.get('session_before_compact')[0];
  const brokenContext={ui:{notify(){}},sessionManager:{buildSessionProjection(){throw Error('fixture failure')}}};
  assert.equal(await hook({signal:new AbortController().signal},brokenContext),undefined);
  const abort=new AbortController();abort.abort();
  assert.deepEqual(await hook({signal:abort.signal},brokenContext),{cancel:true});
  const version=JSON.parse(await readFile(join(piRoot,'package.json'),'utf8')).version;
  console.log(JSON.stringify({piVersion:version,extensionLoaded:true,realPiCompactions:3,stubSummaryCalls:calls,nativeFallbackVerified:true,errorFallbackVerified:true,abortStillCancels:true,beforeEstimate:before,afterEstimate:after,reductionPercent:+((1-after/before)*100).toFixed(1),rawMessagesPreserved:originals.length,pairsValid:true,reloadAndRecall:true,firstMetrics:result.details.metrics},null,2));
} finally {
  session?.dispose();
  if(originalKey===undefined) delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=originalKey;
  await rm(dir,{recursive:true,force:true});
}
