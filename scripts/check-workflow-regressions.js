#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const workflowsDir = path.join(rootDir, 'n8n', 'workflows');
const assistantConfigPath = path.join(rootDir, 'configs', 'vapi', 'assistant.v1.json');
const structuredOutputSchemaPath = path.join(rootDir, 'docs', 'vapi-structured-output.json');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function executeCode(code, globals) {
  const names = Object.keys(globals);
  const values = Object.values(globals);
  return new Function(...names, `return (function(){\n${code}\n})();`)(...values);
}

function makeSelector(nodeResults) {
  return function selectNode(nodeName) {
    if (!(nodeName in nodeResults)) {
      throw new Error(`Unexpected node selector: ${nodeName}`);
    }
    return {
      first() {
        return { json: nodeResults[nodeName] };
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
  const workflow = loadWorkflow(workflowFilename);
  const code = getNodeCode(workflow, nodeName);
  return executeCode(code, {
    $: makeSelector(selectorNodes),
    $input: makeInput(inputItems),
    $env: env
  })[0].json;
}

function getResponseCodeOption(workflowFilename, nodeName) {
  const workflow = loadWorkflow(workflowFilename);
  const node = getNode(workflow, nodeName);
  return node.parameters?.options?.responseCode ?? null;
}

let testsRun = 0;

function test(name, fn) {
  testsRun += 1;
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
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
  assert.equal(result.windowStart, '2026-03-20T08:00:00.000Z');
  assert.equal(result.windowEnd, '2026-03-23T20:00:00.000Z');
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

test('searchKnowledgeBase refuses unsupported pricing questions', () => {
  const workflow = loadWorkflow('tool_search-knowledge-base.json');
  const parseResult = executeCode(getNodeCode(workflow, 'Parse Request'), {
    $json: {
      query: 'Ile kosztuje konsultacja?',
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
});

test('createEvent maps slot conflicts to HTTP 409', () => {
  assert.equal(getResponseCodeOption('tool_create-event.json', 'Respond Conflict'), 409);
});

test('call-ended router maps invalid events to HTTP 400 and unauthorized calls to 401', () => {
  assert.equal(
    getResponseCodeOption('webhook_vapi-call-ended-router.json', 'Respond Invalid'),
    "={{ $json.reason === 'unauthorized' ? 401 : 400 }}"
  );
});

test('assistant prompt contains the call-quality guardrails from recent real-call regressions', () => {
  const prompt = getAssistantSystemPrompt();
  assert.match(prompt, /Nigdy nie lacz w jednej wypowiedzi dwoch pytan/);
  assert.match(prompt, /Nie wywoluj narzedzi na urwanych fragmentach wypowiedzi/);
  assert.match(prompt, /Jesli imie i nazwisko oraz numer telefonu zostaly juz jasno zebrane wczesniej/);
  assert.match(prompt, /Nie wywoluj createEvent bez wyraznej zgody na finalne podsumowanie rezerwacji/);
  assert.match(prompt, /Nie wymieniaj numeru telefonu/);
  assert.match(prompt, /nie mow potem "prosze chwile poczekac"/i);
  assert.match(prompt, /od poniedzialku do piatku w godzinach 09:00-21:00/i);
  assert.match(prompt, /dwie opcje: jedna rano lub w okolicy poludnia, a druga po poludniu/i);
  assert.match(prompt, /bez luk miedzy wizytami/i);
});

test('assistant prompt anchors createEvent to the exact selected slot boundary', () => {
  const config = loadAssistantConfig();
  const systemPrompts = (config.assistant?.model?.messages || [])
    .filter((message) => message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n');
  assert.match(systemPrompts, /slotStart i slotEnd z wybranego slotu/);
  assert.match(systemPrompts, /Patrz na pola start i end w wybranym slocie/);
  assert.match(systemPrompts, /pierwszy termin/);
  assert.match(systemPrompts, /09:00-09:45/);
  assert.match(systemPrompts, /2026-03-19T09:30:00\+01:00/);
  assert.match(systemPrompts, /2026-03-19T10:15:00\+01:00/);
  assert.match(systemPrompts, /Nigdy nie zamieniaj tego na 10:00/);
});

test('assistant config keeps the post-endpoint wait', () => {
  const config = loadAssistantConfig();
  assert.equal(config.assistant?.startSpeakingPlan?.waitSeconds, 0.6);
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

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`Workflow regression checks passed (${testsRun} tests).`);
