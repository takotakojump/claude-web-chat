const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

const CONFIG = loadConfig();
const HOST = process.env.HOST || getConfig('server.host') || '127.0.0.1';
const PORT = Number(process.env.PORT || getConfig('server.port') || 3652);
const CLAUDE_CWD = resolvePath(
  process.env.CLAUDE_CWD || getConfig('claude.cwd') || process.cwd(),
);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVENT_LOG = 800;
const MAX_STDERR_LOG = 200;
const SESSION_COOKIE = 'cwc_session';
const AUTH = buildAuthConfig();

const clients = new Set();
const pendingInteractions = new Map();
const stderrRing = [];
const sessions = new Map();
const loginAttempts = new Map();

let eventLog = [];
let claudeProcess = null;
let stdoutBuffer = '';
let stderrBuffer = '';
let activeAssistantId = null;
let intentionalStop = false;
let state = {
  running: false,
  busy: false,
  status: 'idle',
  pid: null,
  sessionId: null,
  model: null,
  cwd: CLAUDE_CWD,
  command: resolveClaudeCommand(),
  startedAt: null,
  lastResult: null,
  skipPermissions: getSkipPermissions(),
  configPath: CONFIG_PATH,
  hasApiKey: Boolean(getClaudeApiKey()),
  baseUrl: getClaudeBaseUrl() || null,
  authEnabled: AUTH.enabled,
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    console.error(`Failed to read ${CONFIG_PATH}: ${error.message}`);
    return {};
  }
}

function getConfig(dottedPath, fallback) {
  let current = CONFIG;
  for (const segment of dottedPath.split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return fallback;
    }
    current = current[segment];
  }
  return current ?? fallback;
}

function resolvePath(value) {
  return path.resolve(ROOT_DIR, String(value || '.'));
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}



function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value) !== '') return value;
  }
  return undefined;
}

function buildAuthConfig() {
  const enabled = isTruthy(firstNonEmpty(process.env.CWC_AUTH_ENABLED, getConfig('auth.enabled')));
  const password = firstNonEmpty(process.env.CWC_AUTH_PASSWORD, getConfig('auth.password'));
  const passwordSha256 = firstNonEmpty(
    process.env.CWC_AUTH_PASSWORD_SHA256,
    getConfig('auth.passwordSha256'),
  );
  const totpSecret = firstNonEmpty(
    process.env.CWC_TOTP_SECRET,
    getConfig('auth.totp.secret'),
  );
  const totpEnabled = isTruthy(
    firstNonEmpty(process.env.CWC_TOTP_ENABLED, getConfig('auth.totp.enabled')),
  );
  const sessionHours = Number(firstNonEmpty(getConfig('auth.sessionHours'), 12));
  const maxAttempts = Number(firstNonEmpty(getConfig('auth.maxAttemptsPerMinute'), 12));

  return {
    enabled,
    password: password ? String(password) : '',
    passwordSha256: passwordSha256 ? normalizeSha256(passwordSha256) : '',
    totp: {
      enabled: totpEnabled,
      secret: totpSecret ? String(totpSecret) : '',
      period: Number(firstNonEmpty(getConfig('auth.totp.period'), 30)),
      digits: Number(firstNonEmpty(getConfig('auth.totp.digits'), 6)),
      window: Number(firstNonEmpty(getConfig('auth.totp.window'), 1)),
    },
    sessionMs: Math.max(1, sessionHours) * 60 * 60 * 1000,
    maxAttempts: Math.max(3, maxAttempts),
    cookieSecure: isTruthy(getConfig('auth.cookieSecure')),
  };
}

function normalizeSha256(value) {
  return String(value).trim().replace(/^sha256:/i, '').toLowerCase();
}

function authPasswordConfigured() {
  return Boolean(AUTH.password || AUTH.passwordSha256);
}

function authTotpConfigured() {
  return Boolean(AUTH.totp.enabled && AUTH.totp.secret);
}

function authReady() {
  if (!AUTH.enabled) return true;
  return authPasswordConfigured() || authTotpConfigured();
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function verifyPassword(input) {
  if (!authPasswordConfigured()) return true;
  const candidate = String(input || '');
  if (AUTH.passwordSha256) {
    return safeEqualString(sha256Hex(candidate), AUTH.passwordSha256);
  }
  return safeEqualString(sha256Hex(candidate), sha256Hex(AUTH.password));
}

function base32Decode(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(secret || '').toUpperCase().replace(/[=\s-]/g, '');
  let bits = '';
  const bytes = [];
  for (const char of normalized) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('Invalid TOTP secret. Use RFC4648 base32.');
    bits += value.toString(2).padStart(5, '0');
    while (bits.length >= 8) {
      bytes.push(Number.parseInt(bits.slice(0, 8), 2));
      bits = bits.slice(8);
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret, counter, digits) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

function verifyTotp(input) {
  if (!authTotpConfigured()) return true;
  const code = String(input || '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${AUTH.totp.digits}}$`).test(code)) return false;
  const currentCounter = Math.floor(Date.now() / 1000 / AUTH.totp.period);
  for (let offset = -AUTH.totp.window; offset <= AUTH.totp.window; offset += 1) {
    const counter = currentCounter + offset;
    if (counter < 0) continue;
    if (safeEqualString(hotp(AUTH.totp.secret, counter, AUTH.totp.digits), code)) {
      return true;
    }
  }
  return false;
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function createSessionCookie(req) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + AUTH.sessionMs;
  sessions.set(token, { expiresAt, ip: clientIp(req) });
  return buildCookie(SESSION_COOKIE, token, {
    maxAge: Math.floor(AUTH.sessionMs / 1000),
    httpOnly: true,
    sameSite: 'Lax',
    secure: AUTH.cookieSecure,
  });
}

function clearSessionCookie() {
  return buildCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: 'Lax',
    secure: AUTH.cookieSecure,
  });
}

function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function isAuthenticated(req) {
  if (!AUTH.enabled) return true;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkLoginRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const bucket = loginAttempts.get(ip) || [];
  const recent = bucket.filter(timestamp => now - timestamp < 60_000);
  recent.push(now);
  loginAttempts.set(ip, recent);
  return recent.length <= AUTH.maxAttempts;
}

function verifyAuthPayload(body) {
  if (!authReady()) {
    return { ok: false, error: 'Auth is enabled but no password or TOTP secret is configured.' };
  }
  if (!verifyPassword(body.password)) {
    return { ok: false, error: 'Invalid password or verification code.' };
  }
  try {
    if (!verifyTotp(body.totp)) {
      return { ok: false, error: 'Invalid password or verification code.' };
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

function toArgArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return splitArgs(String(value || ''));
}

function getClaudeApiKey() {
  return firstNonEmpty(getConfig('claude.apiKey'), process.env.ANTHROPIC_API_KEY);
}

function getClaudeBaseUrl() {
  return firstNonEmpty(getConfig('claude.baseUrl'), process.env.ANTHROPIC_BASE_URL);
}

function getSkipPermissions() {
  const configured = firstNonEmpty(
    process.env.CLAUDE_SKIP_PERMISSIONS,
    getConfig('claude.skipPermissions'),
  );
  return isTruthy(configured);
}

function buildClaudeEnv() {
  const configuredEnv = getConfig('claude.env', {});
  const extraEnv = configuredEnv && typeof configuredEnv === 'object' ? configuredEnv : {};
  const apiKey = getClaudeApiKey();
  const baseUrl = getClaudeBaseUrl();
  const authToken = firstNonEmpty(
    getConfig('claude.authToken'),
    process.env.ANTHROPIC_AUTH_TOKEN,
  );
  const customHeaders = firstNonEmpty(
    getConfig('claude.customHeaders'),
    process.env.ANTHROPIC_CUSTOM_HEADERS,
  );

  return {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(extraEnv).map(([key, value]) => [key, String(value)]),
    ),
    ...(apiKey ? { ANTHROPIC_API_KEY: String(apiKey) } : {}),
    ...(baseUrl ? { ANTHROPIC_BASE_URL: String(baseUrl) } : {}),
    ...(authToken ? { ANTHROPIC_AUTH_TOKEN: String(authToken) } : {}),
    ...(customHeaders ? { ANTHROPIC_CUSTOM_HEADERS: String(customHeaders) } : {}),
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}

function redactArgs(args) {
  const secretFlags = new Set(['--api-key', '--auth-token', '--token']);
  return args.map((arg, index) => {
    if (secretFlags.has(args[index - 1])) return '***';
    if (/api[_-]?key|auth[_-]?token|secret/i.test(arg)) return arg.replace(/=.*/, '=***');
    return arg;
  });
}

function resolveClaudeCommand() {
  const configured = firstNonEmpty(process.env.CLAUDE_COMMAND, getConfig('claude.command'));
  if (configured) return String(configured);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      const cmd = path.join(appData, 'npm', 'claude.cmd');
      if (fs.existsSync(cmd)) return cmd;
    }
    return 'claude.cmd';
  }
  return 'claude';
}

function splitArgs(input) {
  if (!input) return [];
  const args = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function buildClaudeArgs() {
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
    '--include-partial-messages',
    '--replay-user-messages',
  ];

  if (isTruthy(firstNonEmpty(process.env.CLAUDE_BARE, getConfig('claude.bare')))) {
    args.unshift('--bare');
  }
  const model = firstNonEmpty(process.env.CLAUDE_MODEL, getConfig('claude.model'));
  const agent = firstNonEmpty(process.env.CLAUDE_AGENT, getConfig('claude.agent'));
  const systemPrompt = firstNonEmpty(
    process.env.CLAUDE_SYSTEM_PROMPT,
    getConfig('claude.appendSystemPrompt'),
  );
  if (model) args.push('--model', String(model));
  if (agent) args.push('--agent', String(agent));
  if (systemPrompt) args.push('--append-system-prompt', String(systemPrompt));
  if (getSkipPermissions()) args.push('--dangerously-skip-permissions');
  args.push(...toArgArray(firstNonEmpty(process.env.CLAUDE_EXTRA_ARGS, getConfig('claude.extraArgs'))));
  return args;
}

function sendSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function emit(type, payload = {}, options = {}) {
  const event = {
    id: randomUUID(),
    type,
    payload,
    at: new Date().toISOString(),
  };

  if (options.log !== false) {
    eventLog.push(event);
    if (eventLog.length > MAX_EVENT_LOG) {
      eventLog = eventLog.slice(eventLog.length - MAX_EVENT_LOG);
    }
  }

  for (const client of clients) {
    sendSse(client, 'event', event);
  }
  return event;
}

function updateState(patch) {
  state = { ...state, ...patch };
  emit('state', state, { log: false });
}

function startClaude() {
  if (claudeProcess && !claudeProcess.killed) return claudeProcess;

  const command = resolveClaudeCommand();
  const args = buildClaudeArgs();
  intentionalStop = false;
  stdoutBuffer = '';
  stderrBuffer = '';
  state.command = command;
  state.cwd = CLAUDE_CWD;
  state.hasApiKey = Boolean(getClaudeApiKey());
  state.baseUrl = getClaudeBaseUrl() || null;
  state.skipPermissions = getSkipPermissions();

  updateState({ status: 'starting', running: false, pid: null, startedAt: null });
  emit('system', {
    level: 'info',
    text: 'Starting Claude CLI',
    detail: `${command} ${redactArgs(args).join(' ')}`,
  });

  try {
    claudeProcess = spawn(command, args, {
      cwd: CLAUDE_CWD,
      env: buildClaudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    claudeProcess = null;
    updateState({ running: false, busy: false, status: 'error' });
    emit('error', { text: `Unable to start Claude CLI: ${error.message}` });
    return null;
  }

  const child = claudeProcess;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', chunk => feedStdout(chunk));
  child.stderr.on('data', chunk => feedStderr(chunk));

  child.on('error', error => {
    if (child !== claudeProcess) return;
    emit('error', { text: `Claude CLI process error: ${error.message}` });
    updateState({ running: false, busy: false, status: 'error', pid: null });
  });

  child.on('exit', (code, signal) => {
    if (child !== claudeProcess) return;
    const clean = intentionalStop || code === 0;
    emit('system', {
      level: clean ? 'info' : 'error',
      text: `Claude CLI exited (${signal || (code ?? 'unknown')})`,
    });
    for (const interaction of pendingInteractions.values()) {
      emit('interaction_resolved', {
        id: interaction.id,
        status: 'cancelled',
        label: 'Claude CLI stopped',
      });
    }
    pendingInteractions.clear();
    claudeProcess = null;
    activeAssistantId = null;
    updateState({
      running: false,
      busy: false,
      status: clean ? 'idle' : 'exited',
      pid: null,
      startedAt: null,
    });
  });

  updateState({
    running: true,
    status: 'ready',
    pid: child.pid || null,
    startedAt: new Date().toISOString(),
  });
  return child;
}

function stopClaude() {
  if (!claudeProcess) return;
  intentionalStop = true;
  const child = claudeProcess;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    child.kill('SIGTERM');
  }
}

function resetConversation() {
  eventLog = [];
  pendingInteractions.clear();
  stderrRing.length = 0;
  activeAssistantId = null;
  state = {
    ...state,
    busy: false,
    status: claudeProcess ? 'ready' : 'idle',
    lastResult: null,
    sessionId: null,
  };
  emit('reset', {});
  updateState(state);
}

function feedStdout(chunk) {
  stdoutBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trimEnd();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (line) handleStdoutLine(line);
  }
}

function feedStderr(chunk) {
  stderrBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = stderrBuffer.indexOf('\n')) >= 0) {
    const line = stderrBuffer.slice(0, newlineIndex).trimEnd();
    stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
    if (line) logStderr(line);
  }
}

function logStderr(line) {
  stderrRing.push(line);
  if (stderrRing.length > MAX_STDERR_LOG) stderrRing.shift();
  emit('stderr', { text: line }, { log: false });
}

function handleStdoutLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    emit('cli_text', { stream: 'stdout', text: line });
    return;
  }
  handleClaudeMessage(message);
}

function handleClaudeMessage(message) {
  switch (message.type) {
    case 'system':
      handleSystemMessage(message);
      break;
    case 'assistant':
      handleAssistantMessage(message);
      break;
    case 'stream_event':
      handleStreamEvent(message);
      break;
    case 'streamlined_text':
      handleStreamlinedText(message);
      break;
    case 'streamlined_tool_use_summary':
    case 'tool_use_summary':
      emit('tool_summary', { text: message.tool_summary || message.summary || '' });
      break;
    case 'result':
      handleResultMessage(message);
      break;
    case 'control_request':
      handleControlRequest(message);
      break;
    case 'control_cancel_request':
      handleControlCancel(message);
      break;
    case 'control_response':
      emit('control_response', { response: message.response || null }, { log: false });
      break;
    case 'user':
      emit('user_ack', { uuid: message.uuid || null, sessionId: message.session_id || null }, { log: false });
      break;
    case 'rate_limit_event':
      emit('rate_limit', { info: message.rate_limit_info || null });
      break;
    case 'auth_status':
      emit('auth_status', { status: message.status || message.auth_status || message });
      break;
    case 'prompt_suggestion':
      emit('prompt_suggestion', { suggestion: message.suggestion || message.prompt || message });
      break;
    default:
      emit('raw_message', { message: compactValue(message) }, { log: false });
      break;
  }
}

function handleSystemMessage(message) {
  if (message.subtype === 'init') {
    updateState({
      sessionId: message.session_id || state.sessionId,
      model: message.model || state.model,
      status: 'ready',
      running: true,
    });
    emit('system', {
      level: 'info',
      text: 'Claude session initialized',
      detail: [message.model, message.cwd || CLAUDE_CWD].filter(Boolean).join(' - '),
    });
    return;
  }

  if (message.subtype === 'status') {
    const text = message.message || message.status || message.title || 'Status update';
    emit('status_text', { text, raw: compactValue(message) }, { log: false });
    return;
  }

  if (message.subtype === 'task_notification') {
    emit('system', {
      level: 'info',
      text: message.message || message.notification || 'Task notification',
      detail: message.title || '',
    });
    return;
  }

  emit('system', {
    level: 'info',
    text: message.subtype ? `System: ${message.subtype}` : 'System message',
    detail: message.message || '',
    raw: compactValue(message),
  });
}

function handleAssistantMessage(message) {
  const id = getAssistantId(message);
  const extracted = extractContentBlocks(message.message && message.message.content);
  ensureAssistantMessage(id, { status: 'done' });
  emit('message_replace', {
    id,
    text: extracted.text,
    blocks: extracted.blocks,
    status: 'done',
  });
  activeAssistantId = null;
}

function handleStreamlinedText(message) {
  const id = message.uuid || activeAssistantId || randomUUID();
  ensureAssistantMessage(id, { status: 'streaming' });
  emit('message_delta', { id, text: message.text || '' });
  activeAssistantId = id;
}

function handleStreamEvent(message) {
  const event = message.event || {};
  const id = message.uuid || activeAssistantId || randomUUID();

  if (event.type === 'message_start') {
    activeAssistantId = id;
    ensureAssistantMessage(id, { status: 'streaming' });
    return;
  }

  if (!activeAssistantId) activeAssistantId = id;
  ensureAssistantMessage(activeAssistantId, { status: 'streaming' });

  if (event.type === 'content_block_start') {
    const block = event.content_block || {};
    if (block.type === 'text' && block.text) {
      emit('message_delta', { id: activeAssistantId, text: block.text });
    } else if (block.type === 'thinking') {
      emit('thinking_delta', {
        id: activeAssistantId,
        text: block.thinking || block.text || '',
      });
    } else if (block.type === 'tool_use') {
      emit('tool_use', {
        id: activeAssistantId,
        toolUseId: block.id || null,
        name: block.name || 'tool',
        input: block.input || {},
        status: 'started',
      });
    }
    return;
  }

  if (event.type === 'content_block_delta') {
    const delta = event.delta || {};
    if (delta.type === 'text_delta' && delta.text) {
      emit('message_delta', { id: activeAssistantId, text: delta.text });
    } else if (delta.type === 'thinking_delta' && delta.thinking) {
      emit('thinking_delta', { id: activeAssistantId, text: delta.thinking });
    } else if (delta.type === 'input_json_delta' && delta.partial_json) {
      emit('tool_input_delta', {
        id: activeAssistantId,
        index: event.index,
        partialJson: delta.partial_json,
      });
    }
    return;
  }

  if (event.type === 'message_stop') {
    emit('message_patch', { id: activeAssistantId, status: 'finishing' });
    return;
  }

  if (event.type === 'content_block_stop') {
    emit('stream_marker', { id: activeAssistantId, marker: 'content_block_stop' }, { log: false });
  }
}

function handleResultMessage(message) {
  const result = {
    subtype: message.subtype || 'success',
    durationMs: message.duration_ms || message.durationMs || null,
    apiDurationMs: message.duration_api_ms || null,
    costUsd: message.total_cost_usd || message.cost_usd || null,
    isError: message.is_error || message.subtype === 'error_during_execution',
    numTurns: message.num_turns || null,
    sessionId: message.session_id || state.sessionId,
  };
  updateState({
    busy: false,
    status: result.isError ? 'error' : 'ready',
    lastResult: result,
    sessionId: result.sessionId || state.sessionId,
  });
  emit('result', result);
}

function handleControlRequest(message) {
  const requestId = message.request_id;
  const request = message.request || {};
  if (!requestId) return;

  const kind = request.subtype === 'can_use_tool'
    ? 'permission'
    : request.subtype === 'elicitation'
      ? 'elicitation'
      : 'generic';

  const interaction = {
    id: requestId,
    kind,
    request,
    createdAt: new Date().toISOString(),
  };
  pendingInteractions.set(requestId, interaction);

  if (kind === 'permission') {
    emit('interaction_new', buildPermissionInteraction(requestId, request));
    return;
  }
  if (kind === 'elicitation') {
    emit('interaction_new', buildElicitationInteraction(requestId, request));
    return;
  }
  emit('interaction_new', {
    id: requestId,
    kind: 'generic',
    title: `Claude requests ${request.subtype || 'input'}`,
    description: 'Provide a JSON response for this SDK control request.',
    request: compactValue(request),
  });
}

function handleControlCancel(message) {
  const id = message.request_id;
  if (!id) return;
  pendingInteractions.delete(id);
  emit('interaction_resolved', { id, status: 'cancelled', label: 'Cancelled' });
}

function buildPermissionInteraction(id, request) {
  const toolName = request.tool_name || 'Tool';
  const displayName = request.display_name || request.title || toolName;
  const summary = request.description || summarizeToolInput(toolName, request.input || {});
  const canRemember = Array.isArray(request.permission_suggestions) && request.permission_suggestions.length > 0;
  return {
    id,
    kind: 'permission',
    title: `Allow ${displayName}?`,
    description: summary,
    toolName,
    displayName,
    input: request.input || {},
    blockedPath: request.blocked_path || null,
    decisionReason: request.decision_reason || null,
    suggestions: request.permission_suggestions || [],
    canRemember,
    choices: [
      { action: 'allow_once', label: 'Allow once', tone: 'primary' },
      ...(canRemember ? [{ action: 'allow_always', label: 'Always allow', tone: 'secondary' }] : []),
      { action: 'deny', label: 'Deny', tone: 'quiet' },
      { action: 'deny_interrupt', label: 'Deny and stop', tone: 'danger' },
    ],
  };
}

function buildElicitationInteraction(id, request) {
  return {
    id,
    kind: 'elicitation',
    title: request.message || 'Claude needs input',
    description: request.mcp_server_name ? `From MCP server: ${request.mcp_server_name}` : '',
    mode: request.mode || 'form',
    url: request.url || null,
    schema: request.requested_schema || null,
    choices: [
      { action: 'accept', label: 'Submit', tone: 'primary' },
      { action: 'decline', label: 'Decline', tone: 'quiet' },
      { action: 'cancel', label: 'Cancel', tone: 'danger' },
    ],
  };
}

function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.pattern === 'string') return input.pattern;
  const keys = Object.keys(input).slice(0, 4);
  if (!keys.length) return `Run ${toolName}`;
  return keys.map(key => `${key}: ${formatShort(input[key])}`).join(', ');
}

function formatShort(value) {
  if (value == null) return String(value);
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function getAssistantId(message) {
  return message.uuid || (message.message && message.message.id) || activeAssistantId || randomUUID();
}

function ensureAssistantMessage(id, patch = {}) {
  if (activeAssistantId !== id) activeAssistantId = id;
  emit('message_new', {
    id,
    role: 'assistant',
    text: '',
    blocks: [],
    status: patch.status || 'streaming',
  });
}

function extractContentBlocks(content) {
  const blocks = [];
  let text = '';
  const items = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];

  for (const block of items) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      text += block.text || '';
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', text: block.thinking || block.text || '' });
    } else if (block.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: block.id || null,
        name: block.name || 'tool',
        input: block.input || {},
      });
    } else if (block.type === 'tool_result') {
      blocks.push({
        type: 'tool_result',
        id: block.tool_use_id || null,
        content: block.content || '',
        isError: Boolean(block.is_error),
      });
    } else {
      blocks.push({ type: block.type || 'unknown', value: compactValue(block) });
    }
  }

  return { text, blocks };
}

function compactValue(value) {
  const seen = new WeakSet();
  const json = JSON.stringify(value, (key, val) => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    if (typeof val === 'string' && val.length > 4000) return `${val.slice(0, 4000)}...`;
    return val;
  });
  try {
    return JSON.parse(json);
  } catch {
    return value;
  }
}

function writeToClaude(payload) {
  const child = startClaude();
  if (!child || !child.stdin || child.stdin.destroyed) {
    throw new Error('Claude CLI is not available');
  }
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function sendUserMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Message is empty');

  const id = randomUUID();
  emit('message_new', {
    id,
    role: 'user',
    text: trimmed,
    blocks: [],
    status: 'sent',
  });

  updateState({ busy: true, status: 'thinking' });
  writeToClaude({
    type: 'user',
    uuid: id,
    session_id: state.sessionId || '',
    message: { role: 'user', content: trimmed },
    parent_tool_use_id: null,
  });
  return id;
}

function respondToInteraction(body) {
  const id = String(body.id || '');
  const action = String(body.action || '');
  const interaction = pendingInteractions.get(id);
  if (!interaction) throw new Error('Interaction is no longer pending');

  let wrapper;
  if (interaction.kind === 'permission') {
    wrapper = buildPermissionResponse(id, action, interaction.request, body);
  } else if (interaction.kind === 'elicitation') {
    wrapper = buildElicitationResponse(id, action, body);
  } else {
    wrapper = buildGenericResponse(id, body);
  }

  writeToClaude(wrapper);
  pendingInteractions.delete(id);
  emit('interaction_resolved', {
    id,
    status: 'resolved',
    label: labelForAction(action),
  });
}

function buildPermissionResponse(id, action, request, body) {
  const toolUseID = request.tool_use_id;
  const updatedInput = body.updatedInput && typeof body.updatedInput === 'object'
    ? body.updatedInput
    : request.input || {};

  let response;
  if (action === 'allow_once' || action === 'allow_always') {
    response = {
      behavior: 'allow',
      updatedInput,
      updatedPermissions: action === 'allow_always' ? request.permission_suggestions || [] : [],
      toolUseID,
      decisionClassification: action === 'allow_always' ? 'user_permanent' : 'user_temporary',
    };
  } else if (action === 'deny_interrupt') {
    response = {
      behavior: 'deny',
      message: body.message || 'Denied by user from Claude Web Chat.',
      interrupt: true,
      toolUseID,
      decisionClassification: 'user_reject',
    };
  } else {
    response = {
      behavior: 'deny',
      message: body.message || 'Denied by user from Claude Web Chat.',
      interrupt: false,
      toolUseID,
      decisionClassification: 'user_reject',
    };
  }

  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: id,
      response,
    },
  };
}

function buildElicitationResponse(id, action, body) {
  const normalized = ['accept', 'decline', 'cancel'].includes(action) ? action : 'cancel';
  const response = { action: normalized };
  if (normalized === 'accept') {
    response.content = body.content && typeof body.content === 'object' ? body.content : {};
  }
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: id,
      response,
    },
  };
}

function buildGenericResponse(id, body) {
  if (body.error) {
    return {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: id,
        error: String(body.error),
      },
    };
  }
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: id,
      response: body.response && typeof body.response === 'object' ? body.response : {},
    },
  };
}

function labelForAction(action) {
  return ({
    allow_once: 'Allowed once',
    allow_always: 'Always allowed',
    deny: 'Denied',
    deny_interrupt: 'Denied and stopped',
    accept: 'Submitted',
    decline: 'Declined',
    cancel: 'Cancelled',
  })[action] || 'Responded';
}

function sendInterrupt() {
  writeToClaude({
    type: 'control_request',
    request_id: randomUUID(),
    request: { subtype: 'interrupt' },
  });
  updateState({ busy: false, status: 'interrupted' });
  emit('system', { level: 'warn', text: 'Interrupt sent to Claude CLI' });
}

async function readJsonBody(req) {
  let size = 0;
  let body = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    body += chunk;
  }
  if (!body) return {};
  return JSON.parse(body);
}

function jsonResponse(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}


function htmlResponse(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function redirectResponse(res, location, headers = {}) {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end();
}

function handleUnauthorized(req, res, url) {
  if (!AUTH.enabled || isAuthenticated(req)) return true;
  if (url.pathname.startsWith('/api/')) {
    jsonResponse(res, 401, {
      ok: false,
      authRequired: true,
      error: 'Authentication required.',
    });
    return false;
  }
  const next = encodeURIComponent(`${url.pathname}${url.search}`);
  redirectResponse(res, `/login?next=${next}`);
  return false;
}

async function handleAuthRoutes(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
    jsonResponse(res, 200, {
      ok: true,
      authEnabled: AUTH.enabled,
      authenticated: isAuthenticated(req),
      passwordEnabled: authPasswordConfigured(),
      totpEnabled: authTotpConfigured(),
      authReady: authReady(),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/login') {
    if (!AUTH.enabled || isAuthenticated(req)) {
      redirectResponse(res, safeNextPath(url.searchParams.get('next')) || '/');
      return true;
    }
    htmlResponse(res, 200, renderLoginPage());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!AUTH.enabled) {
      jsonResponse(res, 200, { ok: true });
      return true;
    }
    if (!checkLoginRateLimit(req)) {
      jsonResponse(res, 429, { ok: false, error: 'Too many login attempts. Try again later.' });
      return true;
    }
    const body = await readJsonBody(req);
    const result = verifyAuthPayload(body);
    if (!result.ok) {
      jsonResponse(res, 401, { ok: false, error: result.error });
      return true;
    }
    jsonResponse(res, 200, { ok: true }, { 'set-cookie': createSessionCookie(req) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    jsonResponse(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
    return true;
  }

    return false;
  } catch (error) {
    jsonResponse(res, 400, { ok: false, error: error.message });
    return true;
  }
}

function safeNextPath(next) {
  if (!next || typeof next !== 'string') return '';
  if (!next.startsWith('/') || next.startsWith('//')) return '';
  return next;
}

function renderLoginPage() {
  const passwordField = authPasswordConfigured()
    ? `<label>Password<input name="password" type="password" autocomplete="current-password" autofocus /></label>`
    : '';
  const totpField = authTotpConfigured()
    ? `<label>Authenticator code<input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" placeholder="000000" ${passwordField ? '' : 'autofocus'} /></label>`
    : '';
  const setupWarning = authReady()
    ? ''
    : `<div class="warning">Auth is enabled, but no password or TOTP secret is configured. Edit config.json.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Claude Web Chat Login</title>
  <style>
    :root { color-scheme: light; --ink:#251b14; --muted:#76695c; --accent:#a8451f; --paper:#fffaf2; --line:rgba(72,48,31,.16); }
    * { box-sizing: border-box; }
    body { min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 24px; color: var(--ink); font-family: Aptos, "Trebuchet MS", sans-serif; background: radial-gradient(circle at 18% 10%, rgba(228,141,91,.25), transparent 28rem), linear-gradient(135deg,#fbf3e7,#ead8c4); }
    main { width: min(430px, 100%); padding: 30px; border: 1px solid var(--line); border-radius: 30px; background: rgba(255,250,242,.88); box-shadow: 0 28px 80px rgba(87,58,32,.16); backdrop-filter: blur(20px); }
    .mark { display: grid; place-items: center; width: 54px; height: 54px; border-radius: 18px; color: #fff8ee; font: 700 30px Georgia, serif; background: linear-gradient(145deg,#cc6532,#7e462d); }
    h1 { margin: 18px 0 8px; font: 700 34px Georgia, serif; letter-spacing: -.04em; }
    p { margin: 0 0 22px; color: var(--muted); line-height: 1.55; }
    form { display: grid; gap: 14px; }
    label { display: grid; gap: 7px; color: var(--muted); font-size: 13px; font-weight: 850; }
    input { width: 100%; min-height: 48px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 16px; outline: none; color: var(--ink); background: rgba(255,255,255,.68); font: inherit; }
    input:focus { border-color: rgba(168,69,31,.55); box-shadow: 0 0 0 4px rgba(168,69,31,.1); }
    button { min-height: 48px; border: 0; border-radius: 999px; color: #fff8ee; background: var(--accent); font-weight: 900; cursor: pointer; }
    button:disabled { opacity: .65; cursor: wait; }
    .error, .warning { display: none; padding: 11px 13px; border-radius: 14px; color: #a93628; background: rgba(169,54,40,.1); line-height: 1.45; }
    .warning { display: block; margin-bottom: 14px; }
    .hint { margin-top: 14px; color: var(--muted); font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <div class="mark">C</div>
    <h1>Sign in</h1>
    <p>Enter the access password and/or Google Authenticator code configured for this local Claude Web Chat.</p>
    ${setupWarning}
    <form id="loginForm">
      ${passwordField}
      ${totpField}
      <div class="error" id="errorBox"></div>
      <button type="submit">Unlock</button>
    </form>
    <div class="hint">Sessions are stored in an HttpOnly local cookie.</div>
  </main>
  <script>
    const form = document.getElementById('loginForm');
    const errorBox = document.getElementById('errorBox');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      errorBox.style.display = 'none';
      const button = form.querySelector('button');
      button.disabled = true;
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Login failed.');
        const next = new URLSearchParams(location.search).get('next') || '/';
        location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
      } catch (error) {
        errorBox.textContent = error.message;
        errorBox.style.display = 'block';
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      jsonResponse(res, 200, { ok: true, state, pending: Array.from(pendingInteractions.keys()) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      clients.add(res);
      sendSse(res, 'snapshot', {
        state,
        events: eventLog,
        pendingInteractions: Array.from(pendingInteractions.values()).map(interaction => {
          if (interaction.kind === 'permission') {
            return buildPermissionInteraction(interaction.id, interaction.request);
          }
          if (interaction.kind === 'elicitation') {
            return buildElicitationInteraction(interaction.id, interaction.request);
          }
          return {
            id: interaction.id,
            kind: 'generic',
            title: `Claude requests ${interaction.request.subtype || 'input'}`,
            request: compactValue(interaction.request),
          };
        }),
      });
      const heartbeat = setInterval(() => sendSse(res, 'ping', { at: Date.now() }), 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      const body = await readJsonBody(req);
      const id = sendUserMessage(body.text);
      jsonResponse(res, 200, { ok: true, id });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/respond') {
      const body = await readJsonBody(req);
      respondToInteraction(body);
      jsonResponse(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/interrupt') {
      sendInterrupt();
      jsonResponse(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/restart') {
      stopClaude();
      resetConversation();
      jsonResponse(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      startClaude();
      jsonResponse(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      jsonResponse(res, 200, { ok: true, stderr: stderrRing, state });
      return true;
    }
  } catch (error) {
    jsonResponse(res, 400, { ok: false, error: error.message });
    return true;
  }
  return false;
}

function serveStatic(res, pathname) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  let filePath;
  try {
    filePath = path.join(PUBLIC_DIR, decodeURIComponent(cleanPath));
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': mimeType(filePath),
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  })[ext] || 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (await handleAuthRoutes(req, res, url)) return;
  if (!handleUnauthorized(req, res, url)) return;
  if (await handleApi(req, res, url)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Web Chat listening on http://${HOST}:${PORT}`);
  console.log(`Working directory for Claude CLI: ${CLAUDE_CWD}`);
  console.log(`Claude command: ${state.command}`);
});

process.on('SIGINT', () => {
  stopClaude();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopClaude();
  process.exit(0);
});
