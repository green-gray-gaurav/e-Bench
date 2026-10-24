import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';
import { sampleBook } from '../server/sample.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const passage = (page = 1, offset = 10) => ({ page, start_offset: offset, text: 'Connections often explain more than the components themselves.', context: 'A system contains elements and the connections between them.', rects: [{ x: .1, y: .2, width: .7, height: .025 }] });
function storeFixture(t, options) {
  const folder = mkdtempSync(join(tmpdir(), 'study-bench-'));
  const path = join(folder, 'bench.sqlite'); const store = new Store(path, options);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  const book = store.createNotebook('Systems'); store.attachPdf(book.id, 'book.pdf', Buffer.from('%PDF-'), 3);
  return { store, book, path };
}

test('claims are exclusive; public state hides claim tokens; submission is duplicate-safe', t => {
  const { store, book } = storeFixture(t);
  const selection = store.createSelection(book.id, passage()); const job = store.createJob(selection.id, 'markdown', '');
  assert.equal(store.createJob(selection.id, 'markdown', '').id, job.id);
  const first = store.claim('codex-one'); assert.equal(first.id, job.id); assert.equal(store.claim('codex-two'), null);
  assert.ok(first.claim_token); assert.equal(first.selection.text, selection.text);
  assert.equal('claim_token' in store.state(book.id).jobs[0], false);
  assert.throws(() => store.complete(job.id, 'wrong-token', 'No', 'text'), /no longer claimed/);
  const answer = store.complete(job.id, first.claim_token, '**Connections** shape behavior.', 'markdown');
  assert.equal(answer.status, 'completed');
  assert.deepEqual(store.complete(job.id, first.claim_token, answer.content, answer.format), answer);
  assert.throws(() => store.complete(job.id, first.claim_token, 'Changed', 'text'), /no longer claimed/);
});

test('expired claims return to the queue and stale workers cannot overwrite an answer', async t => {
  const { store, book } = storeFixture(t, { leaseMs: 25 });
  const selection = store.createSelection(book.id, passage()); store.createJob(selection.id, 'text', '');
  const old = store.claim('old'); await sleep(35);
  const next = store.claim('new'); assert.equal(next.id, old.id); assert.notEqual(next.claim_token, old.claim_token); assert.equal(next.attempts, 2);
  assert.throws(() => store.complete(old.id, old.claim_token, 'stale', 'text'), /no longer claimed/);
  store.renew(next.id, next.claim_token);
  assert.equal(store.complete(next.id, next.claim_token, 'fresh', 'text').content, 'fresh');
});

test('notes sort by page and selection offset, snapshot answers, and persist across database reopening', t => {
  const { store, book, path } = storeFixture(t);
  const later = store.createSelection(book.id, passage(3)); const second = store.createSelection(book.id, passage(1, 90)); const first = store.createSelection(book.id, passage(1, 5));
  store.saveNote(later.id); store.saveNote(second.id); store.saveNote(first.id);
  store.createJob(first.id, 'mermaid', ''); const claim = store.claim('codex');
  store.complete(claim.id, claim.claim_token, 'flowchart LR\nA --> B', 'mermaid');
  store.editNote(store.state(book.id).notes[0].id, 'flowchart LR\nA --> B', 'mermaid');
  assert.deepEqual(store.state(book.id).notes.map(n => n.selection_id), [first.id, second.id, later.id]);
  assert.equal(store.state(book.id).notes[0].content, 'flowchart LR\nA --> B');
  const reopened = new Store(path);
  assert.equal(reopened.state(book.id).notes.length, 3); assert.equal(reopened.pdf(book.id).toString(), '%PDF-'); reopened.close();
});

test('cancel invalidates a claim; retry and failure remain visible', t => {
  const { store, book } = storeFixture(t); const selection = store.createSelection(book.id, passage());
  const job = store.createJob(selection.id, 'text', ''); const old = store.claim('codex'); store.cancel(job.id);
  assert.throws(() => store.complete(job.id, old.claim_token, 'late', 'text'), /no longer claimed/);
  store.retry(job.id); const fresh = store.claim('codex'); store.fail(job.id, fresh.claim_token, 'Need a more legible passage.');
  assert.equal(store.state(book.id).jobs[0].status, 'failed'); assert.match(store.state(book.id).jobs[0].error, /legible/);
});

test('highlighting saves a note atomically and repeated saves preserve edits', t => {
  const {store,book} = storeFixture(t);
  const result = store.keepHighlight(book.id,passage(2));
  assert.equal(store.state(book.id).notes[0].selection_id,result.selection.id);
  store.editNote(result.note.id,'My own thoughts','markdown');
  const again = store.keepHighlight(book.id,undefined,result.selection.id);
  assert.equal(again.note.content,'My own thoughts'); assert.equal(store.state(book.id).notes.length,1);
  assert.throws(() => store.keepHighlight(book.id,{...passage(),kind:'page',rects:[]}),/highlight/);
  assert.equal(store.state(book.id).selections.length,1,'failed highlight rolls back its page selection');
});

test('question styles and text persist; saving answers appends without losing edits or duplicating answers', t => {
  const {store,book} = storeFixture(t); const {selection,note} = store.keepHighlight(book.id,passage());
  store.editNote(note.id,'Personal observation.','markdown');
  const job = store.createJob(selection.id,'mermaid','Draw a diagram','visual','How does this feedback work?');
  assert.equal(job.style,'visual'); assert.equal(job.question,'How does this feedback work?');
  const claim = store.claim('codex'); assert.equal(claim.question,job.question);
  store.complete(job.id,claim.claim_token,'flowchart LR\nA --> B','mermaid');
  const saved = store.addAnswerToNote(selection.id,job.id);
  assert.match(saved.content,/Personal observation/); assert.match(saved.content,/```mermaid/);
  assert.equal(store.addAnswerToNote(selection.id,job.id).content,saved.content);
  const next = store.createJob(selection.id,'markdown','Simplify','simplify',''); const nextClaim = store.claim('codex');
  store.complete(next.id,nextClaim.claim_token,'A simple explanation.','markdown'); store.addAnswerToNote(selection.id,next.id);
  const before = store.state(book.id).notes[0].content;
  assert.equal(store.addAnswerToNote(selection.id,job.id).content,before,'old answers are not appended twice');
});

async function appFixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'study-bench-http-')); const { app, store } = createApp({ dbPath: join(folder, 'bench.sqlite') });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(folder, { recursive: true, force: true }); });
  const request = async (path, body, method = 'POST') => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { store, base, request, dbPath:join(folder,'bench.sqlite') };
}

test('whole-page notes keep full text and a separate image, deduplicate, and survive reopening', async t => {
  const {base,request,store,dbPath} = await appFixture(t); const {data:book} = await request('/sample',{});
  const image = Buffer.from([0xff,0xd8,0xff,0xd9]); const imageUrl = 'data:image/jpeg;base64,'+image.toString('base64');
  const saved = await request(`/notebooks/${book.id}/page-notes`,{page:2,text:'All the text on page two.',image:imageUrl});
  assert.equal(saved.status,201); assert.equal(saved.data.note.has_page_image,true); assert.equal(saved.data.selection.kind,'page');
  const again = await request(`/notebooks/${book.id}/page-notes`,{page:2,text:'All the text on page two.',image:imageUrl});
  assert.equal(again.data.note.id,saved.data.note.id); assert.equal(store.state(book.id).notes.length,1);
  const state = store.state(book.id); assert.equal(state.notes[0].has_page_image,true); assert.equal('page_image' in state.notes[0],false);
  const response = await fetch(`${base}/api/notes/${saved.data.note.id}/page-image`);
  assert.equal(response.headers.get('content-type'),'image/jpeg'); assert.deepEqual(Buffer.from(await response.arrayBuffer()),image);
  assert.equal((await request(`/notebooks/${book.id}/page-notes`,{page:4,text:'bad page',image:imageUrl})).status,400);
  assert.equal((await request(`/notebooks/${book.id}/page-notes`,{page:1,text:'bad image',image:'data:image/jpeg;base64,YmFk'})).status,400);
  const reopened = new Store(dbPath); assert.equal(reopened.state(book.id).notes[0].has_page_image,true); assert.deepEqual(reopened.noteImage(saved.data.note.id),image); reopened.close();
});

test('HTTP validates PDFs, enforces one book, validates anchors, and rejects cross-origin writes', async t => {
  const { base, request } = await appFixture(t);
  assert.equal((await request('/notebooks', { title: ' ' })).status, 400);
  const { data: book } = await request('/notebooks', { title: 'Uploaded book' });
  const bad = new FormData(); bad.append('pdf', new Blob(['not a pdf']), 'bad.pdf');
  assert.equal((await fetch(`${base}/api/notebooks/${book.id}/pdf`, { method: 'POST', body: bad })).status, 400);
  const pdf = await sampleBook(); const form = new FormData(); form.append('pdf', new Blob([pdf], { type: 'application/pdf' }), 'systems.pdf');
  const uploaded = await fetch(`${base}/api/notebooks/${book.id}/pdf`, { method: 'POST', body: form }); assert.equal(uploaded.status, 201); assert.equal((await uploaded.json()).page_count, 3);
  assert.equal((await fetch(`${base}/api/notebooks/${book.id}/pdf`, { method: 'POST', body: form })).status, 409);
  const returned = await fetch(`${base}/api/notebooks/${book.id}/pdf`); assert.equal(returned.headers.get('content-type'), 'application/pdf'); assert.deepEqual(Buffer.from(await returned.arrayBuffer()), pdf);
  assert.equal((await request(`/notebooks/${book.id}/selections`, { ...passage(), page: 4 })).status, 400);
  assert.equal((await request(`/notebooks/${book.id}/selections`, { ...passage(), rects: [{ x: .9, y: .2, width: .3, height: .1 }] })).status, 400);
  assert.equal((await fetch(`${base}/api/notebooks`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'bad' }) })).status, 403);
});

test('real MCP client wakes on a queued passage, submits an answer, and the UI API exposes it', async t => {
  const { base, request, store } = await appFixture(t);
  const { data: book } = await request('/sample', {});
  const client = new Client({ name: 'bench-test-worker', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`))); t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['fail_job', 'list_notebooks', 'renew_job', 'start', 'stop', 'submit_explanation', 'submit_image', 'wait_for_job']);
  const waiting = client.callTool({ name: 'wait_for_job', arguments: { worker_id: 'test-codex', wait_seconds: 3 } });
  await sleep(100); assert.equal(store.workerStatus().state, 'waiting');
  const { data: selection } = await request(`/notebooks/${book.id}/selections`, passage());
  const { data: queued } = await request('/jobs', { selection_id: selection.id, format: 'markdown' });
  const result = await waiting; assert.equal(result.isError, undefined);
  const claim = result.structuredContent.job; assert.equal(claim.id, queued.id); assert.equal(claim.selection.page, 1);
  const answer = '## Why connections matter\n\nA system behaves according to **how its parts interact**.';
  const done = await client.callTool({ name: 'submit_explanation', arguments: { job_id: claim.id, claim_token: claim.claim_token, content: answer, format: 'markdown' } });
  assert.equal(done.structuredContent.job.status, 'completed');
  const { data: state } = await request(`/notebooks/${book.id}/state`, undefined, 'GET'); assert.equal(state.jobs[0].content, answer);
  assert.equal('claim_token' in state.jobs[0], false);
  assert.equal((await request('/notes', { selection_id: selection.id, job_id: claim.id })).status, 201);
  const note = store.state(book.id).notes[0];
  const edited = await request(`/notes/${note.id}`, { content: answer + '\n\nMy own example: a thermostat.', format: 'markdown' }, 'PATCH');
  assert.equal(edited.status, 200); assert.ok(edited.data.edited_at);
  assert.match(store.state(book.id).notes[0].content, /My own example/);
  await request('/notes', { selection_id: selection.id, job_id: claim.id });
  assert.match(store.state(book.id).notes[0].content, /My own example/, 're-saving the passage must not overwrite an edited note');
  assert.equal((await request(`/notes/${note.id}`, { content: 'bad', format: 'html' }, 'PATCH')).status, 400);
  assert.equal((await request('/notes/missing', { content: 'text', format: 'text' }, 'PATCH')).status, 404);
  const exported = await fetch(`${base}/api/notebooks/${book.id}/export`); const markdown = await exported.text();
  assert.match(markdown, /# Thinking in systems/); assert.match(markdown, /## Page 1/); assert.match(markdown, /Why connections matter/);
  const empty = await client.callTool({ name: 'wait_for_job', arguments: { worker_id: 'test-codex', wait_seconds: 0 } }); assert.equal(empty.structuredContent.job, null);
  const invalid = await client.callTool({ name: 'submit_explanation', arguments: { job_id: claim.id, claim_token: 'wrong', content: 'bad', format: 'text' } }); assert.equal(invalid.isError, true);
});

test('start handshake drives idle → question → answer → wait, preserves scope, and stops/resumes safely', async t => {
  const {base,store,request} = await appFixture(t);
  const {data:book} = await request('/sample',{}); const {data:other} = await request('/sample',{});
  const client = new Client({name:'autonomous-loop-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`))); t.after(()=>client.close());
  const call = async (name,args={}) => {
    const result = await client.callTool({name,arguments:args});
    assert.equal(result.isError,undefined,JSON.stringify(result));
    return result.structuredContent;
  };
  const start = await call('start',{worker_id:'auto-codex',notebook_id:book.id});
  assert.equal(start.status,'ready'); assert.equal(start.requires_another_user_prompt,false);
  assert.match(start.prompt,/without another user prompt/); assert.match(start.prompt,/NOT completion/); assert.match(start.prompt,/untrusted source material/);
  assert.deepEqual(start.next_action,{tool:'wait_for_job',arguments:{worker_id:'auto-codex',wait_seconds:1800,notebook_id:book.id}});
  const idle = await call(start.next_action.tool,{...start.next_action.arguments,wait_seconds:0});
  assert.equal(idle.status,'idle'); assert.equal(idle.job,null); assert.deepEqual(idle.next_action,start.next_action);
  const otherSelection=store.createSelection(other.id,passage()); const otherJob=store.createJob(otherSelection.id,'markdown','');
  const selection=store.createSelection(book.id,passage()); const job=store.createJob(selection.id,'markdown','Explain this.');
  const claimed=await call('wait_for_job',{worker_id:'auto-codex',wait_seconds:0});
  assert.equal(claimed.job.id,job.id,'omitting the filter inherits the start scope');
  assert.equal(claimed.next_action.tool,'submit_explanation');
  const submitted=await call(claimed.next_action.tool,{...claimed.next_action.arguments,content:'A clear explanation.',format:'markdown'});
  assert.equal(submitted.job.status,'completed'); assert.deepEqual(submitted.next_action,start.next_action);
  const idleAgain=await call(submitted.next_action.tool,{...submitted.next_action.arguments,wait_seconds:0});
  assert.equal(idleAgain.status,'idle'); assert.equal(idleAgain.requires_another_user_prompt,false);
  const second=store.createJob(selection.id,'markdown','Another question.');
  const unfinished=await call('wait_for_job',{worker_id:'auto-codex',wait_seconds:0}); assert.equal(unfinished.job.id,second.id);
  const stopped=await call('stop',{worker_id:'auto-codex'}); assert.equal(stopped.released_jobs,1); assert.equal(stopped.next_action,null);
  assert.equal(store.job(second.id).status,'queued');
  assert.equal((await call('wait_for_job',{worker_id:'auto-codex',wait_seconds:0})).status,'stopped');
  const stale=await client.callTool({name:'submit_explanation',arguments:{job_id:second.id,claim_token:unfinished.job.claim_token,content:'Too late.',format:'markdown'}}); assert.equal(stale.isError,true);
  await call('start',{worker_id:'auto-codex',notebook_id:book.id});
  const resumed=await call('wait_for_job',{worker_id:'auto-codex',wait_seconds:0});
  assert.equal(resumed.job.id,second.id); assert.notEqual(resumed.job.claim_token,unfinished.job.claim_token);
  const failed=await call('fail_job',{job_id:second.id,claim_token:resumed.job.claim_token,error:'Need more context.'}); assert.deepEqual(failed.next_action,start.next_action);
  const waiting=call('wait_for_job',{worker_id:'auto-codex',wait_seconds:3}); await sleep(100);
  assert.equal(store.workerStatus().state,'waiting'); await call('stop',{worker_id:'auto-codex'});
  assert.equal((await waiting).status,'stopped','stop wakes a pending long poll');
  assert.equal(store.job(otherJob.id).status,'queued','scoped listening never consumes another notebook');
  const generated=await call('start'); assert.match(generated.worker_id,/^codex-bench-/); await call('stop',{worker_id:generated.worker_id});
  const invalid=await client.callTool({name:'start',arguments:{worker_id:'bad-worker',notebook_id:'missing'}}); assert.equal(invalid.isError,true); assert.equal(store.workerSession('bad-worker'),undefined);
});

test('live wait status clears on HTTP disconnect and ignores persisted wait deadlines', async t => {
  const {base,store,request,dbPath} = await appFixture(t);
  const {data:book} = await request('/sample',{});
  const {data:other} = await request('/sample',{});
  store.registerWorker('stale-worker'); store.touchWorker('stale-worker',1800);
  assert.equal(store.workerStatus().state,'offline','a saved deadline is not a live request');
  const controller = new AbortController();
  const pending = fetch(`${base}/mcp`,{
    method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:101,method:'tools/call',params:{name:'wait_for_job',arguments:{worker_id:'live-worker',notebook_id:book.id,wait_seconds:1800}}}),signal:controller.signal,
  }).catch(error=>error);
  t.after(()=>controller.abort());
  for(let i=0;i<100 && store.workerStatus(book.id).state!=='waiting';i++) await sleep(10);
  assert.equal(store.workerStatus(book.id).state,'waiting');
  assert.equal(store.workerStatus(book.id).evidence,'live_request');
  assert.equal(store.workerStatus(other.id).state,'offline','another notebook scope is not listening here');
  const reopened = new Store(dbPath); assert.equal(reopened.workerStatus().state,'offline'); reopened.close();
  controller.abort(); await pending;
  for(let i=0;i<100 && store.activeWaits.size;i++) await sleep(10);
  assert.equal(store.activeWaits.size,0); assert.equal(store.workerStatus().state,'offline');
  const selection=store.createSelection(book.id,passage()); const job=store.createJob(selection.id,'markdown','');
  assert.equal(store.job(job.id).status,'queued','offline questions remain saved');
});

test('wait completion, competing workers, and claim expiry produce scoped status', async t => {
  const {store,book} = storeFixture(t);
  const other=store.createNotebook('Other'); store.attachPdf(other.id,'other.pdf',Buffer.from('%PDF-'),3);
  store.registerWorker('listener',book.id); const first=store.beginWait('listener',book.id);
  store.registerWorker('newer-worker',other.id);
  assert.equal(store.workerStatus(book.id).state,'waiting','an idle newer worker must not hide a listener');
  const second=store.beginWait('listener',book.id); store.endWait(first);
  assert.equal(store.workerStatus(book.id).state,'waiting'); store.endWait(second);
  assert.equal(store.workerStatus(book.id).state,'offline');
  const selection=store.createSelection(book.id,passage());const job=store.createJob(selection.id,'markdown','');
  const claim=store.claim('listener',book.id);
  assert.equal(store.workerStatus(book.id).state,'processing');assert.equal(store.workerStatus(other.id).state,'offline');
  store.db.prepare('UPDATE jobs SET lease_until=0 WHERE id=?').run(job.id);
  const state=store.state(book.id);
  assert.equal(state.worker.state,'offline');assert.equal(state.jobs[0].status,'queued');assert.equal(state.jobs[0].attempts,1);
  assert.throws(()=>store.complete(job.id,claim.claim_token,'Late answer','text'));
});

test('Visual PNG submission validates claims, stores image bytes, and saves to notes without duplication', async t => {
  const {base,store,request,dbPath}=await appFixture(t);const {data:book}=await request('/sample',{});
  const client=new Client({name:'visual-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));t.after(()=>client.close());
  const selection=store.createSelection(book.id,passage());store.keepHighlight(book.id,undefined,selection.id);
  const {status,data:job}=await request('/jobs',{selection_id:selection.id,format:'image',style:'image',instruction:'Generate a PNG visual.'});assert.equal(status,201);
  const claim=(await client.callTool({name:'wait_for_job',arguments:{worker_id:'visual-test',wait_seconds:0}})).structuredContent;
  assert.equal(claim.next_action.tool,'submit_explanation');assert.equal(claim.next_action.arguments.format,'text');assert.match(claim.guidance,/fail_job/);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const args={job_id:job.id,claim_token:claim.job.claim_token,image_base64:png.toString('base64'),alt:'Illustrated explanation'};
  assert.equal((await client.callTool({name:'submit_image',arguments:{...args,claim_token:'wrong'}})).isError,true);
  assert.equal((await client.callTool({name:'submit_image',arguments:{...args,image_base64:Buffer.from('bad png').toString('base64')}})).isError,true);
  assert.equal(store.job(job.id).status,'processing');
  assert.equal((await client.callTool({name:'submit_explanation',arguments:{job_id:job.id,claim_token:args.claim_token,content:'Fake image','format':'markdown'}})).isError,true);
  const oversized=Buffer.from(png);oversized.writeUInt32BE(5000,16);
  assert.equal((await client.callTool({name:'submit_image',arguments:{...args,image_base64:oversized.toString('base64')}})).isError,true);
  const filePath=join(dirname(dbPath),'visual.png');writeFileSync(filePath,png);
  const {image_base64,...fileArgs}=args;
  const submitted=await client.callTool({name:'submit_image',arguments:{...fileArgs,file_path:filePath}});assert.equal(submitted.isError,undefined,JSON.stringify(submitted));
  const result=submitted.structuredContent;assert.equal(result.job.status,'completed');assert.equal(result.next_action.tool,'wait_for_job');
  const imageUrl=result.job.content.match(/\((\/api\/images\/[^)]+)\)/)[1];
  const response=await fetch(base+imageUrl);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  assert.equal((await client.callTool({name:'submit_image',arguments:args})).structuredContent.job.content,result.job.content);
  store.addAnswerToNote(selection.id,job.id);store.addAnswerToNote(selection.id,job.id);
  const note=store.state(book.id).notes[0];assert.equal(note.content.split(imageUrl).length,2);
  const reopened=new Store(dbPath);assert.deepEqual(reopened.answerImage(imageUrl.split('/').at(-1)),png);reopened.close();
  const legacy=store.createJob(selection.id,'image','Legacy tools Visual','image');
  const legacyClaim=(await client.callTool({name:'wait_for_job',arguments:{worker_id:'visual-test',wait_seconds:0}})).structuredContent;
  assert.match(legacyClaim.guidance,/submit_explanation/);assert.match(legacyClaim.guidance,/Saved to/);
  const legacyArgs={job_id:legacy.id,claim_token:legacyClaim.job.claim_token,format:'text',content:JSON.stringify({file_path:pathToFileURL(filePath).href,alt:'Legacy visual'})};
  assert.equal((await client.callTool({name:'submit_explanation',arguments:{...legacyArgs,claim_token:'stale'}})).isError,true);
  const legacyResult=await client.callTool({name:'submit_explanation',arguments:legacyArgs});
  assert.equal(legacyResult.isError,undefined,JSON.stringify(legacyResult));assert.equal(legacyResult.structuredContent.job.status,'completed');
  assert.match(legacyResult.structuredContent.job.content,/\/api\/images\//);
  assert.equal((await client.callTool({name:'submit_explanation',arguments:legacyArgs})).structuredContent.job.content,legacyResult.structuredContent.job.content);
  const plain=store.createJob(selection.id,'image','Plain path Visual','image');const plainClaim=store.claim('visual-test');
  const plainResult=await client.callTool({name:'submit_explanation',arguments:{job_id:plain.id,claim_token:plainClaim.claim_token,format:'text',content:pathToFileURL(filePath).href}});
  assert.equal(plainResult.isError,undefined,JSON.stringify(plainResult));
  const second=store.createJob(selection.id,'image','Another visual','image');const secondClaim=store.claim('visual-test');
  const failed=await client.callTool({name:'fail_job',arguments:{job_id:second.id,claim_token:secondClaim.claim_token,error:'Image generation is unavailable in this Codex session.'}});
  assert.equal(failed.structuredContent.job.status,'failed');assert.match(failed.structuredContent.job.error,/unavailable/);
});

test('Visual discovery finds saved PNGs during the active claim without completing or exposing stale files', async t => {
  const {base,store,request,dbPath}=await appFixture(t);const {data:book}=await request('/sample',{});
  const previousHome=process.env.CODEX_HOME;process.env.CODEX_HOME=join(dirname(dbPath),'codex-home');
  t.after(()=>{if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;});
  const folder=join(process.env.CODEX_HOME,'generated_images','test-session');mkdirSync(folder,{recursive:true});
  const old=join(folder,'old.png');writeFileSync(old,Buffer.from('old'));utimesSync(old,new Date(0),new Date(0));
  const selection=store.createSelection(book.id,passage());const job=store.createJob(selection.id,'image','Discover saved output','image');
  const client=new Client({name:'discovery-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));t.after(()=>client.close());
  const claim=(await client.callTool({name:'wait_for_job',arguments:{worker_id:'discovery-test',wait_seconds:0}})).structuredContent;
  assert.match(claim.guidance,/generatedImage\(result\)/);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const filePath=join(folder,'generated.png');writeFileSync(filePath,png);
  const args={job_id:job.id,claim_token:claim.job.claim_token,format:'text',content:JSON.stringify({find_generated_images:true})};
  assert.equal((await client.callTool({name:'submit_explanation',arguments:{...args,claim_token:'stale'}})).isError,true);
  const result=(await client.callTool({name:'submit_explanation',arguments:args})).structuredContent;
  assert.equal(result.status,'artifact_candidates');assert.deepEqual(result.generated_images.map(i=>i.file_path),[filePath]);
  assert.equal(store.job(job.id).status,'processing');
  const submitted=await client.callTool({name:'submit_explanation',arguments:{...args,content:JSON.stringify({file_path:filePath,alt:'Saved visual'})}});
  assert.equal(submitted.structuredContent.job.status,'completed');
});
