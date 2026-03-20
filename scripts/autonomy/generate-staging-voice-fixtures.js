#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_SCENARIOS_DIR = path.join(ROOT_DIR, 'autonomy', 'scenarios', 'staging-voice');
const DEFAULT_FIXTURES_DIR = path.join(DEFAULT_SCENARIOS_DIR, 'fixtures');
const GENERATABLE_SCENARIO_STATUS = new Set(['active', 'draft']);
const LANGUAGE_FILTERS = new Set(['pl', 'en', 'mixed', 'all']);

function usage() {
  console.log(`Usage:
  node scripts/autonomy/generate-staging-voice-fixtures.js [options]

Options:
  --scenario <id>       Generate clips only for the named scenario. Repeat to add more scenarios.
  --language <value>    Filter scenarios by language: pl, en, mixed, or all. Defaults to pl.
  --only-missing        Skip clips that already exist on disk.
  --list-voices         Print the accessible ElevenLabs voices and exit.
  --help                Show this help message.
`);
}

function parseArgs(argv) {
  const options = {
    scenarioIds: [],
    languageFilter: 'pl',
    languageExplicit: false,
    onlyMissing: false,
    listVoices: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--only-missing') {
      options.onlyMissing = true;
      continue;
    }
    if (arg === '--list-voices') {
      options.listVoices = true;
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
      case '--language':
        if (!LANGUAGE_FILTERS.has(next)) {
          throw new Error(`Unsupported language filter: ${next}`);
        }
        options.languageFilter = next;
        options.languageExplicit = true;
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

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(stderr || stdout || `${command} exited with status ${result.status}`);
  }

  return result;
}

function scenarioMatchesLanguageFilter(scenario, languageFilter) {
  return languageFilter === 'all' || scenario.language === languageFilter;
}

function loadScenarios(options) {
  const entries = fs.readdirSync(DEFAULT_SCENARIOS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => path.join(DEFAULT_SCENARIOS_DIR, entry));

  const scenarios = entries
    .map((filePath) => {
      const scenario = readJson(filePath);
      scenario.__filePath = filePath;
      return scenario;
    })
    .filter((scenario) => GENERATABLE_SCENARIO_STATUS.has(scenario.status))
    .sort((left, right) => left.scenario_id.localeCompare(right.scenario_id));

  if (options.scenarioIds.length > 0) {
    const selected = scenarios.filter((scenario) => options.scenarioIds.includes(scenario.scenario_id));
    const found = new Set(selected.map((scenario) => scenario.scenario_id));
    const missing = options.scenarioIds.filter((scenarioId) => !found.has(scenarioId));
    if (missing.length > 0) {
      throw new Error(`Unknown staging voice scenario(s): ${missing.join(', ')}`);
    }
    if (options.languageExplicit) {
      return selected.filter((scenario) => scenarioMatchesLanguageFilter(scenario, options.languageFilter));
    }
    return selected;
  }

  return scenarios.filter((scenario) => scenarioMatchesLanguageFilter(scenario, options.languageFilter));
}

function getElevenLabsConfig() {
  const apiKey = process.env.ELEVENLABS_API_KEY || '';
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is required to synthesize voice fixtures');
  }

  return {
    apiKey,
    modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5',
    polishVoiceId: process.env.ELEVENLABS_POLISH_VOICE_ID || 'EmspiS7CSUabPeqBcrAP',
    englishVoiceId: process.env.ELEVENLABS_ENGLISH_VOICE_ID || 'hpp4J3VqNfWAUOO0d1Us'
  };
}

function buildVoiceSettings() {
  const stability = Number.parseFloat(process.env.ELEVENLABS_STABILITY || '');
  const similarityBoost = Number.parseFloat(process.env.ELEVENLABS_SIMILARITY_BOOST || '');
  const style = Number.parseFloat(process.env.ELEVENLABS_STYLE || '');
  const settings = {};

  if (Number.isFinite(stability)) {
    settings.stability = stability;
  }
  if (Number.isFinite(similarityBoost)) {
    settings.similarity_boost = similarityBoost;
  }
  if (Number.isFinite(style)) {
    settings.style = style;
  }

  return Object.keys(settings).length > 0 ? settings : null;
}

function resolveVoiceIdForScenario(scenario, config) {
  if (scenario.language === 'en') {
    return config.englishVoiceId;
  }
  return config.polishVoiceId;
}

async function listVoices(config) {
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: {
      'xi-api-key': config.apiKey,
      Accept: 'application/json'
    }
  });

  const bodyText = await response.text();
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    payload = bodyText;
  }

  if (!response.ok) {
    throw new Error(`ElevenLabs voices request failed with HTTP ${response.status}`);
  }

  const voices = Array.isArray(payload?.voices) ? payload.voices : [];
  for (const voice of voices) {
    const labels = voice.labels || {};
    console.log([
      voice.voice_id,
      voice.name,
      labels.language || 'n/a',
      voice.category || 'n/a'
    ].join('\t'));
  }
}

async function synthesizeSpeech({ config, voiceId, text }) {
  const payload = {
    text,
    model_id: config.modelId
  };
  const voiceSettings = buildVoiceSettings();
  if (voiceSettings) {
    payload.voice_settings = voiceSettings;
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': config.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify(payload)
  });

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const errorText = audioBuffer.toString('utf8').trim();
    throw new Error(`ElevenLabs synthesis failed with HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`);
  }

  return audioBuffer;
}

function renderCleanFixture(sourcePath, outputPath) {
  ensureDir(path.dirname(outputPath));
  runCommand('ffmpeg', [
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath,
    '-ac', '1',
    '-ar', '48000',
    '-c:a', 'pcm_s16le',
    outputPath
  ]);
}

function renderLowConfidenceFixture(sourcePath, outputPath) {
  ensureDir(path.dirname(outputPath));
  runCommand('ffmpeg', [
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath,
    '-f', 'lavfi',
    '-i', 'anoisesrc=color=white:amplitude=0.02:r=48000',
    '-filter_complex',
    '[0:a]highpass=f=220,lowpass=f=2400,acrusher=bits=7:mode=lin,volume=1.7[voice];[voice][1:a]amix=inputs=2:duration=first:weights=1 0.28',
    '-ac', '1',
    '-ar', '48000',
    '-c:a', 'pcm_s16le',
    outputPath
  ]);
}

function clipStyle(step) {
  return step.fixture_style || 'clean';
}

async function generateClip({ scenario, step, config, onlyMissing }) {
  const outputPath = path.resolve(ROOT_DIR, step.clip_path);
  if (onlyMissing && fs.existsSync(outputPath)) {
    return {
      clipPath: outputPath,
      generated: false,
      skipped: true,
      style: clipStyle(step)
    };
  }

  if (!step.transcript || typeof step.transcript !== 'string') {
    throw new Error(`Scenario ${scenario.scenario_id} step ${step.step_id} is missing transcript text for fixture generation`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-voice-fixture-'));
  const sourcePath = path.join(tempDir, 'source.mp3');

  try {
    const voiceId = resolveVoiceIdForScenario(scenario, config);
    const audioBuffer = await synthesizeSpeech({
      config,
      voiceId,
      text: step.transcript
    });
    fs.writeFileSync(sourcePath, audioBuffer);

    if (clipStyle(step) === 'low_confidence_noise') {
      renderLowConfidenceFixture(sourcePath, outputPath);
    } else {
      renderCleanFixture(sourcePath, outputPath);
    }

    return {
      clipPath: outputPath,
      generated: true,
      skipped: false,
      style: clipStyle(step)
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  loadRootEnvIfPresent();
  const options = parseArgs(process.argv.slice(2));
  const config = getElevenLabsConfig();

  if (options.listVoices) {
    await listVoices(config);
    return;
  }

  const scenarios = loadScenarios(options);
  if (scenarios.length === 0) {
    throw new Error(`No staging voice scenarios matched language filter ${options.languageFilter}`);
  }

  ensureDir(DEFAULT_FIXTURES_DIR);
  const results = [];
  for (const scenario of scenarios) {
    for (const step of scenario.steps || []) {
      if (step.type !== 'play_clip') {
        continue;
      }
      const result = await generateClip({
        scenario,
        step,
        config,
        onlyMissing: options.onlyMissing
      });
      results.push({
        scenario_id: scenario.scenario_id,
        step_id: step.step_id,
        clip_path: path.relative(ROOT_DIR, result.clipPath) || '.',
        generated: result.generated,
        skipped: result.skipped,
        style: result.style
      });
    }
  }

  if (results.length === 0) {
    console.log('No play_clip steps matched the current selection.');
    return;
  }

  for (const result of results) {
    const status = result.generated ? 'generated' : 'cached';
    console.log(`${status}\t${result.scenario_id}\t${result.step_id}\t${result.style}\t${result.clip_path}`);
  }

  const generatedCount = results.filter((entry) => entry.generated).length;
  const cachedCount = results.length - generatedCount;
  console.log('');
  console.log(`Voice fixtures ready under ${path.relative(ROOT_DIR, DEFAULT_FIXTURES_DIR) || '.'}`);
  console.log(`Generated: ${generatedCount}`);
  console.log(`Cached: ${cachedCount}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
