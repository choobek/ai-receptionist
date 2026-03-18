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

function detectStructuredOutput(record, wrapper) {
  const outputs =
    safeObject(record?.artifact?.structuredOutputs) ||
    safeObject(wrapper?.artifact?.structuredOutputs) ||
    safeObject(wrapper?.call?.artifact?.structuredOutputs) ||
    safeObject(wrapper?.message?.artifact?.structuredOutputs) ||
    {};

  const entries = Object.entries(outputs);
  if (entries.length === 0) {
    return {
      found: false,
      output_id: null,
      output_name: null,
      result: null
    };
  }

  let selected = entries.find(([, value]) => {
    const result = safeObject(value?.result);
    return result && Object.keys(result).length > 0;
  });

  if (!selected) {
    selected = entries[0];
  }

  const [outputId, output] = selected;

  return {
    found: true,
    output_id: outputId,
    output_name: typeof output?.name === 'string' ? output.name : null,
    result: safeObject(output?.result) || {}
  };
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

function deriveEvaluation(record, structuredOutput, toolTrace) {
  const result = safeObject(structuredOutput.result) || {};
  const qualityFlags = safeObject(result.qualityFlags) || {};
  const riskFlags = safeObject(result.riskFlags) || {};
  const followUp = safeObject(result.followUp) || {};
  const booking = safeObject(result.booking) || {};

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
  }

  let repeatedQuestion = null;
  if (typeof qualityFlags.repeatedIdentityRequest === 'boolean') {
    repeatedQuestion = qualityFlags.repeatedIdentityRequest;
  }

  let missingRequiredData = null;
  const validationFailure = toolTrace.some((trace) => hasValidationError(trace.result));
  if (validationFailure) {
    missingRequiredData = true;
  } else if (bookingSucceeded || needsHumanHandoff) {
    missingRequiredData = false;
  }

  let unsupportedClaim = null;
  if (riskFlags.medicalAdviceGiven === true) {
    unsupportedClaim = true;
  } else if (result.callOutcome === 'appointment_booked' && !bookingSucceeded) {
    unsupportedClaim = true;
  } else if (isNonEmptyObject(result)) {
    unsupportedClaim = false;
  }

  let failureCategory = 'other';
  if (!structuredOutput.found || !isNonEmptyObject(result)) {
    failureCategory = 'structured_output_missing';
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
  } else if (riskFlags.toolFailureOccurred === true) {
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
  if (failureCategory === 'structured_output_missing') {
    evidence.push('structured output missing or empty');
  }

  let summary = null;
  if (typeof result?.summary?.shortSummaryPl === 'string' && result.summary.shortSummaryPl.trim()) {
    summary = result.summary.shortSummaryPl.trim();
  } else if (typeof record?.summary === 'string' && record.summary.trim()) {
    summary = record.summary.trim();
  } else if (bookingSucceeded) {
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
    recommendedNextAction = 'Review the raw transcript and structured-output attachment before making repo changes.';
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
  const structuredOutput = detectStructuredOutput(entry.record, entry.wrapper);
  const { conversation, tool_trace } = normalizeConversation(entry.record);
  const runId = makeRunId(entry.record, options.scenarioId, options.environment);

  return {
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
      transcript: typeof entry.record?.transcript === 'string' ? entry.record.transcript : null,
      recording_url: typeof entry.record?.recordingUrl === 'string' ? entry.record.recordingUrl : null,
      web_call_url: typeof entry.record?.webCallUrl === 'string' ? entry.record.webCallUrl : null
    },
    conversation,
    tool_trace,
    structured_output: structuredOutput,
    evaluation: deriveEvaluation(entry.record, structuredOutput, tool_trace)
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

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
