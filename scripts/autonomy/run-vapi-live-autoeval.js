#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
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
const MODEL_DOMINANT_REVIEW_THRESHOLD_MS = 4000;
const MODEL_DOMINANT_HIGH_THRESHOLD_MS = 7000;
const SPEECH_RENDERING_TOOL_NAMES = new Set(['checkAvailability', 'lookupPatient', 'createEvent']);
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

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  const container = readContextEnv(environment, 'VPS_N8N_CONTAINER_NAME', 'VPS_N8N_CONTAINER_NAME');

  if (!host || !user || !container) {
    return null;
  }

  return {
    host,
    user,
    port,
    identityFile,
    container
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
    sshContext.container
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
        workflowId
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

    for (const suiteRun of safeArray(suiteRuns)) {
      suiteRun.run.call.latency_diagnostics = deriveLatencyDiagnostics(suiteRun.fullCall, suiteRun.run.tool_trace);
    }

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
  latencyEnrichment = null
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
  const maxToolBackendWorkflowLatencies = [];
  const maxToolBackendExternalLatencies = [];
  const maxToolBackendInternalLatencies = [];
  const maxToolDispatchGaps = [];
  const maxToolReturnGaps = [];
  const maxToolPlatformGaps = [];

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
    if (typeof latency?.maxToolReturnGapMs === 'number') {
      maxToolReturnGaps.push(latency.maxToolReturnGapMs);
    }
    if (typeof latency?.maxToolPlatformGapMs === 'number') {
      maxToolPlatformGaps.push(latency.maxToolPlatformGapMs);
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
      average_max_tool_backend_workflow_latency_ms: roundMaybe(average(maxToolBackendWorkflowLatencies)),
      average_max_tool_backend_external_latency_ms: roundMaybe(average(maxToolBackendExternalLatencies)),
      average_max_tool_backend_internal_latency_ms: roundMaybe(average(maxToolBackendInternalLatencies)),
      average_max_tool_dispatch_gap_ms: roundMaybe(average(maxToolDispatchGaps)),
      average_max_tool_return_gap_ms: roundMaybe(average(maxToolReturnGaps)),
      average_max_tool_platform_gap_ms: roundMaybe(average(maxToolPlatformGaps)),
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
  const latencyEnrichment = safeObject(summary.latency_enrichment) || {};
  if (
    typeof latencySummary.average_max_model_latency_ms === 'number'
    || typeof latencySummary.average_max_transcriber_latency_ms === 'number'
    || typeof latencySummary.average_max_endpointing_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_round_trip_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_backend_workflow_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_backend_external_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_backend_internal_latency_ms === 'number'
    || typeof latencySummary.average_max_tool_dispatch_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_return_gap_ms === 'number'
    || typeof latencySummary.average_max_tool_platform_gap_ms === 'number'
    || typeof latencySummary.average_max_webhook_latency_ms === 'number'
    || latencyEnrichment.warning
    || latencyEnrichment.enabled
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
    if (typeof latencySummary.average_max_tool_dispatch_gap_ms === 'number') {
      lines.push(`- Average max tool dispatch gap: ${latencySummary.average_max_tool_dispatch_gap_ms}ms`);
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
    if (typeof latencySummary.average_max_tool_return_gap_ms === 'number') {
      lines.push(`- Average max tool return gap: ${latencySummary.average_max_tool_return_gap_ms}ms`);
    }
    if (typeof latencySummary.average_max_tool_platform_gap_ms === 'number') {
      lines.push(`- Average max tool platform gap: ${latencySummary.average_max_tool_platform_gap_ms}ms`);
      lines.push('- Backend workflow/external/internal timings come from matched n8n event logs. Platform gap is the part of tool round-trip outside the matched n8n workflow runtime.');
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
        if (typeof latency.maxToolDispatchGapMs === 'number') {
          latencyParts.push(`dispatch=${latency.maxToolDispatchGapMs}ms`);
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
        if (typeof latency.maxToolReturnGapMs === 'number') {
          latencyParts.push(`return=${latency.maxToolReturnGapMs}ms`);
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
          if (typeof slowestToolTrace.dispatchGapMs === 'number') {
            detailParts.push(`dispatch=${slowestToolTrace.dispatchGapMs}ms`);
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
          if (typeof slowestToolTrace.returnGapMs === 'number') {
            detailParts.push(`return=${slowestToolTrace.returnGapMs}ms`);
          }
          if (typeof slowestToolTrace.platformGapMs === 'number') {
            detailParts.push(`platform=${slowestToolTrace.platformGapMs}ms`);
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

  const latencyEnrichment = await enrichSuiteRunsWithN8nLatency(suiteRuns, options.environment);

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
    latencyEnrichment
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
  buildN8nExecutionSummaries,
  buildToolTraceRefs,
  enrichSuiteRunsWithN8nLatency,
  matchToolTracesToExecutions,
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
