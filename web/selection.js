// Measure selected text nodes, rather than element rectangles: positioned PDF
// spans can otherwise contribute duplicate or page-sized selection boxes.
export function capturePdfSelection(selection, pages) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const layer = element?.closest('.textLayer');
  if (!layer || !pages.contains(layer)) return null;
  if (!layer.contains(range.endContainer)) throw new Error('Select text within one page at a time.');
  const stage = layer.closest('.page-stage'); const pageBox = stage.getBoundingClientRect();
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const pieces = []; const boxes = []; let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent || !range.intersectsNode(node)) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (end <= start) continue;
    const part = document.createRange(); part.setStart(node, start); part.setEnd(node, end);
    const rects = [...part.getClientRects()].filter(r => r.width > .2 && r.height > .2);
    if (!rects.length) continue;
    const text = node.textContent.slice(start, end); const box = rects[0];
    const previous = pieces.at(-1);
    const newLine = previous && Math.abs(box.top-previous.box.top) > Math.min(box.height,previous.box.height)*.45;
    const gap = previous && box.left-previous.box.right > 1;
    pieces.push({ text: `${previous ? newLine ? '\n' : gap && !/\s$/.test(previous.text) && !/^\s/.test(text) ? ' ' : '' : ''}${text}`, box });
    boxes.push(...rects);
  }
  const text = pieces.map(p => p.text).join('').trim();
  if (!text || !boxes.length) return null;
  if (text.length > 100_000) throw new Error('Select a shorter passage.');
  boxes.sort((a,b) => Math.abs(a.top-b.top) > 2 ? a.top-b.top : a.left-b.left);
  const merged = [];
  for (const box of boxes) {
    const left = Math.max(pageBox.left,box.left), right = Math.min(pageBox.right,box.right);
    const top = Math.max(pageBox.top,box.top), bottom = Math.min(pageBox.bottom,box.bottom);
    if (right <= left || bottom <= top) continue;
    const last = merged.at(-1);
    if (last && Math.abs(last.top-top) < 2 && Math.abs(last.bottom-bottom) < 3 && left <= last.right+3) last.right = Math.max(last.right,right);
    else merged.push({ left,right,top,bottom });
  }
  const rects = merged.map(r => ({ x:(r.left-pageBox.left)/pageBox.width, y:(r.top-pageBox.top)/pageBox.height, width:(r.right-r.left)/pageBox.width, height:(r.bottom-r.top)/pageBox.height }));
  if (!rects.length) return null;
  const before = document.createRange(); before.selectNodeContents(layer); before.setEnd(range.startContainer,range.startOffset);
  return { selection: { page:Number(stage.dataset.page),start_offset:before.toString().length,text,context:layer.textContent.slice(0,100_000),rects,kind:'passage' }, bounds:range.getBoundingClientRect() };
}
