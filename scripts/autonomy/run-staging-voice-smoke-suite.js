#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
let chromium = null;

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_SCENARIOS_DIR = path.join(ROOT_DIR, 'autonomy', 'scenarios', 'staging-voice');
const DEFAULT_RUNS_DIR = path.join(ROOT_DIR, 'autonomy', 'runs', 'generated', 'staging-voice');
const DEFAULT_REPORTS_DIR = path.join(ROOT_DIR, 'autonomy', 'reports', 'generated', 'staging-voice');
const STAGING_BINDINGS_PATH = path.join(ROOT_DIR, 'configs', 'vapi', 'environments', 'staging.json');
const VAPI_WEB_PACKAGE_PATH = path.join(ROOT_DIR, 'node_modules', '@vapi-ai', 'web', 'package.json');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.GOOGLE_CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);
const LANGUAGE_FILTERS = new Set(['pl', 'en', 'mixed', 'all']);

function usage() {
  console.log(`Usage:
  node scripts/autonomy/run-staging-voice-smoke-suite.js [options]

Options:
  --scenario <id>       Run only the named voice scenario. Repeat to run multiple scenarios.
  --include-draft       Also allow draft voice scenarios for explicit experimental runs.
  --language <value>    Filter active scenarios by language: pl, en, mixed, or all. Defaults to pl.
  --output-dir <dir>    Write machine-readable artifacts into this directory.
  --report <path>       Write the Markdown report to this path.
  --list                Print the available active staging voice scenarios and exit.
  --headful             Launch Chrome in headed mode instead of headless.
  --keep-temp           Keep per-scenario temp harness files in the run directory.
  --help                Show this help message.
`);
}

function parseArgs(argv) {
  const options = {
    scenarioIds: [],
    includeDraft: false,
    languageFilter: 'pl',
    languageExplicit: false,
    outputDir: null,
    reportPath: null,
    listOnly: false,
    headless: true,
    keepTemp: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--list') {
      options.listOnly = true;
      continue;
    }
    if (arg === '--headful') {
      options.headless = false;
      continue;
    }
    if (arg === '--keep-temp') {
      options.keepTemp = true;
      continue;
    }
    if (arg === '--include-draft') {
      options.includeDraft = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next) {
      throw new Error(`Missing value for ${arg}`);
    }
    switch (arg) {
      case '--scenario':
        options.scenarioIds.push(next);
        index += 1;
        break;
      case '--language':
        if (!LANGUAGE_FILTERS.has(next)) {
          throw new Error(`Unsupported language filter: ${next}`);
        }
        options.languageFilter = next;
        options.languageExplicit = true;
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
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function stableNowIso() {
  return new Date().toISOString();
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}

function loadRootEnvIfPresent() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function getInstalledVapiWebVersion() {
  const packageJson = readJson(VAPI_WEB_PACKAGE_PATH);
  const version = packageJson.version;
  if (!version || typeof version !== 'string') {
    throw new Error(`Could not determine installed @vapi-ai/web version from ${VAPI_WEB_PACKAGE_PATH}`);
  }
  return version;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function getByPath(value, dottedPath) {
  if (!dottedPath) {
    return value;
  }
  const parts = dottedPath.split('.');
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number.parseInt(part, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dateTimesEqual(left, right) {
  if (valuesEqual(left, right)) {
    return true;
  }
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }
  const leftTimestamp = Date.parse(left);
  const rightTimestamp = Date.parse(right);
  return Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp) && leftTimestamp === rightTimestamp;
}

function toRelativePath(filePath) {
  return path.relative(ROOT_DIR, filePath) || '.';
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && options.allowFailure !== true) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(stderr || stdout || `${command} exited with status ${result.status}`);
  }

  return result;
}

function scenarioMatchesLanguageFilter(scenario, languageFilter) {
  return languageFilter === 'all' || scenario.language === languageFilter;
}

function resolveChromeExecutablePath() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not find a Chrome/Chromium executable. Set CHROME_PATH if needed.');
}

function buildClientConfig() {
  const bindings = readJson(STAGING_BINDINGS_PATH);
  const assistantId = bindings.assistantId;
  const apiKey = process.env.STAGING_VAPI_API_KEY || process.env.VAPI_API_KEY || '';
  const webToken =
    process.env.STAGING_VAPI_WEB_TOKEN ||
    process.env.STAGING_VAPI_PUBLIC_KEY ||
    process.env.VAPI_WEB_TOKEN ||
    process.env.VAPI_PUBLIC_KEY ||
    '';
  const baseUrl = process.env.VAPI_API_BASE_URL || 'https://api.vapi.ai';

  if (!assistantId) {
    throw new Error(`assistantId is required in ${STAGING_BINDINGS_PATH}`);
  }
  if (!apiKey) {
    throw new Error('STAGING_VAPI_API_KEY or VAPI_API_KEY is required');
  }
  if (!webToken) {
    throw new Error('STAGING_VAPI_WEB_TOKEN, STAGING_VAPI_PUBLIC_KEY, VAPI_WEB_TOKEN, or VAPI_PUBLIC_KEY is required for browser-side web call creation');
  }
  if (!fs.existsSync(VAPI_WEB_PACKAGE_PATH)) {
    throw new Error(`Vapi web SDK package metadata not found at ${VAPI_WEB_PACKAGE_PATH}. Run npm install.`);
  }

  return {
    assistantId,
    apiKey,
    webToken,
    baseUrl
  };
}

function resolveAllowedScenarioStatuses(includeDraft) {
  return new Set(includeDraft ? ['active', 'draft'] : ['active']);
}

function loadScenarios(selectedIds, languageFilter, languageExplicit, includeDraft = false) {
  if (!fs.existsSync(DEFAULT_SCENARIOS_DIR)) {
    return [];
  }

  const entries = fs.readdirSync(DEFAULT_SCENARIOS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => path.join(DEFAULT_SCENARIOS_DIR, entry));

  const scenarios = entries.map((filePath) => {
    const scenario = readJson(filePath);
    scenario.__filePath = filePath;
    return scenario;
  });

  const allowedScenarioStatuses = resolveAllowedScenarioStatuses(includeDraft);
  const activeScenarios = scenarios
    .filter((scenario) => allowedScenarioStatuses.has(scenario.status))
    .sort((left, right) => left.scenario_id.localeCompare(right.scenario_id));

  if (selectedIds.length > 0) {
    const selected = activeScenarios.filter((scenario) => selectedIds.includes(scenario.scenario_id));
    const found = new Set(selected.map((scenario) => scenario.scenario_id));
    const missing = selectedIds.filter((scenarioId) => !found.has(scenarioId));
    if (missing.length > 0) {
      throw new Error(`Unknown or ineligible voice scenario(s): ${missing.join(', ')}`);
    }

    if (languageExplicit) {
      return selected.filter((scenario) => scenarioMatchesLanguageFilter(scenario, languageFilter));
    }
    return selected;
  }

  return activeScenarios.filter((scenario) => scenarioMatchesLanguageFilter(scenario, languageFilter));
}

function printScenarioList(scenarios) {
  for (const scenario of scenarios) {
    console.log(`${scenario.scenario_id}\t${scenario.title}`);
  }
}

function createSilenceSegment(outputPath, durationMs) {
  const seconds = Math.max(0, durationMs) / 1000;
  runCommand('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=r=48000:cl=mono',
    '-t', String(seconds),
    '-ac', '1',
    '-ar', '48000',
    '-c:a', 'pcm_s16le',
    outputPath
  ]);
}

function probeAudioDurationMs(filePath) {
  const result = runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  const durationSeconds = Number.parseFloat((result.stdout || '').trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error(`Could not determine audio duration for ${filePath}`);
  }
  return Math.round(durationSeconds * 1000);
}

function createAudioFixtureForScenario(scenario, tempDir) {
  const segmentsDir = path.join(tempDir, 'segments');
  ensureDir(segmentsDir);

  const audioSteps = scenario.steps.filter((step) => step.type === 'play_clip' || step.type === 'pause');
  const segmentPaths = [];
  const stepTimings = [];
  let segmentIndex = 0;
  let offsetMs = 0;
  const tailSilenceMs = Math.max(30000, ((scenario.runner?.max_duration_seconds ?? 90) * 1000) + 5000);

  if (audioSteps.length === 0) {
    const silencePath = path.join(segmentsDir, 'segment-000-silence.wav');
    createSilenceSegment(silencePath, 1000);
    segmentPaths.push(silencePath);
  }

  for (const step of audioSteps) {
    const segmentPath = path.join(segmentsDir, `segment-${String(segmentIndex).padStart(3, '0')}.wav`);
    segmentIndex += 1;
    let durationMs = 0;
    if (step.type === 'pause') {
      durationMs = step.duration_ms || 0;
      createSilenceSegment(segmentPath, durationMs);
      segmentPaths.push(segmentPath);
    } else {
      const clipPath = path.resolve(ROOT_DIR, step.clip_path);
      if (!fs.existsSync(clipPath)) {
        throw new Error(`Audio clip not found for ${scenario.scenario_id}: ${step.clip_path}`);
      }

      runCommand('ffmpeg', [
        '-y',
        '-i', clipPath,
        '-af', step.fixture_style === 'low_confidence_noise'
          ? 'loudnorm=I=-18:LRA=11:TP=-1.5,volume=1.5'
          : 'loudnorm=I=-18:LRA=11:TP=-1.5',
        '-ac', '1',
        '-ar', '48000',
        '-c:a', 'pcm_s16le',
        segmentPath
      ]);
      durationMs = probeAudioDurationMs(segmentPath);
      segmentPaths.push(segmentPath);
    }

    stepTimings.push({
      step_id: step.step_id,
      window_id: step.window_id || null,
      type: step.type,
      start_ms: offsetMs,
      end_ms: offsetMs + durationMs
    });
    offsetMs += durationMs;
  }

  const tailSilencePath = path.join(segmentsDir, `segment-${String(segmentIndex).padStart(3, '0')}-tail-silence.wav`);
  createSilenceSegment(tailSilencePath, tailSilenceMs);
  segmentPaths.push(tailSilencePath);

  const concatFilePath = path.join(tempDir, 'segments.txt');
  fs.writeFileSync(
    concatFilePath,
    segmentPaths.map((filePath) => `file '${filePath.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  );

  const combinedPath = path.join(tempDir, `${scenario.scenario_id}.input.wav`);
  runCommand('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFilePath,
    '-c', 'copy',
    combinedPath
  ]);

  return {
    combinedPath,
    segmentPaths,
    stepTimings
  };
}

function collectMissingAudioFixtures(scenarios) {
  const missing = [];
  for (const scenario of scenarios) {
    for (const step of scenario.steps || []) {
      if (step.type !== 'play_clip') {
        continue;
      }
      const clipPath = path.resolve(ROOT_DIR, step.clip_path);
      if (!fs.existsSync(clipPath)) {
        missing.push({
          scenario_id: scenario.scenario_id,
          step_id: step.step_id,
          clip_path: step.clip_path
        });
      }
    }
  }
  return missing;
}

function ensureAudioFixtures(scenarios) {
  const missing = collectMissingAudioFixtures(scenarios);
  if (missing.length === 0) {
    return;
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    const example = missing[0];
    throw new Error(
      `Missing caller audio fixture ${example.clip_path} for ${example.scenario_id}/${example.step_id}. ` +
      'Set ELEVENLABS_API_KEY and rerun, or generate fixtures with ./scripts/autonomy/generate-staging-voice-fixtures.sh.'
    );
  }

  const args = [
    path.join(ROOT_DIR, 'scripts', 'autonomy', 'generate-staging-voice-fixtures.js'),
    '--only-missing'
  ];

  for (const scenario of scenarios) {
    args.push('--scenario', scenario.scenario_id);
  }

  runCommand(process.execPath, args);
}

function sanitizeForBrowser(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForBrowser);
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'function') {
        continue;
      }
      output[key] = sanitizeForBrowser(entry);
    }
    return output;
  }
  return String(value);
}

function createHarnessHtml(webToken) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Staging Voice Smoke Harness</title>
  </head>
  <body>
    <div id="status">booting</div>
    <script type="module">
      import Vapi from '/vendor/vapi.mjs';

      const statusNode = document.getElementById('status');
      const state = {
        events: [],
        messages: [],
        errors: [],
        callStarted: false,
        callEnded: false,
        startResult: null
      };

      const replacer = (key, value) => {
        if (typeof value === 'function') {
          return undefined;
        }
        if (value instanceof Error) {
          return { message: value.message, name: value.name, stack: value.stack };
        }
        return value;
      };

      const clone = (value) => {
        try {
          return JSON.parse(JSON.stringify(value, replacer));
        } catch {
          return { unserializable: true, value: String(value) };
        }
      };

      const record = (type, payload = null) => {
        state.events.push({
          sequence: state.events.length,
          time: new Date().toISOString(),
          type,
          payload: clone(payload)
        });
      };

      const vapi = new Vapi(${JSON.stringify(webToken)});

      vapi.on('call-start', (...args) => {
        state.callStarted = true;
        record('call-start', args[0] ?? null);
        statusNode.textContent = 'call-started';
      });

      vapi.on('call-end', (...args) => {
        state.callEnded = true;
        record('call-end', args[0] ?? null);
        statusNode.textContent = 'call-ended';
      });

      vapi.on('speech-start', (...args) => record('speech-start', args[0] ?? null));
      vapi.on('speech-end', (...args) => record('speech-end', args[0] ?? null));

      vapi.on('message', (message) => {
        const sanitized = clone(message);
        state.messages.push(sanitized);
        record('message', sanitized);
      });

      vapi.on('error', (error) => {
        const sanitized = clone(error);
        state.errors.push(sanitized);
        record('error', sanitized);
        statusNode.textContent = 'error';
      });

      window.__voiceSmoke = {
        async start(assistantId) {
          record('start-requested', { assistantId });
          statusNode.textContent = 'starting';
          const result = await vapi.start(assistantId);
          state.startResult = clone(result);
          record('start-result', state.startResult);
          statusNode.textContent = 'started';
          return state.startResult;
        },
        async stop() {
          record('stop-requested');
          await vapi.stop();
        },
        snapshot() {
          return clone({
            callStarted: state.callStarted,
            callEnded: state.callEnded,
            startResult: state.startResult,
            events: state.events,
            messages: state.messages,
            errors: state.errors
          });
        }
      };

      record('ready');
      statusNode.textContent = 'ready';
    </script>
  </body>
</html>`;
}

function createHarnessServer({ webToken }) {
  const html = createHarnessHtml(webToken);
  const vapiWebVersion = getInstalledVapiWebVersion();

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...corsHeaders
      });
      response.end(html);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/vendor/vapi.mjs') {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        ...corsHeaders
      });
      response.end(`import Vapi from 'https://esm.sh/@vapi-ai/web@${vapiWebVersion}';\nexport default Vapi;\n`);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(404, corsHeaders);
    response.end('not found');
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

async function fetchCallById({ callId, apiKey, baseUrl }) {
  const response = await fetch(`${baseUrl}/call/${callId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`
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
    throw new Error(`Vapi call fetch failed with HTTP ${response.status}`);
  }

  return payload;
}

async function fetchRecentCalls({ assistantId, apiKey, baseUrl, limit }) {
  const url = new URL('/call', baseUrl);
  url.searchParams.set('assistantId', assistantId);
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
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
    throw new Error(`Vapi recent calls fetch failed with HTTP ${response.status}`);
  }

  return Array.isArray(payload) ? payload : [];
}

function isCallEnded(call) {
  return Boolean(call) && (call.status === 'ended' || Boolean(call.endedAt));
}

function getCallStartedTimestamp(call) {
  const startedAt = Date.parse(call?.startedAt || call?.createdAt || '');
  return Number.isFinite(startedAt) ? startedAt : null;
}

function selectCompletedRecentCall({ calls, assistantId, scenarioStartedAt, preferredCallId }) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return null;
  }

  const startedTimestamp = Date.parse(scenarioStartedAt || '');
  const endedCalls = calls.filter((call) =>
    isCallEnded(call) && (call?.assistantId === assistantId || !call?.assistantId)
  );

  if (preferredCallId) {
    const exactMatch = endedCalls.find((call) => call?.id === preferredCallId);
    if (exactMatch) {
      return exactMatch;
    }
  }

  const eligibleCalls = endedCalls
    .map((call) => ({ call, startedTimestamp: getCallStartedTimestamp(call) }))
    .filter(({ startedTimestamp: callStartedTimestamp }) =>
      Number.isFinite(startedTimestamp)
        ? Number.isFinite(callStartedTimestamp) && callStartedTimestamp >= startedTimestamp
        : Number.isFinite(callStartedTimestamp)
    )
    .sort((left, right) => right.startedTimestamp - left.startedTimestamp);

  return eligibleCalls[0]?.call || null;
}

async function fetchCompletedCall({ callId, assistantId, apiKey, baseUrl, scenarioStartedAt, scenario }) {
  const settleSeconds = scenario.runner?.post_call_settle_seconds ?? 5;
  if (settleSeconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleSeconds * 1000));
  }

  const attempts = scenario.runner?.artifact_poll_attempts ?? 15;
  const intervalMs = (scenario.runner?.artifact_poll_seconds ?? 2) * 1000;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (callId) {
      try {
        const exactCall = await fetchCallById({ callId, apiKey, baseUrl });
        if (isCallEnded(exactCall)) {
          return exactCall;
        }
      } catch {
        // Fall through to recent-calls search.
      }
    }

    const calls = await fetchRecentCalls({ assistantId, apiKey, baseUrl, limit: 10 });
    const recent = selectCompletedRecentCall({
      calls,
      assistantId,
      scenarioStartedAt,
      preferredCallId: callId
    });

    if (recent) {
      return recent;
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error('Could not fetch the completed call artifact after the voice session ended');
}

function inferCallId(snapshot) {
  const startResultId = snapshot?.startResult?.id;
  if (typeof startResultId === 'string' && startResultId) {
    return startResultId;
  }

  const messageCallId = (snapshot?.messages || [])
    .map((message) => message?.call?.id || message?.callId || message?.id)
    .find((value) => typeof value === 'string' && value);
  if (messageCallId) {
    return messageCallId;
  }

  const eventCallId = (snapshot?.events || [])
    .map((event) => event?.payload?.call?.id || event?.payload?.callId || event?.payload?.id)
    .find((value) => typeof value === 'string' && value);
  return eventCallId || null;
}

function sanitizeEventTrace(snapshot, scenarioStartedAt) {
  const startedTimestamp = Date.parse(scenarioStartedAt);
  return (snapshot?.events || []).map((event, index) => {
    const eventTimestamp = Date.parse(event?.time || '');
    return {
      sequence: index,
      source: 'browser',
      type: event?.type || 'unknown',
      step_id: null,
      time_ms: Number.isFinite(eventTimestamp) ? eventTimestamp : null,
      seconds_from_start: Number.isFinite(eventTimestamp) && Number.isFinite(startedTimestamp)
        ? Math.max(0, (eventTimestamp - startedTimestamp) / 1000)
        : null,
      text: event?.payload?.message || event?.payload?.transcript || null,
      payload: sanitizeForBrowser(event?.payload || null)
    };
  });
}

function buildToolTraceFromNormalizedRun(run) {
  return Array.isArray(run?.tool_trace)
    ? run.tool_trace.map((trace) => ({
      index: trace.index,
      step_id: null,
      tool_name: trace.tool_name,
      tool_call_id: trace.tool_call_id || null,
      status: trace.status === 'requested' ? 'missing_result' : trace.status,
      arguments: trace.arguments || null,
      result: Object.prototype.hasOwnProperty.call(trace, 'result') ? trace.result : null
    }))
    : [];
}

function flattenNormalizedTranscript(run) {
  return Array.isArray(run?.conversation?.messages) ? run.conversation.messages : [];
}

function findToolCalls(toolTrace, toolName) {
  return toolTrace.filter((trace) => trace.tool_name === toolName);
}

function getStructuredOutput(callArtifact) {
  const outputs = callArtifact?.artifact?.structuredOutputs;
  if (!outputs || typeof outputs !== 'object') {
    return { found: false, outputId: null, outputName: null, result: null };
  }
  const entries = Object.entries(outputs);
  if (entries.length === 0) {
    return { found: false, outputId: null, outputName: null, result: null };
  }
  const chosen = entries.find(([, value]) => value?.result) || entries[0];
  return {
    found: true,
    outputId: chosen[0],
    outputName: chosen[1]?.name || null,
    result: chosen[1]?.result || null
  };
}

function buildToolSummary(toolTrace) {
  const byTool = new Map();
  for (const trace of toolTrace) {
    const current = byTool.get(trace.tool_name) || {
      tool_name: trace.tool_name,
      call_count: 0,
      completed_calls: 0,
      missing_result_calls: 0
    };
    current.call_count += 1;
    if (trace.status === 'missing_result') {
      current.missing_result_calls += 1;
    } else {
      current.completed_calls += 1;
    }
    byTool.set(trace.tool_name, current);
  }

  return {
    total_calls: toolTrace.length,
    distinct_tool_count: byTool.size,
    tools: Array.from(byTool.values()).sort((left, right) => left.tool_name.localeCompare(right.tool_name))
  };
}

function buildStructuredOutputSummary(structuredOutput) {
  const result = structuredOutput?.result || null;
  const shortSummaryPl = getByPath(result, 'summary.shortSummaryPl') || null;
  const shortSummaryEn = getByPath(result, 'summary.shortSummaryEn') || null;
  const shortSummary = shortSummaryPl || shortSummaryEn || getByPath(result, 'summary.shortSummary') || null;
  const successfulForAssistantScope = getByPath(result, 'successfulForAssistantScope');

  return {
    found: structuredOutput?.found === true,
    output_id: structuredOutput?.outputId || null,
    output_name: structuredOutput?.outputName || null,
    call_outcome: getByPath(result, 'callOutcome') || null,
    successful_for_assistant_scope: typeof successfulForAssistantScope === 'boolean'
      ? successfulForAssistantScope
      : null,
    short_summary: shortSummary,
    short_summary_pl: shortSummaryPl,
    short_summary_en: shortSummaryEn
  };
}

function extractEndedReasonFromEvents(eventTrace) {
  for (let index = eventTrace.length - 1; index >= 0; index -= 1) {
    const event = eventTrace[index];
    if (
      event?.type === 'message' &&
      event?.payload &&
      typeof event.payload === 'object' &&
      !Array.isArray(event.payload) &&
      event.payload.type === 'status-update' &&
      typeof event.payload.endedReason === 'string' &&
      event.payload.endedReason
    ) {
      return event.payload.endedReason;
    }
  }
  return null;
}

function getCallStartSeconds(eventTrace) {
  const callStartEvent = eventTrace.find((event) => event.type === 'call-start' && typeof event.seconds_from_start === 'number');
  return callStartEvent?.seconds_from_start ?? null;
}

function buildAssistantSpeechIntervals(eventTrace) {
  const timedEvents = eventTrace.filter((event) => typeof event.seconds_from_start === 'number');
  const explicitMarkers = timedEvents
    .filter((event) => event.type === 'speech-start' || event.type === 'speech-end')
    .map((event) => ({
      kind: event.type === 'speech-start' ? 'start' : 'end',
      seconds_from_start: event.seconds_from_start
    }));
  const fallbackMarkers = timedEvents
    .filter((event) => (
      event.type === 'message' &&
      event.payload &&
      typeof event.payload === 'object' &&
      !Array.isArray(event.payload) &&
      event.payload.type === 'speech-update' &&
      event.payload.role === 'assistant' &&
      (event.payload.status === 'started' || event.payload.status === 'stopped')
    ))
    .map((event) => ({
      kind: event.payload.status === 'started' ? 'start' : 'end',
      seconds_from_start: event.seconds_from_start
    }));
  const markers = explicitMarkers.length > 0 ? explicitMarkers : fallbackMarkers;
  const intervals = [];
  let openStart = null;
  let lastTimedSeconds = null;

  for (const marker of markers) {
    lastTimedSeconds = marker.seconds_from_start;
    if (marker.kind === 'start') {
      if (openStart === null) {
        openStart = marker.seconds_from_start;
      }
      continue;
    }
    if (openStart !== null) {
      intervals.push({
        start_seconds: openStart,
        end_seconds: marker.seconds_from_start
      });
      openStart = null;
    }
  }

  if (openStart !== null) {
    intervals.push({
      start_seconds: openStart,
      end_seconds: lastTimedSeconds ?? openStart
    });
  }

  return intervals;
}

function resolveScenarioWindow(rule, scenarioStepTimings, eventTrace) {
  const matchedStep = rule.window_id
    ? scenarioStepTimings.find((step) => step.window_id === rule.window_id)
    : rule.step_id
      ? scenarioStepTimings.find((step) => step.step_id === rule.step_id)
      : null;

  if (!matchedStep) {
    return {
      window: null,
      failure_reason: `Could not resolve timing window for ${rule.window_id ? `window_id=${rule.window_id}` : `step_id=${rule.step_id || '[missing]'}`}`
    };
  }

  const callStartSeconds = getCallStartSeconds(eventTrace);
  if (callStartSeconds === null) {
    return {
      window: null,
      failure_reason: 'Could not determine call-start timing for voice window assertion'
    };
  }

  return {
    window: {
      step_id: matchedStep.step_id,
      window_id: matchedStep.window_id,
      start_seconds: callStartSeconds + (matchedStep.start_ms / 1000),
      end_seconds: callStartSeconds + (matchedStep.end_ms / 1000)
    },
    failure_reason: null
  };
}

function windowLabel(window) {
  if (window?.window_id) {
    return `window ${window.window_id}`;
  }
  if (window?.step_id) {
    return `step ${window.step_id}`;
  }
  return 'window';
}

function intervalsOverlap(left, right) {
  return left.start_seconds < right.end_seconds && left.end_seconds > right.start_seconds;
}

function isRunnerFailure(errorMessage) {
  return [
    /Unsupported rule type/i,
    /Audio clip not found/i,
    /Could not determine audio duration/i,
    /Could not find a Chrome\/Chromium executable/i,
    /assistantId is required/i,
    /required for browser-side web call creation/i,
    /No active staging voice scenarios found/i,
    /Unknown or inactive voice scenario/i,
    /Missing caller audio fixture/i
  ].some((pattern) => pattern.test(errorMessage || ''));
}

function isTransportFailureSignal(event) {
  if (!event) {
    return false;
  }
  if (event.type === 'error') {
    return true;
  }
  if (event.type === 'page-error') {
    return true;
  }
  if (event.type === 'console-error') {
    return /meeting has ended|failed to load resource/i.test(event.text || '');
  }
  return false;
}

function classifyFailureType({ error, failures, eventTrace, callArtifact }) {
  if (!error) {
    return failures.length === 0 ? null : 'assistant_behavior_failure';
  }

  if (isRunnerFailure(error.message)) {
    return 'runner_failure';
  }

  const sawCallLifecycle = eventTrace.some((event) => ['start-result', 'call-start', 'call-end'].includes(event.type)) || Boolean(callArtifact?.id);
  const sawTransportSignal = eventTrace.some(isTransportFailureSignal);
  return sawCallLifecycle || sawTransportSignal ? 'transport_failure' : 'runner_failure';
}

function inferRootCause({ error, failureType, firstFailure }) {
  if (!error) {
    return firstFailure?.root_cause_hint || null;
  }
  if (failureType === 'transport_failure') {
    return 'voice_transport_or_vapi_failure';
  }
  if (failureType === 'runner_failure') {
    return 'voice_runner_or_harness_failure';
  }
  return null;
}

function getAssistantTranscriptText(run) {
  return flattenNormalizedTranscript(run)
    .filter((message) => message.role === 'assistant' && typeof message.text === 'string')
    .map((message) => message.text)
    .join(' ');
}

function evaluateCriterion(criterion, context) {
  const rule = criterion.rule || {};
  const evidence = [];
  const fail = (failureReason) => ({
    criterion_id: criterion.criterion_id,
    description: criterion.description,
    severity: criterion.severity,
    required: criterion.required !== false,
    passed: false,
    failure_reason: failureReason,
    root_cause_hint: criterion.root_cause_hint || null,
    evidence
  });
  const pass = () => ({
    criterion_id: criterion.criterion_id,
    description: criterion.description,
    severity: criterion.severity,
    required: criterion.required !== false,
    passed: true,
    failure_reason: null,
    root_cause_hint: criterion.root_cause_hint || null,
    evidence
  });

  switch (rule.type) {
    case 'tool_called': {
      const matches = findToolCalls(context.toolTrace, rule.tool_name);
      evidence.push(`${matches.length} ${rule.tool_name} call(s)`);
      return matches.length > 0 ? pass() : fail(`Expected ${rule.tool_name} to be called`);
    }
    case 'tool_not_called': {
      const matches = findToolCalls(context.toolTrace, rule.tool_name);
      evidence.push(`${matches.length} ${rule.tool_name} call(s)`);
      return matches.length === 0 ? pass() : fail(`Did not expect ${rule.tool_name} to be called`);
    }
    case 'tool_arg_equals': {
      const matches = findToolCalls(context.toolTrace, rule.tool_name);
      const occurrence = rule.occurrence || 'last';
      const candidate = occurrence === 'any'
        ? matches.find((trace) => valuesEqual(getByPath(trace.arguments, rule.path), rule.equals))
        : occurrence === 'first'
          ? matches[0]
          : matches[matches.length - 1];
      if (candidate) {
        evidence.push(`${candidate.tool_name}.${rule.path}=${JSON.stringify(getByPath(candidate.arguments, rule.path))}`);
      } else {
        evidence.push(`0 ${rule.tool_name} call(s)`);
      }
      if (occurrence === 'any') {
        return candidate ? pass() : fail(`Expected any ${rule.tool_name} call to set ${rule.path}`);
      }
      return candidate && valuesEqual(getByPath(candidate.arguments, rule.path), rule.equals)
        ? pass()
        : fail(`Expected ${occurrence} ${rule.tool_name} call to set ${rule.path} to ${JSON.stringify(rule.equals)}`);
    }
    case 'tool_result_path_equals': {
      const matches = findToolCalls(context.toolTrace, rule.tool_name);
      const occurrence = rule.occurrence || 'last';
      const candidate = occurrence === 'any'
        ? matches.find((trace) => valuesEqual(getByPath(trace.result, rule.path), rule.equals))
        : occurrence === 'first'
          ? matches[0]
          : matches[matches.length - 1];
      if (candidate) {
        evidence.push(`${candidate.tool_name} result ${rule.path}=${JSON.stringify(getByPath(candidate.result, rule.path))}`);
      } else {
        evidence.push(`0 ${rule.tool_name} call(s)`);
      }
      if (occurrence === 'any') {
        return candidate ? pass() : fail(`Expected any ${rule.tool_name} result ${rule.path} to equal ${JSON.stringify(rule.equals)}`);
      }
      return candidate && valuesEqual(getByPath(candidate.result, rule.path), rule.equals)
        ? pass()
        : fail(`Expected ${occurrence} ${rule.tool_name} result ${rule.path} to equal ${JSON.stringify(rule.equals)}`);
    }
    case 'assistant_text_contains_any': {
      const text = getAssistantTranscriptText(context.normalizedRun);
      const normalizedText = normalizeText(text);
      evidence.push(text || '[no assistant text]');
      const matched = (rule.contains_any || []).find((needle) => normalizedText.includes(normalizeText(needle)));
      return matched ? pass() : fail(`Expected assistant transcript to contain one of: ${(rule.contains_any || []).join(', ')}`);
    }
    case 'assistant_text_contains_all': {
      const text = getAssistantTranscriptText(context.normalizedRun);
      const normalizedText = normalizeText(text);
      evidence.push(text || '[no assistant text]');
      const missing = (rule.contains_all || []).filter((needle) => !normalizedText.includes(normalizeText(needle)));
      return missing.length === 0 ? pass() : fail(`Expected assistant transcript to contain: ${(rule.contains_all || []).join(', ')}`);
    }
    case 'structured_output_path_equals': {
      const actual = getByPath(context.structuredOutput.result, rule.path);
      evidence.push(`${rule.path}=${JSON.stringify(actual)}`);
      return valuesEqual(actual, rule.equals)
        ? pass()
        : fail(`Expected structured output ${rule.path} to equal ${JSON.stringify(rule.equals)}`);
    }
    case 'call_path_equals': {
      const actual = getByPath(context.callArtifact, rule.path);
      evidence.push(`${rule.path}=${JSON.stringify(actual)}`);
      return valuesEqual(actual, rule.equals)
        ? pass()
        : fail(`Expected call field ${rule.path} to equal ${JSON.stringify(rule.equals)}`);
    }
    case 'call_path_lte': {
      const actual = getByPath(context.callArtifact, rule.path);
      evidence.push(`${rule.path}=${JSON.stringify(actual)}`);
      return typeof actual === 'number' && actual <= rule.lte
        ? pass()
        : fail(`Expected call field ${rule.path} to be <= ${JSON.stringify(rule.lte)}`);
    }
    case 'ended_reason_equals': {
      const actual = context.callArtifact?.endedReason ?? null;
      evidence.push(`endedReason=${JSON.stringify(actual)}`);
      return valuesEqual(actual, rule.equals)
        ? pass()
        : fail(`Expected endedReason to equal ${JSON.stringify(rule.equals)}`);
    }
    case 'assistant_did_not_speak_during_window': {
      const { window, failure_reason: failureReason } = resolveScenarioWindow(rule, context.scenarioStepTimings, context.eventTrace);
      if (!window) {
        evidence.push(failureReason);
        return fail(failureReason);
      }
      evidence.push(`${windowLabel(window)}=${window.start_seconds.toFixed(3)}-${window.end_seconds.toFixed(3)}s`);
      const overlaps = buildAssistantSpeechIntervals(context.eventTrace).filter((interval) => intervalsOverlap(interval, window));
      if (overlaps.length === 0) {
        evidence.push('No assistant speech overlapped the target window');
        return pass();
      }
      evidence.push(...overlaps.map((interval) => `assistant speech ${interval.start_seconds.toFixed(3)}-${interval.end_seconds.toFixed(3)}s overlapped the target window`));
      return fail(`Expected no assistant speech during ${windowLabel(window)}`);
    }
    case 'assistant_spoke_after_window': {
      const { window, failure_reason: failureReason } = resolveScenarioWindow(rule, context.scenarioStepTimings, context.eventTrace);
      if (!window) {
        evidence.push(failureReason);
        return fail(failureReason);
      }
      evidence.push(`${windowLabel(window)}=${window.start_seconds.toFixed(3)}-${window.end_seconds.toFixed(3)}s`);
      const nextSpeech = buildAssistantSpeechIntervals(context.eventTrace).find((interval) => interval.start_seconds >= window.end_seconds);
      if (nextSpeech) {
        evidence.push(`assistant speech resumed at ${nextSpeech.start_seconds.toFixed(3)}s`);
        return pass();
      }
      evidence.push('No assistant speech observed after the target window');
      return fail(`Expected assistant speech after ${windowLabel(window)}`);
    }
    case 'create_event_matches_selected_slot': {
      const availability = findToolCalls(context.toolTrace, 'checkAvailability')
        .filter((trace) => Array.isArray(trace?.result?.slots) && trace.result.slots.length > rule.selected_slot_index)
        .slice(-1)[0] || null;
      const createEvent = findToolCalls(context.toolTrace, 'createEvent').slice(-1)[0] || null;
      const selectedSlot = availability?.result?.slots?.[rule.selected_slot_index];
      evidence.push(`selected slot start=${JSON.stringify(selectedSlot?.start)} end=${JSON.stringify(selectedSlot?.end)}`);
      evidence.push(`createEvent slotStart=${JSON.stringify(createEvent?.arguments?.slotStart)} slotEnd=${JSON.stringify(createEvent?.arguments?.slotEnd)}`);
      if (!selectedSlot || !createEvent) {
        return fail('Could not compare createEvent with selected slot');
      }
      return dateTimesEqual(createEvent.arguments?.slotStart, selectedSlot.start) &&
        dateTimesEqual(createEvent.arguments?.slotEnd, selectedSlot.end)
        ? pass()
        : fail('createEvent did not preserve selected slot boundaries');
    }
    default:
      evidence.push(`Unsupported rule type in runner: ${rule.type}`);
      return fail(`Unsupported rule type: ${rule.type}`);
  }
}

function buildTranscriptExcerpt(run) {
  return flattenNormalizedTranscript(run)
    .filter((message) => message.role === 'caller' || message.role === 'assistant')
    .slice(-12)
    .map((message) => `${message.role}: ${message.text}`);
}

function summarizeEventForExcerpt(event) {
  if (!event?.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return event.text || null;
  }

  if (event.type === 'message') {
    const payloadType = event.payload.type || 'message';
    switch (payloadType) {
      case 'conversation-update': {
        const messageCount = Array.isArray(event.payload.messages) ? event.payload.messages.length : null;
        return messageCount === null ? payloadType : `${payloadType} (${messageCount} messages)`;
      }
      case 'speech-update':
        return `${payloadType} ${event.payload.role || 'unknown'} ${event.payload.status || 'unknown'}`;
      case 'status-update':
        return `${payloadType} ${event.payload.status || 'unknown'}${event.payload.endedReason ? ` endedReason=${event.payload.endedReason}` : ''}`;
      default:
        return event.text || payloadType;
    }
  }

  if (event.type === 'error') {
    return event.payload?.error?.errorMsg || event.payload?.error?.message?.msg || event.text || 'error';
  }

  return event.text || null;
}

function buildEventExcerpt(eventTrace) {
  return eventTrace
    .slice(-12)
    .map((event) => {
      const payloadText = summarizeEventForExcerpt(event) || '';
      return `${event.type}${payloadText ? ` | ${payloadText}` : ''}`;
    });
}

function scoreScenario({ scenario, callArtifact, normalizedRun, eventTrace, error, scenarioStepTimings }) {
  const structuredOutput = getStructuredOutput(callArtifact);
  const structuredOutputSummary = buildStructuredOutputSummary(structuredOutput);
  const toolTrace = buildToolTraceFromNormalizedRun(normalizedRun);
  const toolSummary = buildToolSummary(toolTrace);
  const criteria = scenario.rubric.map((criterion) => evaluateCriterion(criterion, {
    scenario,
    callArtifact,
    normalizedRun,
    toolTrace,
    structuredOutput,
    eventTrace,
    scenarioStepTimings
  }));

  const failures = criteria.filter((criterion) => criterion.required && !criterion.passed);
  const warnings = criteria.filter((criterion) => !criterion.required && !criterion.passed);
  const bookingCreated = Boolean(structuredOutput.result?.booking?.bookingCreated) ||
    toolTrace.some((trace) => trace.tool_name === 'createEvent' && trace.result?.created === true);
  const receptionTaskCreated = toolTrace.some((trace) => trace.tool_name === 'createReceptionTask' && trace.result?.accepted === true);
  const firstFailure = failures[0] || null;
  const failureType = classifyFailureType({ error, failures, eventTrace, callArtifact });
  const endedReason = callArtifact?.endedReason || extractEndedReasonFromEvents(eventTrace) || null;

  return {
    status: error ? 'error' : failures.length === 0 ? 'passed' : 'failed',
    criteria,
    summary: {
      failure_count: failures.length,
      warning_count: warnings.length,
      booking_created: bookingCreated,
      reception_task_created: receptionTaskCreated,
      structured_output_found: structuredOutput.found,
      ended_reason: endedReason,
      failure_type: failureType,
      suspected_root_cause: inferRootCause({ error, failureType, firstFailure }),
      failure_reason: error ? error.message : firstFailure?.failure_reason || null,
      tool_summary: toolSummary,
      structured_output_summary: structuredOutputSummary,
      transcript_excerpt: buildTranscriptExcerpt(normalizedRun),
      event_excerpt: buildEventExcerpt(eventTrace)
    }
  };
}

function renderMarkdownReport(suiteSummary, scenarioRuns) {
  const lines = [
    '# Staging Voice Smoke Suite Report',
    '',
    `- Suite run: \`${suiteSummary.suite_run_id}\``,
    `- Environment: \`${suiteSummary.environment}\``,
    `- Started: \`${suiteSummary.started_at}\``,
    `- Completed: \`${suiteSummary.completed_at}\``,
    `- Status: **${suiteSummary.status.toUpperCase()}**`,
    `- Scenarios: ${suiteSummary.passed_count}/${suiteSummary.scenario_count} passed`,
    '',
    '## Scenario Summary',
    '',
    '| Scenario | Status | Failure Type | Call ID | Failure Reason | Suspected Root Cause |',
    '| --- | --- | --- | --- | --- | --- |'
  ];

  for (const scenario of suiteSummary.scenario_results) {
    lines.push(
      `| \`${scenario.scenario_id}\` | ${scenario.status.toUpperCase()} | ${scenario.failure_type || 'n/a'} | \`${scenario.call_id || 'n/a'}\` | ${scenario.failure_reason || 'none'} | ${scenario.suspected_root_cause || 'n/a'} |`
    );
  }

  for (const scenarioRun of scenarioRuns) {
    lines.push('', `## ${scenarioRun.title}`, '');
    lines.push(`- Scenario ID: \`${scenarioRun.scenario_id}\``);
    lines.push(`- Status: **${scenarioRun.status.toUpperCase()}**`);
    lines.push(`- Call ID: \`${scenarioRun.call.call_id || 'n/a'}\``);
    lines.push(`- Ended reason: ${scenarioRun.summary.ended_reason || 'n/a'}`);
    lines.push(`- Failure type: ${scenarioRun.summary.failure_type || 'n/a'}`);
    lines.push(`- Failure reason: ${scenarioRun.summary.failure_reason || 'none'}`);
    lines.push(`- Suspected root cause: ${scenarioRun.summary.suspected_root_cause || 'n/a'}`);
    lines.push(`- Booking created: ${scenarioRun.summary.booking_created ? 'yes' : 'no'}`);
    lines.push(`- Reception task created: ${scenarioRun.summary.reception_task_created ? 'yes' : 'no'}`);
    lines.push(`- Structured output found: ${scenarioRun.summary.structured_output_found ? 'yes' : 'no'}`);

    lines.push('', 'Tool summary:');
    if (scenarioRun.summary.tool_summary.total_calls === 0) {
      lines.push('- No tool calls observed');
    } else {
      lines.push(`- Total calls: ${scenarioRun.summary.tool_summary.total_calls}`);
      for (const tool of scenarioRun.summary.tool_summary.tools) {
        lines.push(`- ${tool.tool_name}: ${tool.call_count} call(s), ${tool.completed_calls} completed, ${tool.missing_result_calls} missing result`);
      }
    }

    lines.push('', 'Structured output summary:');
    if (!scenarioRun.summary.structured_output_summary.found) {
      lines.push('- No structured output captured');
    } else {
      const structured = scenarioRun.summary.structured_output_summary;
      lines.push(`- Name: ${structured.output_name || structured.output_id || 'n/a'}`);
      if (structured.call_outcome) {
        lines.push(`- Call outcome: ${structured.call_outcome}`);
      }
      if (structured.successful_for_assistant_scope !== null) {
        lines.push(`- Successful for assistant scope: ${structured.successful_for_assistant_scope ? 'yes' : 'no'}`);
      }
      if (structured.short_summary) {
        lines.push(`- Short summary: ${structured.short_summary}`);
      }
    }

    const failedCriteria = scenarioRun.criteria.filter((criterion) => criterion.required && !criterion.passed);
    if (failedCriteria.length > 0) {
      lines.push('', 'Failed criteria:');
      for (const criterion of failedCriteria) {
        lines.push(`- \`${criterion.criterion_id}\`: ${criterion.failure_reason}`);
      }
    }

    if (scenarioRun.summary.transcript_excerpt.length > 0) {
      lines.push('', 'Transcript excerpt:', '', '```text');
      lines.push(...scenarioRun.summary.transcript_excerpt);
      lines.push('```');
    }

    if (scenarioRun.summary.event_excerpt.length > 0) {
      lines.push('', 'Event excerpt:', '', '```text');
      lines.push(...scenarioRun.summary.event_excerpt);
      lines.push('```');
    }

    if (scenarioRun.error?.message) {
      lines.push('', `Runner error: ${scenarioRun.error.message}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function executeScenario(scenario, clientConfig, suiteRunId, suiteOutputDir, options) {
  const scenarioStartedAt = stableNowIso();
  const scenarioOutputDir = path.join(suiteOutputDir, 'scenario-artifacts', scenario.scenario_id);
  const rawCallsDir = path.join(scenarioOutputDir, 'raw-calls');
  const normalizedDir = path.join(scenarioOutputDir, 'normalized');
  const eventsDir = path.join(scenarioOutputDir, 'events');
  const tempDir = path.join(scenarioOutputDir, 'temp');
  ensureDir(rawCallsDir);
  ensureDir(normalizedDir);
  ensureDir(eventsDir);
  ensureDir(tempDir);

  let browser = null;
  let page = null;
  let server = null;
  const browserDiagnostics = [];
  let scenarioStepTimings = [];

  try {
    if (!chromium) {
      ({ chromium } = require('playwright-core'));
    }
    const { combinedPath, segmentPaths, stepTimings } = createAudioFixtureForScenario(scenario, tempDir);
    scenarioStepTimings = stepTimings;
    server = createHarnessServer(clientConfig);
    const harnessOrigin = await server.start();
    const chromePath = resolveChromeExecutablePath();

    browser = await chromium.launch({
      executablePath: chromePath,
      headless: options.headless,
      args: [
        '--no-sandbox',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${combinedPath}`,
        '--autoplay-policy=no-user-gesture-required'
      ]
    });

    const context = await browser.newContext({
      permissions: ['microphone']
    });
    page = await context.newPage();
    page.on('pageerror', (error) => {
      browserDiagnostics.push({
        source: 'browser',
        type: 'page-error',
        text: error.message,
        payload: {
          stack: error.stack || null
        }
      });
    });
    page.on('console', (message) => {
      browserDiagnostics.push({
        source: 'browser',
        type: `console-${message.type()}`,
        text: message.text(),
        payload: null
      });
    });
    await page.goto(harnessOrigin, { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => window.__voiceSmoke && typeof window.__voiceSmoke.start === 'function',
      undefined,
      { timeout: 15000 }
    );
    await page.evaluate((assistantId) => window.__voiceSmoke.start(assistantId), clientConfig.assistantId);

    const maxDurationMs = (scenario.runner?.max_duration_seconds ?? 90) * 1000;
    await page.waitForFunction(
      () => {
        const snapshot = window.__voiceSmoke.snapshot();
        return snapshot.callEnded || snapshot.errors.length > 0;
      },
      undefined,
      { timeout: maxDurationMs }
    );

    const snapshot = await page.evaluate(() => window.__voiceSmoke.snapshot());
    const callId = inferCallId(snapshot);
    const callArtifact = await fetchCompletedCall({
      callId,
      assistantId: clientConfig.assistantId,
      apiKey: clientConfig.apiKey,
      baseUrl: clientConfig.baseUrl,
      scenarioStartedAt,
      scenario
    });

    const rawCallPath = path.join(rawCallsDir, `${scenario.scenario_id}.call.json`);
    writeJson(rawCallPath, callArtifact);

    const eventsPath = path.join(eventsDir, `${scenario.scenario_id}.events.json`);
    writeJson(eventsPath, snapshot);

    const normalizedRunPath = path.join(normalizedDir, `${scenario.scenario_id}.run.v1.json`);
    runCommand(process.execPath, [
      path.join(ROOT_DIR, 'scripts', 'autonomy', 'ingest-vapi-call-log.js'),
      '--input', rawCallPath,
      '--output', normalizedRunPath,
      '--scenario-id', scenario.scenario_id,
      '--environment', 'staging',
      '--run-kind', 'synthetic_test'
    ]);

    const normalizedRun = readJson(normalizedRunPath);
    const eventTrace = sanitizeEventTrace(snapshot, scenarioStartedAt).concat(
      browserDiagnostics.map((entry, index) => ({
        sequence: (snapshot?.events || []).length + index,
        source: entry.source,
        type: entry.type,
        step_id: null,
        time_ms: null,
        seconds_from_start: null,
        text: entry.text,
        payload: entry.payload
      }))
    );
    const scored = scoreScenario({
      scenario,
      callArtifact,
      normalizedRun,
      eventTrace,
      error: null,
      scenarioStepTimings
    });

    if (!options.keepTemp) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      writeJson(path.join(tempDir, 'audio-input.json'), {
        combined_path: toRelativePath(combinedPath),
        segment_paths: segmentPaths.map(toRelativePath),
        step_timings: scenarioStepTimings
      });
    }

    return {
      schema_version: 'staging-voice-run.v1',
      suite_run_id: suiteRunId,
      scenario_id: scenario.scenario_id,
      title: scenario.title,
      environment: 'staging',
      started_at: scenarioStartedAt,
      completed_at: stableNowIso(),
      status: scored.status,
      call: {
        call_id: callArtifact?.id || callId || null,
        assistant_id: callArtifact?.assistantId || clientConfig.assistantId,
        web_call_url: callArtifact?.webCallUrl || null,
        started_at: callArtifact?.startedAt || null,
        ended_at: callArtifact?.endedAt || null,
        ended_reason: callArtifact?.endedReason || null,
        status: callArtifact?.status || null,
        duration_seconds: typeof callArtifact?.durationSeconds === 'number'
          ? callArtifact.durationSeconds
          : null
      },
      artifacts: {
        raw_call_path: toRelativePath(rawCallPath),
        normalized_run_path: toRelativePath(normalizedRunPath),
        events_path: toRelativePath(eventsPath)
      },
      steps: scenario.steps.map((step, index) => ({
        sequence: index,
        step_id: step.step_id,
        type: step.type,
        status: 'completed',
        started_at: null,
        completed_at: null,
        failure_reason: null
      })),
      event_trace: eventTrace,
      tool_trace: buildToolTraceFromNormalizedRun(normalizedRun),
      criteria: scored.criteria,
      summary: scored.summary,
      error: null
    };
  } catch (error) {
    let snapshot = { events: [], messages: [], errors: [] };
    if (page) {
      try {
        snapshot = await page.evaluate(() => window.__voiceSmoke ? window.__voiceSmoke.snapshot() : ({ events: [], messages: [], errors: [] }));
      } catch {
        snapshot = { events: [], messages: [], errors: [] };
      }
    }
    const eventTrace = sanitizeEventTrace(snapshot, scenarioStartedAt).concat(
      browserDiagnostics.map((entry, index) => ({
        sequence: (snapshot?.events || []).length + index,
        source: entry.source,
        type: entry.type,
        step_id: null,
        time_ms: null,
        seconds_from_start: null,
        text: entry.text,
        payload: entry.payload
      }))
    );
    if (!options.keepTemp) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    const failureType = classifyFailureType({
      error,
      failures: [],
      eventTrace,
      callArtifact: null
    });
    const endedReason = extractEndedReasonFromEvents(eventTrace);
    return {
      schema_version: 'staging-voice-run.v1',
      suite_run_id: suiteRunId,
      scenario_id: scenario.scenario_id,
      title: scenario.title,
      environment: 'staging',
      started_at: scenarioStartedAt,
      completed_at: stableNowIso(),
      status: 'error',
      call: {
        call_id: inferCallId(snapshot),
        assistant_id: clientConfig.assistantId,
        web_call_url: null,
        started_at: null,
        ended_at: null,
        ended_reason: null,
        status: null,
        duration_seconds: null
      },
      artifacts: {
        raw_call_path: null,
        normalized_run_path: null,
        events_path: null
      },
      steps: scenario.steps.map((step, index) => ({
        sequence: index,
        step_id: step.step_id,
        type: step.type,
        status: 'failed',
        started_at: null,
        completed_at: null,
        failure_reason: error.message
      })),
      event_trace: eventTrace,
      tool_trace: [],
      criteria: [],
      summary: {
        failure_count: 1,
        warning_count: 0,
        booking_created: false,
        reception_task_created: false,
        structured_output_found: false,
        ended_reason: endedReason,
        failure_type: failureType,
        suspected_root_cause: inferRootCause({ error, failureType, firstFailure: null }),
        failure_reason: error.message,
        tool_summary: buildToolSummary([]),
        structured_output_summary: buildStructuredOutputSummary({ found: false, outputId: null, outputName: null, result: null }),
        transcript_excerpt: [],
        event_excerpt: buildEventExcerpt(eventTrace)
      },
      error: {
        message: error.message
      }
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore browser close failures.
      }
    }
    if (server) {
      try {
        await server.stop();
      } catch {
        // Ignore server close failures.
      }
    }
  }
}

async function main() {
  loadRootEnvIfPresent();
  const options = parseArgs(process.argv.slice(2));
  const scenarios = loadScenarios(
    options.scenarioIds,
    options.languageFilter,
    options.languageExplicit,
    options.includeDraft
  );

  if (options.listOnly) {
    printScenarioList(scenarios);
    return;
  }

  if (scenarios.length === 0) {
    throw new Error(`No active staging voice scenarios found for language filter ${options.languageFilter}`);
  }

  const clientConfig = buildClientConfig();
  ensureAudioFixtures(scenarios);
  const suiteRunId = `staging-voice-${compactTimestamp()}`;
  const outputDir = options.outputDir || path.join(DEFAULT_RUNS_DIR, suiteRunId);
  const reportPath = options.reportPath || path.join(DEFAULT_REPORTS_DIR, `${suiteRunId}.md`);
  ensureDir(outputDir);
  ensureDir(path.dirname(reportPath));

  const startedAt = stableNowIso();
  const scenarioRuns = [];

  for (const scenario of scenarios) {
    console.log(`Running ${scenario.scenario_id}...`);
    const result = await executeScenario(scenario, clientConfig, suiteRunId, outputDir, options);
    const resultPath = path.join(outputDir, 'scenarios', `${scenario.scenario_id}.result.v1.json`);
    writeJson(resultPath, result);
    result.__resultPath = resultPath;
    scenarioRuns.push(result);
  }

  const failedCount = scenarioRuns.filter((scenario) => scenario.status !== 'passed').length;
  const suiteSummary = {
    schema_version: 'staging-voice-suite.v1',
    suite_run_id: suiteRunId,
    environment: 'staging',
    started_at: startedAt,
    completed_at: stableNowIso(),
    status: failedCount === 0 ? 'passed' : 'failed',
    scenario_count: scenarioRuns.length,
    passed_count: scenarioRuns.length - failedCount,
    failed_count: failedCount,
    run_dir: toRelativePath(outputDir),
    report_path: toRelativePath(reportPath),
    scenario_results: scenarioRuns.map((scenario) => ({
      scenario_id: scenario.scenario_id,
      title: scenario.title,
      status: scenario.status,
      call_id: scenario.call.call_id,
      result_path: toRelativePath(scenario.__resultPath),
      normalized_run_path: scenario.artifacts.normalized_run_path,
      failure_type: scenario.summary.failure_type,
      failure_reason: scenario.summary.failure_reason,
      suspected_root_cause: scenario.summary.suspected_root_cause
    }))
  };

  writeJson(path.join(outputDir, 'suite.result.v1.json'), suiteSummary);
  fs.writeFileSync(reportPath, renderMarkdownReport(suiteSummary, scenarioRuns), 'utf8');

  console.log('');
  console.log(`Suite ${suiteSummary.suite_run_id}: ${suiteSummary.passed_count}/${suiteSummary.scenario_count} passed`);
  console.log(`Artifacts: ${suiteSummary.run_dir}`);
  console.log(`Report: ${suiteSummary.report_path}`);

  if (suiteSummary.status !== 'passed') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  evaluateCriterion,
  selectCompletedRecentCall
};
