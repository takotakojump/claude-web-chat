const elements = {
  messages: document.getElementById('messages'),
  emptyState: document.getElementById('emptyState'),
  interactionHost: document.getElementById('interactionHost'),
  composer: document.getElementById('composer'),
  promptInput: document.getElementById('promptInput'),
  sendButton: document.getElementById('sendButton'),
  newChatButton: document.getElementById('newChatButton'),
  startButton: document.getElementById('startButton'),
  interruptButton: document.getElementById('interruptButton'),
  logoutButton: document.getElementById('logoutButton'),
  refreshSessionsButton: document.getElementById('refreshSessionsButton'),
  clearSessionsButton: document.getElementById('clearSessionsButton'),
  sessionList: document.getElementById('sessionList'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  mobileStatus: document.getElementById('mobileStatus'),
  modelText: document.getElementById('modelText'),
  sessionText: document.getElementById('sessionText'),
  apiText: document.getElementById('apiText'),
  cwdText: document.getElementById('cwdText'),
  sidebar: document.getElementById('sidebar'),
  menuButton: document.getElementById('menuButton'),
  closeMenuButton: document.getElementById('closeMenuButton'),
  mobileBackdrop: document.getElementById('mobileBackdrop'),
};

const INSTANCE_ID = getClientInstanceId();
const messages = new Map();
const interactions = new Map();
let currentState = {};
let eventSource = null;

connectEvents();
wireUi();
resizeTextarea();

function connectEvents() {
  eventSource = new EventSource(`/api/events?instance=${encodeURIComponent(INSTANCE_ID)}`);

  eventSource.addEventListener('snapshot', event => {
    const snapshot = JSON.parse(event.data);
    resetUi();
    updateStatus(snapshot.state || {});
    for (const item of snapshot.events || []) applyEvent(item);
    for (const interaction of snapshot.pendingInteractions || []) renderInteraction(interaction);
    scrollMessages();
    refreshSessions();
  });

  eventSource.addEventListener('event', event => {
    applyEvent(JSON.parse(event.data));
  });

  eventSource.addEventListener('error', () => {
    updateStatus({ ...currentState, status: 'reconnecting' });
    fetch('/api/auth/status')
      .then(response => response.json())
      .then(status => {
        if (status.authEnabled && !status.authenticated) {
          location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
        }
      })
      .catch(() => {});
  });
}

function wireUi() {
  elements.composer.addEventListener('submit', async event => {
    event.preventDefault();
    await sendPrompt();
  });

  elements.promptInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.composer.requestSubmit();
    }
  });

  elements.promptInput.addEventListener('input', resizeTextarea);

  elements.messages.addEventListener('click', event => {
    const button = event.target.closest('[data-prompt]');
    if (!button) return;
    elements.promptInput.value = button.dataset.prompt || '';
    resizeTextarea();
    elements.promptInput.focus();
  });

  elements.sessionList.addEventListener('click', async event => {
    const loadButton = event.target.closest('[data-session-load]');
    const deleteButton = event.target.closest('[data-session-delete]');
    try {
      if (loadButton) await loadSession(loadButton.dataset.sessionLoad);
      if (deleteButton) await deleteSession(deleteButton.dataset.sessionDelete);
    } catch (error) {
      renderSystem({ level: 'error', text: error.message });
    }
  });

  elements.newChatButton.addEventListener('click', async () => {
    if (!confirm('开始新对话？当前网页里的消息会清空，Claude CLI 会重启。')) return;
    await postJson('/api/restart', {});
    await refreshSessions();
    closeMobileMenu();
  });

  elements.startButton.addEventListener('click', async () => {
    await postJson('/api/start', {});
    closeMobileMenu();
  });

  elements.interruptButton.addEventListener('click', async () => {
    await postJson('/api/interrupt', {});
    closeMobileMenu();
  });

  elements.logoutButton.addEventListener('click', async () => {
    await postJson('/api/logout', {});
    location.href = '/login';
  });

  elements.refreshSessionsButton.addEventListener('click', () => {
    refreshSessions();
  });

  elements.clearSessionsButton.addEventListener('click', async () => {
    if (!confirm('Clear all Claude sessions for the current project? This cannot be undone.')) return;
    await postJson('/api/sessions/clear', {});
    await refreshSessions();
  });

  elements.menuButton.addEventListener('click', toggleMobileMenu);
  elements.closeMenuButton.addEventListener('click', closeMobileMenu);
  elements.mobileBackdrop.addEventListener('click', closeMobileMenu);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMobileMenu();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 920) closeMobileMenu();
  });
}

function applyEvent(event) {
  const { type, payload } = event;
  switch (type) {
    case 'reset':
      resetUi();
      break;
    case 'state':
      updateStatus(payload);
      break;
    case 'message_new':
      ensureMessage(payload);
      break;
    case 'message_delta':
      appendMessageText(payload.id, payload.text || '');
      break;
    case 'message_replace':
      replaceMessage(payload);
      break;
    case 'message_patch':
      patchMessage(payload);
      break;
    case 'tool_use':
      addToolBlock(payload.id, payload);
      break;
    case 'thinking_delta':
      appendThinking(payload.id, payload.text || '');
      break;
    case 'tool_input_delta':
      appendToolInputDelta(payload.id, payload);
      break;
    case 'interaction_new':
      renderInteraction(payload);
      break;
    case 'interaction_resolved':
      resolveInteraction(payload);
      break;
    case 'system':
      renderSystem(payload);
      break;
    case 'result':
      renderResult(payload);
      break;
    case 'rate_limit':
      renderSystem({ level: 'warn', text: 'Claude 速率状态更新', detail: summarizeJson(payload.info) });
      break;
    case 'auth_status':
      renderSystem({ level: 'info', text: '认证状态更新', detail: summarizeJson(payload.status) });
      break;
    case 'stderr':
      if (/\berror\b|exception|failed/i.test(payload.text || '')) {
        renderSystem({ level: 'error', text: 'Claude CLI 日志', detail: payload.text });
      }
      break;
    case 'error':
      renderSystem({ level: 'error', text: payload.text || '发生错误' });
      break;
    default:
      break;
  }
}

async function sendPrompt() {
  const text = elements.promptInput.value.trim();
  if (!text) return;

  elements.sendButton.disabled = true;
  try {
    await postJson('/api/send', { text });
    elements.promptInput.value = '';
    resizeTextarea();
  } catch (error) {
    renderSystem({ level: 'error', text: error.message });
  } finally {
    elements.sendButton.disabled = false;
    elements.promptInput.focus();
  }
}

function getClientInstanceId() {
  const key = 'claude-web-chat.instance-id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    const random = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    id = `web-${random.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}

function instanceHeaders(extra = {}) {
  return { ...extra, 'x-cwc-instance': INSTANCE_ID };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: instanceHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && data.authRequired) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Login required');
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}


async function getJson(url) {
  const response = await fetch(url, { headers: instanceHeaders() });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && data.authRequired) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Login required');
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function deleteJson(url) {
  const response = await fetch(url, { method: 'DELETE', headers: instanceHeaders() });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && data.authRequired) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Login required');
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function refreshSessions() {
  if (!elements.sessionList) return;
  try {
    const data = await getJson('/api/sessions');
    renderSessionList(data.sessions || []);
  } catch (error) {
    elements.sessionList.innerHTML = `<p class="muted-small">${escapeHtml(error.message)}</p>`;
  }
}

function renderSessionList(sessions) {
  if (!elements.sessionList) return;
  if (!sessions.length) {
    elements.sessionList.innerHTML = '<p class="muted-small">No Claude sessions found.</p>';
    return;
  }
  elements.sessionList.innerHTML = '';
  for (const session of sessions.slice(0, 50)) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.innerHTML = `
      <div class="session-title">
        <span>${escapeHtml(shortId(session.id))}</span>
        <span>${escapeHtml(formatBytes(session.size || 0))}</span>
      </div>
      <p class="session-preview">${escapeHtml(session.preview || 'No preview')}</p>
      <p class="muted-small">${escapeHtml(formatDate(session.updatedAt))}</p>
      <div class="session-actions">
        <button type="button" data-session-load="${escapeAttribute(session.id)}">Load</button>
        <button type="button" class="danger" data-session-delete="${escapeAttribute(session.id)}">Delete</button>
      </div>
    `;
    elements.sessionList.appendChild(item);
  }
}

async function loadSession(id) {
  await postJson(`/api/sessions/${encodeURIComponent(id)}/load`, {});
  await refreshSessions();
  closeMobileMenu();
}

async function deleteSession(id) {
  if (!confirm(`Delete Claude session ${shortId(id)}? This cannot be undone.`)) return;
  await deleteJson(`/api/sessions/${encodeURIComponent(id)}`);
  await refreshSessions();
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function ensureMessage(data) {
  if (!data || !data.id) return null;
  const existing = messages.get(data.id);
  if (existing) {
    if (data.status) existing.el.dataset.status = data.status;
    return existing;
  }

  hideEmptyState();
  const article = document.createElement('article');
  article.className = `message ${data.role || 'assistant'}`;
  article.dataset.id = data.id;
  article.dataset.status = data.status || '';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = data.role === 'user' ? '你' : 'C';

  const card = document.createElement('div');
  card.className = 'message-card';

  const content = document.createElement('div');
  content.className = 'message-content';
  content.innerHTML = renderMarkdown(data.text || '');

  const blocks = document.createElement('div');
  blocks.className = 'message-blocks';

  card.append(content, blocks);
  article.append(avatar, card);
  elements.messages.appendChild(article);

  const entry = {
    id: data.id,
    role: data.role || 'assistant',
    text: data.text || '',
    el: article,
    contentEl: content,
    blocksEl: blocks,
    thinkingText: '',
    toolJsonText: '',
  };
  messages.set(data.id, entry);

  if (Array.isArray(data.blocks)) renderBlocks(entry, data.blocks);
  scrollMessages();
  return entry;
}

function appendMessageText(id, text) {
  if (!text) return;
  const entry = ensureMessage({ id, role: 'assistant', text: '', status: 'streaming' });
  entry.text += text;
  entry.contentEl.innerHTML = renderMarkdown(entry.text);
  scrollMessages();
}

function replaceMessage(data) {
  const entry = ensureMessage({ id: data.id, role: 'assistant', text: '', status: data.status });
  entry.text = data.text || '';
  entry.contentEl.innerHTML = renderMarkdown(entry.text);
  entry.blocksEl.innerHTML = '';
  renderBlocks(entry, data.blocks || []);
  if (data.status) entry.el.dataset.status = data.status;
  scrollMessages();
}

function patchMessage(data) {
  const entry = messages.get(data.id);
  if (!entry) return;
  if (data.status) entry.el.dataset.status = data.status;
}

function renderBlocks(entry, blocks) {
  for (const block of blocks) {
    if (block.type === 'tool_use') addToolBlock(entry.id, block);
    else if (block.type === 'thinking') addThinkingBlock(entry, block.text || '');
    else if (block.type === 'tool_result') addToolResultBlock(entry, block);
    else addJsonBlock(entry, block.type || 'block', block.value || block);
  }
}

function addToolBlock(messageId, block) {
  const entry = ensureMessage({ id: messageId, role: 'assistant', text: '', status: 'streaming' });
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.toolId = block.toolUseId || block.id || '';
  card.innerHTML = `
    <div class="tool-title">
      <span>工具调用：${escapeHtml(block.name || 'tool')}</span>
      <span>${escapeHtml(block.status || '')}</span>
    </div>
    <pre class="json-view"><code>${escapeHtml(JSON.stringify(block.input || {}, null, 2))}</code></pre>
  `;
  entry.blocksEl.appendChild(card);
  scrollMessages();
}

function addToolResultBlock(entry, block) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML = `
    <div class="tool-title">
      <span>工具结果</span>
      <span>${block.isError ? 'error' : 'ok'}</span>
    </div>
    <pre class="json-view"><code>${escapeHtml(formatBlockContent(block.content))}</code></pre>
  `;
  entry.blocksEl.appendChild(card);
}

function addJsonBlock(entry, title, value) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML = `
    <div class="tool-title"><span>${escapeHtml(title)}</span></div>
    <pre class="json-view"><code>${escapeHtml(JSON.stringify(value, null, 2))}</code></pre>
  `;
  entry.blocksEl.appendChild(card);
}

function appendThinking(id, text) {
  if (!text) return;
  const entry = ensureMessage({ id, role: 'assistant', text: '', status: 'streaming' });
  entry.thinkingText += text;
  let details = entry.blocksEl.querySelector('[data-thinking]');
  if (!details) {
    details = document.createElement('details');
    details.className = 'tool-card';
    details.dataset.thinking = 'true';
    details.innerHTML = '<summary class="tool-title">思考过程</summary><div class="thinking-content"></div>';
    entry.blocksEl.prepend(details);
  }
  details.querySelector('.thinking-content').innerHTML = renderMarkdown(entry.thinkingText);
}

function addThinkingBlock(entry, text) {
  if (!text) return;
  entry.thinkingText += text;
  appendThinking(entry.id, text);
}

function appendToolInputDelta(id, payload) {
  const entry = messages.get(id);
  if (!entry) return;
  entry.toolJsonText += payload.partialJson || '';
  let card = entry.blocksEl.querySelector('[data-tool-json-delta]');
  if (!card) {
    card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolJsonDelta = 'true';
    card.innerHTML = '<div class="tool-title"><span>工具参数流</span></div><pre class="json-view"><code></code></pre>';
    entry.blocksEl.appendChild(card);
  }
  card.querySelector('code').textContent = entry.toolJsonText;
}

function renderSystem(payload) {
  hideEmptyState();
  const row = document.createElement('div');
  row.className = `system-row ${payload.level || 'info'}`;
  const detail = payload.detail ? `<div>${escapeHtml(payload.detail)}</div>` : '';
  row.innerHTML = `<strong>${escapeHtml(payload.text || '系统消息')}</strong>${detail}`;
  elements.messages.appendChild(row);
  scrollMessages();
}

function renderResult(payload) {
  const parts = [];
  if (payload.durationMs) parts.push(`${Math.round(payload.durationMs / 1000)}s`);
  if (payload.costUsd) parts.push(`$${Number(payload.costUsd).toFixed(4)}`);
  if (payload.numTurns) parts.push(`${payload.numTurns} turns`);
  renderSystem({
    level: payload.isError ? 'error' : 'info',
    text: payload.isError ? 'Claude 执行结束但有错误' : 'Claude 回复完成',
    detail: parts.join(' · '),
  });
}

function renderInteraction(data) {
  if (!data || !data.id) return;
  const existing = interactions.get(data.id);
  if (existing) existing.remove();

  const card = document.createElement('article');
  card.className = `interaction-card ${data.kind || 'generic'}`;
  card.dataset.id = data.id;

  const head = document.createElement('div');
  head.className = 'interaction-head';
  head.innerHTML = `
    <div>
      <h3>${escapeHtml(localizeTitle(data))}</h3>
      ${data.description ? `<p>${escapeHtml(data.description)}</p>` : ''}
    </div>
    <span class="pill">需要操作</span>
  `;
  card.appendChild(head);

  if (data.kind === 'permission') renderPermissionBody(card, data);
  else if (data.kind === 'ask_user_question') renderAskUserQuestionBody(card, data);
  else if (data.kind === 'elicitation') renderElicitationBody(card, data);
  else renderGenericBody(card, data);

  elements.interactionHost.appendChild(card);
  interactions.set(data.id, card);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderPermissionBody(card, data) {
  const details = document.createElement('details');
  details.className = 'details-toggle';
  details.innerHTML = `
    <summary>查看工具输入</summary>
    <pre class="json-view"><code>${escapeHtml(JSON.stringify({ input: data.input, suggestions: data.suggestions }, null, 2))}</code></pre>
  `;
  card.appendChild(details);

  const row = document.createElement('div');
  row.className = 'choice-row';
  for (const choice of data.choices || []) {
    const button = choiceButton(choice.action, choice.tone);
    button.addEventListener('click', () => respondFromCard(card, { id: data.id, action: choice.action }));
    row.appendChild(button);
  }
  card.appendChild(row);
}

function renderElicitationBody(card, data) {
  if (data.url) {
    const link = document.createElement('p');
    link.className = 'form-help';
    link.innerHTML = `链接：<a href="${escapeAttribute(data.url)}" target="_blank" rel="noreferrer">${escapeHtml(data.url)}</a>`;
    card.appendChild(link);
  }

  const schema = normalizeSchema(data.schema);
  if (schema) {
    card.appendChild(buildSchemaForm(schema));
  } else {
    const textarea = document.createElement('textarea');
    textarea.className = 'generic-json';
    textarea.dataset.genericJson = 'true';
    textarea.value = '{}';
    card.appendChild(textarea);
  }

  const row = document.createElement('div');
  row.className = 'choice-row';
  for (const choice of data.choices || []) {
    const button = choiceButton(choice.action, choice.tone);
    button.addEventListener('click', () => {
      const payload = { id: data.id, action: choice.action };
      if (choice.action === 'accept') payload.content = collectFormContent(card, schema);
      respondFromCard(card, payload);
    });
    row.appendChild(button);
  }
  card.appendChild(row);
}

function renderAskUserQuestionBody(card, data) {
  const questions = Array.isArray(data.questions) ? data.questions : [];
  if (!questions.length) {
    renderGenericBody(card, data);
    return;
  }

  const form = document.createElement('div');
  form.className = 'ask-form';
  questions.forEach((question, questionIndex) => {
    const section = document.createElement('section');
    section.className = 'ask-question';
    section.dataset.questionIndex = String(questionIndex);

    const heading = document.createElement('div');
    heading.className = 'ask-heading';
    const chip = document.createElement('span');
    chip.textContent = question.header || 'Choice';
    const title = document.createElement('strong');
    title.textContent = question.question || `Question ${questionIndex + 1}`;
    heading.append(chip, title);
    if (question.multiSelect) {
      const hint = document.createElement('em');
      hint.textContent = 'multi-select';
      heading.appendChild(hint);
    }
    section.appendChild(heading);

    const optionGrid = document.createElement('div');
    optionGrid.className = 'ask-options';
    const options = Array.isArray(question.options) ? question.options : [];
    options.forEach((option, optionIndex) => {
      optionGrid.appendChild(createAskOption(data.id, questionIndex, optionIndex, question, option));
    });
    optionGrid.appendChild(createAskOtherOption(data.id, questionIndex, question));
    section.appendChild(optionGrid);

    const notes = document.createElement('textarea');
    notes.className = 'ask-notes';
    notes.dataset.askNotes = 'true';
    notes.placeholder = 'Optional notes for Claude...';
    section.appendChild(notes);
    form.appendChild(section);
  });
  card.appendChild(form);

  const row = document.createElement('div');
  row.className = 'choice-row';
  const submit = choiceButton('answer', 'primary', findInteractionChoiceLabel(data, 'answer', 'Submit answer'));
  submit.addEventListener('click', () => {
    try {
      const payload = collectAskUserQuestionPayload(card, questions);
      respondFromCard(card, { id: data.id, action: 'answer', ...payload });
    } catch (error) {
      alert(error.message);
    }
  });
  const cancel = choiceButton('cancel', 'danger', findInteractionChoiceLabel(data, 'cancel', 'Cancel'));
  cancel.addEventListener('click', () => respondFromCard(card, {
    id: data.id,
    action: 'cancel',
    message: 'User cancelled the question.',
  }));
  row.append(submit, cancel);
  card.appendChild(row);

  const details = document.createElement('details');
  details.className = 'details-toggle';
  details.innerHTML = `
    <summary>View raw request</summary>
    <pre class="json-view"><code>${escapeHtml(JSON.stringify(data.request || {}, null, 2))}</code></pre>
  `;
  card.appendChild(details);
}

function createAskOption(interactionId, questionIndex, optionIndex, question, option) {
  const id = `ask-${interactionId}-${questionIndex}-${optionIndex}`;
  const label = document.createElement('label');
  label.className = 'ask-option';
  label.htmlFor = id;

  const input = document.createElement('input');
  input.type = question.multiSelect ? 'checkbox' : 'radio';
  input.name = `ask-${interactionId}-${questionIndex}`;
  input.id = id;
  input.value = option.label || '';
  input.dataset.askOption = 'true';
  input.dataset.preview = option.preview || '';

  const body = document.createElement('span');
  body.className = 'ask-option-body';
  const title = document.createElement('span');
  title.className = 'ask-option-title';
  title.textContent = option.label || `Option ${optionIndex + 1}`;
  body.appendChild(title);
  if (option.description) {
    const description = document.createElement('span');
    description.className = 'ask-option-description';
    description.textContent = option.description;
    body.appendChild(description);
  }
  if (option.preview) {
    const preview = document.createElement('pre');
    preview.className = 'option-preview';
    preview.textContent = option.preview;
    body.appendChild(preview);
  }
  label.append(input, body);
  return label;
}

function createAskOtherOption(interactionId, questionIndex, question) {
  const id = `ask-${interactionId}-${questionIndex}-other`;
  const label = document.createElement('label');
  label.className = 'ask-option ask-option-other';
  label.htmlFor = id;

  const input = document.createElement('input');
  input.type = question.multiSelect ? 'checkbox' : 'radio';
  input.name = `ask-${interactionId}-${questionIndex}`;
  input.id = id;
  input.value = '__other__';
  input.dataset.askOption = 'true';
  input.dataset.otherOption = 'true';

  const body = document.createElement('span');
  body.className = 'ask-option-body';
  const title = document.createElement('span');
  title.className = 'ask-option-title';
  title.textContent = 'Other';
  const otherInput = document.createElement('input');
  otherInput.type = 'text';
  otherInput.className = 'ask-other-input';
  otherInput.dataset.askOtherText = 'true';
  otherInput.placeholder = 'Type a custom answer';
  otherInput.addEventListener('focus', () => { input.checked = true; });
  body.append(title, otherInput);
  label.append(input, body);
  return label;
}

function collectAskUserQuestionPayload(card, questions) {
  const answers = {};
  const annotations = {};
  questions.forEach((question, questionIndex) => {
    const section = card.querySelector(`[data-question-index="${questionIndex}"]`);
    if (!section) throw new Error('Question form is missing.');
    const selected = question.multiSelect
      ? Array.from(section.querySelectorAll('[data-ask-option]:checked'))
      : [section.querySelector('[data-ask-option]:checked')].filter(Boolean);

    const values = [];
    let preview = '';
    for (const input of selected) {
      if (input.dataset.otherOption) {
        const other = section.querySelector('[data-ask-other-text]');
        const value = String((other && other.value) || '').trim();
        if (value) values.push(value);
      } else {
        values.push(input.value);
        if (!question.multiSelect && input.dataset.preview) preview = input.dataset.preview;
      }
    }
    if (!values.length) throw new Error(`Please answer: ${question.question}`);

    answers[question.question] = question.multiSelect ? values.join(', ') : values[0];
    const notes = String(section.querySelector('[data-ask-notes]')?.value || '').trim();
    const annotation = {};
    if (preview) annotation.preview = preview;
    if (notes) annotation.notes = notes;
    if (Object.keys(annotation).length > 0) annotations[question.question] = annotation;
  });
  return { answers, annotations };
}

function findInteractionChoiceLabel(data, action, fallback) {
  const choice = Array.isArray(data.choices)
    ? data.choices.find(item => item.action === action)
    : null;
  return choice?.label || fallback;
}

function renderGenericBody(card, data) {
  const textarea = document.createElement('textarea');
  textarea.className = 'generic-json';
  textarea.dataset.genericJson = 'true';
  textarea.value = JSON.stringify({}, null, 2);
  card.appendChild(textarea);

  const details = document.createElement('details');
  details.className = 'details-toggle';
  details.innerHTML = `
    <summary>查看原始请求</summary>
    <pre class="json-view"><code>${escapeHtml(JSON.stringify(data.request || {}, null, 2))}</code></pre>
  `;
  card.appendChild(details);

  const row = document.createElement('div');
  row.className = 'choice-row';
  const ok = choiceButton('send_success', 'primary', '发送 JSON 响应');
  ok.addEventListener('click', () => {
    let response = {};
    try {
      response = JSON.parse(textarea.value || '{}');
    } catch (error) {
      alert(`JSON 格式错误：${error.message}`);
      return;
    }
    respondFromCard(card, { id: data.id, action: 'generic', response });
  });
  const cancel = choiceButton('send_error', 'danger', '返回错误');
  cancel.addEventListener('click', () => respondFromCard(card, { id: data.id, action: 'generic', error: 'Cancelled by user.' }));
  row.append(ok, cancel);
  card.appendChild(row);
}

async function respondFromCard(card, payload) {
  const buttons = card.querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; });
  try {
    await postJson('/api/respond', payload);
  } catch (error) {
    alert(error.message);
    buttons.forEach(button => { button.disabled = false; });
  }
}

function resolveInteraction(payload) {
  const card = interactions.get(payload.id);
  if (!card) return;
  card.classList.add('resolved');
  const pill = card.querySelector('.pill');
  if (pill) pill.textContent = payload.label || payload.status || '已处理';
  card.querySelectorAll('button, input, textarea, select').forEach(control => {
    control.disabled = true;
  });
  setTimeout(() => {
    card.remove();
    interactions.delete(payload.id);
  }, 1600);
}

function choiceButton(action, tone, labelOverride) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `choice-button ${tone || 'quiet'}`;
  button.textContent = labelOverride || localizeAction(action);
  return button;
}

function buildSchemaForm(schema) {
  const form = document.createElement('div');
  form.className = 'form-grid';
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);

  for (const [key, fieldSchema] of Object.entries(properties)) {
    const field = document.createElement('div');
    field.className = 'form-field';
    const label = document.createElement('label');
    label.textContent = `${fieldSchema.title || key}${required.has(key) ? ' *' : ''}`;
    label.htmlFor = `field-${key}`;

    const input = createInputForSchema(key, fieldSchema || {});
    input.id = `field-${key}`;
    input.dataset.fieldKey = key;
    input.dataset.fieldType = fieldSchema.type || inferFieldType(fieldSchema);
    if (required.has(key)) input.required = true;

    field.append(label, input);
    if (fieldSchema.description) {
      const help = document.createElement('div');
      help.className = 'form-help';
      help.textContent = fieldSchema.description;
      field.appendChild(help);
    }
    form.appendChild(field);
  }

  if (!Object.keys(properties).length) {
    const help = document.createElement('p');
    help.className = 'form-help';
    help.textContent = '这个请求没有声明字段，将提交空对象。';
    form.appendChild(help);
  }
  return form;
}

function createInputForSchema(key, schema) {
  let input;
  if (Array.isArray(schema.enum)) {
    input = document.createElement('select');
    for (const value of schema.enum) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      input.appendChild(option);
    }
  } else if (schema.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
  } else if (schema.type === 'number' || schema.type === 'integer') {
    input = document.createElement('input');
    input.type = 'number';
    if (schema.type === 'integer') input.step = '1';
  } else if (schema.type === 'object' || schema.type === 'array') {
    input = document.createElement('textarea');
    input.value = JSON.stringify(schema.default ?? (schema.type === 'array' ? [] : {}), null, 2);
    input.dataset.parseJson = 'true';
  } else if ((schema.maxLength && schema.maxLength > 140) || /message|body|text|content/i.test(key)) {
    input = document.createElement('textarea');
  } else {
    input = document.createElement('input');
    input.type = 'text';
  }

  if (schema.default !== undefined && !input.dataset.parseJson) {
    if (input.type === 'checkbox') input.checked = Boolean(schema.default);
    else input.value = String(schema.default);
  }
  input.placeholder = schema.description || schema.title || key;
  return input;
}

function collectFormContent(card, schema) {
  const generic = card.querySelector('[data-generic-json]');
  if (generic) {
    try {
      return JSON.parse(generic.value || '{}');
    } catch (error) {
      alert(`JSON 格式错误：${error.message}`);
      throw error;
    }
  }

  const content = {};
  for (const control of card.querySelectorAll('[data-field-key]')) {
    const key = control.dataset.fieldKey;
    const type = control.dataset.fieldType;
    if (control.dataset.parseJson) {
      content[key] = JSON.parse(control.value || (type === 'array' ? '[]' : '{}'));
    } else if (type === 'boolean') {
      content[key] = control.checked;
    } else if (type === 'number' || type === 'integer') {
      content[key] = control.value === '' ? null : Number(control.value);
    } else {
      content[key] = control.value;
    }
  }
  return content;
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'object' || schema.properties) return schema;
  if (schema.input_schema && typeof schema.input_schema === 'object') return normalizeSchema(schema.input_schema);
  return null;
}

function inferFieldType(schema) {
  if (Array.isArray(schema.enum)) return 'string';
  return 'string';
}

function updateStatus(nextState) {
  currentState = { ...currentState, ...nextState };
  const status = currentState.status || 'idle';
  elements.statusText.textContent = localizeStatus(status);
  elements.mobileStatus.textContent = localizeStatus(status);
  elements.statusDot.className = `status-dot ${status}`;
  elements.modelText.textContent = currentState.model || '自动';
  elements.sessionText.textContent = currentState.sessionId ? shortId(currentState.sessionId) : '-';
  elements.cwdText.textContent = currentState.cwd ? `工作目录：${currentState.cwd}` : '工作目录未知';
}

function resetUi() {
  messages.clear();
  interactions.clear();
  elements.messages.innerHTML = '';
  elements.interactionHost.innerHTML = '';
  elements.messages.appendChild(elements.emptyState);
  elements.emptyState.classList.remove('hidden');
}

function hideEmptyState() {
  elements.emptyState.classList.add('hidden');
}

function resizeTextarea() {
  const input = elements.promptInput;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.3))}px`;
}

function scrollMessages() {
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
}

function toggleMobileMenu() {
  if (elements.sidebar.classList.contains('open')) closeMobileMenu();
  else openMobileMenu();
}

function openMobileMenu() {
  elements.sidebar.classList.add('open');
  elements.mobileBackdrop.hidden = false;
  document.body.classList.add('menu-open');
  elements.menuButton.setAttribute('aria-expanded', 'true');
}

function closeMobileMenu() {
  elements.sidebar.classList.remove('open');
  elements.mobileBackdrop.hidden = true;
  document.body.classList.remove('menu-open');
  elements.menuButton.setAttribute('aria-expanded', 'false');
}

function renderMarkdown(value) {
  const source = String(value || '');
  if (!source) return '';
  const chunks = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match;
  while ((match = fence.exec(source))) {
    chunks.push(renderTextChunk(source.slice(cursor, match.index)));
    const lang = match[1] ? `<span>${escapeHtml(match[1].trim())}</span>` : '';
    chunks.push(`<pre><code>${lang}${escapeHtml(match[2])}</code></pre>`);
    cursor = match.index + match[0].length;
  }
  chunks.push(renderTextChunk(source.slice(cursor)));
  return chunks.join('');
}

function renderTextChunk(text) {
  const escaped = escapeHtml(text).trim();
  if (!escaped) return '';
  const withInline = escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return `<p>${withInline.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
}

function formatBlockContent(content) {
  if (typeof content === 'string') return content;
  return JSON.stringify(content, null, 2);
}

function summarizeJson(value) {
  if (!value) return '';
  try {
    const text = JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 240)}...` : text;
  } catch {
    return String(value);
  }
}

function localizeTitle(data) {
  if (data.kind === 'permission') return `Allow ${data.displayName || data.toolName || 'tool'}?`;
  if (data.kind === 'ask_user_question') return data.title || 'Claude asks a question';
  if (data.kind === 'elicitation') return data.title || 'Claude needs input';
  return data.title || 'Claude needs interaction';
}

function localizeAction(action) {
  return ({
    allow_once: '允许一次',
    allow_always: '始终允许',
    deny: '拒绝',
    deny_interrupt: '拒绝并中断',
    accept: '提交',
    decline: '拒绝',
    cancel: '取消',
    answer: 'Submit answer',
    send_success: '发送',
    send_error: '返回错误',
  })[action] || action;
}

function localizeStatus(status) {
  return ({
    idle: '未启动',
    starting: '启动中',
    ready: '已连接',
    thinking: '回复中',
    interrupted: '已中断',
    reconnecting: '重连中',
    error: '错误',
    exited: '已退出',
  })[status] || status;
}

function shortId(id) {
  return String(id).slice(0, 8);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}
