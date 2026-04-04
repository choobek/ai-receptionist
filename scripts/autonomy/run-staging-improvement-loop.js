#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const STAGING_BINDINGS_PATH = path.join(ROOT_DIR, 'configs', 'vapi', 'environments', 'staging.json');
const SCENARIOS_DIR = path.join(ROOT_DIR, 'autonomy', 'scenarios', 'staging');
const GENERATED_SCENARIOS_DIR = path.join(ROOT_DIR, 'autonomy', 'scenarios', 'generated', 'staging');
const LOOP_RUNS_ROOT = path.join(ROOT_DIR, 'autonomy', 'runs', 'generated', 'staging-loop');
const LOOP_REPORTS_ROOT = path.join(ROOT_DIR, 'autonomy', 'reports', 'generated', 'staging-loop');
const DEFAULT_FETCH_RECENT_CALLS = 0;
const DEFAULT_MAX_ITERATIONS = 2;
const SUPPORTED_ENVIRONMENT = 'staging';

const severityRank = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

const categoryLabels = {
  prompt_issue: 'prompt issue',
  tool_contract_mismatch: 'tool contract mismatch',
  schema_gap: 'schema gap',
  workflow_logic_bug: 'workflow logic bug',
  environment_or_config_issue: 'environment/config issue',
  bad_scenario_false_failure: 'bad scenario / false failure'
};

function usage() {
  console.log(`Usage:
  node scripts/autonomy/run-staging-improvement-loop.js [options]

Options:
  --environment staging      The only supported environment. Default: staging.
  --scenario <id>            Run only the named staging scenario. Repeatable.
  --calls-export <path>      Ingest a local Vapi calls export. Repeatable.
  --fetch-recent-calls <n>   Fetch the most recent staging Vapi call logs before ingesting.
  --max-iterations <n>       Safety cap for fix/apply/rerun cycles. Default: ${DEFAULT_MAX_ITERATIONS}.
  --nightly                  Enable unattended-friendly defaults for staging-only iteration.
  --allow-dirty              Allow running with a dirty git worktree.
  --no-sync                  Never deploy/sync staging, even if a runtime-affecting fixer lands.
  --dry-run                  Generate reports and plans without mutating repo files or staging.
  --help                     Show this help message.
`);
}

function parseArgs(argv) {
  const options = {
    environment: SUPPORTED_ENVIRONMENT,
    scenarioIds: [],
    callsExports: [],
    fetchRecentCalls: DEFAULT_FETCH_RECENT_CALLS,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    nightly: false,
    allowDirty: false,
    syncEnabled: true,
    dryRun: false,
    stopIfRegressionsIncrease: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--nightly') {
      options.nightly = true;
      continue;
    }
    if (arg === '--allow-dirty') {
      options.allowDirty = true;
      continue;
    }
    if (arg === '--no-sync') {
      options.syncEnabled = false;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
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
      case '--scenario':
        options.scenarioIds.push(next);
        index += 1;
        break;
      case '--calls-export':
        options.callsExports.push(path.resolve(next));
        index += 1;
        break;
      case '--fetch-recent-calls':
        options.fetchRecentCalls = Number.parseInt(next, 10);
        if (!Number.isInteger(options.fetchRecentCalls) || options.fetchRecentCalls < 0) {
          throw new Error('--fetch-recent-calls must be a non-negative integer');
        }
        index += 1;
        break;
      case '--max-iterations':
        options.maxIterations = Number.parseInt(next, 10);
        if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1 || options.maxIterations > 10) {
          throw new Error('--max-iterations must be between 1 and 10');
        }
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.environment !== SUPPORTED_ENVIRONMENT) {
    throw new Error('This controller is staging-only. Use --environment staging or omit the flag.');
  }

  if (options.nightly) {
    options.fetchRecentCalls = Math.max(options.fetchRecentCalls, 10);
    options.maxIterations = 1;
  }

  return options;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function replaceExactOrThrow(content, searchValue, replacementValue, label) {
  if (!content.includes(searchValue)) {
    throw new Error(`Could not find expected text while updating ${label}`);
  }
  return content.replace(searchValue, replacementValue);
}

function stableNowIso() {
  return new Date().toISOString();
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}

function toRelativePath(filePath) {
  return path.relative(ROOT_DIR, filePath) || '.';
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

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT_DIR,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const ok = result.status === 0;

  if (!ok && !options.allowFailure) {
    const error = new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`.trim(),
        stdout.trim(),
        stderr.trim()
      ].filter(Boolean).join('\n')
    );
    error.command = command;
    error.args = args;
    error.stdout = stdout;
    error.stderr = stderr;
    error.exitCode = result.status;
    throw error;
  }

  return {
    ok,
    command: [command, ...args].join(' '),
    exitCode: result.status,
    stdout,
    stderr
  };
}

function listResultFiles(rootDir, suffix) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const results = [];

  function visit(currentPath) {
    const stat = fs.statSync(currentPath);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(currentPath)) {
        visit(path.join(currentPath, entry));
      }
      return;
    }
    if (currentPath.endsWith(suffix)) {
      results.push(currentPath);
    }
  }

  visit(rootDir);
  return results.sort();
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function highestFailureSeverity(criteria) {
  const failed = criteria.filter((criterion) => criterion.required && !criterion.passed);
  if (failed.length === 0) {
    return null;
  }
  return failed.reduce((highest, criterion) => (
    severityRank[criterion.severity] > severityRank[highest] ? criterion.severity : highest
  ), failed[0].severity);
}

function gitStatusShort() {
  return runCommand('git', ['status', '--short', '--untracked-files=all'], { allowFailure: false }).stdout.trim();
}

function gitCurrentBranch() {
  return runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: false }).stdout.trim();
}

function gitHeadSha() {
  return runCommand('git', ['rev-parse', 'HEAD'], { allowFailure: false }).stdout.trim();
}

function buildLoopPaths(loopRunId) {
  const runDir = path.join(LOOP_RUNS_ROOT, loopRunId);
  const reportPath = path.join(LOOP_REPORTS_ROOT, `${loopRunId}.md`);
  return {
    loopRunId,
    runDir,
    reportPath,
    baselineDir: path.join(runDir, 'baseline'),
    baselineSuiteDir: path.join(runDir, 'baseline', 'suite'),
    baselineSuiteReport: path.join(runDir, 'baseline', 'suite.report.md'),
    rawCallsDir: path.join(runDir, 'real-calls', 'raw'),
    ingestedCallsDir: path.join(runDir, 'real-calls', 'ingested'),
    draftsDir: path.join(GENERATED_SCENARIOS_DIR, loopRunId),
    patchesDir: path.join(runDir, 'patches'),
    iterationsDir: path.join(runDir, 'iterations')
  };
}

function buildAssistantAuth() {
  const bindings = readJson(STAGING_BINDINGS_PATH);
  const assistantId = bindings.assistantId;
  const apiKey = process.env.STAGING_VAPI_API_KEY || process.env.VAPI_API_KEY || '';
  const baseUrl = process.env.VAPI_API_BASE_URL || 'https://api.vapi.ai';

  if (!assistantId) {
    throw new Error(`assistantId is required in ${STAGING_BINDINGS_PATH}`);
  }
  if (!apiKey) {
    throw new Error('STAGING_VAPI_API_KEY or VAPI_API_KEY is required');
  }

  return {
    assistantId,
    apiKey,
    baseUrl
  };
}

async function fetchRecentCalls({ assistantId, apiKey, baseUrl, limit }) {
  if (limit <= 0) {
    return [];
  }

  const url = new URL('/call', baseUrl);
  url.searchParams.set('assistantId', assistantId);
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || `Vapi calls fetch failed with HTTP ${response.status}`;
    const error = new Error(message);
    error.httpStatus = response.status;
    error.responseBody = payload || text;
    throw error;
  }

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload;
}

function runStagingRegressionSuite({ outputDir, reportPath, scenarioIds }) {
  const args = [
    path.join(ROOT_DIR, 'scripts', 'autonomy', 'run-staging-regression-suite.js'),
    '--output-dir',
    outputDir,
    '--report',
    reportPath
  ];

  for (const scenarioId of scenarioIds) {
    args.push('--scenario', scenarioId);
  }

  const execution = runCommand(process.execPath, args, { allowFailure: true });
  const suitePath = path.join(outputDir, 'suite.result.v1.json');
  if (!fs.existsSync(suitePath)) {
    throw new Error(`Suite result not found at ${suitePath}`);
  }

  const suite = readJson(suitePath);
  const scenarioRuns = suite.scenario_results.map((item) => readJson(path.join(ROOT_DIR, item.result_path)));

  return {
    execution,
    suitePath,
    suite,
    scenarioRuns,
    reportPath
  };
}

function ingestCallsFromFile(inputPath, outputDir) {
  const args = [
    path.join(ROOT_DIR, 'scripts', 'autonomy', 'ingest-vapi-call-log.js'),
    '--input',
    inputPath,
    '--output-dir',
    outputDir,
    '--all',
    '--environment',
    SUPPORTED_ENVIRONMENT
  ];

  const execution = runCommand(process.execPath, args, { allowFailure: false });
  const runFiles = listResultFiles(outputDir, '.run.v1.json');
  const runs = runFiles.map((filePath) => readJson(filePath));
  return {
    execution,
    runFiles,
    runs
  };
}

function buildSuiteIssues(scenarioRuns) {
  return scenarioRuns
    .filter((scenarioRun) => scenarioRun.status !== 'passed')
    .map((scenarioRun) => {
      const failedCriteria = scenarioRun.criteria.filter((criterion) => criterion.required && !criterion.passed);
      return {
        issue_id: `suite:${scenarioRun.scenario_id}`,
        source_kind: 'staging_chat_suite',
        scenario_id: scenarioRun.scenario_id,
        title: scenarioRun.title,
        status: scenarioRun.status,
        failure_reason: scenarioRun.summary.failure_reason || scenarioRun.error?.message || 'unknown failure',
        highest_severity: highestFailureSeverity(scenarioRun.criteria) || 'high',
        suspected_root_cause: scenarioRun.summary.suspected_root_cause || null,
        transcript_excerpt: scenarioRun.summary.transcript_excerpt || [],
        failed_criteria: failedCriteria.map((criterion) => ({
          criterion_id: criterion.criterion_id,
          severity: criterion.severity,
          failure_reason: criterion.failure_reason,
          root_cause_hint: criterion.root_cause_hint,
          evidence: criterion.evidence
        })),
        raw: scenarioRun
      };
    });
}

function buildCallIssues(callRuns) {
  return callRuns
    .filter((run) => {
      const evaluation = run.evaluation?.result || {};
      return evaluation.failure_category !== 'none' || evaluation.repeated_question === true || evaluation.unsupported_claim === true;
    })
    .map((run) => {
      const evaluation = run.evaluation?.result || {};
      return {
        issue_id: `call:${run.run_id}`,
        source_kind: 'normalized_call_run',
        run_id: run.run_id,
        call_id: run.call?.call_id || null,
        scenario_id: run.scenario_id || null,
        title: evaluation.summary || `Call ${run.call?.call_id || run.run_id}`,
        status: evaluation.failure_category === 'none' ? 'weak' : 'failed',
        failure_reason: evaluation.summary,
        highest_severity: evaluation.failure_category === 'none' ? 'medium' : 'high',
        suspected_root_cause: evaluation.failure_category,
        transcript_excerpt: (run.conversation?.messages || [])
          .filter((message) => message.role === 'caller' || message.role === 'assistant')
          .slice(0, 8)
          .map((message) => `${message.role}: ${message.text || ''}`.trim()),
        failed_criteria: [],
        raw: run
      };
    });
}

function classifyIssue(issue) {
  if (issue.source_kind === 'normalized_call_run') {
    const failureCategory = issue.raw?.evaluation?.result?.failure_category || 'other';
    switch (failureCategory) {
      case 'structured_output_missing':
        return {
          category: 'schema_gap',
          summary: 'The call artifact could not be evaluated confidently because structured output was missing or empty.'
        };
      case 'missing_required_data':
        return {
          category: 'tool_contract_mismatch',
          summary: 'The assistant reached a tool boundary without satisfying the required payload contract.'
        };
      case 'tool_failure':
      case 'booking_conflict':
        return {
          category: 'workflow_logic_bug',
          summary: 'The tool layer executed but returned a workflow-side failure or conflict.'
        };
      case 'wrong_tool_usage':
      case 'repeated_question':
      case 'unsupported_claim':
        return {
          category: 'prompt_issue',
          summary: 'The assistant behavior drifted from the intended conversational/tooling policy.'
        };
      default:
        return {
          category: 'environment_or_config_issue',
          summary: 'The call needs environment or runtime inspection before a repo mutation is safe.'
        };
    }
  }

  const scenarioRun = issue.raw;
  if (scenarioRun.status === 'error') {
    return {
      category: 'environment_or_config_issue',
      summary: 'The suite could not complete the scenario because the staging assistant or Vapi chat path returned an error.'
    };
  }

  const unsupportedRule = scenarioRun.criteria.some((criterion) => {
    return typeof criterion.failure_reason === 'string' && criterion.failure_reason.startsWith('Unsupported rule type');
  });
  if (unsupportedRule) {
    return {
      category: 'schema_gap',
      summary: 'The staged scenario expresses an assertion that the deterministic runner cannot evaluate yet.'
    };
  }

  const toolValidationFailure = scenarioRun.tool_trace.some((trace) => {
    const details = trace.result?.error?.details;
    return Array.isArray(details) && details.some((detail) => String(detail).includes(' is required'));
  });
  if (toolValidationFailure) {
    return {
      category: 'tool_contract_mismatch',
      summary: 'The assistant invoked a tool with a payload that the workflow rejected as invalid.'
    };
  }

  if (
    scenarioRun.scenario_id === 'ambiguous-day-correction' &&
    scenarioRun.tool_trace.length === 1 &&
    scenarioRun.tool_trace[0].tool_name === 'checkAvailability' &&
    scenarioRun.tool_trace[0].turn === 2 &&
    scenarioRun.transcript.some((entry) => entry.turn === 1 && entry.role === 'assistant' && entry.kind === 'message') &&
    scenarioRun.summary.booking_created === false &&
    scenarioRun.summary.reception_task_created === false
  ) {
    return {
      category: 'bad_scenario_false_failure',
      summary: 'The scenario treated a valid initial-lookup-plus-refresh strategy as a failure instead of covering it separately.'
    };
  }

  if (
    scenarioRun.scenario_id === 'all-on-four-inquiry-to-booking' &&
    scenarioRun.summary.failure_reason === 'createEvent did not reuse the exact selected slot boundaries'
  ) {
    return {
      category: 'prompt_issue',
      summary: 'The assistant shortened the selected booking slot when it called createEvent instead of reusing the exact slot returned by checkAvailability.'
    };
  }

  const anyToolCalled = scenarioRun.tool_trace.length > 0;
  if (anyToolCalled) {
    const anyToolError = scenarioRun.tool_trace.some((trace) => trace.result?.error);
    return anyToolError
      ? {
        category: 'workflow_logic_bug',
        summary: 'The assistant reached the expected tool branch, but the workflow result did not satisfy the scenario.'
      }
      : {
        category: 'prompt_issue',
        summary: 'The assistant took an incorrect but syntactically valid branch or argument choice.'
      };
  }

  return {
    category: 'prompt_issue',
    summary: 'The assistant did not take the expected action for the staged scenario.'
  };
}

function clusterIssues(issues) {
  const map = new Map();

  for (const issue of issues) {
    const classification = classifyIssue(issue);
    let clusterKey;

    if (classification.category === 'bad_scenario_false_failure' && issue.scenario_id === 'ambiguous-day-correction') {
      clusterKey = 'bad_scenario_false_failure:ambiguous-day-clarification-path';
    } else if (
      classification.category === 'prompt_issue' &&
      issue.scenario_id === 'all-on-four-inquiry-to-booking' &&
      issue.failure_reason === 'createEvent did not reuse the exact selected slot boundaries'
    ) {
      clusterKey = 'prompt_issue:all-on-four-slot-boundary-drift';
    } else if (issue.source_kind === 'normalized_call_run') {
      clusterKey = `${classification.category}:${issue.suspected_root_cause || issue.run_id}`;
    } else {
      clusterKey = `${classification.category}:${issue.scenario_id || issue.issue_id}`;
    }

    if (!map.has(clusterKey)) {
      map.set(clusterKey, {
        cluster_key: clusterKey,
        category: classification.category,
        category_label: categoryLabels[classification.category] || classification.category,
        summary: classification.summary,
        issue_count: 0,
        highest_severity: issue.highest_severity,
        issue_ids: [],
        scenarios: new Set(),
        fixes_supported: [],
        issues: []
      });
    }

    const cluster = map.get(clusterKey);
    cluster.issue_count += 1;
    cluster.issue_ids.push(issue.issue_id);
    if (issue.scenario_id) {
      cluster.scenarios.add(issue.scenario_id);
    }
    if (severityRank[issue.highest_severity] > severityRank[cluster.highest_severity]) {
      cluster.highest_severity = issue.highest_severity;
    }
    cluster.issues.push(issue);
  }

  const clusters = Array.from(map.values()).map((cluster) => {
    const fixesSupported = [];
    if (cluster.cluster_key === 'bad_scenario_false_failure:ambiguous-day-clarification-path') {
      fixesSupported.push('split-ambiguous-day-coverage');
    }
    if (cluster.cluster_key === 'prompt_issue:all-on-four-slot-boundary-drift') {
      fixesSupported.push('tighten-createevent-slot-reuse-prompt');
    }
    return {
      ...cluster,
      scenarios: Array.from(cluster.scenarios).sort(),
      fixes_supported: fixesSupported
    };
  });

  clusters.sort((left, right) => {
    if (severityRank[right.highest_severity] !== severityRank[left.highest_severity]) {
      return severityRank[right.highest_severity] - severityRank[left.highest_severity];
    }
    return left.cluster_key.localeCompare(right.cluster_key);
  });

  return clusters;
}

function createGenericScenarioDraft(cluster, loopPaths) {
  const representative = cluster.issues[0];
  const scenarioIdBase = representative.scenario_id || representative.run_id || cluster.cluster_key.replace(/[^a-z0-9-]+/g, '-');
  const draftScenarioId = `${scenarioIdBase}-draft`;
  const outputPath = path.join(loopPaths.draftsDir, `${draftScenarioId}.v1.json`);

  let turns = [];
  let rubric = [];

  if (representative.source_kind === 'staging_chat_suite') {
    const messages = representative.raw.transcript.filter((entry) => entry.role === 'user' && entry.kind === 'message');
    turns = messages.map((entry, index) => ({
      turn_id: `turn-${index + 1}`,
      user: entry.text
    }));
    const firstTool = representative.raw.tool_trace[0];
    if (firstTool) {
      rubric.push({
        criterion_id: 'observed-tool-branch',
        description: `Observed ${firstTool.tool_name} usage remains covered in the derived draft.`,
        severity: 'medium',
        root_cause_hint: cluster.summary,
        rule: {
          type: 'tool_called',
          tool_name: firstTool.tool_name
        }
      });
    }
  } else if (representative.source_kind === 'normalized_call_run') {
    const messages = representative.raw.conversation.messages.filter((message) => message.role === 'caller' && message.kind === 'utterance');
    turns = messages.slice(0, 3).map((message, index) => ({
      turn_id: `turn-${index + 1}`,
      user: message.text
    }));
    const firstTool = representative.raw.tool_trace[0];
    if (firstTool) {
      rubric.push({
        criterion_id: 'observed-tool-branch',
        description: `Observed ${firstTool.tool_name} usage remains covered in the derived draft.`,
        severity: 'medium',
        root_cause_hint: cluster.summary,
        rule: {
          type: 'tool_called',
          tool_name: firstTool.tool_name
        }
      });
    }
  }

  if (turns.length === 0 || rubric.length === 0) {
    return null;
  }

  const draft = {
    schema_version: 'staging-chat-scenario.v1',
    scenario_id: draftScenarioId,
    title: `Draft derived from ${representative.scenario_id || representative.run_id}`,
    description: cluster.summary,
    status: 'draft',
    environment: 'staging',
    language: 'pl',
    tags: [
      'generated',
      'autonomy-draft'
    ],
    source: {
      origin: 'manual_regression',
      references: [
        representative.source_kind === 'staging_chat_suite'
          ? toRelativePath(path.join(loopPaths.baselineSuiteDir, 'suite.result.v1.json'))
          : 'autonomy generated from normalized call run'
      ]
    },
    runner: {
      provider: 'vapi_chat',
      max_turns: turns.length
    },
    turns,
    rubric
  };

  writeJson(outputPath, draft);

  return {
    scenario_id: draftScenarioId,
    path: outputPath,
    type: 'generic_draft',
    summary: cluster.summary
  };
}

function createAmbiguousClarificationDraft(cluster, loopPaths) {
  const outputPath = path.join(loopPaths.draftsDir, 'alternative-day-refresh-availability.v1.json');
  const draft = {
    schema_version: 'staging-chat-scenario.v1',
    scenario_id: 'alternative-day-refresh-availability',
    title: 'Alternative-day ambiguity refreshes availability after correction',
    description: 'Derived from a staging regression false failure where the assistant picked Tuesday first, then correctly refreshed availability after the caller clarified Wednesday.',
    status: 'draft',
    environment: 'staging',
    language: 'pl',
    tags: [
      'generated',
      'ambiguity',
      'refresh',
      'staging-safe'
    ],
    source: {
      origin: 'repo_audit',
      references: [
        toRelativePath(path.join(loopPaths.baselineSuiteDir, 'suite.result.v1.json'))
      ]
    },
    runner: {
      provider: 'vapi_chat',
      max_turns: 2
    },
    turns: [
      {
        turn_id: 'give-alternative-days',
        user: 'Chcialbym umowic pierwsza konsultacje, najlepiej we wtorek albo srode tak mniej wiecej po lunchu.'
      },
      {
        turn_id: 'correct-to-wednesday',
        user: 'To srode po poludniu.'
      }
    ],
    rubric: [
      {
        criterion_id: 'two-availability-lookups',
        description: 'The assistant should issue a second availability lookup after the caller picks Wednesday.',
        severity: 'critical',
        root_cause_hint: cluster.summary,
        rule: {
          type: 'tool_call_count_at_least',
          tool_name: 'checkAvailability',
          min: 2
        }
      },
      {
        criterion_id: 'first-lookup-uses-afternoon-window',
        description: 'The first lookup should preserve the afternoon window.',
        severity: 'medium',
        root_cause_hint: cluster.summary,
        rule: {
          type: 'turn_tool_arg_equals',
          turn: 1,
          tool_name: 'checkAvailability',
          path: 'timePreference',
          equals: 'afternoon'
        }
      },
      {
        criterion_id: 'second-lookup-uses-afternoon-window',
        description: 'The refreshed Wednesday lookup should preserve the afternoon window.',
        severity: 'medium',
        root_cause_hint: cluster.summary,
        rule: {
          type: 'turn_tool_arg_equals',
          turn: 2,
          tool_name: 'checkAvailability',
          path: 'timePreference',
          equals: 'afternoon'
        }
      },
      {
        criterion_id: 'requested-date-updated-after-correction',
        description: 'The second availability request should change the requested date after the caller picks Wednesday.',
        severity: 'medium',
        root_cause_hint: cluster.summary,
        rule: {
          type: 'tool_arg_changed_between_turns',
          tool_name: 'checkAvailability',
          path: 'requestedDate',
          turn_a: 1,
          turn_b: 2
        }
      },
      {
        criterion_id: 'no-booking-created',
        description: 'This ambiguity-resolution scenario must not create a booking.',
        severity: 'high',
        root_cause_hint: cluster.summary,
        rule: {
          type: 'tool_not_called',
          tool_name: 'createEvent'
        }
      }
    ]
  };

  writeJson(outputPath, draft);

  return {
    scenario_id: draft.scenario_id,
    path: outputPath,
    type: 'targeted_draft',
    summary: cluster.summary
  };
}

function deriveScenarioDrafts(clusters, loopPaths) {
  const drafts = [];
  ensureDir(loopPaths.draftsDir);

  for (const cluster of clusters) {
    if (cluster.cluster_key === 'bad_scenario_false_failure:ambiguous-day-clarification-path') {
      drafts.push(createAmbiguousClarificationDraft(cluster, loopPaths));
      continue;
    }

    const generic = createGenericScenarioDraft(cluster, loopPaths);
    if (generic) {
      drafts.push(generic);
    }
  }

  return drafts;
}

function buildFixPlan(clusters, handledClusterKeys) {
  const fixes = [];
  for (const cluster of clusters) {
    if (handledClusterKeys.has(cluster.cluster_key)) {
      continue;
    }
    if (cluster.cluster_key === 'bad_scenario_false_failure:ambiguous-day-clarification-path') {
      fixes.push({
        fix_id: 'split-ambiguous-day-coverage',
        cluster_key: cluster.cluster_key,
        title: 'Split ambiguous-day coverage into two explicit refresh scenarios',
        rationale: 'The current scenario encoded one valid initial-lookup-plus-refresh strategy as a failure. Keep the nearest-day correction regression, and add a separate alternative-day refresh regression.',
        target_files: [
          path.join(ROOT_DIR, 'autonomy', 'scenarios', 'staging', 'ambiguous-day-correction.v1.json'),
          path.join(ROOT_DIR, 'autonomy', 'scenarios', 'staging', 'alternative-day-refresh-availability.v1.json'),
          path.join(ROOT_DIR, 'docs', 'staging-regression-suite.md')
        ],
        runtime_impact: 'none',
        apply(context) {
          const updatedScenario = {
            schema_version: 'staging-chat-scenario.v1',
            scenario_id: 'ambiguous-day-correction',
            title: 'Corrected day preference triggers a refreshed second availability lookup',
            description: 'The caller first asks for the nearest Tuesday afternoon, then corrects the day to the nearest Wednesday afternoon. The assistant should issue a fresh checkAvailability call instead of reusing the earlier Tuesday result.',
            status: 'active',
            environment: 'staging',
            language: 'pl',
            tags: [
              'edge-case',
              'correction',
              'availability',
              'staging-safe'
            ],
            source: {
              origin: 'repo_audit',
              references: [
                'configs/vapi/assistant.v2.json',
                'autonomy/scenarios/staging/alternative-day-refresh-availability.v1.json'
              ]
            },
            runner: {
              provider: 'vapi_chat',
              max_turns: 2
            },
            turns: [
              {
                turn_id: 'give-tuesday-preference',
                user: 'Chcialbym umowic pierwsza konsultacje, najlepiej w najblizszy wtorek po lunchu.'
              },
              {
                turn_id: 'correct-to-wednesday',
                user: 'Jednak nie, prosze sprawdzic najblizsza srode po poludniu.'
              }
            ],
            rubric: [
              {
                criterion_id: 'two-availability-lookups',
                description: 'The assistant should perform a second availability lookup after the caller corrects the day.',
                severity: 'critical',
                root_cause_hint: 'assistant is not refreshing availability after the caller changes the day preference',
                rule: {
                  type: 'tool_call_count_at_least',
                  tool_name: 'checkAvailability',
                  min: 2
                }
              },
              {
                criterion_id: 'first-lookup-uses-afternoon-window',
                description: 'The first Tuesday request should normalize to the afternoon window.',
                severity: 'medium',
                root_cause_hint: 'time preference normalization drifted for phrases such as po lunchu',
                rule: {
                  type: 'turn_tool_arg_equals',
                  turn: 1,
                  tool_name: 'checkAvailability',
                  path: 'timePreference',
                  equals: 'afternoon'
                }
              },
              {
                criterion_id: 'second-lookup-uses-afternoon-window',
                description: 'The corrected Wednesday preference should keep the afternoon window.',
                severity: 'medium',
                root_cause_hint: 'assistant lost the time window when the caller corrected the day',
                rule: {
                  type: 'turn_tool_arg_equals',
                  turn: 2,
                  tool_name: 'checkAvailability',
                  path: 'timePreference',
                  equals: 'afternoon'
                }
              },
              {
                criterion_id: 'requested-date-updated-after-correction',
                description: 'The second availability request should change the requested date after the Wednesday correction.',
                severity: 'critical',
                root_cause_hint: 'assistant ignored the caller correction and kept the stale day selection',
                rule: {
                  type: 'tool_arg_changed_between_turns',
                  tool_name: 'checkAvailability',
                  path: 'requestedDate',
                  turn_a: 1,
                  turn_b: 2
                }
              },
              {
                criterion_id: 'no-booking-created',
                description: 'This correction-only scenario must not create a booking.',
                severity: 'high',
                root_cause_hint: 'assistant advanced into createEvent before the caller selected a concrete slot',
                rule: {
                  type: 'tool_not_called',
                  tool_name: 'createEvent'
                }
              }
            ]
          };

          const clarificationScenario = {
            schema_version: 'staging-chat-scenario.v1',
            scenario_id: 'alternative-day-refresh-availability',
            title: 'Alternative-day ambiguity refreshes availability after correction',
            description: 'The caller starts with a Tuesday-or-Wednesday afternoon preference. The assistant may pick one candidate day first, but after the caller corrects to Wednesday it must issue a fresh checkAvailability call instead of reusing stale Tuesday availability.',
            status: 'active',
            environment: 'staging',
            language: 'pl',
            tags: [
              'edge-case',
              'ambiguous-input',
              'refresh',
              'staging-safe'
            ],
            source: {
              origin: 'repo_audit',
              references: [
                'configs/vapi/assistant.v2.json',
                'autonomy/scenarios/staging/ambiguous-day-correction.v1.json'
              ]
            },
            runner: {
              provider: 'vapi_chat',
              max_turns: 2
            },
            turns: [
              {
                turn_id: 'give-alternative-days',
                user: 'Chcialbym umowic pierwsza konsultacje, najlepiej we wtorek albo srode tak mniej wiecej po lunchu.'
              },
              {
                turn_id: 'correct-to-wednesday',
                user: 'To srode po poludniu.'
              }
            ],
            rubric: [
              {
                criterion_id: 'two-availability-lookups',
                description: 'The assistant should issue a second availability lookup after the caller picks Wednesday.',
                severity: 'critical',
                root_cause_hint: 'assistant is not refreshing availability after the caller changes the preferred day',
                rule: {
                  type: 'tool_call_count_at_least',
                  tool_name: 'checkAvailability',
                  min: 2
                }
              },
              {
                criterion_id: 'first-lookup-uses-afternoon-window',
                description: 'The first lookup should preserve the afternoon window.',
                severity: 'medium',
                root_cause_hint: 'time preference normalization drifted for phrases such as po lunchu',
                rule: {
                  type: 'turn_tool_arg_equals',
                  turn: 1,
                  tool_name: 'checkAvailability',
                  path: 'timePreference',
                  equals: 'afternoon'
                }
              },
              {
                criterion_id: 'second-lookup-uses-afternoon-window',
                description: 'The refreshed Wednesday lookup should preserve the afternoon window.',
                severity: 'medium',
                root_cause_hint: 'assistant lost the time window after the caller corrected the day',
                rule: {
                  type: 'turn_tool_arg_equals',
                  turn: 2,
                  tool_name: 'checkAvailability',
                  path: 'timePreference',
                  equals: 'afternoon'
                }
              },
              {
                criterion_id: 'requested-date-updated-after-correction',
                description: 'The second availability request should change the requested date after the caller picks Wednesday.',
                severity: 'medium',
                root_cause_hint: 'assistant kept the stale day even after the caller corrected it',
                rule: {
                  type: 'tool_arg_changed_between_turns',
                  tool_name: 'checkAvailability',
                  path: 'requestedDate',
                  turn_a: 1,
                  turn_b: 2
                }
              },
              {
                criterion_id: 'no-booking-created',
                description: 'This ambiguity-resolution scenario must not create a booking.',
                severity: 'high',
                root_cause_hint: 'assistant advanced into createEvent before the caller selected a slot',
                rule: {
                  type: 'tool_not_called',
                  tool_name: 'createEvent'
                }
              }
            ]
          };

          writeJson(context.fix.target_files[0], updatedScenario);
          writeJson(context.fix.target_files[1], clarificationScenario);

          const docsPath = context.fix.target_files[2];
          const docsContent = fs.readFileSync(docsPath, 'utf8');
          const updatedDocs = docsContent.replace(
            '- ambiguous caller correction handling',
            '- alternative-day ambiguity refresh with a second lookup\n- nearest-day correction refresh with a second lookup'
          );
          if (updatedDocs !== docsContent) {
            writeText(docsPath, updatedDocs);
          }

          return {
            summary: 'Split the failing ambiguous-day scenario into two explicit regression paths and updated the suite coverage docs.',
            changed_files: context.fix.target_files.slice()
          };
        }
      });
      continue;
    }

    if (cluster.cluster_key === 'prompt_issue:all-on-four-slot-boundary-drift') {
      fixes.push({
        fix_id: 'tighten-createevent-slot-reuse-prompt',
        cluster_key: cluster.cluster_key,
        title: 'Anchor createEvent to the exact selected slot when booking from checkAvailability',
        rationale: 'The staging implant-booking path drifted from the selected slot boundary. Tighten the repo prompt and local createEvent contract docs with a concrete slot example so Vapi keeps the selected slot end instead of collapsing to a default 30-minute duration.',
        target_files: [
          path.join(ROOT_DIR, 'configs', 'vapi', 'assistant.v2.json'),
          path.join(ROOT_DIR, 'docs', 'tool-contracts.md'),
          path.join(ROOT_DIR, 'schemas', 'createEvent.request.json'),
          path.join(ROOT_DIR, 'scripts', 'check-workflow-regressions.js')
        ],
        runtime_impact: 'vapi_sync_only',
        apply(context) {
          const assistantPath = context.fix.target_files[0];
          const contractsPath = context.fix.target_files[1];
          const schemaPath = context.fix.target_files[2];
          const checksPath = context.fix.target_files[3];

          const assistantConfig = readJson(assistantPath);
          const slotGuardrailMessage = assistantConfig.assistant?.model?.messages?.find((message) => {
            return message.role === 'system'
              && typeof message.content === 'string'
              && message.content.includes('Wybrany slot ma pierwszenstwo nad kazda domyslna dlugoscia uslugi.');
          });
          if (!slotGuardrailMessage) {
            throw new Error('Could not find the createEvent slot guardrail system message in configs/vapi/assistant.v2.json');
          }

          const exampleSentence = ' Przyklad: jesli checkAvailability zwroci slot od 09:30 do 10:15, createEvent ma wyslac dokladnie slotStart 09:30 i slotEnd 10:15, nigdy 10:00. Jesli cokolwiek sugeruje 30 minut, usun service.durationMinutes i zachowaj pole end z wybranego slotu.';
          if (!slotGuardrailMessage.content.includes('slot od 09:30 do 10:15')) {
            slotGuardrailMessage.content += exampleSentence;
            writeJson(assistantPath, assistantConfig);
          }

          const contractsContent = fs.readFileSync(contractsPath, 'utf8');
          const updatedContracts = replaceExactOrThrow(
            contractsContent,
            [
              'Key fields:',
              '',
              '- `service.id`',
              '- `slotStart`',
              '- `slotEnd`',
              '- `timezone`',
              '- `patient.fullName`',
              '- `patient.phoneE164`'
            ].join('\n'),
            [
              'Key fields:',
              '',
              '- `service.id`',
              '- `slotStart`',
              '- `slotEnd`',
              '- `timezone`',
              '- `patient.fullName`',
              '- `patient.phoneE164`',
              '- optional `service.durationMinutes` metadata, but the selected slot boundary must take precedence over any default duration'
            ].join('\n'),
            'docs/tool-contracts.md key fields'
          );
          const finalizedContracts = replaceExactOrThrow(
            updatedContracts,
            [
              '### Workflow behavior',
              '',
              '1. Parse Vapi wrapper or direct body.',
              '2. Validate required fields and patient details.',
              '3. Re-check availability for the requested slot.',
              '4. Create the Google Calendar event only if the slot is still free.',
              '5. Return confirmation data.'
            ].join('\n'),
            [
              '### Workflow behavior',
              '',
              '1. Parse Vapi wrapper or direct body.',
              '2. Validate required fields and patient details.',
              '3. Keep the exact `slotStart` and `slotEnd` from the selected availability option. Do not shorten the slot to a default duration or reintroduce `service.durationMinutes` during booking.',
              '4. Re-check availability for the requested slot.',
              '5. Create the Google Calendar event only if the slot is still free.',
              '6. Return confirmation data.'
            ].join('\n'),
            'docs/tool-contracts.md workflow behavior'
          );
          if (finalizedContracts !== contractsContent) {
            writeText(contractsPath, finalizedContracts);
          }

          const schema = readJson(schemaPath);
          const serviceProperties = schema.properties?.service?.properties || {};
          if (serviceProperties.durationMinutes && !serviceProperties.durationMinutes.description) {
            serviceProperties.durationMinutes.description = 'Optional metadata only. When createEvent books a selected slot, the slotStart and slotEnd boundary must win over any default or inferred duration.';
          }
          if (schema.properties?.slotStart && !schema.properties.slotStart.description) {
            schema.properties.slotStart.description = 'Exact start timestamp from the selected availability slot.';
          }
          if (schema.properties?.slotEnd && !schema.properties.slotEnd.description) {
            schema.properties.slotEnd.description = 'Exact end timestamp from the selected availability slot.';
          }
          if (Array.isArray(schema.examples) && schema.examples.length > 0) {
            schema.examples[0] = {
              requestId: 'req_002',
              service: {
                id: 'consultation',
                name: 'Konsultacja'
              },
              slotStart: '2026-03-12T09:00:00+01:00',
              slotEnd: '2026-03-12T09:45:00+01:00',
              timezone: 'Europe/Warsaw',
              patient: {
                fullName: 'Jan Kowalski',
                phoneE164: '+48500100200',
                email: 'jan@example.com'
              },
              notes: 'Pierwsza wizyta',
              consentToSms: true,
              source: 'phone'
            };
          }
          writeJson(schemaPath, schema);

          const checksContent = fs.readFileSync(checksPath, 'utf8');
          const promptTestBlock = [
            "test('assistant prompt contains the call-quality guardrails from recent real-call regressions', () => {",
            "  const prompt = getAssistantSystemPrompt();",
            "  assert.match(prompt, /Nigdy nie lacz w jednej wypowiedzi dwoch pytan/);",
            "  assert.match(prompt, /Nie wywoluj narzedzi na urwanych fragmentach wypowiedzi/);",
            "  assert.match(prompt, /Jesli imie i nazwisko oraz numer telefonu zostaly juz jasno zebrane wczesniej/);",
            "  assert.match(prompt, /Nie wywoluj createEvent bez wyraznej zgody na finalne podsumowanie rezerwacji/);",
            "  assert.match(prompt, /Nie wymieniaj numeru telefonu/);",
            "  assert.match(prompt, /nie mow potem \"prosze chwile poczekac\"/i);",
            "});"
          ].join('\n');
          const slotPromptTestBlock = [
            promptTestBlock,
            '',
            "test('assistant prompt anchors createEvent to the exact selected slot boundary', () => {",
            "  const config = loadAssistantConfig();",
            "  const systemPrompts = (config.assistant?.model?.messages || [])",
            "    .filter((message) => message.role === 'system' && typeof message.content === 'string')",
            "    .map((message) => message.content)",
            "    .join('\\n');",
            "  assert.match(systemPrompts, /slotStart i slotEnd z wybranego slotu/);",
            "  assert.match(systemPrompts, /09:30 do 10:15/);",
            "  assert.match(systemPrompts, /nigdy 10:00/);",
            "  assert.match(systemPrompts, /usun service\\.durationMinutes/i);",
            "});"
          ].join('\n');
          if (!checksContent.includes('assistant prompt anchors createEvent to the exact selected slot boundary')) {
            const updatedChecks = replaceExactOrThrow(
              checksContent,
              promptTestBlock,
              slotPromptTestBlock,
              'scripts/check-workflow-regressions.js prompt guardrail test block'
            );
            writeText(checksPath, updatedChecks);
          }

          return {
            summary: 'Added a concrete selected-slot guardrail to the Vapi prompt and aligned the local createEvent contract docs, schema example, and prompt regression checks around exact slot reuse.',
            changed_files: context.fix.target_files.slice()
          };
        }
      });
    }
  }
  return fixes;
}

function snapshotFiles(filePaths) {
  const snapshots = new Map();
  for (const filePath of filePaths) {
    if (snapshots.has(filePath)) {
      continue;
    }
    if (fs.existsSync(filePath)) {
      snapshots.set(filePath, {
        exists: true,
        content: fs.readFileSync(filePath, 'utf8')
      });
    } else {
      snapshots.set(filePath, {
        exists: false,
        content: null
      });
    }
  }
  return snapshots;
}

function restoreSnapshots(snapshots) {
  for (const [filePath, snapshot] of snapshots.entries()) {
    if (snapshot.exists) {
      writeText(filePath, snapshot.content);
      continue;
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

function runRepoChecks() {
  const commands = [
    ['./scripts/check-repo-health.sh'],
    [process.execPath, path.join(ROOT_DIR, 'scripts', 'check-workflow-regressions.js')]
  ];

  const results = [];
  for (const command of commands) {
    const executable = command[0];
    const args = command.slice(1);
    results.push(runCommand(executable, args, { allowFailure: true }));
    if (!results[results.length - 1].ok) {
      break;
    }
  }

  return {
    ok: results.every((result) => result.ok),
    commands: results
  };
}

function determineRuntimeImpact(changedFiles) {
  const relativePaths = changedFiles.map((filePath) => toRelativePath(filePath));
  const fullSyncPrefixes = [
    'configs/services/',
    'deploy/vps/',
    'knowledge-base/',
    'mock-data/',
    'n8n/workflows/',
    'n8n/docker-compose.yml'
  ];

  const fullSyncAffected = relativePaths.filter((relativePath) => {
    return fullSyncPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(prefix));
  });
  if (fullSyncAffected.length > 0) {
    return { kind: 'full_sync', affected: fullSyncAffected };
  }

  const vapiAffected = relativePaths.filter((relativePath) => relativePath.startsWith('configs/vapi/'));
  if (vapiAffected.length > 0) {
    return { kind: 'vapi_sync_only', affected: vapiAffected };
  }

  return { kind: 'none', affected: [] };
}

function maybePrepareDerivedArtifacts(changedFiles, dryRun) {
  if (dryRun) {
    return [];
  }

  const commands = [];
  const relativeChangedFiles = changedFiles.map((filePath) => toRelativePath(filePath));
  if (relativeChangedFiles.includes('configs/vapi/assistant.v2.json')) {
    commands.push(runCommand('./scripts/sync-vapi-prompt-mirrors.sh', [], { allowFailure: false }));
  }

  const dataSources = new Set([
    'knowledge-base/clinic-knowledge.json',
    'configs/services/catalog.v1.json'
  ]);
  if (relativeChangedFiles.some((filePath) => dataSources.has(filePath))) {
    commands.push(runCommand('./scripts/sync-n8n-workflow-data.sh', [], { allowFailure: false }));
  }

  return commands;
}

function maybeSyncStaging(runtimeImpact, options) {
  if (runtimeImpact.kind === 'none') {
    return [
      {
        action: 'deploy-and-sync-staging',
        status: 'skipped',
        reason: 'No runtime-affecting repo files changed.'
      }
    ];
  }

  if (!options.syncEnabled) {
    return [
      {
        action: 'deploy-and-sync-staging',
        status: 'skipped',
        reason: 'Runtime-affecting files changed, but --no-sync was set.'
      }
    ];
  }

  if (options.dryRun) {
    return [
      {
        action: runtimeImpact.kind === 'vapi_sync_only' ? 'sync-vapi-environment.sh staging' : 'deploy-and-sync-staging',
        status: 'skipped',
        reason: 'Dry run mode does not mutate staging.'
      }
    ];
  }

  if (runtimeImpact.kind === 'full_sync') {
    return [
      {
        action: 'deploy-and-sync-staging',
        status: 'blocked',
        reason: 'Full staging sync depends on the VPS git checkout. The loop only changed local repo files, so n8n or VPS-affecting fixes must be committed and pushed before the existing deploy/sync scripts can apply them safely.'
      }
    ];
  }

  if (runtimeImpact.kind === 'vapi_sync_only') {
    const syncVapi = runCommand('./scripts/sync-vapi-environment.sh', ['staging'], { allowFailure: true });
    return [
      {
        action: 'sync-vapi-environment.sh staging',
        status: syncVapi.ok ? 'completed' : 'failed',
        command: syncVapi.command,
        stderr: syncVapi.stderr.trim() || null
      }
    ];
  }

  const deploy = runCommand('./scripts/deploy-vps.sh', ['staging'], { allowFailure: true });
  if (!deploy.ok) {
    return [
      {
        action: 'deploy-vps.sh staging',
        status: 'failed',
        command: deploy.command,
        stderr: deploy.stderr.trim()
      }
    ];
  }

  const sync = runCommand('./scripts/sync-environment.sh', ['staging'], { allowFailure: true });
  return [
    {
      action: 'deploy-vps.sh staging',
      status: deploy.ok ? 'completed' : 'failed',
      command: deploy.command
    },
    {
      action: 'sync-environment.sh staging',
      status: sync.ok ? 'completed' : 'failed',
      command: sync.command,
      stderr: sync.stderr.trim() || null
    }
  ];
}

function summarizeFixChangeFiles(filePaths) {
  return filePaths.map((filePath) => toRelativePath(filePath)).sort();
}

function buildComparisonRows(beforeRuns, afterRuns) {
  const afterById = new Map(afterRuns.map((run) => [run.scenario_id, run]));
  return beforeRuns.map((beforeRun) => {
    const afterRun = afterById.get(beforeRun.scenario_id) || null;
    return {
      scenario_id: beforeRun.scenario_id,
      title: beforeRun.title,
      baseline_status: beforeRun.status,
      baseline_failure_reason: beforeRun.summary.failure_reason,
      post_status: afterRun?.status || 'not_rerun',
      post_failure_reason: afterRun?.summary?.failure_reason || null
    };
  });
}

function chooseRecommendation(finalSuite, remainingClusters, attemptedFixes, maxIterationsReached) {
  if (finalSuite.failed_count === 0 && remainingClusters.length === 0) {
    return 'ready for human review';
  }

  if (remainingClusters.some((cluster) => cluster.fixes_supported.length > 0) && !maxIterationsReached) {
    return 'keep iterating in staging';
  }

  if (attemptedFixes.length === 0) {
    return 'ready for human review';
  }

  return 'ready for human review';
}

function renderMarkdownReport(result) {
  const lines = [
    '# Staging Autonomous Improvement Report',
    '',
    `- Loop run: \`${result.loop_run_id}\``,
    `- Environment: \`${result.environment}\``,
    `- Started: \`${result.started_at}\``,
    `- Completed: \`${result.completed_at}\``,
    `- Status: **${result.status.toUpperCase()}**`,
    `- Recommendation: **${result.recommendation.toUpperCase()}**`,
    `- Git branch: \`${result.git.branch}\``,
    `- Git HEAD: \`${result.git.head}\``,
    ''
  ];

  lines.push('## Baseline', '');
  lines.push(`- Staging suite: ${result.baseline.suite.passed_count}/${result.baseline.suite.scenario_count} passed`);
  lines.push(`- Baseline report: \`${result.baseline.suite.report_path}\``);
  lines.push(`- Ingested real or local call runs: ${result.baseline.call_runs.ingested_count}`);
  lines.push(`- Baseline failing or weak call runs: ${result.baseline.call_runs.issue_count}`);
  if (result.baseline.failures.length > 0) {
    lines.push('- Baseline failing cases:');
    for (const failure of result.baseline.failures) {
      lines.push(`- \`${failure.scenario_id}\`: ${failure.failure_reason}`);
    }
  } else {
    lines.push('- Baseline failing cases: none');
  }

  lines.push('', '## Triage', '');
  if (result.triage_clusters.length === 0) {
    lines.push('- No failing or weak cases required triage.');
  } else {
    lines.push('| Cluster | Category | Cases | Summary | Supported Fixers |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const cluster of result.triage_clusters) {
      lines.push(`| \`${cluster.cluster_key}\` | ${cluster.category_label} | ${cluster.issue_count} | ${cluster.summary} | ${cluster.fixes_supported.length > 0 ? cluster.fixes_supported.join(', ') : 'none'} |`);
    }
  }

  lines.push('', '## Derived Regression Scenarios', '');
  if (result.derived_scenarios.length === 0) {
    lines.push('- No draft scenarios were generated.');
  } else {
    for (const draft of result.derived_scenarios) {
      lines.push(`- \`${draft.scenario_id}\` -> \`${draft.path}\` (${draft.type})`);
    }
  }

  lines.push('', '## Attempted Fixes', '');
  if (result.iterations.length === 0) {
    lines.push('- No repo-backed fixes were attempted.');
  } else {
    for (const iteration of result.iterations) {
      lines.push(`### Iteration ${iteration.iteration}`);
      lines.push('');
      lines.push(`- Status: \`${iteration.status}\``);
      if (iteration.fixes.length === 0) {
        lines.push('- Attempted fixes: none');
      } else {
        for (const fix of iteration.fixes) {
          lines.push(`- \`${fix.fix_id}\`: ${fix.status} — ${fix.summary}`);
          lines.push(`- Files changed: ${fix.files_changed.length > 0 ? fix.files_changed.map((filePath) => `\`${filePath}\``).join(', ') : 'none'}`);
        }
      }

      if (iteration.staging_actions.length > 0) {
        lines.push('- Staging sync/deploy actions:');
        for (const action of iteration.staging_actions) {
          lines.push(`- \`${action.action}\`: ${action.status}${action.reason ? ` — ${action.reason}` : ''}`);
        }
      }

      if (iteration.repo_checks.commands.length > 0) {
        lines.push('- Repo checks:');
        for (const command of iteration.repo_checks.commands) {
          lines.push(`- \`${command.command}\`: ${command.ok ? 'passed' : 'failed'}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## Before And After', '');
  lines.push('| Scenario | Baseline | Post-fix |');
  lines.push('| --- | --- | --- |');
  for (const row of result.comparison) {
    const baseline = `${row.baseline_status.toUpperCase()}${row.baseline_failure_reason ? ` — ${row.baseline_failure_reason}` : ''}`;
    const post = `${row.post_status.toUpperCase()}${row.post_failure_reason ? ` — ${row.post_failure_reason}` : ''}`;
    lines.push(`| \`${row.scenario_id}\` | ${baseline} | ${post} |`);
  }

  lines.push('', '## Remaining Failures', '');
  if (result.remaining_failures.length === 0) {
    lines.push('- None.');
  } else {
    for (const failure of result.remaining_failures) {
      lines.push(`- \`${failure.scenario_id}\`: ${failure.failure_reason}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function updateReportIndex() {
  ensureDir(LOOP_REPORTS_ROOT);
  const runFiles = listResultFiles(LOOP_RUNS_ROOT, 'loop.result.v1.json');
  const rows = runFiles.map((filePath) => readJson(filePath)).sort((left, right) => {
    return right.started_at.localeCompare(left.started_at);
  });

  const lines = [
    '# Staging Loop Report Index',
    '',
    '| Loop Run | Started | Status | Baseline Failures | Final Failures | Recommendation | Report |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];

  for (const row of rows) {
    lines.push(
      `| \`${row.loop_run_id}\` | \`${row.started_at}\` | ${row.status.toUpperCase()} | ${row.baseline.suite.failed_count} | ${row.final_suite.failed_count} | ${row.recommendation} | \`${row.report_path}\` |`
    );
  }

  writeText(path.join(LOOP_REPORTS_ROOT, 'index.md'), `${lines.join('\n')}\n`);
}

async function main() {
  loadRootEnvIfPresent();
  const options = parseArgs(process.argv.slice(2));

  const initialStatus = gitStatusShort();
  if (initialStatus && !options.allowDirty) {
    throw new Error('The staging improvement loop requires a clean worktree by default. Re-run with --allow-dirty if you need to test from an in-progress branch.');
  }

  const loopRunId = `staging-autonomy-${compactTimestamp()}`;
  const loopPaths = buildLoopPaths(loopRunId);
  ensureDir(loopPaths.runDir);
  ensureDir(path.dirname(loopPaths.reportPath));
  ensureDir(loopPaths.patchesDir);
  ensureDir(loopPaths.iterationsDir);

  const git = {
    branch: gitCurrentBranch(),
    head: gitHeadSha(),
    initial_status: initialStatus
  };

  const startedAt = stableNowIso();
  const auth = buildAssistantAuth();

  const baselineSuite = runStagingRegressionSuite({
    outputDir: loopPaths.baselineSuiteDir,
    reportPath: loopPaths.baselineSuiteReport,
    scenarioIds: options.scenarioIds
  });

  const callArtifacts = [];
  if (options.fetchRecentCalls > 0) {
    const fetched = await fetchRecentCalls({
      ...auth,
      limit: options.fetchRecentCalls
    });
    const rawOutputPath = path.join(loopPaths.rawCallsDir, 'recent-staging-calls.json');
    writeJson(rawOutputPath, fetched);
    if (fetched.length > 0) {
      const ingestedOutputDir = path.join(loopPaths.ingestedCallsDir, 'recent-staging-calls');
      const ingested = ingestCallsFromFile(rawOutputPath, ingestedOutputDir);
      callArtifacts.push({
        source_path: rawOutputPath,
        run_files: ingested.runFiles,
        runs: ingested.runs,
        fetched_count: fetched.length
      });
    } else {
      callArtifacts.push({
        source_path: rawOutputPath,
        run_files: [],
        runs: [],
        fetched_count: 0
      });
    }
  }

  for (const inputPath of options.callsExports) {
    const outputDir = path.join(loopPaths.ingestedCallsDir, path.basename(inputPath, path.extname(inputPath)));
    const ingested = ingestCallsFromFile(inputPath, outputDir);
    callArtifacts.push({
      source_path: inputPath,
      run_files: ingested.runFiles,
      runs: ingested.runs,
      fetched_count: null
    });
  }

  const ingestedRuns = callArtifacts.flatMap((artifact) => artifact.runs);
  const baselineIssues = [
    ...buildSuiteIssues(baselineSuite.scenarioRuns),
    ...buildCallIssues(ingestedRuns)
  ];
  const triageClusters = clusterIssues(baselineIssues);
  const derivedScenarios = deriveScenarioDrafts(triageClusters, loopPaths).filter(Boolean).map((draft) => ({
    ...draft,
    path: toRelativePath(draft.path)
  }));

  const handledClusterKeys = new Set();
  const iterations = [];
  let currentSuite = baselineSuite;
  const baselineFailedCount = baselineSuite.suite.failed_count;

  for (let iterationNumber = 1; iterationNumber <= options.maxIterations; iterationNumber += 1) {
    const currentIssues = [
      ...buildSuiteIssues(currentSuite.scenarioRuns),
      ...buildCallIssues(ingestedRuns)
    ];
    const currentClusters = clusterIssues(currentIssues);
    const fixPlan = buildFixPlan(currentClusters, handledClusterKeys);

    if (fixPlan.length === 0) {
      iterations.push({
        iteration: iterationNumber,
        status: 'no-op',
        fixes: [],
        staging_actions: [],
        repo_checks: {
          ok: true,
          commands: []
        },
        suite_before: {
          failed_count: currentSuite.suite.failed_count,
          report_path: toRelativePath(currentSuite.reportPath)
        },
        suite_after: {
          failed_count: currentSuite.suite.failed_count,
          report_path: toRelativePath(currentSuite.reportPath)
        }
      });
      break;
    }

    const fix = fixPlan[0];
    handledClusterKeys.add(fix.cluster_key);
    const snapshots = snapshotFiles(fix.target_files);
    let repoChecks = { ok: true, commands: [] };
    let stagingActions = [];
    let iterationStatus = 'applied';
    let afterSuite = currentSuite;
    let fixSummary = fix.rationale;
    let changedFiles = [];

    try {
      if (!options.dryRun) {
        const applied = fix.apply({ fix });
        fixSummary = applied.summary || fixSummary;
        changedFiles = applied.changed_files || fix.target_files.slice();
      }

      if (!options.dryRun) {
        maybePrepareDerivedArtifacts(changedFiles, options.dryRun);
      } else {
        changedFiles = fix.target_files.slice();
      }

      repoChecks = runRepoChecks();
      if (!repoChecks.ok) {
        throw new Error('Repo checks failed after applying the targeted fix.');
      }

      const runtimeImpact = determineRuntimeImpact(changedFiles);
      stagingActions = maybeSyncStaging(runtimeImpact, options);
      if (stagingActions.some((action) => action.status === 'failed')) {
        throw new Error('Staging deploy/sync failed after applying the targeted fix.');
      }
      if (stagingActions.some((action) => action.status === 'blocked')) {
        iterationStatus = 'blocked';
      }

      if (iterationStatus !== 'blocked') {
        const afterSuiteDir = path.join(loopPaths.iterationsDir, `iteration-${iterationNumber}`, 'suite');
        const afterSuiteReport = path.join(loopPaths.iterationsDir, `iteration-${iterationNumber}`, 'suite.report.md');
        afterSuite = runStagingRegressionSuite({
          outputDir: afterSuiteDir,
          reportPath: afterSuiteReport,
          scenarioIds: options.scenarioIds
        });

        if (options.stopIfRegressionsIncrease && afterSuite.suite.failed_count > currentSuite.suite.failed_count) {
          iterationStatus = 'rolled_back';
          if (!options.dryRun) {
            restoreSnapshots(snapshots);
            const rollbackChecks = runRepoChecks();
            if (!rollbackChecks.ok) {
              throw new Error('Rollback restored files, but repo checks still failed.');
            }
          }
          afterSuite = currentSuite;
        } else {
          currentSuite = afterSuite;
        }
      }
    } catch (error) {
      iterationStatus = 'failed';
      if (!options.dryRun) {
        restoreSnapshots(snapshots);
      }
      repoChecks = repoChecks.commands.length > 0 ? repoChecks : {
        ok: false,
        commands: [
          {
            ok: false,
            command: fix.fix_id,
            stderr: error.message
          }
        ]
      };
    }

    const patchRecord = {
      patch_id: fix.fix_id,
      cluster_key: fix.cluster_key,
      status: iterationStatus,
      summary: fixSummary,
      rationale: fix.rationale,
      files_changed: summarizeFixChangeFiles(changedFiles),
      runtime_impact: fix.runtime_impact
    };

    writeJson(path.join(loopPaths.patchesDir, `iteration-${iterationNumber}-${fix.fix_id}.json`), patchRecord);

    iterations.push({
      iteration: iterationNumber,
      status: iterationStatus,
      fixes: [
        {
          fix_id: fix.fix_id,
          status: iterationStatus,
          summary: fixSummary,
          files_changed: summarizeFixChangeFiles(changedFiles),
          runtime_impact: fix.runtime_impact
        }
      ],
      staging_actions: stagingActions,
      repo_checks: {
        ok: repoChecks.ok,
        commands: repoChecks.commands.map((command) => ({
          ok: command.ok,
          command: command.command
        }))
      },
      suite_before: {
        failed_count: baselineFailedCount,
        report_path: toRelativePath(currentSuite.reportPath)
      },
      suite_after: {
        failed_count: currentSuite.suite.failed_count,
        report_path: toRelativePath(currentSuite.reportPath)
      }
    });

    if (iterationStatus !== 'applied') {
      break;
    }

    if (currentSuite.suite.failed_count === 0) {
      break;
    }
  }

  const finalIssues = [
    ...buildSuiteIssues(currentSuite.scenarioRuns),
    ...buildCallIssues(ingestedRuns)
  ];
  const remainingClusters = clusterIssues(finalIssues).filter((cluster) => !handledClusterKeys.has(cluster.cluster_key) || cluster.category !== 'bad_scenario_false_failure');
  const comparison = buildComparisonRows(baselineSuite.scenarioRuns, currentSuite.scenarioRuns);
  const recommendation = chooseRecommendation(
    currentSuite.suite,
    remainingClusters,
    iterations.flatMap((iteration) => iteration.fixes),
    iterations.length >= options.maxIterations
  );

  const result = {
    schema_version: 'staging-improvement-loop.v1',
    loop_run_id: loopRunId,
    environment: SUPPORTED_ENVIRONMENT,
    started_at: startedAt,
    completed_at: stableNowIso(),
    status: currentSuite.suite.failed_count === 0 ? 'passed' : 'completed_with_findings',
    recommendation,
    git,
    options: {
      ...options,
      callsExports: options.callsExports.map((item) => toRelativePath(item))
    },
    baseline: {
      suite: {
        scenario_count: baselineSuite.suite.scenario_count,
        passed_count: baselineSuite.suite.passed_count,
        failed_count: baselineSuite.suite.failed_count,
        report_path: toRelativePath(baselineSuite.reportPath),
        result_path: toRelativePath(baselineSuite.suitePath)
      },
      call_runs: {
        ingested_count: ingestedRuns.length,
        issue_count: buildCallIssues(ingestedRuns).length
      },
      failures: buildSuiteIssues(baselineSuite.scenarioRuns).map((issue) => ({
        scenario_id: issue.scenario_id,
        failure_reason: issue.failure_reason
      }))
    },
    triage_clusters: triageClusters.map((cluster) => ({
      cluster_key: cluster.cluster_key,
      category: cluster.category,
      category_label: cluster.category_label,
      summary: cluster.summary,
      issue_count: cluster.issue_count,
      highest_severity: cluster.highest_severity,
      scenarios: cluster.scenarios,
      fixes_supported: cluster.fixes_supported
    })),
    derived_scenarios: derivedScenarios,
    iterations,
    comparison,
    remaining_failures: buildSuiteIssues(currentSuite.scenarioRuns).map((issue) => ({
      scenario_id: issue.scenario_id,
      failure_reason: issue.failure_reason
    })),
    final_suite: {
      scenario_count: currentSuite.suite.scenario_count,
      passed_count: currentSuite.suite.passed_count,
      failed_count: currentSuite.suite.failed_count,
      report_path: toRelativePath(currentSuite.reportPath),
      result_path: toRelativePath(currentSuite.suitePath)
    },
    report_path: toRelativePath(loopPaths.reportPath)
  };

  writeJson(path.join(loopPaths.runDir, 'loop.result.v1.json'), result);
  writeText(loopPaths.reportPath, renderMarkdownReport(result));
  updateReportIndex();

  console.log(`Loop run: ${loopRunId}`);
  console.log(`Baseline suite: ${baselineSuite.suite.passed_count}/${baselineSuite.suite.scenario_count} passed`);
  console.log(`Final suite: ${currentSuite.suite.passed_count}/${currentSuite.suite.scenario_count} passed`);
  console.log(`Recommendation: ${recommendation}`);
  console.log(`Report: ${toRelativePath(loopPaths.reportPath)}`);

  if (currentSuite.suite.failed_count > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
