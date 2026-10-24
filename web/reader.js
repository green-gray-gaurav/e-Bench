import { TextLayer } from 'pdfjs-dist';

// Keep page placeholders, but render only the neighborhood of the visible page.
// This keeps continuous scrolling practical for books with hundreds of pages.
export class PdfReader {
  constructor({ root, pages, onPageChange, onError }) {
    Object.assign(this, { root, pages, onPageChange, onError });
    this.document = null; this.currentPage = 1; this.direction = 'vertical'; this.zoom = 1;
    this.generation = 0; this.rendered = new Map(); this.visible = new Set(); this.selections = [];
    this.selectionLocked = false;
    this.root.addEventListener('scroll', () => {
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => { this.scrollFrame = null; this.trackPage(); });
    }, { passive: true });
    this.root.addEventListener('wheel', event => {
      if (this.direction !== 'horizontal' || event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? this.root.clientWidth : 1);
      if ((delta > 0 && this.root.scrollLeft < this.root.scrollWidth-this.root.clientWidth-1) || (delta < 0 && this.root.scrollLeft > 0)) {
        event.preventDefault(); this.root.scrollBy({ left: delta });
      }
    }, { passive: false });
  }
  clear() {
    this.generation++;
    this.lazyObserver?.disconnect(); this.pageObserver?.disconnect();
    for (const entry of this.rendered.values()) { entry.task?.cancel(); entry.text?.cancel(); }
    this.rendered.clear(); this.visible.clear(); this.pages.replaceChildren(); this.document = null;
  }
  async open(document, page = 1) {
    this.clear(); this.document = document; this.currentPage = page;
    const first = await document.getPage(page);
    this.baseSize = first.getViewport({ scale: 1 });
    await this.layout({ page, preserveOffset: false });
  }
  size(page) {
    const base = page ? page.getViewport({ scale: 1 }) : this.baseSize;
    const width = Math.max(180, this.root.clientWidth - 48);
    const height = Math.max(180, this.root.clientHeight - 48);
    const scale = Math.min(width/base.width, this.direction === 'horizontal' ? height/base.height : 1.5, 1.5) * this.zoom;
    return { width: base.width*scale, height: base.height*scale, scale };
  }
  setSize(slot, size) {
    const stage = slot.querySelector('.page-stage');
    stage.style.width = `${size.width}px`; stage.style.height = `${size.height}px`;
    slot.style.width = `${this.direction === 'horizontal' ? Math.max(size.width, this.root.clientWidth-48) : size.width}px`;
    slot.style.height = `${this.direction === 'horizontal' ? Math.max(size.height, this.root.clientHeight-48) : size.height}px`;
  }
  async layout({ page = this.currentPage, preserveOffset = true } = {}) {
    if (!this.document || !this.root.clientWidth || !this.root.clientHeight) return;
    const old = this.pages.querySelector(`[data-page="${page}"]`);
    const oldBounds = old?.getBoundingClientRect(); const bounds = this.root.getBoundingClientRect();
    const fraction = preserveOffset && oldBounds && this.direction === 'vertical' ? Math.max(0, Math.min(.95, (bounds.top-oldBounds.top)/oldBounds.height)) : 0;
    const document = this.document; const base = this.baseSize;
    this.clear(); this.document = document; this.baseSize = base; this.currentPage = page;
    const generation = this.generation; const size = this.size();
    this.root.classList.toggle('horizontal-reading', this.direction === 'horizontal');
    this.pages.classList.toggle('horizontal', this.direction === 'horizontal');
    const fragment = window.document.createDocumentFragment();
    for (let number = 1; number <= document.numPages; number++) {
      const slot = window.document.createElement('div'); slot.className = 'pdf-page-slot'; slot.dataset.page = number;
      slot.setAttribute('aria-label', `Page ${number}`);
      slot.innerHTML = `<div class="page-stage" data-page="${number}"><span class="page-placeholder">Page ${number}</span></div>`;
      this.setSize(slot, size); fragment.append(slot);
    }
    this.pages.append(fragment);
    const target = this.pages.children[page-1];
    this.root.scrollTo({ left: this.direction === 'horizontal' ? target.offsetLeft : 0, top: this.direction === 'vertical' ? target.offsetTop+fraction*size.height : 0, behavior: 'instant' });
    this.lazyObserver = new IntersectionObserver(entries => {
      if (generation !== this.generation) return;
      for (const entry of entries) if (entry.isIntersecting) void this.render(Number(entry.target.dataset.page));
    }, { root: this.root, rootMargin: this.direction === 'horizontal' ? '0px 100% 0px 100%' : '100% 0px 100% 0px' });
    this.pageObserver = new IntersectionObserver(entries => {
      if (generation !== this.generation) return;
      for (const entry of entries) if (entry.isIntersecting) this.visible.add(entry.target); else this.visible.delete(entry.target);
      if (generation === this.generation) this.trackPage();
    }, { root: this.root, threshold: [0, .1, .25, .5, .75, 1] });
    for (const slot of this.pages.children) { this.lazyObserver.observe(slot); this.pageObserver.observe(slot); }
    await this.render(page);
  }
  async render(number) {
    if (!this.document) return;
    if (this.rendered.has(number)) return this.rendered.get(number).promise;
    const generation = this.generation; const document = this.document;
    const slot = this.pages.children[number-1]; if (!slot) return;
    const stage = slot.querySelector('.page-stage'); const entry = {};
    this.rendered.set(number, entry);
    entry.promise = (async () => {
      try {
        const page = await document.getPage(number);
        if (generation !== this.generation || this.rendered.get(number) !== entry || !slot.isConnected) return;
        const size = this.size(page); const viewport = page.getViewport({ scale: size.scale });
        this.setSize(slot, size);
        stage.style.setProperty('--scale-factor', size.scale); stage.style.setProperty('--user-unit', page.userUnit || 1); stage.style.setProperty('--total-scale-factor', size.scale*(page.userUnit || 1));
        stage.innerHTML = '<canvas class="pdf-canvas"></canvas><div class="highlight-layer"></div><div class="textLayer"></div>';
        const canvas = stage.querySelector('canvas'); const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width*ratio); canvas.height = Math.floor(viewport.height*ratio);
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
        entry.task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio,0,0,ratio,0,0] });
        await entry.task.promise;
        if (generation !== this.generation || this.rendered.get(number) !== entry) return;
        const content = await page.getTextContent();
        if (generation !== this.generation || this.rendered.get(number) !== entry) return;
        entry.hasText = content.items.some(item => item.str?.trim());
        entry.text = new TextLayer({ textContentSource: content, container: stage.querySelector('.textLayer'), viewport });
        await entry.text.render();
        if (generation !== this.generation || this.rendered.get(number) !== entry) return;
        const layer = stage.querySelector('.textLayer'); layer.tabIndex = 0; layer.setAttribute('aria-label',`Selectable text on page ${number}`);
        const end = window.document.createElement('div'); end.className = 'endOfContent'; layer.append(end);
        this.drawPage(number); this.evict();
        if (number === this.currentPage) this.onPageChange(number, entry.hasText);
      } catch (error) {
        if (generation !== this.generation || ['RenderingCancelledException', 'AbortException'].includes(error.name)) return;
        stage.replaceChildren(); const message = window.document.createElement('div'); message.className = 'page-placeholder'; message.textContent = `Page ${number} could not be rendered.`; stage.append(message);
        this.onError(error);
      }
    })();
    return entry.promise;
  }
  evict() {
    if (this.selectionLocked) return;
    if (this.rendered.size <= 7) return;
    for (const [number, entry] of this.rendered) {
      if (Math.abs(number-this.currentPage) <= 3 || this.visible.has(this.pages.children[number-1])) continue;
      entry.task?.cancel(); entry.text?.cancel();
      const stage = this.pages.children[number-1]?.querySelector('.page-stage');
      if (stage) stage.innerHTML = `<span class="page-placeholder">Page ${number}</span>`;
      this.rendered.delete(number);
    }
  }
  trackPage() {
    if (!this.document || !this.root.clientWidth || !this.root.clientHeight) return;
    const bounds = this.root.getBoundingClientRect(); let best, largest = 0;
    for (const slot of this.visible) {
      const box = slot.getBoundingClientRect();
      const area = Math.max(0, Math.min(box.right,bounds.right)-Math.max(box.left,bounds.left))*Math.max(0,Math.min(box.bottom,bounds.bottom)-Math.max(box.top,bounds.top));
      if (area > largest) { largest = area; best = slot; }
    }
    if (best) {
      const number = Number(best.dataset.page);
      if (number !== this.currentPage) { this.currentPage = number; this.onPageChange(number, this.rendered.get(number)?.hasText); this.evict(); }
    }
  }
  async jump(page) {
    const slot = this.pages.children[page-1]; if (!slot) return;
    this.currentPage = page;
    this.root.scrollTo({ left: this.direction === 'horizontal' ? slot.offsetLeft : 0, top: this.direction === 'vertical' ? slot.offsetTop : 0, behavior: 'instant' });
    this.onPageChange(page, this.rendered.get(page)?.hasText); await this.render(page);
  }
  setHighlights(selections, selectedId) {
    this.selections = selections; this.selectedId = selectedId;
    for (const number of this.rendered.keys()) this.drawPage(number);
  }
  drawPage(number) {
    const layer = this.pages.children[number-1]?.querySelector('.highlight-layer'); if (!layer) return;
    layer.innerHTML = this.selections.filter(s => s.page === number).flatMap(s => s.rects.map(r => `<span class="pdf-highlight ${s.id === this.selectedId ? 'active' : ''}" style="left:${r.x*100}%;top:${r.y*100}%;width:${r.width*100}%;height:${r.height*100}%"></span>`)).join('');
  }
  async pageContent(number = this.currentPage, withImage = false) {
    if (!this.document) throw new Error('Open a PDF first.');
    const document = this.document;
    const page = await document.getPage(number); const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
    text = text.trim();
    if (text.length > 100_000) throw new Error('This page has too much text to save in one note. Select a passage instead.');
    let image;
    if (withImage) {
      const base = page.getViewport({ scale: 1 }); const viewport = page.getViewport({ scale: Math.min(1400/base.width,1800/base.height,2) });
      const canvas = window.document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext:canvas.getContext('2d'),viewport }).promise;
      image = canvas.toDataURL('image/jpeg',.82); canvas.width = canvas.height = 0;
    }
    if (document !== this.document) throw new Error('The book changed. Please try again.');
    return { page:number,text,image };
  }
}
