#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const workflowsDir = path.join(rootDir, 'n8n', 'workflows');

function loadWorkflow(filename) {
  return JSON.parse(fs.readFileSync(path.join(workflowsDir, filename), 'utf8'));
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
  DEFAULT_APPOINTMENT_DURATION_MINUTES: '30',
  DEFAULT_SLOT_INCREMENT_MINUTES: '30',
  DEFAULT_SLOT_SEARCH_LIMIT: '3',
  CLINIC_WORKING_HOURS_START: '08:00',
  CLINIC_WORKING_HOURS_END: '18:00',
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

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`Workflow regression checks passed (${testsRun} tests).`);
