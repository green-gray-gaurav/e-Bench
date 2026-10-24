import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class BenchError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class Store {
  constructor(path, { leaseMs = 10 * 60_000 } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.leaseMs = leaseMs;
    this.activeWaits = new Map();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS notebooks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
        filename TEXT, pdf BLOB, page_count INTEGER, current_page INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS selections (
        id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        page INTEGER NOT NULL, start_offset INTEGER NOT NULL, text TEXT NOT NULL,
        context TEXT NOT NULL, rects TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, selection_id TEXT NOT NULL REFERENCES selections(id) ON DELETE CASCADE,
        requested_format TEXT NOT NULL, instruction TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, worker_id TEXT, claim_token TEXT,
        lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, content TEXT, format TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, selection_id TEXT NOT NULL UNIQUE REFERENCES selections(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES jobs(id), content TEXT, format TEXT, created_at TEXT NOT NULL, edited_at TEXT
      );
      CREATE TABLE IF NOT EXISTS answer_images (id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,bytes BLOB NOT NULL,alt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL, waiting_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS note_answers (note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, job_id TEXT NOT NULL REFERENCES jobs(id), PRIMARY KEY(note_id,job_id));
      CREATE INDEX IF NOT EXISTS queue_status ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS selection_book ON selections(notebook_id, page, start_offset);`);
    if (!this.db.prepare('PRAGMA table_info(notes)').all().some(column => column.name === 'edited_at')) {
      this.db.exec('ALTER TABLE notes ADD COLUMN edited_at TEXT');
    }
    for (const [table, column, type] of [['selections','kind',"TEXT NOT NULL DEFAULT 'passage'"], ['jobs','style',"TEXT NOT NULL DEFAULT 'detailed'"], ['jobs','question',"TEXT NOT NULL DEFAULT ''"], ['notes','page_image','BLOB'], ['workers','notebook_id','TEXT'], ['workers','running','INTEGER NOT NULL DEFAULT 1']]) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    this.db.exec('INSERT OR IGNORE INTO note_answers(note_id,job_id) SELECT id,job_id FROM notes WHERE job_id IS NOT NULL');
  }
  close() { this.db.close(); }
  notebook(id) {
    const row = this.db.prepare('SELECT id,title,created_at,filename,page_count,current_page FROM notebooks WHERE id=?').get(id);
    if (!row) throw new BenchError('Notebook not found.', 404);
    return row;
  }
  listNotebooks() {
    return this.db.prepare(`SELECT n.id,n.title,n.created_at,n.filename,n.page_count,n.current_page,
      (SELECT COUNT(*) FROM selections s WHERE s.notebook_id=n.id AND s.kind='passage') AS highlights,
      (SELECT COUNT(*) FROM notes t JOIN selections s ON s.id=t.selection_id WHERE s.notebook_id=n.id) AS notes
      FROM notebooks n ORDER BY n.created_at DESC, n.id`).all();
  }
  createNotebook(title) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO notebooks(id,title,created_at) VALUES(?,?,?)').run(id, title, new Date().toISOString());
    return this.notebook(id);
  }
  attachPdf(id, filename, bytes, pageCount) {
    this.notebook(id);
    const result = this.db.prepare('UPDATE notebooks SET filename=?,pdf=?,page_count=? WHERE id=? AND pdf IS NULL').run(filename, bytes, pageCount, id);
    if (!result.changes) throw new BenchError('This notebook already has a book. Create another notebook for a different PDF.', 409);
    return this.notebook(id);
  }
  pdf(id) {
    this.notebook(id);
    const result = this.db.prepare('SELECT pdf FROM notebooks WHERE id=?').get(id);
    if (!result.pdf) throw new BenchError('Upload a PDF first.', 404);
    return Buffer.from(result.pdf);
  }
  setPage(id, page) {
    const book = this.notebook(id);
    if (!book.page_count || page > book.page_count) throw new BenchError('Page is outside this book.');
    this.db.prepare('UPDATE notebooks SET current_page=? WHERE id=?').run(page, id);
  }
  selection(id) {
    const row = this.db.prepare('SELECT * FROM selections WHERE id=?').get(id);
    if (!row) throw new BenchError('Highlight not found.', 404);
    return { ...row, rects: JSON.parse(row.rects) };
  }
  createSelection(notebookId, data) {
    const book = this.notebook(notebookId);
    if (!book.page_count || data.page > book.page_count) throw new BenchError('Page is outside this book.');
    const kind = data.kind || 'passage';
    if (kind === 'page') {
      const existing = this.db.prepare("SELECT id FROM selections WHERE notebook_id=? AND page=? AND kind='page' LIMIT 1").get(notebookId, data.page);
      if (existing) return this.selection(existing.id);
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO selections(id,notebook_id,page,start_offset,text,context,rects,created_at,kind)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, notebookId, data.page, data.start_offset, data.text, data.context, JSON.stringify(data.rects), new Date().toISOString(), kind);
    return this.selection(id);
  }
  createJob(selectionId, format, instruction, style = 'detailed', question = '') {
    this.selection(selectionId);
    const existing = this.db.prepare("SELECT * FROM jobs WHERE selection_id=? AND requested_format=? AND instruction=? AND style=? AND question=? AND status IN ('queued','processing')").get(selectionId, format, instruction, style, question);
    if (existing) return this.publicJob(existing);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO jobs(id,selection_id,requested_format,instruction,created_at,updated_at,style,question) VALUES(?,?,?,?,?,?,?,?)').run(id, selectionId, format, instruction, now, now, style, question);
    return this.publicJob(this.job(id));
  }
  job(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw new BenchError('Explanation job not found.', 404);
    return row;
  }
  publicJob(row) {
    const { claim_token, lease_until, ...publicRow } = row;
    return publicRow;
  }
  recoverExpired() {
    return this.db.prepare("UPDATE jobs SET status='queued',worker_id=NULL,claim_token=NULL,lease_until=NULL,updated_at=? WHERE status='processing' AND lease_until<=?")
      .run(new Date().toISOString(), Date.now());
  }
  touchWorker(id, waitSeconds = 0) {
    this.db.prepare('INSERT INTO workers(id,seen_at,waiting_until) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at,waiting_until=excluded.waiting_until')
      .run(id, Date.now(), Date.now() + waitSeconds * 1000);
  }
  registerWorker(id, notebookId) {
    if (notebookId) this.notebook(notebookId);
    this.db.prepare('INSERT INTO workers(id,seen_at,waiting_until,notebook_id,running) VALUES(?,?,0,?,1) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at,waiting_until=0,notebook_id=excluded.notebook_id,running=1')
      .run(id,Date.now(),notebookId || null);
  }
  rememberWorkerScope(id, notebookId) {
    this.db.prepare('INSERT INTO workers(id,seen_at,waiting_until,notebook_id,running) VALUES(?,?,0,?,1) ON CONFLICT(id) DO UPDATE SET notebook_id=excluded.notebook_id')
      .run(id,Date.now(),notebookId || null);
  }
  workerSession(id) {
    return this.db.prepare('SELECT id,notebook_id,running FROM workers WHERE id=?').get(id);
  }
  stopWorker(id) {
    const worker = this.workerSession(id);
    if (!worker) throw new BenchError('Worker not found. Call start first.',404);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE workers SET running=0,waiting_until=0,seen_at=? WHERE id=?').run(Date.now(),id);
      const released = this.db.prepare("UPDATE jobs SET status='queued',worker_id=NULL,claim_token=NULL,lease_until=NULL,updated_at=? WHERE status='processing' AND worker_id=?")
        .run(new Date().toISOString(),id);
      this.db.exec('COMMIT'); return { worker_id:id,released_jobs:Number(released.changes) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  claim(workerId, notebookId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.recoverExpired();
      const row = this.db.prepare(`SELECT j.* FROM jobs j JOIN selections s ON s.id=j.selection_id
        WHERE j.status='queued' ${notebookId ? 'AND s.notebook_id=?' : ''} ORDER BY j.created_at,j.rowid LIMIT 1`).get(...(notebookId ? [notebookId] : []));
      if (!row) { this.db.exec('COMMIT'); return null; }
      const token = randomUUID();
      this.db.prepare("UPDATE jobs SET status='processing',worker_id=?,claim_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?")
        .run(workerId, token, Date.now() + this.leaseMs, new Date().toISOString(), row.id);
      this.db.exec('COMMIT');
      const job = this.job(row.id);
      const selection = this.selection(job.selection_id);
      return { ...job, selection, notebook: this.notebook(selection.notebook_id) };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  assertClaim(job, token) {
    if (job.status !== 'processing' || job.claim_token !== token || job.lease_until <= Date.now()) {
      throw new BenchError('This job is no longer claimed by you. Fetch a fresh job; do not submit an old answer.', 409);
    }
  }
  complete(id, token, content, format) {
    if (this.job(id).requested_format === 'image') throw new BenchError('Use submit_image for Visual answers, or fail_job if image generation is unavailable.');
    const job = this.job(id);
    if (job.status === 'completed' && job.claim_token === token && job.content === content && job.format === format) return this.publicJob(job);
    this.assertClaim(job, token);
    this.db.prepare("UPDATE jobs SET status='completed',content=?,format=?,error=NULL,updated_at=? WHERE id=?")
      .run(content, format, new Date().toISOString(), id);
    return this.publicJob(this.job(id));
  }
  completeImage(id, token, bytes, alt) {
    const job = this.job(id);
    if (job.requested_format !== 'image') throw new BenchError('This question did not request an image.');
    const existing = this.db.prepare('SELECT * FROM answer_images WHERE job_id=?').get(id);
    if (job.status === 'completed' && job.claim_token === token && existing && Buffer.from(existing.bytes).equals(bytes) && existing.alt === alt) return this.publicJob(job);
    this.assertClaim(job, token);
    const imageId = randomUUID();
    const safeAlt = alt.replace(/[\[\]\r\n]/g,' ').trim() || 'Visual explanation';
    const content = '![' + safeAlt + '](/api/images/' + imageId + ')';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO answer_images(id,job_id,bytes,alt) VALUES(?,?,?,?)').run(imageId,id,bytes,alt);
      this.db.prepare("UPDATE jobs SET status='completed',content=?,format='markdown',error=NULL,updated_at=? WHERE id=?").run(content,new Date().toISOString(),id);
      this.db.exec('COMMIT'); return this.publicJob(this.job(id));
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  answerImage(id) {
    const image = this.db.prepare('SELECT bytes FROM answer_images WHERE id=?').get(id);
    if (!image) throw new BenchError('Image not found.',404);
    return Buffer.from(image.bytes);
  }
  renew(id, token) {
    const job = this.job(id);
    this.assertClaim(job, token);
    const until = Date.now() + this.leaseMs;
    this.db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(until, id);
    return { job_id: id, lease_until: until };
  }
  fail(id, token, error) {
    const job = this.job(id);
    this.assertClaim(job, token);
    this.db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?").run(error, new Date().toISOString(), id);
    return this.publicJob(this.job(id));
  }
  retry(id) {
    const job = this.job(id);
    if (!['failed', 'cancelled'].includes(job.status)) throw new BenchError('Only failed or cancelled jobs can be retried.', 409);
    this.db.prepare("UPDATE jobs SET status='queued',claim_token=NULL,worker_id=NULL,lease_until=NULL,error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    return this.publicJob(this.job(id));
  }
  cancel(id) {
    const job = this.job(id);
    if (!['queued', 'processing'].includes(job.status)) throw new BenchError('This job is already finished.', 409);
    this.db.prepare("UPDATE jobs SET status='cancelled',claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    return this.publicJob(this.job(id));
  }
  saveNote(selectionId, jobId) {
    this.selection(selectionId);
    const job = jobId ? this.job(jobId) : null;
    if (job && (job.selection_id !== selectionId || job.status !== 'completed')) throw new BenchError('Choose a completed explanation for this highlight.');
    this.db.prepare(`INSERT INTO notes(id,selection_id,job_id,content,format,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(selection_id) DO NOTHING`)
      .run(randomUUID(), selectionId, jobId || null, job?.content ?? null, job?.format ?? null, new Date().toISOString());
    const saved = this.db.prepare('SELECT * FROM notes WHERE selection_id=?').get(selectionId);
    if (saved.job_id) this.db.prepare('INSERT OR IGNORE INTO note_answers(note_id,job_id) VALUES(?,?)').run(saved.id,saved.job_id);
    return this.publicNote(saved);
  }
  publicNote(row) { const { page_image, ...note } = row; return { ...note, has_page_image: Boolean(page_image || note.has_page_image) }; }
  addAnswerToNote(selectionId, jobId) {
    const job = this.job(jobId);
    if (job.selection_id !== selectionId || job.status !== 'completed') throw new BenchError('Choose an answer for this passage.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const note = this.saveNote(selectionId);
      if (!this.db.prepare('SELECT 1 FROM note_answers WHERE note_id=? AND job_id=?').get(note.id,jobId)) {
        const asMarkdown = (content, format) => ['mermaid','code'].includes(format) ? `\`\`\`${format === 'mermaid' ? 'mermaid' : ''}\n${content}\n\`\`\`` : content;
        const content = note.content ? `${asMarkdown(note.content,note.format)}\n\n---\n\n${asMarkdown(job.content,job.format)}` : job.content;
        this.db.prepare('UPDATE notes SET content=?,format=?,job_id=? WHERE id=?').run(content,note.content ? 'markdown' : job.format,jobId,note.id);
        this.db.prepare('INSERT INTO note_answers(note_id,job_id) VALUES(?,?)').run(note.id,jobId);
      }
      const saved = this.publicNote(this.db.prepare('SELECT * FROM notes WHERE id=?').get(note.id));
      this.db.exec('COMMIT'); return saved;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  keepHighlight(notebookId, data, selectionId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const selection = selectionId ? this.selection(selectionId) : this.createSelection(notebookId, data);
      if (selection.notebook_id !== notebookId || selection.kind !== 'passage') throw new BenchError('Choose a highlight in this notebook.');
      const note = this.saveNote(selection.id); this.db.exec('COMMIT'); return { selection, note };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  savePage(notebookId, page, text, image) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const selection = this.createSelection(notebookId, { page, text: text || `[Page ${page} — image only]`, context: text, start_offset: 0, rects: [], kind: 'page' });
      const note = this.saveNote(selection.id);
      this.db.prepare('UPDATE notes SET page_image=COALESCE(page_image,?) WHERE id=?').run(image, note.id);
      const saved = this.publicNote(this.db.prepare('SELECT * FROM notes WHERE id=?').get(note.id));
      this.db.exec('COMMIT'); return { selection, note: saved };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  noteImage(id) {
    const row = this.db.prepare('SELECT page_image FROM notes WHERE id=?').get(id);
    if (!row?.page_image) throw new BenchError('Page image not found.', 404);
    return Buffer.from(row.page_image);
  }
  deleteNote(id) {
    if (!this.db.prepare('DELETE FROM notes WHERE id=?').run(id).changes) throw new BenchError('Note not found.', 404);
  }
  editNote(id, content, format) {
    const result = this.db.prepare('UPDATE notes SET content=?,format=?,edited_at=? WHERE id=?').run(content, format, new Date().toISOString(), id);
    if (!result.changes) throw new BenchError('Note not found.', 404);
    return this.publicNote(this.db.prepare('SELECT * FROM notes WHERE id=?').get(id));
  }
  state(notebookId) {
    this.recoverExpired();
    const notebook = this.notebook(notebookId);
    const selections = this.db.prepare('SELECT * FROM selections WHERE notebook_id=? ORDER BY page,start_offset,created_at,id').all(notebookId)
      .map(s => ({ ...s, rects: JSON.parse(s.rects) }));
    const jobs = this.db.prepare('SELECT j.* FROM jobs j JOIN selections s ON s.id=j.selection_id WHERE s.notebook_id=? ORDER BY j.created_at,j.rowid').all(notebookId)
      .map(j => this.publicJob(j));
    const notes = this.db.prepare(`SELECT n.id,n.selection_id,n.job_id,n.content,n.format,n.created_at,n.edited_at,(n.page_image IS NOT NULL) AS has_page_image,s.page,s.start_offset,s.text,s.notebook_id,s.kind FROM notes n JOIN selections s ON s.id=n.selection_id
      WHERE s.notebook_id=? ORDER BY s.page,s.start_offset,s.created_at,s.id`).all(notebookId).map(n => this.publicNote(n));
    return { notebook, selections, jobs, notes, worker: this.workerStatus(notebookId) };
  }
  beginWait(workerId, notebookId) {
    const token = randomUUID();
    this.activeWaits.set(token, { workerId, notebookId });
    return token;
  }
  endWait(token) { this.activeWaits.delete(token); }
  workerStatus(notebookId) {
    const active = this.db.prepare(`SELECT j.worker_id,w.seen_at FROM jobs j JOIN selections s ON s.id=j.selection_id
      JOIN workers w ON w.id=j.worker_id WHERE j.status='processing' AND j.lease_until>? AND w.running=1
      ${notebookId ? 'AND s.notebook_id=?' : ''} ORDER BY j.updated_at DESC LIMIT 1`).get(Date.now(), ...(notebookId ? [notebookId] : []));
    if (active) return { state:'processing',worker_id:active.worker_id,last_seen:active.seen_at,evidence:'job_claim' };
    for (const wait of this.activeWaits.values()) {
      if (notebookId && wait.notebookId && wait.notebookId !== notebookId) continue;
      const worker = this.workerSession(wait.workerId);
      if (worker?.running) return { state:'waiting',worker_id:wait.workerId,evidence:'live_request' };
    }
    return { state:'offline',worker_id:null,evidence:'no_live_request' };
  }
}
