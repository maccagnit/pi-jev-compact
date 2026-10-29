import test from 'node:test';
import assert from 'node:assert/strict';
import { compact, recall, makePlan, tokens, LIMITS, MARKER } from '../compact.ts';
import { select, validChoice, redact, CRITERIA } from '../jev.ts';

export function fixture(count = 30) {
  const messages = [{role:'user', content:'Fix /srv/ledger.py; preserve account ID 0017. Never deploy without approval.'}];
  for (let i=0;i<count;i++) messages.push({role:'toolResult', content:[{type:'text', text:`read result ${i}\n`+'routine log line\n'.repeat(240)+`\nnext step ${i}`} ]});
  const branchEntries = messages.map((message,i)=>({type:'message', id:`e${i}`,message}));
  branchEntries.push({type:'message',id:'tail',message:{role:'user',content:'Now check tests'}});
  return {preparation:{messagesToSummarize:messages,turnPrefixMessages:[],tokensBefore:60000,firstKeptEntryId:'tail'},branchEntries, signal:new AbortController().signal};
}
function answer(choice='SUMMARIZE', probability=1) {
  return {type:'choice',choice,confidence:probability, probabilities:Object.fromEntries(Object.keys(CRITERIA).map(k=>[k,k===choice?probability:(1-probability)/3]))};
}
function fakeFetch(choice='SUMMARIZE', inspect=()=>{}) {
  return async (url,opts)=>{ const p=JSON.parse(opts.body); inspect(p,opts,url); return {ok:true,json:async()=>({answers:Object.fromEntries(Object.keys(p.questions).map(k=>[k,answer(choice)])), usage:{input_tokens:700}})}; };
}
const goodSummary = async ()=>({content:[{type:'text',text:'Ledger work is in progress. Run the remaining tests; deployment requires approval.'}],stopReason:'stop',usage:{input:900,output:30}});

test('bounded checkpoint, exact requests, originals and native boundary unchanged',async()=>{
  const e=fixture(), before=structuredClone(e.branchEntries);let requests=0;
  const r=await compact(e,{key:'fake',fetchImpl:fakeFetch('SUMMARIZE',p=>{requests++;assert(Object.keys(p.questions).length<=8);assert(JSON.stringify(p).length<=14000)}),summarize:goodSummary});
  assert.equal(requests,1);assert(r.compaction.summary.includes(e.preparation.messagesToSummarize[0].content));
  assert.equal(r.compaction.firstKeptEntryId,'tail');assert.equal(r.compaction.usage.output,30);
  assert(tokens(r.compaction.summary)<=LIMITS.checkpointTokens);assert.deepEqual(e.branchEntries,before);
  assert(r.compaction.details.metrics.savedEstimate>10000);
});
test('repeated compaction retains earlier user constraints',async()=>{
  const first=await compact(fixture(),{summarize:goodSummary});const e=fixture();
  e.preparation.previousSummary=first.compaction.summary;
  e.branchEntries.unshift({type:'compaction',summary:first.compaction.summary,details:first.compaction.details});
  e.preparation.messagesToSummarize[0].content='Also preserve invoice 991 and UTF-8.';
  const next=await compact(e,{summarize:goodSummary});
  assert(next.compaction.summary.includes('account ID 0017'));assert(next.compaction.summary.includes('invoice 991'));
  assert.equal(next.compaction.details.state.pins.length,2);
});
test('no key means no hosted call',async()=>{
  const r=await compact(fixture(),{fetchImpl:()=>assert.fail('network call'),summarize:goodSummary});
  assert.equal(r.compaction.details.metrics.jevRequests,0);assert.equal(r.compaction.details.metrics.jev,'missing_key');
});
test('Jev unavailable falls back without retries',async()=>{
  let n=0;const r=await compact(fixture(),{key:'fake',fetchImpl:async()=>{n++;throw Error('down')},summarize:goodSummary});
  assert.equal(n,1);assert.equal(r.compaction.details.metrics.jev,'unavailable');
});
test('Jev timeout is bounded; user abort propagates',async()=>{
  const fetchImpl=async(_,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}));
  const c=[{role:'toolResult',text:'evidence'}];
  assert.equal((await select(c,'goal',{key:'fake',fetchImpl,timeoutMs:10})).status,'timeout');
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>select(c,'goal',{key:'fake',fetchImpl,signal:controller.signal}));
});
test('invalid probability distributions are rejected',()=>{
  assert(validChoice(answer()));assert(!validChoice({...answer(),confidence:NaN}));
  assert(!validChoice({...answer(),choice:'ARCHIVE'}));assert(!validChoice({...answer(),probabilities:{SUMMARIZE:1}}));
  assert(!validChoice({...answer(),confidence:true}));
});
test('weak ARCHIVE decision cannot drop evidence',async()=>{
  const r=await select([{role:'assistant',text:'fact'}],'goal',{key:'fake',fetchImpl:async()=>({ok:true,json:async()=>({answers:{r0:answer('ARCHIVE',0.7)}})})});
  assert.deepEqual(r.choices,['SUMMARIZE']);
});
test('partial summary and invented quotes trigger exact fallback',async()=>{
  for (const response of [{stopReason:'length',content:'Partial claim'}, {stopReason:'stop',content:'Use `invented/path/001111`.'}]) {
    const r=await compact(fixture(),{summarize:async()=>response});assert.equal(r.compaction.details.metrics.mode,'extractive');
    assert(!r.compaction.summary.includes('invented/path'));assert(!r.compaction.summary.includes('Partial claim'));
  }
});
test('summary failure retains prior checkpoint and KEEP evidence',async()=>{
  const e=fixture();e.preparation.previousSummary='A previously validated result: balance=17';
  const r=await compact(e,{key:'fake',fetchImpl:fakeFetch('KEEP'),summarize:async()=>{throw Error('down')}});
  assert.equal(r.compaction.details.metrics.mode,'extractive');assert(r.compaction.summary.includes('balance=17'));
  for (const c of makePlan(e).candidates) assert(r.compaction.summary.includes(c.text));
});
test('an oversized user request becomes a labelled excerpt instead of blocking compaction',async()=>{
  const e=fixture(0);e.preparation.messagesToSummarize[0].content='Do not remove this constraint. '.repeat(600);
  const r=await compact(e,{key:'fake',fetchImpl:()=>assert.fail('network')});
  assert(r.compaction);assert.equal(r.compaction.details.metrics.pins,'bounded');
  assert(r.compaction.summary.includes('[excerpt of user request e0, ~'));assert(r.compaction.summary.includes('Do not remove this constraint.'));
  assert(tokens(r.compaction.summary)<=LIMITS.pinTokensEach+200);
});
test('protected text that cannot fit even as an excerpt still cancels before API calls',async()=>{
  const e=fixture(0);e.preparation.messagesToSummarize[0].content='x'.repeat(2400);
  e.preparation.fileOps={written:Array.from({length:200},(_,i)=>`/srv/generated/file-${i}.py`)};
  const r=await compact(e,{key:'fake',fetchImpl:()=>assert.fail('network'),summarize:()=>assert.fail('summary')});
  assert.equal(r.reason,'protected_text_exceeds_budget');assert(r.cancel);
});
test('pasted user turns keep their marked lines across repeated compactions',async()=>{
  // Shape of a long session of pasted files: ~6k-token user turns with facts in the middle.
  const filler=n=>Array.from({length:n},(_,i)=>`    value_${i} = compute(value_${i-1}, ${i})  # routine line`).join('\n');
  let previous,turn=0;const notes=[];
  for(let round=0;round<3;round++){
    const messages=[];
    for(let k=0;k<6;k++){turn++;const note=`# NOTE: the access code for key-${turn} is CODE${turn}X.`;notes.push(note);
      messages.push({role:'user',content:`Part ${turn}:\n${filler(150)}\n${note}\n${filler(150)}`},{role:'assistant',content:[{type:'text',text:`ACK part ${turn}`}]});}
    const e={signal:new AbortController().signal,preparation:{messagesToSummarize:messages,turnPrefixMessages:[],tokensBefore:80000,firstKeptEntryId:'tail',previousSummary:previous?.summary},
      branchEntries:[...(previous?[{type:'compaction',summary:previous.summary,details:previous.details}]:[]),...messages.map((message,i)=>({type:'message',id:`r${round}m${i}`,message}))]};
    const r=await compact(e);assert(r.compaction,JSON.stringify(r));previous=r.compaction;
    assert.equal(previous.details.metrics.pins,'bounded');
    for(const note of notes) assert(previous.summary.includes(note),`lost ${note} in round ${round}`);
  }
  assert(tokens(previous.summary)<=LIMITS.pinTokens+LIMITS.checkpointTokens);
});
test('small compactions are rejected',async()=>{assert.equal((await compact(fixture(0))).reason,'too_little_to_reclaim')});
test('recall recovers originals completely via pagination and rejects foreign IDs',()=>{
  const e=fixture();const found=recall(e.branchEntries,{query:'read result 9'});assert.equal(found.matches[0].id,'e10');
  let out='', offset=0;do{const r=recall(e.branchEntries,{id:'e10',offset});out+=r.text;offset=r.nextOffset}while(offset!==null);
  assert.deepEqual(JSON.parse(out),e.branchEntries.find(e=>e.id==='e10'));
  assert.throws(()=>recall(e.branchEntries,{id:'sibling'}));assert.throws(()=>recall(e.branchEntries,{query:'result',offset:-1}));
});
test('raw omitted entries never re-enter checkpoint',async()=>{
  const e=fixture();e.branchEntries.unshift({type:'message',id:'omitted',message:{role:'user',content:'SECRET_OMITTED_MARKER'}});
  assert(!(await compact(e,{summarize:goodSummary})).compaction.summary.includes('SECRET_OMITTED_MARKER'));
});
test('split-turn user request is included',async()=>{
  const e=fixture();e.preparation.turnPrefixMessages=[{role:'user',content:'Split turn: use port 4321.'}];
  assert((await compact(e,{summarize:goodSummary})).compaction.summary.includes('port 4321'));
});
test('long lines are never presented as complete exact snippets',()=>{
  const e=fixture();e.preparation.messagesToSummarize.push({role:'toolResult',content:'abc'.repeat(1000)});
  assert(makePlan(e).candidates.every(c=>c.text.length<=800 && c.text!=='abc'.repeat(266)));
});
test('hosted payload redacts common secrets and uses fixed endpoint',async()=>{
  const secret='https://user:password@example.com token=private-value Bearer abcdef';assert(!redact(secret).includes('private-value'));
  await select([{role:'toolResult',text:secret}],'goal',{key:'key',fetchImpl:fakeFetch('SUMMARIZE',(p,o,url)=>{
    assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(o.redirect,'error');assert(!JSON.stringify(p).includes('private-value'));assert(!JSON.stringify(p).includes('user:password'));
  })});
});
test('summary timeout falls back without retry',async()=>{
  const r=await compact(fixture(),{summaryTimeoutMs:10,summarize:async(_,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}))});
  assert.equal(r.compaction.details.metrics.summary,'timeout');assert.equal(r.compaction.details.metrics.mode,'extractive');
});
test('abort never produces a checkpoint',async()=>{
  const e=fixture();const c=new AbortController();e.signal=c.signal;
  await assert.rejects(()=>compact(e,{summarize:async()=>{c.abort();return goodSummary()}}));
});
test('state from a different projection cannot become pinned',()=>{
  const e=fixture();e.branchEntries.unshift({type:'compaction',summary:'different',details:{engine:MARKER,state:{pins:[{text:'not in active projection'}]}}});
  assert(!makePlan(e).pins.some(p=>p.text.includes('not in active')));
});
test('duplicate requests keep latest precedence',()=>{
  const e=fixture();e.preparation.messagesToSummarize=[{role:'user',content:'Use A'},{role:'user',content:'Use B'},{role:'user',content:'Use A'}];
  assert.deepEqual(makePlan(e).pins.map(p=>p.text),['Use B','Use A']);
});
test('Jev uses the current task rather than an obsolete compacted request',async()=>{
  await compact(fixture(),{activeGoal:'NEW_TASK_X',key:'fake',fetchImpl:fakeFetch('KEEP',p=>assert.equal(p.state.goal,'NEW_TASK_X'))});
});
test('modified/read file lists survive checkpoint with exact paths',async()=>{
  const e=fixture();e.preparation.fileOps={read:new Set(['/a','/b']),edited:new Set(['/a']),written:new Set(['/c'])};
  const r=await compact(e);
  assert.deepEqual(r.compaction.details.modifiedFiles,['/a','/c']);assert.deepEqual(r.compaction.details.readFiles,['/b']);
  assert(r.compaction.summary.includes('/a\n/c'));assert(r.compaction.summary.includes('/b'));
});
test('non-shrinking prior checkpoint cancels without modifying history',async()=>{
  const e=fixture(0);e.preparation.previousSummary='old exact evidence '.repeat(100);
  const r=await compact(e);assert(r.cancel);assert.equal(r.reason,'fallback_exceeds_budget');
});
test('oversized mandatory KEEP evidence cancels rather than truncating it',async()=>{
  const e=fixture(0);e.preparation.messagesToSummarize.push(...Array.from({length:8},(_,i)=>({role:'toolResult',content:'x'.repeat(799)+i})));
  e.preparation.messagesToSummarize[0].content='constraint '.repeat(100);
  const r=await compact(e,{key:'fake',fetchImpl:fakeFetch('KEEP')});assert.equal(r.reason,'fallback_exceeds_budget');
});
test('fast mode never calls the generation model and stays bounded over five compactions',async()=>{
  let previous;for(let i=0;i<5;i++){
    const e=fixture();if(previous){e.preparation.previousSummary=previous.summary;e.branchEntries.unshift({type:'compaction',summary:previous.summary,details:previous.details})}
    previous=(await compact(e)).compaction;assert(previous);assert.equal(previous.details.metrics.summary,'disabled');
    assert.equal(previous.details.state.pins.length,1);assert(tokens(previous.summary)<=LIMITS.checkpointTokens);
  }
});
test('migration: a large native summary is carried verbatim within the reclaim budget',async()=>{
  const e=fixture(5);e.preparation.previousSummary='Existing native checkpoint. '.repeat(750);
  const r=await compact(e);assert(r.compaction,'A pre-existing native summary must not be blocked by the normal 2400-token target');
  assert(r.compaction.summary.includes(e.preparation.previousSummary));
  const m=r.compaction.details.metrics;assert(m.checkpointEstimate>LIMITS.checkpointTokens);
  assert(m.savedEstimate>=LIMITS.minSavedTokens);assert(m.checkpointEstimate<=m.removedEstimate*0.7);
  assert.equal(r.compaction.firstKeptEntryId,e.preparation.firstKeptEntryId);
});
test('migration: large user requests remain verbatim when enough other context is reclaimable',async()=>{
  const e=fixture();e.preparation.messagesToSummarize[0].content='Exact user constraint. '.repeat(500);
  const r=await compact(e);assert(r.compaction);assert(r.compaction.summary.includes(e.preparation.messagesToSummarize[0].content));
});
test('config: missing file gives defaults, a broken file is reported, globs match provider/model',async()=>{
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { loadConfig, resolveKey, modelMatches, CONFIG_FILE } = await import('../config.ts');
  const dir=await mkdtemp(join(tmpdir(),'jev-config-'));
  try {
    assert.deepEqual(loadConfig(dir).stripThinkingModels,[]);
    assert.equal(loadConfig(dir).typesafeApiKeyFile,join((await import('node:os')).homedir(),'.config/jev/typesafe.key'));
    await writeFile(join(dir,CONFIG_FILE),'{broken');assert.match(loadConfig(dir).error,/pi-jev-compact\.json/);
    await writeFile(join(dir,'key'),'  ts_file_key_value\n');
    await writeFile(join(dir,CONFIG_FILE),JSON.stringify({stripThinkingModels:['home-qwen*/orcarouter-*'],typesafeApiKeyFile:join(dir,'key')}));
    const config=loadConfig(dir);
    assert(modelMatches(config.stripThinkingModels,{provider:'home-qwen-remote',id:'orcarouter-qwen3.8-27b'}));
    assert(!modelMatches(config.stripThinkingModels,{provider:'openai',id:'orcarouter-x'}));
    assert(!modelMatches([],{provider:'home-qwen',id:'orcarouter-qwen3.8-27b'}));
    assert.deepEqual(resolveKey(config,{}),{key:'ts_file_key_value',source:'file'});
    assert.deepEqual(resolveKey(config,{TYPESAFE_API_KEY:'from-env'}),{key:'from-env',source:'env'});
    assert.equal(resolveKey({...config,typesafeApiKeyFile:join(dir,'missing')},{}).source,'file_unreadable');
    assert.equal(resolveKey({stripThinkingModels:[]},{}).source,'none');
    // The default file is optional: absent means no key, not an error. (Path forced to a missing file.)
    assert.equal(resolveKey({...loadConfig(join(dir,'nowhere')),typesafeApiKeyFile:join(dir,'x')},{}).source,'file_unreadable');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('redaction covers JSON keys and common provider token formats',()=>{
  const text=['"api_key": "abc123secretvalue"',"password: 'hunter2hunter2'",'AKIAABCDEFGHIJKLMNOP','ghp_'+'a'.repeat(36),
    'xoxb-1234567890-abcdefghij','eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl'].join('\n');
  const out=redact(text);
  for(const leaked of ['abc123secretvalue','hunter2hunter2','AKIAABCDEFGHIJKLMNOP','ghp_aaaa','xoxb-1234567890','eyJhbGciOiJIUzI1NiJ9.']) assert(!out.includes(leaked),leaked);
});
test('code-heavy candidates are shortened to fit the Jev payload instead of abandoning Jev',async()=>{
  const heavy='"\\\\"'.repeat(400);let sent;
  const r=await select(Array.from({length:8},()=>({role:'toolResult',text:heavy})),'goal',{key:'fake',fetchImpl:fakeFetch('KEEP',p=>{sent=p})});
  assert.equal(r.status,'ok');assert(JSON.stringify(sent).length<=14000);
});
