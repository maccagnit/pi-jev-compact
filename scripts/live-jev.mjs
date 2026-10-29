// Only synthetic data is sent by this smoke test. Credentials come from the environment.
import assert from 'node:assert/strict';
import { compact } from '../compact.ts';
import { select } from '../jev.ts';
if (!process.env.TYPESAFE_API_KEY) throw Error('Set TYPESAFE_API_KEY to run the live synthetic test');
const candidates = [
  {role:'toolResult',text:'Ledger regression FAILED: account_id 0017 is parsed as 17. Preserve leading zeros.'},
  {role:'assistant',text:'User constraint: no deployment without explicit approval. Pending: test /srv/ledger.py.'},
  {role:'toolResult',text:'A completed unrelated weather lookup from yesterday: sunny, 23 degrees.'},
];
const start=performance.now();
const result=await select(candidates,'Fix leading zeros for account 0017 in /srv/ledger.py. Do not deploy.',{key:process.env.TYPESAFE_API_KEY});
console.log(JSON.stringify({...result,elapsedMs:Math.round(performance.now()-start)},null,2));
assert.equal(result.status,'ok','Live Jev unavailable (fallback remains covered by unit tests)');
assert.notEqual(result.choices[0],'ARCHIVE','Critical regression evidence was incorrectly archived');
assert.notEqual(result.choices[1],'ARCHIVE','Active constraint was incorrectly archived');
const fastMessages=[{role:'user',content:'Fix /srv/ledger.py. Preserve 0017. Do not deploy without approval.'},
  ...Array.from({length:20},(_,i)=>({role:'toolResult',content:`Fixture ${i}\n`+'routine successful check\n'.repeat(160)})),...candidates];
const fastEvent={signal:new AbortController().signal,preparation:{messagesToSummarize:fastMessages,turnPrefixMessages:[],firstKeptEntryId:'tail',tokensBefore:40000},branchEntries:fastMessages.map((message,i)=>({type:'message',id:`e${i}`,message}))};
const fast=await compact(fastEvent,{key:process.env.TYPESAFE_API_KEY});
assert(fast.compaction);assert.equal(fast.compaction.details.metrics.jev,'ok');
assert.equal(fast.compaction.details.metrics.summary,'disabled');assert(fast.compaction.summary.includes('0017'));
console.log(JSON.stringify({liveFastPipeline:fast.compaction.details.metrics},null,2));
if (process.argv.includes('--with-summary')) {
  const { sdk } = await import('./pi-sdk.mjs');
  const { homedir, tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { LIMITS } = await import('../compact.ts');
  const dir = await mkdtemp(join(tmpdir(),'jev-live-'));
  try {
    const agentDir=join(homedir(),'.pi','agent');
    const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),modelsStorePath:join(dir,'store.json'),refreshOnCreate:false});
    const [provider,...id]=(process.env.PI_JEV_LIVE_MODEL??'').split('/');
    const model=runtime.getModel(provider,id.join('/'));
    assert(model,'Set PI_JEV_LIVE_MODEL=provider/model-id for --with-summary');
    const messages=[{role:'user',content:'Fix /srv/ledger.py. Preserve account ID 0017. Do not deploy without approval.'}];
    for(let i=0;i<20;i++) messages.push({role:'toolResult',content:[{type:'text',text:`Test step ${i}\n`+'successful routine fixture check\n'.repeat(160)}]});
    messages.push(...candidates);
    const event={signal:new AbortController().signal,preparation:{messagesToSummarize:messages,turnPrefixMessages:[],firstKeptEntryId:'tail',tokensBefore:40000},branchEntries:messages.map((message,i)=>({type:'message',id:`e${i}`,message}))};
    const result=await compact(event,{key:process.env.TYPESAFE_API_KEY,summarize:async(prompt,signal)=>runtime.streamSimple(model,{messages:[{role:'user',content:[{type:'text',text:prompt}],timestamp:Date.now()}]}, {maxTokens:LIMITS.outputTokens,reasoning:'off',signal,cacheRetention:'none'}).result()});
    assert(result.compaction,JSON.stringify(result));
    assert(result.compaction.summary.includes('0017'));
    assert(result.compaction.summary.includes('Do not deploy without approval'));
    console.log(JSON.stringify({livePipeline:result.compaction.details.metrics,summaryUsage:result.compaction.usage??null},null,2));
  } finally { await rm(dir,{recursive:true,force:true}); }
}
