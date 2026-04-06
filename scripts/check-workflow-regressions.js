#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const workflowsDir = path.join(rootDir, 'n8n', 'workflows');
const assistantConfigPath = path.join(rootDir, 'configs', 'vapi', 'assistant.v2.json');
const toolDefinitionsPath = path.join(rootDir, 'configs', 'vapi', 'tool-definitions.v1.json');
const modelPayloadBaselinePath = path.join(rootDir, 'configs', 'vapi', 'model-payload-baseline.v1.json');
const structuredOutputSchemaPath = path.join(rootDir, 'docs', 'vapi-structured-output.json');
const {
  createContext: createChatRegressionContext,
  normalizeOutputForTurn,
  evaluateCriterion: evaluateChatCriterion,
  resolveScenarioTemplates,
  getEnabledToolBindings,
  getMissingRequiredToolBindings
} = require(path.join(
  rootDir,
  'scripts',
  'autonomy',
  'run-staging-regression-suite.js'
));
const {
  buildRun,
  deriveLatencyDiagnostics,
  pickCallEntries
} = require(path.join(
  rootDir,
  'scripts',
  'autonomy',
  'ingest-vapi-call-log.js'
));
const {
  buildSshContext,
  buildN8nExecutionSummaries,
  buildToolTraceRefs,
  matchToolTracesToVapiSpeechEntries,
  matchToolTracesToVapiWebhookEntries,
  matchToolTracesToCaddyEntries,
  matchToolTracesToExecutions,
  parseVapiArtifactAssistantSpeechEntries,
  parseVapiArtifactWebhookEntries,
  parseCaddyAccessLogBundle,
  renderSuiteReport
} = require(path.join(
  rootDir,
  'scripts',
  'autonomy',
  'run-vapi-live-autoeval.js'
));

function usage() {
  console.log(`Usage:
  node scripts/check-workflow-regressions.js [options]

Options:
  --help                  Show this help message.
`);
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
}

parseArgs(process.argv.slice(2));
const enabledLanes = new Set(['contract', 'assistant-invariant']);

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function loadEnvironmentBindings(environment) {
  return loadJson(path.join(rootDir, 'configs', 'vapi', 'environments', `${environment}.json`));
}

function loadWorkflow(filename) {
  return loadJson(path.join(workflowsDir, filename));
}

function loadAssistantConfig() {
  return loadJson(assistantConfigPath);
}

function loadToolDefinitions() {
  return loadJson(toolDefinitionsPath);
}

function loadModelPayloadBaseline() {
  return loadJson(modelPayloadBaselinePath);
}

function loadStructuredOutputSchema() {
  return loadJson(structuredOutputSchemaPath);
}

function loadSchema(filename) {
  return loadJson(path.join(rootDir, 'schemas', filename));
}

function loadStagingScenario(filename) {
  return loadJson(path.join(rootDir, 'autonomy', 'scenarios', 'staging', filename));
}

function loadAutonomyExample(filename) {
  return loadJson(path.join(rootDir, 'autonomy', 'examples', filename));
}

function getScenarioCriterion(scenario, criterionId) {
  const criterion = [
    ...scenario.turns.flatMap((turn) => turn.assertions || []),
    ...scenario.rubric
  ].find((item) => item.criterion_id === criterionId);

  assert.ok(criterion, `Missing criterion ${criterionId} in scenario ${scenario.scenario_id}`);
  return criterion;
}

function renderAssistantConfig(environment, envOverrides = {}) {
  const output = execFileSync('bash', ['scripts/render-vapi-assistant-config.sh', environment], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...envOverrides
    },
    encoding: 'utf8'
  });
  return JSON.parse(output);
}

function getAssistantSystemPrompt(config = loadAssistantConfig()) {
  const prompt = config.assistant?.model?.messages?.find(
    (message) => message.role === 'system' && typeof message.content === 'string'
  )?.content;
  if (!prompt) {
    throw new Error('Assistant system prompt not found in configs/vapi/assistant.v2.json');
  }
  return prompt;
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L');
}

function containsPolishDiacritics(value) {
  return /[ąćęłńóśźż]/i.test(String(value || ''));
}

function getToolDefinitionMap(toolDefinitions = loadToolDefinitions()) {
  return toolDefinitions.tools || {};
}

function getToolDescriptionStats(toolDefinitions = loadToolDefinitions()) {
  const perTool = {};
  for (const [toolName, definition] of Object.entries(getToolDefinitionMap(toolDefinitions))) {
    perTool[toolName] = typeof definition?.description === 'string' ? definition.description.length : 0;
  }
  return {
    perTool,
    total: Object.values(perTool).reduce((sum, value) => sum + value, 0)
  };
}

function getNode(workflow, nodeName) {
  const node = workflow.nodes.find((item) => item.name === nodeName);
  if (!node) {
    throw new Error(`Node ${nodeName} not found in workflow ${workflow.name}`);
  }
  return node;
}

function getNodeCode(workflow, nodeName) {
  const node = getNode(workflow, nodeName);
  if (!node?.parameters?.jsCode) {
    throw new Error(`Node ${nodeName} not found in workflow ${workflow.name}`);
  }
  return node.parameters.jsCode;
}

function getNodeParameters(workflowFilename, nodeName) {
  const workflow = loadWorkflow(workflowFilename);
  return getNode(workflow, nodeName).parameters || {};
}

function executeCode(code, globals) {
  const names = Object.keys(globals);
  const values = Object.values(globals);
  return new Function(...names, `return (function(){\n${code}\n})();`)(...values);
}

function normalizeNodeItems(nodeResult) {
  return Array.isArray(nodeResult) ? nodeResult : [nodeResult];
}

function makeSelector(nodeResults) {
  return function selectNode(nodeName) {
    if (!(nodeName in nodeResults)) {
      throw new Error(`Unexpected node selector: ${nodeName}`);
    }
    const items = normalizeNodeItems(nodeResults[nodeName]);
    return {
      first() {
        return { json: items[0] };
      },
      all() {
        return items.map((json) => ({ json }));
      }
    };
  };
}

function makeInput(items) {
  return {
    all() {
      return items.map((json) => ({ json }));
    }
  };
}

function expectValidationError(result, message) {
  assert.equal(result.ok, false);
  assert.ok(
    Array.isArray(result.validationErrors) && result.validationErrors.includes(message),
    `Expected validation error ${message}, got ${JSON.stringify(result.validationErrors)}`
  );
}

function expectUnauthorized(result) {
  expectValidationError(result, 'webhook request is unauthorized');
}

function runParse(workflowFilename, nodeName, payload, env = {}) {
  const workflow = loadWorkflow(workflowFilename);
  const code = getNodeCode(workflow, nodeName);
  return executeCode(code, { $json: payload, $env: env })[0].json;
}

function runCodeNode(workflowFilename, nodeName, selectorNodes, inputItems = [], env = {}) {
  return runCodeNodeItems(workflowFilename, nodeName, selectorNodes, inputItems, env)[0];
}

function runCodeNodeItems(workflowFilename, nodeName, selectorNodes, inputItems = [], env = {}) {
  const workflow = loadWorkflow(workflowFilename);
  const code = getNodeCode(workflow, nodeName);
  return executeCode(code, {
    $: makeSelector(selectorNodes),
    $input: makeInput(inputItems),
    $env: env
  }).map((item) => item.json);
}

async function runAsyncCodeNode(
  workflowFilename,
  nodeName,
  selectorNodes,
  inputItems = [],
  env = {},
  extraGlobals = {}
) {
  const workflow = loadWorkflow(workflowFilename);
  const code = getNodeCode(workflow, nodeName);
  const result = await executeCode(code, {
    $: makeSelector(selectorNodes),
    $input: makeInput(inputItems),
    $env: env,
    ...extraGlobals
  });
  return result[0].json;
}

function getResponseCodeOption(workflowFilename, nodeName) {
  const workflow = loadWorkflow(workflowFilename);
  const node = getNode(workflow, nodeName);
  return node.parameters?.options?.responseCode ?? null;
}

let testsRun = 0;
let testsSkipped = 0;
const pendingTests = [];
const laneStats = new Map();

function noteLane(lane, field) {
  if (!laneStats.has(lane)) {
    laneStats.set(lane, {
      registered: 0,
      run: 0,
      skipped: 0
    });
  }
  laneStats.get(lane)[field] += 1;
}

function test(name, fn, { lane = 'contract' } = {}) {
  testsRun += 1;
  noteLane(lane, 'registered');

  if (!enabledLanes.has(lane)) {
    testsSkipped += 1;
    noteLane(lane, 'skipped');
    console.log(`skip - ${name} (${lane})`);
    return;
  }

  noteLane(lane, 'run');
  pendingTests.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        console.log(`ok - ${name}`);
      })
      .catch((error) => {
        console.error(`not ok - ${name}`);
        console.error(error.stack || error.message);
        process.exitCode = 1;
      })
  );
}

function assistantInvariantTest(name, fn) {
  test(name, fn, { lane: 'assistant-invariant' });
}

const defaultEnv = {
  CLINIC_TIMEZONE: 'Europe/Warsaw',
  DEFAULT_APPOINTMENT_DURATION_MINUTES: '45',
  DEFAULT_SLOT_INCREMENT_MINUTES: '15',
  DEFAULT_SLOT_SEARCH_LIMIT: '3',
  CLINIC_WORKING_HOURS_START: '09:00',
  CLINIC_WORKING_HOURS_END: '21:00',
  CLINIC_OPEN_WEEKDAYS: '1,2,3,4,5',
  GOOGLE_CALENDAR_ID: 'primary'
};

test('checkAvailability rejects natural-language requestedDate without throwing', () => {
  const result = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: 'tomorrow',
      timePreference: 'morning',
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  expectValidationError(result, 'requestedDate must use YYYY-MM-DD');
});

test('checkAvailability rejects unauthorized requests when webhook secret is configured', () => {
  const result = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      body: {
        service: { id: 'consultation' },
        timePreference: 'first_available',
        timezone: 'Europe/Warsaw'
      },
      headers: {}
    },
    { ...defaultEnv, AI_RECEPTIONIST_WEBHOOK_SECRET: 'topsecret' }
  );
  expectUnauthorized(result);
});

test('checkAvailability rejects malformed requestedTime', () => {
  const result = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: '2026-03-16',
      requestedTime: 'banana',
      timePreference: 'specific_time',
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  expectValidationError(result, 'requestedTime must use HH:MM');
});

test('checkAvailability rejects overflow requestedTime instead of rolling into the next day', () => {
  const result = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: '2026-03-16',
      requestedTime: '25:99',
      timePreference: 'specific_time',
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  expectValidationError(result, 'requestedTime must use HH:MM');
});

test('checkAvailability rejects malformed timezone', () => {
  const result = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: '2026-03-16',
      timePreference: 'morning',
      timezone: 'Warsaw'
    },
    defaultEnv
  );
  expectValidationError(result, 'timezone is invalid');
});

test('checkAvailability first_available search window skips closed weekend days', () => {
  const result = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: '2026-03-20',
      timePreference: 'first_available',
      searchDays: 2,
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(result.ok, true);
  assert.equal(result.searchDays, 2);
  assert.equal(result.requestedDateWasExplicit, true);
  assert.ok(new Date(result.windowEnd) > new Date(result.windowStart));
  assert.ok(['2026-03-20', '2026-03-23'].includes(result.windowStart.slice(0, 10)));
  assert.equal(result.windowEnd.slice(0, 10), '2026-03-23');
  assert.notEqual(result.windowStart.slice(0, 10), '2026-03-21');
  assert.notEqual(result.windowStart.slice(0, 10), '2026-03-22');
});

test('checkAvailability broad-window searches can span multiple clinic days', () => {
  const result = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: '2026-03-20',
      timePreference: 'afternoon',
      searchDays: 3,
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(result.ok, true);
  assert.equal(result.searchDays, 3);
  assert.equal(result.windowStart.slice(0, 10), '2026-03-20');
  assert.equal(result.windowEnd.slice(0, 10), '2026-03-24');
});

test('checkAvailability implicit evening searches stay bounded and prepare a nearest-slot fallback', () => {
  const result = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      timePreference: 'evening',
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(result.ok, true);
  assert.equal(result.requestedDateWasExplicit, false);
  assert.equal(result.timePreference, 'evening');
  assert.equal(result.searchDays, 5);
  assert.match(result.requestedDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result.searchPlans?.length, 2);
  assert.equal(result.searchPlans?.[0]?.stage, 'primary');
  assert.equal(result.searchPlans?.[0]?.timePreference, 'evening');
  assert.equal(result.searchPlans?.[0]?.searchDays, 5);
  assert.equal(result.searchPlans?.[1]?.stage, 'first_available_fallback');
  assert.equal(result.searchPlans?.[1]?.timePreference, 'first_available');
  assert.equal(result.searchPlans?.[1]?.searchDays, 5);
});

test('checkAvailability implicit exact-hour searches stay bounded and keep the hour', () => {
  const result = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedTime: '18:00',
      timePreference: 'specific_time',
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(result.ok, true);
  assert.equal(result.requestedDateWasExplicit, false);
  assert.equal(result.timePreference, 'specific_time');
  assert.equal(result.requestedTime, '18:00');
  assert.equal(result.searchDays, 5);
  assert.match(result.requestedDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result.searchPlans?.length, 2);
  assert.equal(result.searchPlans?.[0]?.stage, 'primary');
  assert.equal(result.searchPlans?.[0]?.timePreference, 'specific_time');
  assert.equal(result.searchPlans?.[0]?.requestedTime, '18:00');
  assert.equal(result.searchPlans?.[0]?.searchDays, 5);
  assert.equal(result.searchPlans?.[1]?.stage, 'first_available_fallback');
  assert.equal(result.searchPlans?.[1]?.timePreference, 'first_available');
});

test('checkAvailability broad weekend requests roll to the next open clinic day', () => {
  const result = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: '2026-03-21',
      timePreference: 'morning',
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(result.ok, true);
  assert.equal(result.windowStart.slice(0, 10), '2026-03-23');
  assert.equal(result.windowEnd.slice(0, 10), '2026-03-23');
});

test('calendar availability nodes use timeMin/timeMax fields expected by n8n import', () => {
  const checkAvailabilityWorkflow = loadWorkflow('tool_check-availability.json');
  const checkAvailabilityParams = getNodeParameters('tool_check-availability.json', 'Get Busy Events');
  assert.equal(checkAvailabilityParams.timeMin, '={{ $json.windowStart }}');
  assert.equal(checkAvailabilityParams.timeMax, '={{ $json.windowEnd }}');
  assert.equal(checkAvailabilityParams.start, undefined);
  assert.equal(checkAvailabilityParams.end, undefined);
  assert.equal(getNode(checkAvailabilityWorkflow, 'Get Busy Events').onError, 'continueRegularOutput');

  const createEventWorkflow = loadWorkflow('tool_create-event.json');
  const createEventParams = getNodeParameters('tool_create-event.json', 'Re-check Busy Events');
  assert.equal(createEventParams.timeMin, '={{ $json.slotStart }}');
  assert.equal(createEventParams.timeMax, '={{ $json.slotEnd }}');
  assert.equal(createEventParams.start, undefined);
  assert.equal(createEventParams.end, undefined);
  assert.equal(getNode(createEventWorkflow, 'Re-check Busy Events').onError, 'continueRegularOutput');
});

test('checkAvailability returns only weekday slots inside clinic hours', () => {
  const parseResult = {
    requestId: 'req_weekday_only',
    toolCallId: null,
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    requestedDate: '2026-03-21',
    requestedDateWasExplicit: true,
    requestedTime: null,
    timePreference: 'first_available',
    durationMinutes: 45,
    limit: 5,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 1,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-21T08:00:00.000Z',
    windowEnd: '2026-03-23T20:00:00.000Z'
  };
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [],
    defaultEnv
  );
  assert.equal(result.available, true);
  assert.ok(result.slots.length > 0);
  assert.ok(result.slots.every((slot) => slot.start.startsWith('2026-03-23T')));
  assert.ok(result.slots.every((slot) => slot.start.slice(11, 16) >= '09:00'));
  assert.ok(result.slots.every((slot) => slot.end.slice(11, 16) <= '21:00'));
});

test('checkAvailability keeps first_available ordering chronological even when later slots sit next to busy events', () => {
  const parseResult = {
    requestId: 'req_gapless',
    toolCallId: null,
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    requestedDate: '2026-03-16',
    requestedDateWasExplicit: true,
    requestedTime: null,
    timePreference: 'first_available',
    durationMinutes: 45,
    limit: 3,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 1,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-16T08:00:00.000Z',
    windowEnd: '2026-03-16T20:00:00.000Z'
  };
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [
      {
        start: { dateTime: '2026-03-16T13:00:00.000Z' },
        end: { dateTime: '2026-03-16T13:45:00.000Z' }
      }
    ],
    defaultEnv
  );
  assert.equal(result.available, true);
  assert.deepEqual(
    result.slots.slice(0, 2).map((slot) => slot.start),
    ['2026-03-16T09:00:00+01:00', '2026-03-16T09:15:00+01:00']
  );
});

test('checkAvailability keeps morning searches inside the morning window across multiple days', () => {
  const parseResult = {
    requestId: 'req_morning_window',
    toolCallId: null,
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'implant_consultation' },
    requestedDate: '2026-03-23',
    requestedTime: null,
    timePreference: 'morning',
    durationMinutes: 45,
    limit: 3,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 3,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-23T08:00:00.000Z',
    windowEnd: '2026-03-25T12:00:00.000Z'
  };
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [
      {
        start: { dateTime: '2026-03-23T09:00:00+01:00' },
        end: { dateTime: '2026-03-23T20:15:00+01:00' }
      }
    ],
    defaultEnv
  );
  assert.equal(result.available, true);
  assert.deepEqual(
    result.slots.map((slot) => slot.start),
    [
      '2026-03-24T09:00:00+01:00',
      '2026-03-24T09:15:00+01:00',
      '2026-03-24T09:30:00+01:00'
    ]
  );
  assert.ok(result.slots.every((slot) => slot.start.slice(11, 16) < '13:00'));
  assert.ok(result.slots.every((slot) => slot.end.slice(11, 16) <= '13:00'));
});

test('checkAvailability implicit specific_time searches return the same hour across business days', () => {
  const parseResult = {
    requestId: 'req_specific_time_multi_day',
    toolCallId: null,
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    requestedDate: '2026-03-16',
    requestedDateWasExplicit: false,
    requestedTime: '18:00',
    timePreference: 'specific_time',
    durationMinutes: 45,
    limit: 3,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 5,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-16T17:00:00.000Z',
    windowEnd: '2026-03-20T17:45:00.000Z'
  };
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [],
    defaultEnv
  );
  assert.equal(result.available, true);
  assert.equal(result.normalizedRequest?.timePreference, 'specific_time');
  assert.equal(result.normalizedRequest?.requestedTime, '18:00');
  assert.equal(result.normalizedRequest?.searchDays, 5);
  assert.deepEqual(
    result.slots.map((slot) => slot.start),
    [
      '2026-03-16T18:00:00+01:00',
      '2026-03-17T18:00:00+01:00',
      '2026-03-18T18:00:00+01:00'
    ]
  );
  assert.ok(result.slots.every((slot) => slot.start.slice(11, 16) === '18:00'));
});

test('checkAvailability widens a concrete morning miss across later mornings before first_available', () => {
  const parseResult = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: '2026-03-16',
      timePreference: 'morning',
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.searchPlans?.length, 3);

  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [
      {
        start: { dateTime: '2026-03-16T09:00:00+01:00' },
        end: { dateTime: '2026-03-16T21:00:00+01:00' }
      }
    ],
    defaultEnv
  );

  assert.equal(result.available, true);
  assert.equal(result.requestedRangeAvailable, false);
  assert.equal(result.normalizedRequest?.timePreference, 'morning');
  assert.equal(result.normalizedRequest?.searchDays, 1);
  assert.equal(result.resolvedSearch?.stage, 'same_preference_fallback');
  assert.equal(result.resolvedSearch?.timePreference, 'morning');
  assert.equal(result.resolvedSearch?.searchDays, 5);
  assert.ok(result.slots.every((slot) => slot.start.startsWith('2026-03-17T')));
  assert.ok(result.slots.every((slot) => slot.start.slice(11, 16) < '13:00'));
  assert.match(
    normalizeSearchText(result.message),
    /nie widze wolnych terminow na poniedzialek, szesnastego marca rano/i
  );
});

test('checkAvailability falls back to first_available when the requested afternoon stays full', () => {
  const parseResult = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: '2026-03-16',
      timePreference: 'afternoon',
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.searchPlans?.length, 3);

  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [
      {
        start: { dateTime: '2026-03-16T13:00:00+01:00' },
        end: { dateTime: '2026-03-16T21:00:00+01:00' }
      },
      {
        start: { dateTime: '2026-03-17T13:00:00+01:00' },
        end: { dateTime: '2026-03-17T21:00:00+01:00' }
      },
      {
        start: { dateTime: '2026-03-18T13:00:00+01:00' },
        end: { dateTime: '2026-03-18T21:00:00+01:00' }
      },
      {
        start: { dateTime: '2026-03-19T13:00:00+01:00' },
        end: { dateTime: '2026-03-19T21:00:00+01:00' }
      },
      {
        start: { dateTime: '2026-03-20T13:00:00+01:00' },
        end: { dateTime: '2026-03-20T21:00:00+01:00' }
      }
    ],
    defaultEnv
  );

  assert.equal(result.available, true);
  assert.equal(result.requestedRangeAvailable, false);
  assert.equal(result.normalizedRequest?.timePreference, 'afternoon');
  assert.equal(result.normalizedRequest?.searchDays, 1);
  assert.equal(result.resolvedSearch?.stage, 'first_available_fallback');
  assert.equal(result.resolvedSearch?.timePreference, 'first_available');
  assert.equal(result.resolvedSearch?.searchDays, 8);
  assert.deepEqual(
    result.slots.map((slot) => slot.start),
    [
      '2026-03-16T09:00:00+01:00',
      '2026-03-17T09:00:00+01:00',
      '2026-03-18T09:00:00+01:00'
    ]
  );
  assert.ok(result.slots.every((slot) => slot.start.slice(11, 16) === '09:00'));
  assert.match(
    normalizeSearchText(result.message),
    /nie widze wolnych terminow na poniedzialek, szesnastego marca po poludniu/i
  );

  const formatted = executeCode(getNodeCode(loadWorkflow('tool_check-availability.json'), 'Format Success'), {
    $json: result
  })[0].json;
  const formattedPayload = formatted.results?.[0]?.result || formatted;
  assert.equal(formattedPayload.requestedRangeAvailable, false);
  assert.equal(formattedPayload.resolvedSearch?.stage, 'first_available_fallback');
  assert.equal(formattedPayload.resolvedSearch?.searchDays, 8);
});

test('checkAvailability exact daypart misses can reach later bounded first_available alternatives', () => {
  const parseResult = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: '2026-03-16',
      timePreference: 'afternoon',
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.searchPlans?.length, 3);
  assert.equal(parseResult.searchPlans?.[2]?.stage, 'first_available_fallback');
  assert.equal(parseResult.searchPlans?.[2]?.searchDays, 8);

  const fullyBlockedDays = [
    '2026-03-16',
    '2026-03-17',
    '2026-03-18',
    '2026-03-19',
    '2026-03-20',
    '2026-03-23'
  ].map((dateText) => ({
    start: { dateTime: `${dateText}T09:00:00+01:00` },
    end: { dateTime: `${dateText}T21:00:00+01:00` }
  }));

  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    fullyBlockedDays,
    defaultEnv
  );

  assert.equal(result.available, true);
  assert.equal(result.requestedRangeAvailable, false);
  assert.equal(result.resolvedSearch?.stage, 'first_available_fallback');
  assert.equal(result.resolvedSearch?.searchDays, 8);
  assert.equal(result.slots[0]?.start, '2026-03-24T09:00:00+01:00');
  assert.ok(
    result.slots.some((slot) => slot.start === '2026-03-25T09:00:00+01:00'),
    'expected fallback slots to reach later alternatives inside the 8-day horizon'
  );
  assert.match(
    normalizeSearchText(result.message),
    /nie widze wolnych terminow na poniedzialek, szesnastego marca po poludniu/i
  );
});

test('checkAvailability implicit evening searches can fall back to nearest slots inside the same bounded horizon', () => {
  const parseResult = {
    requestId: 'req_evening_implicit_fallback',
    toolCallId: null,
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    requestedDate: '2026-03-16',
    requestedDateWasExplicit: false,
    requestedTime: null,
    timePreference: 'evening',
    durationMinutes: 45,
    limit: 3,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 5,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-16T16:00:00.000Z',
    windowEnd: '2026-03-20T20:00:00.000Z',
    searchPlans: [
      {
        stage: 'primary',
        requestedDate: '2026-03-16',
        requestedDateWasExplicit: false,
        requestedTime: null,
        timePreference: 'evening',
        searchDays: 5,
        windowStart: '2026-03-16T16:00:00.000Z',
        windowEnd: '2026-03-20T20:00:00.000Z'
      },
      {
        stage: 'first_available_fallback',
        requestedDate: '2026-03-16',
        requestedDateWasExplicit: false,
        requestedTime: null,
        timePreference: 'first_available',
        searchDays: 5,
        windowStart: '2026-03-16T08:00:00.000Z',
        windowEnd: '2026-03-20T20:00:00.000Z'
      }
    ]
  };
  const blockedEvenings = [
    '2026-03-16',
    '2026-03-17',
    '2026-03-18',
    '2026-03-19',
    '2026-03-20'
  ].map((dateText) => ({
    start: { dateTime: `${dateText}T17:00:00+01:00` },
    end: { dateTime: `${dateText}T21:00:00+01:00` }
  }));
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    blockedEvenings,
    defaultEnv
  );
  assert.equal(result.available, true);
  assert.equal(result.requestedRangeAvailable, false);
  assert.equal(result.normalizedRequest?.timePreference, 'evening');
  assert.equal(result.normalizedRequest?.searchDays, 5);
  assert.equal(result.resolvedSearch?.stage, 'first_available_fallback');
  assert.equal(result.resolvedSearch?.timePreference, 'first_available');
  assert.equal(result.resolvedSearch?.searchDays, 5);
  assert.deepEqual(
    result.slots.map((slot) => slot.start),
    [
      '2026-03-16T09:00:00+01:00',
      '2026-03-17T09:00:00+01:00',
      '2026-03-18T09:00:00+01:00'
    ]
  );
  assert.match(
    normalizeSearchText(result.message),
    /nie widze wolnych terminow wieczorem w ciagu najblizszych pieciu dni roboczych/i
  );
});

test('checkAvailability explains the bounded first_available search window when no slots exist', () => {
  const parseResult = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'urgent_consultation' },
      requestedDate: '2026-03-16',
      timePreference: 'first_available',
      searchDays: 5,
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.searchPlans?.length, 1);
  assert.equal(parseResult.searchPlans?.[0]?.stage, 'primary');
  assert.equal(parseResult.searchPlans?.[0]?.searchDays, 5);

  const blockedBusinessDates = [
    '2026-03-16',
    '2026-03-17',
    '2026-03-18',
    '2026-03-19',
    '2026-03-20'
  ];

  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    blockedBusinessDates.map((dateText) => {
      const offset = dateText >= '2026-03-30' ? '+02:00' : '+01:00';
      return {
        start: { dateTime: dateText + 'T09:00:00' + offset },
        end: { dateTime: dateText + 'T21:00:00' + offset }
      };
    }),
    defaultEnv
  );

  assert.equal(result.available, false);
  assert.match(
    normalizeSearchText(result.message),
    /najblizszych pieciu dni roboczych/i
  );
  assert.doesNotMatch(
    normalizeSearchText(result.message),
    /trzydziesci dni roboczych/i
  );
});

test('checkAvailability returns first_available slots as the next few available dates in chronological order', () => {
  const parseResult = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'urgent_consultation' },
      requestedDate: '2026-03-16',
      timePreference: 'first_available',
      searchDays: 5,
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.searchPlans?.length, 1);
  assert.equal(parseResult.searchPlans?.[0]?.stage, 'primary');
  assert.equal(parseResult.searchPlans?.[0]?.searchDays, 5);

  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [
      {
        start: { dateTime: '2026-03-16T09:00:00+01:00' },
        end: { dateTime: '2026-03-16T21:00:00+01:00' }
      },
      {
        start: { dateTime: '2026-03-17T09:00:00+01:00' },
        end: { dateTime: '2026-03-17T21:00:00+01:00' }
      }
    ],
    defaultEnv
  );

  assert.equal(result.available, true);
  assert.equal(result.normalizedRequest?.timePreference, 'first_available');
  assert.equal(result.normalizedRequest?.searchDays, 5);
  assert.deepEqual(
    result.slots.map((slot) => slot.start),
    [
      '2026-03-18T09:00:00+01:00',
      '2026-03-19T09:00:00+01:00',
      '2026-03-20T09:00:00+01:00'
    ]
  );
  assert.doesNotMatch(
    normalizeSearchText(result.message),
    /sprawdzilam tez kolejne/i
  );
});

test('checkAvailability keeps a specific-day first_available search bounded while offering next dates as fallback', () => {
  const parseResult = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      requestedDate: '2026-03-16',
      timePreference: 'first_available',
      searchDays: 1,
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.searchPlans?.length, 2);
  assert.equal(parseResult.searchPlans?.[0]?.stage, 'primary');
  assert.equal(parseResult.searchPlans?.[0]?.searchDays, 1);
  assert.equal(parseResult.searchPlans?.[1]?.stage, 'next_available_fallback');
  assert.equal(parseResult.searchPlans?.[1]?.searchDays, 8);

  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [
      {
        start: { dateTime: '2026-03-16T09:00:00+01:00' },
        end: { dateTime: '2026-03-16T21:00:00+01:00' }
      }
    ],
    defaultEnv
  );

  assert.equal(result.available, true);
  assert.equal(result.requestedRangeAvailable, false);
  assert.equal(result.normalizedRequest?.requestedDate, '2026-03-16');
  assert.equal(result.normalizedRequest?.timePreference, 'first_available');
  assert.equal(result.normalizedRequest?.searchDays, 1);
  assert.equal(result.resolvedSearch?.stage, 'next_available_fallback');
  assert.equal(result.resolvedSearch?.timePreference, 'first_available');
  assert.equal(result.resolvedSearch?.searchDays, 8);
  assert.deepEqual(
    result.slots.map((slot) => slot.start),
    [
      '2026-03-17T09:00:00+01:00',
      '2026-03-18T09:00:00+01:00',
      '2026-03-19T09:00:00+01:00'
    ]
  );
  assert.match(
    normalizeSearchText(result.message),
    /nie widze wolnych terminow na poniedzialek, szesnastego marca/i
  );
});

test('checkAvailability speaks the resolved open-day date when an explicit first_available request lands on a closed day', () => {
  const parseResult = runParse(
    'tool_check-availability.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      patient: { isExistingPatient: false },
      requestedDate: '2026-03-21',
      timePreference: 'first_available',
      timezone: 'Europe/Warsaw'
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.requestedDate, '2026-03-21');
  assert.equal(parseResult.requestedDateWasExplicit, true);
  assert.equal(parseResult.searchPlans?.length, 1);
  assert.equal(parseResult.searchPlans?.[0]?.stage, 'primary');
  assert.equal(parseResult.searchPlans?.[0]?.requestedDate, '2026-03-21');
  assert.equal(parseResult.searchPlans?.[0]?.windowStart.slice(0, 10), '2026-03-23');

  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [],
    defaultEnv
  );

  assert.equal(result.available, true);
  assert.equal(result.requestedRangeAvailable, true);
  assert.equal(result.normalizedRequest?.requestedDate, '2026-03-21');
  assert.equal(result.resolvedSearch, undefined);
  assert.deepEqual(
    result.slots.map((slot) => slot.start),
    [
      '2026-03-23T09:00:00+01:00',
      '2026-03-23T09:15:00+01:00',
      '2026-03-23T09:30:00+01:00'
    ]
  );
  assert.match(
    normalizeSearchText(result.message),
    /na poniedzialek, dwudziestego trzeciego marca/i
  );
  assert.doesNotMatch(
    normalizeSearchText(result.message),
    /na sobote, dwudziestego pierwszego marca/i
  );
});

test('checkAvailability preserves calendar provider failures as structured unavailable results', () => {
  const parseResult = {
    requestId: 'req_calendar_provider_error',
    toolCallId: 'tool_call_calendar_provider_error',
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    requestedDate: '2026-03-16',
    requestedDateWasExplicit: true,
    requestedTime: null,
    timePreference: 'first_available',
    durationMinutes: 45,
    limit: 3,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 1,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-16T08:00:00.000Z',
    windowEnd: '2026-03-16T20:00:00.000Z'
  };
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [{ error: { message: 'EAUTH: invalid_grant' } }],
    defaultEnv
  );
  assert.equal(result.available, false);
  assert.deepEqual(result.slots, []);
  assert.equal(result.error?.code, 'CALENDAR_PROVIDER_REJECTED');
  assert.match(result.error?.details?.[0] || '', /EAUTH/i);

  const formatted = executeCode(getNodeCode(loadWorkflow('tool_check-availability.json'), 'Format Success'), {
    $json: result
  })[0].json;
  const formattedPayload = formatted.results[0].result;
  assert.equal(formatted.results[0].toolCallId, result.toolCallId);
  assert.deepEqual(formatted.results[0].message, {
    type: 'request-complete',
    content: result.message
  });
  assert.equal(formattedPayload.error.code, 'CALENDAR_PROVIDER_REJECTED');
  assert.match(
    normalizeSearchText(formattedPayload.message),
    /kalendarz wizyt jest tymczasowo niedostepny/i
  );
});

test('checkAvailability returns speech-safe slot wording for voice playback', () => {
  const parseResult = {
    requestId: 'req_spoken_slot_words',
    toolCallId: 'tool_call_spoken_slot_words',
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    requestedDate: '2026-03-16',
    requestedDateWasExplicit: true,
    requestedTime: null,
    timePreference: 'first_available',
    durationMinutes: 45,
    limit: 2,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 1,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-16T08:00:00.000Z',
    windowEnd: '2026-03-16T20:00:00.000Z'
  };
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [],
    defaultEnv
  );

  assert.equal(result.available, true);
  assert.ok(result.slots.length > 0, 'expected at least one available slot');

  const firstSlot = result.slots[0];
  assert.equal(typeof firstSlot.label, 'string');
  assert.equal(typeof firstSlot.spokenDate, 'string');
  assert.equal(typeof firstSlot.spokenTime, 'string');
  assert.equal(typeof firstSlot.spokenLabel, 'string');
  assert.equal(/\d/.test(firstSlot.label), false);
  assert.equal(/\d/.test(firstSlot.spokenDate), false);
  assert.equal(/\d/.test(firstSlot.spokenTime), false);
  assert.equal(/\d/.test(firstSlot.spokenLabel), false);
  assert.equal(firstSlot.label, firstSlot.spokenLabel);
  assert.equal(firstSlot.spokenDate, 'poniedziałek, szesnastego marca');
  assert.equal(firstSlot.spokenTime, 'o dziewiątej');
  assert.equal(firstSlot.spokenLabel, 'poniedziałek, szesnastego marca o dziewiątej');
  assert.equal(containsPolishDiacritics(firstSlot.spokenLabel), true);
  assert.match(normalizeSearchText(firstSlot.spokenLabel), /o dziewiatej/);
});

test('checkAvailability names doctor Magdalena Szajnar for default first-visit consultation offers', () => {
  const parseResult = {
    requestId: 'req_first_visit_doctor_name',
    toolCallId: 'tool_call_first_visit_doctor_name',
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    patient: { isExistingPatient: false },
    requestedDate: '2026-03-16',
    requestedDateWasExplicit: true,
    requestedTime: null,
    timePreference: 'first_available',
    durationMinutes: 45,
    limit: 2,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 1,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-16T08:00:00.000Z',
    windowEnd: '2026-03-16T20:00:00.000Z'
  };
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [],
    defaultEnv
  );

  assert.equal(result.available, true);
  assert.match(
    normalizeSearchText(result.message),
    /magdaleny szajnar/i
  );
  assert.match(
    normalizeSearchText(result.message),
    /mam wolne terminy do doktor magdaleny szajnar|mam wolny termin do doktor magdaleny szajnar/i
  );
});

test('checkAvailability keeps doctor Magdalena Szajnar in first-visit no-availability replies', () => {
  const parseResult = {
    requestId: 'req_first_visit_doctor_name_unavailable',
    toolCallId: 'tool_call_first_visit_doctor_name_unavailable',
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    patient: { isExistingPatient: false },
    requestedDate: '2026-03-16',
    requestedDateWasExplicit: true,
    requestedTime: null,
    timePreference: 'first_available',
    durationMinutes: 45,
    limit: 2,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 1,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-16T08:00:00.000Z',
    windowEnd: '2026-03-16T20:00:00.000Z'
  };
  const blockedDay = [
    {
      start: { dateTime: '2026-03-16T09:00:00+01:00' },
      end: { dateTime: '2026-03-16T21:00:00+01:00' }
    }
  ];
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    blockedDay,
    defaultEnv
  );

  assert.equal(result.available, false);
  assert.match(
    normalizeSearchText(result.message),
    /nie widze wolnych terminow do doktor magdaleny szajnar/i
  );
});

test('checkAvailability keeps generic offer wording outside the default first-visit path', () => {
  const parseResult = {
    requestId: 'req_generic_offer_wording',
    toolCallId: 'tool_call_generic_offer_wording',
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    patient: { isExistingPatient: true },
    requestedDate: '2026-03-16',
    requestedDateWasExplicit: true,
    requestedTime: null,
    timePreference: 'first_available',
    durationMinutes: 45,
    limit: 2,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 1,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-16T08:00:00.000Z',
    windowEnd: '2026-03-16T20:00:00.000Z'
  };
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [],
    defaultEnv
  );

  assert.equal(result.available, true);
  assert.doesNotMatch(
    normalizeSearchText(result.message),
    /magdaleny szajnar/i
  );
});

test('checkAvailability formats a speech-safe tool-complete message for Vapi', () => {
  const parseResult = {
    requestId: 'req_spoken_slot_message',
    toolCallId: 'tool_call_spoken_slot_message',
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    requestedDate: '2026-03-16',
    requestedDateWasExplicit: true,
    requestedTime: null,
    timePreference: 'first_available',
    durationMinutes: 45,
    limit: 2,
    incrementMinutes: 15,
    slotSearchIncrementMinutes: 15,
    searchDays: 1,
    workingStart: '09:00',
    workingEnd: '21:00',
    openWeekdays: [1, 2, 3, 4, 5],
    windowStart: '2026-03-16T08:00:00.000Z',
    windowEnd: '2026-03-16T20:00:00.000Z'
  };
  const result = runCodeNode(
    'tool_check-availability.json',
    'Build Slots',
    { 'Parse Request': parseResult },
    [],
    defaultEnv
  );
  const formatted = executeCode(getNodeCode(loadWorkflow('tool_check-availability.json'), 'Format Success'), {
    $json: result
  })[0].json;
  const formattedPayload = formatted.results[0].result;

  assert.equal(formatted.results[0].toolCallId, result.toolCallId);
  assert.equal(typeof formatted.results[0].result, 'object');
  assert.deepEqual(formatted.results[0].message, {
    type: 'request-complete',
    content: result.message
  });
  assert.equal(formattedPayload.message, result.message);
  assert.equal(/\d/.test(formattedPayload.message || ''), false);
  assert.equal(containsPolishDiacritics(formattedPayload.message || ''), true);
  assert.match(
    normalizeSearchText(formattedPayload.message || ''),
    /mam wolne terminy|mam wolny termin/i
  );
});

test('createEvent rejects reversed slots', () => {
  const result = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      slotStart: '2026-03-16T10:00:00+01:00',
      slotEnd: '2026-03-16T09:30:00+01:00',
      timezone: 'Europe/Warsaw',
      patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' }
    },
    defaultEnv
  );
  expectValidationError(result, 'slotEnd must be after slotStart');
});

test('createEvent Vapi schema requires digit-only E.164 phone numbers', () => {
  const schema = loadSchema('createEvent.vapi.request.json');
  assert.equal(
    schema.properties?.patient?.properties?.phoneE164?.pattern,
    '^\\+[1-9]\\d{7,14}$'
  );
  assert.equal(
    schema.properties?.telephony?.properties?.callerPhoneE164?.pattern,
    '^\\+[1-9]\\d{7,14}$'
  );
});

test('checkAvailability Vapi schema exposes patient.isExistingPatient for first-visit routing', () => {
  const schema = loadSchema('checkAvailability.vapi.request.json');
  assert.equal(schema.properties?.patient?.type, 'object');
  assert.equal(schema.properties?.patient?.additionalProperties, false);
  assert.equal(schema.properties?.patient?.properties?.isExistingPatient?.type, 'boolean');
});

test('createEvent rejects unsupported service IDs', () => {
  const result = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      service: { id: 'banana_implant_magic' },
      slotStart: '2026-03-16T10:00:00+01:00',
      slotEnd: '2026-03-16T10:30:00+01:00',
      timezone: 'Europe/Warsaw',
      patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' }
    },
    defaultEnv
  );
  expectValidationError(result, 'service.id is unsupported');
});

test('createEvent rejects garbage slot strings', () => {
  const result = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      slotStart: 'soon',
      slotEnd: 'later',
      timezone: 'Europe/Warsaw',
      patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' }
    },
    defaultEnv
  );
  expectValidationError(result, 'slotStart is invalid');
  expectValidationError(result, 'slotEnd is invalid');
});

test('createEvent preserves explicit slotEnd for manual requests', () => {
  const result = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      source: 'manual',
      service: { id: 'consultation', durationMinutes: 30 },
      slotStart: '2026-03-16T08:30:00.000Z',
      slotEnd: '2026-03-16T09:15:00.000Z',
      timezone: 'Europe/Warsaw',
      patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' }
    },
    defaultEnv
  );
  assert.equal(result.ok, true);
  assert.equal(result.slotEnd, '2026-03-16T09:15:00.000Z');
});

test('createEvent normalizes phone slotEnd to the catalog duration when the assistant shortens it', () => {
  const result = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      source: 'phone',
      service: { id: 'implant_consultation', durationMinutes: 30 },
      slotStart: '2026-03-16T09:00:00.000Z',
      slotEnd: '2026-03-16T09:30:00.000Z',
      timezone: 'Europe/Warsaw',
      patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' }
    },
    defaultEnv
  );

  assert.equal(result.ok, true);
  assert.equal(result.service.durationMinutes, 45);
  assert.equal(result.slotEnd, '2026-03-16T09:45:00.000Z');
});

test('createEvent rejects weekend slots', () => {
  const result = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      slotStart: '2026-03-21T09:00:00.000Z',
      slotEnd: '2026-03-21T09:45:00.000Z',
      timezone: 'Europe/Warsaw',
      patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' }
    },
    defaultEnv
  );
  expectValidationError(result, 'slot must fall on an open clinic day');
});

test('createEvent rejects slots outside clinic working hours', () => {
  const result = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      slotStart: '2026-03-16T19:30:00.000Z',
      slotEnd: '2026-03-16T20:15:00.000Z',
      timezone: 'Europe/Warsaw',
      patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' }
    },
    defaultEnv
  );
  expectValidationError(result, 'slot must be within clinic working hours');
});

test('createEvent accepts a confirmed phone alias fallback outside patient.phoneE164', () => {
  const parseResult = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      slotStart: '2026-03-16T10:00:00+01:00',
      slotEnd: '2026-03-16T10:45:00+01:00',
      timezone: 'Europe/Warsaw',
      patient: {
        fullName: 'Anna Kowalska'
      },
      patientPhoneE164: '+48500111001'
    },
    defaultEnv
  );

  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.patient?.phoneE164, '+48500111001');
});

test('createEvent normalizes a clear raw phone fallback outside patient.phoneE164', () => {
  const parseResult = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      service: { id: 'consultation' },
      slotStart: '2026-03-16T10:00:00+01:00',
      slotEnd: '2026-03-16T10:45:00+01:00',
      timezone: 'Europe/Warsaw',
      patient: {
        fullName: 'Anna Kowalska'
      },
      patientPhoneRaw: '500111001'
    },
    defaultEnv
  );

  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.patient?.phoneE164, '+48500111001');
});

test('createEvent preserves calendar provider failures for reception fallback', () => {
  const parseResult = {
    requestId: 'req_create_event_provider_error',
    toolCallId: 'tool_call_create_event_provider_error',
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation', name: 'Consultation' },
    slotStart: '2026-03-16T10:00:00+01:00',
    slotEnd: '2026-03-16T10:45:00+01:00',
    patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' }
  };
  const availabilityResult = runCodeNode(
    'tool_create-event.json',
    'Slot Available?',
    { 'Parse Request': parseResult },
    [{ error: { message: 'EAUTH: invalid_grant' } }],
    defaultEnv
  );
  assert.equal(availabilityResult.slotAvailable, false);
  assert.equal(availabilityResult.error?.code, 'CALENDAR_PROVIDER_REJECTED');
  assert.match(availabilityResult.error?.details?.[0] || '', /EAUTH/i);

  const formatted = executeCode(getNodeCode(loadWorkflow('tool_create-event.json'), 'Format Conflict'), {
    $json: availabilityResult
  })[0].json;
  const formattedPayload = formatted.results[0].result;
  assert.equal(formatted.results[0].toolCallId, availabilityResult.toolCallId);
  assert.deepEqual(formatted.results[0].message, {
    type: 'request-complete',
    content: formattedPayload.message
  });
  assert.equal(formattedPayload.error.code, 'CALENDAR_PROVIDER_REJECTED');
  assert.match(
    normalizeSearchText(formattedPayload.message),
    /kalendarz wizyt jest tymczasowo niedostepny/i
  );
});

test('createEvent captures caller phone metadata from Vapi tool payloads', () => {
  const parseResult = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      message: {
        type: 'tool-calls',
        customer: {
          number: '+48500111001'
        },
        call: {
          id: 'call_booking_001',
          from: {
            phoneNumber: '+48500111001'
          }
        },
        toolCallList: [
          {
            id: 'tool_call_booking_001',
            name: 'createEvent',
            parameters: {
              service: {
                id: 'consultation'
              },
              slotStart: '2026-03-24T10:00:00+01:00',
              slotEnd: '2026-03-24T10:45:00+01:00',
              timezone: 'Europe/Warsaw',
              patient: {
                fullName: 'Anna Kowalska',
                phoneE164: '+48500111001'
              }
            }
          }
        ]
      }
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);
  assert.deepEqual(parseResult.telephony, {
    callerPhoneE164: '+48500111001',
    callerPhoneRaw: '+48500111001',
    callerPhoneSource: 'customer.number',
    callerMatchesPatientPhone: true
  });
  assert.equal(parseResult.language, 'pl');

  const formatResult = executeCode(getNodeCode(loadWorkflow('tool_create-event.json'), 'Format Success'), {
    $: makeSelector({
      'Slot Available?': parseResult,
      'Create Calendar Event': { id: 'evt_booking_001' }
    }),
    $json: {
      accepted: true,
      recipientClass: 'caller_phone',
      delivery: {
        status: 'simulated',
        provider: 'mock',
        recipientCount: 1,
        providerMessageId: null
      },
      sms: {
        kind: 'booking_confirmation',
        language: 'pl'
      },
      message: 'Potwierdzenie SMS po rezerwacji zostalo przygotowane.'
    }
  })[0].json;
  const bookedResult = formatResult.results?.[0]
    ? (typeof formatResult.results[0].result === 'string'
        ? JSON.parse(formatResult.results[0].result)
        : formatResult.results[0].result)
    : formatResult;
  assert.deepEqual(bookedResult.phoneContext, {
    declaredPhoneE164: '+48500111001',
    callerPhoneE164: '+48500111001',
    callerPhoneSource: 'customer.number',
    callerMatchesDeclaredPhone: true
  });
  assert.deepEqual(bookedResult.bookingConfirmationSms, {
    accepted: true,
    recipientClass: 'caller_phone',
    delivery: {
      status: 'simulated',
      provider: 'mock',
      recipientCount: 1,
      providerMessageId: null
    },
    sms: {
      kind: 'booking_confirmation',
      language: 'pl'
    },
    message: 'Potwierdzenie SMS po rezerwacji zostalo przygotowane.',
    error: null
  });
});

test('createEvent calendar description keeps only receptionist-facing identity fields', () => {
  const params = getNodeParameters('tool_create-event.json', 'Create Calendar Event');
  const description = params.additionalFields?.description || '';

  assert.match(description, /Patient:/);
  assert.match(description, /Callback phone:/);
  assert.match(description, /Caller phone:/);
  assert.match(description, /Source call:/);
  assert.doesNotMatch(description, /Booking SMS target:/);
  assert.doesNotMatch(description, /Phone note:/);
  assert.doesNotMatch(description, /Email:/);
  assert.doesNotMatch(description, /Notes:/);
});

test('createEvent booking SMS uses the live caller number even when the declared phone differs', () => {
  const parseResult = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      message: {
        type: 'tool-calls',
        customer: {
          number: '+48500111001'
        },
        call: {
          id: 'call_booking_sms_001',
          from: {
            phoneNumber: '+48500111001'
          }
        },
        toolCallList: [
          {
            id: 'tool_call_booking_sms_001',
            name: 'createEvent',
            parameters: {
              service: {
                id: 'consultation'
              },
              slotStart: '2026-03-24T10:00:00+01:00',
              slotEnd: '2026-03-24T10:45:00+01:00',
              timezone: 'Europe/Warsaw',
              language: 'en',
              patient: {
                fullName: 'Anna Kowalska',
                phoneE164: '+48500999888'
              }
            }
          }
        ]
      }
    },
    defaultEnv
  );
  const prepared = runCodeNode(
    'tool_create-event.json',
    'Prepare Booking SMS',
    {
      'Slot Available?': parseResult,
      'Create Calendar Event': { id: 'evt_booking_sms_001' }
    },
    [],
    { ...defaultEnv, CLINIC_NAME: 'Demo Dental Clinic' }
  );

  assert.equal(prepared.language, 'en');
  assert.equal(prepared.recipientPhoneE164, '+48500111001');
  assert.equal(prepared.recipientClass, 'caller_phone');
  assert.match(prepared.messageBody, /Ipokrzyku\.pl: Appointment confirmed/i);
  assert.match(prepared.messageBody, /24 March 2026, 10:00/);
  assert.match(prepared.messageBody, /contact reception at \+48530880033/i);

  const dispatched = runCodeNode(
    'tool_create-event.json',
    'Send Booking SMS',
    { 'Prepare Booking SMS': prepared },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_SMS_PROVIDER: 'webhook',
      AI_RECEPTIONIST_SMS_WEBHOOK_URL: 'https://sms-gateway.example.test/send',
      AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN: 'token_123',
      AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS: '9000'
    }
  );

  assert.equal(dispatched.recipientPhoneE164, '+48500111001');
  assert.deepEqual(dispatched.webhookBody?.metadata, {
    requestId: parseResult.requestId,
    calendarEventId: 'evt_booking_sms_001',
    appointmentStart: '2026-03-24T10:00:00+01:00',
    appointmentEnd: '2026-03-24T10:45:00+01:00',
    timezone: 'Europe/Warsaw',
    sourceCallId: 'call_booking_sms_001',
    language: 'en',
    recipientClass: 'caller_phone'
  });
});

test('createEvent booking SMS keeps explicit deferred dispatch available', () => {
  const parseResult = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      message: {
        type: 'tool-calls',
        customer: {
          number: '+48500111001'
        },
        call: {
          id: 'call_booking_sms_deferred_001',
          from: {
            phoneNumber: '+48500111001'
          }
        },
        toolCallList: [
          {
            id: 'tool_call_booking_sms_deferred_001',
            name: 'createEvent',
            parameters: {
              service: {
                id: 'consultation'
              },
              slotStart: '2026-03-24T10:00:00+01:00',
              slotEnd: '2026-03-24T10:45:00+01:00',
              timezone: 'Europe/Warsaw',
              language: 'pl',
              patient: {
                fullName: 'Anna Kowalska',
                phoneE164: '+48500999888'
              }
            }
          }
        ]
      }
    },
    defaultEnv
  );
  const prepared = runCodeNode(
    'tool_create-event.json',
    'Prepare Booking SMS',
    {
      'Slot Available?': parseResult,
      'Create Calendar Event': { id: 'evt_booking_sms_deferred_001' }
    },
    [],
    defaultEnv
  );

  const dispatched = runCodeNode(
    'tool_create-event.json',
    'Send Booking SMS',
    { 'Prepare Booking SMS': prepared },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_BOOKING_SMS_MODE: 'deferred',
      AI_RECEPTIONIST_SMS_PROVIDER: 'webhook',
      AI_RECEPTIONIST_SMS_WEBHOOK_URL: 'https://sms-gateway.example.test/send',
      AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN: 'token_123',
      AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS: '9000'
    }
  );

  assert.equal(dispatched.accepted, true);
  assert.equal(dispatched.recipientClass, 'caller_phone');
  assert.equal(dispatched.delivery?.status, 'queued');
  assert.equal(dispatched.delivery?.provider, 'webhook');
  assert.equal(dispatched.delivery?.recipientCount, 1);
  assert.equal(dispatched.dispatchMode, undefined);
  assert.equal(dispatched.webhookBody, undefined);
  assert.match(dispatched.message || '', /zaplanowane/i);
});

test('createEvent booking SMS falls back to the declared phone when no live caller phone is available', () => {
  const parseResult = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
      service: {
        id: 'consultation'
      },
      slotStart: '2026-03-24T10:00:00+01:00',
      slotEnd: '2026-03-24T10:45:00+01:00',
      timezone: 'Europe/Warsaw',
      language: 'pl',
      patient: {
        fullName: 'Anna Kowalska',
        phoneE164: '+48500999888'
      }
    },
    defaultEnv
  );

  const prepared = runCodeNode(
    'tool_create-event.json',
    'Prepare Booking SMS',
    {
      'Slot Available?': parseResult,
      'Create Calendar Event': { id: 'evt_booking_sms_declared_001' }
    },
    [],
    defaultEnv
  );

  assert.equal(prepared.recipientPhoneE164, '+48500999888');
  assert.equal(prepared.recipientClass, 'declared_phone');

  const dispatched = runCodeNode(
    'tool_create-event.json',
    'Send Booking SMS',
    { 'Prepare Booking SMS': prepared },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_SMS_PROVIDER: 'mock'
    }
  );

  assert.equal(dispatched.accepted, true);
  assert.equal(dispatched.recipientClass, 'declared_phone');
  assert.deepEqual(dispatched.delivery, {
    status: 'simulated',
    provider: 'mock',
    recipientCount: 1,
    providerMessageId: null
  });
  assert.match(dispatched.message || '', /przygotowane/i);
});

test('createReceptionTask rejects unknown taskType', () => {
  const result = runParse(
    'tool_create-reception-task.json',
    'Parse Request',
    {
      taskType: 'whatever_vapi_invents',
      patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' }
    },
    defaultEnv
  );
  expectValidationError(result, 'taskType is invalid');
});

test('createReceptionTask captures caller phone metadata from Vapi tool payloads', () => {
  const parseResult = runParse(
    'tool_create-reception-task.json',
    'Parse Request',
    {
      message: {
        type: 'tool-calls',
        customer: {
          number: '+48500111001'
        },
        call: {
          id: 'call_real_001',
          from: {
            phoneNumber: '+48500111001'
          }
        },
        toolCallList: [
          {
            id: 'tool_call_001',
            name: 'createReceptionTask',
            parameters: {
              taskType: 'existing_patient_booking',
              patient: {
                fullName: 'Anna Kowalska',
                phoneE164: '+48500111001'
              },
              serviceBucket: 'hygiene'
            }
          }
        ]
      }
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.sourceCallId, 'call_real_001');
  assert.deepEqual(parseResult.telephony, {
    callerPhoneE164: '+48500111001',
    callerPhoneRaw: '+48500111001',
    callerPhoneSource: 'customer.number',
    callerMatchesPatientPhone: true
  });

  const built = runCodeNode(
    'tool_create-reception-task.json',
    'Build Task',
    { 'Parse Request': parseResult }
  );
  const builtResult = built.results?.[0]?.result || built;
  assert.equal(builtResult.accepted, true);
  assert.deepEqual(builtResult.task?.phoneContext, {
    declaredPhoneE164: '+48500111001',
    callerPhoneE164: '+48500111001',
    callerPhoneSource: 'customer.number',
    callerMatchesDeclaredPhone: true
  });
});

test('createReceptionTask accepts a confirmed phone alias fallback outside patient.phoneE164', () => {
  const parseResult = runParse(
    'tool_create-reception-task.json',
    'Parse Request',
    {
      taskType: 'existing_patient_booking',
      patient: {
        fullName: 'Anna Kowalska'
      },
      patientPhoneE164: '+48500111001'
    },
    defaultEnv
  );

  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.patient?.phoneE164, '+48500111001');
});

test('createReceptionTask normalizes a clear raw phone fallback outside patient.phoneE164', () => {
  const parseResult = runParse(
    'tool_create-reception-task.json',
    'Parse Request',
    {
      taskType: 'existing_patient_booking',
      patient: {
        fullName: 'Anna Kowalska'
      },
      patientPhoneRaw: '500111001'
    },
    defaultEnv
  );

  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.patient?.phoneE164, '+48500111001');
});

test('Vapi tool sync scripts treat createReceptionTask as a repo-owned tool definition', () => {
  const syncScript = loadText(path.join(rootDir, 'scripts', 'sync-vapi-environment.sh'));
  const updateScript = loadText(path.join(rootDir, 'scripts', 'update-vapi-tool-definition.sh'));
  const createScript = loadText(path.join(rootDir, 'scripts', 'create-vapi-tool.sh'));
  const toolDefinitions = getToolDefinitionMap();
  const createReceptionTask = toolDefinitions.createReceptionTask;
  const lookupPatient = toolDefinitions.lookupPatient;

  assert.match(syncScript, /TOOL_DEFINITION_NAMES=\(/);
  assert.match(syncScript, /createReceptionTask/);
  assert.match(syncScript, /update-vapi-tool-definition\.sh" "\$ENVIRONMENT" "\$\{TOOL_DEFINITION_NAMES\[\$index\]\}"/);
  assert.match(updateScript, /tool-definitions\.v1\.json/);
  assert.match(createScript, /tool-definitions\.v1\.json/);
  assert.match(updateScript, /\.parameters \/\/ \[\]/);
  assert.match(updateScript, /\.variableExtractionPlan \/\/ null/);
  assert.match(createScript, /\.parameters \/\/ \[\]/);
  assert.match(createScript, /\.variableExtractionPlan/);
  assert.equal(createReceptionTask?.schemaPath, 'schemas/createReceptionTask.request.json');
  assert.equal(createReceptionTask?.endpoint, '/webhook/ai-receptionist/create-reception-task');
  assert.equal(createReceptionTask?.messages?.[0]?.content, 'Już zapisuję prośbę dla recepcji.');
  assert.equal(createReceptionTask?.messages?.[0]?.blocking, false);
  assert.equal(createReceptionTask?.messages?.[1]?.content, 'Jeszcze chwila, kończę zapisywać prośbę dla recepcji.');
  assert.equal(createReceptionTask?.messages?.[1]?.timingMilliseconds, 1800);
  assert.equal(createReceptionTask?.parameters?.[0]?.key, 'patientPhoneE164');
  assert.equal(createReceptionTask?.parameters?.[0]?.value, '{{ confirmedPatientPhoneE164 }}');
  assert.equal(lookupPatient?.variableExtractionPlan?.aliases?.[0]?.key, 'confirmedPatientPhoneE164');
  assert.equal(lookupPatient?.variableExtractionPlan?.aliases?.[0]?.value, '{{ $.phone.normalizedE164 }}');
});

test('Vapi tool sync scripts keep searchKnowledgeBase and delayed tool messages repo-owned', () => {
  const syncScript = loadText(path.join(rootDir, 'scripts', 'sync-vapi-environment.sh'));
  const toolDefinitions = getToolDefinitionMap();
  const searchKnowledgeBase = toolDefinitions.searchKnowledgeBase;
  const checkAvailability = toolDefinitions.checkAvailability;
  const createEvent = toolDefinitions.createEvent;

  assert.match(syncScript, /searchKnowledgeBase/);
  assert.match(syncScript, /TOOL_DEFINITION_DELAY_SECONDS/);
  assert.equal(searchKnowledgeBase?.schemaPath, 'schemas/searchKnowledgeBase.request.json');
  assert.equal(searchKnowledgeBase?.endpoint, '/webhook/ai-receptionist/search-knowledge-base');
  assert.equal(searchKnowledgeBase?.messages?.[1]?.type, 'request-response-delayed');
  assert.match(checkAvailability?.description || '', /requestedDate plus searchDays 1 for one specific day/i);
  assert.match(checkAvailability?.description || '', /without requestedDate for the next available dates/i);
  assert.doesNotMatch(checkAvailability?.description || '', /fixed .* business-day horizon/i);
  assert.match(checkAvailability?.description || '', /patient\.isExistingPatient/);
  assert.match(createEvent?.description || '', /confirmed the phone/);
  assert.equal(checkAvailability?.messages?.[1]?.timingMilliseconds, 3000);
  assert.equal(checkAvailability?.messages?.[0]?.content, 'Już sprawdzam dostępne terminy.');
  assert.equal(createEvent?.messages?.[1]?.content, 'Jeszcze moment, finalizuję rezerwację wizyty.');
  assert.equal(createEvent?.messages?.[1]?.timingMilliseconds, 3000);
});

test('Vapi tool sync scripts keep receptionist handoff wait messages repo-owned', () => {
  const toolDefinitions = getToolDefinitionMap();
  const receptionSms = toolDefinitions.sendSmsToReceptionists;

  assert.equal(receptionSms?.messages?.[0]?.content, 'Jeszcze chwila, kończę przekazywanie sprawy.');
  assert.equal(receptionSms?.messages?.[0]?.blocking, false);
  assert.equal(receptionSms?.messages?.[1]?.content, 'Jeszcze moment, dopinam przekazanie sprawy.');
  assert.equal(receptionSms?.messages?.[1]?.timingMilliseconds, 1800);
});

test('sendSmsToReceptionists requires createReceptionTask taskId', () => {
  const result = runParse(
    'tool_send-sms-to-receptionists.json',
    'Parse Request',
    {
      taskType: 'existing_patient_booking',
      patient: { fullName: 'Anna Kowalska', phoneE164: '+48500111001' }
    },
    defaultEnv
  );
  expectValidationError(result, 'taskId is required');
});

test('sendSmsToReceptionists prepares an internal alert body', () => {
  const parseResult = runParse(
    'tool_send-sms-to-receptionists.json',
    'Parse Request',
    {
      taskId: 'task_20260320_001',
      taskType: 'existing_patient_booking',
      patient: { fullName: 'Anna Kowalska', phoneE164: '+48500111001' },
      serviceBucket: 'hygiene',
      preferredCallbackWindow: 'morning',
      telephony: {
        callerPhoneE164: '+48700123000',
        callerPhoneSource: 'customer.number'
      }
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);

  const prepared = runCodeNode(
    'tool_send-sms-to-receptionists.json',
    'Prepare SMS',
    { 'Parse Request': parseResult },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS: '+48793385531'
    }
  );

  assert.equal(prepared.kind, 'reception_follow_up');
  assert.match(prepared.messageBody, /Task ID: task_20260320_001/);
  assert.match(prepared.messageBody, /Preferowany kontakt: rano/);
  assert.match(prepared.messageBody, /Usluga: hygiene/);
  assert.match(prepared.messageBody, /deklarowany \+48500111001/);
  assert.match(prepared.messageBody, /numer dzwoniacego \+48700123000/);
  assert.match(prepared.messageBody, /rozne - zweryfikowac, ktory numer wykorzystac/);
  assert.doesNotMatch(prepared.messageBody, /Summary:/);
  assert.doesNotMatch(prepared.messageBody, /Notatki:/);
  assert.deepEqual(prepared.phoneContext, {
    declaredPhoneE164: '+48500111001',
    callerPhoneE164: '+48700123000',
    callerPhoneSource: 'customer.number',
    callerMatchesDeclaredPhone: false
  });
});

test('sendSmsToPatient requires explicit SMS consent', () => {
  const result = runParse(
    'tool_send-sms-to-patient.json',
    'Parse Request',
    {
      calendarEventId: 'evt_001',
      consentConfirmed: false,
      patient: { phoneE164: '+48500100200' },
      appointment: {
        start: '2026-03-20T10:30:00+01:00',
        timezone: 'Europe/Warsaw',
        service: { id: 'consultation', name: 'Konsultacja' }
      }
    },
    defaultEnv
  );
  expectValidationError(result, 'consentConfirmed must be true');
});

test('sendSmsToPatient prepares an English booking confirmation SMS', () => {
  const parseResult = runParse(
    'tool_send-sms-to-patient.json',
    'Parse Request',
    {
      calendarEventId: 'evt_001',
      consentConfirmed: true,
      language: 'en',
      patient: { phoneE164: '+48500100200' },
      appointment: {
        start: '2026-03-20T10:30:00+01:00',
        timezone: 'Europe/Warsaw',
        service: { id: 'consultation', name: 'Consultation' }
      }
    },
    { ...defaultEnv, CLINIC_NAME: 'Demo Dental Clinic' }
  );
  assert.equal(parseResult.ok, true);

  const prepared = runCodeNode(
    'tool_send-sms-to-patient.json',
    'Prepare SMS',
    { 'Parse Request': parseResult },
    [],
    { ...defaultEnv, CLINIC_NAME: 'Demo Dental Clinic' }
  );

  assert.equal(prepared.kind, 'booking_confirmation');
  assert.equal(prepared.recipientPhoneE164, '+48500100200');
  assert.equal(prepared.recipientClass, 'declared_phone');
  assert.deepEqual(prepared.recipients, ['+48500100200']);
  assert.match(prepared.messageBody, /Ipokrzyku\.pl: Appointment confirmed/i);
  assert.match(prepared.messageBody, /20 March 2026, 10:30/);
  assert.match(prepared.messageBody, /contact reception at \+48530880033/i);
});

test('sendSmsToPatient prepares the branded Polish booking confirmation SMS with the full date', () => {
  const parseResult = runParse(
    'tool_send-sms-to-patient.json',
    'Parse Request',
    {
      calendarEventId: 'evt_002',
      consentConfirmed: true,
      language: 'pl',
      patient: { phoneE164: '+48500100200' },
      appointment: {
        start: '2026-03-25T17:00:00+01:00',
        timezone: 'Europe/Warsaw',
        service: { id: 'implant_consultation', name: 'Konsultacja implantologiczna' }
      }
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);

  const prepared = runCodeNode(
    'tool_send-sms-to-patient.json',
    'Prepare SMS',
    { 'Parse Request': parseResult }
  );

  assert.equal(
    prepared.messageBody,
    'Ipokrzyku.pl: Potwierdzenie wizyty. środa, 25 marca 2026, 17:00. W razie zmian prosimy o kontakt z recepcją pod numerem +48530880033.'
  );
});

test('sendSmsToPatient captures caller phone metadata and carries it into webhook dispatch', () => {
  const parseResult = runParse(
    'tool_send-sms-to-patient.json',
    'Parse Request',
    {
      message: {
        type: 'tool-calls',
        customer: {
          number: '+48500111001'
        },
        call: {
          id: 'call_sms_001',
          from: {
            phoneNumber: '+48500111001'
          }
        },
        toolCallList: [
          {
            id: 'tool_call_sms_001',
            name: 'sendSmsToPatient',
            parameters: {
              calendarEventId: 'evt_001',
              consentConfirmed: true,
              language: 'pl',
              patient: {
                phoneE164: '+48500999888'
              },
              appointment: {
                start: '2026-03-20T10:30:00+01:00',
                timezone: 'Europe/Warsaw',
                service: {
                  id: 'consultation',
                  name: 'Konsultacja'
                }
              }
            }
          }
        ]
      }
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.sourceCallId, 'call_sms_001');
  assert.deepEqual(parseResult.telephony, {
    callerPhoneE164: '+48500111001',
    callerPhoneRaw: '+48500111001',
    callerPhoneSource: 'customer.number',
    callerMatchesPatientPhone: false
  });

  const prepared = runCodeNode(
    'tool_send-sms-to-patient.json',
    'Prepare SMS',
    { 'Parse Request': parseResult },
    [],
    defaultEnv
  );
  assert.equal(prepared.recipientClass, 'caller_phone');
  assert.equal(prepared.recipientPhoneE164, '+48500111001');
  assert.deepEqual(prepared.recipients, ['+48500111001']);

  const dispatch = runCodeNode(
    'tool_send-sms-to-patient.json',
    'Send SMS',
    { 'Prepare SMS': prepared },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_SMS_PROVIDER: 'webhook',
      AI_RECEPTIONIST_SMS_WEBHOOK_URL: 'https://sms-gateway.example.test/send',
      AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN: 'token_123',
      AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS: '9000'
    }
  );

  assert.equal(dispatch.baseResult?.recipientClass, 'caller_phone');
  assert.deepEqual(dispatch.webhookBody?.metadata, {
    requestId: parseResult.requestId,
    calendarEventId: 'evt_001',
    appointmentStart: '2026-03-20T10:30:00+01:00',
    appointmentEnd: null,
    timezone: 'Europe/Warsaw',
    sourceCallId: 'call_sms_001',
    language: 'pl',
    recipientClass: 'caller_phone'
  });

  const formatted = executeCode(getNodeCode(loadWorkflow('tool_send-sms-to-patient.json'), 'Format Success'), {
    $json: {
      toolCallId: 'tool_call_sms_001',
      requestId: 'req_sms_001',
      recipientClass: 'caller_phone',
      delivery: {
        status: 'queued',
        provider: 'webhook',
        recipientCount: 1,
        providerMessageId: 'msg_001'
      },
      sms: {
        kind: 'booking_confirmation',
        language: 'pl'
      },
      message: 'Potwierdzenie SMS dla pacjenta zostalo przekazane do wysylki.'
    }
  })[0].json;
  const formattedResult = formatted.results?.[0]?.result || formatted;
  assert.equal(formattedResult.recipientClass, 'caller_phone');
});

test('sendSmsToReceptionists twilio mode requires an explicit sender number', () => {
  const parseResult = runParse(
    'tool_send-sms-to-receptionists.json',
    'Parse Request',
    {
      taskId: 'task_20260320_001',
      taskType: 'existing_patient_booking',
      patient: { fullName: 'Anna Kowalska', phoneE164: '+48500111001' }
    },
    defaultEnv
  );
  assert.equal(parseResult.ok, true);

  const prepared = runCodeNode(
    'tool_send-sms-to-receptionists.json',
    'Prepare SMS',
    { 'Parse Request': parseResult },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS: '+48793385531'
    }
  );

  const result = runCodeNode(
    'tool_send-sms-to-receptionists.json',
    'Send SMS',
    { 'Prepare SMS': prepared },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_SMS_PROVIDER: 'twilio',
      AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS: '+48793385531'
    }
  );

  assert.equal(result.accepted, false);
  assert.equal(result.error?.code, 'SMS_PROVIDER_NOT_CONFIGURED');
  assert.equal(result.delivery?.provider, 'twilio');
  assert.match(result.error?.details?.[0] || '', /TWILIO_PHONE_NUMBER/);
});

test('sendSmsToPatient twilio mode creates a dispatch item when configured', () => {
  const parseResult = runParse(
    'tool_send-sms-to-patient.json',
    'Parse Request',
    {
      calendarEventId: 'evt_001',
      consentConfirmed: true,
      language: 'en',
      patient: { fullName: 'Jane Example', phoneE164: '+48500100200' },
      appointment: {
        start: '2026-03-20T10:30:00+01:00',
        timezone: 'Europe/Warsaw',
        service: { id: 'consultation', name: 'Consultation' }
      }
    },
    { ...defaultEnv, CLINIC_NAME: 'Demo Dental Clinic' }
  );
  assert.equal(parseResult.ok, true);

  const prepared = runCodeNode(
    'tool_send-sms-to-patient.json',
    'Prepare SMS',
    { 'Parse Request': parseResult },
    [],
    { ...defaultEnv, CLINIC_NAME: 'Demo Dental Clinic' }
  );

  const result = runCodeNode(
    'tool_send-sms-to-patient.json',
    'Send SMS',
    { 'Prepare SMS': prepared },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC_test_account',
      TWILIO_AUTH_TOKEN: 'test_token',
      TWILIO_PHONE_NUMBER: '+18207774711'
    }
  );

  assert.equal(result.dispatchMode, 'twilio');
  assert.equal(result.fromNumber, '+18207774711');
  assert.equal(result.recipient, '+48500100200');
  assert.match(result.authHeader, /^Basic /);
});

test('sendSmsToPatient finalizes Twilio HTTP responses', () => {
  const parseResult = runParse(
    'tool_send-sms-to-patient.json',
    'Parse Request',
    {
      calendarEventId: 'evt_001',
      consentConfirmed: true,
      language: 'en',
      patient: { fullName: 'Jane Example', phoneE164: '+48500100200' },
      appointment: {
        start: '2026-03-20T10:30:00+01:00',
        timezone: 'Europe/Warsaw',
        service: { id: 'consultation', name: 'Consultation' }
      }
    },
    { ...defaultEnv, CLINIC_NAME: 'Demo Dental Clinic' }
  );
  const prepared = runCodeNode(
    'tool_send-sms-to-patient.json',
    'Prepare SMS',
    { 'Parse Request': parseResult },
    [],
    { ...defaultEnv, CLINIC_NAME: 'Demo Dental Clinic' }
  );
  const dispatchItems = runCodeNodeItems(
    'tool_send-sms-to-patient.json',
    'Send SMS',
    { 'Prepare SMS': prepared },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC_test_account',
      TWILIO_AUTH_TOKEN: 'test_token',
      TWILIO_PHONE_NUMBER: '+18207774711'
    }
  );

  const result = runCodeNode(
    'tool_send-sms-to-patient.json',
    'Finalize Twilio Response',
    { 'Send SMS': dispatchItems },
    [{ statusCode: 201, body: { sid: 'SM123', status: 'queued' } }]
  );

  assert.equal(result.accepted, true);
  assert.equal(result.delivery?.provider, 'twilio');
  assert.equal(result.delivery?.status, 'queued');
  assert.equal(result.delivery?.providerMessageId, 'SM123');
});

test('sendSmsToReceptionists finalizes multiple Twilio HTTP responses', () => {
  const parseResult = runParse(
    'tool_send-sms-to-receptionists.json',
    'Parse Request',
    {
      taskId: 'task_20260320_001',
      taskType: 'existing_patient_booking',
      patient: { fullName: 'Anna Kowalska', phoneE164: '+48500111001' }
    },
    defaultEnv
  );
  const prepared = runCodeNode(
    'tool_send-sms-to-receptionists.json',
    'Prepare SMS',
    { 'Parse Request': parseResult },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS: '+48793385531,+48793385532'
    }
  );
  const dispatchItems = runCodeNodeItems(
    'tool_send-sms-to-receptionists.json',
    'Send SMS',
    { 'Prepare SMS': prepared },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_SMS_PROVIDER: 'twilio',
      AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS: '+48793385531,+48793385532',
      TWILIO_ACCOUNT_SID: 'AC_test_account',
      TWILIO_AUTH_TOKEN: 'test_token',
      TWILIO_PHONE_NUMBER: '+18207774711'
    }
  );

  const result = runCodeNode(
    'tool_send-sms-to-receptionists.json',
    'Finalize Twilio Response',
    { 'Send SMS': dispatchItems },
    [
      { statusCode: 201, body: { sid: 'SM111', status: 'queued' } },
      { statusCode: 201, body: { sid: 'SM222', status: 'sent' } }
    ]
  );

  assert.equal(result.accepted, true);
  assert.equal(result.delivery?.provider, 'twilio');
  assert.equal(result.delivery?.status, 'sent');
  assert.equal(result.delivery?.recipientCount, 2);
  assert.equal(result.delivery?.providerMessageId, 'SM111,SM222');
});

test('sendSmsToPatient finalizes webhook HTTP responses', () => {
  const parseResult = runParse(
    'tool_send-sms-to-patient.json',
    'Parse Request',
    {
      calendarEventId: 'evt_001',
      consentConfirmed: true,
      language: 'pl',
      patient: { fullName: 'Jan Example', phoneE164: '+48500100200' },
      appointment: {
        start: '2026-03-20T10:30:00+01:00',
        timezone: 'Europe/Warsaw',
        service: { id: 'consultation', name: 'Konsultacja' }
      }
    },
    defaultEnv
  );
  const prepared = runCodeNode(
    'tool_send-sms-to-patient.json',
    'Prepare SMS',
    { 'Parse Request': parseResult },
    [],
    defaultEnv
  );
  const dispatchItems = runCodeNodeItems(
    'tool_send-sms-to-patient.json',
    'Send SMS',
    { 'Prepare SMS': prepared },
    [],
    {
      ...defaultEnv,
      AI_RECEPTIONIST_SMS_PROVIDER: 'webhook',
      AI_RECEPTIONIST_SMS_WEBHOOK_URL: 'https://sms-gateway.example.test/send',
      AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN: 'token_123',
      AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS: '9000'
    }
  );

  const result = runCodeNode(
    'tool_send-sms-to-patient.json',
    'Finalize Webhook Response',
    { 'Send SMS': dispatchItems },
    [{ statusCode: 202, body: { status: 'accepted', messageId: 'msg_test_001' } }]
  );

  assert.equal(result.accepted, true);
  assert.equal(result.delivery?.provider, 'webhook');
  assert.equal(result.delivery?.status, 'queued');
  assert.equal(result.delivery?.providerMessageId, 'msg_test_001');
});

test('SMS workflows use HTTP Request nodes instead of in-code fetch', () => {
  const workflowFiles = [
    'tool_send-sms-to-patient.json',
    'tool_send-sms-to-receptionists.json'
  ];

  for (const workflowFilename of workflowFiles) {
    const workflow = loadWorkflow(workflowFilename);
    assert.equal(getNode(workflow, 'Dispatch Twilio SMS').type, 'n8n-nodes-base.httpRequest');
    assert.equal(getNode(workflow, 'Dispatch Webhook SMS').type, 'n8n-nodes-base.httpRequest');
    assert.equal(getNode(workflow, 'Immediate Result?').type, 'n8n-nodes-base.if');
    assert.equal(getNode(workflow, 'Finalize Twilio Response').type, 'n8n-nodes-base.code');
    assert.equal(getNode(workflow, 'Finalize Webhook Response').type, 'n8n-nodes-base.code');
    assert.doesNotMatch(
      loadText(path.join(workflowsDir, workflowFilename)),
      /fetch\s*\(/,
      `${workflowFilename} should not call fetch inside Code nodes`
    );
  }
});

test('searchKnowledgeBase returns English answers for English queries', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'What is the difference between veneers and bonding?',
      language: 'en',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /veneers|bonding/i);
  assert.equal(searchResult.message, 'I found an answer in the local knowledge base.');
});

test('searchKnowledgeBase returns supported fixed pricing answers', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Ile kosztuje higienizacja?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /450/);
  assert.match(searchResult.answer, /Higienizacja kosztuje/i);
});

test('searchKnowledgeBase matches generic All on four offer questions', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Czy wykonujecie All on four?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /All on four/i);
  assert.match(searchResult.answer, /bezzebiu|bezzebie/i);
});

test('searchKnowledgeBase matches teeth-in-one-day marketing questions with extra context', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Co oznacza haslo zeby w jeden dzien? Na czym polega leczenie w jeden dzien w klinice?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /All on four|implant/i);
  assert.match(searchResult.answer, /bezzebiu|mostu|implantach/i);
});

test('searchKnowledgeBase matches long veneers-versus-bonding questions with durability context', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Czym różnią się licówki od bondingu? Różnice, zastosowanie, trwałość.',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.equal(searchResult.matches[0].id, 'kb_veneers_vs_bonding');
  assert.match(searchResult.answer, /Licowki|Bonding/i);
  assert.match(searchResult.answer, /trwaly|przebarwienia|kompozyt/i);
});

test('searchKnowledgeBase matches standalone bonding overview questions', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Na czym polega bonding zebow?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.equal(searchResult.matches[0].id, 'kb_bonding_overview');
  assert.match(searchResult.answer, /Bonding|kompozyt/i);
  assert.match(searchResult.answer, /W klinice|estetyczna odbudowa|estetyke usmiechu/i);
  assert.match(searchResult.answer, /licowki|trwal/i);
});

test('searchKnowledgeBase matches the assistant paraphrase for veneers versus bonding', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'różnica między licówkami a bondingiem',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.equal(searchResult.matches[0].id, 'kb_veneers_vs_bonding');
  assert.match(searchResult.answer, /Licowki|Bonding/i);
});

test('searchKnowledgeBase matches the staging veneers-versus-bonding phrasing with scope extras', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Czym różnią się licówki od bondingu? Różnice, zakres, trwałość, cena ogólnie.',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.equal(searchResult.matches[0].id, 'kb_veneers_vs_bonding');
});

test('searchKnowledgeBase matches the runtime veneers-versus-bonding query with extra pricing qualifiers', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Czym różnią się licówki od bondingu? Różnice, trwałość, zakres zabiegu, cena orientacyjna jeśli dostępna.',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.equal(searchResult.matches[0].id, 'kb_veneers_vs_bonding');
});

test('searchKnowledgeBase matches direct veneers availability questions', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Czy można zrobić licówki?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.equal(searchResult.matches[0].id, 'kb_prosthetics_overview');
  assert.match(searchResult.answer, /licowki|Protetyka/i);
});

test('searchKnowledgeBase matches the live-call veneers offer phrasing', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Czy w klinice można wykonać licówki? Oferta licówek.',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.equal(searchResult.matches[0].id, 'kb_prosthetics_overview');
  assert.match(searchResult.answer, /licowki|Protetyka/i);
});

test('searchKnowledgeBase matches the long natural-language live query about zeby w jeden dzien', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'widziałam, że macie taką reklamę "zęby w jeden dzień" i chciałam zapytać, jak to wygląda, bo aż ciężko uwierzyć, że tak robicie zęby w jeden dzień?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /All on four|pelnego luku/i);
  assert.match(searchResult.answer, /tymczasowe uzupelnienie|jednej wizyty/i);
});

test('searchKnowledgeBase returns All on four qualification guidance for patients with their own teeth', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Czy all on 4 mozna zrobic, jesli mam swoje zeby?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /usunac/i);
  assert.match(searchResult.answer, /pojedyncze implanty/i);
});

test('searchKnowledgeBase keeps branded All on four pricing queries retrievable', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Ile kosztuje All on four? Cena All on four w klinice ipokrzyku.pl.',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /28 000/);
  assert.match(searchResult.answer, /18 000/);
  assert.match(searchResult.answer, /indywidualnie/i);
});

test('searchKnowledgeBase maps the marketing phrase implanty w jeden dzien to All on four guidance', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Co oznacza haslo implanty w jeden dzien? Czy to chodzi o All on four?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /All on four/i);
  assert.match(searchResult.answer, /czterech strategicznie rozmieszczonych implantach/i);
});

test('searchKnowledgeBase returns starting-price guidance for root canal treatment', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Ile kosztuje leczenie kanalowe?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /1000/);
  assert.match(searchResult.answer, /liczba kanalow|kanalow/i);
  assert.match(searchResult.answer, /powtorne leczenie|wiecej/i);
});

test('searchKnowledgeBase returns other-specialist handoff guidance', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Czy moge umowic sie do innego specjalisty?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /tylko pierwsze wizyty/i);
  assert.match(searchResult.answer, /recepcji/i);
});

test('searchKnowledgeBase returns the clinic address for location questions', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Jaki jest adres kliniki ipokrzyku.pl w Krakowie? Gdzie znajduje sie klinika?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, true);
  assert.match(searchResult.answer, /Josepha Conrada 37/i);
  assert.match(searchResult.answer, /31-357 Krakow/i);
});

test('searchKnowledgeBase refuses partial-overlap medical questions', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Czy bonding boli?',
      language: 'pl',
      limit: 1
    },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const searchResult = executeCode(getNodeCode(workflow, 'Search KB'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(searchResult.found, false);
  assert.equal(searchResult.answer, null);
});

test('lookupPatient returns only the phone confirmation payload', () => {
  const workflow = loadWorkflow('tool_lookup-patient.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: { phoneRaw: '500111001' },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const lookupResult = executeCode(getNodeCode(workflow, 'Build Phone Result'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.deepEqual(
    Object.keys(lookupResult).sort(),
    ['language', 'message', 'phone', 'ready', 'requestId', 'toolCallId']
  );
});

test('lookupPatient returns a speech-safe phone readback helper', () => {
  const workflow = loadWorkflow('tool_lookup-patient.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: { fullName: 'Test Pacjent', phoneRaw: '702003006' },
    $env: defaultEnv
  })[0].json;

  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.phone?.normalizedE164, '+48702003006');
  assert.equal(/\d/.test(parseResult.phone?.spoken || ''), false);
  assert.equal(/\d/.test(parseResult.phone?.readbackPrompt || ''), false);
  assert.equal(parseResult.phone?.spoken, 'siedem zero dwa, zero zero trzy, zero zero sześć');
  assert.equal(
    parseResult.phone?.readbackPrompt,
    'Dziękuję. Powtarzam numer: siedem zero dwa, zero zero trzy, zero zero sześć. Czy wszystko się zgadza?'
  );
  assert.equal(containsPolishDiacritics(parseResult.phone?.readbackPrompt || ''), true);

  const lookupResult = executeCode(getNodeCode(workflow, 'Build Phone Result'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.equal(lookupResult.ready, true);
  assert.equal(lookupResult.phone?.normalizedE164, '+48702003006');
  assert.match(
    normalizeSearchText(lookupResult.phone?.readbackPrompt || ''),
    /powtarzam numer: siedem zero dwa, zero zero trzy, zero zero szesc/i
  );
});

test('lookupPatient rejects malformed 10-digit local phone captures', () => {
  const workflow = loadWorkflow('tool_lookup-patient.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: { phoneRaw: '7933885531' },
    $env: defaultEnv
  })[0].json;

  assert.equal(parseResult.ok, false);
  assert.equal(parseResult.phone?.normalizedE164, null);
  assert.ok(parseResult.validationErrors.includes('phone number could not be normalized'));
});

test('lookupPatient normalizes fully spoken Polish digit words', () => {
  const workflow = loadWorkflow('tool_lookup-patient.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      phoneRaw: 'siedem zero dwa zero zero trzy zero zero sześć',
      language: 'pl'
    },
    $env: defaultEnv
  })[0].json;

  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.phone?.normalizedE164, '+48702003006');
  assert.equal(parseResult.phone?.spoken, 'siedem zero dwa, zero zero trzy, zero zero sześć');
  assert.equal(
    parseResult.phone?.readbackPrompt,
    'Dziękuję. Powtarzam numer: siedem zero dwa, zero zero trzy, zero zero sześć. Czy wszystko się zgadza?'
  );
});

test('lookupPatient formats exact speech-safe completion and retry messages for Vapi', () => {
  const workflow = loadWorkflow('tool_lookup-patient.json');
  const okParseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      message: {
        toolCallList: [
          {
            id: 'tool_call_lookup_ok',
            parameters: {
              phoneRaw: '702003006'
            }
          }
        ]
      }
    },
    $env: defaultEnv
  })[0].json;
  const okLookupResult = executeCode(getNodeCode(workflow, 'Build Phone Result'), {
    $: makeSelector({ 'Parse Request': okParseResult })
  })[0].json;
  const okFormatted = executeCode(getNodeCode(workflow, 'Format Ready'), {
    $json: okLookupResult
  })[0].json;
  const okPayload = okFormatted.results[0].result;

  assert.equal(okFormatted.results[0].toolCallId, okLookupResult.toolCallId);
  assert.equal(typeof okFormatted.results[0].result, 'object');
  assert.equal(okFormatted.results[0].message, undefined);
  assert.equal(okPayload.message, okLookupResult.message);
  assert.equal(/\d/.test(okPayload.message || ''), false);
  assert.equal(containsPolishDiacritics(okPayload.message || ''), true);

  const failedParseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      message: {
        toolCallList: [
          {
            id: 'tool_call_lookup_failed',
            parameters: {
              phoneRaw: '7933885531'
            }
          }
        ]
      }
    },
    $env: defaultEnv
  })[0].json;
  const failedFormatted = executeCode(getNodeCode(workflow, 'Format Validation Error'), {
    $json: failedParseResult
  })[0].json;
  const failedPayload = failedFormatted.results[0].result;

  assert.equal(failedFormatted.results[0].toolCallId, failedParseResult.toolCallId);
  assert.equal(failedFormatted.results[0].message, undefined);
  assert.equal(failedPayload.error.code, 'VALIDATION_ERROR');
  assert.equal(/\d/.test(failedPayload.message || ''), false);
  assert.match(
    normalizeSearchText(failedPayload.message || ''),
    /prosze podac go jeszcze raz, cyfra po cyfrze/i
  );
});

test('createEvent formats a speech-safe tool-complete confirmation for Vapi', () => {
  const formatted = executeCode(getNodeCode(loadWorkflow('tool_create-event.json'), 'Format Success'), {
    $: makeSelector({
      'Slot Available?': {
        requestId: 'req_create_event_voice_message',
        toolCallId: 'tool_call_create_event_voice_message',
        calendarId: 'primary',
        timezone: 'Europe/Warsaw',
        language: 'pl',
        service: {
          id: 'consultation',
          name: 'Konsultacja'
        },
        slotStart: '2026-03-16T09:00:00+01:00',
        slotEnd: '2026-03-16T09:45:00+01:00',
        patient: {
          fullName: 'Jan Testowy',
          phoneE164: '+48500100200'
        },
        telephony: {
          callerPhoneE164: '+48500100200',
          callerMatchesPatientPhone: true,
          callerPhoneSource: 'call.customer.number'
        }
      },
      'Create Calendar Event': {
        id: 'calendar_sample_001'
      }
    }),
    $json: {
      accepted: true,
      recipientClass: 'caller',
      delivery: {
        status: 'sent',
        provider: 'mock',
        recipientCount: 1,
        providerMessageId: 'mock_001'
      },
      sms: null,
      message: 'Booking confirmation SMS sent.'
    }
  })[0].json;
  const formattedPayload = formatted.results[0].result;

  assert.equal(formatted.results[0].toolCallId, 'tool_call_create_event_voice_message');
  assert.equal(typeof formatted.results[0].result, 'object');
  assert.deepEqual(formatted.results[0].message, {
    type: 'request-complete',
    content: formattedPayload.message
  });
  assert.equal(/\d/.test(formattedPayload.message || ''), false);
  assert.equal(containsPolishDiacritics(formattedPayload.message || ''), true);
  assert.match(
    normalizeSearchText(formattedPayload.message || ''),
    /wizyta zostala potwierdzona/i
  );
});

test('call-ended router rejects unauthorized requests when webhook secret is configured', () => {
  const result = runParse(
    'webhook_vapi-call-ended-router.json',
    'Parse Event',
    {
      type: 'call.ended',
      call: { id: 'call_auth_test' },
      headers: {}
    },
    { ...defaultEnv, AI_RECEPTIONIST_WEBHOOK_SECRET: 'topsecret' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthorized');
});

test('call-ended router surfaces scorecard-backed autoevaluation hints on valid ended calls', () => {
  const parseResult = runParse(
    'webhook_vapi-call-ended-router.json',
    'Parse Event',
    {
      type: 'call.ended',
      call: {
        id: 'call_obs_test',
        assistantId: 'assistant_test',
        startedAt: '2026-03-22T00:00:00Z',
        endedAt: '2026-03-22T00:02:00Z'
      },
      artifact: {
        structuredOutputs: {
          'dff8d16d-1f39-4d46-9f3d-370c8ecaeb40': {
            name: 'Dental Call Intake',
            result: {
              callOutcome: 'appointment_booked',
              successfulForAssistantScope: true,
              language: 'pl',
              caseCategory: 'new_patient_first_visit',
              serviceBucket: 'consultation',
              booking: {
                bookingCreated: true,
                serviceId: 'consultation'
              },
              timing: {
                selectedSlotStart: '2026-03-24T09:00:00+01:00'
              }
            }
          },
          'qa-phone': {
            name: 'QA: Phone Readback Wrong',
            result: true
          },
          'qa-detail': {
            name: 'QA: Unnecessary Detail Request',
            result: true
          }
        },
        scorecards: {
          sc1: {
            name: 'Core Call Quality',
            score: 62,
            scoreNormalized: 62
          }
        }
      }
    },
    defaultEnv
  );

  assert.equal(parseResult.ok, true);
  assert.equal(parseResult.route, 'booked');
  assert.equal(parseResult.requiresReview, true);
  assert.equal(parseResult.reviewSeverity, 'high');
  assert.ok(parseResult.reviewReasons.includes('phone_readback_wrong'));
  assert.ok(parseResult.reviewReasons.includes('unnecessary_detail_request'));
  assert.ok(parseResult.reviewReasons.includes('Core Call Quality_critical'));

  const workflow = loadWorkflow('webhook_vapi-call-ended-router.json');
  const formatted = executeCode(getNodeCode(workflow, 'Format Booked'), {
    $json: parseResult
  })[0].json;

  assert.equal(formatted.autoevaluation.requiresReview, true);
  assert.equal(formatted.autoevaluation.reviewSeverity, 'high');
  assert.equal(formatted.autoevaluation.scorecards[0].nameCanonical, 'Core Call Quality');
  assert.equal(formatted.autoevaluation.qaSignals.phoneNumberRepeatedIncorrectly, true);
  assert.equal(formatted.autoevaluation.qaSignals.unnecessaryHealthDetailRequest, true);
});

test('tool webhooks map validation and auth failures to HTTP status codes', () => {
  assert.equal(
    getResponseCodeOption('tool_check-availability.json', 'Respond Error'),
    "={{ $json.results ? 200 : ($json.error?.code === 'UNAUTHORIZED' ? 401 : 400) }}"
  );
  assert.equal(
    getResponseCodeOption('tool_create-event.json', 'Respond Validation Error'),
    "={{ $json.results ? 200 : ($json.error?.code === 'UNAUTHORIZED' ? 401 : 400) }}"
  );
  assert.equal(
    getResponseCodeOption('tool_create-reception-task.json', 'Respond Error'),
    "={{ $json.error?.code === 'UNAUTHORIZED' ? 401 : 400 }}"
  );
  assert.equal(
    getResponseCodeOption('tool_lookup-patient.json', 'Respond Error'),
    "={{ $json.results ? 200 : ($json.error?.code === 'UNAUTHORIZED' ? 401 : 400) }}"
  );
  assert.equal(
    getResponseCodeOption('tool_search-knowledge-base.json', 'Respond Error'),
    "={{ $json.error?.code === 'UNAUTHORIZED' ? 401 : 400 }}"
  );
  assert.equal(
    getResponseCodeOption('tool_send-sms-to-receptionists.json', 'Respond Validation Error'),
    "={{ $json.error?.code === 'UNAUTHORIZED' ? 401 : 400 }}"
  );
  assert.equal(
    getResponseCodeOption('tool_send-sms-to-patient.json', 'Respond Validation Error'),
    "={{ $json.error?.code === 'UNAUTHORIZED' ? 401 : 400 }}"
  );
});

test('createEvent maps slot conflicts to HTTP 409', () => {
  assert.equal(getResponseCodeOption('tool_create-event.json', 'Respond Conflict'), "={{ $json.results ? 200 : 409 }}");
});

test('SMS provider failures map to 5xx status codes', () => {
  assert.equal(
    getResponseCodeOption('tool_send-sms-to-receptionists.json', 'Respond Provider Error'),
    "={{ ['SMS_PROVIDER_NOT_CONFIGURED', 'SMS_RECIPIENTS_NOT_CONFIGURED'].includes($json.error?.code) ? 503 : 502 }}"
  );
  assert.equal(
    getResponseCodeOption('tool_send-sms-to-patient.json', 'Respond Provider Error'),
    502
  );
});

test('call-ended router maps invalid events to HTTP 400 and unauthorized calls to 401', () => {
  assert.equal(
    getResponseCodeOption('webhook_vapi-call-ended-router.json', 'Respond Invalid'),
    "={{ $json.reason === 'unauthorized' ? 401 : 400 }}"
  );
});

test('assistant config makes silence handling explicit and repo-owned', () => {
  const config = loadAssistantConfig();
  assert.equal(config.assistant?.silenceTimeoutSeconds, 60);
  assert.deepEqual(config.assistant?.hooks, []);
  assert.equal(config.assistant?.server?.timeoutSeconds, 20);
});

test('assistant spoken voice strings keep spoken pe-el branding without the dotted domain', () => {
  const config = loadAssistantConfig();
  const systemPrompts = (config.assistant?.model?.messages || [])
    .filter((message) => message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n');

  assert.equal(typeof config.assistant?.firstMessage, 'string');
  assert.equal(typeof config.assistant?.voicemailMessage, 'string');
  assert.match(config.assistant.firstMessage, /centrum stomatologii Ipokrzyku pe el/i);
  assert.match(config.assistant.voicemailMessage, /centrum stomatologii Ipokrzyku pe el/i);
  assert.doesNotMatch(config.assistant.firstMessage, /Ipokrzyku\.pl/);
  assert.doesNotMatch(config.assistant.voicemailMessage, /Ipokrzyku\.pl/);
  assert.doesNotMatch(config.assistant.firstMessage, /Ipokrzyku pl/i);
  assert.doesNotMatch(config.assistant.voicemailMessage, /Ipokrzyku pl/i);
  assert.match(systemPrompts, /centrum stomatologii Ipokrzyku pe el/i);
  assert.match(systemPrompts, /nie "Ipokrzyku\.pl"/i);
});

assistantInvariantTest('assistant system message bundle locks spoken brand, exact tool replay, and vocative guardrails', () => {
  const config = loadAssistantConfig();
  const normalizedSystemMessages = normalizeSearchText(
    (config.assistant?.model?.messages || [])
      .filter((message) => message.role === 'system' && typeof message.content === 'string')
      .map((message) => message.content)
      .join('\n')
  );

  assert.match(normalizedSystemMessages, /ipokrzyku pe el/i);
  assert.match(normalizedSystemMessages, /mow "ipokrzyku pe el", nie "ipokrzyku\.pl", "pl" ani "i pokrzyku"/i);
  assert.match(normalizedSystemMessages, /result\.message albo request-complete/i);
  assert.match(
    normalizedSystemMessages,
    /(wypowiedz dokladnie to pole i niczego nie dopisuj|wypowiedz je doslownie)/i
  );
  assert.match(
    normalizedSystemMessages,
    /(unikaj "panie\?" albo "pani\?".*preferuj "pana\/pani"|unikaj "panie\?" albo "pani\?".*pytaj z "pan\/pani"|unikaj "panie\?" albo "pani\?".*nie pytaj neutralnie.*"pana\/pani pierwsza wizyta".*"panu\/pani pasuje termin")/i
  );
});

test('assistant prompt keeps phone-collection logic as plain text without unresolved liquid control flow', () => {
  const config = loadAssistantConfig();
  const systemPrompts = (config.assistant?.model?.messages || [])
    .filter((message) => message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n');
  const normalizedPrompt = normalizeSearchText(systemPrompts);

  assert.equal(/\{%/.test(systemPrompts), false);
  assert.match(systemPrompts, /customer\.number=\{\{\s*customer\.number\s*\}\}/);
  assert.match(normalizedPrompt, /jawnie widzisz konkretny numer dzwoniacego w formacie E\.164/i);
  assert.match(normalizedPrompt, /odczytaj biezacy numer polaczenia w formie glosowej/i);
  assert.match(normalizedPrompt, /czy mam uzyc go jako numeru kontaktowego/i);
  assert.match(normalizedPrompt, /nie pros wtedy o podanie numeru od nowa/i);
  assert.match(normalizedPrompt, /Popros po prostu o numer telefonu/i);
  assert.match(
    normalizedPrompt,
    /po numerze powtorz go i pytaj tylko: "Czy wszystko sie zgadza\?" \/? "Is that correct\?"/i
  );
  assert.match(normalizedPrompt, /przy samych danych najpierw potwierdz numer.*"W czym moge pomoc\?"/i);
  assert.doesNotMatch(normalizedPrompt, /nie czytaj go na glos/i);
});

assistantInvariantTest('assistant prompt keeps the urgent first-available override explicit', () => {
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt());

  assert.match(
    normalizedPrompt,
    /nie pytaj najpierw, czy to pierwsza wizyta/i
  );
  assert.match(
    normalizedPrompt,
    /checkAvailability z service\.id urgent_consultation, timePreference first_available i timezone Europe\/Warsaw/i
  );
  assert.doesNotMatch(normalizedPrompt, /searchDays 5/i);
  assert.match(
    normalizedPrompt,
    /nie zadawaj dodatkowych pytan o objawy przed .* narzedzia/i
  );
  assert.match(
    normalizedPrompt,
    /createEvent, dopoki pacjent nie wybierze jednego terminu/i
  );
});

assistantInvariantTest('assistant prompt keeps implant consultation lookup explicit after booking intent', () => {
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt());

  assert.match(
    normalizedPrompt,
    /po pytaniu o implanty albo All on four, jesli rozmowca .*chce konsultacje implantologiczna i termin/i
  );
  assert.match(
    normalizedPrompt,
    /uzyj implant_consultation/i
  );
  assert.match(
    normalizedPrompt,
    /nie blokuj tego pytaniem o pierwsza wizyte/i
  );
});

assistantInvariantTest('assistant prompt keeps the latency-first first-visit default explicit', () => {
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt());

  assert.match(
    normalizedPrompt,
    /domyslna sciezka to consultation/i
  );
  assert.match(
    normalizedPrompt,
    /przy samej pierwszej wizycie nie pytaj o rodzaj problemu/i
  );
});

assistantInvariantTest('assistant prompt keeps the first-visit pricing formula explicit but scoped to the final summary', () => {
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt());

  assert.match(
    normalizedPrompt,
    /koszt pierwszej wizyty wynosi dwiescie zlotych/i
  );
  assert.match(
    normalizedPrompt,
    /zdjecie tomograficzne jest w cenie konsultacji na poczet leczenia w klinice/i
  );
  assert.match(
    normalizedPrompt,
    /jesli pacjent chce zabrac zdjecie ze soba, dodatkowy koszt wynosi dwiescie zlotych/i
  );
  assert.match(
    normalizedPrompt,
    /po potwierdzeniu numeru/i
  );
  assert.match(
    normalizedPrompt,
    /powiedz dokladnie|nie parafrazuj/i
  );
  assert.match(
    normalizedPrompt,
    /nie dodawaj tego przy pierwszej ofercie terminu|nie mow tego przy pierwszej ofercie/i
  );
});

assistantInvariantTest('assistant prompt keeps post-booking close and reception SMS follow-up explicit', () => {
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt());

  assert.match(
    normalizedPrompt,
    /po sukcesie createEvent powiedz dokladnie gotowe message z narzedzia/i
  );
  assert.match(
    normalizedPrompt,
    /po sukcesie createReceptionTask, jesli dostepne jest sendSmsToReceptionists, wywo[lł]aj je od razu z taskId/i
  );
  assert.match(
    normalizedPrompt,
    /slot\.start i slot\.end wybranego slotu/i
  );
  assert.match(
    normalizedPrompt,
    /dokladnie gotowe message z narzedzia/i
  );
});

assistantInvariantTest('assistant prompt keeps gender recognition but forbids repetitive prosze pana pani phrasing', () => {
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt());

  assert.match(
    normalizedPrompt,
    /(dopasuj gramatyke do rozmowcy|dopasuj gramatyke i uzywaj|po ujawnieniu formy uzywaj odpowiedniej formy|po ujawnieniu formy uzywaj form "pan\/pani"|po ujawnieniu formy uzywaj "pan\/pani")/i
  );
  assert.match(
    normalizedPrompt,
    /(nie zostawaj dalej przy samej formie neutralnej|po wiarygodnym ujawnieniu formy wracaj do odpowiedniej formy "pan\/pani"|uzywaj odpowiedniej formy "pan\/pani" nie samej neutralnej|nie pytan bezosobowych|nie bezosobowo)/i
  );
  assert.match(
    normalizedPrompt,
    /czy to bedzie pana\/pani pierwsza wizyta/i
  );
  assert.match(
    normalizedPrompt,
    /po slowie "chcialbym\/chcialbym" nastepne pytanie musi zawierac meska forme "pan\/pana\/panu"/i
  );
  assert.match(
    normalizedPrompt,
    /po slowie "chcialabym\/chcialabym" nastepne pytanie musi zawierac zenska forme "pani\/pania"/i
  );
  assert.match(
    normalizedPrompt,
    /neutralne wersje typu "czy to bedzie pierwsza wizyta\?" albo "na jaki dzien pasuje termin\?" sa wtedy bledem/i
  );
  assert.match(
    normalizedPrompt,
    /(unikaj "panie\?" albo "pani\?"|nigdy "panie\?" czy "pani\?")/i
  );
  assert.match(
    normalizedPrompt,
    /nie zaczynaj( kazdej wypowiedzi)? od "prosze pana\/pani"/i
  );
  assert.match(
    normalizedPrompt,
    /nie wracaj do przeciwnej formy/i
  );
});

assistantInvariantTest('assistant prompt forbids small talk and keeps the brief-answer handoff explicit', () => {
  const config = loadAssistantConfig();
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt(config));
  const normalizedSystemMessages = normalizeSearchText(
    (config.assistant?.model?.messages || [])
      .filter((message) => message.role === 'system' && typeof message.content === 'string')
      .map((message) => message.content)
      .join('\n')
  );

  assert.match(
    normalizedPrompt,
    /nie uzywaj small talku/i
  );
  assert.match(
    normalizedPrompt,
    /nie nazywaj kliniki salonem/i
  );
  assert.match(
    normalizedPrompt,
    /takie terminy sprawdza recepcja.*przejdz do brakujacej danej albo do createReceptionTask/i
  );
  assert.match(
    normalizedSystemMessages,
    /((jesli rozmowca zadaje krotkie pytanie operacyjne przed handoffem|na krotkie pytanie operacyjne przed handoffem) odpowiedz jednym zdaniem i od razu przejdz do brakujacej danej|na krotkie pytanie przed handoffem odpowiedz jednym zdaniem i przejdz do brakujacej danej)/i
  );
});

assistantInvariantTest('assistant prompt keeps speech-safe wording and calendar-failure handoff explicit', () => {
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt());

  assert.match(
    normalizedPrompt,
    /w tekscie do odczytu na glos nie zostawiaj cyfr 0-9/i
  );
  assert.match(
    normalizedPrompt,
    /slot\.spokenLabel albo slot\.spokenTime/i
  );
  assert.match(
    normalizedPrompt,
    /slot\.label.*bez cyfr/i
  );
  assert.match(
    normalizedPrompt,
    /pytanie o inny dzien odswiez checkAvailability/i
  );
  assert.match(
    normalizedPrompt,
    /nie wywoluj `?lookupPatient`? tylko po to, zeby przeczytac jasny numer/i
  );
  assert.match(
    normalizedPrompt,
    /(jesli|gdy) wynik narzedzia (zawiera|ma) gotowe pole message, nastepna wypowiedz do pacjenta ma byc dokladnie tym polem/i
  );
  assert.match(
    normalizedPrompt,
    /patientPhoneRaw albo patient\.phoneRaw/i
  );
  assert.match(
    normalizedPrompt,
    /checkAvailability zwrocilo available false z error\.code CALENDAR_PROVIDER_REJECTED/i
  );
});

assistantInvariantTest('assistant prompt keeps explicit day-plus-daypart lookups bounded', () => {
  const config = loadAssistantConfig();
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt(config));
  const normalizedSystemMessages = normalizeSearchText(
    (config.assistant?.model?.messages || [])
      .filter((message) => message.role === 'system' && typeof message.content === 'string')
      .map((message) => message.content)
      .join('\n')
  );

  assert.match(
    normalizedPrompt,
    /konkretny dzien albo data razem z pora dnia -> requestedDate na ten dzien, odpowiedni timePreference i searchDays 1/i
  );
  assert.match(
    normalizedPrompt,
    /po pytaniu o pierwsza wizyte rozmowca poda konkretny dzien albo date razem z pora dnia.*uzyj checkAvailability z requestedDate na ten dzien/i
  );
  assert.match(
    normalizedSystemMessages,
    /(jesli rozmowca poda konkretny dzien albo date razem z pora dnia|gdy rozmowca poda konkretny dzien albo date z pora dnia|gdy rozmowca poda konkretny dzien lub date z pora dnia), checkAvailability (musi zachowac|zachowuje) requestedDate i searchDays 1/i
  );
});

assistantInvariantTest('assistant prompt keeps the booking-to-kb pivot and one-question fallback explicit', () => {
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt());

  assert.match(
    normalizedPrompt,
    /takze po uslyszeniu terminow, nie jest jeszcze prosba o rezerwacje/i
  );
  assert.match(
    normalizedPrompt,
    /nie zbieraj w tej samej turze danych do callbacku/i
  );
  assert.match(
    normalizedPrompt,
    /zapytaj najwyzej, czy przekazac sprawe do recepcji/i
  );
});

assistantInvariantTest('assistant prompt bundle keeps anti-fragment speech rules explicit', () => {
  const config = loadAssistantConfig();
  const normalizedPrompt = normalizeSearchText(
    (config.assistant?.model?.messages || [])
      .filter((message) => message.role === 'system' && typeof message.content === 'string')
      .map((message) => message.content)
      .join('\n')
  );

  assert.match(
    normalizedPrompt,
    /slot\.spokenLabel albo slot\.spokenTime|slot\.spokenLabel, slot\.spokenTime albo slot\.spokenDate/i
  );
  assert.match(
    normalizedPrompt,
    /urwanego startu typu "Wtorek, sroda" albo "Siedem"/i
  );
  assert.match(
    normalizedPrompt,
    /(Jesli rozmowca poprawia wybor w tej samej wypowiedzi, wypowiedz tylko finalna wersje|Przy poprawce w tej samej wypowiedzi mow tylko finalna wersje|Przy poprawce mow tylko finalna wersje)/i
  );
  assert.match(
    normalizedPrompt,
    /(?:lookupPatient uzyj tylko(?: wtedy)?, gdy numer|nie wywoluj `?lookupPatient`? tylko po to, zeby przeczytac jasny numer\. uzyj go tylko przy numerze) (?:jest )?(?:niejasny, fragmentaryczny albo nadal wymaga technicznej normalizacji po doprecyzowaniu|niepelnym, sprzecznym albo wymagajacym naprawy po doprecyzowaniu|niepelny, sprzeczny albo wymagajacym naprawy po doprecyzowaniu|niepelny, sprzeczny albo nadal wymaga normalizacji po doprecyzowaniu)/i
  );
  assert.match(
    normalizedPrompt,
    /rozmowca poda imie, nazwisko i numer.*bez prosby o numer drugi raz/i
  );
  assert.match(
    normalizedPrompt,
    /potwierdzony numer telefonu pozostaje aktywnym numerem kontaktowym/i
  );
  assert.match(
    normalizedPrompt,
    /nie pytaj ponownie, czy nadal jest aktualny/i
  );
  assert.match(
    normalizedPrompt,
    /w nowej rezerwacji albo zanim intencja bedzie pelna, po numerze powtorz go i pytaj tylko/i
  );
  assert.match(
    normalizedPrompt,
    /nie odpowiadaj( samym)? "Dziekuje\. W czym moge pomoc\?"/i
  );
  assert.match(
    normalizedPrompt,
    /przy pelnych danych od razu wywolaj createReceptionTask/i
  );
  assert.doesNotMatch(
    normalizedPrompt,
    /jesli numer jest jasny, potwierdz go krotko i przekaz dalej jako patient\.phoneRaw albo patientPhoneRaw/i
  );
});

test('assistant renderer excludes the direct patient SMS tool from production bindings', () => {
  const rendered = renderAssistantConfig('production', {
    PRODUCTION_N8N_PUBLIC_BASE_URL: 'https://prod.example.test',
    PRODUCTION_AI_RECEPTIONIST_WEBHOOK_SECRET: 'prod-secret'
  });
  const receptionSmsBinding = rendered.toolBindings.find(
    (binding) => binding.name === 'sendSmsToReceptionists'
  );

  assert.deepEqual(
    rendered.toolBindings.map((binding) => binding.name),
    [
      'lookupPatient',
      'checkAvailability',
      'searchKnowledgeBase',
      'createEvent',
      'createReceptionTask',
      'sendSmsToReceptionists'
    ]
  );
  assert.equal(rendered.assistant?.model?.toolIds?.length, 6);
  assert.ok(receptionSmsBinding?.serverUrl?.includes('/send-sms-to-receptionists?secret='));
  assert.equal(rendered.toolBindings.some((binding) => binding.name === 'sendSmsToPatient'), false);
});

test('assistant renderer excludes the direct patient SMS tool from staging bindings', () => {
  const rendered = renderAssistantConfig('staging', {
    STAGING_N8N_PUBLIC_BASE_URL: 'https://staging.example.test',
    STAGING_AI_RECEPTIONIST_WEBHOOK_SECRET: 'stage-secret'
  });
  const receptionSmsBinding = rendered.toolBindings.find(
    (binding) => binding.name === 'sendSmsToReceptionists'
  );

  assert.deepEqual(
    rendered.toolBindings.map((binding) => binding.name),
    [
      'lookupPatient',
      'checkAvailability',
      'searchKnowledgeBase',
      'createEvent',
      'createReceptionTask',
      'sendSmsToReceptionists'
    ]
  );
  assert.equal(rendered.assistant?.model?.toolIds?.length, 6);
  assert.ok(receptionSmsBinding?.serverUrl?.includes('/send-sms-to-receptionists?secret='));
  assert.equal(rendered.toolBindings.some((binding) => binding.name === 'sendSmsToPatient'), false);
});

test('assistant renderer keeps staging on explicit Vapi smart endpointing with conservative thresholds', () => {
  const shared = loadAssistantConfig();
  const rendered = renderAssistantConfig('staging', {
    STAGING_N8N_PUBLIC_BASE_URL: 'https://staging.example.test',
    STAGING_AI_RECEPTIONIST_WEBHOOK_SECRET: 'stage-secret'
  });

  assert.equal(shared.assistant?.name, 'Ola');
  assert.equal(shared.assistant?.transcriber?.provider, '11labs');
  assert.equal(shared.assistant?.transcriber?.model, 'scribe_v2');
  assert.equal(rendered.assistant?.name, 'Ola [staging]');
  assert.equal(rendered.assistant?.transcriber?.provider, '11labs');
  assert.equal(rendered.assistant?.transcriber?.model, 'scribe_v2');
  assert.equal(rendered.assistant?.transcriber?.language, 'pl');
  assert.equal(shared.assistant?.voice?.chunkPlan?.minCharacters, 48);
  assert.equal(shared.assistant?.startSpeakingPlan?.waitSeconds, 0.35);
  assert.equal(shared.assistant?.startSpeakingPlan?.smartEndpointingPlan, undefined);
  assert.equal(rendered.assistant?.voice?.chunkPlan?.minCharacters, 32);
  assert.equal(rendered.assistant?.startSpeakingPlan?.waitSeconds, 0.35);
  assert.equal(rendered.assistant?.startSpeakingPlan?.smartEndpointingPlan?.provider, 'vapi');
  assert.equal(rendered.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onPunctuationSeconds, 0.35);
  assert.equal(rendered.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onNoPunctuationSeconds, 1.8);
  assert.equal(rendered.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onNumberSeconds, 0.9);
  assert.equal(rendered.assistant?.silenceTimeoutSeconds, 60);
  assert.deepEqual(rendered.assistant?.hooks, []);
});

test('assistant renderer keeps production on explicit Vapi smart endpointing with matched thresholds', () => {
  const shared = loadAssistantConfig();
  const rendered = renderAssistantConfig('production', {
    PRODUCTION_N8N_PUBLIC_BASE_URL: 'https://production.example.test',
    PRODUCTION_AI_RECEPTIONIST_WEBHOOK_SECRET: 'prod-secret'
  });

  assert.equal(shared.assistant?.name, 'Ola');
  assert.equal(shared.assistant?.transcriber?.provider, '11labs');
  assert.equal(shared.assistant?.transcriber?.model, 'scribe_v2');
  assert.equal(rendered.assistant?.name, 'Ola');
  assert.equal(rendered.assistant?.transcriber?.provider, '11labs');
  assert.equal(rendered.assistant?.transcriber?.model, 'scribe_v2');
  assert.equal(rendered.assistant?.transcriber?.language, 'pl');
  assert.equal(rendered.assistant?.voice?.chunkPlan?.minCharacters, 32);
  assert.equal(rendered.assistant?.startSpeakingPlan?.waitSeconds, 0.35);
  assert.equal(rendered.assistant?.startSpeakingPlan?.smartEndpointingPlan?.provider, 'vapi');
  assert.equal(rendered.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onPunctuationSeconds, 0.35);
  assert.equal(rendered.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onNoPunctuationSeconds, 1.8);
  assert.equal(rendered.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onNumberSeconds, 0.9);
});

assistantInvariantTest('assistant model payload stays within the latency baseline and tool waits remain non-blocking', () => {
  const baseline = loadModelPayloadBaseline();
  const assistantConfig = loadAssistantConfig();
  const systemMessages = (assistantConfig.assistant?.model?.messages || [])
    .filter((message) => message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content);
  const systemPrompt = systemMessages[0] || '';
  const totalSystemMessageChars = systemMessages.reduce((sum, content) => sum + content.length, 0);
  const toolDefinitions = loadToolDefinitions();
  const currentToolStats = getToolDescriptionStats(toolDefinitions);
  const maxGrowthFactor = Number(baseline.maxGrowthFactor || 1.1);
  const allowedPromptLength = Math.ceil(baseline.systemPromptChars * maxGrowthFactor);
  const allowedTotalSystemMessageChars = Math.ceil(
    Number((baseline.totalSystemMessageChars ?? baseline.systemPromptChars) || 0) * maxGrowthFactor
  );
  const allowedToolDescriptionTotal = Math.ceil(baseline.toolDescriptionTotalChars * maxGrowthFactor);

  assert.ok(
    systemPrompt.length <= allowedPromptLength,
    `system prompt grew to ${systemPrompt.length} chars, limit is ${allowedPromptLength}`
  );
  assert.ok(
    totalSystemMessageChars <= allowedTotalSystemMessageChars,
    `total system messages grew to ${totalSystemMessageChars} chars, limit is ${allowedTotalSystemMessageChars}`
  );
  assert.ok(
    currentToolStats.total <= allowedToolDescriptionTotal,
    `tool descriptions grew to ${currentToolStats.total} chars, limit is ${allowedToolDescriptionTotal}`
  );

  for (const [toolName, baselineChars] of Object.entries(baseline.toolDescriptionChars || {})) {
    const currentChars = currentToolStats.perTool[toolName];
    const allowedChars = Math.ceil(baselineChars * maxGrowthFactor);
    assert.equal(typeof currentChars, 'number', `missing tool description for ${toolName}`);
    assert.ok(
      currentChars <= allowedChars,
      `${toolName} description grew to ${currentChars} chars, limit is ${allowedChars}`
    );
  }

  for (const [toolName, definition] of Object.entries(getToolDefinitionMap(toolDefinitions))) {
    for (const message of Array.isArray(definition?.messages) ? definition.messages : []) {
      if (message?.type === 'request-start') {
        assert.equal(
          message.blocking,
          false,
          `${toolName} request-start message must stay non-blocking`
        );
      }
    }
  }
});

assistantInvariantTest('assistant SMS scenarios resolve required tool bindings against staging and production environments', () => {
  const stagingEnabledBindings = getEnabledToolBindings(loadEnvironmentBindings('staging'));
  const productionEnabledBindings = getEnabledToolBindings(loadEnvironmentBindings('production'));
  const patientSmsScenario = loadStagingScenario('booking-confirmation-sms.v1.json');
  const receptionSmsScenario = loadStagingScenario('reschedule-handoff-internal-sms-alert.v1.json');
  const existingPatientBookingScenario = loadStagingScenario('existing-patient-booking-handoff-internal-sms-alert.v1.json');

  assert.deepEqual(
    getMissingRequiredToolBindings(patientSmsScenario, stagingEnabledBindings),
    []
  );
  assert.deepEqual(
    getMissingRequiredToolBindings(receptionSmsScenario, stagingEnabledBindings),
    []
  );
  assert.deepEqual(
    getMissingRequiredToolBindings(existingPatientBookingScenario, stagingEnabledBindings),
    []
  );
  assert.deepEqual(
    getMissingRequiredToolBindings(patientSmsScenario, productionEnabledBindings),
    []
  );
  assert.deepEqual(
    getMissingRequiredToolBindings(receptionSmsScenario, productionEnabledBindings),
    []
  );
  assert.deepEqual(
    getMissingRequiredToolBindings(existingPatientBookingScenario, productionEnabledBindings),
    []
  );
});

assistantInvariantTest('specialist handoff scenario routes other specialists into general follow-up without scheduling', () => {
  const scenario = loadStagingScenario('other-specialist-first-visit-handoff.v1.json');

  assert.deepEqual(getScenarioCriterion(scenario, 'reception-task-created').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'createReceptionTask',
    path: 'accepted',
    equals: true
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'general-follow-up-task-type-used').rule, {
    type: 'tool_arg_equals',
    tool_name: 'createReceptionTask',
    path: 'taskType',
    equals: 'general_follow_up'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'reception-task-omits-summary').rule, {
    type: 'tool_arg_missing',
    tool_name: 'createReceptionTask',
    path: 'summary'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'reception-task-omits-notes').rule, {
    type: 'tool_arg_missing',
    tool_name: 'createReceptionTask',
    path: 'notes'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-availability-check').rule, {
    type: 'tool_not_called',
    tool_name: 'checkAvailability'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-booking-created').rule, {
    type: 'tool_not_called',
    tool_name: 'createEvent'
  });
});

assistantInvariantTest('existing-patient booking handoff scenario routes directly to reception with internal SMS and no scheduling', () => {
  const scenario = loadStagingScenario('existing-patient-booking-handoff-internal-sms-alert.v1.json');

  assert.deepEqual(getScenarioCriterion(scenario, 'existing-patient-booking-task-type-used').rule, {
    type: 'tool_arg_equals',
    tool_name: 'createReceptionTask',
    path: 'taskType',
    equals: 'existing_patient_booking'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'reception-task-omits-summary').rule, {
    type: 'tool_arg_missing',
    tool_name: 'createReceptionTask',
    path: 'summary'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'reception-task-omits-notes').rule, {
    type: 'tool_arg_missing',
    tool_name: 'createReceptionTask',
    path: 'notes'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'internal-sms-workflow-accepted').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'sendSmsToReceptionists',
    path: 'accepted',
    equals: true
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'internal-sms-reuses-task-id').rule, {
    type: 'tool_arg_matches_tool_result_path',
    tool_name: 'sendSmsToReceptionists',
    path: 'taskId',
    source_tool_name: 'createReceptionTask',
    source_path: 'taskId'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-availability-check').rule, {
    type: 'tool_not_called',
    tool_name: 'checkAvailability'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-booking-created').rule, {
    type: 'tool_not_called',
    tool_name: 'createEvent'
  });
});

assistantInvariantTest('first-visit date-evening scenario keeps requestedDate bounded after the first-visit gate', () => {
  const scenario = loadStagingScenario('first-visit-date-evening-keeps-requested-date.v1.json');

  assert.deepEqual(getScenarioCriterion(scenario, 'turn-two-checks-availability').rule, {
    type: 'turn_tool_called',
    turn: 2,
    tool_name: 'checkAvailability'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'turn-two-targets-the-explicit-date').rule, {
    type: 'turn_tool_arg_equals',
    turn: 2,
    tool_name: 'checkAvailability',
    path: 'requestedDate',
    equals: '2027-04-09'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'turn-two-keeps-evening-preference').rule, {
    type: 'turn_tool_arg_equals',
    turn: 2,
    tool_name: 'checkAvailability',
    path: 'timePreference',
    equals: 'evening'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'turn-two-bounds-search-days-to-one').rule, {
    type: 'turn_tool_arg_equals',
    turn: 2,
    tool_name: 'checkAvailability',
    path: 'searchDays',
    equals: 1
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'turn-two-avoids-small-talk-and-salon-wording').rule, {
    type: 'turn_assistant_text_not_contains_any',
    turn: 2,
    contains_none: ['czesc', 'jak sie masz', 'salon']
  });
});

assistantInvariantTest('existing-patient doctor-question scenario answers briefly before handoff and still avoids scheduling', () => {
  const scenario = loadStagingScenario('existing-patient-doctor-question-brief-answer.v1.json');

  assert.deepEqual(getScenarioCriterion(scenario, 'turn-one-does-not-handoff-without-identity').rule, {
    type: 'turn_tool_not_called',
    turn: 1,
    tool_name: 'createReceptionTask'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'turn-one-gives-a-brief-operational-answer').rule, {
    type: 'turn_assistant_text_contains_all',
    turn: 1,
    contains_all: [
      'sprawdza recepcja',
      'termin'
    ]
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'turn-two-creates-reception-task').rule, {
    type: 'turn_tool_called',
    turn: 2,
    tool_name: 'createReceptionTask'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'existing-patient-booking-task-type-used').rule, {
    type: 'tool_arg_equals',
    tool_name: 'createReceptionTask',
    path: 'taskType',
    equals: 'existing_patient_booking'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-availability-check').rule, {
    type: 'tool_not_called',
    tool_name: 'checkAvailability'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-booking-created').rule, {
    type: 'tool_not_called',
    tool_name: 'createEvent'
  });
});

assistantInvariantTest('one-day implant marketing scenario stays in the knowledge-base branch', () => {
  const scenario = loadStagingScenario('zeby-w-jeden-dzien-kb-question.v1.json');

  assert.deepEqual(getScenarioCriterion(scenario, 'kb-tool-called').rule, {
    type: 'turn_tool_called',
    turn: 1,
    tool_name: 'searchKnowledgeBase'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'kb-answer-found').rule, {
    type: 'turn_tool_result_path_equals',
    turn: 1,
    tool_name: 'searchKnowledgeBase',
    path: 'found',
    equals: true
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-availability-check').rule, {
    type: 'tool_not_called',
    tool_name: 'checkAvailability'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-booking-created').rule, {
    type: 'tool_not_called',
    tool_name: 'createEvent'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-reception-task-created').rule, {
    type: 'tool_not_called',
    tool_name: 'createReceptionTask'
  });
});

assistantInvariantTest('post-handoff meta-question scenario forbids a second reception task', () => {
  const scenario = loadStagingScenario('existing-patient-post-handoff-meta-question.v1.json');

  assert.deepEqual(getScenarioCriterion(scenario, 'reception-task-created-on-first-turn').rule, {
    type: 'turn_tool_called',
    turn: 1,
    tool_name: 'createReceptionTask'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'reception-task-omits-summary').rule, {
    type: 'tool_arg_missing',
    tool_name: 'createReceptionTask',
    path: 'summary'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'reception-task-omits-notes').rule, {
    type: 'tool_arg_missing',
    tool_name: 'createReceptionTask',
    path: 'notes'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-second-reception-task-on-meta-question').rule, {
    type: 'turn_tool_not_called',
    turn: 2,
    tool_name: 'createReceptionTask'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-second-internal-sms-on-meta-question').rule, {
    type: 'turn_tool_not_called',
    turn: 2,
    tool_name: 'sendSmsToReceptionists'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-availability-check').rule, {
    type: 'tool_not_called',
    tool_name: 'checkAvailability'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-booking-created').rule, {
    type: 'tool_not_called',
    tool_name: 'createEvent'
  });
});

assistantInvariantTest('after-hours first-visit scenario keeps evening preference and speech-safe output', () => {
  const scenario = loadStagingScenario('after-hours-first-visit-availability.v1.json');

  assert.deepEqual(getScenarioCriterion(scenario, 'after-hours-availability-lookup-used').rule, {
    type: 'turn_tool_called',
    turn: 1,
    tool_name: 'checkAvailability'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'after-hours-lookup-uses-evening-window').rule, {
    type: 'turn_tool_arg_equals',
    turn: 1,
    tool_name: 'checkAvailability',
    path: 'timePreference',
    equals: 'evening'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'after-hours-answer-stays-speech-safe').rule, {
    type: 'turn_assistant_text_not_contains_any',
    turn: 1,
    contains_none: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-booking-created').rule, {
    type: 'tool_not_called',
    tool_name: 'createEvent'
  });
});

assistantInvariantTest('booking without an exposed caller number asks for the spoken phone number', () => {
  const scenario = loadStagingScenario('booking-without-exposed-caller-number-captures-phone.v1.json');

  assert.deepEqual(getScenarioCriterion(scenario, 'asks-for-phone-number-after-name-only').rule, {
    type: 'turn_assistant_text_contains_any',
    turn: 4,
    contains_any: [
      'prosze podac numer telefonu',
      'podanie numeru telefonu',
      'prosze o podanie numeru telefonu',
      'prosze o numer telefonu',
      'numeru telefonu do kontaktu',
      'prosze o podanie numeru telefonu do kontaktu',
      'poprosze o numer telefonu',
      'prosze jeszcze o numer telefonu kontaktowego',
      'poprosze jeszcze numer telefonu do kontaktu',
      'poprosze jeszcze o numer telefonu do potwierdzenia rezerwacji',
      'numer telefonu do kontaktu',
      'numer telefonu kontaktowego',
      'numer telefonu do kontakt',
      'numer telefonu do potwierdzenia wizyty',
      'numer telefonu do potwierdzenia rezerwacji',
      'jaki numer telefonu',
      'numer telefonu do rezerwacji'
    ]
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'does-not-assume-current-call-number').rule, {
    type: 'turn_assistant_text_not_contains_any',
    turn: 4,
    contains_none: [
      'numer, z ktorego jest to polaczenie',
      'numer, z ktorego teraz jest wykonywane polaczenie',
      'numer z ktorego jest to polaczenie',
      'numer z ktorego teraz jest wykonywane polaczenie'
    ]
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-booking-before-phone-capture').rule, {
    type: 'turn_tool_not_called',
    turn: 4,
    tool_name: 'createEvent'
  });
});

assistantInvariantTest('revealed masculine-form scenario requires respectful pan wording after the cue', () => {
  const scenario = loadStagingScenario('revealed-masculine-form-uses-pan.v1.json');
  const criterion = getScenarioCriterion(scenario, 'turn-one-uses-masculine-respectful-form');

  assert.equal(scenario.turns[0].user.toLowerCase().includes('chcialbym'), true);
  assert.deepEqual(criterion.rule.contains_any, [
    'na jaki dzien i o jakiej porze najbardziej panu pasuje termin',
    'na jaki dzien i mniej wiecej na ktora godzine chcialby sie pan umowic',
    'na jaki dzien i o jakiej porze chcialby sie pan umowic',
    'czy to bedzie pana pierwsza wizyta',
    'czy byl juz pan u nas',
    'czy byl pan juz u nas'
  ]);
});

assistantInvariantTest('assistant prompt keeps exposed caller-number confirmation explicit', () => {
  const normalizedPrompt = normalizeSearchText(getAssistantSystemPrompt());
  const systemMessages = (loadAssistantConfig().assistant?.model?.messages || [])
    .filter((message) => message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n');

  assert.match(
    normalizedPrompt,
    /odczytaj biezacy numer polaczenia w formie glosowej/i
  );
  assert.match(
    normalizedPrompt,
    /czy mam uzyc go jako numeru kontaktowego/i
  );
  assert.match(
    normalizedPrompt,
    /nie pros wtedy o podanie numeru od nowa/i
  );
  assert.match(
    normalizedPrompt,
    /nie zastepuj tego pytania samym "Czy wszystko sie zgadza\?"/i
  );
  assert.match(systemMessages, /customer\.number=\{\{\s*customer\.number\s*\}\}/);
});

assistantInvariantTest('rendered staging and production assistant configs preserve the caller-number runtime hint', () => {
  for (const [environment, envOverrides] of [
    [
      'staging',
      {
        STAGING_N8N_PUBLIC_BASE_URL: 'https://staging.example.test',
        STAGING_AI_RECEPTIONIST_WEBHOOK_SECRET: 'staging-secret'
      }
    ],
    [
      'production',
      {
        PRODUCTION_N8N_PUBLIC_BASE_URL: 'https://production.example.test',
        PRODUCTION_AI_RECEPTIONIST_WEBHOOK_SECRET: 'prod-secret'
      }
    ]
  ]) {
    const rendered = renderAssistantConfig(environment, envOverrides);
    const renderedMessages = (rendered.assistant?.model?.messages || [])
      .filter((message) => message.role === 'system' && typeof message.content === 'string')
      .map((message) => message.content)
      .join('\n');

    assert.match(
      renderedMessages,
      /customer\.number=\{\{\s*customer\.number\s*\}\}/,
      `${environment} rendered config is missing the caller-number runtime hint`
    );
  }
});

assistantInvariantTest('bonding overview staging scenario stays in the knowledge-base branch', () => {
  const scenario = loadStagingScenario('bonding-overview-kb-question.v1.json');

  assert.deepEqual(getScenarioCriterion(scenario, 'kb-tool-called').rule, {
    type: 'turn_tool_called',
    turn: 1,
    tool_name: 'searchKnowledgeBase'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'kb-found-supported-answer').rule, {
    type: 'turn_tool_result_path_equals',
    turn: 1,
    tool_name: 'searchKnowledgeBase',
    path: 'found',
    equals: true
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'assistant-answer-mentioned-bonding').rule, {
    type: 'turn_assistant_text_contains_all',
    turn: 1,
    contains_all: ['bonding', 'w klinice']
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-availability-check').rule, {
    type: 'tool_not_called',
    tool_name: 'checkAvailability'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-booking-write').rule, {
    type: 'tool_not_called',
    tool_name: 'createEvent'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-reception-task-write').rule, {
    type: 'tool_not_called',
    tool_name: 'createReceptionTask'
  });
});

assistantInvariantTest('staging chat runner resolves scenario template fallbacks and explicit overrides', () => {
  const template = {
    turns: [
      { user: '{{STAGING_SMS_TEST_PATIENT_IDENTITY_UTTERANCE|fallback utterance}}' }
    ]
  };

  const defaultResolved = resolveScenarioTemplates(template, {});
  assert.equal(defaultResolved.turns[0].user, 'fallback utterance');

  const overrideResolved = resolveScenarioTemplates(template, {
    STAGING_SMS_TEST_PATIENT_IDENTITY_UTTERANCE: 'override utterance'
  });
  assert.equal(overrideResolved.turns[0].user, 'override utterance');

  assert.throws(
    () => resolveScenarioTemplates({ turns: [{ user: '{{MISSING_REQUIRED_TEMPLATE}}' }] }, {}),
    /Missing required scenario template variable: MISSING_REQUIRED_TEMPLATE/
  );
});

assistantInvariantTest('assistant SMS staging scenarios require end-to-end workflow result checks', () => {
  const patientSmsScenario = loadStagingScenario('booking-confirmation-sms.v1.json');
  const receptionSmsScenario = loadStagingScenario('reschedule-handoff-internal-sms-alert.v1.json');
  const existingPatientBookingScenario = loadStagingScenario('existing-patient-booking-handoff-internal-sms-alert.v1.json');
  const implantBookingScenario = loadStagingScenario('all-on-four-inquiry-to-booking.v1.json');

  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'slot-offer-uses-spoken-text').rule, {
    type: 'turn_assistant_text_not_contains_any',
    turn: 1,
    contains_none: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'phone-readback-uses-spoken-text').rule, {
    type: 'turn_assistant_text_not_contains_any',
    turn: 4,
    contains_none: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'phone-readback-asks-for-yes-no-confirmation').rule, {
    type: 'turn_assistant_text_contains_any',
    turn: 4,
    contains_any: [
      'czy wszystko się zgadza',
      'czy wszystko sie zgadza',
      'czy ten numer się zgadza',
      'czy ten numer sie zgadza',
      'czy to poprawny numer',
      'czy ten numer jest poprawny',
      'is that correct'
    ]
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'final-confirmation-uses-spoken-text').rule, {
    type: 'turn_assistant_text_not_contains_any',
    turn: 6,
    contains_none: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'booking-sms-workflow-accepted').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'createEvent',
    path: 'bookingConfirmationSms.accepted',
    equals: true
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'booking-sms-targets-single-recipient').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'createEvent',
    path: 'bookingConfirmationSms.delivery.recipientCount',
    equals: 1
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'booking-sms-produces-booking-confirmation-payload').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'createEvent',
    path: 'bookingConfirmationSms.sms.kind',
    equals: 'booking_confirmation'
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'booking-sms-result-keeps-polish-language').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'createEvent',
    path: 'bookingConfirmationSms.sms.language',
    equals: 'pl'
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'no-separate-patient-sms-tool').rule, {
    type: 'tool_not_called',
    tool_name: 'sendSmsToPatient'
  });

  assert.deepEqual(getScenarioCriterion(receptionSmsScenario, 'internal-sms-workflow-accepted').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'sendSmsToReceptionists',
    path: 'accepted',
    equals: true
  });
  assert.deepEqual(getScenarioCriterion(receptionSmsScenario, 'internal-sms-targets-single-recipient').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'sendSmsToReceptionists',
    path: 'delivery.recipientCount',
    equals: 1
  });
  assert.deepEqual(getScenarioCriterion(receptionSmsScenario, 'internal-sms-produces-reception-notification').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'sendSmsToReceptionists',
    path: 'notification.kind',
    equals: 'reception_follow_up'
  });
  assert.deepEqual(getScenarioCriterion(receptionSmsScenario, 'name-is-not-reasked-after-complete-first-turn').rule, {
    type: 'turn_assistant_text_not_contains_any',
    turn: 1,
    contains_none: [
      'prosze podac imie',
      'prosze podac imie i nazwisko',
      'jak ma na imie',
      'jakie jest imie i nazwisko'
    ]
  });
  assert.deepEqual(getScenarioCriterion(receptionSmsScenario, 'phone-readback-uses-spoken-text').rule, {
    type: 'turn_assistant_text_not_contains_any',
    turn: 1,
    contains_none: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  });

  assert.deepEqual(getScenarioCriterion(existingPatientBookingScenario, 'internal-sms-workflow-accepted').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'sendSmsToReceptionists',
    path: 'accepted',
    equals: true
  });
  assert.deepEqual(getScenarioCriterion(existingPatientBookingScenario, 'name-is-not-reasked-after-complete-first-turn').rule, {
    type: 'turn_assistant_text_not_contains_any',
    turn: 1,
    contains_none: [
      'prosze podac imie',
      'prosze podac imie i nazwisko',
      'jak ma na imie',
      'jakie jest imie i nazwisko'
    ]
  });
  assert.deepEqual(getScenarioCriterion(existingPatientBookingScenario, 'phone-readback-uses-spoken-text').rule, {
    type: 'turn_assistant_text_not_contains_any',
    turn: 1,
    contains_none: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  });
  assert.deepEqual(getScenarioCriterion(implantBookingScenario, 'phone-readback-asks-for-yes-no-confirmation').rule, {
    type: 'turn_assistant_text_contains_any',
    turn: 5,
    contains_any: [
      'czy wszystko się zgadza',
      'czy wszystko sie zgadza',
      'czy ten numer się zgadza',
      'czy ten numer sie zgadza',
      'czy to poprawny numer',
      'czy ten numer jest poprawny',
      'is that correct'
    ]
  });
  assert.deepEqual(getScenarioCriterion(existingPatientBookingScenario, 'internal-sms-keeps-task-type').rule, {
    type: 'tool_arg_equals',
    tool_name: 'sendSmsToReceptionists',
    path: 'taskType',
    equals: 'existing_patient_booking'
  });
});

test('docker compose files expose SMS runtime variables to n8n', () => {
  const composeFiles = [
    'n8n/docker-compose.yml',
    'deploy/vps/docker-compose.yml',
    'deploy/vps/docker-compose.n8n-only.yml'
  ];
  const requiredLines = [
    '- AI_RECEPTIONIST_SMS_PROVIDER=${AI_RECEPTIONIST_SMS_PROVIDER}',
    '- AI_RECEPTIONIST_SMS_WEBHOOK_URL=${AI_RECEPTIONIST_SMS_WEBHOOK_URL}',
    '- AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN=${AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN}',
    '- AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS=${AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS}',
    '- AI_RECEPTIONIST_BOOKING_SMS_MODE=${AI_RECEPTIONIST_BOOKING_SMS_MODE}',
    '- AI_RECEPTIONIST_SMS_SENDER=${AI_RECEPTIONIST_SMS_SENDER}',
    '- AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS=${AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS}',
    '- TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}',
    '- TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}',
    '- TWILIO_PHONE_NUMBER=${TWILIO_PHONE_NUMBER}'
  ];

  for (const relativePath of composeFiles) {
    const composeText = loadText(path.join(rootDir, relativePath));
    for (const line of requiredLines) {
      assert.match(
        composeText,
        new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `Expected ${relativePath} to include ${line}`
      );
	}
  }
});

test('Caddy access log filter redacts webhook secret carriers before observability enrichment', () => {
  const caddyfile = loadText(path.join(rootDir, 'deploy', 'vps', 'Caddyfile'));
  assert.match(caddyfile, /request>uri query\s*\{\s*replace secret REDACTED\s*\}/m);
  assert.match(caddyfile, /request>headers>X-Ai-Receptionist-Secret delete/);
});

assistantInvariantTest('assistant chat rubric can verify booking SMS metadata returned inside createEvent', () => {
  const context = createChatRegressionContext({
    turns: [{ user: 'synthetic turn' }],
    rubric: []
  });

  normalizeOutputForTurn(context, 1, [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_create_event_1',
          function: {
            name: 'createEvent',
            arguments: JSON.stringify({
              service: { id: 'consultation' },
              slotStart: '2026-03-23T09:00:00+01:00',
              slotEnd: '2026-03-23T09:45:00+01:00'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_create_event_1',
      content: {
        created: true,
        calendarEventId: 'evt_sms_patient_001',
        bookingConfirmationSms: {
          accepted: true,
          recipientClass: 'caller_phone',
          delivery: {
            recipientCount: 1
          },
          sms: {
            kind: 'booking_confirmation',
            language: 'pl'
          }
        }
      }
    }
  ]);

  const acceptedResult = evaluateChatCriterion(context, {
    criterion_id: 'booking-sms-accepted',
    description: 'createEvent should carry accepted booking SMS metadata',
    severity: 'critical',
    rule: {
      type: 'tool_result_path_equals',
      tool_name: 'createEvent',
      path: 'bookingConfirmationSms.accepted',
      equals: true
    }
  });
  assert.equal(acceptedResult.passed, true);

  const recipientCountResult = evaluateChatCriterion(context, {
    criterion_id: 'booking-sms-recipient-count',
    description: 'createEvent should carry a single-recipient booking SMS result',
    severity: 'high',
    rule: {
      type: 'tool_result_path_equals',
      tool_name: 'createEvent',
      path: 'bookingConfirmationSms.delivery.recipientCount',
      equals: 1
    }
  });
  assert.equal(recipientCountResult.passed, true);

  const payloadKindResult = evaluateChatCriterion(context, {
    criterion_id: 'booking-sms-kind',
    description: 'createEvent should carry booking_confirmation SMS metadata',
    severity: 'high',
    rule: {
      type: 'tool_result_path_equals',
      tool_name: 'createEvent',
      path: 'bookingConfirmationSms.sms.kind',
      equals: 'booking_confirmation'
    }
  });
  assert.equal(payloadKindResult.passed, true);

  const noSeparateToolResult = evaluateChatCriterion(context, {
    criterion_id: 'no-separate-patient-sms-tool',
    description: 'the assistant should not call sendSmsToPatient separately',
    severity: 'high',
    rule: {
      type: 'tool_not_called',
      tool_name: 'sendSmsToPatient',
    }
  });
  assert.equal(noSeparateToolResult.passed, true);
});

assistantInvariantTest('assistant chat rubric rejects direct patient SMS tool calls in booking flows', () => {
  const context = createChatRegressionContext({
    turns: [{ user: 'synthetic turn' }],
    rubric: []
  });

  normalizeOutputForTurn(context, 1, [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_create_event_early',
          function: {
            name: 'createEvent',
            arguments: JSON.stringify({
              service: { id: 'consultation' }
            })
          }
        }
      ]
    },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_send_sms_patient_unexpected',
          function: {
            name: 'sendSmsToPatient',
            arguments: JSON.stringify({
              calendarEventId: 'evt_missing'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_create_event_early',
      content: {
        created: true,
        calendarEventId: 'evt_missing'
      }
    }
  ]);

  const noSeparateToolResult = evaluateChatCriterion(context, {
    criterion_id: 'no-separate-patient-sms-tool',
    description: 'sendSmsToPatient should not be called separately',
    severity: 'critical',
    rule: {
      type: 'tool_not_called',
      tool_name: 'sendSmsToPatient'
    }
  });
  assert.equal(noSeparateToolResult.passed, false);
  assert.match(noSeparateToolResult.failure_reason || '', /sendSmsToPatient/);
});

assistantInvariantTest('assistant chat rubric can verify internal receptionist SMS ordering and taskId reuse', () => {
  const context = createChatRegressionContext({
    turns: [{ user: 'synthetic turn' }],
    rubric: []
  });

  normalizeOutputForTurn(context, 1, [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_create_task_1',
          function: {
            name: 'createReceptionTask',
            arguments: JSON.stringify({
              taskType: 'reschedule_or_cancel'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_create_task_1',
      content: {
        accepted: true,
        taskId: 'task_sms_reception_001'
      }
    },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_send_sms_reception_1',
          function: {
            name: 'sendSmsToReceptionists',
            arguments: JSON.stringify({
              taskId: 'task_sms_reception_001',
              taskType: 'reschedule_or_cancel'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_send_sms_reception_1',
      content: {
        accepted: true,
        delivery: {
          recipientCount: 1
        },
        notification: {
          kind: 'reception_follow_up'
        }
      }
    }
  ]);

  const orderingResult = evaluateChatCriterion(context, {
    criterion_id: 'internal-sms-after-task',
    description: 'sendSmsToReceptionists should happen after createReceptionTask returned',
    severity: 'critical',
    rule: {
      type: 'tool_called_after_tool_result',
      tool_name: 'sendSmsToReceptionists',
      source_tool_name: 'createReceptionTask'
    }
  });
  assert.equal(orderingResult.passed, true);

  const idReuseResult = evaluateChatCriterion(context, {
    criterion_id: 'internal-sms-reuses-task-id',
    description: 'sendSmsToReceptionists should reuse taskId from createReceptionTask',
    severity: 'critical',
    rule: {
      type: 'tool_arg_matches_tool_result_path',
      tool_name: 'sendSmsToReceptionists',
      path: 'taskId',
      source_tool_name: 'createReceptionTask',
      source_path: 'taskId'
    }
  });
  assert.equal(idReuseResult.passed, true);

  const acceptedResult = evaluateChatCriterion(context, {
    criterion_id: 'internal-sms-accepted',
    description: 'sendSmsToReceptionists should return accepted=true',
    severity: 'critical',
    rule: {
      type: 'tool_result_path_equals',
      tool_name: 'sendSmsToReceptionists',
      path: 'accepted',
      equals: true
    }
  });
  assert.equal(acceptedResult.passed, true);

  const recipientCountResult = evaluateChatCriterion(context, {
    criterion_id: 'internal-sms-recipient-count',
    description: 'sendSmsToReceptionists should target one recipient',
    severity: 'high',
    rule: {
      type: 'tool_result_path_equals',
      tool_name: 'sendSmsToReceptionists',
      path: 'delivery.recipientCount',
      equals: 1
    }
  });
  assert.equal(recipientCountResult.passed, true);

  const notificationKindResult = evaluateChatCriterion(context, {
    criterion_id: 'internal-sms-kind',
    description: 'sendSmsToReceptionists should return reception_follow_up notification metadata',
    severity: 'high',
    rule: {
      type: 'tool_result_path_equals',
      tool_name: 'sendSmsToReceptionists',
      path: 'notification.kind',
      equals: 'reception_follow_up'
    }
  });
  assert.equal(notificationKindResult.passed, true);
});

assistantInvariantTest('assistant chat rubric can verify createReceptionTask omits forbidden free-text fields', () => {
  const context = createChatRegressionContext({
    turns: [{ user: 'synthetic turn' }],
    rubric: []
  });

  normalizeOutputForTurn(context, 1, [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_create_task_minimized',
          function: {
            name: 'createReceptionTask',
            arguments: JSON.stringify({
              taskType: 'existing_patient_booking',
              patient: {
                fullName: 'Anna Kowalska',
                phoneE164: '+48500111001'
              },
              serviceBucket: 'hygiene'
            })
          }
        }
      ]
    }
  ]);

  const summaryMissingResult = evaluateChatCriterion(context, {
    criterion_id: 'reception-task-omits-summary',
    description: 'createReceptionTask should omit summary',
    severity: 'critical',
    rule: {
      type: 'tool_arg_missing',
      tool_name: 'createReceptionTask',
      path: 'summary'
    }
  });
  assert.equal(summaryMissingResult.passed, true);

  const notesMissingResult = evaluateChatCriterion(context, {
    criterion_id: 'reception-task-omits-notes',
    description: 'createReceptionTask should omit notes',
    severity: 'critical',
    rule: {
      type: 'tool_arg_missing',
      tool_name: 'createReceptionTask',
      path: 'notes'
    }
  });
  assert.equal(notesMissingResult.passed, true);
});

assistantInvariantTest('assistant chat rubric can verify createEvent reuses the exact selected slot boundaries', () => {
  const context = createChatRegressionContext({
    turns: [{ user: 'synthetic turn' }],
    rubric: []
  });

  normalizeOutputForTurn(context, 1, [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_check_slots_1',
          function: {
            name: 'checkAvailability',
            arguments: JSON.stringify({
              service: { id: 'consultation' },
              timePreference: 'morning'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_check_slots_1',
      content: {
        available: true,
        slots: [
          {
            start: '2026-03-23T09:00:00+01:00',
            end: '2026-03-23T09:45:00+01:00'
          },
          {
            start: '2026-03-23T10:15:00+01:00',
            end: '2026-03-23T11:00:00+01:00'
          }
        ]
      }
    },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_create_event_selected_slot',
          function: {
            name: 'createEvent',
            arguments: JSON.stringify({
              service: { id: 'consultation' },
              slotStart: '2026-03-23T10:15:00+01:00',
              slotEnd: '2026-03-23T11:00:00+01:00'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_create_event_selected_slot',
      content: {
        created: true,
        appointment: {
          start: '2026-03-23T10:15:00+01:00',
          end: '2026-03-23T11:00:00+01:00'
        }
      }
    }
  ]);

  const result = evaluateChatCriterion(context, {
    criterion_id: 'selected-slot-preserved',
    description: 'createEvent should reuse the exact slot boundaries returned by checkAvailability',
    severity: 'critical',
    rule: {
      type: 'create_event_matches_selected_slot',
      availability_turn: 1,
      selected_slot_index: 1
    }
  });
  assert.equal(result.passed, true);
});

assistantInvariantTest('assistant chat rubric accepts workflow-normalized slot boundaries when the booked slot is correct', () => {
  const context = createChatRegressionContext({
    turns: [{ user: 'synthetic turn' }],
    rubric: []
  });

  normalizeOutputForTurn(context, 1, [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_check_slots_normalized',
          function: {
            name: 'checkAvailability',
            arguments: JSON.stringify({
              service: { id: 'consultation' },
              timePreference: 'morning'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_check_slots_normalized',
      content: {
        available: true,
        slots: [
          {
            start: '2026-03-23T10:15:00+01:00',
            end: '2026-03-23T11:00:00+01:00'
          }
        ]
      }
    },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_create_event_normalized',
          function: {
            name: 'createEvent',
            arguments: JSON.stringify({
              service: { id: 'consultation' },
              slotStart: '2026-03-23T10:15:00+01:00',
              slotEnd: '2026-03-23T10:45:00+01:00'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_create_event_normalized',
      content: {
        created: true,
        appointment: {
          start: '2026-03-23T10:15:00+01:00',
          end: '2026-03-23T11:00:00+01:00'
        }
      }
    }
  ]);

  const result = evaluateChatCriterion(context, {
    criterion_id: 'selected-slot-normalized',
    description: 'createEvent may be normalized by the workflow as long as the booked slot matches the selected slot',
    severity: 'critical',
    rule: {
      type: 'create_event_matches_selected_slot',
      availability_turn: 1,
      selected_slot_index: 0
    }
  });
  assert.equal(result.passed, true);
});

assistantInvariantTest('assistant chat rubric rejects createEvent when slotEnd drifts from the selected slot', () => {
  const context = createChatRegressionContext({
    turns: [{ user: 'synthetic turn' }],
    rubric: []
  });

  normalizeOutputForTurn(context, 1, [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_check_slots_drift',
          function: {
            name: 'checkAvailability',
            arguments: JSON.stringify({
              service: { id: 'consultation' },
              timePreference: 'morning'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_check_slots_drift',
      content: {
        available: true,
        slots: [
          {
            start: '2026-03-23T10:15:00+01:00',
            end: '2026-03-23T11:00:00+01:00'
          }
        ]
      }
    },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_create_event_drift',
          function: {
            name: 'createEvent',
            arguments: JSON.stringify({
              service: { id: 'consultation' },
              slotStart: '2026-03-23T10:15:00+01:00',
              slotEnd: '2026-03-23T10:45:00+01:00'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_create_event_drift',
      content: {
        created: true,
        appointment: {
          start: '2026-03-23T10:15:00+01:00',
          end: '2026-03-23T10:45:00+01:00'
        }
      }
    }
  ]);

  const result = evaluateChatCriterion(context, {
    criterion_id: 'selected-slot-drift-detected',
    description: 'createEvent should not shorten the selected slot before booking',
    severity: 'critical',
    rule: {
      type: 'create_event_matches_selected_slot',
      availability_turn: 1,
      selected_slot_index: 0
    }
  });
  assert.equal(result.passed, false);
  assert.match(result.failure_reason || '', /selected slot boundaries/);
});

test('structured output schema exposes QA flags for conversation regressions', () => {
  const schema = loadStructuredOutputSchema();
  const qualityFlags = schema.properties?.qualityFlags?.properties;
  assert.ok(qualityFlags, 'qualityFlags schema is missing');
  assert.deepEqual(
    Object.keys(qualityFlags).sort(),
    [
      'explicitBookingConfirmationMissing',
      'multipleQuestionsInSingleTurn',
      'phoneNumberRepeatedIncorrectly',
      'postBookingFlowRestarted',
      'repeatedIdentityRequest',
      'toolCalledOnIncompleteAnswer',
      'unnecessaryHealthDetailRequest'
    ]
  );
});

test('real-call ingest redacts utterance text and minimizes tool payloads', () => {
  const sample = loadAutonomyExample('vapi-call-ended-sample-booking.json');
  const [entry] = pickCallEntries(sample);
  const run = buildRun(
    entry,
    {
      scenarioId: null,
      environment: 'staging',
      runKind: 'real_call'
    },
    null
  );

  assert.equal(run.call.transcript, null);
  assert.equal(run.call.recording_url, null);
  assert.equal(run.call.web_call_url, null);
  assert.ok(run.conversation.messages_omitted.includes('real_call_content_redacted'));
  assert.ok(run.conversation.messages_omitted.includes('real_call_tool_payloads_minimized'));
  assert.ok(
    run.conversation.messages.every((message) => message.kind !== 'utterance' || message.text === null),
    'real-call utterance text should be redacted'
  );

  const knowledgeBaseTrace = run.tool_trace.find((trace) => trace.tool_name === 'searchKnowledgeBase');
  assert.deepEqual(knowledgeBaseTrace?.arguments, {
    language: 'pl',
    limit: 2,
    queryRedacted: true
  });
  assert.deepEqual(knowledgeBaseTrace?.result, {
    found: true,
    matches: [
      {
        id: 'kb_all_on_4',
        title: 'System All-on-4',
        sourceDocument: 'all-on-4.odt'
      }
    ],
    answerRedacted: true
  });

  const createEventTrace = run.tool_trace.find((trace) => trace.tool_name === 'createEvent');
  assert.deepEqual(createEventTrace?.arguments, {
    source: 'phone',
    slotStart: '2026-03-19T10:30:00+01:00',
    slotEnd: '2026-03-19T11:15:00+01:00',
    timezone: 'Europe/Warsaw',
    patient: {
      isExistingPatient: false
    },
    service: {
      id: 'implant_consultation',
      durationMinutes: 45
    }
  });
  assert.deepEqual(createEventTrace?.result, {
    created: true,
    calendarEventId: 'calendar_sample_001',
    appointment: {
      start: '2026-03-19T10:30:00+01:00',
      end: '2026-03-19T11:15:00+01:00',
      timezone: 'Europe/Warsaw',
      service: {
        id: 'implant_consultation'
      }
    }
  });

  assert.deepEqual(run.structured_output.result, {
    callOutcome: 'appointment_booked',
    successfulForAssistantScope: true,
    language: 'pl',
    caller: {
      isExistingPatient: false
    },
    timing: {
      requestedDateIso: '2026-03-19',
      timePreference: 'first_available',
      selectedSlotStart: '2026-03-19T10:30:00+01:00',
      selectedSlotEnd: '2026-03-19T11:15:00+01:00',
      timezone: 'Europe/Warsaw'
    },
    booking: {
      availabilityChecked: true,
      slotOptionsOffered: 1,
      slotSelected: true,
      bookingCreated: true,
      serviceId: 'implant_consultation',
      firstVisit: true,
      doctorAssignmentConfirmedBySystem: false,
      firstVisitPriceMentioned: false
    },
    riskFlags: {
      urgentSymptomsMentioned: false,
      medicalAdviceRequested: false,
      medicalAdviceGiven: false,
      cancellationOrRescheduleRequested: false,
      toolFailureOccurred: false,
      ambiguousDateClarified: false,
      callerHungUpBeforeCompletion: false
    },
    qualityFlags: {
      repeatedIdentityRequest: false,
      multipleQuestionsInSingleTurn: false,
      toolCalledOnIncompleteAnswer: false,
      explicitBookingConfirmationMissing: false,
      phoneNumberRepeatedIncorrectly: false,
      postBookingFlowRestarted: false
    },
    followUp: {
      receptionFollowUpNeeded: false,
      reason: 'none'
    }
  });

  const primaryStructuredOutput = run.observability.structured_outputs.find(
    (item) => item.output_name_canonical === 'Dental Call Intake'
  );
  assert.ok(primaryStructuredOutput, 'expected dental intake structured output in observability');
  assert.deepEqual(primaryStructuredOutput.result, run.structured_output.result);
  assert.equal(primaryStructuredOutput.result.intent, undefined);
  assert.equal(primaryStructuredOutput.result.summary, undefined);
});

test('real-call ingest parses stringified Vapi tool results and errors', () => {
  const record = {
    id: 'call_stringified_tool_results',
    status: 'ended',
    assistantId: 'assistant_test',
    startedAt: '2026-04-04T13:00:00.000Z',
    endedAt: '2026-04-04T13:01:00.000Z',
    artifact: {
      messages: [
        {
          role: 'tool_calls',
          time: 1000,
          secondsFromStart: 1,
          toolCallList: [
            {
              id: 'tool_call_availability',
              name: 'checkAvailability',
              parameters: JSON.stringify({
                service: { id: 'consultation' },
                timePreference: 'first_available',
                timezone: 'Europe/Warsaw'
              })
            }
          ]
        },
        {
          role: 'tool_call_result',
          time: 1500,
          secondsFromStart: 1.5,
          name: 'checkAvailability',
          toolCallId: 'tool_call_availability',
          result: JSON.stringify({
            available: true,
            slots: [
              {
                spokenLabel: 'poniedziałek, szesnastego marca o dziewiątej'
              }
            ]
          })
        },
        {
          role: 'tool_calls',
          time: 2000,
          secondsFromStart: 2,
          toolCallList: [
            {
              id: 'tool_call_booking',
              name: 'createEvent',
              parameters: JSON.stringify({
                slotStart: '2026-03-16T09:00:00+01:00',
                slotEnd: '2026-03-16T09:45:00+01:00'
              })
            }
          ]
        },
        {
          role: 'tool_call_result',
          time: 2500,
          secondsFromStart: 2.5,
          name: 'createEvent',
          toolCallId: 'tool_call_booking',
          error: JSON.stringify({
            created: false,
            error: {
              code: 'SLOT_UNAVAILABLE'
            }
          })
        }
      ]
    }
  };

  const run = buildRun(
    {
      record,
      wrapper: record,
      index: 0,
      sourceKind: 'call_object'
    },
    {
      scenarioId: null,
      environment: 'staging',
      runKind: 'real_call'
    },
    null
  );

  const availabilityTrace = run.tool_trace.find((trace) => trace.tool_name === 'checkAvailability');
  const bookingTrace = run.tool_trace.find((trace) => trace.tool_name === 'createEvent');

  assert.equal(availabilityTrace?.result?.available, true);
  assert.equal(bookingTrace?.result?.error?.code, 'SLOT_UNAVAILABLE');
});

test('real-call ingest derives latency diagnostics from turn metrics and tool round trips', () => {
  const record = {
    id: 'call_latency_001',
    startedAt: '2026-04-03T20:20:05.000Z',
    endedAt: '2026-04-03T20:20:55.000Z',
    status: 'ended',
    artifact: {
      performanceMetrics: {
        turnLatencies: [
          {
            modelLatency: 4540,
            transcriberLatency: 724,
            endpointingLatency: 500,
            turnLatency: 7200
          },
          {
            modelLatency: 1180,
            transcriberLatency: 446,
            endpointingLatency: 500,
            turnLatency: 2400
          }
        ]
      }
    },
    messages: [
      {
        role: 'tool_calls',
        time: 46442,
        secondsFromStart: 46.442,
        toolCalls: [
          {
            id: 'tool_call_latency_001',
            type: 'function',
            function: {
              name: 'checkAvailability',
              arguments: JSON.stringify({
                service: { id: 'urgent_consultation' },
                timePreference: 'first_available',
                timezone: 'Europe/Warsaw'
              })
            }
          }
        ]
      },
      {
        role: 'tool_call_result',
        time: 48241,
        secondsFromStart: 48.241,
        name: 'checkAvailability',
        toolCallId: 'tool_call_latency_001',
        result: {
          available: true,
          slots: []
        }
      }
    ]
  };

  const run = buildRun(
    {
      record,
      wrapper: record,
      index: 0,
      sourceKind: 'call_object'
    },
    {
      scenarioId: null,
      environment: 'staging',
      runKind: 'real_call'
    },
    null
  );

  assert.deepEqual(run.call.latency_diagnostics, {
    maxModelLatencyMs: 4540,
    maxTranscriberLatencyMs: 724,
    maxEndpointingLatencyMs: 500,
    maxToolRoundTripLatencyMs: 1799,
    maxWebhookLatencyMs: 1799,
    webhookLatencyMetricSource: 'tool_trace_round_trip',
    dominantLatencyStage: 'model',
    slowestToolTrace: {
      toolName: 'checkAvailability',
      toolCallId: 'tool_call_latency_001',
      roundTripMs: 1799
    },
    slowTurnCount: 1
  });
});

test('real-call ingest derives decomposed tool latency diagnostics from matched n8n executions', () => {
  const record = {
    startedAt: '2026-04-05T10:54:27.118Z',
    endedAt: '2026-04-05T10:56:03.186Z',
    artifact: {
      performanceMetrics: {
        turnLatencies: [
          {
            modelLatency: 514,
            transcriberLatency: 0,
            endpointingLatency: 1001,
            turnLatency: 1515
          }
        ]
      }
    }
  };

	  const diagnostics = deriveLatencyDiagnostics(record, [
	    {
	      tool_name: 'checkAvailability',
	      tool_call_id: 'tool_call_latency_002',
	      requested_at_ms: 10000,
	      completed_at_ms: 31159,
      n8nLatency: {
        workflowId: 'aiReceptionistCheckAvailability',
        executionId: '2583',
        workflowDurationMs: 652,
        externalDurationMs: 410,
        internalDurationMs: 242,
	        preWorkflowGapMs: 1041,
	        postWorkflowGapMs: 19466,
	        platformGapMs: 20507,
	        matchedUsing: 'nearest_workflow_start_after_tool_request'
	      },
	      edgeLatency: {
	        requestPath: '/webhook/ai-receptionist/check-availability',
	        status: 200,
	        edgeDurationMs: 8326,
	        upstreamDurationMs: 649,
	        upstreamLatencyMs: 187,
	        toolToEdgeStartGapMs: 284,
	        edgeIngressGapMs: 757,
	        edgeObservedGapMs: 7674,
	        edgeEgressGapMs: 6917,
	        edgeToToolResultGapMs: 12549
	      }
	    }
	  ]);

  assert.deepEqual(diagnostics, {
    maxModelLatencyMs: 514,
    maxTranscriberLatencyMs: 0,
    maxEndpointingLatencyMs: 1001,
    maxToolRoundTripLatencyMs: 21159,
    maxToolBackendWorkflowLatencyMs: 652,
	    maxToolBackendExternalLatencyMs: 410,
	    maxToolBackendInternalLatencyMs: 242,
	    maxToolDispatchGapMs: 1041,
	    maxToolToEdgeStartGapMs: 284,
	    maxToolReturnGapMs: 19466,
	    maxToolPlatformGapMs: 20507,
	    maxToolEdgeDurationMs: 8326,
	    maxToolEdgeUpstreamDurationMs: 649,
	    maxToolEdgeUpstreamLatencyMs: 187,
	    maxToolEdgeIngressGapMs: 757,
	    maxToolEdgeObservedGapMs: 7674,
	    maxToolEdgeEgressGapMs: 6917,
	    maxToolEdgeToToolResultGapMs: 12549,
	    maxWebhookLatencyMs: 21159,
	    webhookLatencyMetricSource: 'tool_trace_round_trip',
	    dominantLatencyStage: 'tool_edge_to_result_gap',
	    slowestToolTrace: {
	      toolName: 'checkAvailability',
	      toolCallId: 'tool_call_latency_002',
	      roundTripMs: 21159,
	      backendWorkflowLatencyMs: 652,
	      backendExternalLatencyMs: 410,
	      backendInternalLatencyMs: 242,
	      dispatchGapMs: 1041,
	      toolToEdgeStartGapMs: 284,
	      returnGapMs: 19466,
	      platformGapMs: 20507,
	      edgeDurationMs: 8326,
	      edgeUpstreamDurationMs: 649,
	      edgeUpstreamLatencyMs: 187,
	      edgeIngressGapMs: 757,
	      edgeObservedGapMs: 7674,
	      edgeEgressGapMs: 6917,
	      edgeToToolResultGapMs: 12549,
	      edgeStatus: 200,
	      requestPath: '/webhook/ai-receptionist/check-availability',
	      workflowId: 'aiReceptionistCheckAvailability',
	      executionId: '2583',
	      matchedUsing: 'nearest_workflow_start_after_tool_request'
	    },
	    slowTurnCount: 0
  });
});

test('live autoeval matches tool traces to n8n executions and preserves stage breakdown', () => {
  const suiteRuns = [
    {
      run: {
        call: {},
        tool_trace: [
          {
            tool_name: 'checkAvailability',
            tool_call_id: 'tool_call_latency_match',
            requested_at_ms: 10000,
            completed_at_ms: 31159
          }
        ]
      }
    }
  ];

  const executions = buildN8nExecutionSummaries([
    {
      eventName: 'n8n.workflow.started',
      payload: {
        executionId: '2583',
        workflowId: 'aiReceptionistCheckAvailability',
        workflowName: 'aiReceptionistCheckAvailability'
      },
      __file: 'n8nEventLog.log',
      __tsMs: 11041
    },
    {
      eventName: 'n8n.node.started',
      payload: {
        executionId: '2583',
        workflowId: 'aiReceptionistCheckAvailability',
        workflowName: 'aiReceptionistCheckAvailability',
        nodeName: 'Google Calendar',
        nodeType: 'n8n-nodes-base.googleCalendar'
      },
      __file: 'n8nEventLog.log',
      __tsMs: 11041
    },
    {
      eventName: 'n8n.node.finished',
      payload: {
        executionId: '2583',
        workflowId: 'aiReceptionistCheckAvailability',
        workflowName: 'aiReceptionistCheckAvailability',
        nodeName: 'Google Calendar',
        nodeType: 'n8n-nodes-base.googleCalendar'
      },
      __file: 'n8nEventLog.log',
      __tsMs: 11451
    },
    {
      eventName: 'n8n.node.started',
      payload: {
        executionId: '2583',
        workflowId: 'aiReceptionistCheckAvailability',
        workflowName: 'aiReceptionistCheckAvailability',
        nodeName: 'Build Slots',
        nodeType: 'n8n-nodes-base.code'
      },
      __file: 'n8nEventLog.log',
      __tsMs: 11451
    },
    {
      eventName: 'n8n.node.finished',
      payload: {
        executionId: '2583',
        workflowId: 'aiReceptionistCheckAvailability',
        workflowName: 'aiReceptionistCheckAvailability',
        nodeName: 'Build Slots',
        nodeType: 'n8n-nodes-base.code'
      },
      __file: 'n8nEventLog.log',
      __tsMs: 11693
    },
    {
      eventName: 'n8n.workflow.success',
      payload: {
        executionId: '2583',
        workflowId: 'aiReceptionistCheckAvailability',
        workflowName: 'aiReceptionistCheckAvailability'
      },
      __file: 'n8nEventLog.log',
      __tsMs: 11693
    }
  ]);

  const matchSummary = matchToolTracesToExecutions(buildToolTraceRefs(suiteRuns), executions);
  const trace = suiteRuns[0].run.tool_trace[0];

  assert.deepEqual(matchSummary, {
    matchedTraceCount: 1,
    totalTraceCount: 1,
    executionCount: 1
  });
	assert.deepEqual(trace.n8nLatency, {
	  source: 'n8n_event_log',
    workflowId: 'aiReceptionistCheckAvailability',
    workflowName: 'aiReceptionistCheckAvailability',
    executionId: '2583',
    workflowStartedAtMs: 11041,
    workflowFinishedAtMs: 11693,
    workflowDurationMs: 652,
    externalDurationMs: 410,
    internalDurationMs: 242,
    preWorkflowGapMs: 1041,
    postWorkflowGapMs: 19466,
    platformGapMs: 20507,
    externalNodes: [
      {
        nodeName: 'Google Calendar',
        nodeType: 'n8n-nodes-base.googleCalendar',
        count: 1,
        durationMs: 410
      }
    ],
    files: ['n8nEventLog.log'],
	  matchedUsing: 'nearest_workflow_start_after_tool_request'
	});
});

test('live autoeval matches tool traces to Caddy access logs and preserves edge stage breakdown', () => {
  const suiteRuns = [
    {
      run: {
        call: {},
        tool_trace: [
          {
            tool_name: 'checkAvailability',
            tool_call_id: 'tool_call_latency_match',
            requested_at_ms: 10000,
            completed_at_ms: 31159,
            n8nLatency: {
              workflowStartedAtMs: 11041,
              workflowFinishedAtMs: 11693,
              workflowDurationMs: 652
            }
          }
        ]
      }
    }
  ];

  const accessEntries = parseCaddyAccessLogBundle(
    JSON.stringify({
      level: 'info',
      ts: 18.61,
      logger: 'http.log.access.log0',
      msg: 'handled request',
      request: {
        method: 'POST',
        uri: '/webhook/ai-receptionist/check-availability?secret=REDACTED'
      },
      duration: 8.326,
      status: 200,
      upstream_duration_ms: '649',
      upstream_latency_ms: '187'
    }),
    { minMs: 9000, maxMs: 32000 }
  );

  const matchSummary = matchToolTracesToCaddyEntries(buildToolTraceRefs(suiteRuns), accessEntries);
  const trace = suiteRuns[0].run.tool_trace[0];

  assert.deepEqual(matchSummary, {
    matchedTraceCount: 1,
    totalTraceCount: 1,
    accessEntryCount: 1
  });
  assert.deepEqual(trace.edgeLatency, {
    source: 'caddy_access_log',
    requestPath: '/webhook/ai-receptionist/check-availability',
    method: 'POST',
    status: 200,
    edgeStartedAtMs: 10284,
    edgeCompletedAtMs: 18610,
    edgeDurationMs: 8326,
    upstreamDurationMs: 649,
    upstreamLatencyMs: 187,
    proxyOverheadMs: 7677,
    toolToEdgeStartGapMs: 284,
    edgeIngressGapMs: 757,
    edgeObservedGapMs: 7674,
    edgeEgressGapMs: 6917,
    edgeToToolResultGapMs: 12549,
    roundTripMs: 21159,
    matchedUsing: 'nearest_edge_request_for_tool_endpoint'
  });
});

test('live autoeval falls back to the default Caddy container name when only SSH and n8n container env vars are set', () => {
  const restoreEnv = { ...process.env };
  try {
    delete process.env.PRODUCTION_VPS_CADDY_CONTAINER_NAME;
    delete process.env.CADDY_CONTAINER_NAME;
    process.env.PRODUCTION_VPS_SSH_HOST = 'example.com';
    process.env.PRODUCTION_VPS_SSH_USER = 'deploy';
    process.env.PRODUCTION_VPS_N8N_CONTAINER_NAME = 'ai-receptionist-n8n';
    const sshContext = buildSshContext('production');
    assert.deepEqual(sshContext, {
      host: 'example.com',
      user: 'deploy',
      port: '22',
      identityFile: '',
      n8nContainer: 'ai-receptionist-n8n',
      caddyContainer: 'ai-receptionist-caddy'
    });
  } finally {
    process.env = restoreEnv;
  }
});

test('live autoeval matches Vapi artifact webhook transport to tool traces', () => {
  const requestUrl = 'https://example.com/webhook/ai-receptionist/check-availability?secret=REDACTED';
  const suiteRuns = [{
    run: {
      tool_trace: [{
        tool_name: 'checkAvailability',
        tool_call_id: 'call_123',
        requested_at_ms: 1000,
        completed_at_ms: 7000
      }]
    }
  }];
  const transportEntries = parseVapiArtifactWebhookEntries([
    {
      time: 1018,
      body: 'Request initiated: tool-calls',
      attributes: {
        category: 'webhook',
        messageType: 'tool-calls',
        url: requestUrl,
        requestMethod: 'POST',
        timeout: 20,
        retries: 0,
        requestBody: {
          message: {
            toolCalls: [{
              id: 'call_123',
              function: {
                name: 'checkAvailability'
              }
            }]
          }
        }
      }
    },
    {
      time: 1459,
      body: 'Request failed: tool-calls',
      attributes: {
        category: 'webhook',
        messageType: 'tool-calls',
        url: requestUrl,
        latencyMs: 441,
        errorMessage: ''
      }
    },
    {
      time: 1459,
      body: 'Request completed: tool-calls',
      attributes: {
        category: 'webhook',
        messageType: 'tool-calls',
        url: requestUrl,
        totalLatencyMs: 441,
        success: false,
        hasRetries: false
      }
    }
  ]);

  const matchSummary = matchToolTracesToVapiWebhookEntries(buildToolTraceRefs(suiteRuns), transportEntries);
  const trace = suiteRuns[0].run.tool_trace[0];

  assert.deepEqual(matchSummary, {
    matchedTraceCount: 1,
    totalTraceCount: 1,
    transportEntryCount: 1
  });
  assert.deepEqual(trace.vapiWebhookTransport, {
    source: 'vapi_artifact_log',
    requestPath: '/webhook/ai-receptionist/check-availability',
    requestMethod: 'POST',
    requestUrl,
    requestInitiatedAtMs: 1018,
    requestCompletedAtMs: 1459,
    requestLatencyMs: 441,
    statusCode: null,
    success: false,
    hasRetries: false,
    configuredRetries: 0,
    timeoutSeconds: 20,
    errorMessage: '',
    toolToWebhookCompletionGapMs: 459,
    webhookToToolResultGapMs: 5541,
    roundTripMs: 6000,
    matchedUsing: 'tool_call_id_from_vapi_artifact_webhook'
  });
});

test('live autoeval matches first non-wait Vapi assistant speech to tool traces', () => {
  const suiteRuns = [{
    fullCall: {
      id: 'call_123'
    },
    run: {
      call: {
        call_id: 'call_123'
      },
      tool_trace: [{
        tool_name: 'checkAvailability',
        tool_call_id: 'call_123',
        requested_at_ms: 1000,
        completed_at_ms: 7000,
        vapiWebhookTransport: {
          requestCompletedAtMs: 1459
        }
      }]
    }
  }];
  const speechEntries = parseVapiArtifactAssistantSpeechEntries([
    {
      time: 1200,
      body: 'Voice input',
      attributes: {
        category: 'voice',
        callId: 'call_123',
        text: 'Już sprawdzam dostępne terminy.'
      }
    },
    {
      time: 2000,
      body: 'Voice input',
      attributes: {
        category: 'voice',
        callId: 'call_123',
        text: 'Najbliższe wolne terminy to wtorek, siódmego kwietnia o dziesiątej piętnaście.'
      }
    }
  ]);

  const matchSummary = matchToolTracesToVapiSpeechEntries(buildToolTraceRefs(suiteRuns), speechEntries);
  const trace = suiteRuns[0].run.tool_trace[0];

  assert.deepEqual(matchSummary, {
    matchedTraceCount: 1,
    totalTraceCount: 1,
    speechEntryCount: 2
  });
  assert.deepEqual(trace.vapiSpeechLatency, {
    source: 'vapi_artifact_log_voice',
    spokenResultStartedAtMs: 2000,
    speechText: 'Najbliższe wolne terminy to wtorek, siódmego kwietnia o dziesiątej piętnaście.',
    toolToSpeechMs: 1000,
    webhookToSpeechGapMs: 541,
    speechToToolResultBackfillMs: 5000,
    matchedUsing: 'first_non_wait_voice_input_after_webhook_completion'
  });
});

test('latency diagnostics surface Vapi webhook transport failures before edge matching exists', () => {
  const latency = deriveLatencyDiagnostics(
    {
      artifact: {
        performanceMetrics: {
          turnLatencies: []
        }
      }
    },
    [{
      tool_name: 'checkAvailability',
      tool_call_id: 'call_123',
      requested_at_ms: 1000,
      completed_at_ms: 7000,
      vapiWebhookTransport: {
        requestCompletedAtMs: 1459,
        requestLatencyMs: 441,
        success: false,
        hasRetries: false,
        errorMessage: ''
      }
    }]
  );

  assert.equal(latency.maxToolVapiWebhookLatencyMs, 441);
  assert.equal(latency.maxToolVapiWebhookToToolResultGapMs, 5541);
  assert.equal(latency.dominantLatencyStage, 'tool_vapi_webhook_to_result_gap');
  assert.deepEqual(latency.slowestToolTrace, {
    toolName: 'checkAvailability',
    toolCallId: 'call_123',
    roundTripMs: 6000,
    vapiWebhookLatencyMs: 441,
    vapiWebhookToToolResultGapMs: 5541,
    vapiWebhookSuccess: false,
    vapiWebhookHasRetries: false
  });
});

test('latency diagnostics prefer caller-heard Vapi speech gaps over delayed tool-result bookkeeping', () => {
  const latency = deriveLatencyDiagnostics(
    {
      artifact: {
        performanceMetrics: {
          turnLatencies: []
        }
      }
    },
    [{
      tool_name: 'checkAvailability',
      tool_call_id: 'call_123',
      requested_at_ms: 1000,
      completed_at_ms: 7000,
      vapiWebhookTransport: {
        requestCompletedAtMs: 1459,
        requestLatencyMs: 441,
        success: true,
        hasRetries: false
      },
      vapiSpeechLatency: {
        spokenResultStartedAtMs: 2000,
        toolToSpeechMs: 1000,
        webhookToSpeechGapMs: 541,
        speechToToolResultBackfillMs: 5000
      }
    }]
  );

  assert.equal(latency.maxToolVapiWebhookLatencyMs, 441);
  assert.equal(latency.maxToolVapiSpeechLatencyMs, 1000);
  assert.equal(latency.maxToolVapiWebhookToSpeechGapMs, 541);
  assert.equal(latency.maxToolVapiSpeechToToolResultBackfillMs, 5000);
  assert.equal(latency.maxToolVapiWebhookToToolResultGapMs, 5541);
  assert.equal(latency.dominantLatencyStage, 'tool_vapi_webhook_to_speech_gap');
  assert.deepEqual(latency.slowestToolTrace, {
    toolName: 'checkAvailability',
    toolCallId: 'call_123',
    roundTripMs: 6000,
    vapiWebhookLatencyMs: 441,
    vapiSpeechLatencyMs: 1000,
    vapiWebhookToSpeechGapMs: 541,
    vapiSpeechToToolResultBackfillMs: 5000,
    vapiWebhookToToolResultGapMs: 5541,
    vapiWebhookSuccess: true,
    vapiWebhookHasRetries: false
  });
});

test('live autoeval report renders decomposed tool latency attribution and enrichment coverage', () => {
  const report = renderSuiteReport({
    suite_run_id: 'staging-vapi-live-autoeval-20260405T120000Z',
    environment: 'staging',
    assistant_id: 'assistant_123',
    started_at: '2026-04-05T12:00:00Z',
    completed_at: '2026-04-05T12:05:00Z',
    call_count: 1,
    review_required_count: 1,
    pass_count: 0,
    policy_path: 'configs/vapi/autoevaluation-policy.v1.json',
    average_scorecards: [],
    reason_counts: [],
    coverage_warning_counts: [],
    latency_summary: {
      average_max_model_latency_ms: 514,
      average_max_transcriber_latency_ms: 0,
      average_max_endpointing_latency_ms: 1001,
      average_max_tool_round_trip_latency_ms: 21159,
      average_max_tool_vapi_webhook_latency_ms: 441,
      average_max_tool_vapi_speech_latency_ms: 2283,
      average_max_tool_vapi_webhook_to_speech_gap_ms: 1542,
      average_max_tool_vapi_speech_to_tool_result_backfill_ms: 3999,
      average_max_tool_vapi_webhook_to_result_gap_ms: 5541,
      average_max_tool_dispatch_gap_ms: 1041,
      average_max_tool_to_edge_start_gap_ms: 284,
      average_max_tool_backend_workflow_latency_ms: 652,
      average_max_tool_backend_external_latency_ms: 410,
      average_max_tool_backend_internal_latency_ms: 242,
      average_max_tool_edge_duration_ms: 8326,
      average_max_tool_edge_upstream_duration_ms: 649,
      average_max_tool_edge_upstream_latency_ms: 187,
      average_max_tool_edge_ingress_gap_ms: 757,
      average_max_tool_edge_observed_gap_ms: 7674,
      average_max_tool_edge_egress_gap_ms: 6917,
      average_max_tool_return_gap_ms: 19466,
      average_max_tool_edge_to_result_gap_ms: 12549,
      average_max_tool_platform_gap_ms: 20507,
      dominant_latency_stage_counts: [
        { stage: 'tool_edge_to_result_gap', count: 1 }
      ]
    },
    latency_enrichment: {
      enabled: true,
      source: 'n8n_event_log',
      matched_trace_count: 1,
      total_trace_count: 1,
      unmatched_trace_count: 0,
      execution_count: 1,
      warning: null
    },
    vapi_transport_enrichment: {
      enabled: true,
      source: 'vapi_artifact_log',
      matched_trace_count: 1,
      total_trace_count: 1,
      unmatched_trace_count: 0,
      transport_entry_count: 1,
      matched_speech_trace_count: 1,
      total_speech_trace_count: 1,
      speech_entry_count: 2,
      warning: null
    },
    edge_latency_enrichment: {
      enabled: true,
      source: 'caddy_access_log',
      matched_trace_count: 1,
      total_trace_count: 1,
      unmatched_trace_count: 0,
      access_entry_count: 1,
      warning: null
    },
    calls: [
      {
        call_id: 'call_123',
        ended_at: '2026-04-05T10:56:03Z',
        run_path: 'autonomy/runs/generated/vapi-live-autoeval/example.run.v1.json',
        raw_call_path: null,
        failure_category: 'other',
        severity: 'medium',
        requires_review: true,
        summary: 'Synthetic latency attribution example.',
        scorecards: [],
        latency_diagnostics: {
          maxModelLatencyMs: 514,
          maxTranscriberLatencyMs: 0,
          maxEndpointingLatencyMs: 1001,
          maxToolRoundTripLatencyMs: 21159,
          maxToolVapiWebhookLatencyMs: 441,
          maxToolVapiSpeechLatencyMs: 2283,
          maxToolVapiWebhookToSpeechGapMs: 1542,
          maxToolVapiSpeechToToolResultBackfillMs: 3999,
          maxToolVapiWebhookToToolResultGapMs: 5541,
          maxToolDispatchGapMs: 1041,
          maxToolToEdgeStartGapMs: 284,
          maxToolBackendWorkflowLatencyMs: 652,
          maxToolBackendExternalLatencyMs: 410,
          maxToolBackendInternalLatencyMs: 242,
          maxToolEdgeDurationMs: 8326,
          maxToolEdgeUpstreamDurationMs: 649,
          maxToolEdgeUpstreamLatencyMs: 187,
          maxToolEdgeIngressGapMs: 757,
          maxToolEdgeObservedGapMs: 7674,
          maxToolEdgeEgressGapMs: 6917,
          maxToolReturnGapMs: 19466,
          maxToolEdgeToToolResultGapMs: 12549,
          maxToolPlatformGapMs: 20507,
          dominantLatencyStage: 'tool_vapi_webhook_to_speech_gap',
          slowTurnCount: 0,
          slowestToolTrace: {
            toolName: 'checkAvailability',
            roundTripMs: 21159,
            vapiWebhookLatencyMs: 441,
            vapiSpeechLatencyMs: 2283,
            vapiWebhookToSpeechGapMs: 1542,
            vapiSpeechToToolResultBackfillMs: 3999,
            vapiWebhookToToolResultGapMs: 5541,
            vapiWebhookSuccess: false,
            vapiWebhookHasRetries: false,
            dispatchGapMs: 1041,
            toolToEdgeStartGapMs: 284,
            backendWorkflowLatencyMs: 652,
            backendExternalLatencyMs: 410,
            backendInternalLatencyMs: 242,
            edgeDurationMs: 8326,
            edgeUpstreamDurationMs: 649,
            edgeUpstreamLatencyMs: 187,
            edgeIngressGapMs: 757,
            edgeObservedGapMs: 7674,
            edgeEgressGapMs: 6917,
            returnGapMs: 19466,
            edgeToToolResultGapMs: 12549,
            platformGapMs: 20507,
            edgeStatus: 200,
            executionId: '2583'
          }
        },
        coverage_warnings: [],
        reasons: []
      }
    ]
  });

  assert.match(report, /Average max tool dispatch gap: 1041ms/);
  assert.match(report, /Average max Vapi webhook request latency: 441ms/);
  assert.match(report, /Average max tool-to-speech latency: 2283ms/);
  assert.match(report, /Average max Vapi webhook-to-speech gap: 1542ms/);
  assert.match(report, /Average max Vapi speech-to-tool-result backfill gap: 3999ms/);
  assert.match(report, /Average max Vapi webhook-to-result gap: 5541ms/);
  assert.match(report, /Average max tool-to-edge start gap: 284ms/);
  assert.match(report, /Average max tool backend workflow latency: 652ms/);
  assert.match(report, /Average max edge request duration: 8326ms/);
  assert.match(report, /Average max edge upstream duration: 649ms/);
  assert.match(report, /Average max edge ingress gap: 757ms/);
  assert.match(report, /Average max edge observed gap: 7674ms/);
  assert.match(report, /Average max edge-to-result gap: 12549ms/);
  assert.match(report, /Average max tool return gap: 19466ms/);
  assert.match(report, /Average max tool platform gap: 20507ms/);
  assert.match(report, /Vapi transport enrichment: matched 1 of 1 tool traces across 1 artifact webhook entries\./);
  assert.match(report, /Vapi speech enrichment: matched 1 of 1 tool traces across 2 assistant voice events\./);
  assert.match(report, /Edge latency enrichment: matched 1 of 1 tool traces across 1 Caddy access entries\./);
  assert.match(report, /N8N latency enrichment: matched 1 of 1 tool traces across 1 executions\./);
  assert.match(
    report,
    /Slowest tool trace: checkAvailability round_trip=21159ms, vapi_webhook=441ms, tool_speech=2283ms, vapi_webhook_to_speech=1542ms, speech_to_result_backfill=3999ms, vapi_webhook_to_result=5541ms, dispatch=1041ms, to_edge=284ms, backend=652ms \(external=410ms, internal=242ms\), edge=8326ms \(upstream=649ms, header=187ms\), edge_ingress=757ms, edge_observed=7674ms, edge_egress=6917ms, return=19466ms, edge_to_result=12549ms, platform=20507ms, edge_status=200, vapi_webhook_success=false, vapi_webhook_retries=false, execution=2583/
  );
});

(async () => {
  await Promise.all(pendingTests);

  if (process.exitCode) {
    process.exit(process.exitCode);
  }

  const laneSummary = Array.from(laneStats.entries())
    .map(([lane, stats]) => `${lane}: run ${stats.run}/${stats.registered}${stats.skipped ? `, skipped ${stats.skipped}` : ''}`)
    .join('; ');
  console.log(
    `Workflow regression checks passed (${testsRun - testsSkipped}/${testsRun} tests run; ${laneSummary}).`
  );
})();
