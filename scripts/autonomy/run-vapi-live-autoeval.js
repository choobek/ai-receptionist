#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const {
  buildRun,
  writeRun
} = require(path.join(__dirname, 'ingest-vapi-call-log.js'));

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const RUNS_ROOT = path.join(ROOT_DIR, 'autonomy', 'runs', 'generated', 'vapi-live-autoeval');
const REPORTS_ROOT = path.join(ROOT_DIR, 'autonomy', 'reports', 'generated', 'vapi-live-autoeval');
const POLICY_PATH = path.join(ROOT_DIR, 'configs', 'vapi', 'autoevaluation-policy.v1.json');
const ENVIRONMENTS_DIR = path.join(ROOT_DIR, 'configs', 'vapi', 'environments');
const MODEL_DOMINANT_REVIEW_THRESHOLD_MS = 4000;
const MODEL_DOMINANT_HIGH_THRESHOLD_MS = 7000;

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
  const apiKey = process.env[`${prefix}_VAPI_API_KEY`] || process.env.VAPI_API_KEY || '';
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
    case 'scorecards_missing':
      return 'no Vapi scorecards were attached to the call artifact';
    default:
      return reason.message || reason.code || 'review required';
  }
}

function evaluateRunAgainstPolicy(run, policy) {
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

function summarizeSuite({ suiteRunId, environment, assistantId, calls, reviews, suitePaths, startedAt, completedAt, policyPath }) {
  const reviewCounts = { high: 0, medium: 0, low: 0 };
  const reasonCounts = new Map();
  const coverageWarningCounts = new Map();
  const scorecardBuckets = new Map();
  const dominantLatencyStageCounts = new Map();
  const maxModelLatencies = [];
  const maxTranscriberLatencies = [];
  const maxEndpointingLatencies = [];
  const maxWebhookLatencies = [];

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
    if (typeof latency?.maxWebhookLatencyMs === 'number') {
      maxWebhookLatencies.push(latency.maxWebhookLatencyMs);
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
      average_max_webhook_latency_ms: roundMaybe(average(maxWebhookLatencies)),
      dominant_latency_stage_counts: Array.from(dominantLatencyStageCounts.entries())
        .map(([stage, count]) => ({ stage, count }))
        .sort((left, right) => right.count - left.count || left.stage.localeCompare(right.stage))
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
  if (
    typeof latencySummary.average_max_model_latency_ms === 'number'
    || typeof latencySummary.average_max_transcriber_latency_ms === 'number'
    || typeof latencySummary.average_max_endpointing_latency_ms === 'number'
    || typeof latencySummary.average_max_webhook_latency_ms === 'number'
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
    if (typeof latencySummary.average_max_webhook_latency_ms === 'number') {
      lines.push(`- Average max webhook latency: ${latencySummary.average_max_webhook_latency_ms}ms`);
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
        if (typeof latency.maxWebhookLatencyMs === 'number') {
          latencyParts.push(`webhook=${latency.maxWebhookLatencyMs}ms`);
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

  const calls = [];
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
    writeRun(run, normalizedRunPath);

    const review = evaluateRunAgainstPolicy(run, policy);
    calls.push({
      call_id: run.call.call_id,
      ended_at: run.call.ended_at,
      raw_call_path: rawCallPath ? path.relative(ROOT_DIR, rawCallPath) : null,
      run_path: path.relative(ROOT_DIR, normalizedRunPath),
      failure_category: run.evaluation?.result?.failure_category || 'other',
      summary: run.evaluation?.result?.summary || null,
      scorecards: buildScorecardSummary(run),
      latency_diagnostics: run.call?.latency_diagnostics || null,
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
    policyPath: path.relative(ROOT_DIR, POLICY_PATH)
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

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
