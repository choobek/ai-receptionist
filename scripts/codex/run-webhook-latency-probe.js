#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const RUNS_ROOT = path.join(ROOT_DIR, 'autonomy', 'runs', 'generated', 'codex');
const REPORTS_ROOT = path.join(ROOT_DIR, 'autonomy', 'reports', 'generated', 'codex');
const FUTURE_CLINIC_DAY = '2030-03-18';

function usage() {
  console.log(`Usage:
  ./scripts/run-webhook-latency-probe.sh [environment] [options]
  node scripts/codex/run-webhook-latency-probe.js [options]

Options:
  --environment <name>    staging | production. Default: staging.
  --samples <n>           Number of attempts per probe. Default: 3.
  --timeout-ms <n>        Per-request timeout in milliseconds. Default: 15000.
  --probe <id>            Probe id to run. Repeatable. Default: all safe probes.
  --output-dir <path>     Override the generated run directory.
  --report <path>         Override the generated Markdown report path.
  --summary-json <path>   Write the suite summary JSON to this path.
  --fail-on-budget        Exit non-zero when a probe exceeds its configured latency budget.
  --help                  Show this help message.
`);
}

function parseArgs(argv) {
  const options = {
    environment: 'staging',
    samples: 3,
    timeoutMs: 15000,
    probes: [],
    outputDir: null,
    reportPath: null,
    summaryJson: null,
    failOnBudget: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--fail-on-budget') {
      options.failOnBudget = true;
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
      case '--samples':
        options.samples = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--probe':
        options.probes.push(next);
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
  if (!Number.isInteger(options.samples) || options.samples <= 0) {
    throw new Error('--samples must be a positive integer');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }

  return options;
}

function stableTimestamp() {
  return new Date().toISOString();
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function roundMaybe(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 10) / 10
    : null;
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pathRelativeToRoot(filePath) {
  return path.relative(ROOT_DIR, filePath);
}

function buildSuitePaths(suiteRunId, options) {
  const runDir = options.outputDir || path.join(RUNS_ROOT, suiteRunId);
  return {
    suiteRunId,
    runDir,
    reportPath: options.reportPath || path.join(REPORTS_ROOT, `${suiteRunId}.md`)
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('WEBHOOK_LATENCY_BASE_URL is required');
  }
  return trimmed.endsWith('/webhook/ai-receptionist')
    ? trimmed
    : `${trimmed}/webhook/ai-receptionist`;
}

function buildHeaders(secret) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'ai-receptionist-webhook-latency-probe/1.0'
  };
  if (secret) {
    headers['X-AI-Receptionist-Secret'] = secret;
  }
  return headers;
}

function sortedCounts(map) {
  return Array.from(map.entries())
    .map(([key, count]) => ({ key: String(key), count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function trimPreview(value, limit = 240) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) {
    return null;
  }
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function buildProbeDefinitions() {
  return [
    {
      id: 'lookup-patient-basic',
      toolName: 'lookupPatient',
      description: 'Normalize a local Polish phone number through the public patient lookup webhook.',
      endpointPath: '/lookup-patient',
      latencyBudgetMs: null,
      buildBody: ({ suiteRunId, attempt }) => ({
        requestId: `${suiteRunId}_lookup_${attempt}`,
        phoneRaw: '500111001'
      }),
      validate(response) {
        const phone = response && typeof response === 'object' ? response.phone : null;
        if (!phone || typeof phone !== 'object') {
          throw new Error('response.phone is missing');
        }
        if (typeof phone.normalizedE164 !== 'string' || !phone.normalizedE164.startsWith('+')) {
          throw new Error('phone.normalizedE164 is missing');
        }
        if (typeof phone.readbackPrompt !== 'string' || !phone.readbackPrompt.trim()) {
          throw new Error('phone.readbackPrompt is missing');
        }
      }
    },
    {
      id: 'search-knowledge-base-basic',
      toolName: 'searchKnowledgeBase',
      description: 'Query the public knowledge-base webhook with a stable clinic-information question.',
      endpointPath: '/search-knowledge-base',
      latencyBudgetMs: 3000,
      buildBody: ({ suiteRunId, attempt }) => ({
        requestId: `${suiteRunId}_kb_${attempt}`,
        query: 'Czym rozni sie bonding od licowek?',
        limit: 2,
        language: 'pl'
      }),
      validate(response) {
        if (typeof response?.found !== 'boolean') {
          throw new Error('found is missing');
        }
        if (!Array.isArray(response.matches)) {
          throw new Error('matches are missing');
        }
        if (response.found === true) {
          if (typeof response.answer !== 'string' || !response.answer.trim()) {
            throw new Error('answer is missing');
          }
          return;
        }
        if (typeof response.message !== 'string' || !response.message.trim()) {
          throw new Error('message is missing');
        }
      }
    },
    {
      id: 'check-availability-specific-day',
      toolName: 'checkAvailability',
      description: 'Probe a same-day windowed availability lookup on a fixed future clinic day.',
      endpointPath: '/check-availability',
      latencyBudgetMs: 1800,
      buildBody: ({ suiteRunId, attempt }) => ({
        requestId: `${suiteRunId}_check_specific_${attempt}`,
        service: {
          id: 'consultation',
          name: 'Konsultacja',
          durationMinutes: 45
        },
        requestedDate: FUTURE_CLINIC_DAY,
        timePreference: 'morning',
        timezone: 'Europe/Warsaw',
        limit: 3,
        patient: {
          isExistingPatient: false
        }
      }),
      validate: validateAvailabilityResponse
    },
    {
      id: 'check-availability-first-available',
      toolName: 'checkAvailability',
      description: 'Probe the wider first-available availability search that has historically dominated webhook latency.',
      endpointPath: '/check-availability',
      latencyBudgetMs: 1800,
      buildBody: ({ suiteRunId, attempt }) => ({
        requestId: `${suiteRunId}_check_first_available_${attempt}`,
        service: {
          id: 'consultation',
          name: 'Konsultacja',
          durationMinutes: 45
        },
        timePreference: 'first_available',
        timezone: 'Europe/Warsaw',
        limit: 3,
        searchDays: 5,
        patient: {
          isExistingPatient: false
        }
      }),
      validate: validateAvailabilityResponse
    },
    {
      id: 'check-availability-urgent-first-available',
      toolName: 'checkAvailability',
      description: 'Probe the urgent-consultation first-available search that showed up in slow-call evidence.',
      endpointPath: '/check-availability',
      latencyBudgetMs: 1800,
      buildBody: ({ suiteRunId, attempt }) => ({
        requestId: `${suiteRunId}_check_urgent_${attempt}`,
        service: {
          id: 'urgent_consultation',
          name: 'Pilna konsultacja',
          durationMinutes: 45
        },
        timePreference: 'first_available',
        timezone: 'Europe/Warsaw',
        limit: 3,
        searchDays: 5,
        patient: {
          isExistingPatient: false
        }
      }),
      validate: validateAvailabilityResponse
    },
    {
      id: 'create-reception-task-basic',
      toolName: 'createReceptionTask',
      description: 'Probe the receptionist handoff webhook without touching booking state.',
      endpointPath: '/create-reception-task',
      latencyBudgetMs: 1800,
      buildBody: ({ suiteRunId, attempt }) => ({
        requestId: `${suiteRunId}_task_${attempt}`,
        taskType: 'existing_patient_booking',
        patient: {
          fullName: 'Test Latency Probe',
          phoneE164: '+48500111001',
          isExistingPatient: true
        },
        serviceBucket: 'consultation',
        preferredCallbackWindow: 'morning',
        telephony: {
          callerPhoneE164: '+48500111001',
          callerPhoneSource: 'probe'
        }
      }),
      validate(response) {
        if (response?.accepted !== true) {
          throw new Error('accepted is not true');
        }
        if (typeof response.taskId !== 'string' || !response.taskId.trim()) {
          throw new Error('taskId is missing');
        }
      }
    }
  ];
}

function validateAvailabilityResponse(response) {
  if (typeof response?.available !== 'boolean') {
    throw new Error('available is missing');
  }
  if (!Array.isArray(response.slots)) {
    throw new Error('slots are missing');
  }
  if (response.available === true && response.slots.length === 0) {
    throw new Error('available=true but slots are empty');
  }
  if (typeof response.message !== 'string' || !response.message.trim()) {
    throw new Error('message is missing');
  }
}

async function postJson({ url, headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = stableTimestamp();
  const startedAtPerf = performance.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const durationMs = performance.now() - startedAtPerf;
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return {
      startedAt,
      completedAt: stableTimestamp(),
      durationMs,
      httpStatus: response.status,
      ok: response.ok,
      text,
      json: parsed
    };
  } catch (error) {
    const durationMs = performance.now() - startedAtPerf;
    return {
      startedAt,
      completedAt: stableTimestamp(),
      durationMs,
      httpStatus: null,
      ok: false,
      text: null,
      json: null,
      error: error?.name === 'AbortError'
        ? `request timed out after ${timeoutMs}ms`
        : (error?.message || String(error))
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runProbe(probe, context) {
  const samples = [];

  for (let attempt = 1; attempt <= context.samples; attempt += 1) {
    const body = probe.buildBody({
      suiteRunId: context.suiteRunId,
      attempt
    });
    const result = await postJson({
      url: `${context.webhookBase}${probe.endpointPath}`,
      headers: context.headers,
      body,
      timeoutMs: context.timeoutMs
    });

    let validationPassed = false;
    let validationError = null;
    let responsePreview = null;

    if (result.error) {
      validationError = result.error;
    } else if (!result.ok) {
      validationError = `HTTP ${result.httpStatus}`;
      responsePreview = trimPreview(result.text);
    } else if (!result.json || typeof result.json !== 'object') {
      validationError = 'response is not valid JSON';
      responsePreview = trimPreview(result.text);
    } else {
      try {
        probe.validate(result.json);
        validationPassed = true;
        responsePreview = trimPreview(result.json);
      } catch (error) {
        validationError = error?.message || String(error);
        responsePreview = trimPreview(result.json);
      }
    }

    const durationMs = roundMaybe(result.durationMs);
    const budgetBreached = typeof probe.latencyBudgetMs === 'number'
      ? durationMs > probe.latencyBudgetMs
      : false;

    samples.push({
      attempt,
      started_at: result.startedAt,
      completed_at: result.completedAt,
      duration_ms: durationMs,
      http_status: result.httpStatus,
      ok: Boolean(result.ok),
      validation_passed: validationPassed,
      budget_breached: budgetBreached,
      error: validationError,
      response_preview: responsePreview
    });
  }

  return summarizeProbe(probe, samples);
}

function summarizeProbe(probe, samples) {
  const durations = samples
    .map((sample) => sample.duration_ms)
    .filter((value) => typeof value === 'number');
  const httpStatuses = new Map();
  let successCount = 0;
  let failureCount = 0;
  let budgetBreachCount = 0;

  for (const sample of samples) {
    if (sample.http_status !== null) {
      httpStatuses.set(String(sample.http_status), (httpStatuses.get(String(sample.http_status)) || 0) + 1);
    }
    if (sample.validation_passed) {
      successCount += 1;
    } else {
      failureCount += 1;
    }
    if (sample.budget_breached) {
      budgetBreachCount += 1;
    }
  }

  let status = 'passed';
  if (failureCount > 0) {
    status = 'failed';
  } else if (budgetBreachCount > 0) {
    status = 'budget_breached';
  }

  return {
    probe_id: probe.id,
    tool_name: probe.toolName,
    description: probe.description,
    endpoint_path: probe.endpointPath,
    latency_budget_ms: probe.latencyBudgetMs,
    status,
    sample_count: samples.length,
    success_count: successCount,
    failure_count: failureCount,
    budget_breach_count: budgetBreachCount,
    average_latency_ms: roundMaybe(average(durations)),
    max_latency_ms: roundMaybe(Math.max(...durations)),
    min_latency_ms: roundMaybe(Math.min(...durations)),
    http_status_counts: sortedCounts(httpStatuses).map((item) => ({
      status: item.key,
      count: item.count
    })),
    samples
  };
}

function summarizeSuite({ suiteRunId, environment, suitePaths, startedAt, completedAt, webhookBase, timeoutMs, samplesPerProbe, probes }) {
  const allDurations = [];
  const probeAverageDurations = [];
  const probeMaxDurations = [];
  let failedProbeCount = 0;
  let budgetBreachedProbeCount = 0;

  for (const probe of probes) {
    if (probe.status === 'failed') {
      failedProbeCount += 1;
    } else if (probe.status === 'budget_breached') {
      budgetBreachedProbeCount += 1;
    }
    if (typeof probe.average_latency_ms === 'number') {
      probeAverageDurations.push(probe.average_latency_ms);
    }
    if (typeof probe.max_latency_ms === 'number') {
      probeMaxDurations.push(probe.max_latency_ms);
    }
    for (const sample of probe.samples) {
      if (typeof sample.duration_ms === 'number') {
        allDurations.push(sample.duration_ms);
      }
    }
  }

  return {
    schema_version: 'codex-webhook-latency-probe-suite.v1',
    suite_run_id: suiteRunId,
    environment,
    webhook_base: webhookBase,
    started_at: startedAt,
    completed_at: completedAt,
    probe_count: probes.length,
    sample_count_per_probe: samplesPerProbe,
    timeout_ms: timeoutMs,
    failed_probe_count: failedProbeCount,
    budget_breached_probe_count: budgetBreachedProbeCount,
    passed_probe_count: probes.length - failedProbeCount - budgetBreachedProbeCount,
    latency_summary: {
      average_all_samples_latency_ms: roundMaybe(average(allDurations)),
      average_probe_average_latency_ms: roundMaybe(average(probeAverageDurations)),
      average_probe_max_latency_ms: roundMaybe(average(probeMaxDurations))
    },
    run_dir: pathRelativeToRoot(suitePaths.runDir),
    report_path: pathRelativeToRoot(suitePaths.reportPath),
    probes
  };
}

function renderSuiteReport(summary) {
  const lines = [
    '# Webhook Latency Probe',
    '',
    `- Suite run: \`${summary.suite_run_id}\``,
    `- Environment: \`${summary.environment}\``,
    `- Webhook base: \`${summary.webhook_base}\``,
    `- Started: \`${summary.started_at}\``,
    `- Completed: \`${summary.completed_at}\``,
    `- Probes: ${summary.probe_count}`,
    `- Samples per probe: ${summary.sample_count_per_probe}`,
    `- Failed probes: ${summary.failed_probe_count}`,
    `- Budget-breached probes: ${summary.budget_breached_probe_count}`,
    `- Passed probes: ${summary.passed_probe_count}`,
    ''
  ];

  if (summary.latency_summary) {
    lines.push('## Latency Summary', '');
    if (typeof summary.latency_summary.average_all_samples_latency_ms === 'number') {
      lines.push(`- Average all-samples latency: ${summary.latency_summary.average_all_samples_latency_ms}ms`);
    }
    if (typeof summary.latency_summary.average_probe_average_latency_ms === 'number') {
      lines.push(`- Average probe average latency: ${summary.latency_summary.average_probe_average_latency_ms}ms`);
    }
    if (typeof summary.latency_summary.average_probe_max_latency_ms === 'number') {
      lines.push(`- Average probe max latency: ${summary.latency_summary.average_probe_max_latency_ms}ms`);
    }
    lines.push('');
  }

  lines.push('## Probe Results', '');
  for (const probe of summary.probes) {
    lines.push(`### ${probe.probe_id}`);
    lines.push('');
    lines.push(`- Tool: \`${probe.tool_name}\``);
    lines.push(`- Status: **${probe.status.toUpperCase()}**`);
    lines.push(`- Endpoint: \`${probe.endpoint_path}\``);
    lines.push(`- Description: ${probe.description}`);
    if (typeof probe.latency_budget_ms === 'number') {
      lines.push(`- Latency budget: ${probe.latency_budget_ms}ms`);
    } else {
      lines.push('- Latency budget: not configured');
    }
    if (typeof probe.average_latency_ms === 'number') {
      lines.push(`- Average latency: ${probe.average_latency_ms}ms`);
    }
    if (typeof probe.max_latency_ms === 'number') {
      lines.push(`- Max latency: ${probe.max_latency_ms}ms`);
    }
    if (typeof probe.min_latency_ms === 'number') {
      lines.push(`- Min latency: ${probe.min_latency_ms}ms`);
    }
    if (probe.http_status_counts.length > 0) {
      lines.push(`- HTTP statuses: ${probe.http_status_counts.map((item) => `${item.status}=${item.count}`).join(', ')}`);
    }
    for (const sample of probe.samples) {
      let sampleLine = `- Attempt ${sample.attempt}: ${sample.duration_ms}ms`;
      if (sample.http_status !== null) {
        sampleLine += `, HTTP ${sample.http_status}`;
      }
      if (sample.validation_passed) {
        sampleLine += ', validated';
      } else {
        sampleLine += `, error: ${sample.error || 'validation failed'}`;
      }
      if (sample.budget_breached) {
        sampleLine += ', budget breached';
      }
      lines.push(sampleLine);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const webhookBase = normalizeBaseUrl(process.env.WEBHOOK_LATENCY_BASE_URL || '');
  const webhookSecret = String(process.env.WEBHOOK_LATENCY_SECRET || '').trim();
  const allProbes = buildProbeDefinitions();
  const availableProbeIds = new Set(allProbes.map((probe) => probe.id));

  if (options.probes.length > 0) {
    for (const probeId of options.probes) {
      if (!availableProbeIds.has(probeId)) {
        throw new Error(`Unknown probe id: ${probeId}`);
      }
    }
  }

  const selectedProbes = options.probes.length > 0
    ? allProbes.filter((probe) => options.probes.includes(probe.id))
    : allProbes;
  const suiteRunId = `codex-${options.environment}-webhook-latency-probe-${compactTimestamp()}`;
  const suitePaths = buildSuitePaths(suiteRunId, options);
  const startedAt = stableTimestamp();
  const headers = buildHeaders(webhookSecret);

  fs.mkdirSync(suitePaths.runDir, { recursive: true });

  const probes = [];
  for (const probe of selectedProbes) {
    console.log(`Running ${probe.id} (${probe.toolName})...`);
    probes.push(await runProbe(probe, {
      suiteRunId,
      webhookBase,
      headers,
      timeoutMs: options.timeoutMs,
      samples: options.samples
    }));
  }

  const completedAt = stableTimestamp();
  const summary = summarizeSuite({
    suiteRunId,
    environment: options.environment,
    suitePaths,
    startedAt,
    completedAt,
    webhookBase,
    timeoutMs: options.timeoutMs,
    samplesPerProbe: options.samples,
    probes
  });

  writeJson(path.join(suitePaths.runDir, 'suite.summary.json'), summary);
  fs.mkdirSync(path.dirname(suitePaths.reportPath), { recursive: true });
  fs.writeFileSync(suitePaths.reportPath, renderSuiteReport(summary), 'utf8');

  if (options.summaryJson) {
    writeJson(options.summaryJson, summary);
  }

  console.log(
    `Webhook latency probe ${suiteRunId}: ${summary.failed_probe_count} failed, `
    + `${summary.budget_breached_probe_count} budget breached, ${summary.passed_probe_count} passed\n`
    + `Artifacts: ${summary.run_dir}\n`
    + `Report: ${summary.report_path}`
  );

  if (summary.failed_probe_count > 0) {
    process.exit(1);
  }
  if (options.failOnBudget && summary.budget_breached_probe_count > 0) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
