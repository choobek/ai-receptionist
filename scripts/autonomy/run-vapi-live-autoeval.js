#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const {
  buildRun,
  deriveLatencyDiagnostics,
  writeRun
} = require(path.join(__dirname, 'ingest-vapi-call-log.js'));

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const RUNS_ROOT = path.join(ROOT_DIR, 'autonomy', 'runs', 'generated', 'vapi-live-autoeval');
const REPORTS_ROOT = path.join(ROOT_DIR, 'autonomy', 'reports', 'generated', 'vapi-live-autoeval');
const POLICY_PATH = path.join(ROOT_DIR, 'configs', 'vapi', 'autoevaluation-policy.v1.json');
const ENVIRONMENTS_DIR = path.join(ROOT_DIR, 'configs', 'vapi', 'environments');
const TOOL_DEFINITIONS_PATH = path.join(ROOT_DIR, 'configs', 'vapi', 'tool-definitions.v1.json');
const MODEL_DOMINANT_REVIEW_THRESHOLD_MS = 4000;
const MODEL_DOMINANT_HIGH_THRESHOLD_MS = 7000;
const SPEECH_RENDERING_TOOL_NAMES = new Set(['checkAvailability', 'lookupPatient', 'createEvent']);
const VAPI_TOOL_WAIT_SPEECH_PREFIXES = [
  'Już sprawdzam dostępne terminy.',
  'Jeszcze chwila, sprawdzam kalendarz.',
  'Już sprawdzam informacje.',
  'Jeszcze chwila, wyszukuję potrzebne informacje.',
  'Już zapisuję wizytę w kalendarzu.',
  'Jeszcze moment, finalizuję rezerwację wizyty.',
  'Już zapisuję prośbę dla recepcji.',
  'Jeszcze chwila, kończę zapisywać prośbę dla recepcji.',
  'Jeszcze chwila, kończę przekazywanie sprawy.',
  'Jeszcze moment, dopinam przekazanie sprawy.'
];
const N8N_EVENT_LOG_FILENAMES = ['n8nEventLog.log', 'n8nEventLog-1.log', 'n8nEventLog-2.log', 'n8nEventLog-3.log'];
const N8N_EXTERNAL_NODE_TYPES = new Set(['n8n-nodes-base.googleCalendar', 'n8n-nodes-base.httpRequest']);
const TOOL_WORKFLOW_IDS = {
  lookupPatient: 'aiReceptionistLookupPatient',
  checkAvailability: 'aiReceptionistCheckAvailability',
  searchKnowledgeBase: 'aiReceptionistSearchKnowledgeBase',
  createEvent: 'aiReceptionistCreateEvent',
  createReceptionTask: 'aiReceptionistCreateReceptionTask',
  sendSmsToReceptionists: 'aiReceptionistSendSmsToReceptionists',
  sendSmsToPatient: 'aiReceptionistSendSmsToPatient'
};
const TOOL_ENDPOINTS = loadToolEndpointMap(TOOL_DEFINITIONS_PATH);
const EVENT_LOG_FILE_START_MARKER = '__AI_RECEPTIONIST_EVENT_LOG_FILE_START__';
const EVENT_LOG_FILE_END_MARKER = '__AI_RECEPTIONIST_EVENT_LOG_FILE_END__';
const DATE_OR_NUMBER_ASCII_PATTERNS = [
  { pattern: /\bponiedzialek\b/i, expected: 'poniedziałek' },
  { pattern: /\bsroda\b/i, expected: 'środa' },
  { pattern: /\bpiatek\b/i, expected: 'piątek' },
  { pattern: /\bwrzesnia\b/i, expected: 'września' },
  { pattern: /\bpazdziernika\b/i, expected: 'października' },
  { pattern: /\bpiatego\b/i, expected: 'piątego' },
  { pattern: /\bszostego\b/i, expected: 'szóstego' },
  { pattern: /\bsiodmego\b/i, expected: 'siódmego' },
  { pattern: /\bosmego\b/i, expected: 'ósmego' },
  { pattern: /\bdziewiatego\b/i, expected: 'dziewiątego' },
  { pattern: /\bdziewiatej\b/i, expected: 'dziewiątej' },
  { pattern: /\bpietnastego\b/i, expected: 'piętnastego' },
  { pattern: /\bpietnascie\b/i, expected: 'piętnaście' },
  { pattern: /\bszesc\b/i, expected: 'sześć' },
  { pattern: /\bdziewiec\b/i, expected: 'dziewięć' },
  { pattern: /\bczterdziesci\b/i, expected: 'czterdzieści' },
  { pattern: /\btrzydziesci\b/i, expected: 'trzydzieści' },
  { pattern: /\bpiecdziesiat\b/i, expected: 'pięćdziesiąt' }
];
const POLISH_MONTH_CONTEXT = /\b(stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrzesnia|września|pazdziernika|października|listopada|grudnia)\b/i;

function usage() {
  console.log(`Usage:
  node scripts/autonomy/run-vapi-live-autoeval.js [options]

Options:
  --environment <name>    staging | production. Default: staging.
  --limit <n>             Fetch up to this many recent calls before filtering. Default: 25.
  --since-hours <n>       Review only calls ended within the last n hours. Default: 168.
  --call-id <id>          Fetch a specific call id. Repeatable.
  --include-raw-calls     Also write raw call JSON files for manual debugging.
  --output-dir <path>     Override the generated run directory.
  --report <path>         Override the generated Markdown report path.
  --summary-json <path>   Write the suite summary JSON to this path.
  --fail-on-review        Exit non-zero when any call is flagged for review.
  --help                  Show this help message.
`);
}

function parseArgs(argv) {
  const options = {
    environment: 'staging',
    limit: 25,
    sinceHours: 168,
    callIds: [],
    outputDir: null,
    reportPath: null,
    summaryJson: null,
    includeRawCalls: false,
    failOnReview: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--fail-on-review') {
      options.failOnReview = true;
      continue;
    }
    if (arg === '--include-raw-calls') {
      options.includeRawCalls = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next) {
      throw new Error(`Missing value for ${arg}`);
    }
    switch (arg) {
      case '--environment':
        options.environment = next;
        index += 1;
        break;
      case '--limit':
        options.limit = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--since-hours':
        options.sinceHours = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--call-id':
        options.callIds.push(next);
        index += 1;
        break;
      case '--output-dir':
        options.outputDir = path.resolve(next);
        index += 1;
        break;
      case '--report':
        options.reportPath = path.resolve(next);
        index += 1;
        break;
      case '--summary-json':
        options.summaryJson = path.resolve(next);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['staging', 'production'].includes(options.environment)) {
    throw new Error('--environment must be staging or production');
  }
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error('--limit must be a positive integer');
  }
  if (!Number.isInteger(options.sinceHours) || options.sinceHours <= 0) {
    throw new Error('--since-hours must be a positive integer');
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function loadToolEndpointMap(filePath) {
  const payload = readJson(filePath);
  const tools = safeObject(payload?.tools) || {};
  return Object.fromEntries(
    Object.entries(tools)
      .map(([toolName, config]) => [
        toolName,
        typeof config?.endpoint === 'string' ? config.endpoint.trim() : ''
      ])
      .filter(([, endpoint]) => endpoint)
  );
}

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toCaddyTimestampMs(value) {
  const numericValue = toFiniteNumber(value);
  if (numericValue !== null) {
    return Math.round(numericValue * 1000);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function secondsToMilliseconds(value) {
  const numericValue = toFiniteNumber(value);
  if (numericValue === null) {
    return null;
  }
  return Math.max(Math.round(numericValue * 1000), 0);
}

function normalizeRequestPath(uri) {
  if (typeof uri !== 'string' || !uri.trim()) {
    return null;
  }
  try {
    return new URL(uri, 'https://edge.invalid').pathname || null;
  } catch {
    return uri.split('?')[0].trim() || null;
  }
}

function normalizeSpeechCompareText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

const NORMALIZED_VAPI_TOOL_WAIT_SPEECH_PREFIXES = VAPI_TOOL_WAIT_SPEECH_PREFIXES.map(normalizeSpeechCompareText);

function isVapiToolWaitSpeech(text) {
  const normalized = normalizeSpeechCompareText(text);
  if (!normalized) {
    return false;
  }
  return NORMALIZED_VAPI_TOOL_WAIT_SPEECH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `)
  );
}

function parseJsonLines(text) {
  const entries = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return entries;
}

async function fetchArtifactLogEntries(logUrl) {
  if (typeof logUrl !== 'string' || !logUrl.trim()) {
    return [];
  }

  const response = await fetch(logUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch Vapi artifact log: HTTP ${response.status}`);
  }

  const payload = Buffer.from(await response.arrayBuffer());
  let text;
  try {
    text = zlib.gunzipSync(payload).toString('utf8');
  } catch {
    text = payload.toString('utf8');
  }
  return parseJsonLines(text);
}

function parseVapiArtifactAssistantSpeechEntries(entries) {
  return safeArray(entries)
    .map((entry, index) => {
      const source = safeObject(entry);
      if (!source || source.body !== 'Voice input') {
        return null;
      }
      const attributes = safeObject(source.attributes) || {};
      if (attributes.category !== 'voice') {
        return null;
      }
      const spokenAtMs = toFiniteNumber(source.time);
      const text = typeof attributes.text === 'string' ? attributes.text.trim() : '';
      if (spokenAtMs === null || !text) {
        return null;
      }
      return {
        entryId: `vapi-artifact-voice-${index}`,
        callId: typeof attributes.callId === 'string' ? attributes.callId : null,
        spokenAtMs,
        text,
        isToolWaitSpeech: isVapiToolWaitSpeech(text)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.spokenAtMs - right.spokenAtMs);
}

function extractInitiatedToolCalls(attributes) {
  const requestBody = safeObject(attributes?.requestBody) || {};
  const message = safeObject(requestBody?.message) || {};
  const candidates = [
    ...safeArray(message.toolCalls),
    ...safeArray(message.toolCallList),
    ...safeArray(message.toolWithToolCallList).map((entry) => safeObject(entry?.toolCall)).filter(Boolean)
  ];
  const seen = new Set();
  const toolCalls = [];

  for (const candidate of candidates) {
    const toolCall = safeObject(candidate) || {};
    const toolCallId = typeof toolCall.id === 'string' ? toolCall.id : null;
    const functionPart = safeObject(toolCall.function) || {};
    const toolName = typeof functionPart.name === 'string' ? functionPart.name : null;
    const key = toolCallId || `${toolName || 'unknown'}::${toolCalls.length}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    toolCalls.push({
      toolCallId,
      toolName
    });
  }

  return toolCalls;
}

function pickPendingVapiWebhookBatch(pendingBatches, attributes, eventTimeMs) {
  const url = typeof attributes?.url === 'string' ? attributes.url : null;
  const messageType = typeof attributes?.messageType === 'string' ? attributes.messageType : null;
  if (!url || messageType !== 'tool-calls') {
    return null;
  }

  const candidates = pendingBatches.filter(
    (batch) => batch.url === url && batch.messageType === messageType && batch.initiatedAtMs <= eventTimeMs
  );
  return candidates[candidates.length - 1] || null;
}

function parseVapiArtifactWebhookEntries(entries) {
  const sortedEntries = safeArray(entries)
    .map((entry) => safeObject(entry))
    .filter(Boolean)
    .sort((left, right) => (toFiniteNumber(left.time) || 0) - (toFiniteNumber(right.time) || 0));
  const pendingBatches = [];
  const completedBatches = [];
  let batchIndex = 0;

  for (const entry of sortedEntries) {
    const attributes = safeObject(entry.attributes) || {};
    if (attributes.category !== 'webhook' || attributes.messageType !== 'tool-calls') {
      continue;
    }
    const timeMs = toFiniteNumber(entry.time);
    if (timeMs === null) {
      continue;
    }
    const body = typeof entry.body === 'string' ? entry.body : '';
    if (body === 'Request initiated: tool-calls') {
      const batch = {
        entryId: `vapi-artifact-webhook-${batchIndex}`,
        initiatedAtMs: timeMs,
        messageType: 'tool-calls',
        url: typeof attributes.url === 'string' ? attributes.url : null,
        requestPath: normalizeRequestPath(attributes.url),
        requestMethod: typeof attributes.requestMethod === 'string' ? attributes.requestMethod : null,
        timeoutSeconds: toFiniteNumber(attributes.timeout),
        configuredRetries: toFiniteNumber(attributes.retries),
        toolCalls: extractInitiatedToolCalls(attributes),
        responseLatencyMs: null,
        failureLatencyMs: null,
        statusCode: null,
        errorMessage: null,
        completedAtMs: null,
        totalLatencyMs: null,
        success: null,
        hasRetries: null
      };
      batchIndex += 1;
      pendingBatches.push(batch);
      completedBatches.push(batch);
      continue;
    }

    const batch = pickPendingVapiWebhookBatch(pendingBatches, attributes, timeMs);
    if (!batch) {
      continue;
    }

    if (body === 'Response successful: tool-calls') {
      batch.responseLatencyMs = toFiniteNumber(attributes.latencyMs);
      batch.statusCode = toFiniteNumber(attributes.statusCode);
      continue;
    }

    if (body === 'Request failed: tool-calls') {
      batch.failureLatencyMs = toFiniteNumber(attributes.latencyMs);
      batch.errorMessage = typeof attributes.errorMessage === 'string' ? attributes.errorMessage : null;
      if (batch.completedAtMs === null) {
        batch.completedAtMs = timeMs;
      }
      continue;
    }

    if (body === 'Request completed: tool-calls') {
      batch.completedAtMs = timeMs;
      batch.totalLatencyMs = toFiniteNumber(attributes.totalLatencyMs);
      batch.success = typeof attributes.success === 'boolean' ? attributes.success : null;
      batch.hasRetries = typeof attributes.hasRetries === 'boolean' ? attributes.hasRetries : null;
      const index = pendingBatches.indexOf(batch);
      if (index >= 0) {
        pendingBatches.splice(index, 1);
      }
    }
  }

  return completedBatches.flatMap((batch) => {
    const requestCompletedAtMs = typeof batch.completedAtMs === 'number'
      ? batch.completedAtMs
      : typeof batch.totalLatencyMs === 'number'
        ? batch.initiatedAtMs + batch.totalLatencyMs
        : typeof batch.responseLatencyMs === 'number'
          ? batch.initiatedAtMs + batch.responseLatencyMs
          : typeof batch.failureLatencyMs === 'number'
            ? batch.initiatedAtMs + batch.failureLatencyMs
            : null;
    const requestLatencyMs = batch.totalLatencyMs
      ?? batch.responseLatencyMs
      ?? batch.failureLatencyMs
      ?? (requestCompletedAtMs === null ? null : Math.max(requestCompletedAtMs - batch.initiatedAtMs, 0));
    const toolCalls = batch.toolCalls.length > 0 ? batch.toolCalls : [{ toolCallId: null, toolName: null }];
    return toolCalls.map((toolCall, index) => ({
      entryId: `${batch.entryId}::${index}`,
      source: 'vapi_artifact_log',
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      requestUrl: batch.url,
      requestPath: batch.requestPath,
      requestMethod: batch.requestMethod,
      requestInitiatedAtMs: batch.initiatedAtMs,
      requestCompletedAtMs,
      requestLatencyMs,
      statusCode: batch.statusCode,
      success: batch.success,
      hasRetries: batch.hasRetries,
      configuredRetries: batch.configuredRetries,
      timeoutSeconds: batch.timeoutSeconds,
      errorMessage: batch.errorMessage
    }));
  });
}

function maxNullable(values) {
  const finiteValues = safeArray(values).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (finiteValues.length === 0) {
    return null;
  }
  return Math.max(...finiteValues);
}

function readContextEnv(environment, key, legacyKey = '') {
  const prefix = environment.toUpperCase();
  return process.env[`${prefix}_${key}`] || (legacyKey ? process.env[legacyKey] : '') || '';
}

function buildSshContext(environment) {
  const host = readContextEnv(environment, 'VPS_SSH_HOST', 'VPS_SSH_HOST');
  const user = readContextEnv(environment, 'VPS_SSH_USER', 'VPS_SSH_USER');
  const port = readContextEnv(environment, 'VPS_SSH_PORT', 'VPS_SSH_PORT') || '22';
  const identityFile = readContextEnv(environment, 'VPS_SSH_IDENTITY_FILE', 'VPS_SSH_IDENTITY_FILE');
  const n8nContainer = readContextEnv(environment, 'VPS_N8N_CONTAINER_NAME', 'VPS_N8N_CONTAINER_NAME');
  const caddyContainer = readContextEnv(environment, 'VPS_CADDY_CONTAINER_NAME', 'CADDY_CONTAINER_NAME')
    || 'ai-receptionist-caddy';

  if (!host || !user || !n8nContainer) {
    return null;
  }

  return {
    host,
    user,
    port,
    identityFile,
    n8nContainer,
    caddyContainer
  };
}

function fetchRemoteN8nEventLogBundle(sshContext) {
  const sshArgs = ['-p', sshContext.port];
  if (sshContext.identityFile) {
    sshArgs.push('-i', sshContext.identityFile);
  }
  sshArgs.push(
    `${sshContext.user}@${sshContext.host}`,
    'bash',
    '-s',
    '--',
    sshContext.n8nContainer
  );

  const remoteScript = `
set -euo pipefail

container="$1"

for file_name in ${N8N_EVENT_LOG_FILENAMES.map((fileName) => `'${fileName}'`).join(' ')}; do
  if docker exec "$container" sh -lc "[ -f /home/node/.n8n/$file_name ]"; then
    printf '%s %s\\n' '${EVENT_LOG_FILE_START_MARKER}' "$file_name"
    docker exec "$container" sh -lc "cat /home/node/.n8n/$file_name"
    printf '\\n%s %s\\n' '${EVENT_LOG_FILE_END_MARKER}' "$file_name"
  fi
done
`;

  const result = spawnSync('ssh', sshArgs, {
    input: remoteScript,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `ssh exited with status ${result.status}`;
    throw new Error(`Failed to fetch n8n event logs: ${detail}`);
  }

  return result.stdout || '';
}

function fetchRemoteCaddyAccessLogBundle(sshContext, timeWindow) {
  if (!sshContext.caddyContainer) {
    throw new Error('Missing VPS Caddy container name for edge latency enrichment.');
  }

  const sshArgs = ['-p', sshContext.port];
  if (sshContext.identityFile) {
    sshArgs.push('-i', sshContext.identityFile);
  }
  sshArgs.push(
    `${sshContext.user}@${sshContext.host}`,
    'bash',
    '-s',
    '--',
    sshContext.caddyContainer,
    new Date(timeWindow.minMs).toISOString(),
    new Date(timeWindow.maxMs).toISOString()
  );

  const remoteScript = `
set -euo pipefail

container="$1"
since_iso="$2"
until_iso="$3"

docker logs --since "$since_iso" --until "$until_iso" "$container" 2>&1
`;

  const result = spawnSync('ssh', sshArgs, {
    input: remoteScript,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `ssh exited with status ${result.status}`;
    throw new Error(`Failed to fetch Caddy access logs: ${detail}`);
  }

  return result.stdout || '';
}

function parseN8nEventLogBundle(bundleText, timeWindow = null) {
  const events = [];
  let currentFile = null;
  const minMs = typeof timeWindow?.minMs === 'number' ? timeWindow.minMs : null;
  const maxMs = typeof timeWindow?.maxMs === 'number' ? timeWindow.maxMs : null;

  for (const rawLine of String(bundleText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith(`${EVENT_LOG_FILE_START_MARKER} `)) {
      currentFile = line.slice(EVENT_LOG_FILE_START_MARKER.length + 1).trim() || null;
      continue;
    }
    if (line.startsWith(`${EVENT_LOG_FILE_END_MARKER} `)) {
      currentFile = null;
      continue;
    }
    if (!currentFile || !line.startsWith('{')) {
      continue;
    }
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const tsMs = typeof event?.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
    if (Number.isFinite(tsMs)) {
      if (minMs !== null && tsMs < minMs) {
        continue;
      }
      if (maxMs !== null && tsMs > maxMs) {
        continue;
      }
    }
    events.push({
      ...event,
      __file: currentFile,
      __tsMs: Number.isFinite(tsMs) ? tsMs : null
    });
  }

  return events;
}

function parseCaddyAccessLogBundle(bundleText, timeWindow = null) {
  const entries = [];
  const minMs = typeof timeWindow?.minMs === 'number' ? timeWindow.minMs : null;
  const maxMs = typeof timeWindow?.maxMs === 'number' ? timeWindow.maxMs : null;
  let lineNumber = 0;

  for (const rawLine of String(bundleText || '').split(/\r?\n/)) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) {
      continue;
    }
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const logger = typeof event?.logger === 'string' ? event.logger : '';
    if (!logger.startsWith('http.log.access')) {
      continue;
    }
    const request = safeObject(event?.request) || {};
    const requestPath = normalizeRequestPath(request.uri);
    const edgeCompletedAtMs = toCaddyTimestampMs(event?.ts);
    const edgeDurationMs = secondsToMilliseconds(event?.duration);
    if (edgeCompletedAtMs === null || requestPath === null) {
      continue;
    }
    const edgeStartedAtMs = edgeDurationMs === null
      ? edgeCompletedAtMs
      : Math.max(edgeCompletedAtMs - edgeDurationMs, 0);
    if (minMs !== null && edgeCompletedAtMs < minMs) {
      continue;
    }
    if (maxMs !== null && edgeStartedAtMs > maxMs) {
      continue;
    }
    const upstreamDurationMs = toFiniteNumber(event?.upstream_duration_ms);
    entries.push({
      entryId: `${edgeCompletedAtMs}:${lineNumber}`,
      requestPath,
      method: typeof request.method === 'string' ? request.method : null,
      status: toFiniteNumber(event?.status),
      edgeStartedAtMs,
      edgeCompletedAtMs,
      edgeDurationMs,
      upstreamDurationMs,
      upstreamLatencyMs: toFiniteNumber(event?.upstream_latency_ms),
      proxyOverheadMs: edgeDurationMs !== null && upstreamDurationMs !== null
        ? Math.max(edgeDurationMs - upstreamDurationMs, 0)
        : null
    });
  }

  return entries.sort((left, right) => left.edgeStartedAtMs - right.edgeStartedAtMs);
}

function buildN8nExecutionSummaries(events) {
  const executions = new Map();

  function getExecution(executionId) {
    const existing = executions.get(executionId);
    if (existing) {
      return existing;
    }
    const created = {
      executionId,
      workflowId: null,
      workflowName: null,
      startedAtMs: null,
      endedAtMs: null,
      success: null,
      nodeStats: new Map(),
      pendingNodeStarts: new Map(),
      files: new Set()
    };
    executions.set(executionId, created);
    return created;
  }

  for (const event of safeArray(events)) {
    const payload = safeObject(event?.payload);
    const executionId = payload?.executionId;
    const tsMs = toNumber(event?.__tsMs);
    if (!executionId || tsMs === null) {
      continue;
    }

    const execution = getExecution(executionId);
    if (event.__file) {
      execution.files.add(event.__file);
    }
    if (typeof payload.workflowId === 'string' && payload.workflowId.trim()) {
      execution.workflowId = payload.workflowId.trim();
    }
    if (typeof payload.workflowName === 'string' && payload.workflowName.trim()) {
      execution.workflowName = payload.workflowName.trim();
    }

    switch (event.eventName) {
      case 'n8n.workflow.started':
        execution.startedAtMs = execution.startedAtMs === null ? tsMs : Math.min(execution.startedAtMs, tsMs);
        break;
      case 'n8n.workflow.success':
        execution.endedAtMs = execution.endedAtMs === null ? tsMs : Math.max(execution.endedAtMs, tsMs);
        execution.success = true;
        break;
      case 'n8n.workflow.failed':
        execution.endedAtMs = execution.endedAtMs === null ? tsMs : Math.max(execution.endedAtMs, tsMs);
        execution.success = false;
        break;
      case 'n8n.node.started': {
        const nodeName = typeof payload.nodeName === 'string' ? payload.nodeName : 'unknown';
        const nodeType = typeof payload.nodeType === 'string' ? payload.nodeType : 'unknown';
        const nodeKey = `${nodeName}::${nodeType}`;
        const pending = execution.pendingNodeStarts.get(nodeKey) || [];
        pending.push(tsMs);
        execution.pendingNodeStarts.set(nodeKey, pending);
        break;
      }
      case 'n8n.node.finished': {
        const nodeName = typeof payload.nodeName === 'string' ? payload.nodeName : 'unknown';
        const nodeType = typeof payload.nodeType === 'string' ? payload.nodeType : 'unknown';
        const nodeKey = `${nodeName}::${nodeType}`;
        const pending = execution.pendingNodeStarts.get(nodeKey) || [];
        const startedAtMs = pending.length > 0 ? pending.shift() : tsMs;
        if (pending.length > 0) {
          execution.pendingNodeStarts.set(nodeKey, pending);
        } else {
          execution.pendingNodeStarts.delete(nodeKey);
        }
        const durationMs = Math.max(tsMs - startedAtMs, 0);
        const current = execution.nodeStats.get(nodeKey) || {
          nodeName,
          nodeType,
          count: 0,
          durationMs: 0
        };
        current.count += 1;
        current.durationMs += durationMs;
        execution.nodeStats.set(nodeKey, current);
        break;
      }
      default:
        break;
    }
  }

  return Array.from(executions.values())
    .map((execution) => {
      const nodes = Array.from(execution.nodeStats.values())
        .map((node) => ({
          ...node
        }))
        .sort((left, right) => right.durationMs - left.durationMs || left.nodeName.localeCompare(right.nodeName));
      const externalNodes = nodes.filter((node) => N8N_EXTERNAL_NODE_TYPES.has(node.nodeType));
      const workflowDurationMs = execution.startedAtMs !== null && execution.endedAtMs !== null
        ? Math.max(execution.endedAtMs - execution.startedAtMs, 0)
        : null;
      const externalDurationMs = externalNodes.reduce((sum, node) => sum + node.durationMs, 0);
      const internalDurationMs = workflowDurationMs === null
        ? null
        : Math.max(workflowDurationMs - externalDurationMs, 0);

      return {
        executionId: execution.executionId,
        workflowId: execution.workflowId,
        workflowName: execution.workflowName,
        startedAtMs: execution.startedAtMs,
        endedAtMs: execution.endedAtMs,
        success: execution.success,
        workflowDurationMs,
        externalDurationMs,
        internalDurationMs,
        externalNodes,
        nodes,
        files: Array.from(execution.files).sort()
      };
    })
    .sort((left, right) => {
      const leftStarted = typeof left.startedAtMs === 'number' ? left.startedAtMs : Number.POSITIVE_INFINITY;
      const rightStarted = typeof right.startedAtMs === 'number' ? right.startedAtMs : Number.POSITIVE_INFINITY;
      return leftStarted - rightStarted;
    });
}

function buildToolTraceRefs(suiteRuns) {
  const refs = [];
  for (const suiteRun of safeArray(suiteRuns)) {
    for (const trace of safeArray(suiteRun?.run?.tool_trace)) {
      const requestedAtMs = toNumber(trace?.requested_at_ms);
      const completedAtMs = toNumber(trace?.completed_at_ms);
      const workflowId = TOOL_WORKFLOW_IDS[trace?.tool_name];
      if (!workflowId || requestedAtMs === null || completedAtMs === null) {
        continue;
      }
      refs.push({
        suiteRun,
        trace,
        requestedAtMs,
        completedAtMs,
        workflowId,
        endpointPath: TOOL_ENDPOINTS[trace?.tool_name] || null
      });
    }
  }
  return refs.sort((left, right) => left.requestedAtMs - right.requestedAtMs);
}

function buildTraceExecutionMatch(traceRef, execution) {
  const roundTripMs = Math.max(traceRef.completedAtMs - traceRef.requestedAtMs, 0);
  const workflowStartedAtMs = toNumber(execution?.startedAtMs);
  const workflowFinishedAtMs = toNumber(execution?.endedAtMs);
  const workflowDurationMs = toNumber(execution?.workflowDurationMs);
  const preWorkflowGapMs = workflowStartedAtMs === null
    ? null
    : Math.max(workflowStartedAtMs - traceRef.requestedAtMs, 0);
  const postWorkflowGapMs = workflowFinishedAtMs === null
    ? null
    : Math.max(traceRef.completedAtMs - workflowFinishedAtMs, 0);
  const platformGapMs = workflowDurationMs === null
    ? null
    : Math.max(roundTripMs - workflowDurationMs, 0);

  return {
    source: 'n8n_event_log',
    workflowId: execution.workflowId,
    workflowName: execution.workflowName,
    executionId: execution.executionId,
    workflowStartedAtMs,
    workflowFinishedAtMs,
    workflowDurationMs,
    externalDurationMs: toNumber(execution.externalDurationMs),
    internalDurationMs: toNumber(execution.internalDurationMs),
    preWorkflowGapMs,
    postWorkflowGapMs,
    platformGapMs,
    externalNodes: safeArray(execution.externalNodes).map((node) => ({
      nodeName: node.nodeName,
      nodeType: node.nodeType,
      count: node.count,
      durationMs: node.durationMs
    })),
    files: safeArray(execution.files),
    matchedUsing: 'nearest_workflow_start_after_tool_request'
  };
}

function buildTraceEdgeMatch(traceRef, entry) {
  const roundTripMs = Math.max(traceRef.completedAtMs - traceRef.requestedAtMs, 0);
  const n8nLatency = safeObject(traceRef.trace?.n8nLatency);
  const workflowStartedAtMs = toNumber(n8nLatency?.workflowStartedAtMs);
  const workflowFinishedAtMs = toNumber(n8nLatency?.workflowFinishedAtMs);
  const workflowDurationMs = toNumber(n8nLatency?.workflowDurationMs);
  const edgeStartedAtMs = toNumber(entry?.edgeStartedAtMs);
  const edgeCompletedAtMs = toNumber(entry?.edgeCompletedAtMs);
  const edgeDurationMs = toNumber(entry?.edgeDurationMs);
  const toolToEdgeStartGapMs = edgeStartedAtMs === null
    ? null
    : Math.max(edgeStartedAtMs - traceRef.requestedAtMs, 0);
  const edgeToToolResultGapMs = edgeCompletedAtMs === null
    ? null
    : Math.max(traceRef.completedAtMs - edgeCompletedAtMs, 0);
  const edgeIngressGapMs = edgeStartedAtMs === null || workflowStartedAtMs === null
    ? null
    : Math.max(workflowStartedAtMs - edgeStartedAtMs, 0);
  const edgeEgressGapMs = edgeCompletedAtMs === null || workflowFinishedAtMs === null
    ? null
    : Math.max(edgeCompletedAtMs - workflowFinishedAtMs, 0);
  const edgeObservedGapMs = edgeDurationMs === null || workflowDurationMs === null
    ? null
    : Math.max(edgeDurationMs - workflowDurationMs, 0);

  return {
    source: 'caddy_access_log',
    requestPath: entry.requestPath,
    method: entry.method,
    status: toNumber(entry.status),
    edgeStartedAtMs,
    edgeCompletedAtMs,
    edgeDurationMs,
    upstreamDurationMs: toNumber(entry.upstreamDurationMs),
    upstreamLatencyMs: toNumber(entry.upstreamLatencyMs),
    proxyOverheadMs: toNumber(entry.proxyOverheadMs),
    toolToEdgeStartGapMs,
    edgeIngressGapMs,
    edgeObservedGapMs,
    edgeEgressGapMs,
    edgeToToolResultGapMs,
    roundTripMs,
    matchedUsing: 'nearest_edge_request_for_tool_endpoint'
  };
}

function buildTraceVapiWebhookMatch(traceRef, entry) {
  const roundTripMs = Math.max(traceRef.completedAtMs - traceRef.requestedAtMs, 0);
  const requestCompletedAtMs = toNumber(entry?.requestCompletedAtMs);
  const requestLatencyMs = toNumber(entry?.requestLatencyMs);
  const toolToWebhookCompletionGapMs = requestCompletedAtMs === null
    ? null
    : Math.max(requestCompletedAtMs - traceRef.requestedAtMs, 0);
  const webhookToToolResultGapMs = requestCompletedAtMs === null
    ? null
    : Math.max(traceRef.completedAtMs - requestCompletedAtMs, 0);

  return {
    source: 'vapi_artifact_log',
    requestPath: entry.requestPath,
    requestMethod: entry.requestMethod,
    requestUrl: entry.requestUrl,
    requestInitiatedAtMs: toNumber(entry.requestInitiatedAtMs),
    requestCompletedAtMs,
    requestLatencyMs,
    statusCode: toNumber(entry.statusCode),
    success: typeof entry.success === 'boolean' ? entry.success : null,
    hasRetries: typeof entry.hasRetries === 'boolean' ? entry.hasRetries : null,
    configuredRetries: toNumber(entry.configuredRetries),
    timeoutSeconds: toNumber(entry.timeoutSeconds),
    errorMessage: typeof entry.errorMessage === 'string' ? entry.errorMessage : null,
    toolToWebhookCompletionGapMs,
    webhookToToolResultGapMs,
    roundTripMs,
    matchedUsing: entry.toolCallId
      ? 'tool_call_id_from_vapi_artifact_webhook'
      : 'endpoint_path_and_time_from_vapi_artifact_webhook'
  };
}

function buildTraceVapiSpeechMatch(traceRef, entry) {
  const requestCompletedAtMs = toNumber(traceRef.trace?.vapiWebhookTransport?.requestCompletedAtMs);
  const spokenAtMs = toNumber(entry?.spokenAtMs);
  const toolToSpeechMs = spokenAtMs === null
    ? null
    : Math.max(spokenAtMs - traceRef.requestedAtMs, 0);
  const webhookToSpeechGapMs = requestCompletedAtMs === null || spokenAtMs === null
    ? null
    : Math.max(spokenAtMs - requestCompletedAtMs, 0);
  const speechToToolResultBackfillMs = spokenAtMs === null
    ? null
    : Math.max(traceRef.completedAtMs - spokenAtMs, 0);

  return {
    source: 'vapi_artifact_log_voice',
    spokenResultStartedAtMs: spokenAtMs,
    speechText: typeof entry?.text === 'string' ? entry.text : null,
    toolToSpeechMs,
    webhookToSpeechGapMs,
    speechToToolResultBackfillMs,
    matchedUsing: 'first_non_wait_voice_input_after_webhook_completion'
  };
}

function matchToolTracesToExecutions(traceRefs, executions) {
  const executionsByWorkflowId = new Map();
  for (const execution of safeArray(executions)) {
    if (!execution.workflowId || typeof execution.startedAtMs !== 'number') {
      continue;
    }
    const current = executionsByWorkflowId.get(execution.workflowId) || [];
    current.push(execution);
    executionsByWorkflowId.set(execution.workflowId, current);
  }

  for (const executionList of executionsByWorkflowId.values()) {
    executionList.sort((left, right) => left.startedAtMs - right.startedAtMs);
  }

  const usedExecutionIds = new Set();
  let matchedTraceCount = 0;

  for (const traceRef of safeArray(traceRefs)) {
    const executionList = executionsByWorkflowId.get(traceRef.workflowId) || [];
    const matchingWindowStartMs = traceRef.requestedAtMs - 5000;
    const matchingWindowEndMs = traceRef.completedAtMs + 5000;
    const candidates = executionList
      .filter((execution) => !usedExecutionIds.has(execution.executionId))
      .filter((execution) => execution.startedAtMs >= matchingWindowStartMs && execution.startedAtMs <= matchingWindowEndMs)
      .filter((execution) => execution.endedAtMs === null || execution.endedAtMs <= matchingWindowEndMs)
      .sort((left, right) => {
        const leftScore = Math.abs(left.startedAtMs - traceRef.requestedAtMs);
        const rightScore = Math.abs(right.startedAtMs - traceRef.requestedAtMs);
        return leftScore - rightScore || left.startedAtMs - right.startedAtMs;
      });

    const matchedExecution = candidates[0] || null;
    if (!matchedExecution) {
      continue;
    }

    traceRef.trace.n8nLatency = buildTraceExecutionMatch(traceRef, matchedExecution);
    usedExecutionIds.add(matchedExecution.executionId);
    matchedTraceCount += 1;
  }

  return {
    matchedTraceCount,
    totalTraceCount: traceRefs.length,
    executionCount: safeArray(executions).length
  };
}

function matchToolTracesToCaddyEntries(traceRefs, accessEntries) {
  const entriesByPath = new Map();
  for (const entry of safeArray(accessEntries)) {
    if (!entry.requestPath || typeof entry.edgeStartedAtMs !== 'number') {
      continue;
    }
    const current = entriesByPath.get(entry.requestPath) || [];
    current.push(entry);
    entriesByPath.set(entry.requestPath, current);
  }

  for (const entryList of entriesByPath.values()) {
    entryList.sort((left, right) => left.edgeStartedAtMs - right.edgeStartedAtMs);
  }

  const usedEntryIds = new Set();
  let matchedTraceCount = 0;
  let totalTraceCount = 0;

  for (const traceRef of safeArray(traceRefs)) {
    if (!traceRef.endpointPath) {
      continue;
    }
    totalTraceCount += 1;
    const entryList = entriesByPath.get(traceRef.endpointPath) || [];
    const matchingWindowStartMs = traceRef.requestedAtMs - 5000;
    const matchingWindowEndMs = traceRef.completedAtMs + 5000;
    const candidates = entryList
      .filter((entry) => !usedEntryIds.has(entry.entryId))
      .filter((entry) => entry.edgeStartedAtMs <= matchingWindowEndMs && entry.edgeCompletedAtMs >= matchingWindowStartMs)
      .sort((left, right) => {
        const leftScore = Math.abs(left.edgeStartedAtMs - traceRef.requestedAtMs)
          + Math.abs(left.edgeCompletedAtMs - traceRef.completedAtMs);
        const rightScore = Math.abs(right.edgeStartedAtMs - traceRef.requestedAtMs)
          + Math.abs(right.edgeCompletedAtMs - traceRef.completedAtMs);
        return leftScore - rightScore || left.edgeStartedAtMs - right.edgeStartedAtMs;
      });

    const matchedEntry = candidates[0] || null;
    if (!matchedEntry) {
      continue;
    }

    traceRef.trace.edgeLatency = buildTraceEdgeMatch(traceRef, matchedEntry);
    usedEntryIds.add(matchedEntry.entryId);
    matchedTraceCount += 1;
  }

  return {
    matchedTraceCount,
    totalTraceCount,
    accessEntryCount: safeArray(accessEntries).length
  };
}

function matchToolTracesToVapiWebhookEntries(traceRefs, transportEntries) {
  const entriesByToolCallId = new Map();
  const entriesByPath = new Map();
  const normalizedEntries = safeArray(transportEntries)
    .map((entry, index) => {
      const source = safeObject(entry);
      if (!source) {
        return null;
      }
      return {
        ...source,
        matchKey: `${typeof source.entryId === 'string' ? source.entryId : 'vapi-transport-entry'}::${index}`
      };
    })
    .filter(Boolean);

  for (const entry of normalizedEntries) {
    if (entry.toolCallId) {
      const current = entriesByToolCallId.get(entry.toolCallId) || [];
      current.push(entry);
      entriesByToolCallId.set(entry.toolCallId, current);
    }
    if (entry.requestPath) {
      const current = entriesByPath.get(entry.requestPath) || [];
      current.push(entry);
      entriesByPath.set(entry.requestPath, current);
    }
  }

  for (const entryList of entriesByToolCallId.values()) {
    entryList.sort((left, right) => (left.requestInitiatedAtMs || 0) - (right.requestInitiatedAtMs || 0));
  }
  for (const entryList of entriesByPath.values()) {
    entryList.sort((left, right) => (left.requestInitiatedAtMs || 0) - (right.requestInitiatedAtMs || 0));
  }

  const usedEntryIds = new Set();
  let matchedTraceCount = 0;
  let totalTraceCount = 0;

  for (const traceRef of safeArray(traceRefs)) {
    totalTraceCount += 1;
    const matchingWindowStartMs = traceRef.requestedAtMs - 5000;
    const matchingWindowEndMs = traceRef.completedAtMs + 5000;
    const directCandidates = traceRef.trace?.tool_call_id
      ? (entriesByToolCallId.get(traceRef.trace.tool_call_id) || [])
      : [];
    const fallbackCandidates = traceRef.endpointPath
      ? (entriesByPath.get(traceRef.endpointPath) || [])
      : [];
    const candidates = (directCandidates.length > 0 ? directCandidates : fallbackCandidates)
      .filter((entry) => !usedEntryIds.has(entry.matchKey))
      .filter((entry) => {
        const startedAtMs = toNumber(entry.requestInitiatedAtMs);
        const completedAtMs = toNumber(entry.requestCompletedAtMs) ?? startedAtMs;
        if (startedAtMs === null) {
          return false;
        }
        return startedAtMs <= matchingWindowEndMs && completedAtMs >= matchingWindowStartMs;
      })
      .sort((left, right) => {
        const leftScore = Math.abs((toNumber(left.requestInitiatedAtMs) || 0) - traceRef.requestedAtMs)
          + Math.abs((toNumber(left.requestCompletedAtMs) || toNumber(left.requestInitiatedAtMs) || 0) - traceRef.completedAtMs);
        const rightScore = Math.abs((toNumber(right.requestInitiatedAtMs) || 0) - traceRef.requestedAtMs)
          + Math.abs((toNumber(right.requestCompletedAtMs) || toNumber(right.requestInitiatedAtMs) || 0) - traceRef.completedAtMs);
        return leftScore - rightScore;
      });

    const matchedEntry = candidates[0] || null;
    if (!matchedEntry) {
      continue;
    }

    traceRef.trace.vapiWebhookTransport = buildTraceVapiWebhookMatch(traceRef, matchedEntry);
    usedEntryIds.add(matchedEntry.matchKey);
    matchedTraceCount += 1;
  }

  return {
    matchedTraceCount,
    totalTraceCount,
    transportEntryCount: normalizedEntries.length
  };
}

function matchToolTracesToVapiSpeechEntries(traceRefs, speechEntries) {
  const entriesByCallId = new Map();
  const normalizedEntries = safeArray(speechEntries)
    .map((entry) => safeObject(entry))
    .filter(Boolean);

  for (const entry of normalizedEntries) {
    if (!entry.callId) {
      continue;
    }
    const current = entriesByCallId.get(entry.callId) || [];
    current.push(entry);
    entriesByCallId.set(entry.callId, current);
  }

  for (const entryList of entriesByCallId.values()) {
    entryList.sort((left, right) => (left.spokenAtMs || 0) - (right.spokenAtMs || 0));
  }

  const usedEntryIds = new Set();
  let matchedTraceCount = 0;
  let totalTraceCount = 0;

  for (const traceRef of safeArray(traceRefs)) {
    const requestCompletedAtMs = toNumber(traceRef.trace?.vapiWebhookTransport?.requestCompletedAtMs);
    const callId = traceRef.suiteRun?.run?.call?.call_id || traceRef.suiteRun?.fullCall?.id || null;
    if (requestCompletedAtMs === null || !callId) {
      continue;
    }
    totalTraceCount += 1;
    const candidates = (entriesByCallId.get(callId) || [])
      .filter((entry) => !usedEntryIds.has(entry.entryId))
      .filter((entry) => entry.isToolWaitSpeech !== true)
      .filter((entry) => entry.spokenAtMs >= requestCompletedAtMs && entry.spokenAtMs <= traceRef.completedAtMs)
      .sort((left, right) => left.spokenAtMs - right.spokenAtMs);

    const matchedEntry = candidates[0] || null;
    if (!matchedEntry) {
      continue;
    }

    traceRef.trace.vapiSpeechLatency = buildTraceVapiSpeechMatch(traceRef, matchedEntry);
    usedEntryIds.add(matchedEntry.entryId);
    matchedTraceCount += 1;
  }

  return {
    matchedTraceCount,
    totalTraceCount,
    speechEntryCount: normalizedEntries.length
  };
}

function refreshSuiteRunLatencyDiagnostics(suiteRuns) {
  for (const suiteRun of safeArray(suiteRuns)) {
    suiteRun.run.call.latency_diagnostics = deriveLatencyDiagnostics(suiteRun.fullCall, suiteRun.run.tool_trace);
  }
}

async function enrichSuiteRunsWithVapiWebhookTransport(suiteRuns) {
  const traceRefs = buildToolTraceRefs(suiteRuns);
  if (traceRefs.length === 0) {
    return {
      enabled: true,
      source: 'vapi_artifact_log',
      matchedTraceCount: 0,
      totalTraceCount: 0,
      transportEntryCount: 0
    };
  }

  const transportEntries = [];
  const speechEntries = [];
  const warnings = [];

  for (const suiteRun of safeArray(suiteRuns)) {
    const logUrl = suiteRun?.fullCall?.artifact?.logUrl;
    if (typeof logUrl !== 'string' || !logUrl.trim()) {
      continue;
    }
    try {
      const rawEntries = await fetchArtifactLogEntries(logUrl);
      transportEntries.push(...parseVapiArtifactWebhookEntries(rawEntries));
      speechEntries.push(...parseVapiArtifactAssistantSpeechEntries(rawEntries));
    } catch (error) {
      warnings.push(
        `${suiteRun?.run?.call?.call_id || 'unknown'}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const matchSummary = matchToolTracesToVapiWebhookEntries(traceRefs, transportEntries);
  const speechMatchSummary = matchToolTracesToVapiSpeechEntries(traceRefs, speechEntries);
  return {
    enabled: true,
    source: 'vapi_artifact_log',
    matchedTraceCount: matchSummary.matchedTraceCount,
    totalTraceCount: matchSummary.totalTraceCount,
    transportEntryCount: matchSummary.transportEntryCount,
    matchedSpeechTraceCount: speechMatchSummary.matchedTraceCount,
    totalSpeechTraceCount: speechMatchSummary.totalTraceCount,
    speechEntryCount: speechMatchSummary.speechEntryCount,
    ...(warnings.length > 0 ? { warning: warnings.join(' | ') } : {})
  };
}

async function enrichSuiteRunsWithN8nLatency(suiteRuns, environment) {
  const sshContext = buildSshContext(environment);
  if (!sshContext) {
    return {
      enabled: false,
      source: 'n8n_event_log',
      matchedTraceCount: 0,
      totalTraceCount: 0,
      executionCount: 0,
      warning: `Missing ${environment.toUpperCase()} VPS SSH or container env vars for n8n latency enrichment.`
    };
  }

  const traceRefs = buildToolTraceRefs(suiteRuns);
  if (traceRefs.length === 0) {
    return {
      enabled: true,
      source: 'n8n_event_log',
      matchedTraceCount: 0,
      totalTraceCount: 0,
      executionCount: 0
    };
  }

  const timeWindow = {
    minMs: Math.min(...traceRefs.map((traceRef) => traceRef.requestedAtMs)) - 60000,
    maxMs: Math.max(...traceRefs.map((traceRef) => traceRef.completedAtMs)) + 60000
  };

  try {
    const bundleText = fetchRemoteN8nEventLogBundle(sshContext);
    const events = parseN8nEventLogBundle(bundleText, timeWindow);
    const executions = buildN8nExecutionSummaries(events);
    const matchSummary = matchToolTracesToExecutions(traceRefs, executions);

    return {
      enabled: true,
      source: 'n8n_event_log',
      matchedTraceCount: matchSummary.matchedTraceCount,
      totalTraceCount: matchSummary.totalTraceCount,
      executionCount: matchSummary.executionCount
    };
  } catch (error) {
    return {
      enabled: false,
      source: 'n8n_event_log',
      matchedTraceCount: 0,
      totalTraceCount: traceRefs.length,
      executionCount: 0,
      warning: error instanceof Error ? error.message : String(error)
    };
  }
}

async function enrichSuiteRunsWithCaddyEdgeLatency(suiteRuns, environment) {
  const sshContext = buildSshContext(environment);
  if (!sshContext) {
    return {
      enabled: false,
      source: 'caddy_access_log',
      matchedTraceCount: 0,
      totalTraceCount: 0,
      accessEntryCount: 0,
      warning: `Missing ${environment.toUpperCase()} VPS SSH env vars for edge latency enrichment.`
    };
  }
  if (!sshContext.caddyContainer) {
    return {
      enabled: false,
      source: 'caddy_access_log',
      matchedTraceCount: 0,
      totalTraceCount: 0,
      accessEntryCount: 0,
      warning: `Missing ${environment.toUpperCase()} VPS Caddy container env vars for edge latency enrichment.`
    };
  }

  const traceRefs = buildToolTraceRefs(suiteRuns).filter((traceRef) => Boolean(traceRef.endpointPath));
  if (traceRefs.length === 0) {
    return {
      enabled: true,
      source: 'caddy_access_log',
      matchedTraceCount: 0,
      totalTraceCount: 0,
      accessEntryCount: 0
    };
  }

  const timeWindow = {
    minMs: Math.min(...traceRefs.map((traceRef) => traceRef.requestedAtMs)) - 120000,
    maxMs: Math.max(...traceRefs.map((traceRef) => traceRef.completedAtMs)) + 120000
  };

  try {
    const bundleText = fetchRemoteCaddyAccessLogBundle(sshContext, timeWindow);
    const accessEntries = parseCaddyAccessLogBundle(bundleText, timeWindow);
    const matchSummary = matchToolTracesToCaddyEntries(traceRefs, accessEntries);

    return {
      enabled: true,
      source: 'caddy_access_log',
      matchedTraceCount: matchSummary.matchedTraceCount,
      totalTraceCount: matchSummary.totalTraceCount,
      accessEntryCount: matchSummary.accessEntryCount
    };
  } catch (error) {
    return {
      enabled: false,
      source: 'caddy_access_log',
      matchedTraceCount: 0,
      totalTraceCount: traceRefs.length,
      accessEntryCount: 0,
      warning: error instanceof Error ? error.message : String(error)
    };
  }
}

function stableTimestamp() {
  return new Date().toISOString();
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildSuitePaths(suiteRunId, options) {
  const runDir = options.outputDir || path.join(RUNS_ROOT, suiteRunId);
  return {
    suiteRunId,
    runDir,
    rawCallsDir: options.includeRawCalls ? path.join(runDir, 'raw-calls') : null,
    normalizedRunsDir: path.join(runDir, 'normalized-runs'),
    reportPath: options.reportPath || path.join(REPORTS_ROOT, `${suiteRunId}.md`)
  };
}

function buildAssistantContext(environment) {
  const bindingsPath = path.join(ENVIRONMENTS_DIR, `${environment}.json`);
  const bindings = readJson(bindingsPath);
  const prefix = environment.toUpperCase();
  const assistantId = bindings.assistantId;
  const apiKey = readContextEnv(environment, 'VAPI_API_KEY', 'VAPI_API_KEY');
  const baseUrl = process.env.VAPI_API_BASE_URL || 'https://api.vapi.ai';

  if (!assistantId) {
    throw new Error(`assistantId is required in ${bindingsPath}`);
  }
  if (!apiKey) {
    throw new Error(`${prefix}_VAPI_API_KEY or VAPI_API_KEY is required`);
  }

  return {
    assistantId,
    apiKey,
    baseUrl,
    bindingsPath
  };
}

async function fetchJson(url, apiKey) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'ai-receptionist-live-autoeval/1.0'
    }
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const detail = typeof payload === 'object' && payload !== null ? JSON.stringify(payload) : String(payload);
    throw new Error(`Vapi request failed with HTTP ${response.status}: ${detail}`);
  }

  return payload;
}

async function fetchRecentCalls({ assistantId, apiKey, baseUrl, limit }) {
  const url = new URL('/call', baseUrl);
  url.searchParams.set('assistantId', assistantId);
  url.searchParams.set('limit', String(limit));
  const payload = await fetchJson(url, apiKey);
  return Array.isArray(payload) ? payload : [];
}

async function fetchCallById({ callId, apiKey, baseUrl }) {
  return fetchJson(`${baseUrl.replace(/\/$/, '')}/call/${callId}`, apiKey);
}

function isEndedCall(call) {
  return Boolean(call) && (call.status === 'ended' || typeof call.endedAt === 'string');
}

function endedAtValue(call) {
  const endedAt = typeof call?.endedAt === 'string' ? Date.parse(call.endedAt) : Number.NaN;
  return Number.isFinite(endedAt) ? endedAt : null;
}

function withinSinceHours(call, sinceHours) {
  const endedAt = endedAtValue(call);
  if (endedAt === null) {
    return false;
  }
  const cutoff = Date.now() - (sinceHours * 60 * 60 * 1000);
  return endedAt >= cutoff;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeScopedName(name) {
  if (typeof name !== 'string') {
    return null;
  }
  return name.replace(/\s+\[(staging|production)\]$/i, '').trim();
}

function stringifySpeechAuditValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getSpeechAuditMessages(run, rawCall = null) {
  if (rawCall) {
    const rawMessages = safeArray(rawCall?.artifact?.messages).length > 0
      ? safeArray(rawCall.artifact.messages)
      : safeArray(rawCall?.messages);
    return rawMessages.map((message) => {
      if ((message?.role === 'bot' || message?.role === 'assistant') && typeof message?.message === 'string') {
        return {
          role: 'assistant',
          text: message.message,
          result: null,
          tool_name: null
        };
      }
      const toolName = typeof message?.name === 'string' ? message.name : null;
      if (
        (message?.role === 'tool_call_result' || message?.role === 'tool')
        && SPEECH_RENDERING_TOOL_NAMES.has(toolName)
      ) {
        return {
          role: 'tool_result',
          text: null,
          result: message.result ?? message.error ?? null,
          tool_name: toolName
        };
      }
      return null;
    }).filter(Boolean);
  }
  return safeArray(run?.conversation?.messages);
}

function detectSpeechRenderingIssues(run, rawCall = null) {
  const findings = [];
  const seen = new Set();
  const messages = getSpeechAuditMessages(run, rawCall);

  function addFinding(message) {
    if (!seen.has(message)) {
      seen.add(message);
      findings.push(message);
    }
  }

  for (const message of messages) {
    if (message?.role === 'assistant' && typeof message?.text === 'string') {
      const text = message.text;
      if (
        /\d/.test(text)
        && (
          /\b\d{1,2}:\d{2}\b/.test(text)
          || POLISH_MONTH_CONTEXT.test(text)
          || /\bpowtarzam numer\b/i.test(text)
        )
      ) {
        addFinding('assistant spoke raw digits in date, time, or phone text');
      }
    }

    if (
      message?.role !== 'assistant'
      && !(
        message?.role === 'tool_result'
        && SPEECH_RENDERING_TOOL_NAMES.has(message?.tool_name)
      )
    ) {
      continue;
    }

    const text = message?.role === 'assistant'
      ? message.text
      : stringifySpeechAuditValue(message?.result);
    if (typeof text !== 'string' || !text) {
      continue;
    }

    for (const rule of DATE_OR_NUMBER_ASCII_PATTERNS) {
      if (rule.pattern.test(text)) {
        addFinding(`speech-safe wording lost Polish diacritics (${rule.expected})`);
      }
    }
  }

  return findings;
}

function severityRank(severity) {
  switch (severity) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

function maxSeverity(left, right) {
  return severityRank(left) >= severityRank(right) ? left : right;
}

function detectBookingConfirmationSmsRegression(run) {
  const evaluation = safeObject(run?.evaluation?.result);
  if (evaluation?.booking_succeeded !== true) {
    return null;
  }

  const createEventTrace = safeArray(run?.tool_trace).find((trace) => trace?.tool_name === 'createEvent');
  const createEventResult = safeObject(createEventTrace?.result);
  if (createEventResult?.created !== true) {
    return null;
  }

  const bookingConfirmationSms = safeObject(createEventResult.bookingConfirmationSms);
  if (!bookingConfirmationSms) {
    return {
      type: 'booking_confirmation_sms_regression',
      severity: 'high',
      message: 'booking succeeded but createEvent returned no patient confirmation SMS evidence'
    };
  }

  const delivery = safeObject(bookingConfirmationSms.delivery);
  const provider = typeof delivery?.provider === 'string' ? delivery.provider.toLowerCase() : null;
  const status = typeof delivery?.status === 'string' ? delivery.status.toLowerCase() : null;
  const recipientCount = typeof delivery?.recipientCount === 'number' ? delivery.recipientCount : null;

  if (bookingConfirmationSms.accepted !== true) {
    return {
      type: 'booking_confirmation_sms_regression',
      severity: 'high',
      message: 'booking succeeded but patient confirmation SMS was not accepted by createEvent'
    };
  }

  if (!delivery) {
    return {
      type: 'booking_confirmation_sms_regression',
      severity: 'high',
      message: 'booking succeeded but createEvent returned no patient confirmation SMS delivery summary'
    };
  }

  if (recipientCount !== null && recipientCount < 1) {
    return {
      type: 'booking_confirmation_sms_regression',
      severity: 'high',
      message: 'booking succeeded but patient confirmation SMS had no recipient'
    };
  }

  if (status === 'failed') {
    return {
      type: 'booking_confirmation_sms_regression',
      severity: 'high',
      message: `booking succeeded but patient confirmation SMS failed (${provider || 'unknown provider'})`
    };
  }

  const externalNodes = safeArray(createEventTrace?.n8nLatency?.externalNodes);
  const hasDispatchEvidence = externalNodes.some((node) =>
    /dispatch booking (twilio|webhook) sms/i.test(String(node?.nodeName || ''))
  );
  if (
    provider
    && provider !== 'mock'
    && status === 'queued'
    && externalNodes.length > 0
    && !hasDispatchEvidence
  ) {
    return {
      type: 'booking_confirmation_sms_regression',
      severity: 'high',
      message: `booking succeeded but patient confirmation SMS was only marked queued with no dispatch trace in createEvent (${provider})`
    };
  }

  return null;
}

function renderReasonMessage(reason) {
  switch (reason.type) {
    case 'failure_category':
      return `failure category ${reason.code}`;
    case 'bad_boolean_output':
      return `${reason.output_name} returned true`;
    case 'scorecard_threshold':
      return `${reason.scorecard_name} scored ${reason.score_normalized} below ${reason.threshold}`;
    case 'latency_dominant_pause':
      return `model dominated a slow turn (${reason.max_latency_ms}ms max, ${reason.slow_turn_count} slow turns)`;
    case 'booking_confirmation_sms_regression':
      return reason.message || 'booking confirmation SMS regression detected';
    case 'speech_rendering_regression':
      return reason.message || 'speech rendering regression detected';
    case 'scorecards_missing':
      return 'no Vapi scorecards were attached to the call artifact';
    default:
      return reason.message || reason.code || 'review required';
  }
}

function evaluateRunAgainstPolicy(run, policy, rawCall = null) {
  const reasons = [];
  const coverageWarnings = [];
  let severity = 'none';
  const evaluation = run?.evaluation?.result || {};
  const latency = safeObject(run?.call?.latency_diagnostics) || {};
  const failureCategory = typeof evaluation.failure_category === 'string'
    ? evaluation.failure_category
    : 'other';

  if (!safeArray(policy.passingFailureCategories).includes(failureCategory)) {
    const mappedSeverity = policy.reviewFailureCategories?.[failureCategory] || 'medium';
    reasons.push({
      type: 'failure_category',
      code: failureCategory,
      severity: mappedSeverity
    });
    severity = maxSeverity(severity, mappedSeverity);
  }

  const outputs = safeArray(run?.observability?.structured_outputs);
  const outputsByCanonical = new Map(
    outputs.map((item) => [item.output_name_canonical || item.output_name, item])
  );
  for (const rule of safeArray(policy.badBooleanOutputs)) {
    const output = outputsByCanonical.get(rule.outputName) || null;
    if (output?.result === true) {
      reasons.push({
        type: 'bad_boolean_output',
        output_name: rule.outputName,
        severity: rule.severity || 'medium'
      });
      severity = maxSeverity(severity, rule.severity || 'medium');
    }
  }

  const scorecards = safeArray(run?.observability?.scorecards);
  if (scorecards.length === 0) {
    coverageWarnings.push({
      type: 'scorecards_missing',
      severity: 'medium'
    });
  }
  const scorecardsByCanonical = new Map(
    scorecards.map((item) => [item.name_canonical || normalizeScopedName(item.name), item])
  );
  for (const rule of safeArray(policy.scorecardThresholds)) {
    const scorecard = scorecardsByCanonical.get(rule.scorecardName) || null;
    if (!scorecard || typeof scorecard.score_normalized !== 'number') {
      continue;
    }
    if (typeof rule.criticalBelow === 'number' && scorecard.score_normalized < rule.criticalBelow) {
      reasons.push({
        type: 'scorecard_threshold',
        scorecard_name: rule.scorecardName,
        score_normalized: scorecard.score_normalized,
        threshold: rule.criticalBelow,
        severity: 'high'
      });
      severity = maxSeverity(severity, 'high');
      continue;
    }
    if (typeof rule.warnBelow === 'number' && scorecard.score_normalized < rule.warnBelow) {
      reasons.push({
        type: 'scorecard_threshold',
        scorecard_name: rule.scorecardName,
        score_normalized: scorecard.score_normalized,
        threshold: rule.warnBelow,
        severity: 'medium'
      });
      severity = maxSeverity(severity, 'medium');
    }
  }

  if (
    latency.dominantLatencyStage === 'model'
    && typeof latency.maxModelLatencyMs === 'number'
    && latency.maxModelLatencyMs >= MODEL_DOMINANT_REVIEW_THRESHOLD_MS
  ) {
    const latencySeverity =
      latency.maxModelLatencyMs >= MODEL_DOMINANT_HIGH_THRESHOLD_MS ? 'high' : 'medium';
    reasons.push({
      type: 'latency_dominant_pause',
      dominant_stage: 'model',
      max_latency_ms: latency.maxModelLatencyMs,
      slow_turn_count: typeof latency.slowTurnCount === 'number' ? latency.slowTurnCount : 0,
      severity: latencySeverity
    });
    severity = maxSeverity(severity, latencySeverity);
  }

  const bookingConfirmationSmsRegression = detectBookingConfirmationSmsRegression(run);
  if (bookingConfirmationSmsRegression) {
    reasons.push(bookingConfirmationSmsRegression);
    severity = maxSeverity(severity, bookingConfirmationSmsRegression.severity || 'high');
  }

  const speechRenderingFindings = detectSpeechRenderingIssues(run, rawCall);
  if (speechRenderingFindings.length > 0) {
    reasons.push({
      type: 'speech_rendering_regression',
      severity: 'high',
      findings: speechRenderingFindings,
      message: speechRenderingFindings.slice(0, 3).join('; ')
    });
    severity = maxSeverity(severity, 'high');
  }

  return {
    status: reasons.length > 0 ? 'review' : 'pass',
    requires_review: reasons.length > 0,
    severity,
    reason_count: reasons.length,
    reasons,
    coverage_warnings: coverageWarnings,
    failure_category: failureCategory
  };
}

function buildScorecardSummary(run) {
  return safeArray(run?.observability?.scorecards).map((scorecard) => ({
    name: scorecard.name,
    name_canonical: scorecard.name_canonical,
    score_normalized: scorecard.score_normalized
  }));
}

function sanitizeFileComponent(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function average(numbers) {
  if (numbers.length === 0) {
    return null;
  }
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function roundMaybe(value) {
  return typeof value === 'number' ? Math.round(value * 10) / 10 : null;
}

function summarizeSuite({
  suiteRunId,
  environment,
  assistantId,
  calls,
  reviews,
  suitePaths,
  startedAt,
  completedAt,
  policyPath,
  vapiTransportEnrichment = null,
  latencyEnrichment = null,
  edgeEnrichment = null
}) {
  const reviewCounts = { high: 0, medium: 0, low: 0 };
  const reasonCounts = new Map();
  const coverageWarningCounts = new Map();
  const scorecardBuckets = new Map();
  const dominantLatencyStageCounts = new Map();
  const maxModelLatencies = [];
  const maxTranscriberLatencies = [];
  const maxEndpointingLatencies = [];
  const maxToolRoundTripLatencies = [];
  const maxToolVapiWebhookLatencies = [];
  const maxToolVapiSpeechLatencies = [];
  const maxToolVapiWebhookToSpeechGaps = [];
  const maxToolVapiSpeechToToolResultBackfillGaps = [];
  const maxToolVapiWebhookToResultGaps = [];
  const maxToolBackendWorkflowLatencies = [];
  const maxToolBackendExternalLatencies = [];
  const maxToolBackendInternalLatencies = [];
  const maxToolDispatchGaps = [];
  const maxToolToEdgeStartGaps = [];
  const maxToolReturnGaps = [];
  const maxToolPlatformGaps = [];
  const maxToolEdgeDurations = [];
  const maxToolEdgeUpstreamDurations = [];
  const maxToolEdgeUpstreamLatencies = [];
  const maxToolEdgeIngressGaps = [];
  const maxToolEdgeObservedGaps = [];
  const maxToolEdgeEgressGaps = [];
  const maxToolEdgeToResultGaps = [];

  for (const call of calls) {
    if (call.review.requires_review) {
      const key = call.review.severity;
      reviewCounts[key] = (reviewCounts[key] || 0) + 1;
    }
    for (const reason of call.review.reasons) {
      const code = reason.type === 'failure_category'
        ? `failure:${reason.code}`
        : reason.type === 'bad_boolean_output'
          ? `boolean:${reason.output_name}`
          : reason.type === 'scorecard_threshold'
            ? `scorecard:${reason.scorecard_name}`
            : reason.type;
      reasonCounts.set(code, (reasonCounts.get(code) || 0) + 1);
    }
    for (const warning of call.review.coverage_warnings) {
      const code = warning.type;
      coverageWarningCounts.set(code, (coverageWarningCounts.get(code) || 0) + 1);
    }
    for (const scorecard of call.scorecards) {
      if (!scorecard.name_canonical || typeof scorecard.score_normalized !== 'number') {
        continue;
      }
      const bucket = scorecardBuckets.get(scorecard.name_canonical) || [];
      bucket.push(scorecard.score_normalized);
      scorecardBuckets.set(scorecard.name_canonical, bucket);
    }

    const latency = safeObject(call.latency_diagnostics);
    if (latency?.dominantLatencyStage) {
      dominantLatencyStageCounts.set(
        latency.dominantLatencyStage,
        (dominantLatencyStageCounts.get(latency.dominantLatencyStage) || 0) + 1
      );
    }
    if (typeof latency?.maxModelLatencyMs === 'number') {
      maxModelLatencies.push(latency.maxModelLatencyMs);
    }
    if (typeof latency?.maxTranscriberLatencyMs === 'number') {
      maxTranscriberLatencies.push(latency.maxTranscriberLatencyMs);
    }
    if (typeof latency?.maxEndpointingLatencyMs === 'number') {
      maxEndpointingLatencies.push(latency.maxEndpointingLatencyMs);
    }
    const maxToolRoundTripLatencyMs = typeof latency?.maxToolRoundTripLatencyMs === 'number'
      ? latency.maxToolRoundTripLatencyMs
      : latency?.maxWebhookLatencyMs;
    if (typeof maxToolRoundTripLatencyMs === 'number') {
      maxToolRoundTripLatencies.push(maxToolRoundTripLatencyMs);
    }
    if (typeof latency?.maxToolVapiWebhookLatencyMs === 'number') {
      maxToolVapiWebhookLatencies.push(latency.maxToolVapiWebhookLatencyMs);
    }
    if (typeof latency?.maxToolVapiSpeechLatencyMs === 'number') {
      maxToolVapiSpeechLatencies.push(latency.maxToolVapiSpeechLatencyMs);
    }
    if (typeof latency?.maxToolVapiWebhookToSpeechGapMs === 'number') {
      maxToolVapiWebhookToSpeechGaps.push(latency.maxToolVapiWebhookToSpeechGapMs);
    }
    if (typeof latency?.maxToolVapiSpeechToToolResultBackfillMs === 'number') {
      maxToolVapiSpeechToToolResultBackfillGaps.push(latency.maxToolVapiSpeechToToolResultBackfillMs);
    }
    if (typeof latency?.maxToolVapiWebhookToToolResultGapMs === 'number') {
      maxToolVapiWebhookToResultGaps.push(latency.maxToolVapiWebhookToToolResultGapMs);
    }
    if (typeof latency?.maxToolBackendWorkflowLatencyMs === 'number') {
      maxToolBackendWorkflowLatencies.push(latency.maxToolBackendWorkflowLatencyMs);
    }
    if (typeof latency?.maxToolBackendExternalLatencyMs === 'number') {
      maxToolBackendExternalLatencies.push(latency.maxToolBackendExternalLatencyMs);
    }
    if (typeof latency?.maxToolBackendInternalLatencyMs === 'number') {
      maxToolBackendInternalLatencies.push(latency.maxToolBackendInternalLatencyMs);
    }
    if (typeof latency?.maxToolDispatchGapMs === 'number') {
      maxToolDispatchGaps.push(latency.maxToolDispatchGapMs);
    }
    if (typeof latency?.maxToolToEdgeStartGapMs === 'number') {
      maxToolToEdgeStartGaps.push(latency.maxToolToEdgeStartGapMs);
    }
    if (typeof latency?.maxToolReturnGapMs === 'number') {
      maxToolReturnGaps.push(latency.maxToolReturnGapMs);
    }
    if (typeof latency?.maxToolPlatformGapMs === 'number') {
      maxToolPlatformGaps.push(latency.maxToolPlatformGapMs);
    }
    if (typeof latency?.maxToolEdgeDurationMs === 'number') {
      maxToolEdgeDurations.push(latency.maxToolEdgeDurationMs);
    }
    if (typeof latency?.maxToolEdgeUpstreamDurationMs === 'number') {
      maxToolEdgeUpstreamDurations.push(latency.maxToolEdgeUpstreamDurationMs);
    }
    if (typeof latency?.maxToolEdgeUpstreamLatencyMs === 'number') {
      maxToolEdgeUpstreamLatencies.push(latency.maxToolEdgeUpstreamLatencyMs);
    }
    if (typeof latency?.maxToolEdgeIngressGapMs === 'number') {
      maxToolEdgeIngressGaps.push(latency.maxToolEdgeIngressGapMs);
    }
    if (typeof latency?.maxToolEdgeObservedGapMs === 'number') {
      maxToolEdgeObservedGaps.push(latency.maxToolEdgeObservedGapMs);
    }
    if (typeof latency?.maxToolEdgeEgressGapMs === 'number') {
      maxToolEdgeEgressGaps.push(latency.maxToolEdgeEgressGapMs);
    }
    if (typeof latency?.maxToolEdgeToToolResultGapMs === 'number') {
      maxToolEdgeToResultGaps.push(latency.maxToolEdgeToToolResultGapMs);
    }
  }

  return {
    schema_version: 'vapi-live-autoeval-suite.v1',
    suite_run_id: suiteRunId,
    environment,
    assistant_id: assistantId,
    policy_path: policyPath,
    started_at: startedAt,
    completed_at: completedAt,
    call_count: calls.length,
    review_required_count: reviews.length,
    pass_count: calls.length - reviews.length,
    review_counts: reviewCounts,
    latency_summary: {
      average_max_model_latency_ms: roundMaybe(average(maxModelLatencies)),
      average_max_transcriber_latency_ms: roundMaybe(average(maxTranscriberLatencies)),
      average_max_endpointing_latency_ms: roundMaybe(average(maxEndpointingLatencies)),
      average_max_tool_round_trip_latency_ms: roundMaybe(average(maxToolRoundTripLatencies)),
      average_max_tool_vapi_webhook_latency_ms: roundMaybe(average(maxToolVapiWebhookLatencies)),
      average_max_tool_vapi_speech_latency_ms: roundMaybe(average(maxToolVapiSpeechLatencies)),
      average_max_tool_vapi_webhook_to_speech_gap_ms: roundMaybe(average(maxToolVapiWebhookToSpeechGaps)),
      average_max_tool_vapi_speech_to_tool_result_backfill_ms: roundMaybe(average(maxToolVapiSpeechToToolResultBackfillGaps)),
      average_max_tool_vapi_webhook_to_result_gap_ms: roundMaybe(average(maxToolVapiWebhookToResultGaps)),
      average_max_tool_backend_workflow_latency_ms: roundMaybe(average(maxToolBackendWorkflowLatencies)),
      average_max_tool_backend_external_latency_ms: roundMaybe(average(maxToolBackendExternalLatencies)),
      average_max_tool_backend_internal_latency_ms: roundMaybe(average(maxToolBackendInternalLatencies)),
      average_max_tool_dispatch_gap_ms: roundMaybe(average(maxToolDispatchGaps)),
      average_max_tool_to_edge_start_gap_ms: roundMaybe(average(maxToolToEdgeStartGaps)),
      average_max_tool_return_gap_ms: roundMaybe(average(maxToolReturnGaps)),
      average_max_tool_platform_gap_ms: roundMaybe(average(maxToolPlatformGaps)),
      average_max_tool_edge_duration_ms: roundMaybe(average(maxToolEdgeDurations)),
      average_max_tool_edge_upstream_duration_ms: roundMaybe(average(maxToolEdgeUpstreamDurations)),
      average_max_tool_edge_upstream_latency_ms: roundMaybe(average(maxToolEdgeUpstreamLatencies)),
      average_max_tool_edge_ingress_gap_ms: roundMaybe(average(maxToolEdgeIngressGaps)),
      average_max_tool_edge_observed_gap_ms: roundMaybe(average(maxToolEdgeObservedGaps)),
      average_max_tool_edge_egress_gap_ms: roundMaybe(average(maxToolEdgeEgressGaps)),
      average_max_tool_edge_to_result_gap_ms: roundMaybe(average(maxToolEdgeToResultGaps)),
      average_max_webhook_latency_ms: roundMaybe(average(maxToolRoundTripLatencies)),
      dominant_latency_stage_counts: Array.from(dominantLatencyStageCounts.entries())
        .map(([stage, count]) => ({ stage, count }))
        .sort((left, right) => right.count - left.count || left.stage.localeCompare(right.stage))
    },
    latency_enrichment: {
      enabled: Boolean(latencyEnrichment?.enabled),
      source: latencyEnrichment?.source || null,
      matched_trace_count: typeof latencyEnrichment?.matchedTraceCount === 'number'
        ? latencyEnrichment.matchedTraceCount
        : 0,
      total_trace_count: typeof latencyEnrichment?.totalTraceCount === 'number'
        ? latencyEnrichment.totalTraceCount
        : 0,
      unmatched_trace_count: Math.max(
        (typeof latencyEnrichment?.totalTraceCount === 'number' ? latencyEnrichment.totalTraceCount : 0)
          - (typeof latencyEnrichment?.matchedTraceCount === 'number' ? latencyEnrichment.matchedTraceCount : 0),
        0
      ),
      execution_count: typeof latencyEnrichment?.executionCount === 'number'
        ? latencyEnrichment.executionCount
        : 0,
      warning: typeof latencyEnrichment?.warning === 'string' ? latencyEnrichment.warning : null
    },
    vapi_transport_enrichment: {
      enabled: Boolean(vapiTransportEnrichment?.enabled),
      source: vapiTransportEnrichment?.source || null,
      matched_trace_count: typeof vapiTransportEnrichment?.matchedTraceCount === 'number'
        ? vapiTransportEnrichment.matchedTraceCount
        : 0,
      total_trace_count: typeof vapiTransportEnrichment?.totalTraceCount === 'number'
        ? vapiTransportEnrichment.totalTraceCount
        : 0,
      unmatched_trace_count: Math.max(
        (typeof vapiTransportEnrichment?.totalTraceCount === 'number'
          ? vapiTransportEnrichment.totalTraceCount
          : 0)
          - (typeof vapiTransportEnrichment?.matchedTraceCount === 'number'
            ? vapiTransportEnrichment.matchedTraceCount
            : 0),
        0
      ),
      transport_entry_count: typeof vapiTransportEnrichment?.transportEntryCount === 'number'
        ? vapiTransportEnrichment.transportEntryCount
        : 0,
      matched_speech_trace_count: typeof vapiTransportEnrichment?.matchedSpeechTraceCount === 'number'
        ? vapiTransportEnrichment.matchedSpeechTraceCount
        : 0,
      total_speech_trace_count: typeof vapiTransportEnrichment?.totalSpeechTraceCount === 'number'
        ? vapiTransportEnrichment.totalSpeechTraceCount
        : 0,
      speech_entry_count: typeof vapiTransportEnrichment?.speechEntryCount === 'number'
        ? vapiTransportEnrichment.speechEntryCount
        : 0,
      warning: typeof vapiTransportEnrichment?.warning === 'string' ? vapiTransportEnrichment.warning : null
    },
    edge_latency_enrichment: {
      enabled: Boolean(edgeEnrichment?.enabled),
      source: edgeEnrichment?.source || null,
      matched_trace_count: typeof edgeEnrichment?.matchedTraceCount === 'number'
        ? edgeEnrichment.matchedTraceCount
        : 0,
      total_trace_count: typeof edgeEnrichment?.totalTraceCount === 'number'
        ? edgeEnrichment.totalTraceCount
        : 0,
      unmatched_trace_count: Math.max(
        (typeof edgeEnrichment?.totalTraceCount === 'number' ? edgeEnrichment.totalTraceCount : 0)
          - (typeof edgeEnrichment?.matchedTraceCount === 'number' ? edgeEnrichment.matchedTraceCount : 0),
        0
      ),
      access_entry_count: typeof edgeEnrichment?.accessEntryCount === 'number'
        ? edgeEnrichment.accessEntryCount
        : 0,
      warning: typeof edgeEnrichment?.warning === 'string' ? edgeEnrichment.warning : null
    },
    average_scorecards: Array.from(scorecardBuckets.entries()).map(([name, values]) => ({
      name,
      average_score_normalized: roundMaybe(average(values))
    })),
    reason_counts: Array.from(reasonCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    coverage_warning_counts: Array.from(coverageWarningCounts.entries())
      .map(([warning, count]) => ({ warning, count }))
      .sort((left, right) => right.count - left.count || left.warning.localeCompare(right.warning)),
    report_path: path.relative(ROOT_DIR, suitePaths.reportPath),
    run_dir: path.relative(ROOT_DIR, suitePaths.runDir),
    calls: calls.map((call) => ({
      call_id: call.call_id,
      ended_at: call.ended_at,
      run_path: call.run_path,
      raw_call_path: call.raw_call_path,
      failure_category: call.failure_category,
      severity: call.review.severity,
      requires_review: call.review.requires_review,
      scorecards: call.scorecards,
      latency_diagnostics: call.latency_diagnostics,
      summary: call.summary,
      coverage_warnings: call.review.coverage_warnings.map((warning) => ({
        ...warning,
        rendered_message: renderReasonMessage(warning)
      })),
      reasons: call.review.reasons.map((reason) => ({
        ...reason,
        rendered_message: renderReasonMessage(reason)
      }))
    }))
  };
}

function renderSuiteReport(summary) {
  const lines = [
    '# Vapi Live Autoevaluation',
    '',
    `- Suite run: \`${summary.suite_run_id}\``,
    `- Environment: \`${summary.environment}\``,
    `- Assistant: \`${summary.assistant_id}\``,
    `- Started: \`${summary.started_at}\``,
    `- Completed: \`${summary.completed_at}\``,
    `- Calls reviewed: ${summary.call_count}`,
    `- Review required: ${summary.review_required_count}`,
    `- Passed without review: ${summary.pass_count}`,
    `- Policy: \`${summary.policy_path}\``,
    ''
  ];

  if (summary.average_scorecards.length > 0) {
    lines.push('## Average Scorecards', '');
    for (const scorecard of summary.average_scorecards) {
      lines.push(`- ${scorecard.name}: ${scorecard.average_score_normalized}`);
    }
    lines.push('');
  }

  const latencySummary = safeObject(summary.latency_summary) || {};
  const vapiTransportEnrichment = safeObject(summary.vapi_transport_enrichment) || {};
  const latencyEnrichment = safeObject(summary.latency_enrichment) || {};
  const edgeLatencyEnrichment = safeObject(summary.edge_latency_enrichment) || {};
  if (
    typeof latencySummary.average_max_model_latency_ms === 'number'
    || typeof latencySummary.average_max_transcriber_latency_ms === 'number'
    || typeof latencySummary.average_max_endpointing_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_round_trip_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_vapi_webhook_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_vapi_speech_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_vapi_webhook_to_speech_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_vapi_speech_to_tool_result_backfill_ms === 'number'
    || typeof latencySummary.average_max_tool_vapi_webhook_to_result_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_backend_workflow_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_backend_external_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_backend_internal_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_dispatch_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_to_edge_start_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_return_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_platform_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_edge_duration_ms === 'number'
    || typeof latencySummary.average_max_tool_edge_upstream_duration_ms === 'number'
    || typeof latencySummary.average_max_tool_edge_upstream_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_edge_ingress_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_edge_observed_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_edge_egress_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_edge_to_result_gap_ms === 'number'
    || typeof latencySummary.average_max_webhook_latency_ms === 'number'
    || latencyEnrichment.warning
    || edgeLatencyEnrichment.warning
    || latencyEnrichment.enabled
    || edgeLatencyEnrichment.enabled
    || safeArray(latencySummary.dominant_latency_stage_counts).length > 0
  ) {
    lines.push('## Latency Summary', '');
    if (typeof latencySummary.average_max_model_latency_ms === 'number') {
      lines.push(`- Average max model latency: ${latencySummary.average_max_model_latency_ms}ms`);
    }
    if (typeof latencySummary.average_max_transcriber_latency_ms === 'number') {
      lines.push(`- Average max transcriber latency: ${latencySummary.average_max_transcriber_latency_ms}ms`);
    }
    if (typeof latencySummary.average_max_endpointing_latency_ms === 'number') {
      lines.push(`- Average max endpointing latency: ${latencySummary.average_max_endpointing_latency_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_round_trip_latency_ms === 'number') {
      lines.push(`- Average max tool round-trip latency: ${latencySummary.average_max_tool_round_trip_latency_ms}ms`);
      lines.push('- Tool round-trip latency is inferred from Vapi tool-call and tool-result timestamps; it is not raw backend runtime.');
    } else if (typeof latencySummary.average_max_webhook_latency_ms === 'number') {
      lines.push(`- Average max tool round-trip latency: ${latencySummary.average_max_webhook_latency_ms}ms`);
      lines.push('- Tool round-trip latency is inferred from Vapi tool-call and tool-result timestamps; it is not raw backend runtime.');
    }
    if (typeof latencySummary.average_max_tool_vapi_webhook_latency_ms === 'number') {
      lines.push(`- Average max Vapi webhook request latency: ${latencySummary.average_max_tool_vapi_webhook_latency_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_vapi_speech_latency_ms === 'number') {
      lines.push(`- Average max tool-to-speech latency: ${latencySummary.average_max_tool_vapi_speech_latency_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_vapi_webhook_to_speech_gap_ms === 'number') {
      lines.push(`- Average max Vapi webhook-to-speech gap: ${latencySummary.average_max_tool_vapi_webhook_to_speech_gap_ms}ms`);
      lines.push('- Webhook-to-speech gap tracks the first non-wait assistant speech after the webhook returned, which is closer to caller-perceived latency than delayed tool-result bookkeeping.');
    }
    if (typeof latencySummary.average_max_tool_vapi_speech_to_tool_result_backfill_ms === 'number') {
      lines.push(`- Average max Vapi speech-to-tool-result backfill gap: ${latencySummary.average_max_tool_vapi_speech_to_tool_result_backfill_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_vapi_webhook_to_result_gap_ms === 'number') {
      lines.push(`- Average max Vapi webhook-to-result gap: ${latencySummary.average_max_tool_vapi_webhook_to_result_gap_ms}ms`);
      lines.push('- Webhook-to-result gap can stay high even after the caller already heard the answer because Vapi often backfills tool-result bookkeeping later.');
    }
    if (typeof latencySummary.average_max_tool_dispatch_gap_ms === 'number') {
      lines.push(`- Average max tool dispatch gap: ${latencySummary.average_max_tool_dispatch_gap_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_to_edge_start_gap_ms === 'number') {
      lines.push(`- Average max tool-to-edge start gap: ${latencySummary.average_max_tool_to_edge_start_gap_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_backend_workflow_latency_ms === 'number') {
      lines.push(`- Average max tool backend workflow latency: ${latencySummary.average_max_tool_backend_workflow_latency_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_backend_external_latency_ms === 'number') {
      lines.push(`- Average max tool backend external latency: ${latencySummary.average_max_tool_backend_external_latency_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_backend_internal_latency_ms === 'number') {
      lines.push(`- Average max tool backend internal latency: ${latencySummary.average_max_tool_backend_internal_latency_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_edge_duration_ms === 'number') {
      lines.push(`- Average max edge request duration: ${latencySummary.average_max_tool_edge_duration_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_edge_upstream_duration_ms === 'number') {
      lines.push(`- Average max edge upstream duration: ${latencySummary.average_max_tool_edge_upstream_duration_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_edge_upstream_latency_ms === 'number') {
      lines.push(`- Average max edge upstream header latency: ${latencySummary.average_max_tool_edge_upstream_latency_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_edge_ingress_gap_ms === 'number') {
      lines.push(`- Average max edge ingress gap: ${latencySummary.average_max_tool_edge_ingress_gap_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_edge_observed_gap_ms === 'number') {
      lines.push(`- Average max edge observed gap: ${latencySummary.average_max_tool_edge_observed_gap_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_edge_egress_gap_ms === 'number') {
      lines.push(`- Average max edge egress gap: ${latencySummary.average_max_tool_edge_egress_gap_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_return_gap_ms === 'number') {
      lines.push(`- Average max tool return gap: ${latencySummary.average_max_tool_return_gap_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_edge_to_result_gap_ms === 'number') {
      lines.push(`- Average max edge-to-result gap: ${latencySummary.average_max_tool_edge_to_result_gap_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_platform_gap_ms === 'number') {
      lines.push(`- Average max tool platform gap: ${latencySummary.average_max_tool_platform_gap_ms}ms`);
      lines.push('- Backend workflow/external/internal timings come from matched n8n event logs. Tool-to-edge start and edge-to-result gaps come from matched Caddy access logs. Platform gap remains the full round-trip share outside the matched n8n workflow runtime.');
    }
    if (edgeLatencyEnrichment.warning) {
      lines.push(`- Edge latency enrichment warning: ${edgeLatencyEnrichment.warning}`);
    } else if (edgeLatencyEnrichment.enabled) {
      if (edgeLatencyEnrichment.total_trace_count > 0) {
        lines.push(
          `- Edge latency enrichment: matched ${edgeLatencyEnrichment.matched_trace_count || 0} of ${edgeLatencyEnrichment.total_trace_count} tool traces across ${edgeLatencyEnrichment.access_entry_count || 0} Caddy access entries.`
        );
      } else {
        lines.push('- Edge latency enrichment: no completed tool traces required matching.');
      }
    }
    if (vapiTransportEnrichment.warning) {
      lines.push(`- Vapi transport enrichment warning: ${vapiTransportEnrichment.warning}`);
    } else if (vapiTransportEnrichment.enabled) {
      if (vapiTransportEnrichment.total_trace_count > 0) {
        lines.push(
          `- Vapi transport enrichment: matched ${vapiTransportEnrichment.matched_trace_count || 0} of ${vapiTransportEnrichment.total_trace_count} tool traces across ${vapiTransportEnrichment.transport_entry_count || 0} artifact webhook entries.`
        );
        if (vapiTransportEnrichment.total_speech_trace_count > 0) {
          lines.push(
            `- Vapi speech enrichment: matched ${vapiTransportEnrichment.matched_speech_trace_count || 0} of ${vapiTransportEnrichment.total_speech_trace_count} tool traces across ${vapiTransportEnrichment.speech_entry_count || 0} assistant voice events.`
          );
        }
      } else {
        lines.push('- Vapi transport enrichment: no completed tool traces required matching.');
      }
    }
    if (latencyEnrichment.warning) {
      lines.push(`- N8N latency enrichment warning: ${latencyEnrichment.warning}`);
    } else if (latencyEnrichment.enabled) {
      if (latencyEnrichment.total_trace_count > 0) {
        lines.push(
          `- N8N latency enrichment: matched ${latencyEnrichment.matched_trace_count || 0} of ${latencyEnrichment.total_trace_count} tool traces across ${latencyEnrichment.execution_count || 0} executions.`
        );
      } else {
        lines.push('- N8N latency enrichment: no completed tool traces required matching.');
      }
    }
    for (const item of safeArray(latencySummary.dominant_latency_stage_counts)) {
      lines.push(`- Dominant stage ${item.stage}: ${item.count}`);
    }
    lines.push('');
  }

  if (summary.reason_counts.length > 0) {
    lines.push('## Review Reasons', '');
    for (const item of summary.reason_counts) {
      lines.push(`- ${item.reason}: ${item.count}`);
    }
    lines.push('');
  }

  if (summary.coverage_warning_counts.length > 0) {
    lines.push('## Coverage Warnings', '');
    for (const item of summary.coverage_warning_counts) {
      lines.push(`- ${item.warning}: ${item.count}`);
    }
    lines.push('');
  }

  const flagged = summary.calls.filter((call) => call.requires_review);
  lines.push('## Flagged Calls', '');
  if (flagged.length === 0) {
    lines.push('- None.');
  } else {
    for (const call of flagged.sort((left, right) => {
      const severityDiff = severityRank(right.severity) - severityRank(left.severity);
      if (severityDiff !== 0) {
        return severityDiff;
      }
      return String(right.ended_at || '').localeCompare(String(left.ended_at || ''));
    })) {
      lines.push(`### ${call.call_id}`);
      lines.push('');
      lines.push(`- Ended: \`${call.ended_at || 'unknown'}\``);
      lines.push(`- Severity: **${String(call.severity || 'medium').toUpperCase()}**`);
      lines.push(`- Failure category: \`${call.failure_category || 'other'}\``);
      if (call.summary) {
        lines.push(`- Summary: ${call.summary}`);
      }
      if (call.scorecards.length > 0) {
        lines.push(`- Scorecards: ${call.scorecards.map((scorecard) => `${scorecard.name_canonical || scorecard.name}=${scorecard.score_normalized}`).join(', ')}`);
      }
      if (call.latency_diagnostics) {
        const latency = call.latency_diagnostics;
        const latencyParts = [];
        if (typeof latency.maxModelLatencyMs === 'number') {
          latencyParts.push(`model=${latency.maxModelLatencyMs}ms`);
        }
        if (typeof latency.maxTranscriberLatencyMs === 'number') {
          latencyParts.push(`transcriber=${latency.maxTranscriberLatencyMs}ms`);
        }
        if (typeof latency.maxEndpointingLatencyMs === 'number') {
          latencyParts.push(`endpointing=${latency.maxEndpointingLatencyMs}ms`);
        }
        const maxToolRoundTripLatencyMs = typeof latency.maxToolRoundTripLatencyMs === 'number'
          ? latency.maxToolRoundTripLatencyMs
          : latency.maxWebhookLatencyMs;
        if (typeof maxToolRoundTripLatencyMs === 'number') {
          latencyParts.push(`tool_round_trip=${maxToolRoundTripLatencyMs}ms`);
        }
        if (typeof latency.maxToolVapiWebhookLatencyMs === 'number') {
          latencyParts.push(`vapi_webhook=${latency.maxToolVapiWebhookLatencyMs}ms`);
        }
        if (typeof latency.maxToolVapiSpeechLatencyMs === 'number') {
          latencyParts.push(`tool_speech=${latency.maxToolVapiSpeechLatencyMs}ms`);
        }
        if (typeof latency.maxToolVapiWebhookToSpeechGapMs === 'number') {
          latencyParts.push(`vapi_webhook_to_speech=${latency.maxToolVapiWebhookToSpeechGapMs}ms`);
        }
        if (typeof latency.maxToolVapiSpeechToToolResultBackfillMs === 'number') {
          latencyParts.push(`speech_to_result_backfill=${latency.maxToolVapiSpeechToToolResultBackfillMs}ms`);
        }
        if (typeof latency.maxToolVapiWebhookToToolResultGapMs === 'number') {
          latencyParts.push(`vapi_webhook_to_result=${latency.maxToolVapiWebhookToToolResultGapMs}ms`);
        }
        if (typeof latency.maxToolDispatchGapMs === 'number') {
          latencyParts.push(`dispatch=${latency.maxToolDispatchGapMs}ms`);
        }
        if (typeof latency.maxToolToEdgeStartGapMs === 'number') {
          latencyParts.push(`to_edge=${latency.maxToolToEdgeStartGapMs}ms`);
        }
        if (typeof latency.maxToolBackendWorkflowLatencyMs === 'number') {
          latencyParts.push(`backend=${latency.maxToolBackendWorkflowLatencyMs}ms`);
        }
        if (typeof latency.maxToolBackendExternalLatencyMs === 'number') {
          latencyParts.push(`backend_external=${latency.maxToolBackendExternalLatencyMs}ms`);
        }
        if (typeof latency.maxToolBackendInternalLatencyMs === 'number') {
          latencyParts.push(`backend_internal=${latency.maxToolBackendInternalLatencyMs}ms`);
        }
        if (typeof latency.maxToolEdgeDurationMs === 'number') {
          latencyParts.push(`edge=${latency.maxToolEdgeDurationMs}ms`);
        }
        if (typeof latency.maxToolEdgeUpstreamDurationMs === 'number') {
          latencyParts.push(`edge_upstream=${latency.maxToolEdgeUpstreamDurationMs}ms`);
        }
        if (typeof latency.maxToolEdgeIngressGapMs === 'number') {
          latencyParts.push(`edge_ingress=${latency.maxToolEdgeIngressGapMs}ms`);
        }
        if (typeof latency.maxToolEdgeObservedGapMs === 'number') {
          latencyParts.push(`edge_observed=${latency.maxToolEdgeObservedGapMs}ms`);
        }
        if (typeof latency.maxToolEdgeEgressGapMs === 'number') {
          latencyParts.push(`edge_egress=${latency.maxToolEdgeEgressGapMs}ms`);
        }
        if (typeof latency.maxToolReturnGapMs === 'number') {
          latencyParts.push(`return=${latency.maxToolReturnGapMs}ms`);
        }
        if (typeof latency.maxToolEdgeToToolResultGapMs === 'number') {
          latencyParts.push(`edge_to_result=${latency.maxToolEdgeToToolResultGapMs}ms`);
        }
        if (typeof latency.maxToolPlatformGapMs === 'number') {
          latencyParts.push(`platform=${latency.maxToolPlatformGapMs}ms`);
        }
        if (latency.dominantLatencyStage) {
          latencyParts.push(`dominant=${latency.dominantLatencyStage}`);
        }
        if (typeof latency.slowTurnCount === 'number') {
          latencyParts.push(`slow_turns=${latency.slowTurnCount}`);
        }
        if (latencyParts.length > 0) {
          lines.push(`- Latency: ${latencyParts.join(', ')}`);
        }
        const slowestToolTrace = safeObject(latency.slowestToolTrace);
        if (slowestToolTrace) {
          const detailParts = [];
          if (typeof slowestToolTrace.roundTripMs === 'number') {
            detailParts.push(`round_trip=${slowestToolTrace.roundTripMs}ms`);
          }
          if (typeof slowestToolTrace.vapiWebhookLatencyMs === 'number') {
            detailParts.push(`vapi_webhook=${slowestToolTrace.vapiWebhookLatencyMs}ms`);
          }
          if (typeof slowestToolTrace.vapiSpeechLatencyMs === 'number') {
            detailParts.push(`tool_speech=${slowestToolTrace.vapiSpeechLatencyMs}ms`);
          }
          if (typeof slowestToolTrace.vapiWebhookToSpeechGapMs === 'number') {
            detailParts.push(`vapi_webhook_to_speech=${slowestToolTrace.vapiWebhookToSpeechGapMs}ms`);
          }
          if (typeof slowestToolTrace.vapiSpeechToToolResultBackfillMs === 'number') {
            detailParts.push(`speech_to_result_backfill=${slowestToolTrace.vapiSpeechToToolResultBackfillMs}ms`);
          }
          if (typeof slowestToolTrace.vapiWebhookToToolResultGapMs === 'number') {
            detailParts.push(`vapi_webhook_to_result=${slowestToolTrace.vapiWebhookToToolResultGapMs}ms`);
          }
          if (typeof slowestToolTrace.dispatchGapMs === 'number') {
            detailParts.push(`dispatch=${slowestToolTrace.dispatchGapMs}ms`);
          }
          if (typeof slowestToolTrace.toolToEdgeStartGapMs === 'number') {
            detailParts.push(`to_edge=${slowestToolTrace.toolToEdgeStartGapMs}ms`);
          }
          if (typeof slowestToolTrace.backendWorkflowLatencyMs === 'number') {
            const backendParts = [`backend=${slowestToolTrace.backendWorkflowLatencyMs}ms`];
            if (
              typeof slowestToolTrace.backendExternalLatencyMs === 'number'
              || typeof slowestToolTrace.backendInternalLatencyMs === 'number'
            ) {
              const subparts = [];
              if (typeof slowestToolTrace.backendExternalLatencyMs === 'number') {
                subparts.push(`external=${slowestToolTrace.backendExternalLatencyMs}ms`);
              }
              if (typeof slowestToolTrace.backendInternalLatencyMs === 'number') {
                subparts.push(`internal=${slowestToolTrace.backendInternalLatencyMs}ms`);
              }
              backendParts.push(`(${subparts.join(', ')})`);
            }
            detailParts.push(backendParts.join(' '));
          }
          if (typeof slowestToolTrace.edgeDurationMs === 'number') {
            const edgeParts = [`edge=${slowestToolTrace.edgeDurationMs}ms`];
            if (
              typeof slowestToolTrace.edgeUpstreamDurationMs === 'number'
              || typeof slowestToolTrace.edgeUpstreamLatencyMs === 'number'
            ) {
              const subparts = [];
              if (typeof slowestToolTrace.edgeUpstreamDurationMs === 'number') {
                subparts.push(`upstream=${slowestToolTrace.edgeUpstreamDurationMs}ms`);
              }
              if (typeof slowestToolTrace.edgeUpstreamLatencyMs === 'number') {
                subparts.push(`header=${slowestToolTrace.edgeUpstreamLatencyMs}ms`);
              }
              edgeParts.push(`(${subparts.join(', ')})`);
            }
            detailParts.push(edgeParts.join(' '));
          }
          if (typeof slowestToolTrace.edgeIngressGapMs === 'number') {
            detailParts.push(`edge_ingress=${slowestToolTrace.edgeIngressGapMs}ms`);
          }
          if (typeof slowestToolTrace.edgeObservedGapMs === 'number') {
            detailParts.push(`edge_observed=${slowestToolTrace.edgeObservedGapMs}ms`);
          }
          if (typeof slowestToolTrace.edgeEgressGapMs === 'number') {
            detailParts.push(`edge_egress=${slowestToolTrace.edgeEgressGapMs}ms`);
          }
          if (typeof slowestToolTrace.returnGapMs === 'number') {
            detailParts.push(`return=${slowestToolTrace.returnGapMs}ms`);
          }
          if (typeof slowestToolTrace.edgeToToolResultGapMs === 'number') {
            detailParts.push(`edge_to_result=${slowestToolTrace.edgeToToolResultGapMs}ms`);
          }
          if (typeof slowestToolTrace.platformGapMs === 'number') {
            detailParts.push(`platform=${slowestToolTrace.platformGapMs}ms`);
          }
          if (typeof slowestToolTrace.edgeStatus === 'number') {
            detailParts.push(`edge_status=${slowestToolTrace.edgeStatus}`);
          }
          if (typeof slowestToolTrace.vapiWebhookSuccess === 'boolean') {
            detailParts.push(`vapi_webhook_success=${slowestToolTrace.vapiWebhookSuccess}`);
          }
          if (typeof slowestToolTrace.vapiWebhookHasRetries === 'boolean') {
            detailParts.push(`vapi_webhook_retries=${slowestToolTrace.vapiWebhookHasRetries}`);
          }
          if (slowestToolTrace.vapiWebhookErrorMessage) {
            detailParts.push(`vapi_webhook_error=${JSON.stringify(slowestToolTrace.vapiWebhookErrorMessage)}`);
          }
          if (slowestToolTrace.executionId) {
            detailParts.push(`execution=${slowestToolTrace.executionId}`);
          }
          if (detailParts.length > 0) {
            lines.push(`- Slowest tool trace: ${slowestToolTrace.toolName || 'unknown'} ${detailParts.join(', ')}`);
          }
        }
      }
      lines.push(`- Run path: \`${call.run_path}\``);
      if (call.raw_call_path) {
        lines.push(`- Raw call path: \`${call.raw_call_path}\``);
      }
      for (const reason of call.reasons) {
        lines.push(`- Review reason: ${reason.rendered_message}`);
      }
      for (const warning of call.coverage_warnings) {
        lines.push(`- Coverage warning: ${warning.rendered_message}`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const suiteRunId = `${options.environment}-vapi-live-autoeval-${compactTimestamp()}`;
  const suitePaths = buildSuitePaths(suiteRunId, options);
  if (suitePaths.rawCallsDir) {
    fs.mkdirSync(suitePaths.rawCallsDir, { recursive: true });
  }
  fs.mkdirSync(suitePaths.normalizedRunsDir, { recursive: true });

  const policy = readJson(POLICY_PATH);
  const context = buildAssistantContext(options.environment);
  const startedAt = stableTimestamp();

  let recentCalls;
  if (options.callIds.length > 0) {
    recentCalls = options.callIds.map((callId) => ({ id: callId }));
  } else {
    recentCalls = await fetchRecentCalls({
      assistantId: context.assistantId,
      apiKey: context.apiKey,
      baseUrl: context.baseUrl,
      limit: options.limit
    });
  }

  const eligibleCalls = recentCalls
    .filter((call) => Boolean(call?.id))
    .filter((call) => options.callIds.length > 0 || (isEndedCall(call) && withinSinceHours(call, options.sinceHours)));

  const suiteRuns = [];
  for (let index = 0; index < eligibleCalls.length; index += 1) {
    const callStub = eligibleCalls[index];
    const fullCall = await fetchCallById({
      callId: callStub.id,
      apiKey: context.apiKey,
      baseUrl: context.baseUrl
    });
    if (!isEndedCall(fullCall)) {
      continue;
    }
    if (options.callIds.length === 0 && !withinSinceHours(fullCall, options.sinceHours)) {
      continue;
    }

    const safeCallId = sanitizeFileComponent(fullCall.id || `call-${index}`);
    let rawCallPath = null;
    if (suitePaths.rawCallsDir) {
      rawCallPath = path.join(suitePaths.rawCallsDir, `${safeCallId}.call.json`);
      writeJson(rawCallPath, fullCall);
    }

    const run = buildRun(
      {
        record: fullCall,
        wrapper: fullCall,
        index,
        sourceKind: 'api_call_fetch'
      },
      {
        scenarioId: null,
        environment: options.environment,
        runKind: 'real_call'
      },
      rawCallPath
    );

    const normalizedRunPath = path.join(suitePaths.normalizedRunsDir, `${run.run_id}.run.v1.json`);
    suiteRuns.push({
      run,
      fullCall,
      rawCallPath,
      normalizedRunPath
    });
  }

  const vapiTransportEnrichment = await enrichSuiteRunsWithVapiWebhookTransport(suiteRuns);
  const latencyEnrichment = await enrichSuiteRunsWithN8nLatency(suiteRuns, options.environment);
  const edgeEnrichment = await enrichSuiteRunsWithCaddyEdgeLatency(suiteRuns, options.environment);
  refreshSuiteRunLatencyDiagnostics(suiteRuns);

  const calls = [];
  for (const suiteRun of suiteRuns) {
    writeRun(suiteRun.run, suiteRun.normalizedRunPath);

    const review = evaluateRunAgainstPolicy(suiteRun.run, policy, suiteRun.fullCall);
    calls.push({
      call_id: suiteRun.run.call.call_id,
      ended_at: suiteRun.run.call.ended_at,
      raw_call_path: suiteRun.rawCallPath ? path.relative(ROOT_DIR, suiteRun.rawCallPath) : null,
      run_path: path.relative(ROOT_DIR, suiteRun.normalizedRunPath),
      failure_category: suiteRun.run.evaluation?.result?.failure_category || 'other',
      summary: suiteRun.run.evaluation?.result?.summary || null,
      scorecards: buildScorecardSummary(suiteRun.run),
      latency_diagnostics: suiteRun.run.call?.latency_diagnostics || null,
      review
    });
  }

  const completedAt = stableTimestamp();
  const reviews = calls.filter((call) => call.review.requires_review);
  const summary = summarizeSuite({
    suiteRunId,
    environment: options.environment,
    assistantId: context.assistantId,
    calls,
    reviews,
    suitePaths,
    startedAt,
    completedAt,
    policyPath: path.relative(ROOT_DIR, POLICY_PATH),
    vapiTransportEnrichment,
    latencyEnrichment,
    edgeEnrichment
  });

  writeJson(path.join(suitePaths.runDir, 'suite.summary.json'), summary);
  fs.mkdirSync(path.dirname(suitePaths.reportPath), { recursive: true });
  fs.writeFileSync(suitePaths.reportPath, renderSuiteReport(summary), 'utf8');

  if (options.summaryJson) {
    writeJson(options.summaryJson, summary);
  }

  console.log(
    `Vapi live autoevaluation ${suiteRunId}: ${summary.review_required_count} flagged, ${summary.pass_count} passed\n`
    + `Artifacts: ${summary.run_dir}\n`
    + `Report: ${summary.report_path}`
  );

  if (options.failOnReview && summary.review_required_count > 0) {
    process.exit(2);
  }
}

module.exports = {
  buildSshContext,
  buildN8nExecutionSummaries,
  buildToolTraceRefs,
  enrichSuiteRunsWithVapiWebhookTransport,
  enrichSuiteRunsWithCaddyEdgeLatency,
  enrichSuiteRunsWithN8nLatency,
  matchToolTracesToVapiSpeechEntries,
  matchToolTracesToVapiWebhookEntries,
  matchToolTracesToCaddyEntries,
  matchToolTracesToExecutions,
  parseVapiArtifactAssistantSpeechEntries,
  parseVapiArtifactWebhookEntries,
  parseCaddyAccessLogBundle,
  parseN8nEventLogBundle,
  renderSuiteReport,
  summarizeSuite
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
