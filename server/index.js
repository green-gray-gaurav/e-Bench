import express from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { PDFDocument } from 'pdf-lib';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Store, BenchError } from './store.js';
import { mountMcp } from './mcp.js';
import { sampleBook } from './sample.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const formats = z.enum(['markdown', 'text', 'mermaid', 'code']);
const rect = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) })
  .refine(r => r.x + r.width <= 1.005 && r.y + r.height <= 1.005, 'Highlight lies outside the page.');
const selectionSchema = z.object({
  page: z.number().int().positive(), start_offset: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(100_000), context: z.string().max(100_000).default(''),
  rects: z.array(rect).max(1000), kind: z.enum(['passage', 'page']).default('passage'),
}).refine(s => s.kind === 'page' || s.rects.length > 0, 'Select some text to highlight.');

export function createApp({ dbPath = join(process.env.BENCH_DATA_DIR || join(root, 'data'), 'bench.sqlite'), leaseMs } = {}) {
  const store = new Store(dbPath, { leaseMs });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // A local, single-user prototype. Reject browser cross-origin writes and DNS rebinding.
    const allowed = ['localhost', '127.0.0.1', '[::1]', ...(process.env.BENCH_ALLOWED_HOSTS || '').split(',').filter(Boolean)];
    if (!allowed.includes(req.hostname)) return res.status(403).json({ error: 'Host is not allowed.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
      return res.status(403).json({ error: 'Cross-origin access is not allowed.' });
    }
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use('/mcp', express.json({ limit: '16mb' }));
  app.use(express.json({ limit: '4mb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 1, fields: 0 } });
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.0' }));
  app.get('/api/notebooks', (_req, res) => res.json({ notebooks: store.listNotebooks(), worker: store.workerStatus() }));
  app.post('/api/notebooks', (req, res) => {
    const data = z.object({ title: z.string().trim().min(1).max(120) }).parse(req.body);
    res.status(201).json(store.createNotebook(data.title));
  });
  app.post('/api/sample', async (_req, res) => {
    const bytes = await sampleBook();
    const book = store.createNotebook('Thinking in systems');
    res.status(201).json(store.attachPdf(book.id, 'thinking-in-systems.pdf', bytes, 3));
  });
  app.get('/api/notebooks/:id/state', (req, res) => res.json(store.state(req.params.id)));
  app.post('/api/notebooks/:id/pdf', upload.single('pdf'), async (req, res) => {
    store.notebook(req.params.id);
    if (!req.file) throw new BenchError('Choose a PDF to upload.');
    if (!req.file.originalname.toLowerCase().endsWith('.pdf') || !req.file.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new BenchError('Only valid PDF files are supported.');
    }
    let document;
    try { document = await PDFDocument.load(req.file.buffer); }
    catch { throw new BenchError('This PDF could not be opened. Use a valid PDF without password protection.'); }
    if (!document.getPageCount()) throw new BenchError('This PDF has no pages.');
    const filename = req.file.originalname.replace(/[\x00-\x1f]/g, '').split(/[\\/]/).at(-1).slice(0, 200);
    res.status(201).json(store.attachPdf(req.params.id, filename, req.file.buffer, document.getPageCount()));
  });
  app.get('/api/notebooks/:id/pdf', (req, res) => {
    res.set('Cache-Control', 'private, max-age=3600').type('pdf').send(store.pdf(req.params.id));
  });
  app.patch('/api/notebooks/:id/page', (req, res) => {
    const { page } = z.object({ page: z.number().int().positive() }).parse(req.body);
    store.setPage(req.params.id, page); res.json({ ok: true });
  });
  app.post('/api/notebooks/:id/selections', (req, res) => res.status(201).json(store.createSelection(req.params.id, selectionSchema.parse(req.body))));
  app.post('/api/notebooks/:id/highlights', (req, res) => {
    const data = z.object({ selection: selectionSchema.optional(), selection_id: z.string().uuid().optional() }).parse(req.body);
    if (!data.selection_id && !data.selection) throw new BenchError('Select a passage first.');
    res.status(201).json(store.keepHighlight(req.params.id, data.selection, data.selection_id));
  });
  app.post('/api/notebooks/:id/page-notes', (req, res) => {
    const data = z.object({ page: z.number().int().positive(), text: z.string().max(100_000), image: z.string().max(3_000_000).startsWith('data:image/jpeg;base64,') }).parse(req.body);
    const bytes = Buffer.from(data.image.slice('data:image/jpeg;base64,'.length), 'base64');
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new BenchError('Page preview must be a JPEG image.');
    res.status(201).json(store.savePage(req.params.id, data.page, data.text, bytes));
  });
  app.get('/api/images/:id', (req,res) => res.type('png').set('Cache-Control','private, max-age=3600').send(store.answerImage(req.params.id)));
  app.post('/api/jobs', (req, res) => {
    const data = z.object({ selection_id: z.string().uuid(), format: z.enum(['markdown','text','mermaid','code','image']).default('markdown'), instruction: z.string().trim().max(4000).default(''), style: z.enum(['visual','image','simplify','detailed']).default('detailed'), question: z.string().trim().max(2000).default('') }).parse(req.body);
    res.status(201).json(store.createJob(data.selection_id, data.format, data.instruction, data.style, data.question));
  });
  app.post('/api/jobs/:id/retry', (req, res) => res.json(store.retry(req.params.id)));
  app.post('/api/jobs/:id/cancel', (req, res) => res.json(store.cancel(req.params.id)));
  app.post('/api/notes', (req, res) => {
    const data = z.object({ selection_id: z.string().uuid(), job_id: z.string().uuid().nullable().optional() }).parse(req.body);
    res.status(201).json(store.saveNote(data.selection_id, data.job_id));
  });
  app.post('/api/notes/answers', (req, res) => {
    const data = z.object({selection_id:z.string().uuid(),job_id:z.string().uuid()}).parse(req.body);
    res.json(store.addAnswerToNote(data.selection_id,data.job_id));
  });
  app.delete('/api/notes/:id', (req, res) => { store.deleteNote(req.params.id); res.json({ ok: true }); });
  app.get('/api/notes/:id/page-image', (req, res) => res.type('jpeg').set('Cache-Control','private, max-age=3600').send(store.noteImage(req.params.id)));
  app.patch('/api/notes/:id', (req, res) => {
    const data = z.object({ content: z.string().max(100_000), format: formats }).parse(req.body);
    res.json(store.editNote(req.params.id, data.content, data.format));
  });
  app.get('/api/notebooks/:id/export', (req, res) => {
    const { notebook, notes } = store.state(req.params.id);
    const text = [`# ${notebook.title}`, ...notes.map(n => {
      const quote = n.text.split('\n').map(line => `> ${line}`).join('\n');
      let content = n.content || '';
      if (content && ['mermaid', 'code'].includes(n.format)) content = `\`\`\`${n.format === 'mermaid' ? 'mermaid' : ''}\n${content}\n\`\`\``;
      return `## Page ${n.page}\n\n${quote}${content ? '\n\n' + content : ''}`;
    })].join('\n\n');
    res.type('text/markdown').attachment('bench-notes.md').send(text);
  });
  mountMcp(app, store);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  const dist = join(root, 'dist');
  if (existsSync(dist)) app.use(express.static(dist));
  app.get('/', (_req, res) => res.status(503).type('text').send('Build the reader first: npm run build'));
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'PDFs must be 40 MB or smaller.' : 'Upload one PDF at a time.' });
    if (err instanceof BenchError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'This request is too large.' });
    console.error('Request error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return { app, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, store } = createApp();
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const server = app.listen(port, host, () => console.log(`Study Bench is ready at http://localhost:${port}\nMCP endpoint: http://localhost:${port}/mcp`));
  const stop = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
