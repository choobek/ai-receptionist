#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const workflowsDir = path.join(rootDir, 'n8n', 'workflows');
const assistantConfigPath = path.join(rootDir, 'configs', 'vapi', 'assistant.v1.json');
const structuredOutputSchemaPath = path.join(rootDir, 'docs', 'vapi-structured-output.json');
const { selectCompletedRecentCall } = require(path.join(
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
const pendingTests = [];

function test(name, fn) {
  testsRun += 1;
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
      preferredCallbackWindow: 'rano'
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
  assert.deepEqual(prepared.recipients, ['+48500100200']);
  assert.match(prepared.messageBody, /appointment confirmed/i);
  assert.match(prepared.messageBody, /Demo Dental Clinic/);
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

test('assistant prompt contains the call-quality guardrails from recent real-call regressions', () => {
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
  assert.match(systemPrompts, /po lunchu \/ po obiedzie -> afternoon/i);
  assert.match(systemPrompts, /ustaw requestedDate na najwczesniejszy pasujacy otwarty dzien i searchDays/i);
  assert.match(systemPrompts, /mimo szumu slyszysz kluczowe slowa pytania ogolnego/i);
  assert.match(systemPrompts, /Jesli w danym srodowisku wlaczone sa narzedzia SMS/);
  assert.match(systemPrompts, /sendSmsToReceptionists/);
  assert.match(systemPrompts, /sendSmsToPatient/);
  assert.match(systemPrompts, /tylko pierwsze wizyty do doktor Magdaleny Szajnar/i);
  assert.match(systemPrompts, /taskType general_follow_up/i);
  assert.match(systemPrompts, /nie proponuj terminow przez checkAvailability/i);
  assert.match(systemPrompts, /Nie pytaj wtedy o preferowany dzien, godzine ani dalsze preferencje terminowe/i);
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
  assert.equal(config.assistant?.transcriber?.provider, 'openai');
  assert.equal(config.assistant?.transcriber?.model, 'gpt-4o-transcribe');
  assert.equal(config.assistant?.transcriber?.language, 'pl');
  assert.equal(config.assistant?.startSpeakingPlan?.waitSeconds, 0.6);
  assert.equal(config.assistant?.startSpeakingPlan?.smartEndpointingPlan, undefined);
  assert.deepEqual(config.assistant?.startSpeakingPlan?.customEndpointingRules, [
    {
      type: 'customer',
      regex: '^[Aa]\\s+co\\s+[Jj]e(?:s|ś)li(?:\\s*[.?!…]+)?\\s*$',
      timeoutSeconds: 3.2
    },
    {
      type: 'customer',
      regex: '^[Ww]hat\\s+[Ii]f(?:\\s*[.?!…]+)?\\s*$',
      timeoutSeconds: 3.2
    }
  ]);
  assert.equal(config.assistant?.startSpeakingPlan?.transcriptionEndpointingPlan?.onNoPunctuationSeconds, 3);
});

test('assistant renderer includes SMS tools in production when bindings are configured', () => {
  const rendered = renderAssistantConfig('production', {
    PRODUCTION_N8N_PUBLIC_BASE_URL: 'https://prod.example.test',
    PRODUCTION_AI_RECEPTIONIST_WEBHOOK_SECRET: 'prod-secret'
  });
  const receptionSmsBinding = rendered.toolBindings.find(
    (binding) => binding.name === 'sendSmsToReceptionists'
  );
  const patientSmsBinding = rendered.toolBindings.find(
    (binding) => binding.name === 'sendSmsToPatient'
  );

  assert.deepEqual(
    rendered.toolBindings.map((binding) => binding.name),
    [
      'lookupPatient',
      'checkAvailability',
      'searchKnowledgeBase',
      'createEvent',
      'createReceptionTask',
      'sendSmsToReceptionists',
      'sendSmsToPatient'
    ]
  );
  assert.equal(rendered.assistant?.model?.toolIds?.length, 7);
  assert.ok(receptionSmsBinding?.serverUrl?.includes('/send-sms-to-receptionists?secret='));
  assert.ok(patientSmsBinding?.serverUrl?.includes('/send-sms-to-patient?secret='));
});

test('assistant renderer includes SMS tools in staging when bindings are configured', () => {
  const rendered = renderAssistantConfig('staging', {
    STAGING_N8N_PUBLIC_BASE_URL: 'https://staging.example.test',
    STAGING_AI_RECEPTIONIST_WEBHOOK_SECRET: 'stage-secret'
  });
  const receptionSmsBinding = rendered.toolBindings.find(
    (binding) => binding.name === 'sendSmsToReceptionists'
  );
  const patientSmsBinding = rendered.toolBindings.find(
    (binding) => binding.name === 'sendSmsToPatient'
  );

  assert.deepEqual(
    rendered.toolBindings.map((binding) => binding.name),
    [
      'lookupPatient',
      'checkAvailability',
      'searchKnowledgeBase',
      'createEvent',
      'createReceptionTask',
      'sendSmsToReceptionists',
      'sendSmsToPatient'
    ]
  );
  assert.equal(rendered.assistant?.model?.toolIds?.length, 7);
  assert.ok(receptionSmsBinding?.serverUrl?.includes('/send-sms-to-receptionists?secret='));
  assert.ok(patientSmsBinding?.serverUrl?.includes('/send-sms-to-patient?secret='));
});

test('assistant SMS scenarios resolve required tool bindings against staging and production environments', () => {
  const stagingEnabledBindings = getEnabledToolBindings(loadEnvironmentBindings('staging'));
  const productionEnabledBindings = getEnabledToolBindings(loadEnvironmentBindings('production'));
  const patientSmsScenario = loadStagingScenario('booking-confirmation-sms.v1.json');
  const receptionSmsScenario = loadStagingScenario('reschedule-handoff-internal-sms-alert.v1.json');

  assert.deepEqual(
    getMissingRequiredToolBindings(patientSmsScenario, stagingEnabledBindings),
    []
  );
  assert.deepEqual(
    getMissingRequiredToolBindings(receptionSmsScenario, stagingEnabledBindings),
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
});

test('specialist handoff scenario routes other specialists into general follow-up without scheduling', () => {
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

test('staging chat runner resolves scenario template fallbacks and explicit overrides', () => {
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

test('assistant SMS staging scenarios require end-to-end workflow result checks', () => {
  const patientSmsScenario = loadStagingScenario('booking-confirmation-sms.v1.json');
  const receptionSmsScenario = loadStagingScenario('reschedule-handoff-internal-sms-alert.v1.json');

  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'patient-sms-workflow-accepted').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'sendSmsToPatient',
    path: 'accepted',
    equals: true
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'patient-sms-targets-single-recipient').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'sendSmsToPatient',
    path: 'delivery.recipientCount',
    equals: 1
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'patient-sms-produces-booking-confirmation-payload').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'sendSmsToPatient',
    path: 'sms.kind',
    equals: 'booking_confirmation'
  });
  assert.deepEqual(getScenarioCriterion(patientSmsScenario, 'patient-sms-result-keeps-polish-language').rule, {
    type: 'tool_result_path_equals',
    tool_name: 'sendSmsToPatient',
    path: 'sms.language',
    equals: 'pl'
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

test('assistant chat rubric can verify patient SMS ordering and calendarEventId reuse', () => {
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
        calendarEventId: 'evt_sms_patient_001'
      }
    },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool_send_sms_patient_1',
          function: {
            name: 'sendSmsToPatient',
            arguments: JSON.stringify({
              calendarEventId: 'evt_sms_patient_001',
              consentConfirmed: true,
              language: 'pl'
            })
          }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'tool_send_sms_patient_1',
      content: {
        accepted: true,
        delivery: {
          recipientCount: 1
        },
        sms: {
          kind: 'booking_confirmation',
          language: 'pl'
        }
      }
    }
  ]);

  const orderingResult = evaluateChatCriterion(context, {
    criterion_id: 'sms-after-booking',
    description: 'sendSmsToPatient should happen after createEvent returned',
    severity: 'critical',
    rule: {
      type: 'tool_called_after_tool_result',
      tool_name: 'sendSmsToPatient',
      source_tool_name: 'createEvent'
    }
  });
  assert.equal(orderingResult.passed, true);

  const idReuseResult = evaluateChatCriterion(context, {
    criterion_id: 'sms-reuses-event-id',
    description: 'sendSmsToPatient should reuse calendarEventId from createEvent',
    severity: 'critical',
    rule: {
      type: 'tool_arg_matches_tool_result_path',
      tool_name: 'sendSmsToPatient',
      path: 'calendarEventId',
      source_tool_name: 'createEvent',
      source_path: 'calendarEventId'
    }
  });
  assert.equal(idReuseResult.passed, true);

  const acceptedResult = evaluateChatCriterion(context, {
    criterion_id: 'sms-accepted',
    description: 'sendSmsToPatient should return accepted=true',
    severity: 'critical',
    rule: {
      type: 'tool_result_path_equals',
      tool_name: 'sendSmsToPatient',
      path: 'accepted',
      equals: true
    }
  });
  assert.equal(acceptedResult.passed, true);

  const recipientCountResult = evaluateChatCriterion(context, {
    criterion_id: 'sms-recipient-count',
    description: 'sendSmsToPatient should target one recipient',
    severity: 'high',
    rule: {
      type: 'tool_result_path_equals',
      tool_name: 'sendSmsToPatient',
      path: 'delivery.recipientCount',
      equals: 1
    }
  });
  assert.equal(recipientCountResult.passed, true);

  const payloadKindResult = evaluateChatCriterion(context, {
    criterion_id: 'sms-kind',
    description: 'sendSmsToPatient should return booking_confirmation payload metadata',
    severity: 'high',
    rule: {
      type: 'tool_result_path_equals',
      tool_name: 'sendSmsToPatient',
      path: 'sms.kind',
      equals: 'booking_confirmation'
    }
  });
  assert.equal(payloadKindResult.passed, true);
});

test('assistant chat rubric rejects patient SMS calls that happen before createEvent returns', () => {
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
          id: 'tool_send_sms_patient_early',
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

  const orderingResult = evaluateChatCriterion(context, {
    criterion_id: 'sms-before-booking',
    description: 'sendSmsToPatient should not happen before createEvent returned',
    severity: 'critical',
    rule: {
      type: 'tool_called_after_tool_result',
      tool_name: 'sendSmsToPatient',
      source_tool_name: 'createEvent'
    }
  });
  assert.equal(orderingResult.passed, false);
  assert.match(orderingResult.failure_reason || '', /after the createEvent result/);
});

test('assistant chat rubric can verify internal receptionist SMS ordering and taskId reuse', () => {
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

test('voice smoke recent-call selection prefers the current scenario call', () => {
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

  console.log(`Workflow regression checks passed (${testsRun} tests).`);
})();
