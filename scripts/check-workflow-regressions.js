#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const workflowsDir = path.join(rootDir, 'n8n', 'workflows');
const assistantConfigPath = path.join(rootDir, 'configs', 'vapi', 'assistant.v1.json');
const structuredOutputSchemaPath = path.join(rootDir, 'docs', 'vapi-structured-output.json');
const {
  evaluateCriterion: evaluateVoiceCriterion,
  selectCompletedRecentCall
} = require(path.join(
  rootDir,
  'scripts',
  'autonomy',
  'run-staging-voice-smoke-suite.js'
));
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

function usage() {
  console.log(`Usage:
  node scripts/check-workflow-regressions.js [options]

Options:
  --include-experimental  Also run quarantined prompt/config/voice checks.
  --help                  Show this help message.
`);
}

function parseArgs(argv) {
  const options = {
    includeExperimental:
      process.env.WORKFLOW_REGRESSION_INCLUDE_EXPERIMENTAL === '1'
      || process.env.WORKFLOW_REGRESSION_INCLUDE_EXPERIMENTAL === 'true'
  };

  for (const arg of argv) {
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--include-experimental') {
      options.includeExperimental = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const enabledLanes = new Set(['contract', 'assistant-invariant']);
if (options.includeExperimental) {
  enabledLanes.add('experimental');
}

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

function loadStructuredOutputSchema() {
  return loadJson(structuredOutputSchemaPath);
}

function loadStagingScenario(filename) {
  return loadJson(path.join(rootDir, 'autonomy', 'scenarios', 'staging', filename));
}

function loadStagingVoiceScenario(filename) {
  return loadJson(path.join(rootDir, 'autonomy', 'scenarios', 'staging-voice', filename));
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
    throw new Error('Assistant system prompt not found in configs/vapi/assistant.v1.json');
  }
  return prompt;
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

function experimentalTest(name, fn) {
  test(name, fn, { lane: 'experimental' });
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
  assert.ok(new Date(result.windowEnd) > new Date(result.windowStart));
  assert.ok(['2026-03-20', '2026-03-23'].includes(result.windowStart.slice(0, 10)));
  assert.ok(['2026-03-23', '2026-03-24'].includes(result.windowEnd.slice(0, 10)));
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
  const checkAvailabilityParams = getNodeParameters('tool_check-availability.json', 'Get Busy Events');
  assert.equal(checkAvailabilityParams.timeMin, '={{ $json.windowStart }}');
  assert.equal(checkAvailabilityParams.timeMax, '={{ $json.windowEnd }}');
  assert.equal(checkAvailabilityParams.start, undefined);
  assert.equal(checkAvailabilityParams.end, undefined);

  const createEventParams = getNodeParameters('tool_create-event.json', 'Re-check Busy Events');
  assert.equal(createEventParams.timeMin, '={{ $json.slotStart }}');
  assert.equal(createEventParams.timeMax, '={{ $json.slotEnd }}');
  assert.equal(createEventParams.start, undefined);
  assert.equal(createEventParams.end, undefined);
});

test('checkAvailability returns only weekday slots inside clinic hours', () => {
  const parseResult = {
    requestId: 'req_weekday_only',
    toolCallId: null,
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    requestedDate: '2026-03-21',
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

test('checkAvailability prefers slots adjacent to existing appointments and splits earlier/later offers', () => {
  const parseResult = {
    requestId: 'req_gapless',
    toolCallId: null,
    calendarId: 'primary',
    timezone: 'Europe/Warsaw',
    service: { id: 'consultation' },
    requestedDate: '2026-03-16',
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
    ['2026-03-16T13:15:00+01:00', '2026-03-16T14:45:00+01:00']
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

test('createEvent preserves explicit slotEnd when provided', () => {
  const result = runParse(
    'tool_create-event.json',
    'Parse Request',
    {
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
      recipientPhoneE164: '+48500111001',
      delivery: {
        status: 'simulated',
        provider: 'mock',
        recipientCount: 1,
        providerMessageId: null
      },
      sms: {
        kind: 'booking_confirmation',
        language: 'pl',
        body: 'ipokrzyku.pl: potwierdzenie wizyty dla Anna Kowalska.'
      },
      message: 'Potwierdzenie SMS po rezerwacji zostalo przygotowane.'
    }
  })[0].json;
  const bookedResult = formatResult.results?.[0]?.result || formatResult;
  assert.deepEqual(bookedResult.phoneContext, {
    declaredPhoneE164: '+48500111001',
    callerPhoneE164: '+48500111001',
    callerPhoneSource: 'customer.number',
    callerMatchesDeclaredPhone: true,
    smsRecipientPhoneE164: '+48500111001'
  });
  assert.deepEqual(bookedResult.bookingConfirmationSms, {
    accepted: true,
    recipientPhoneE164: '+48500111001',
    delivery: {
      status: 'simulated',
      provider: 'mock',
      recipientCount: 1,
      providerMessageId: null
    },
    sms: {
      kind: 'booking_confirmation',
      language: 'pl',
      body: 'ipokrzyku.pl: potwierdzenie wizyty dla Anna Kowalska.'
    },
    message: 'Potwierdzenie SMS po rezerwacji zostalo przygotowane.',
    error: null
  });
});

test('createEvent calendar description includes callback and caller phone context', () => {
  const params = getNodeParameters('tool_create-event.json', 'Create Calendar Event');
  const description = params.additionalFields?.description || '';

  assert.match(description, /Callback phone:/);
  assert.match(description, /Caller phone:/);
  assert.match(description, /Booking SMS target:/);
  assert.match(description, /caller number (matches|differs)/i);
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
  assert.deepEqual(prepared.phoneContext, {
    declaredPhoneE164: '+48500999888',
    callerPhoneE164: '+48500111001',
    callerPhoneSource: 'customer.number',
    callerMatchesDeclaredPhone: false,
    smsRecipientPhoneE164: '+48500111001'
  });
  assert.match(prepared.messageBody, /Ipokrzyku\.pl: Appointment confirmed/i);
  assert.match(prepared.messageBody, /24 March 2026, 10:00/);

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
    declaredPhoneE164: '+48500999888',
    callerPhoneE164: '+48500111001',
    callerPhoneSource: 'customer.number',
    callerMatchesDeclaredPhone: false,
    recipientPhoneE164: '+48500111001'
  });
});

test('createReceptionTask rejects unknown taskType', () => {
  const result = runParse(
    'tool_create-reception-task.json',
    'Parse Request',
    {
      taskType: 'whatever_vapi_invents',
      patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' },
      summary: 'Call back requested'
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
              summary: 'Pacjentka chce umowic kolejna wizyte.'
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

test('sendSmsToReceptionists requires createReceptionTask taskId', () => {
  const result = runParse(
    'tool_send-sms-to-receptionists.json',
    'Parse Request',
    {
      taskType: 'existing_patient_booking',
      patient: { fullName: 'Anna Kowalska', phoneE164: '+48500111001' },
      summary: 'Pacjentka chce umowic kolejna wizyte.'
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
      summary: 'Pacjentka chce umowic kolejna wizyte.',
      preferredCallbackWindow: 'rano',
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
  assert.match(prepared.messageBody, /deklarowany \+48500111001/);
  assert.match(prepared.messageBody, /numer dzwoniacego \+48700123000/);
  assert.match(prepared.messageBody, /rozne - zweryfikowac, ktory numer wykorzystac/);
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
      patient: { fullName: 'Jan Testowy', phoneE164: '+48500100200' },
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

  assert.equal(prepared.kind, 'booking_confirmation');
  assert.equal(prepared.recipientPhoneE164, '+48500100200');
  assert.deepEqual(prepared.recipients, ['+48500100200']);
  assert.match(prepared.messageBody, /Ipokrzyku\.pl: Appointment confirmed/i);
  assert.match(prepared.messageBody, /20 March 2026, 10:30/);
});

test('sendSmsToPatient prepares the branded Polish booking confirmation SMS with the full date', () => {
  const parseResult = runParse(
    'tool_send-sms-to-patient.json',
    'Parse Request',
    {
      calendarEventId: 'evt_002',
      consentConfirmed: true,
      language: 'pl',
      patient: { fullName: 'Jan Nowak', phoneE164: '+48500100200' },
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
    'Ipokrzyku.pl: Potwierdzenie wizyty dla Jan Nowak. Konsultacja implantologiczna, środa, 25 marca 2026, 17:00. W razie zmian prosimy o kontakt z recepcją.'
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
                fullName: 'Anna Kowalska',
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
  assert.deepEqual(prepared.phoneContext, {
    declaredPhoneE164: '+48500999888',
    callerPhoneE164: '+48500111001',
    callerPhoneSource: 'customer.number',
    callerMatchesDeclaredPhone: false,
    smsRecipientPhoneE164: '+48500111001'
  });
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

  assert.deepEqual(dispatch.baseResult?.phoneContext, prepared.phoneContext);
  assert.equal(dispatch.baseResult?.recipientPhoneE164, '+48500111001');
  assert.deepEqual(dispatch.webhookBody?.metadata, {
    requestId: parseResult.requestId,
    calendarEventId: 'evt_001',
    appointmentStart: '2026-03-20T10:30:00+01:00',
    timezone: 'Europe/Warsaw',
    sourceCallId: 'call_sms_001',
    language: 'pl',
    declaredPhoneE164: '+48500999888',
    callerPhoneE164: '+48500111001',
    callerPhoneSource: 'customer.number',
    callerMatchesDeclaredPhone: false,
    recipientPhoneE164: '+48500111001'
  });

  const formatted = executeCode(getNodeCode(loadWorkflow('tool_send-sms-to-patient.json'), 'Format Success'), {
    $json: {
      toolCallId: 'tool_call_sms_001',
      requestId: 'req_sms_001',
      delivery: {
        status: 'queued',
        provider: 'webhook',
        recipientCount: 1,
        providerMessageId: 'msg_001'
      },
      sms: {
        kind: 'booking_confirmation',
        language: 'pl',
        body: prepared.messageBody
      },
      recipientPhoneE164: '+48500111001',
      phoneContext: prepared.phoneContext,
      message: 'Potwierdzenie SMS dla pacjenta zostalo przekazane do wysylki.'
    }
  })[0].json;
  const formattedResult = formatted.results?.[0]?.result || formatted;
  assert.equal(formattedResult.recipientPhoneE164, '+48500111001');
  assert.deepEqual(formattedResult.phoneContext, prepared.phoneContext);
});

test('sendSmsToReceptionists twilio mode requires an explicit sender number', () => {
  const parseResult = runParse(
    'tool_send-sms-to-receptionists.json',
    'Parse Request',
    {
      taskId: 'task_20260320_001',
      taskType: 'existing_patient_booking',
      patient: { fullName: 'Anna Kowalska', phoneE164: '+48500111001' },
      summary: 'Pacjentka chce umowic kolejna wizyte.'
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
      patient: { fullName: 'Anna Kowalska', phoneE164: '+48500111001' },
      summary: 'Pacjentka chce umowic kolejna wizyte.'
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
  assert.match(searchResult.answer, /30 000/);
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

test('searchKnowledgeBase returns individualized pricing guidance for root canal treatment', () => {
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
  assert.match(searchResult.answer, /ustalany indywidualnie/i);
  assert.match(searchResult.answer, /konsultacja/i);
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

experimentalTest('searchKnowledgeBase returns the clinic address for location questions', () => {
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

test('lookupPatient returns only the compact branching payload', () => {
  const workflow = loadWorkflow('tool_lookup-patient.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: { phoneRaw: '500111001' },
    $env: defaultEnv
  })[0].json;
  assert.equal(parseResult.ok, true);

  const lookupResult = executeCode(getNodeCode(workflow, 'Find Patient'), {
    $: makeSelector({ 'Parse Request': parseResult })
  })[0].json;

  assert.deepEqual(
    Object.keys(lookupResult.patient).sort(),
    ['fullName', 'isExistingPatient', 'patientId', 'phoneE164']
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
              booking: {
                bookingCreated: true,
                serviceName: 'Konsultacja'
              },
              timing: {
                selectedSlotStart: '2026-03-24T09:00:00+01:00'
              },
              summary: {
                shortSummaryPl: 'Rezerwacja utworzona.'
              }
            }
          },
          'qa-phone': {
            name: 'QA: Phone Readback Wrong',
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
  assert.ok(parseResult.reviewReasons.includes('Core Call Quality_critical'));

  const workflow = loadWorkflow('webhook_vapi-call-ended-router.json');
  const formatted = executeCode(getNodeCode(workflow, 'Format Booked'), {
    $json: parseResult
  })[0].json;

  assert.equal(formatted.autoevaluation.requiresReview, true);
  assert.equal(formatted.autoevaluation.reviewSeverity, 'high');
  assert.equal(formatted.autoevaluation.scorecards[0].nameCanonical, 'Core Call Quality');
  assert.equal(formatted.autoevaluation.qaSignals.phoneNumberRepeatedIncorrectly, true);
});

test('tool webhooks map validation and auth failures to HTTP status codes', () => {
  assert.equal(
    getResponseCodeOption('tool_check-availability.json', 'Respond Error'),
    "={{ $json.error?.code === 'UNAUTHORIZED' ? 401 : 400 }}"
  );
  assert.equal(
    getResponseCodeOption('tool_create-event.json', 'Respond Validation Error'),
    "={{ $json.error?.code === 'UNAUTHORIZED' ? 401 : 400 }}"
  );
  assert.equal(
    getResponseCodeOption('tool_create-reception-task.json', 'Respond Error'),
    "={{ $json.error?.code === 'UNAUTHORIZED' ? 401 : 400 }}"
  );
  assert.equal(
    getResponseCodeOption('tool_lookup-patient.json', 'Respond Error'),
    "={{ $json.error?.code === 'UNAUTHORIZED' ? 401 : 400 }}"
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
  assert.equal(getResponseCodeOption('tool_create-event.json', 'Respond Conflict'), 409);
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

experimentalTest('assistant prompt keeps the March 18 live-call booking guardrails', () => {
  const config = loadAssistantConfig();
  const systemPrompts = (config.assistant?.model?.messages || [])
    .filter((message) => message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n');
  assert.match(systemPrompts, /Nigdy nie lacz w jednej wypowiedzi dwoch pytan/);
  assert.match(systemPrompts, /Nie wywoluj narzedzi na urwanych fragmentach wypowiedzi/);
  assert.match(systemPrompts, /Jesli imie i nazwisko oraz numer telefonu zostaly juz jasno zebrane wczesniej/);
  assert.match(systemPrompts, /Nie wywoluj createEvent bez wyraznej zgody na finalne podsumowanie rezerwacji/);
  assert.match(systemPrompts, /Nie wymieniaj numeru telefonu/);
  assert.match(systemPrompts, /nie mow potem "prosze chwile poczekac"/i);
  assert.match(systemPrompts, /od poniedzialku do piatku w godzinach 09:00-21:00/i);
  assert.match(systemPrompts, /dwie opcje: jedna rano lub w okolicy poludnia, a druga po poludniu/i);
  assert.match(systemPrompts, /bez luk miedzy wizytami/i);
  assert.match(systemPrompts, /Masz dostep do:\s*- lookupPatient\s*- checkAvailability\s*- searchKnowledgeBase\s*- createEvent\s*- createReceptionTask/i);
  assert.match(systemPrompts, /### sendSmsToReceptionists/i);
  assert.match(systemPrompts, /createReceptionTask juz zwrocil sukces/i);
  assert.match(systemPrompts, /masz taskId z wyniku createReceptionTask/i);
  assert.match(systemPrompts, /to jest narzedzie wewnetrzne/i);
  assert.match(systemPrompts, /ta sciezka dotyczy tylko pierwszej wizyty/i);
  assert.match(systemPrompts, /potwierdzony istniejacy pacjent nie przechodzi do samodzielnej rezerwacji/i);
  assert.match(systemPrompts, /taskType existing_patient_booking/i);
  assert.match(systemPrompts, /Nie zostawiaj w wypowiedzi ani jednej cyfry/i);
  assert.match(systemPrompts, /nie wypowiadaj juz zadnego dodatkowego pytania ani komentarza przed tym wywolaniem/i);
  assert.match(systemPrompts, /wywolaj sendSmsToReceptionists od razu w tej samej sciezce/i);
  assert.match(systemPrompts, /workflow n8n automatycznie probuje wyslac techniczne potwierdzenie SMS/i);
  assert.match(systemPrompts, /Nie pytaj o osobna zgode na ten krok/i);
  assert.match(systemPrompts, /language ustawiaj na `pl` albo `en`/i);
  assert.equal(/sendSmsToPatient/.test(systemPrompts), false);
  assert.equal(/consentToSms/i.test(systemPrompts), false);
  assert.equal(/taskType general_follow_up/i.test(systemPrompts), false);
  assert.equal(/po lunchu \/ po obiedzie -> afternoon/i.test(systemPrompts), false);
});

experimentalTest('assistant prompt anchors createEvent to the exact selected slot boundary', () => {
  const config = loadAssistantConfig();
  const systemPrompts = (config.assistant?.model?.messages || [])
    .filter((message) => message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n');
  assert.match(systemPrompts, /skopiuj slotStart z pola start i slotEnd z pola end wybranego slotu/i);
  assert.match(systemPrompts, /Nie wyliczaj slotEnd z label/i);
  assert.match(systemPrompts, /2026-03-19T09:30:00\+01:00/);
  assert.match(systemPrompts, /2026-03-19T10:15:00\+01:00/);
});

experimentalTest('assistant prompt keeps the baseline spoken-phone and doctor-name guardrails', () => {
  const config = loadAssistantConfig();
  const systemPrompts = (config.assistant?.model?.messages || [])
    .filter((message) => message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n');
  assert.match(systemPrompts, /nazwisko lekarza to Szajnar/i);
  assert.match(systemPrompts, /Numer telefonu czytaj cyfra po cyfrze lub parami/i);
  assert.match(systemPrompts, /nigdy nie rekonstruuj numeru telefonu z pamieci/i);
  assert.match(systemPrompts, /uzyj polskich slow dla kazdej cyfry/i);
  assert.match(systemPrompts, /\{\{\s*customer\.number\s*\}\}/);
  assert.match(systemPrompts, /system zna numer dzwoniacego/i);
  assert.match(systemPrompts, /nie czytaj tego numeru na glos cyfra po cyfrze/i);
  assert.match(systemPrompts, /ustaw patient\.phoneE164 dokladnie na \{\{\s*customer\.number\s*\}\}/i);
  assert.match(systemPrompts, /nigdy nie wpisuj numeru przykladowego, testowego ani zastepczego/i);
});

experimentalTest('assistant config keeps the March 18 endpointing profile', () => {
  const config = loadAssistantConfig();
  assert.equal(config.assistant?.transcriber?.provider, 'openai');
  assert.equal(config.assistant?.transcriber?.model, 'gpt-4o-transcribe');
  assert.equal(config.assistant?.transcriber?.language, 'pl');
  assert.equal(config.assistant?.startSpeakingPlan?.waitSeconds, 0.6);
  assert.deepEqual(config.assistant?.startSpeakingPlan?.smartEndpointingPlan, {
    provider: 'vapi'
  });
  assert.equal(config.assistant?.startSpeakingPlan?.customEndpointingRules, undefined);
  assert.equal(config.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onPunctuationSeconds, 0.5);
  assert.equal(config.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onNoPunctuationSeconds, 3);
  assert.equal(config.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onNumberSeconds, 1.5);
  assert.equal(config.assistant?.stopSpeakingPlan?.backoffSeconds, 1.2);
});

experimentalTest('assistant config keeps the March 18 voice model and temperature', () => {
  const config = loadAssistantConfig();
  assert.equal(config.assistant?.voice?.model, 'eleven_turbo_v2_5');
  assert.equal(config.assistant?.voice?.chunkPlan?.enabled, true);
  assert.equal(config.assistant?.model?.temperature, 0.2);
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

test('assistant renderer applies staging assistant overrides without changing the shared config', () => {
  const shared = loadAssistantConfig();
  const rendered = renderAssistantConfig('staging', {
    STAGING_N8N_PUBLIC_BASE_URL: 'https://staging.example.test',
    STAGING_AI_RECEPTIONIST_WEBHOOK_SECRET: 'stage-secret'
  });

  assert.equal(shared.assistant?.transcriber?.provider, 'openai');
  assert.equal(shared.assistant?.transcriber?.model, 'gpt-4o-transcribe');
  assert.equal(rendered.assistant?.transcriber?.provider, '11labs');
  assert.equal(rendered.assistant?.transcriber?.model, 'scribe_v2');
  assert.equal(rendered.assistant?.transcriber?.language, 'pl');
  assert.equal(rendered.assistant?.startSpeakingPlan?.waitSeconds, 0.4);
  assert.equal(rendered.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onPunctuationSeconds, 0.5);
  assert.equal(rendered.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onNoPunctuationSeconds, 1.4);
  assert.equal(rendered.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onNumberSeconds, 1);
  assert.equal(rendered.assistant?.startSpeakingPlan?.smartEndpointingPlan?.provider, 'vapi');
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

  assert.deepEqual(getScenarioCriterion(scenario, 'reception-task-created-on-confirmation-turn').rule, {
    type: 'turn_tool_called',
    turn: 2,
    tool_name: 'createReceptionTask'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'internal-sms-called-on-confirmation-turn').rule, {
    type: 'turn_tool_called',
    turn: 2,
    tool_name: 'sendSmsToReceptionists'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-second-reception-task-on-meta-question').rule, {
    type: 'turn_tool_not_called',
    turn: 3,
    tool_name: 'createReceptionTask'
  });
  assert.deepEqual(getScenarioCriterion(scenario, 'no-second-internal-sms-on-meta-question').rule, {
    type: 'turn_tool_not_called',
    turn: 3,
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

  assert.deepEqual(getScenarioCriterion(existingPatientBookingScenario, 'internal-sms-workflow-accepted').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'sendSmsToReceptionists',
    path: 'accepted',
    equals: true
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
          recipientPhoneE164: '+48500111001',
          delivery: {
            recipientCount: 1
          },
          sms: {
            kind: 'booking_confirmation',
            language: 'pl'
          }
        },
        phoneContext: {
          smsRecipientPhoneE164: '+48500111001'
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
  assert.match(result.failure_reason || '', /exact selected slot boundaries/);
});

experimentalTest('voice smoke recent-call selection prefers the current scenario call', () => {
  const selected = selectCompletedRecentCall({
    calls: [
      {
        id: 'older-call',
        assistantId: 'assistant_staging',
        status: 'ended',
        startedAt: '2026-03-20T19:01:48.313Z'
      },
      {
        id: 'current-call',
        assistantId: 'assistant_staging',
        status: 'ended',
        startedAt: '2026-03-20T19:02:40.973Z'
      }
    ],
    assistantId: 'assistant_staging',
    scenarioStartedAt: '2026-03-20T19:02:39.832Z',
    preferredCallId: 'missing-call'
  });

  assert.equal(selected?.id, 'current-call');
});

experimentalTest('voice smoke evaluator supports numeric call-path latency ceilings', () => {
  const passing = evaluateVoiceCriterion({
    criterion_id: 'endpointing-latency-budget',
    description: 'Average endpointing latency should stay under one second.',
    severity: 'high',
    rule: {
      type: 'call_path_lte',
      path: 'artifact.performanceMetrics.endpointingLatencyAverage',
      lte: 900
    }
  }, {
    callArtifact: {
      artifact: {
        performanceMetrics: {
          endpointingLatencyAverage: 820
        }
      }
    },
    normalizedRun: null,
    toolTrace: [],
    structuredOutput: { found: false, result: {} },
    eventTrace: [],
    scenarioStepTimings: {}
  });
  assert.equal(passing.passed, true);

  const failing = evaluateVoiceCriterion({
    criterion_id: 'endpointing-latency-budget',
    description: 'Average endpointing latency should stay under one second.',
    severity: 'high',
    rule: {
      type: 'call_path_lte',
      path: 'artifact.performanceMetrics.endpointingLatencyAverage',
      lte: 900
    }
  }, {
    callArtifact: {
      artifact: {
        performanceMetrics: {
          endpointingLatencyAverage: 1200
        }
      }
    },
    normalizedRun: null,
    toolTrace: [],
    structuredOutput: { found: false, result: {} },
    eventTrace: [],
    scenarioStepTimings: {}
  });
  assert.equal(failing.passed, false);
});

experimentalTest('implant booking voice scenario now guards phone readback quality and latency', () => {
  const scenario = loadStagingVoiceScenario('implant-inquiry-to-booking-voice.v1.json');
  const criteria = new Map(scenario.rubric.map((criterion) => [criterion.criterion_id, criterion]));

  assert.deepEqual(
    criteria.get('phone-readback-uses-spoken-digits')?.rule,
    {
      type: 'tool_arg_equals',
      tool_name: 'createEvent',
      occurrence: 'last',
      path: 'patient.phoneE164',
      equals: '+48604123456'
    }
  );
  assert.deepEqual(
    criteria.get('phone-quality-flag-clear')?.rule,
    {
      type: 'structured_output_path_equals',
      path: 'qualityFlags.phoneNumberRepeatedIncorrectly',
      equals: false
    }
  );
  assert.deepEqual(
    criteria.get('endpointing-latency-budget')?.rule,
    {
      type: 'call_path_lte',
      path: 'artifact.performanceMetrics.endpointingLatencyAverage',
      lte: 900
    }
  );
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
      'toolCalledOnIncompleteAnswer'
    ]
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
  const experimentalNote = enabledLanes.has('experimental')
    ? 'including experimental lane'
    : 'experimental lane skipped';
  console.log(
    `Workflow regression checks passed (${testsRun - testsSkipped}/${testsRun} tests run, ${experimentalNote}; ${laneSummary}).`
  );
})();
