#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_SCENARIOS_DIR = path.join(ROOT_DIR, 'autonomy', 'scenarios', 'staging');
const DEFAULT_RUNS_DIR = path.join(ROOT_DIR, 'autonomy', 'runs', 'generated', 'staging');
const DEFAULT_REPORTS_DIR = path.join(ROOT_DIR, 'autonomy', 'reports', 'generated', 'staging');
const STAGING_BINDINGS_PATH = path.join(ROOT_DIR, 'configs', 'vapi', 'environments', 'staging.json');

function usage() {
  console.log(`Usage:
  node scripts/autonomy/run-staging-regression-suite.js [options]

Options:
  --scenario <id>     Run only the named scenario. Repeat to run multiple scenarios.
  --include-draft     Also allow draft scenarios for explicit experimental runs.
  --output-dir <dir>  Write machine-readable artifacts into this directory.
  --report <path>     Write the Markdown report to this path.
  --list              Print the available active staging scenarios and exit.
  --help              Show this help message.
`);
}

function parseArgs(argv) {
  const options = {
    scenarioIds: [],
    includeDraft: false,
    outputDir: null,
    reportPath: null,
    listOnly: false
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

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}

function stableNowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '')
    .replace(/[Łł]/g, (letter) => (letter === 'Ł' ? 'L' : 'l'))
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveTemplatedString(value, env = process.env) {
  return value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)(?:\|([^{}]*))?\}\}/g, (match, envName, fallback) => {
    const envValue = env[envName];
    if (typeof envValue === 'string' && envValue !== '') {
      return envValue;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing required scenario template variable: ${envName}`);
  });
}

function resolveScenarioTemplates(value, env = process.env) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveScenarioTemplates(item, env));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, resolveScenarioTemplates(nestedValue, env)])
    );
  }

  if (typeof value === 'string' && value.includes('{{')) {
    return resolveTemplatedString(value, env);
  }

  return value;
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

function formatValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify(value);
}

function summarizeToolArguments(args) {
  if (!args || typeof args !== 'object') {
    return '';
  }
  const preview = JSON.stringify(args);
  return preview.length <= 240 ? preview : `${preview.slice(0, 237)}...`;
}

function scenarioSort(left, right) {
  return left.scenario_id.localeCompare(right.scenario_id);
}

function resolveAllowedScenarioStatuses(includeDraft) {
  return new Set(includeDraft ? ['active', 'draft'] : ['active']);
}

function loadScenarios(selectedIds, includeDraft = false) {
  const entries = fs.readdirSync(DEFAULT_SCENARIOS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => path.join(DEFAULT_SCENARIOS_DIR, entry));

  const scenarios = entries.map((filePath) => {
    const scenario = resolveScenarioTemplates(readJson(filePath));
    scenario.__filePath = filePath;
    return scenario;
  });

  const allowedScenarioStatuses = resolveAllowedScenarioStatuses(includeDraft);
  const activeScenarios = scenarios
    .filter((scenario) => allowedScenarioStatuses.has(scenario.status))
    .sort(scenarioSort);

  if (selectedIds.length === 0) {
    return activeScenarios;
  }

  const selectedSet = new Set(selectedIds);
  const selected = activeScenarios.filter((scenario) => selectedSet.has(scenario.scenario_id));
  if (selected.length !== selectedIds.length) {
    const found = new Set(selected.map((scenario) => scenario.scenario_id));
    const missing = selectedIds.filter((scenarioId) => !found.has(scenarioId));
    throw new Error(`Scenario not found or not eligible for this run: ${missing.join(', ')}`);
  }

  return selected;
}

function getEnabledToolBindings(bindings) {
  const toolIds = bindings?.toolIds;
  if (!toolIds || typeof toolIds !== 'object') {
    return new Set();
  }

  return new Set(
    Object.entries(toolIds)
      .filter(([, toolId]) => typeof toolId === 'string' && toolId.trim())
      .map(([toolName]) => toolName)
  );
}

function getMissingRequiredToolBindings(scenario, enabledToolBindings) {
  const requiredToolBindings = Array.isArray(scenario?.required_tool_bindings)
    ? scenario.required_tool_bindings
      .filter((toolName) => typeof toolName === 'string' && toolName.trim())
      .map((toolName) => toolName.trim())
    : [];

  return requiredToolBindings.filter((toolName) => !enabledToolBindings.has(toolName));
}

function printScenarioList(scenarios) {
  for (const scenario of scenarios) {
    console.log(`${scenario.scenario_id}\t${scenario.title}`);
  }
}

async function callVapiChat({ assistantId, apiKey, baseUrl, previousChatId, input }) {
  const payload = previousChatId
    ? { assistantId, previousChatId, input }
    : { assistantId, input };

  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const body = await response.text();
  let parsedBody;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = { raw: body };
  }

  if (!response.ok) {
    const message = typeof parsedBody?.message === 'string'
      ? parsedBody.message
      : `Vapi chat request failed with HTTP ${response.status}`;
    const error = new Error(message);
    error.httpStatus = response.status;
    error.responseBody = parsedBody;
    throw error;
  }

  return parsedBody;
}

function createContext(scenario) {
  return {
    scenario,
    chatId: null,
    transcript: [],
    toolTrace: [],
    turns: []
  };
}

function recordTranscriptEntry(context, entry) {
  context.transcript.push({
    sequence: context.transcript.length,
    ...entry
  });
}

function normalizeOutputForTurn(context, turnIndex, output) {
  const turnState = {
    turn: turnIndex,
    user: context.scenario.turns[turnIndex - 1].user,
    assistant_texts: [],
    tool_calls: [],
    tool_results: []
  };

  const unresolved = new Map();

  for (const item of Array.isArray(output) ? output : []) {
    if (item?.role === 'assistant' && Array.isArray(item.tool_calls)) {
      for (const call of item.tool_calls) {
        const trace = {
          index: context.toolTrace.length,
          turn: turnIndex,
          tool_name: call?.function?.name || 'unknown_tool',
          tool_call_id: call?.id || null,
          status: 'missing_result',
          arguments: parseMaybeJson(call?.function?.arguments) || null,
          result: null
        };
        context.toolTrace.push(trace);
        turnState.tool_calls.push(trace);
        if (trace.tool_call_id) {
          unresolved.set(trace.tool_call_id, trace);
        }

        recordTranscriptEntry(context, {
          turn: turnIndex,
          role: 'assistant',
          kind: 'tool_call',
          text: null,
          tool_name: trace.tool_name,
          tool_call_id: trace.tool_call_id,
          arguments: trace.arguments,
          result: null
        });
      }
      continue;
    }

    if (item?.role === 'tool') {
      const trace = item?.tool_call_id
        ? unresolved.get(item.tool_call_id) || context.toolTrace.find((candidate) => candidate.tool_call_id === item.tool_call_id)
        : null;

      if (trace) {
        trace.status = 'completed';
        trace.result = item.content ?? null;
      }

      const toolName = trace?.tool_name || null;
      turnState.tool_results.push({
        tool_name: toolName,
        tool_call_id: item?.tool_call_id || null,
        result: item.content ?? null
      });

      recordTranscriptEntry(context, {
        turn: turnIndex,
        role: 'tool',
        kind: 'tool_result',
        text: null,
        tool_name: toolName,
        tool_call_id: item?.tool_call_id || null,
        arguments: null,
        result: item.content ?? null
      });
      continue;
    }

    if (item?.role === 'assistant' && typeof item.content === 'string') {
      const text = item.content.trim();
      if (!text) {
        continue;
      }

      turnState.assistant_texts.push(text);
      recordTranscriptEntry(context, {
        turn: turnIndex,
        role: 'assistant',
        kind: 'message',
        text,
        tool_name: null,
        tool_call_id: null,
        arguments: null,
        result: null
      });
    }
  }

  context.turns.push(turnState);
}

function findToolCalls(context, toolName, turn) {
  return context.toolTrace.filter((trace) => {
    if (toolName && trace.tool_name !== toolName) {
      return false;
    }
    if (turn && trace.turn !== turn) {
      return false;
    }
    return true;
  });
}

function findTranscriptEntries(context, kind, toolName) {
  return context.transcript.filter((entry) => {
    if (kind && entry.kind !== kind) {
      return false;
    }
    if (toolName && entry.tool_name !== toolName) {
      return false;
    }
    return true;
  });
}

function pickOccurrence(traces, occurrence) {
  if (traces.length === 0) {
    return null;
  }
  switch (occurrence) {
    case 'first':
      return traces[0];
    case 'any':
      return traces[0];
    case 'last':
    default:
      return traces[traces.length - 1];
  }
}

function stringifyEvidence(parts) {
  return parts.filter(Boolean).join(' | ');
}

function getAssistantTextForTurn(context, turn) {
  const turnState = context.turns.find((candidate) => candidate.turn === turn);
  if (!turnState) {
    return '';
  }
  return turnState.assistant_texts.join(' ');
}

function evaluateCriterion(context, criterion) {
  const rule = criterion.rule || {};
  const occurrence = rule.occurrence || 'last';
  const sourceOccurrence = rule.source_occurrence || 'last';
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
    case 'turn_tool_called': {
      const matches = findToolCalls(context, rule.tool_name, rule.turn);
      evidence.push(`turn ${rule.turn}: ${matches.length} ${rule.tool_name} call(s)`);
      return matches.length > 0
        ? pass()
        : fail(`Expected ${rule.tool_name} on turn ${rule.turn}`);
    }

    case 'turn_tool_not_called': {
      const matches = findToolCalls(context, rule.tool_name, rule.turn);
      evidence.push(`turn ${rule.turn}: ${matches.length} ${rule.tool_name} call(s)`);
      return matches.length === 0
        ? pass()
        : fail(`Did not expect ${rule.tool_name} on turn ${rule.turn}`);
    }

    case 'turn_tool_arg_equals': {
      const matches = findToolCalls(context, rule.tool_name, rule.turn);
      const passing = matches.find((trace) => valuesEqual(getByPath(trace.arguments, rule.path), rule.equals));
      for (const trace of matches) {
        evidence.push(
          stringifyEvidence([
            `turn ${rule.turn}`,
            trace.tool_name,
            `${rule.path}=${formatValue(getByPath(trace.arguments, rule.path))}`
          ])
        );
      }
      return passing
        ? pass()
        : fail(`Expected ${rule.tool_name}.${rule.path} to equal ${formatValue(rule.equals)} on turn ${rule.turn}`);
    }

    case 'turn_tool_result_path_equals': {
      const matches = findToolCalls(context, rule.tool_name, rule.turn);
      const passing = matches.find((trace) => valuesEqual(getByPath(trace.result, rule.path), rule.equals));
      for (const trace of matches) {
        evidence.push(
          stringifyEvidence([
            `turn ${rule.turn}`,
            trace.tool_name,
            `${rule.path}=${formatValue(getByPath(trace.result, rule.path))}`
          ])
        );
      }
      return passing
        ? pass()
        : fail(`Expected ${rule.tool_name} result ${rule.path} to equal ${formatValue(rule.equals)} on turn ${rule.turn}`);
    }

    case 'turn_tool_result_array_min_length': {
      const matches = findToolCalls(context, rule.tool_name, rule.turn);
      const passing = matches.find((trace) => {
        const value = getByPath(trace.result, rule.path);
        return Array.isArray(value) && value.length >= rule.min;
      });
      for (const trace of matches) {
        const value = getByPath(trace.result, rule.path);
        evidence.push(
          stringifyEvidence([
            `turn ${rule.turn}`,
            trace.tool_name,
            `${rule.path}.length=${Array.isArray(value) ? value.length : 'n/a'}`
          ])
        );
      }
      return passing
        ? pass()
        : fail(`Expected ${rule.tool_name} result ${rule.path} to contain at least ${rule.min} item(s) on turn ${rule.turn}`);
    }

    case 'turn_assistant_text_contains_any': {
      const assistantText = getAssistantTextForTurn(context, rule.turn);
      const normalizedText = normalizeText(assistantText);
      evidence.push(`turn ${rule.turn}: ${assistantText || '[no assistant text]'}`);
      const matched = (rule.contains_any || []).find((needle) => normalizedText.includes(normalizeText(needle)));
      return matched
        ? pass()
        : fail(`Expected assistant text on turn ${rule.turn} to contain one of: ${(rule.contains_any || []).join(', ')}`);
    }

    case 'turn_assistant_text_contains_all': {
      const assistantText = getAssistantTextForTurn(context, rule.turn);
      const normalizedText = normalizeText(assistantText);
      evidence.push(`turn ${rule.turn}: ${assistantText || '[no assistant text]'}`);
      const missing = (rule.contains_all || []).filter((needle) => !normalizedText.includes(normalizeText(needle)));
      return missing.length === 0
        ? pass()
        : fail(`Expected assistant text on turn ${rule.turn} to contain: ${(rule.contains_all || []).join(', ')}`);
    }

    case 'tool_called': {
      const matches = findToolCalls(context, rule.tool_name);
      evidence.push(`${matches.length} ${rule.tool_name} call(s)`);
      return matches.length > 0
        ? pass()
        : fail(`Expected ${rule.tool_name} to be called`);
    }

    case 'tool_not_called': {
      const matches = findToolCalls(context, rule.tool_name);
      evidence.push(`${matches.length} ${rule.tool_name} call(s)`);
      return matches.length === 0
        ? pass()
        : fail(`Did not expect ${rule.tool_name} to be called`);
    }

    case 'tool_arg_equals': {
      const matches = findToolCalls(context, rule.tool_name);
      const candidate = occurrence === 'any'
        ? matches.find((trace) => valuesEqual(getByPath(trace.arguments, rule.path), rule.equals))
        : pickOccurrence(matches, occurrence);

      if (candidate) {
        evidence.push(`${candidate.tool_name}.${rule.path}=${formatValue(getByPath(candidate.arguments, rule.path))}`);
      } else {
        evidence.push(`0 ${rule.tool_name} call(s)`);
      }

      if (occurrence === 'any') {
        return candidate
          ? pass()
          : fail(`Expected any ${rule.tool_name} call to set ${rule.path} to ${formatValue(rule.equals)}`);
      }

      return candidate && valuesEqual(getByPath(candidate.arguments, rule.path), rule.equals)
        ? pass()
        : fail(`Expected ${occurrence} ${rule.tool_name} call to set ${rule.path} to ${formatValue(rule.equals)}`);
    }

    case 'tool_result_path_equals': {
      const matches = findToolCalls(context, rule.tool_name);
      const candidate = occurrence === 'any'
        ? matches.find((trace) => valuesEqual(getByPath(trace.result, rule.path), rule.equals))
        : pickOccurrence(matches, occurrence);

      if (candidate) {
        evidence.push(`${candidate.tool_name} result ${rule.path}=${formatValue(getByPath(candidate.result, rule.path))}`);
      } else {
        evidence.push(`0 ${rule.tool_name} call(s)`);
      }

      if (occurrence === 'any') {
        return candidate
          ? pass()
          : fail(`Expected any ${rule.tool_name} result ${rule.path} to equal ${formatValue(rule.equals)}`);
      }

      return candidate && valuesEqual(getByPath(candidate.result, rule.path), rule.equals)
        ? pass()
        : fail(`Expected ${occurrence} ${rule.tool_name} result ${rule.path} to equal ${formatValue(rule.equals)}`);
    }

    case 'tool_arg_matches_tool_result_path': {
      const sourceMatches = findToolCalls(context, rule.source_tool_name);
      const sourceTrace = pickOccurrence(sourceMatches, sourceOccurrence);
      const sourceValue = getByPath(sourceTrace?.result, rule.source_path);
      if (sourceTrace) {
        evidence.push(`${sourceTrace.tool_name} result ${rule.source_path}=${formatValue(sourceValue)}`);
      } else {
        evidence.push(`0 ${rule.source_tool_name} call(s)`);
      }

      const matches = findToolCalls(context, rule.tool_name);
      const candidate = occurrence === 'any'
        ? matches.find((trace) => valuesEqual(getByPath(trace.arguments, rule.path), sourceValue))
        : pickOccurrence(matches, occurrence);

      if (candidate) {
        evidence.push(`${candidate.tool_name}.${rule.path}=${formatValue(getByPath(candidate.arguments, rule.path))}`);
      } else {
        evidence.push(`0 ${rule.tool_name} call(s)`);
      }

      if (!sourceTrace) {
        return fail(`Expected ${rule.source_tool_name} to provide result ${rule.source_path}`);
      }

      if (occurrence === 'any') {
        return candidate
          ? pass()
          : fail(`Expected any ${rule.tool_name} call to reuse ${rule.source_tool_name} result ${rule.source_path} at ${rule.path}`);
      }

      return candidate && valuesEqual(getByPath(candidate.arguments, rule.path), sourceValue)
        ? pass()
        : fail(`Expected ${occurrence} ${rule.tool_name} call to reuse ${rule.source_tool_name} result ${rule.source_path} at ${rule.path}`);
    }

    case 'tool_call_count_at_least': {
      const matches = findToolCalls(context, rule.tool_name);
      evidence.push(`${matches.length} ${rule.tool_name} call(s)`);
      return matches.length >= rule.min
        ? pass()
        : fail(`Expected at least ${rule.min} ${rule.tool_name} call(s)`);
    }

    case 'tool_called_after_tool_result': {
      const sourceEntry = pickOccurrence(
        findTranscriptEntries(context, 'tool_result', rule.source_tool_name),
        sourceOccurrence
      );
      const targetEntries = findTranscriptEntries(context, 'tool_call', rule.tool_name);
      const targetEntry = occurrence === 'any'
        ? targetEntries.find((entry) => sourceEntry && entry.sequence > sourceEntry.sequence) || null
        : pickOccurrence(targetEntries, occurrence);

      evidence.push(
        sourceEntry
          ? `${rule.source_tool_name} result sequence=${sourceEntry.sequence}`
          : `0 ${rule.source_tool_name} result(s)`
      );
      evidence.push(
        targetEntry
          ? `${rule.tool_name} call sequence=${targetEntry.sequence}`
          : `0 ${rule.tool_name} call(s)`
      );

      if (!sourceEntry || !targetEntry) {
        return fail(`Expected ${rule.tool_name} to be called after ${rule.source_tool_name} returned a result`);
      }

      return targetEntry.sequence > sourceEntry.sequence
        ? pass()
        : fail(`Expected ${rule.tool_name} to be called after the ${rule.source_tool_name} result`);
    }

    case 'tool_arg_changed_between_turns': {
      const turnA = pickOccurrence(findToolCalls(context, rule.tool_name, rule.turn_a), 'last');
      const turnB = pickOccurrence(findToolCalls(context, rule.tool_name, rule.turn_b), 'last');
      const valueA = getByPath(turnA?.arguments, rule.path);
      const valueB = getByPath(turnB?.arguments, rule.path);
      evidence.push(`turn ${rule.turn_a}: ${formatValue(valueA)}`);
      evidence.push(`turn ${rule.turn_b}: ${formatValue(valueB)}`);
      if (!turnA || !turnB) {
        return fail(`Expected ${rule.tool_name} calls on turns ${rule.turn_a} and ${rule.turn_b}`);
      }
      return !valuesEqual(valueA, valueB)
        ? pass()
        : fail(`Expected ${rule.tool_name}.${rule.path} to change between turns ${rule.turn_a} and ${rule.turn_b}`);
    }

    case 'create_event_matches_selected_slot': {
      const availability = pickOccurrence(findToolCalls(context, 'checkAvailability', rule.availability_turn), 'last');
      const selectedSlot = availability?.result?.slots?.[rule.selected_slot_index];
      const createEvent = pickOccurrence(findToolCalls(context, 'createEvent'), 'last');
      const requestedStart = createEvent?.arguments?.slotStart;
      const requestedEnd = createEvent?.arguments?.slotEnd;
      const actualStart = createEvent?.result?.appointment?.start ?? requestedStart;
      const actualEnd = createEvent?.result?.appointment?.end ?? requestedEnd;

      evidence.push(`selected slot start=${formatValue(selectedSlot?.start)} end=${formatValue(selectedSlot?.end)}`);
      evidence.push(`createEvent args slotStart=${formatValue(requestedStart)} slotEnd=${formatValue(requestedEnd)}`);
      evidence.push(`createEvent result slotStart=${formatValue(actualStart)} slotEnd=${formatValue(actualEnd)}`);

      if (!availability || !selectedSlot || !createEvent) {
        return fail('Could not compare the selected availability slot with the createEvent payload');
      }

      const requestedStartMatches = dateTimesEqual(requestedStart, selectedSlot.start);
      const requestedEndMatches = dateTimesEqual(requestedEnd, selectedSlot.end);
      if (!requestedStartMatches || !requestedEndMatches) {
        return fail('createEvent did not send the exact selected slot boundaries');
      }

      const slotStartMatches = dateTimesEqual(actualStart, selectedSlot.start);
      const slotEndMatches = dateTimesEqual(actualEnd, selectedSlot.end);
      return slotStartMatches && slotEndMatches
        ? pass()
        : fail('createEvent result did not preserve the selected slot boundaries');
    }

    default:
      evidence.push(`unsupported rule type: ${rule.type}`);
      return fail(`Unsupported rule type: ${rule.type}`);
  }
}

function buildTranscriptExcerpt(context, failedCriteria) {
  const interestingTurns = new Set();
  for (const criterion of failedCriteria) {
    const rule = criterion.rule || {};
    if (rule.turn) {
      interestingTurns.add(rule.turn);
    }
    if (rule.turn_a) {
      interestingTurns.add(rule.turn_a);
    }
    if (rule.turn_b) {
      interestingTurns.add(rule.turn_b);
    }
    if (rule.availability_turn) {
      interestingTurns.add(rule.availability_turn);
    }
  }

  const selectedEntries = interestingTurns.size > 0
    ? context.transcript.filter((entry) => interestingTurns.has(entry.turn))
    : context.transcript.slice(-12);

  return selectedEntries.slice(0, 12).map((entry) => {
    if (entry.kind === 'tool_call') {
      return `T${entry.turn} assistant -> ${entry.tool_name}(${summarizeToolArguments(entry.arguments)})`;
    }
    if (entry.kind === 'tool_result') {
      const summary = typeof entry.result === 'object'
        ? JSON.stringify(entry.result)
        : String(entry.result);
      return `T${entry.turn} tool ${entry.tool_name || 'unknown'} -> ${summary.length <= 220 ? summary : `${summary.slice(0, 217)}...`}`;
    }
    return `T${entry.turn} ${entry.role}: ${entry.text}`;
  });
}

function buildScenarioSummary(context, criteriaResults, error) {
  const failures = criteriaResults.filter((result) => result.required && !result.passed);
  const warnings = criteriaResults.filter((result) => !result.required && !result.passed);
  const bookingCreated = findToolCalls(context, 'createEvent').some((trace) => trace.result?.created === true);
  const receptionTaskCreated = findToolCalls(context, 'createReceptionTask').some((trace) => trace.result?.accepted === true);
  const firstFailure = failures[0] || null;

  return {
    failure_count: failures.length,
    warning_count: warnings.length,
    booking_created: bookingCreated,
    reception_task_created: receptionTaskCreated,
    suspected_root_cause: error
      ? 'runner_or_vapi_chat_failure'
      : firstFailure?.root_cause_hint || null,
    failure_reason: error
      ? error.message
      : firstFailure?.failure_reason || null,
    transcript_excerpt: buildTranscriptExcerpt(context, failures.length > 0 ? failures.map((failure) => ({
      rule: context.scenario.rubric.find((criterion) => criterion.criterion_id === failure.criterion_id)?.rule ||
        context.scenario.turns.flatMap((turn) => turn.assertions || []).find((criterion) => criterion.criterion_id === failure.criterion_id)?.rule ||
        {}
    })) : [])
  };
}

function buildSkippedScenarioRun(scenario, clientConfig, missingToolBindings) {
  const timestamp = stableNowIso();
  const reason = `Required staging tool bindings are missing: ${missingToolBindings.join(', ')}`;

  return {
    schema_version: 'staging-chat-run.v1',
    suite_run_id: clientConfig.suiteRunId,
    scenario_id: scenario.scenario_id,
    title: scenario.title,
    environment: 'staging',
    chat_id: null,
    started_at: timestamp,
    completed_at: timestamp,
    status: 'skipped',
    transcript: [],
    tool_trace: [],
    criteria: [],
    summary: {
      failure_count: 0,
      warning_count: 0,
      booking_created: false,
      reception_task_created: false,
      suspected_root_cause: null,
      failure_reason: reason,
      transcript_excerpt: []
    },
    error: null
  };
}

async function executeScenario(scenario, clientConfig) {
  const missingToolBindings = getMissingRequiredToolBindings(
    scenario,
    clientConfig.enabledToolBindings || new Set()
  );
  if (missingToolBindings.length > 0) {
    return buildSkippedScenarioRun(scenario, clientConfig, missingToolBindings);
  }

  const context = createContext(scenario);
  const startedAt = stableNowIso();

  try {
    let previousChatId = null;

    for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex += 1) {
      const turnNumber = turnIndex + 1;
      const turn = scenario.turns[turnIndex];

      recordTranscriptEntry(context, {
        turn: turnNumber,
        role: 'user',
        kind: 'message',
        text: turn.user,
        tool_name: null,
        tool_call_id: null,
        arguments: null,
        result: null
      });

      const response = await callVapiChat({
        assistantId: clientConfig.assistantId,
        apiKey: clientConfig.apiKey,
        baseUrl: clientConfig.baseUrl,
        previousChatId,
        input: turn.user
      });

      previousChatId = response.id;
      context.chatId = response.id;
      normalizeOutputForTurn(context, turnNumber, response.output);
    }

    const criteria = [
      ...scenario.turns.flatMap((turn) => turn.assertions || []),
      ...scenario.rubric
    ];
    const criteriaResults = criteria.map((criterion) => evaluateCriterion(context, criterion));
    const summary = buildScenarioSummary(context, criteriaResults, null);
    const status = summary.failure_count === 0 ? 'passed' : 'failed';

    return {
      schema_version: 'staging-chat-run.v1',
      suite_run_id: clientConfig.suiteRunId,
      scenario_id: scenario.scenario_id,
      title: scenario.title,
      environment: 'staging',
      chat_id: context.chatId,
      started_at: startedAt,
      completed_at: stableNowIso(),
      status,
      transcript: context.transcript,
      tool_trace: context.toolTrace,
      criteria: criteriaResults,
      summary,
      error: null
    };
  } catch (error) {
    const summary = buildScenarioSummary(context, [], error);
    return {
      schema_version: 'staging-chat-run.v1',
      suite_run_id: clientConfig.suiteRunId,
      scenario_id: scenario.scenario_id,
      title: scenario.title,
      environment: 'staging',
      chat_id: context.chatId,
      started_at: startedAt,
      completed_at: stableNowIso(),
      status: 'error',
      transcript: context.transcript,
      tool_trace: context.toolTrace,
      criteria: [],
      summary,
      error: {
        message: error.message
      }
    };
  }
}

function toRelativePath(filePath) {
  return path.relative(ROOT_DIR, filePath) || '.';
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function renderMarkdownReport(suiteSummary, scenarioRuns) {
  const lines = [
    '# Staging Regression Suite Report',
    '',
    `- Suite run: \`${suiteSummary.suite_run_id}\``,
    `- Environment: \`${suiteSummary.environment}\``,
    `- Started: \`${suiteSummary.started_at}\``,
    `- Completed: \`${suiteSummary.completed_at}\``,
    `- Status: **${suiteSummary.status.toUpperCase()}**`,
    `- Scenarios: ${suiteSummary.passed_count} passed, ${suiteSummary.skipped_count} skipped, ${suiteSummary.failed_count} failed`,
    '',
    '## Scenario Summary',
    '',
    '| Scenario | Status | Failure Reason | Suspected Root Cause |',
    '| --- | --- | --- | --- |'
  ];

  for (const scenario of suiteSummary.scenario_results) {
    lines.push(
      `| \`${scenario.scenario_id}\` | ${scenario.status.toUpperCase()} | ${scenario.failure_reason || 'none'} | ${scenario.suspected_root_cause || 'n/a'} |`
    );
  }

  for (const scenarioRun of scenarioRuns) {
    const failedCriteria = scenarioRun.criteria.filter((criterion) => criterion.required && !criterion.passed);

    lines.push('', `## ${scenarioRun.title}`, '');
    lines.push(`- Scenario ID: \`${scenarioRun.scenario_id}\``);
    lines.push(`- Status: **${scenarioRun.status.toUpperCase()}**`);
    lines.push(`- Chat ID: \`${scenarioRun.chat_id || 'n/a'}\``);
    lines.push(`- Failure reason: ${scenarioRun.summary.failure_reason || 'none'}`);
    lines.push(`- Suspected root cause: ${scenarioRun.summary.suspected_root_cause || 'n/a'}`);
    lines.push(`- Booking created: ${scenarioRun.summary.booking_created ? 'yes' : 'no'}`);
    lines.push(`- Reception task created: ${scenarioRun.summary.reception_task_created ? 'yes' : 'no'}`);

    if (scenarioRun.status === 'skipped') {
      lines.push(`- Skip reason: ${scenarioRun.summary.failure_reason || 'missing required tool bindings'}`);
    }

    if (failedCriteria.length > 0) {
      lines.push('', 'Failed criteria:');
      for (const criterion of failedCriteria) {
        lines.push(`- \`${criterion.criterion_id}\`: ${criterion.failure_reason}`);
      }
    }

    if (scenarioRun.error?.message) {
      lines.push('', `Runner error: ${scenarioRun.error.message}`);
    }

    if (scenarioRun.summary.transcript_excerpt.length > 0) {
      lines.push('', 'Transcript excerpt:', '', '```text');
      lines.push(...scenarioRun.summary.transcript_excerpt);
      lines.push('```');
    }
  }

  return `${lines.join('\n')}\n`;
}

function printConsoleSummary(suiteSummary) {
  console.log('');
  console.log(
    `Suite ${suiteSummary.suite_run_id}: ${suiteSummary.passed_count} passed, ${suiteSummary.skipped_count} skipped, ${suiteSummary.failed_count} failed`
  );
  for (const scenario of suiteSummary.scenario_results) {
    const status = scenario.status.toUpperCase().padEnd(7, ' ');
    const suffix = scenario.failure_reason ? ` - ${scenario.failure_reason}` : '';
    console.log(`${status} ${scenario.scenario_id}${suffix}`);
  }
  console.log(`Artifacts: ${suiteSummary.run_dir}`);
  console.log(`Report: ${suiteSummary.report_path}`);
}

async function main() {
  loadRootEnvIfPresent();
  const options = parseArgs(process.argv.slice(2));
  const scenarios = loadScenarios(options.scenarioIds, options.includeDraft);

  if (options.listOnly) {
    printScenarioList(scenarios);
    return;
  }

  const bindings = readJson(STAGING_BINDINGS_PATH);
  const assistantId = bindings.assistantId;
  const enabledToolBindings = getEnabledToolBindings(bindings);
  const apiKey = process.env.STAGING_VAPI_API_KEY || process.env.VAPI_API_KEY || '';
  const baseUrl = process.env.VAPI_API_BASE_URL || 'https://api.vapi.ai';

  if (!assistantId) {
    throw new Error(`assistantId is required in ${STAGING_BINDINGS_PATH}`);
  }
  if (!apiKey) {
    throw new Error('STAGING_VAPI_API_KEY or VAPI_API_KEY is required');
  }

  const suiteRunId = `staging-regression-${compactTimestamp()}`;
  const outputDir = options.outputDir || path.join(DEFAULT_RUNS_DIR, suiteRunId);
  const reportPath = options.reportPath || path.join(DEFAULT_REPORTS_DIR, `${suiteRunId}.md`);
  const scenarioOutputDir = path.join(outputDir, 'scenarios');

  ensureDir(outputDir);
  ensureDir(scenarioOutputDir);
  ensureDir(path.dirname(reportPath));

  const startedAt = stableNowIso();
  const clientConfig = {
    assistantId,
    apiKey,
    baseUrl,
    suiteRunId,
    enabledToolBindings
  };

  const scenarioRuns = [];
  for (const scenario of scenarios) {
    console.log(`Running ${scenario.scenario_id}...`);
    const result = await executeScenario(scenario, clientConfig);
    const resultPath = path.join(scenarioOutputDir, `${scenario.scenario_id}.result.v1.json`);
    writeJson(resultPath, result);
    result.__resultPath = resultPath;
    scenarioRuns.push(result);
  }

  const passedCount = scenarioRuns.filter((scenario) => scenario.status === 'passed').length;
  const skippedCount = scenarioRuns.filter((scenario) => scenario.status === 'skipped').length;
  const failedCount = scenarioRuns.filter(
    (scenario) => scenario.status === 'failed' || scenario.status === 'error'
  ).length;
  const suiteSummary = {
    schema_version: 'staging-chat-suite.v1',
    suite_run_id: suiteRunId,
    environment: 'staging',
    started_at: startedAt,
    completed_at: stableNowIso(),
    status: failedCount === 0 ? 'passed' : 'failed',
    scenario_count: scenarioRuns.length,
    passed_count: passedCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    run_dir: toRelativePath(outputDir),
    report_path: toRelativePath(reportPath),
    scenario_results: scenarioRuns.map((scenario) => ({
      scenario_id: scenario.scenario_id,
      title: scenario.title,
      status: scenario.status,
      result_path: toRelativePath(scenario.__resultPath),
      failure_reason: scenario.summary.failure_reason,
      suspected_root_cause: scenario.summary.suspected_root_cause
    }))
  };

  const suiteJsonPath = path.join(outputDir, 'suite.result.v1.json');
  writeJson(suiteJsonPath, suiteSummary);
  fs.writeFileSync(reportPath, renderMarkdownReport(suiteSummary, scenarioRuns), 'utf8');

  printConsoleSummary(suiteSummary);

  if (suiteSummary.status !== 'passed') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  module.exports = {
    createContext,
    normalizeOutputForTurn,
    evaluateCriterion,
    resolveScenarioTemplates,
    getEnabledToolBindings,
    getMissingRequiredToolBindings
  };
}
