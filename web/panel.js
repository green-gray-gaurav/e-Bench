const answeringDots = '<span class="answering-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
export function renderExplanationPanel({ state, root, styles, escape, icon, icons, renderRich }) {
  document.querySelectorAll('[data-tab]').forEach(button => {
    const active = button.dataset.tab === state.tab; button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active));
  });
  const labels = { queued:'Waiting for an answer',processing:'Being answered',completed:'Answer ready',failed:'Couldn’t answer',cancelled:'Cancelled' };
  const disconnected = state.data.worker?.state === 'offline';
  const statusLabel = job => job.status === 'queued' ? (disconnected ? (job.attempts > 0 ? 'Answer interrupted. Question saved for reconnection.' : 'Codex is disconnected. Your question is saved.') : 'Waiting for Codex to pick this up.') : labels[job.status];
  const connectAction = job => job.status === 'queued' && disconnected ? '<button class="text-button" data-connect-codex>Connect Codex</button>' : '';
  const modes = `<div class="explanation-styles" role="group" aria-label="Explanation style">${Object.entries(styles).map(([key,style]) => `<button data-style="${key}" data-request-style="${key}" class="${!state.choosingStyle && state.style === key ? 'active' : ''}" ${state.busy ? 'disabled' : ''}>${style.label}</button>`).join('')}</div>`;
  let answer;
  if (state.tab === 'questions') {
    root.innerHTML = state.data.jobs.length ? [...state.data.jobs].reverse().map(job => {
      const selection = state.data.selections.find(s => s.id === job.selection_id);
      const title = job.question || (selection?.kind === 'page' ? `Explain page ${selection.page}` : selection?.text || 'Explain this text');
      return `<article class="question-card"><button class="question-title" data-job="${job.id}">${escape(title.slice(0,350))}</button><div class="question-meta"><span>Page ${selection?.page} · ${styles[job.style]?.label || 'Detailed'}</span><span class="status-badge ${job.status}">${job.status === 'processing' ? answeringDots : ''}${statusLabel(job)}</span></div>${job.error ? `<p class="job-error">${escape(job.error)}</p>` : ''}<div class="question-actions">${connectAction(job)}${job.status === 'completed' ? `<button class="text-button" data-job="${job.id}">Read answer ${icon('ArrowRight')}</button>` : ['queued','processing'].includes(job.status) ? `<button class="text-button muted" data-cancel="${job.id}">Cancel question</button>` : `<button class="text-button" data-retry="${job.id}">Try again</button>`}</div></article>`;
    }).join('') : '<p class="simple-empty">Your questions and answers will appear here.</p>';
  } else {
    const selection = state.selection;
    const jobs = state.data.jobs.filter(j => j.selection_id === selection?.id);
    const job = jobs.find(j => j.id === state.activeJob) || jobs.at(-1);
    root.innerHTML = `<div class="answer-source"><span class="section-label">${selection?.kind === 'passage' ? 'SELECTED TEXT' : 'CURRENT PAGE'} · ${selection?.page || state.page}</span>${selection?.kind === 'passage' ? `<blockquote>${escape(selection.text.slice(0,700))}${selection.text.length > 700 ? '…' : ''}</blockquote>` : ''}</div>${modes}`;
    if (job?.question) root.innerHTML += `<p class="answer-question">${escape(job.question)}</p>`;
    if (!job) root.innerHTML += '<p class="simple-empty">Choose how you’d like it explained, or ask your own question.</p>';
    else if (job.status === 'completed') {
      root.innerHTML += `<div id="answer-content" class="rich-content"></div><button class="button secondary full-width" data-save-answer="${job.id}">${icon('NotebookPen')} Save answer to Notes</button>`;
      answer = job;
    } else if (['queued','processing'].includes(job.status)) root.innerHTML += `<div class="simple-status ${job.status}" role="status" aria-live="polite">${job.status === 'processing' ? answeringDots : '<span class="waiting-dot" aria-hidden="true"></span>'}<span>${statusLabel(job)}</span></div>`;
    else if (job.status === 'failed') root.innerHTML += `<p class="job-error">${escape(job.error)}</p><button class="text-button" data-retry="${job.id}">Try again</button>`;
    else root.innerHTML += '<p class="simple-empty">This question was cancelled.</p>';
    if (job?.status === 'queued' || job?.status === 'processing') root.innerHTML += `<div class="question-actions pending-question-actions">${connectAction(job)}<button class="text-button muted" data-cancel="${job.id}">Cancel question</button></div>`;
  }
  icons(root);
  if (answer) renderRich(root.querySelector('#answer-content'),answer.content,answer.format);
}
