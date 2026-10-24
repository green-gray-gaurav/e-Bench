import './style.css';
import './dark.css';
import './pdf-text-layer.css';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { PdfReader } from './reader.js';
import { capturePdfSelection } from './selection.js';
import { renderExplanationPanel } from './panel.js';
import { renderNotesWorkspace, noteInitialValue, noteInitialFormat } from './notes.js';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { createElement, BookOpen, Plus, Library, ArrowRight, ArrowUpRight, Plug, Sprout, CircleHelp, FileText, ChevronLeft, ChevronRight, Minus, Upload, Lightbulb, Highlighter, Copy, X, BookmarkPlus, Check, Clock, Download, Trash2, RotateCcw, CircleX, Workflow, Braces, AlignLeft, NotebookPen, Maximize, MessageCircle } from 'lucide';

GlobalWorkerOptions.workerSrc = workerUrl;
const iconSet = { BookOpen, Plus, Library, ArrowRight, ArrowUpRight, Plug, Sprout, CircleHelp, FileText, ChevronLeft, ChevronRight, Minus, Upload, Lightbulb, Highlighter, Copy, X, BookmarkPlus, Check, Clock, Download, Trash2, RotateCcw, CircleX, Workflow, Braces, AlignLeft, NotebookPen, Maximize, MessageCircle };
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = name => `<span data-icon="${name}"></span>`;
function icons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { const node = iconSet[el.dataset.icon]; if (node) { const svg = createElement(node, { width: 18, height: 18, 'stroke-width': 1.65, 'aria-hidden': 'true' }); if (el.className) { el.replaceChildren(svg); el.removeAttribute('data-icon'); } else el.replaceWith(svg); } }); }
icons();
const markdownFromHtml = new TurndownService({ headingStyle:'atx',codeBlockStyle:'fenced',bulletListMarker:'-' });
markdownFromHtml.use(gfm);
markdownFromHtml.addRule('appended-note', {
  filter: node => node.nodeName === 'DIV' && node.classList.contains('note-appended'),
  replacement: (_content, node) => '\n\n<div class="note-appended">' + node.innerHTML + '</div>\n\n'
});
const state = { books: [], bookId: null, data: null, pdf: null, page: 1, zoom: 1, selection: null, tab: 'explain', view: localStorage.getItem('bench-view') === 'reader' ? 'reader' : 'notes', collapsed: true, direction: localStorage.getItem('bench-scroll-direction') === 'horizontal' ? 'horizontal' : 'vertical', editingNote: null, noteDrafts: new Map(), style: 'detailed', choosingStyle: true, busy: false, signature: '', loading: false, selecting: false, activeJob: null };
let toastTimer, refreshBusy = false, pdfLoadTask, pageSaveTimer, selectionTimer, layoutPromise = Promise.resolve();
const reader = new PdfReader({ root: $('#reader-scroll'), pages: $('#pdf-pages'), onError: error => toast(error.message, true), onPageChange(page, hasText) {
  state.page = page; updatePageControls();
  $('#reader-status').textContent = hasText === false ? 'No selectable text on this page. OCR is not included yet.' : 'Select text to highlight or explain.';
  if (!state.loading) {
    clearTimeout(pageSaveTimer); const bookId = state.bookId;
    pageSaveTimer = setTimeout(() => { void api(`/notebooks/${bookId}/page`, { method: 'PATCH', body: { page } }).catch(e => toast(e.message, true)); }, 350);
  }
} });

async function api(path, options = {}) {
  const { body, ...rest } = options;
  const response = await fetch(`/api${path}`, { ...rest, headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function toast(message, error = false) {
  clearTimeout(toastTimer); const el = $('#toast'); el.textContent = message; el.classList.remove('hidden'); el.classList.toggle('error', error);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}
function online(ok) { $('#connection-status').innerHTML = `<span class="tiny-dot"></span>${ok ? 'Saved locally' : 'Reconnecting…'}`; $('#connection-status').classList.toggle('offline', !ok); }
function worker(status) {
  const text = { offline: 'Codex disconnected', waiting: 'Codex is listening', processing: 'Codex is answering' }[status?.state] || 'Connect Codex to get answers';
  $('#worker-state').textContent = text; $('.panel-footer').classList.toggle('worker-active', status?.state !== 'offline');
  $('#panel-connect').classList.toggle('hidden', status?.state !== 'offline');
}
async function books() {
  const result = await api('/notebooks'); state.books = result.notebooks; renderShelf(); worker(state.bookId && state.data ? state.data.worker : result.worker); online(true);
}
function renderShelf() {
  $('#home-notebook-list').innerHTML = state.books.length ? state.books.map(b => `<button class="home-notebook" data-book="${b.id}"><span class="home-book-icon">${icon('BookOpen')}</span><strong>${escape(b.title)}</strong><span>${b.filename ? b.page_count + ' pages &middot; ' + b.notes + ' notes' : 'No PDF added'}</span>${icon('ArrowUpRight')}</button>`).join('') : '<p class="home-empty">No notebooks yet. Create one to add a PDF.</p>';
  icons($('#home-notebook-list'));
}
async function openBook(id) {
  if (state.loading) return;
  state.loading = true; state.bookId = id; state.selection = null; state.activeJob = null; state.signature = ''; hideSelection(); togglePageChat(false);
  $('#welcome').classList.add('hidden'); $('#study').classList.remove('hidden');
  clearTimeout(pageSaveTimer); reader.clear();
  try {
    if (pdfLoadTask) { await pdfLoadTask.destroy(); pdfLoadTask = null; }
    state.pdf = null; state.data = await api(`/notebooks/${id}/state`); state.page = state.data.notebook.current_page; state.zoom = 1;
    state.signature = JSON.stringify([state.data.selections, state.data.jobs, state.data.notes, state.data.worker?.state]);
    localStorage.setItem('bench-book', id); state.view = localStorage.getItem('bench-view') === 'reader' ? 'reader' : 'notes'; state.collapsed = true; state.editingNote = null; applyView(); renderNotes(true); renderShelf(); renderBookHeader(); renderPanel(); updateCounts(); worker(state.data.worker);
    $('#pdf-pages').classList.add('hidden'); $('#reader-message').classList.add('hidden');
    $('#upload-view').classList.toggle('hidden', Boolean(state.data.notebook.filename));
    if (state.data.notebook.filename) {
      showReaderMessage('Opening your book…');
      pdfLoadTask = getDocument({ url: `/api/notebooks/${id}/pdf`, isEvalSupported: false, cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/' });
      state.pdf = await pdfLoadTask.promise;
      await renderPage();
    }
  } catch (error) { showReaderMessage(error.message); toast(error.message, true); }
  finally { state.loading = false; updatePageControls(); }
}
function renderBookHeader() {
  const b = state.data.notebook;
  $('#book-title').textContent = b.title; $('#breadcrumb-title').textContent = b.title;
  $('#reader-book-title').textContent = b.title;
  $('#notes-book-title').textContent = b.title;
  $('#book-subtitle').textContent = b.filename ? `${b.filename}  /  ${b.page_count} pages` : 'Your book is the beginning. Bring a PDF to this notebook.';
}
function showReaderMessage(text) { const el = $('#reader-message'); el.textContent = text; el.classList.remove('hidden'); }
function updatePageControls() {
  if (document.activeElement !== $('#page-input')) $('#page-input').value = state.page;
  $('#page-input').max = state.pdf?.numPages || 1;
  $('#page-total').textContent = `/ ${state.pdf?.numPages || '—'}`;
  $('#prev-page').disabled = !state.pdf || state.page <= 1; $('#next-page').disabled = !state.pdf || state.page >= state.pdf.numPages;
  $('#zoom-in').disabled = !state.pdf || state.zoom >= 1.6; $('#zoom-out').disabled = !state.pdf || state.zoom <= .7;
  $('#zoom-label').textContent = state.zoom === 1 ? 'Fit' : `${Math.round(state.zoom * 100)}%`;
  $('#chat-page-number').textContent = state.page;
  $('#add-page-note').disabled = !state.pdf || state.busy;
  $('#show-explanation').disabled = !state.pdf || state.busy;
}
async function renderPage() {
  if (!state.pdf || state.view !== 'reader' || state.selecting) return;
  hideSelection(); updatePageControls();
  $('#pdf-pages').classList.remove('hidden');
  reader.direction = state.direction; reader.zoom = state.zoom;
  try {
    layoutPromise = reader.document !== state.pdf ? reader.open(state.pdf,state.page) : reader.layout({page:state.page});
    await layoutPromise;
    $('#reader-message').classList.add('hidden');
    drawHighlights();
  } catch (error) {
    if (error.name !== 'RenderingCancelledException' && error.name !== 'AbortException') { showReaderMessage(`Could not render this page: ${error.message}`); toast('This page could not be rendered.', true); }
  }
}
async function goPage(page) {
  if (!state.pdf || !Number.isInteger(page) || page < 1 || page > state.pdf.numPages) { $('#page-input').value = state.page; updatePageControls(); return; }
  const bookId = state.bookId;
  await layoutPromise.catch(() => {});
  if (bookId !== state.bookId) return;
  state.page = page; await reader.jump(page); updatePageControls();
  if (state.page !== page || bookId !== state.bookId) return;
  try { await api(`/notebooks/${bookId}/page`, { method: 'PATCH', body: { page } }); } catch (e) { toast(e.message, true); }
}
function drawHighlights() {
  reader.setHighlights(state.data?.selections || [], state.selection?.id);
  $('#highlight-count').textContent = `${state.data?.selections.filter(s => s.kind !== 'page').length || 0} highlights`;
}
function hideSelection() { $('#selection-menu').classList.add('hidden'); }
function captureSelection() {
  let captured;
  try { captured = capturePdfSelection(window.getSelection(), $('#pdf-pages')); }
  catch (e) { hideSelection(); toast(e.message); return; }
  if (!captured) { hideSelection(); return; }
  if (state.selection?.text === captured.selection.text && state.selection?.page === captured.selection.page && !$('#selection-menu').classList.contains('hidden')) return;
  state.selection = captured.selection; state.activeJob = null; state.choosingStyle = true;
  const bounds = captured.bounds; const menu = $('#selection-menu'); menu.classList.remove('hidden');
  menu.style.left = `${Math.min(Math.max(bounds.left, 12), window.innerWidth-menu.offsetWidth-12)}px`;
  menu.style.top = `${Math.max(12, Math.min(bounds.top-menu.offsetHeight-12, window.innerHeight-menu.offsetHeight-12))}px`;
  state.tab = 'explain'; renderPanel(); drawHighlights();
}
async function ensureSelection() {
  if (!state.selection) throw new Error('Select a passage in your book first.');
  if (!state.selection.id) {
    if (state.selection.kind === 'page') state.selection = await api(`/notebooks/${state.bookId}/selections`, { method:'POST',body:state.selection });
    else state.selection = (await api(`/notebooks/${state.bookId}/highlights`, {method:'POST',body:{selection:state.selection}})).selection;
    state.data.selections.push(state.selection); drawHighlights();
  }
  return state.selection;
}
async function action(fn) {
  if (state.busy) return;
  state.busy = true; updatePageControls();
  try { await fn(); await refresh(true); await books(); }
  catch (e) { toast(e.message, true); }
  finally { state.busy = false; updatePageControls(); renderPanel(); }
}
async function highlight() { await action(async () => {
  if (!state.selection || state.selection.kind === 'page') throw new Error('Select some text first.');
  const result = await api(`/notebooks/${state.bookId}/highlights`, { method:'POST',body:state.selection.id ? { selection_id:state.selection.id } : { selection:state.selection } });
  state.selection = result.selection; hideSelection(); window.getSelection()?.removeAllRanges(); toast('Highlighted and saved to Notes.');
}); }
async function pageSelection(persist = true) {
  reader.trackPage();
  const page = await reader.pageContent(state.page);
  if (!page.text) throw new Error('This page has no selectable text. You can still save its snapshot to Notes.');
  const source = { page:page.page,start_offset:0,text:page.text,context:page.text,rects:[],kind:'page' };
  return persist ? api(`/notebooks/${state.bookId}/selections`,{ method:'POST',body:source }) : source;
}
const styles = { image:{label:'Visual',format:'image',instruction:'Generate an educational illustration or infographic that explains the selected text and question. Use your image-generation tool to create a real PNG with clear labels and readable contrast. Submit the saved PNG path using submit_image if exposed, otherwise submit_explanation with format text and content JSON containing file_path and alt. A Saved to path is usable even with no inline image payload. If the path is not visible, call submit_explanation with format text and content {"find_generated_images":true}, inspect the returned candidates and submit the matching saved PNG path. If no image-generation tool is available, call fail_job with a clear explanation. Do not substitute Mermaid or silently use a paid API.'},visual:{ label:'Chart',format:'mermaid',instruction:'Explain visually using a clear Mermaid diagram. Return only Mermaid source, without code fences.' },simplify:{ label:'Simplify',format:'markdown',instruction:'Explain simply in plain language, briefly, with one concrete example. Avoid jargon.' },detailed:{ label:'Detailed',format:'markdown',instruction:'Explain in detail, step by step, including the key reasoning and a useful example. Use readable Markdown.' } };
async function ask({ wholePage = false, question = '' } = {}) {
  await action(async () => {
    state.choosingStyle = false;
    const selection = wholePage || !state.selection ? await pageSelection() : await ensureSelection(); state.selection = selection;
    const mode = styles[state.style];
    const job = await api('/jobs', { method:'POST',body:{ selection_id:selection.id,format:mode.format,style:state.style,question,instruction:`${mode.instruction}${question ? '\nQuestion: '+question : ''}` } });
    state.activeJob = job.id; state.tab = 'explain';
    if (state.collapsed) setExplanationCollapsed(false);
    hideSelection(); window.getSelection()?.removeAllRanges(); togglePageChat(false);
    if (question) $('#page-question').value = '';
    toast(state.data.worker?.state === 'offline' ? 'Question saved. Connect Codex to get an answer.' : 'Question sent. The answer will appear here.');
  });
}
async function saveCurrentPage() { await action(async () => {
  reader.trackPage();
  const page = await reader.pageContent(state.page,true);
  await api(`/notebooks/${state.bookId}/page-notes`,{method:'POST',body:page}); toast(`Page ${page.page} saved to Notes.`);
}); }
async function explainCurrentPage() {
  reader.trackPage();
  const source = state.data?.selections.find(s => s.kind === 'page' && s.page === state.page);
  const job = source && [...state.data.jobs].reverse().find(j => j.selection_id === source.id);
  if (!job) {
    await action(async () => { state.selection = await pageSelection(false); state.activeJob = null; state.tab = 'explain'; state.choosingStyle = true; togglePageChat(false); if (state.collapsed) setExplanationCollapsed(false); });
    return;
  }
  state.selection = source; state.activeJob = job.id; state.tab = 'explain'; togglePageChat(false);
  if (styles[job.style]) state.style = job.style;
  state.choosingStyle = true;
  if (state.collapsed) setExplanationCollapsed(false);
  renderPanel();
}
let chatAnimation;
function togglePageChat(open = $('#ask-page-toggle').getAttribute('aria-expanded') !== 'true') {
  const panel = $('#page-chat'); const button = $('#ask-page-toggle');
  const wasOpen = button.getAttribute('aria-expanded') === 'true';
  if (open === wasOpen) return;
  chatAnimation?.cancel();
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', open ? 'Close question box' : 'Ask about this page');
  button.title = open ? 'Close question box' : 'Ask about this page';
  panel.inert = !open;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (open) {
    panel.classList.remove('hidden'); $('#chat-page-number').textContent = state.page;
    chatAnimation = panel.animate([{opacity:0,transform:'translateY(14px) scale(.96)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:reduced ? 0 : 240,easing:'cubic-bezier(.16,1,.3,1)'});
    $('#page-question').focus({preventScroll:true});
  } else {
    if (panel.contains(document.activeElement)) button.focus({preventScroll:true});
    chatAnimation = panel.animate([{opacity:1,transform:'translateY(0) scale(1)'},{opacity:0,transform:'translateY(10px) scale(.97)'}],{duration:reduced ? 0 : 150,easing:'ease-in',fill:'forwards'});
    chatAnimation.finished.then(() => { if (button.getAttribute('aria-expanded') === 'false') panel.classList.add('hidden'); }).catch(() => {});
  }
}

function updateCounts() {
  if (!state.data) return;
  $('#notes-count').textContent = state.data.notes.length;
  $('#queue-count').textContent = state.data.jobs.length;
}
function applyView() {
  document.body.classList.toggle('reader-focus', state.view === 'reader' && Boolean(state.data?.notebook.filename));
  document.body.classList.toggle('notes-focus', state.view === 'notes');
  document.body.classList.toggle('explanations-open', !state.collapsed);
  $('#reader-view').classList.toggle('hidden', state.view !== 'reader');
  $('#notes-view').classList.toggle('hidden', state.view !== 'notes');
  $('#reader-view').classList.toggle('explanation-collapsed', state.collapsed);
  $('#explanation-panel').classList.toggle('hidden', state.collapsed);
  $('#scroll-direction').value = state.direction;
  document.querySelectorAll('[data-view]').forEach(button => { const active = button.dataset.view === state.view; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
}
function showView(view) {
  if (view === 'reader' && state.view !== 'reader') state.collapsed = true;
  state.view = view; localStorage.setItem('bench-view', view); hideSelection(); togglePageChat(false); applyView();
  if (view === 'notes') renderNotes(true);
  else if (state.pdf) void renderPage();
  if (view !== 'reader' && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}
function setExplanationCollapsed(collapsed) {
  state.collapsed = collapsed; applyView();
  if (state.pdf && state.view === 'reader') void renderPage();
}
function renderNotes(force = false) {
  if (!state.data || state.view !== 'notes' || (state.editingNote && !force)) return;
  $('#export-notes').href = '/api/notebooks/'+state.bookId+'/export';
  $('#export-notes').classList.toggle('disabled',!state.data.notes.length);
  renderNotesWorkspace({state,root:$('#notes-content'),escape,icon,icons,renderRich});
}

function renderPanel() {
  if (!state.data) return;
  renderExplanationPanel({ state,root:$('#panel-content'),styles,escape,icon,icons,renderRich });
  document.querySelectorAll('[data-style]').forEach(button => button.classList.toggle('active',button.dataset.style === state.style && (!button.hasAttribute('data-request-style') || !state.choosingStyle)));
}

let mermaidPromise;
async function diagram(el, source) {
  try {
    mermaidPromise ||= import('mermaid').then(({ default: mermaid }) => { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false, theme: 'dark', themeVariables: { primaryColor: '#202b3d', primaryTextColor: '#e3e8f0', primaryBorderColor: '#607da1', lineColor: '#8fa7c5', fontFamily: 'Consolas, monospace' }, flowchart: { htmlLabels: false } }); return mermaid; });
    const mermaid = await mermaidPromise;
    const { svg } = await mermaid.render(`diagram-${crypto.randomUUID()}`, source.replace(/^```(?:mermaid)?\s*\n?|\n?```$/g, ''));
    if (el.isConnected && !state.noteDrafts.has(el.closest('[data-inline-note]')?.dataset.inlineNote)) {
      const preview = document.createElement('button');
      preview.type = 'button'; preview.className = 'chart-preview'; preview.contentEditable = 'false';
      preview.setAttribute('aria-label', 'Open chart in larger view'); preview.title = 'Click to enlarge chart';
      preview.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      el.replaceChildren(preview);
    }
  } catch { if (el.isConnected) { el.innerHTML = '<p class="diagram-error">This diagram could not be rendered. Its source is shown below.</p>'; const pre = document.createElement('pre'); pre.textContent = source; el.append(pre); } }
}
function sanitizeRichHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(html,{FORBID_TAGS:['iframe','style','form','input','button','video','audio','svg'],FORBID_ATTR:['style','srcset']});
  template.content.querySelectorAll('img').forEach(img => {
    if (!/^\/api\/images\/[a-f0-9-]{36}$/.test(img.getAttribute('src') || '')) img.remove();
  });
  return template.innerHTML;
}
function renderRich(el, content, format) {
  if (!el) return;
  if (format === 'mermaid') { el.textContent = 'Drawing the connections…'; void diagram(el, content); }
  else if (format === 'code' || format === 'text') { const pre = document.createElement(format === 'code' ? 'pre' : 'div'); pre.className = format === 'text' ? 'plain-text' : ''; pre.textContent = content; el.replaceChildren(pre); }
  else {
    el.innerHTML = sanitizeRichHtml(marked.parse(content));
    el.querySelectorAll('img').forEach(img => {
      const preview = document.createElement('button'); preview.type='button'; preview.className='visual-preview'; preview.contentEditable='false';
      preview.setAttribute('aria-label','Open visual in larger view'); preview.title='Click to enlarge visual';
      img.loading='lazy'; img.replaceWith(preview); preview.append(img);
    });
    el.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    el.querySelectorAll('pre code.language-mermaid').forEach(code => { const block = document.createElement('div'); block.className = 'inline-diagram'; code.parentElement.replaceWith(block); void diagram(block, code.textContent); });
  }
}
async function refresh(force = false) {
  if (!state.bookId || state.loading || refreshBusy) return;
  refreshBusy = true;
  const bookId = state.bookId;
  try {
    const result = await api(`/notebooks/${bookId}/state`);
    if (bookId !== state.bookId || state.loading) return;
    const signature = JSON.stringify([result.selections, result.jobs, result.notes, result.worker?.state]);
    state.data = result; online(true); worker(result.worker);
    if (force || signature !== state.signature) { state.signature = signature; updateCounts(); renderPanel(); renderNotes(); drawHighlights(); }
  } catch { online(false); }
  finally { refreshBusy = false; }
}
async function upload(file) {
  if (!file || state.busy) return;
  await action(async () => {
    const form = new FormData(); form.append('pdf', file);
    showReaderMessage('Making a place for your book…');
    await api(`/notebooks/${state.bookId}/pdf`, { method: 'POST', body: form });
    await openBook(state.bookId); toast('Your book is ready. Make yourself at home.');
  });
  $('#pdf-upload').value = '';
}
function openDialog(id) { hideSelection(); $(id).showModal(); }
function showCreate() { openDialog('#notebook-dialog'); $('#notebook-title').focus(); }
$('#welcome-new').addEventListener('click', showCreate);
$('#notebook-form').addEventListener('submit', async event => {
  event.preventDefault();
  await action(async () => {
    const book = await api('/notebooks', { method: 'POST', body: { title: $('#notebook-title').value } });
    $('#notebook-dialog').close(); $('#notebook-form').reset(); await books(); await openBook(book.id);
  });
});
$('#try-sample').addEventListener('click', () => action(async () => { toast('Putting a little book on your desk…'); const book = await api('/sample', { method: 'POST' }); await books(); await openBook(book.id); }));
$('#home-notebook-list').addEventListener('click', event => { const button = event.target.closest('[data-book]'); if (button && !state.busy) void openBook(button.dataset.book); });
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const b = dialog.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) dialog.close(); } }));
$('#help').addEventListener('click', () => openDialog('#help-dialog'));
const mcpConfig = () => '[mcp_servers.study_bench]\nurl = ' + JSON.stringify(location.origin + '/mcp') + '\ntool_timeout_sec = 1860';
['#connect','#panel-connect'].forEach(id => $(id).addEventListener('click', () => { $('#mcp-config').textContent = mcpConfig(); openDialog('#connect-dialog'); }));
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied. Ready when you are.'); } catch { toast('Clipboard unavailable. Select and copy the text above.', true); } }
$('#copy-config').addEventListener('click', () => copy(mcpConfig()));
$('#copy-prompt').addEventListener('click', () => copy('Start Study Bench by calling study_bench.start. Follow its instructions to wait for questions, submit answers to Bench, and wait again. Continue after idle timeouts until I say stop.'));
$('#choose-pdf').addEventListener('click', () => $('#pdf-upload').click()); $('#pdf-upload').addEventListener('change', e => void upload(e.target.files[0]));
$('#reader-scroll').addEventListener('dragover', e => { if (!state.data?.notebook.filename) { e.preventDefault(); $('#upload-view').classList.add('drag-over'); } });
$('#reader-scroll').addEventListener('dragleave', () => $('#upload-view').classList.remove('drag-over'));
$('#reader-scroll').addEventListener('drop', e => { e.preventDefault(); $('#upload-view').classList.remove('drag-over'); if (!state.data?.notebook.filename) void upload(e.dataTransfer.files[0]); });
$('#prev-page').addEventListener('click', () => void goPage(state.page-1)); $('#next-page').addEventListener('click', () => void goPage(state.page+1));
$('#page-input').addEventListener('change', e => void goPage(Number(e.target.value)));
['in','out'].forEach(direction => $(`#zoom-${direction}`).addEventListener('click', () => { state.zoom = Math.min(1.6, Math.max(.7, Math.round((state.zoom + (direction === 'in' ? .15 : -.15))*100)/100)); void renderPage(); }));
$('#pdf-pages').addEventListener('pointerdown', e => { if (e.button !== 0 || !e.target.closest('.textLayer')) return; state.selecting = true; reader.selectionLocked = true; e.target.closest('.textLayer').classList.add('selecting'); hideSelection(); });
function finishPdfSelection() {
  if (!state.selecting) return; state.selecting = false; reader.selectionLocked = false;
  document.querySelectorAll('.textLayer.selecting').forEach(layer => layer.classList.remove('selecting'));
  setTimeout(captureSelection,0);
}
document.addEventListener('pointerup',finishPdfSelection);
document.addEventListener('pointercancel',finishPdfSelection);
document.addEventListener('selectionchange', () => { clearTimeout(selectionTimer); if (!state.selecting) selectionTimer = setTimeout(captureSelection,160); });
$('#pdf-pages').addEventListener('click', event => {
  if (event.button !== 0 || state.collapsed || state.view !== 'reader') return;
  const selection = window.getSelection();
  // Keep the page stable after dragging to select text.
  if (selection && !selection.isCollapsed && selection.toString().trim()) return;
  setExplanationCollapsed(true);
});
$('#pdf-pages').addEventListener('keyup', captureSelection);
$('#pdf-pages').addEventListener('keydown', e => { const layer = e.target.closest('.textLayer'); if (layer && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); const range = document.createRange(); range.selectNodeContents(layer); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); captureSelection(); } });
$('#selection-menu').addEventListener('pointerdown', event => event.preventDefault());
$('#selection-highlight').addEventListener('click', () => void highlight()); $('#selection-explain').addEventListener('click', () => { state.choosingStyle = true; state.tab = 'explain'; togglePageChat(false); if (state.collapsed) setExplanationCollapsed(false); renderPanel(); });
$('.notebook-tabs').addEventListener('click', e => { const button = e.target.closest('[data-view]'); if (button) showView(button.dataset.view); });
$('#collapse-explanation').addEventListener('click', () => setExplanationCollapsed(true));
$('#show-explanation').addEventListener('click',explainCurrentPage);
$('#add-page-note').addEventListener('click', () => void saveCurrentPage());
$('#ask-page-toggle').addEventListener('click', () => togglePageChat());
$('#close-page-chat').addEventListener('click', () => togglePageChat(false));
$('#page-question-form').addEventListener('submit', e => { e.preventDefault(); const question = $('#page-question').value.trim(); if (question) void ask({wholePage:true,question}); });
document.addEventListener('click', e => {
  const button = e.target.closest('[data-style]'); if (!button) return;
  state.style = button.dataset.style;
  if (button.dataset.requestStyle) state.choosingStyle = false;
  document.querySelectorAll('[data-style]').forEach(b => b.classList.toggle('active',b.dataset.style === state.style));
  if (button.dataset.requestStyle) void ask();
});
$('#reader-notes').addEventListener('click', () => showView('notes'));
$('#leave-reader').addEventListener('click', () => showView('notes'));
$('#back-to-shelf').addEventListener('click', () => {
  clearTimeout(pageSaveTimer); state.bookId = null; state.view = 'shelf'; reader.clear(); applyView();
  localStorage.removeItem('bench-book'); $('#study').classList.add('hidden'); $('#welcome').classList.remove('hidden');
  $('#breadcrumb-title').textContent = 'Notebooks'; renderShelf();
});
$('#scroll-direction').addEventListener('change', e => { state.direction = e.target.value; localStorage.setItem('bench-scroll-direction', state.direction); void renderPage(); });
$('#browser-fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { toast('Use your browser’s fullscreen shortcut to hide the browser toolbar.'); }
});
document.addEventListener('fullscreenchange', () => { const active = Boolean(document.fullscreenElement); $('#browser-fullscreen').setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen'); $('#browser-fullscreen').title = active ? 'Exit fullscreen' : 'Enter fullscreen'; });
document.addEventListener('pointerdown', event => { if (!event.target.closest('#selection-menu') && !event.target.closest('.textLayer')) hideSelection(); });
$('.panel-tabs').addEventListener('click', e => { const tab = e.target.closest('[data-tab]'); if (tab) { state.tab = tab.dataset.tab; renderPanel(); } });
$('#panel-content').addEventListener('click', async e => {
  const answer = e.target.closest('[data-save-answer]');
  if (answer) return void action(async () => { const job = state.data.jobs.find(j => j.id === answer.dataset.saveAnswer); await api('/notes/answers',{method:'POST',body:{selection_id:job.selection_id,job_id:job.id}}); toast('Answer saved to Notes.'); });
  const selectedJob = e.target.closest('[data-job]');
  if (selectedJob) { const job = state.data.jobs.find(j => j.id === selectedJob.dataset.job); state.selection = state.data.selections.find(s => s.id === job.selection_id); state.activeJob = job.id; if (styles[job.style]) state.style = job.style; state.choosingStyle = false; state.tab = 'explain'; renderPanel(); return; }
  const retry = e.target.closest('[data-retry]'); if (retry) return void action(async () => { await api(`/jobs/${retry.dataset.retry}/retry`, { method: 'POST' }); toast('Question sent again.'); });
  const cancel = e.target.closest('[data-cancel]'); if (cancel) return void action(async () => { await api(`/jobs/${cancel.dataset.cancel}/cancel`, { method: 'POST' }); toast('Request cancelled.'); });
});
function readInlineNote(editor) {
  const draft = state.noteDrafts.get(editor.dataset.inlineNote); if (!draft) return;
  const content = draft.format === 'markdown' ? markdownFromHtml.turndown(sanitizeRichHtml(editor.innerHTML)) : editor.innerText;
  draft.content = content;
}
function startInlineNote(editor) {
  const id = editor.dataset.inlineNote; const note = state.data.notes.find(n => n.id === id); if (!note) return;
  if (state.editingNote === id) return;
  state.editingNote = id;
  if (!state.noteDrafts.has(id)) state.noteDrafts.set(id,{content:noteInitialValue(note),format:noteInitialFormat(note)});
  const draft = state.noteDrafts.get(id);
  if (['text','code','mermaid'].includes(draft.format)) { editor.textContent = draft.content; editor.classList.add('plain-editing'); }
  else if (editor.querySelector('svg,.inline-diagram')) editor.innerHTML = sanitizeRichHtml(marked.parse(draft.content));
  document.querySelectorAll('[data-note-actions]').forEach(bar => bar.classList.toggle('hidden',bar.dataset.noteActions !== id));
  document.querySelectorAll('.workspace-note').forEach(card => card.classList.toggle('editing',card.id === `note-${id}`));
}
$('#notes-content').addEventListener('focusin', e => { const editor = e.target.closest('[data-inline-note]'); if (editor && !e.target.closest('.chart-preview,.visual-preview')) startInlineNote(editor); });
$('#notes-content').addEventListener('input', e => { const editor = e.target.closest('[data-inline-note]'); if (editor) readInlineNote(editor); });
$('#notes-content').addEventListener('paste', e => {
  const editor = e.target.closest('[data-inline-note]'); if (!editor) return;
  e.preventDefault(); document.execCommand('insertText',false,e.clipboardData.getData('text/plain')); readInlineNote(editor);
});
$('#notes-content').addEventListener('drop', e => { if (e.target.closest('[data-inline-note]')) e.preventDefault(); });
$('#notes-content').addEventListener('keydown', e => {
  const editor = e.target.closest('[data-inline-note]'); if (!editor) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $(`[data-save-edit="${editor.dataset.inlineNote}"]`).click(); }
  if (e.key === 'Escape') { e.preventDefault(); $(`[data-cancel-edit="${editor.dataset.inlineNote}"]`).click(); }
});
$('#notes-content').addEventListener('click', async e => {
  if (e.target.closest('[data-return-reader]')) return showView('reader');
  const source = e.target.closest('[data-note-source]');
  if (source) { state.selection = state.data.selections.find(s => s.id === source.dataset.noteSource); state.tab = 'explain'; showView('reader'); if (state.selection) { await goPage(state.selection.page); renderPanel(); drawHighlights(); } return; }
  const remove = e.target.closest('[data-delete-note]');
  if (remove) {
    if (remove.disabled || !window.confirm('Delete this note? Its saved text and any unsaved edits will be removed.')) return;
    const id = remove.dataset.deleteNote; const bookId = state.bookId;
    remove.disabled = true;
    try {
      await api(`/notes/${id}`, {method:'DELETE'});
      state.noteDrafts.delete(id); if (state.editingNote === id) state.editingNote = null;
      if (bookId === state.bookId) { state.data.notes = state.data.notes.filter(n => n.id !== id); updateCounts(); renderNotes(true); }
      toast('Note deleted.'); void books();
    } catch (error) { remove.disabled = false; toast(error.message,true); }
    return;
  }
  const append = e.target.closest('[data-append-note]');
  if (append) {
    const id = append.dataset.appendNote; const editor = $(`[data-inline-note="${id}"]`);
    if (!editor) return;
    startInlineNote(editor);
    const draft = state.noteDrafts.get(id);
    if (['mermaid','code'].includes(draft.format)) {
      draft.content = '```' + (draft.format === 'mermaid' ? 'mermaid' : '') + '\n' + draft.content + '\n```';
      draft.format = 'markdown'; editor.classList.remove('plain-editing');
      editor.innerHTML = DOMPurify.sanitize(marked.parse(draft.content));
    }
    if (draft.format === 'text') {
      const original = document.createElement('div'); original.className = 'plain-text'; original.textContent = draft.content;
      editor.replaceChildren(original); draft.format = 'markdown'; editor.classList.remove('plain-editing');
    }
    const addition = document.createElement('div'); addition.className = 'note-appended';
    const paragraph = document.createElement('p'); paragraph.append(document.createElement('br')); addition.append(paragraph); editor.append(addition);
    editor.focus();
    const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    readInlineNote(editor); editor.scrollIntoView({block:'nearest',behavior:'smooth'});
    return;
  }
  const edit = e.target.closest('[data-edit-note]');
  if (edit) {
    const editor = $(`[data-inline-note="${edit.dataset.editNote}"]`); if (editor) { startInlineNote(editor); editor.focus(); } return;
  }
  const cancel = e.target.closest('[data-cancel-edit]');
  if (cancel) { state.noteDrafts.delete(cancel.dataset.cancelEdit); state.editingNote = null; renderNotes(true); return; }
  const save = e.target.closest('[data-save-edit]');
  if (save) {
    const editor = $(`[data-inline-note="${save.dataset.saveEdit}"]`); if (editor) readInlineNote(editor);
    if (save.disabled) return;
    const id = save.dataset.saveEdit;
    const draft = state.noteDrafts.get(id);
    if (!draft) return;
    const submitted = { ...draft };
    const bookId = state.bookId;
    save.disabled = true;
    try {
      const saved = await api(`/notes/${id}`, { method: 'PATCH', body: submitted });
      if (bookId === state.bookId) {
        const note = state.data.notes.find(n => n.id === id);
        if (note) Object.assign(note, saved);
      }
      const current = state.noteDrafts.get(id);
      if (current?.content === submitted.content && current?.format === submitted.format) {
        state.noteDrafts.delete(id);
        if (state.editingNote === id) state.editingNote = null;
      }
      toast('Your note is saved.');
    } catch (e) {
      toast(`Could not save your note: ${e.message} Your edits are still here; try Save again.`, true);
    } finally {
      save.disabled = false;
      if (bookId === state.bookId) renderNotes(true);
    }
  }
});
window.addEventListener('beforeunload', e => {
  const changed = state.data?.notes.some(n => { const draft = state.noteDrafts.get(n.id); return draft && (draft.content !== noteInitialValue(n) || draft.format !== noteInitialFormat(n)); });
  if (changed) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('keydown', e => { if (state.view !== 'reader' || e.target.closest('input,textarea,select,dialog') || window.getSelection()?.toString()) return; if (e.key === 'ArrowRight') void goPage(state.page+1); if (e.key === 'ArrowLeft') void goPage(state.page-1); });
let resizeTimer; window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.pdf && state.view === 'reader') void renderPage(); }, 200); });
setInterval(() => void refresh(), 1500);
try {
  await books();
  const last = localStorage.getItem('bench-book');
  if (last && state.books.some(b => b.id === last)) await openBook(last);
} catch (e) { online(false); toast(`Could not connect to your workspace: ${e.message}`, true); }

const chartDialog = $('#chart-dialog');
document.addEventListener('click', e => {
  const preview = e.target.closest('.chart-preview,.visual-preview');
  if (!preview) return;
  const media = preview.querySelector('svg,img'); if (!media) return;
  $('#chart-dialog-title').textContent = media.tagName.toLowerCase() === 'img' ? 'Visual' : 'Chart';
  $('#chart-viewer').replaceChildren(media.cloneNode(true));
  if (!chartDialog.open) chartDialog.showModal();
});
$('#close-chart').addEventListener('click', () => chartDialog.close());
chartDialog.addEventListener('click', e => { if (e.target === chartDialog) { const rect = chartDialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) chartDialog.close(); } });
chartDialog.addEventListener('close', () => $('#chart-viewer').replaceChildren());

$('#page-chat').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); togglePageChat(false); } });

document.addEventListener('click', e => { if (e.target.closest('[data-connect-codex]')) { $('#mcp-config').textContent = mcpConfig(); openDialog('#connect-dialog'); } });
