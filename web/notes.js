export const noteInitialValue = note => note.content ?? note.text ?? '';
export const noteInitialFormat = note => note.format || (note.content == null ? 'text' : 'markdown');

export function renderNotesWorkspace({ state,root,escape,icon,icons,renderRich }) {
  root.innerHTML = state.data.notes.length ? state.data.notes.map((note,index) => {
    const editing = state.editingNote === note.id;
    const source = note.kind === 'page' ? `${note.has_page_image ? `<img class="page-note-image" src="/api/notes/${note.id}/page-image" alt="Saved snapshot of page ${note.page}" loading="lazy">` : ''}<details class="page-source-text"><summary>Original page text</summary><pre>${escape(note.text)}</pre></details>` : `<details class="note-original-source"><summary>Original passage</summary><blockquote class="note-source-quote">${escape(note.text)}</blockquote></details>`;
    return `<article class="workspace-note ${editing ? 'editing' : ''}" id="note-${note.id}"><div class="workspace-note-meta"><span class="note-number">${String(index+1).padStart(2,'0')}</span><button class="page-link" data-note-source="${note.selection_id}">PAGE ${note.page} ↗${note.kind === 'page' ? ' · WHOLE PAGE' : ''}</button><span class="note-edit-state">${note.edited_at ? 'Edited by you' : 'Saved from your reading'}</span><div class="note-tools"><button class="text-button" data-append-note="${note.id}">${icon('Plus')} Append</button><button class="text-button note-edit-button" data-edit-note="${note.id}">${icon('NotebookPen')} Edit</button><button class="text-button note-delete-button" data-delete-note="${note.id}">${icon('Trash2')} Delete</button></div></div>${source}<div class="rich-content workspace-note-content inline-note-editor" contenteditable="true" role="textbox" aria-label="Note content" aria-multiline="true" spellcheck="false" data-inline-note="${note.id}" data-placeholder="Click here to add your thoughts…"></div><div class="inline-note-actions ${editing ? '' : 'hidden'}" data-note-actions="${note.id}"><span class="inline-edit-hint">${['mermaid','code'].includes(note.format) ? 'Edit the source here' : 'Editing in place'}</span><button class="button secondary" data-cancel-edit="${note.id}">Cancel</button><button class="button primary" data-save-edit="${note.id}">${icon('Check')} Save</button></div></article>`;
  }).join('') : `<div class="notes-empty"><span class="empty-symbol">${icon('NotebookPen')}</span><h3>Your notes</h3><p>Highlight text or save a page while reading.</p><button class="button secondary" data-return-reader>${icon('BookOpen')} Back to Reader</button></div>`;
  icons(root);
  for (const note of state.data.notes) {
    const editor = root.querySelector(`[data-inline-note="${note.id}"]`);
    const draft = state.noteDrafts.get(note.id); const content = draft?.content ?? noteInitialValue(note); const format = draft?.format || noteInitialFormat(note);
    if (state.editingNote === note.id && ['mermaid','code','text'].includes(format)) { editor.textContent = content; editor.classList.add('plain-editing'); }
    else if (content) renderRich(editor,content,format);
  }
}
