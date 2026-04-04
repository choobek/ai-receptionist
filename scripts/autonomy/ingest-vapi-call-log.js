#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function usage() {
  console.log(`Usage:
  node scripts/autonomy/ingest-vapi-call-log.js --input <path> [options]

Options:
  --output <path>         Write one normalized run to this file.
  --output-dir <path>     Write normalized runs into this directory.
  --call-id <id>          Select one call from a Vapi export array.
  --index <n>             Select one call from a Vapi export array by zero-based index.
  --all                   Ingest every call from a Vapi export array.
  --scenario-id <id>      Attach a scenario id to the normalized run(s).
  --environment <name>    Attach an environment label, for example staging.
  --run-kind <kind>       real_call | synthetic_test | manual_review. Default: real_call.
  --help                  Show this help message.
`);
}

function parseArgs(argv) {
  const options = {
    input: null,
    output: null,
    outputDir: null,
    callId: null,
    index: null,
    all: false,
    scenarioId: null,
    environment: 'unknown',
    runKind: 'real_call'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next) {
      throw new Error(`Missing value for ${arg}`);
    }
    switch (arg) {
      case '--input':
        options.input = next;
        i += 1;
        break;
      case '--output':
        options.output = next;
        i += 1;
        break;
      case '--output-dir':
        options.outputDir = next;
        i += 1;
        break;
      case '--call-id':
        options.callId = next;
        i += 1;
        break;
      case '--index':
        options.index = Number.parseInt(next, 10);
        if (!Number.isInteger(options.index) || options.index < 0) {
          throw new Error('--index must be a non-negative integer');
        }
        i += 1;
        break;
      case '--scenario-id':
        options.scenarioId = next;
        i += 1;
        break;
      case '--environment':
        options.environment = next;
        i += 1;
        break;
      case '--run-kind':
        options.runKind = next;
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.input) {
    throw new Error('--input is required');
  }

  if (!['real_call', 'synthetic_test', 'manual_review'].includes(options.runKind)) {
    throw new Error('--run-kind must be real_call, synthetic_test, or manual_review');
  }

  if (options.all && !options.outputDir) {
    throw new Error('--all requires --output-dir');
  }

  if (options.output && options.outputDir) {
    throw new Error('Use either --output or --output-dir, not both');
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function stableNowIso() {
  return new Date().toISOString();
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') {
    return safeObject(value) || null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return safeObject(parsed) || null;
  } catch {
    return null;
  }
}

function detectJsonType(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function copyIfPresent(target, source, key, predicate = null) {
  const value = source?.[key];
  if (value === null || value === undefined) {
    return;
  }
  if (typeof predicate === 'function' && !predicate(value)) {
    return;
  }
  target[key] = value;
}

function finalizeSanitizedObject(value) {
  return safeObject(value) && Object.keys(value).length > 0 ? value : null;
}

function sanitizeErrorSummary(error) {
  const source = safeObject(error);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'code', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'status', (value) => typeof value === 'number' && Number.isFinite(value));
  copyIfPresent(sanitized, source, 'type', (value) => typeof value === 'string');
  return finalizeSanitizedObject(sanitized);
}

function sanitizeDeliverySummary(delivery) {
  const source = safeObject(delivery);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'status', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'provider', (value) => typeof value === 'string');
  copyIfPresent(
    sanitized,
    source,
    'recipientCount',
    (value) => typeof value === 'number' && Number.isFinite(value)
  );
  return finalizeSanitizedObject(sanitized);
}

function sanitizeSlotList(slots) {
  const sanitized = safeArray(slots)
    .map((slot) => {
      const source = safeObject(slot);
      if (!source) {
        return null;
      }
      const item = {};
      copyIfPresent(item, source, 'start', (value) => typeof value === 'string');
      copyIfPresent(item, source, 'end', (value) => typeof value === 'string');
      return finalizeSanitizedObject(item);
    })
    .filter(Boolean);

  return sanitized.length > 0 ? sanitized : null;
}

function sanitizeNormalizedAvailabilityRequest(request) {
  const source = safeObject(request);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'serviceId', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'requestedDate', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'requestedTime', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'timePreference', (value) => typeof value === 'string');
  return finalizeSanitizedObject(sanitized);
}

function sanitizeAppointmentSummary(appointment) {
  const source = safeObject(appointment);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'start', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'end', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'timezone', (value) => typeof value === 'string');

  const service = safeObject(source.service);
  if (service) {
    const sanitizedService = {};
    copyIfPresent(sanitizedService, service, 'id', (value) => typeof value === 'string');
    if (typeof service.durationMinutes === 'number' && Number.isFinite(service.durationMinutes)) {
      sanitizedService.durationMinutes = service.durationMinutes;
    }
    if (Object.keys(sanitizedService).length > 0) {
      sanitized.service = sanitizedService;
    }
  }

  return finalizeSanitizedObject(sanitized);
}

function sanitizeRealCallStructuredOutput(result) {
  const source = safeObject(result);
  if (!source) {
    return source === null ? null : {};
  }

  const sanitized = {};
  copyIfPresent(sanitized, source, 'callOutcome', (value) => typeof value === 'string');
  copyIfPresent(
    sanitized,
    source,
    'successfulForAssistantScope',
    (value) => typeof value === 'boolean'
  );
  copyIfPresent(sanitized, source, 'language', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'caseCategory', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'serviceBucket', (value) => typeof value === 'string');

  const caller = safeObject(source.caller);
  if (caller && typeof caller.isExistingPatient === 'boolean') {
    sanitized.caller = {
      isExistingPatient: caller.isExistingPatient
    };
  }

  const timing = safeObject(source.timing);
  if (timing) {
    const sanitizedTiming = {};
    copyIfPresent(sanitizedTiming, timing, 'requestedDateIso', (value) => typeof value === 'string');
    copyIfPresent(sanitizedTiming, timing, 'timePreference', (value) => typeof value === 'string');
    copyIfPresent(sanitizedTiming, timing, 'selectedSlotStart', (value) => typeof value === 'string');
    copyIfPresent(sanitizedTiming, timing, 'selectedSlotEnd', (value) => typeof value === 'string');
    copyIfPresent(sanitizedTiming, timing, 'timezone', (value) => typeof value === 'string');
    if (Object.keys(sanitizedTiming).length > 0) {
      sanitized.timing = sanitizedTiming;
    }
  }

  const booking = safeObject(source.booking);
  if (booking) {
    const sanitizedBooking = {};
    copyIfPresent(sanitizedBooking, booking, 'availabilityChecked', (value) => typeof value === 'boolean');
    copyIfPresent(
      sanitizedBooking,
      booking,
      'slotOptionsOffered',
      (value) => typeof value === 'number' && Number.isFinite(value)
    );
    copyIfPresent(sanitizedBooking, booking, 'slotSelected', (value) => typeof value === 'boolean');
    copyIfPresent(sanitizedBooking, booking, 'bookingCreated', (value) => typeof value === 'boolean');
    copyIfPresent(sanitizedBooking, booking, 'serviceId', (value) => typeof value === 'string');
    copyIfPresent(sanitizedBooking, booking, 'firstVisit', (value) => typeof value === 'boolean');
    copyIfPresent(
      sanitizedBooking,
      booking,
      'doctorAssignmentConfirmedBySystem',
      (value) => typeof value === 'boolean'
    );
    copyIfPresent(sanitizedBooking, booking, 'firstVisitPriceMentioned', (value) => typeof value === 'boolean');
    if (Object.keys(sanitizedBooking).length > 0) {
      sanitized.booking = sanitizedBooking;
    }
  }

  const riskFlags = safeObject(source.riskFlags);
  if (riskFlags) {
    const sanitizedRiskFlags = {};
    for (const key of [
      'urgentSymptomsMentioned',
      'medicalAdviceRequested',
      'medicalAdviceGiven',
      'cancellationOrRescheduleRequested',
      'toolFailureOccurred',
      'ambiguousDateClarified',
      'callerHungUpBeforeCompletion'
    ]) {
      copyIfPresent(sanitizedRiskFlags, riskFlags, key, (value) => typeof value === 'boolean');
    }
    if (Object.keys(sanitizedRiskFlags).length > 0) {
      sanitized.riskFlags = sanitizedRiskFlags;
    }
  }

  const qualityFlags = safeObject(source.qualityFlags);
  if (qualityFlags) {
    const sanitizedQualityFlags = {};
    for (const key of [
      'repeatedIdentityRequest',
      'multipleQuestionsInSingleTurn',
      'toolCalledOnIncompleteAnswer',
      'explicitBookingConfirmationMissing',
      'phoneNumberRepeatedIncorrectly',
      'unnecessaryHealthDetailRequest',
      'postBookingFlowRestarted'
    ]) {
      copyIfPresent(sanitizedQualityFlags, qualityFlags, key, (value) => typeof value === 'boolean');
    }
    if (Object.keys(sanitizedQualityFlags).length > 0) {
      sanitized.qualityFlags = sanitizedQualityFlags;
    }
  }

  const followUp = safeObject(source.followUp);
  if (followUp) {
    const sanitizedFollowUp = {};
    copyIfPresent(
      sanitizedFollowUp,
      followUp,
      'receptionFollowUpNeeded',
      (value) => typeof value === 'boolean'
    );
    copyIfPresent(sanitizedFollowUp, followUp, 'reason', (value) => typeof value === 'string');
    if (Object.keys(sanitizedFollowUp).length > 0) {
      sanitized.followUp = sanitizedFollowUp;
    }
  }

  return sanitized;
}

function sanitizeSearchKnowledgeBaseArguments(argumentsValue) {
  const source = safeObject(argumentsValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'language', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'limit', (value) => typeof value === 'number' && Number.isFinite(value));
  if (Object.prototype.hasOwnProperty.call(source, 'query')) {
    sanitized.queryRedacted = true;
  }
  return finalizeSanitizedObject(sanitized);
}

function sanitizeSearchKnowledgeBaseResult(resultValue) {
  const source = safeObject(resultValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'found', (value) => typeof value === 'boolean');
  const matches = safeArray(source.matches)
    .map((match) => {
      const item = {};
      copyIfPresent(item, match, 'id', (value) => typeof value === 'string');
      copyIfPresent(item, match, 'title', (value) => typeof value === 'string');
      copyIfPresent(item, match, 'sourceDocument', (value) => typeof value === 'string');
      return finalizeSanitizedObject(item);
    })
    .filter(Boolean);
  if (matches.length > 0) {
    sanitized.matches = matches;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'answer')) {
    sanitized.answerRedacted = true;
  }
  return finalizeSanitizedObject(sanitized);
}

function sanitizeCheckAvailabilityArguments(argumentsValue) {
  const source = safeObject(argumentsValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  const service = safeObject(source.service);
  if (service && typeof service.id === 'string') {
    sanitized.service = { id: service.id };
  }
  copyIfPresent(sanitized, source, 'timezone', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'requestedDate', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'requestedTime', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'timePreference', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'limit', (value) => typeof value === 'number' && Number.isFinite(value));
  copyIfPresent(sanitized, source, 'searchDays', (value) => typeof value === 'number' && Number.isFinite(value));
  return finalizeSanitizedObject(sanitized);
}

function sanitizeCheckAvailabilityResult(resultValue) {
  const source = safeObject(resultValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'available', (value) => typeof value === 'boolean');
  copyIfPresent(sanitized, source, 'timezone', (value) => typeof value === 'string');

  const normalizedRequest = sanitizeNormalizedAvailabilityRequest(source.normalizedRequest);
  if (normalizedRequest) {
    sanitized.normalizedRequest = normalizedRequest;
  }

  const slots = sanitizeSlotList(source.slots);
  if (slots) {
    sanitized.slots = slots;
  }

  return finalizeSanitizedObject(sanitized);
}

function sanitizeCreateEventArguments(argumentsValue) {
  const source = safeObject(argumentsValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'source', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'slotStart', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'slotEnd', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'timezone', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'language', (value) => typeof value === 'string');

  const patient = safeObject(source.patient);
  if (patient && typeof patient.isExistingPatient === 'boolean') {
    sanitized.patient = {
      isExistingPatient: patient.isExistingPatient
    };
  }

  const service = safeObject(source.service);
  if (service) {
    const sanitizedService = {};
    copyIfPresent(sanitizedService, service, 'id', (value) => typeof value === 'string');
    copyIfPresent(
      sanitizedService,
      service,
      'durationMinutes',
      (value) => typeof value === 'number' && Number.isFinite(value)
    );
    if (Object.keys(sanitizedService).length > 0) {
      sanitized.service = sanitizedService;
    }
  }

  return finalizeSanitizedObject(sanitized);
}

function sanitizeBookingConfirmationSummary(resultValue) {
  const source = safeObject(resultValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'accepted', (value) => typeof value === 'boolean');

  const delivery = sanitizeDeliverySummary(source.delivery);
  if (delivery) {
    sanitized.delivery = delivery;
  }

  const error = sanitizeErrorSummary(source.error);
  if (error) {
    sanitized.error = error;
  }

  return finalizeSanitizedObject(sanitized);
}

function sanitizeCreateEventResult(resultValue) {
  const source = safeObject(resultValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'created', (value) => typeof value === 'boolean');
  copyIfPresent(sanitized, source, 'calendarEventId', (value) => typeof value === 'string');

  const appointment = sanitizeAppointmentSummary(source.appointment);
  if (appointment) {
    sanitized.appointment = appointment;
  }

  const bookingConfirmationSms = sanitizeBookingConfirmationSummary(source.bookingConfirmationSms);
  if (bookingConfirmationSms) {
    sanitized.bookingConfirmationSms = bookingConfirmationSms;
  }

  const error = sanitizeErrorSummary(source.error);
  if (error) {
    sanitized.error = error;
  }

  return finalizeSanitizedObject(sanitized);
}

function sanitizeCreateReceptionTaskArguments(argumentsValue) {
  const source = safeObject(argumentsValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'taskType', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'serviceBucket', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'preferredCallbackWindow', (value) => typeof value === 'string');
  return finalizeSanitizedObject(sanitized);
}

function sanitizeTaskSummary(task) {
  const source = safeObject(task);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'taskType', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'serviceBucket', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'preferredCallbackWindow', (value) => typeof value === 'string');
  return finalizeSanitizedObject(sanitized);
}

function sanitizeCreateReceptionTaskResult(resultValue) {
  const source = safeObject(resultValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'accepted', (value) => typeof value === 'boolean');
  copyIfPresent(sanitized, source, 'taskId', (value) => typeof value === 'string');

  const task = sanitizeTaskSummary(source.task);
  if (task) {
    sanitized.task = task;
  }

  const error = sanitizeErrorSummary(source.error);
  if (error) {
    sanitized.error = error;
  }

  return finalizeSanitizedObject(sanitized);
}

function sanitizeReceptionSmsArguments(argumentsValue) {
  const source = safeObject(argumentsValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'taskId', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'taskType', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'serviceBucket', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'preferredCallbackWindow', (value) => typeof value === 'string');
  return finalizeSanitizedObject(sanitized);
}

function sanitizePatientSmsArguments(argumentsValue) {
  const source = safeObject(argumentsValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'calendarEventId', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'consentConfirmed', (value) => typeof value === 'boolean');
  copyIfPresent(sanitized, source, 'language', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'sourceCallId', (value) => typeof value === 'string');

  const appointment = sanitizeAppointmentSummary(source.appointment);
  if (appointment) {
    sanitized.appointment = appointment;
  }

  return finalizeSanitizedObject(sanitized);
}

function sanitizeSmsDispatchResult(resultValue) {
  const source = safeObject(resultValue);
  if (!source) {
    return null;
  }
  const sanitized = {};
  copyIfPresent(sanitized, source, 'accepted', (value) => typeof value === 'boolean');
  copyIfPresent(sanitized, source, 'sent', (value) => typeof value === 'boolean');
  copyIfPresent(sanitized, source, 'taskId', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'kind', (value) => typeof value === 'string');
  copyIfPresent(sanitized, source, 'language', (value) => typeof value === 'string');

  const delivery = sanitizeDeliverySummary(source.delivery);
  if (delivery) {
    sanitized.delivery = delivery;
  }

  const error = sanitizeErrorSummary(source.error);
  if (error) {
    sanitized.error = error;
  }

  return finalizeSanitizedObject(sanitized);
}

function sanitizeRealCallToolPayload(toolName, payload, section) {
  if (payload === null || payload === undefined) {
    return null;
  }

  switch (toolName) {
    case 'searchKnowledgeBase':
      return section === 'arguments'
        ? sanitizeSearchKnowledgeBaseArguments(payload)
        : sanitizeSearchKnowledgeBaseResult(payload);
    case 'checkAvailability':
      return section === 'arguments'
        ? sanitizeCheckAvailabilityArguments(payload)
        : sanitizeCheckAvailabilityResult(payload);
    case 'createEvent':
      return section === 'arguments'
        ? sanitizeCreateEventArguments(payload)
        : sanitizeCreateEventResult(payload);
    case 'createReceptionTask':
      return section === 'arguments'
        ? sanitizeCreateReceptionTaskArguments(payload)
        : sanitizeCreateReceptionTaskResult(payload);
    case 'sendSmsToReceptionists':
      return section === 'arguments'
        ? sanitizeReceptionSmsArguments(payload)
        : sanitizeSmsDispatchResult(payload);
    case 'sendSmsToPatient':
      return section === 'arguments'
        ? sanitizePatientSmsArguments(payload)
        : sanitizeSmsDispatchResult(payload);
    default:
      return null;
  }
}

function sanitizeRealCallConversationMessage(message) {
  const sanitized = {
    ...message,
    text: null,
    arguments: null,
    result: null
  };

  if (sanitized.role === 'tool_call' && typeof sanitized.tool_name === 'string') {
    sanitized.arguments = sanitizeRealCallToolPayload(
      sanitized.tool_name,
      message.arguments,
      'arguments'
    );
  }

  if (sanitized.role === 'tool_result' && typeof sanitized.tool_name === 'string') {
    sanitized.result = sanitizeRealCallToolPayload(
      sanitized.tool_name,
      message.result,
      'result'
    );
  }

  return sanitized;
}

function sanitizeRealCallToolTrace(trace) {
  return {
    ...trace,
    arguments: sanitizeRealCallToolPayload(trace.tool_name, trace.arguments, 'arguments'),
    result: sanitizeRealCallToolPayload(trace.tool_name, trace.result, 'result')
  };
}

function sanitizeRealCallObservabilityResult(resultValue) {
  if (typeof resultValue === 'boolean') {
    return resultValue;
  }
  if (resultValue === null || resultValue === undefined) {
    return null;
  }
  const source = safeObject(resultValue);
  if (source && Object.prototype.hasOwnProperty.call(source, 'callOutcome')) {
    return sanitizeRealCallStructuredOutput(source);
  }
  return null;
}

function pickCallEntries(root) {
  if (Array.isArray(root)) {
    return root.map((record, index) => ({
      wrapper: root,
      record,
      index,
      sourceKind: 'vapi_calls_export'
    }));
  }

  if (safeObject(root?.call)) {
    return [{
      wrapper: root,
      record: root.call,
      index: 0,
      sourceKind: root.type === 'call.ended' ? 'call_ended_webhook' : 'wrapped_call_object'
    }];
  }

  if (safeObject(root?.message?.call)) {
    return [{
      wrapper: root,
      record: root.message.call,
      index: 0,
      sourceKind: 'wrapped_call_object'
    }];
  }

  if (safeObject(root)) {
    return [{
      wrapper: root,
      record: root,
      index: 0,
      sourceKind: 'call_object'
    }];
  }

  throw new Error('Unsupported input JSON shape');
}

function selectEntries(entries, options) {
  if (options.all) {
    return entries;
  }

  if (options.callId) {
    const match = entries.find((entry) => entry.record?.id === options.callId);
    if (!match) {
      throw new Error(`Call id not found: ${options.callId}`);
    }
    return [match];
  }

  if (options.index !== null) {
    const match = entries.find((entry) => entry.index === options.index);
    if (!match) {
      throw new Error(`Call index not found: ${options.index}`);
    }
    return [match];
  }

  if (entries.length === 1) {
    return entries;
  }

  throw new Error('Input contains multiple calls. Use --all, --call-id, or --index.');
}

function normalizeScopedName(name) {
  if (typeof name !== 'string') {
    return null;
  }
  return name.replace(/\s+\[(staging|production)\]$/i, '').trim();
}

function getArtifact(record, wrapper) {
  return (
    safeObject(record?.artifact) ||
    safeObject(wrapper?.artifact) ||
    safeObject(wrapper?.call?.artifact) ||
    safeObject(wrapper?.message?.artifact) ||
    null
  );
}

function getStructuredOutputs(record, wrapper) {
  return safeObject(getArtifact(record, wrapper)?.structuredOutputs) || {};
}

function getScorecards(record, wrapper) {
  return safeObject(getArtifact(record, wrapper)?.scorecards) || {};
}

function normalizeStructuredOutputs(record, wrapper) {
  return Object.entries(getStructuredOutputs(record, wrapper))
    .map(([outputId, output]) => ({
      output_id: outputId,
      output_name: typeof output?.name === 'string' ? output.name : null,
      output_name_canonical: normalizeScopedName(output?.name),
      result_type: detectJsonType(output?.result ?? null),
      result: output?.result ?? null
    }))
    .sort((left, right) => {
      const leftName = left.output_name || left.output_id;
      const rightName = right.output_name || right.output_id;
      return leftName.localeCompare(rightName);
    });
}

function detectStructuredOutput(record, wrapper, normalizedOutputs = null) {
  const outputs = Array.isArray(normalizedOutputs)
    ? normalizedOutputs
    : normalizeStructuredOutputs(record, wrapper);

  const selected =
    outputs.find((item) => safeObject(item.result)?.callOutcome) ||
    outputs.find((item) => {
      const result = safeObject(item.result);
      return result && Object.keys(result).length > 0;
    }) ||
    null;

  if (!selected) {
    return {
      found: false,
      output_id: null,
      output_name: null,
      result: null
    };
  }

  return {
    found: true,
    output_id: selected.output_id,
    output_name: selected.output_name,
    result: safeObject(selected.result) || {}
  };
}

function normalizeScorecards(record, wrapper, normalizedOutputs = null) {
  const outputs = Array.isArray(normalizedOutputs)
    ? normalizedOutputs
    : normalizeStructuredOutputs(record, wrapper);
  const outputsById = new Map(outputs.map((item) => [item.output_id, item]));

  return Object.entries(getScorecards(record, wrapper))
    .map(([scorecardId, scorecard]) => {
      const metricPoints = safeObject(scorecard?.metricPoints) || {};
      return {
        scorecard_id: scorecardId,
        name: typeof scorecard?.name === 'string' ? scorecard.name : null,
        name_canonical: normalizeScopedName(scorecard?.name),
        score: toNumber(scorecard?.score),
        score_normalized: toNumber(scorecard?.scoreNormalized),
        metrics: Object.entries(metricPoints).map(([outputId, points]) => {
          const output = outputsById.get(outputId) || null;
          return {
            structured_output_id: outputId,
            structured_output_name: output?.output_name || null,
            structured_output_name_canonical: output?.output_name_canonical || null,
            points: toNumber(points),
            result_type: output?.result_type || null,
            result: output?.result ?? null
          };
        })
      };
    })
    .sort((left, right) => {
      const leftName = left.name || left.scorecard_id;
      const rightName = right.name || right.scorecard_id;
      return leftName.localeCompare(rightName);
    });
}

function getObservedBoolean(observability, canonicalOutputName) {
  const output = safeArray(observability?.structured_outputs).find(
    (item) => item?.output_name_canonical === canonicalOutputName
  );
  return typeof output?.result === 'boolean' ? output.result : null;
}

function roleToNormalized(role) {
  switch (role) {
    case 'user':
      return { role: 'caller', kind: 'utterance' };
    case 'bot':
    case 'assistant':
      return { role: 'assistant', kind: 'utterance' };
    case 'tool_calls':
      return { role: 'tool_call', kind: 'tool_call' };
    case 'tool_call_result':
      return { role: 'tool_result', kind: 'tool_result' };
    case 'system':
      return { role: 'system', kind: 'prompt' };
    default:
      return { role: 'other', kind: 'metadata' };
  }
}

function flattenToolCalls(message) {
  const directToolCalls = safeArray(message.toolCalls);
  if (directToolCalls.length > 0) {
    return directToolCalls.map((toolCall) => {
      const functionPart = safeObject(toolCall.function) || {};
      return {
        tool_name: typeof functionPart.name === 'string' ? functionPart.name : null,
        tool_call_id: typeof toolCall.id === 'string' ? toolCall.id : null,
        arguments: parseMaybeJson(functionPart.arguments || functionPart.parameters)
      };
    });
  }

  const toolCallList = safeArray(message.toolCallList);
  if (toolCallList.length > 0) {
    return toolCallList.map((toolCall) => ({
      tool_name: typeof toolCall?.function?.name === 'string' ? toolCall.function.name : null,
      tool_call_id: typeof toolCall?.id === 'string' ? toolCall.id : null,
      arguments: parseMaybeJson(toolCall?.function?.arguments || toolCall?.parameters)
    }));
  }

  const wrapped = safeArray(message.toolWithToolCallList);
  return wrapped.map((item) => ({
    tool_name: typeof item?.toolCall?.function?.name === 'string' ? item.toolCall.function.name : null,
    tool_call_id: typeof item?.toolCall?.id === 'string' ? item.toolCall.id : null,
    arguments: parseMaybeJson(item?.toolCall?.function?.arguments || item?.toolCall?.parameters)
  }));
}

function flattenToolResults(message) {
  const resultEntries = safeArray(message.results);
  if (resultEntries.length > 0) {
    return resultEntries.map((entry) => ({
      tool_call_id: typeof entry?.toolCallId === 'string' ? entry.toolCallId : null,
      result: entry?.result ?? null
    }));
  }

  if (Object.prototype.hasOwnProperty.call(message, 'result')) {
    return [{
      tool_call_id: typeof message?.toolCallId === 'string' ? message.toolCallId : null,
      result: message.result ?? null
    }];
  }

  return [];
}

function sortMessages(messages) {
  const decorated = messages.map((message, index) => ({ message, index }));
  decorated.sort((left, right) => {
    const leftTime = typeof left.message?.time === 'number' ? left.message.time : Number.POSITIVE_INFINITY;
    const rightTime = typeof right.message?.time === 'number' ? right.message.time : Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.index - right.index;
  });
  return decorated.map((item) => item.message);
}

function normalizeConversation(record) {
  const rawMessages = safeArray(record?.artifact?.messages).length > 0
    ? safeArray(record.artifact.messages)
    : safeArray(record?.messages);
  const messages = sortMessages(rawMessages);
  const normalizedMessages = [];
  const toolTrace = [];
  const pending = [];
  const omitted = new Set();

  function pushMessage(payload) {
    normalizedMessages.push({
      message_index: normalizedMessages.length,
      ...payload
    });
  }

  function addToolTrace(toolCall, message) {
    const trace = {
      index: toolTrace.length,
      tool_name: toolCall.tool_name || 'unknown_tool',
      tool_call_id: toolCall.tool_call_id || null,
      status: 'requested',
      arguments: toolCall.arguments,
      result: null,
      requested_at_ms: typeof message?.time === 'number' ? message.time : null,
      completed_at_ms: null
    };
    toolTrace.push(trace);
    pending.push(trace);
    pushMessage({
      role: 'tool_call',
      kind: 'tool_call',
      text: null,
      time_ms: typeof message?.time === 'number' ? message.time : null,
      seconds_from_start: typeof message?.secondsFromStart === 'number' ? message.secondsFromStart : null,
      tool_name: trace.tool_name,
      tool_call_id: trace.tool_call_id,
      arguments: trace.arguments,
      result: null
    });
  }

  function consumePending(toolCallId) {
    if (toolCallId) {
      const match = pending.find((item) => item.tool_call_id === toolCallId && item.status === 'requested');
      if (match) {
        return match;
      }
    }
    return pending.find((item) => item.status === 'requested') || null;
  }

  for (const message of messages) {
    const { role, kind } = roleToNormalized(message.role);

    if (role === 'system') {
      omitted.add('system_prompt');
      continue;
    }

    if (role === 'tool_call') {
      const calls = flattenToolCalls(message);
      if (calls.length === 0) {
        omitted.add('empty_tool_call_event');
        continue;
      }
      for (const call of calls) {
        addToolTrace(call, message);
      }
      continue;
    }

    if (role === 'tool_result') {
      const results = flattenToolResults(message);
      if (results.length === 0) {
        omitted.add('empty_tool_result_event');
        continue;
      }
      for (const resultEntry of results) {
        const trace = consumePending(resultEntry.tool_call_id);
        if (trace) {
          trace.status = 'completed';
          trace.result = resultEntry.result;
          trace.completed_at_ms = typeof message?.time === 'number' ? message.time : null;
        }
        pushMessage({
          role: 'tool_result',
          kind: 'tool_result',
          text: null,
          time_ms: typeof message?.time === 'number' ? message.time : null,
          seconds_from_start: typeof message?.secondsFromStart === 'number' ? message.secondsFromStart : null,
          tool_name: trace?.tool_name || null,
          tool_call_id: trace?.tool_call_id || resultEntry.tool_call_id || null,
          arguments: null,
          result: resultEntry.result ?? null
        });
      }
      continue;
    }

    const text = typeof message?.message === 'string' ? message.message.trim() : null;
    if (!text) {
      omitted.add('empty_utterance');
      continue;
    }

    pushMessage({
      role,
      kind,
      text,
      time_ms: typeof message?.time === 'number' ? message.time : null,
      seconds_from_start: typeof message?.secondsFromStart === 'number' ? message.secondsFromStart : null,
      tool_name: null,
      tool_call_id: null,
      arguments: null,
      result: null
    });
  }

  for (const trace of pending) {
    if (trace.status === 'requested') {
      trace.status = 'missing_result';
    }
  }

  return {
    conversation: {
      message_count: normalizedMessages.length,
      messages_omitted: Array.from(omitted),
      messages: normalizedMessages
    },
    tool_trace: toolTrace
  };
}

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function computeDurationSeconds(record, messages) {
  if (record?.startedAt && record?.endedAt) {
    const start = Date.parse(record.startedAt);
    const end = Date.parse(record.endedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return (end - start) / 1000;
    }
  }

  const last = messages
    .map((message) => toNumber(message.seconds_from_start))
    .filter((value) => value !== null)
    .sort((a, b) => a - b)
    .pop();
  return last;
}

function maxLatencyValue(turnLatencies, key) {
  const values = turnLatencies
    .map((turn) => toNumber(safeObject(turn)?.[key]))
    .filter((value) => value !== null);
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

function deriveLatencyDiagnostics(record, toolTrace) {
  const artifactMetrics = safeObject(record?.artifact?.performanceMetrics) || safeObject(record?.performanceMetrics) || {};
  const turnLatencies = safeArray(artifactMetrics.turnLatencies).map((turn) => safeObject(turn)).filter(Boolean);
  const maxModelLatencyMs = maxLatencyValue(turnLatencies, 'modelLatency');
  const maxTranscriberLatencyMs = maxLatencyValue(turnLatencies, 'transcriberLatency');
  const maxEndpointingLatencyMs = maxLatencyValue(turnLatencies, 'endpointingLatency');
  const completedToolLatencies = safeArray(toolTrace)
    .map((trace) => {
      const requestedAt = toNumber(trace?.requested_at_ms);
      const completedAt = toNumber(trace?.completed_at_ms);
      if (requestedAt === null || completedAt === null || completedAt < requestedAt) {
        return null;
      }
      return completedAt - requestedAt;
    })
    .filter((value) => value !== null);
  const maxWebhookLatencyMs = completedToolLatencies.length > 0 ? Math.max(...completedToolLatencies) : null;
  const dominantCandidates = [
    { stage: 'model', value: maxModelLatencyMs, priority: 4 },
    { stage: 'webhook', value: maxWebhookLatencyMs, priority: 3 },
    { stage: 'endpointing', value: maxEndpointingLatencyMs, priority: 2 },
    { stage: 'transcriber', value: maxTranscriberLatencyMs, priority: 1 }
  ].filter((candidate) => candidate.value !== null);
  dominantCandidates.sort((left, right) => {
    const byValue = right.value - left.value;
    if (byValue !== 0) {
      return byValue;
    }
    return right.priority - left.priority;
  });

  return {
    maxModelLatencyMs,
    maxTranscriberLatencyMs,
    maxEndpointingLatencyMs,
    maxWebhookLatencyMs,
    dominantLatencyStage: dominantCandidates[0]?.stage || null,
    slowTurnCount: turnLatencies.filter((turn) => {
      const turnLatency = toNumber(turn?.turnLatency);
      return turnLatency !== null && turnLatency >= 4000;
    }).length
  };
}

function hasValidationError(result) {
  const details = safeArray(result?.error?.details).map(String);
  return details.some((detail) => detail.includes(' is required') || detail.includes('webhook request is unauthorized'));
}

function findToolResult(toolTrace, toolName) {
  return toolTrace.find((trace) => trace.tool_name === toolName && trace.status === 'completed') || null;
}

function isNonEmptyObject(value) {
  return Boolean(safeObject(value)) && Object.keys(value).length > 0;
}

function truthy(value) {
  return value === true;
}

function deriveEvaluation(record, structuredOutput, toolTrace, observability = null, conversation = null) {
  const result = safeObject(structuredOutput.result) || {};
  const qualityFlags = safeObject(result.qualityFlags) || {};
  const riskFlags = safeObject(result.riskFlags) || {};
  const followUp = safeObject(result.followUp) || {};
  const booking = safeObject(result.booking) || {};
  const conversationMessages = safeArray(conversation?.messages);
  const utteranceMessages = conversationMessages.filter(
    (message) => message.role === 'assistant' || message.role === 'user'
  );
  const userMessages = utteranceMessages.filter((message) => message.role === 'user');
  const artifactMetrics = safeObject(record?.artifact?.performanceMetrics) || safeObject(record?.performanceMetrics) || {};
  const turnLatencies = safeArray(artifactMetrics.turnLatencies);
  const transcriptText =
    typeof record?.artifact?.transcript === 'string'
      ? record.artifact.transcript.trim()
      : typeof record?.transcript === 'string'
        ? record.transcript.trim()
        : '';
  const durationSeconds = computeDurationSeconds(record, conversationMessages);
  const likelyConversationStartFailure =
    transcriptText === '' &&
    utteranceMessages.length === 0 &&
    userMessages.length === 0 &&
    turnLatencies.length === 0 &&
    typeof durationSeconds === 'number' &&
    durationSeconds >= 10 &&
    ['silence-timed-out', 'customer-ended-call'].includes(record?.endedReason);

  const observedRepeatedIdentity = getObservedBoolean(observability, 'QA: Repeated Identity');
  const observedPrematureToolCall = getObservedBoolean(observability, 'QA: Premature Tool Call');
  const observedMedicalAdviceGiven = getObservedBoolean(observability, 'QA: Medical Advice Given');
  const observedToolFailure = getObservedBoolean(observability, 'QA: Tool Failure');

  const createEventTrace = findToolResult(toolTrace, 'createEvent');
  const createReceptionTaskTrace = findToolResult(toolTrace, 'createReceptionTask');

  const bookingSucceeded = booking.bookingCreated === true || createEventTrace?.result?.created === true;
  const needsHumanHandoff =
    followUp.receptionFollowUpNeeded === true ||
    createReceptionTaskTrace?.result?.accepted === true ||
    ['cancellation_or_reschedule_requested', 'needs_reception_follow_up'].includes(result.callOutcome);

  let taskCompleted = null;
  if (typeof result.successfulForAssistantScope === 'boolean') {
    taskCompleted = result.successfulForAssistantScope;
  } else if (bookingSucceeded || needsHumanHandoff) {
    taskCompleted = true;
  } else if (result.callOutcome === 'abandoned_or_incomplete') {
    taskCompleted = false;
  }

  let wrongToolUsage = null;
  if (typeof qualityFlags.toolCalledOnIncompleteAnswer === 'boolean') {
    wrongToolUsage = qualityFlags.toolCalledOnIncompleteAnswer;
  } else if (typeof observedPrematureToolCall === 'boolean') {
    wrongToolUsage = observedPrematureToolCall;
  }

  let repeatedQuestion = null;
  if (typeof qualityFlags.repeatedIdentityRequest === 'boolean') {
    repeatedQuestion = qualityFlags.repeatedIdentityRequest;
  } else if (typeof observedRepeatedIdentity === 'boolean') {
    repeatedQuestion = observedRepeatedIdentity;
  }

  let missingRequiredData = null;
  const validationFailure = toolTrace.some((trace) => hasValidationError(trace.result));
  if (validationFailure) {
    missingRequiredData = true;
  } else if (bookingSucceeded || needsHumanHandoff) {
    missingRequiredData = false;
  }

  let unsupportedClaim = null;
  if (riskFlags.medicalAdviceGiven === true || observedMedicalAdviceGiven === true) {
    unsupportedClaim = true;
  } else if (result.callOutcome === 'appointment_booked' && !bookingSucceeded) {
    unsupportedClaim = true;
  } else if (isNonEmptyObject(result)) {
    unsupportedClaim = false;
  }

  const toolFailureDetected =
    typeof riskFlags.toolFailureOccurred === 'boolean'
      ? riskFlags.toolFailureOccurred
      : observedToolFailure;

  let failureCategory = 'other';
  if (!structuredOutput.found || !isNonEmptyObject(result)) {
    failureCategory = 'structured_output_missing';
  } else if (likelyConversationStartFailure) {
    failureCategory = 'conversation_start_failure';
  } else if (truthy(wrongToolUsage)) {
    failureCategory = 'wrong_tool_usage';
  } else if (truthy(missingRequiredData)) {
    failureCategory = 'missing_required_data';
  } else if (truthy(repeatedQuestion)) {
    failureCategory = 'repeated_question';
  } else if (truthy(unsupportedClaim)) {
    failureCategory = 'unsupported_claim';
  } else if (needsHumanHandoff) {
    failureCategory = 'needs_human_handoff';
  } else if (createEventTrace?.result?.error?.code === 'SLOT_UNAVAILABLE') {
    failureCategory = 'booking_conflict';
  } else if (toolFailureDetected === true) {
    failureCategory = 'tool_failure';
  } else if (riskFlags.callerHungUpBeforeCompletion === true || result.callOutcome === 'abandoned_or_incomplete') {
    failureCategory = 'caller_abandoned';
  } else if (taskCompleted === true && !truthy(wrongToolUsage) && !truthy(missingRequiredData) && !truthy(repeatedQuestion) && !truthy(unsupportedClaim)) {
    failureCategory = 'none';
  }

  const evidence = [];
  if (typeof result.callOutcome === 'string') {
    evidence.push(`structured_output.callOutcome=${result.callOutcome}`);
  }
  if (bookingSucceeded && createEventTrace) {
    evidence.push(`tool_trace[${createEventTrace.index}] createEvent created=true`);
  }
  if (needsHumanHandoff && createReceptionTaskTrace?.result?.accepted === true) {
    evidence.push(`tool_trace[${createReceptionTaskTrace.index}] createReceptionTask accepted=true`);
  }
  if (truthy(wrongToolUsage)) {
    evidence.push('structured_output.qualityFlags.toolCalledOnIncompleteAnswer=true');
  }
  if (truthy(repeatedQuestion)) {
    evidence.push('structured_output.qualityFlags.repeatedIdentityRequest=true');
  }
  if (truthy(unsupportedClaim)) {
    evidence.push('structured_output or tool outcomes show an unsupported promise or inconsistency');
  }
  if (truthy(missingRequiredData)) {
    evidence.push('tool_trace contains a validation error tied to required data');
  }
  if (toolFailureDetected === true) {
    evidence.push('observability QA output or structured output indicates a material tool failure');
  }
  if (failureCategory === 'structured_output_missing') {
    evidence.push('structured output missing or empty');
  }
  if (likelyConversationStartFailure) {
    evidence.push('call artifact captured no assistant/user turns, no transcript text, and zero turn latencies');
  }

  let summary = null;
  if (bookingSucceeded) {
    summary = 'Booking succeeded according to tool output.';
  } else if (needsHumanHandoff) {
    summary = 'Reception handoff was required or completed.';
  } else if (failureCategory === 'structured_output_missing') {
    summary = 'Structured output was missing or empty, so manual review is still required.';
  } else {
    summary = 'Run normalized for further review.';
  }

  let confidence = 'low';
  if (isNonEmptyObject(result)) {
    confidence = 'high';
  } else if (toolTrace.length > 0) {
    confidence = 'medium';
  }

  let recommendedNextAction = 'Inspect the run and convert any confirmed issue into a scenario-backed regression.';
  if (failureCategory === 'none') {
    recommendedNextAction = needsHumanHandoff
      ? 'Archive as a supported receptionist handoff baseline.'
      : 'Archive as a passing regression baseline.';
  } else if (failureCategory === 'structured_output_missing') {
    recommendedNextAction = 'Review the call in Vapi or rerun ingest with explicit raw-call retention before making repo changes.';
  } else if (failureCategory === 'conversation_start_failure') {
    recommendedNextAction = 'Review the call in Vapi because the conversation never started even though the call connected.';
  } else if (failureCategory === 'needs_human_handoff') {
    recommendedNextAction = 'Confirm the handoff path stayed within scope and that no unsupported promise was made before tool success.';
  }

  return {
    schema_version: 'evaluator-result.v1',
    source: 'heuristic_vapi_ingest',
    result: {
      task_completed: taskCompleted,
      booking_succeeded: bookingSucceeded,
      wrong_tool_usage: wrongToolUsage,
      missing_required_data: missingRequiredData,
      repeated_question: repeatedQuestion,
      unsupported_claim: unsupportedClaim,
      needs_human_handoff: needsHumanHandoff,
      failure_category: failureCategory,
      summary,
      confidence,
      evidence,
      recommended_next_action: recommendedNextAction
    }
  };
}

function makeRunId(record, scenarioId, environment) {
  const base =
    (typeof record?.id === 'string' && record.id.trim()) ||
    scenarioId ||
    crypto.createHash('sha1').update(JSON.stringify(record)).digest('hex').slice(0, 12);
  const cleaned = base.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return environment && environment !== 'unknown' ? `${environment}-${cleaned}` : cleaned;
}

function buildRun(entry, options, inputPath) {
  const ingestedAt = stableNowIso();
  const structuredOutputs = normalizeStructuredOutputs(entry.record, entry.wrapper);
  const scorecards = normalizeScorecards(entry.record, entry.wrapper, structuredOutputs);
  const observability = {
    structured_outputs: structuredOutputs,
    scorecards
  };
  const structuredOutput = detectStructuredOutput(entry.record, entry.wrapper, structuredOutputs);
  const { conversation, tool_trace } = normalizeConversation(entry.record);
  const latencyDiagnostics = deriveLatencyDiagnostics(entry.record, tool_trace);
  const runId = makeRunId(entry.record, options.scenarioId, options.environment);

  const run = {
    schema_version: 'run.v1',
    run_id: runId,
    run_kind: options.runKind,
    environment: options.environment,
    scenario_id: options.scenarioId,
    created_at: ingestedAt,
    source: {
      provider: 'vapi',
      source_kind: entry.sourceKind,
      input_path: inputPath,
      ingested_at: ingestedAt,
      call_index: entry.index
    },
    call: {
      call_id: entry.record?.id || runId,
      assistant_id: entry.record?.assistantId || null,
      phone_number_id: entry.record?.phoneNumberId || null,
      started_at: entry.record?.startedAt || null,
      ended_at: entry.record?.endedAt || null,
      ended_reason: entry.record?.endedReason || null,
      duration_seconds: computeDurationSeconds(entry.record, conversation.messages),
      status: entry.record?.status || null,
      cost: toNumber(entry.record?.cost),
      cost_breakdown: safeObject(entry.record?.costBreakdown),
      latency_diagnostics: latencyDiagnostics,
      transcript: typeof entry.record?.transcript === 'string' ? entry.record.transcript : null,
      recording_url: typeof entry.record?.recordingUrl === 'string' ? entry.record.recordingUrl : null,
      web_call_url: typeof entry.record?.webCallUrl === 'string' ? entry.record.webCallUrl : null
    },
    conversation,
    tool_trace,
    observability,
    structured_output: structuredOutput,
    evaluation: deriveEvaluation(entry.record, structuredOutput, tool_trace, observability, conversation)
  };

  if (options.runKind !== 'real_call') {
    return run;
  }

  const redactedConversation = {
    ...run.conversation,
    messages_omitted: Array.from(new Set([
      ...safeArray(run.conversation?.messages_omitted),
      'real_call_content_redacted',
      'real_call_tool_payloads_minimized'
    ])),
    messages: safeArray(run.conversation?.messages).map((message) => sanitizeRealCallConversationMessage(message))
  };

  return {
    ...run,
    call: {
      ...run.call,
      transcript: null,
      recording_url: null,
      web_call_url: null
    },
    conversation: redactedConversation,
    tool_trace: safeArray(run.tool_trace).map((trace) => sanitizeRealCallToolTrace(trace)),
    structured_output: {
      ...run.structured_output,
      result: sanitizeRealCallStructuredOutput(run.structured_output?.result)
    },
    observability: {
      structured_outputs: safeArray(run.observability?.structured_outputs).map((item) => ({
        ...item,
        result: sanitizeRealCallObservabilityResult(item.result)
      })),
      scorecards: safeArray(run.observability?.scorecards).map((scorecard) => ({
        ...scorecard,
        metrics: safeArray(scorecard.metrics).map((metric) => ({
          ...metric,
          result: sanitizeRealCallObservabilityResult(metric.result)
        }))
      }))
    }
  };
}

function writeRun(run, outputPath) {
  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const root = readJson(inputPath);
  const entries = selectEntries(pickCallEntries(root), options);
  const runs = entries.map((entry) => buildRun(entry, options, inputPath));

  if (options.output) {
    if (runs.length !== 1) {
      throw new Error('--output can only be used when ingesting one run');
    }
    writeRun(runs[0], path.resolve(options.output));
    console.log(`Wrote ${runs[0].run_id} -> ${path.resolve(options.output)}`);
    return;
  }

  if (options.outputDir) {
    const outputDir = path.resolve(options.outputDir);
    ensureDir(outputDir);
    for (const run of runs) {
      const outputPath = path.join(outputDir, `${run.run_id}.run.v1.json`);
      writeRun(run, outputPath);
      console.log(`Wrote ${run.run_id} -> ${outputPath}`);
    }
    return;
  }

  if (runs.length !== 1) {
    throw new Error('Multiple runs selected. Provide --output-dir or narrow the selection.');
  }

  process.stdout.write(`${JSON.stringify(runs[0], null, 2)}\n`);
}

module.exports = {
  buildRun,
  detectStructuredOutput,
  deriveLatencyDiagnostics,
  deriveEvaluation,
  normalizeScorecards,
  normalizeStructuredOutputs,
  pickCallEntries,
  selectEntries,
  writeRun
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
