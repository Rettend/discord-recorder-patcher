#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const command = process.argv[2] ?? 'status';

function info(message) {
  console.log(`[info] ${message}`);
}

function fail(message) {
  console.error(`[error] ${message}`);
  process.exit(1);
}

function ensureExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} not found: ${filePath}`);
  }
}

function loadTemplate(name) {
  const templatePath = path.join(__dirname, '..', 'templates', name);
  ensureExists(templatePath, 'Template');
  return fs.readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n').trimEnd();
}

function parseVersionFromAppDir(name) {
  if (!/^app-\d+(?:\.\d+)+$/.test(name)) {
    return null;
  }
  return name
    .slice(4)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
}

function compareVersionParts(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
}

function getDiscordRoot() {
  if (process.env.DISCORD_ROOT) {
    return process.env.DISCORD_ROOT;
  }

  if (!process.env.LOCALAPPDATA) {
    fail('LOCALAPPDATA is not set. Use DISCORD_ROOT or DISCORD_VOICE_INDEX.');
  }

  return path.join(process.env.LOCALAPPDATA, 'Discord');
}

function findLatestAppDir(discordRoot) {
  ensureExists(discordRoot, 'Discord root');

  const appDirs = fs
    .readdirSync(discordRoot, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({name: entry.name, version: parseVersionFromAppDir(entry.name)}))
    .filter((entry) => entry.version != null)
    .sort((left, right) => compareVersionParts(right.version, left.version));

  if (appDirs.length === 0) {
    fail(`No app-* Discord directories found in ${discordRoot}`);
  }

  return path.join(discordRoot, appDirs[0].name);
}

function findVoiceIndexInApp(appDir) {
  const modulesDir = path.join(appDir, 'modules');
  ensureExists(modulesDir, 'Discord modules directory');

  const voiceModules = fs
    .readdirSync(modulesDir, {withFileTypes: true})
    .filter((entry) => entry.isDirectory() && /^discord_voice-\d+$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      order: Number.parseInt(entry.name.split('-')[1], 10) || 0,
    }))
    .sort((left, right) => right.order - left.order);

  for (const moduleEntry of voiceModules) {
    const candidate = path.join(modulesDir, moduleEntry.name, 'discord_voice', 'index.js');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  fail(`No discord_voice index.js found in ${modulesDir}`);
}

function resolveVoiceIndexPath() {
  if (process.env.DISCORD_VOICE_INDEX) {
    return process.env.DISCORD_VOICE_INDEX;
  }

  const root = getDiscordRoot();
  const appDir = findLatestAppDir(root);
  return findVoiceIndexInApp(appDir);
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function normalizeEol(text, eol) {
  return text.replace(/\n/g, eol);
}

function isPatched(content) {
  return (
    content.includes("const childProcess = require('child_process');")
    && content.includes('const activeRecorders = new Map();')
    && content.includes('void startRecorder(streamId);')
    && content.includes('stopRecorder(streamId);')
  );
}

function ensureImport(content, eol) {
  if (content.includes("const childProcess = require('child_process');")) {
    return content;
  }

  const anchor = "const VoiceEngine = require('./discord_voice.node');";
  if (!content.includes(anchor)) {
    fail(`Import anchor missing: ${anchor}`);
  }

  return content.replace(anchor, `${anchor}${eol}const childProcess = require('child_process');`);
}

function ensureStackTraceLimit(content, eol) {
  if (content.includes('Error.stackTraceLimit = 100;')) {
    return content;
  }

  const anchor = "const path = require('path');";
  if (!content.includes(anchor)) {
    fail(`Stack trace anchor missing: ${anchor}`);
  }

  return content.replace(anchor, `${anchor}${eol}${eol}Error.stackTraceLimit = 100;`);
}

function ensureRecorderBlock(content, eol, block) {
  if (content.includes('const activeRecorders = new Map();')) {
    return content;
  }

  const anchor = 'const directVideoStreams = {};' ;
  if (!content.includes(anchor)) {
    fail(`Recorder block anchor missing: ${anchor}`);
  }

  return content.replace(anchor, `${anchor}${eol}${normalizeEol(block, eol)}`);
}

function ensureHookLine(content, functionName, insertLine, afterLine, eol) {
  const fnRegex = new RegExp(`VoiceEngine\\.${functionName} = function \\(streamId\\) \\{[\\s\\S]*?\\n\\};`);
  const match = content.match(fnRegex);
  if (match == null) {
    fail(`Could not find wrapper for VoiceEngine.${functionName}`);
  }

  const block = match[0];
  if (block.includes(insertLine)) {
    return content;
  }

  const marker = `  ${afterLine}`;
  if (!block.includes(marker)) {
    fail(`Could not find insertion marker "${afterLine}" in ${functionName}`);
  }

  const patchedBlock = block.replace(marker, `${marker}${eol}  ${insertLine}`);
  return content.replace(block, patchedBlock);
}

function removeImport(content, eol) {
  const line = "const childProcess = require('child_process');";
  if (!content.includes(line)) {
    return content;
  }

  let out = content.replace(`${eol}${line}`, '');
  if (out !== content) {
    return out;
  }

  out = content.replace(`${line}${eol}`, '');
  return out;
}

function removeStackTraceLimit(content, eol) {
  const line = 'Error.stackTraceLimit = 100;';
  if (!content.includes(line)) {
    return content;
  }

  let out = content.replace(`${eol}${eol}${line}`, '');
  if (out !== content) {
    return out;
  }

  out = content.replace(`${eol}${line}`, '');
  if (out !== content) {
    return out;
  }

  out = content.replace(`${line}${eol}`, '');
  return out;
}

function removeRecorderBlock(content, eol, block) {
  const anchor = 'const directVideoStreams = {};';
  const normalizedBlock = normalizeEol(block, eol);
  const exactInsert = `${anchor}${eol}${normalizedBlock}`;

  if (content.includes(exactInsert)) {
    return content.replace(exactInsert, anchor);
  }

  if (content.includes(normalizedBlock)) {
    return content.replace(normalizedBlock, '').replace(`${eol}${eol}${eol}`, `${eol}${eol}`);
  }

  return content;
}

function removeHookLine(content, functionName, removeLine, eol) {
  const fnRegex = new RegExp(`VoiceEngine\\.${functionName} = function \\(streamId\\) \\{[\\s\\S]*?\\n\\};`);
  const match = content.match(fnRegex);
  if (match == null) {
    return content;
  }

  const block = match[0];
  const targetLine = `${eol}  ${removeLine}`;
  if (!block.includes(targetLine)) {
    return content;
  }

  const cleanedBlock = block.replace(targetLine, '');
  return content.replace(block, cleanedBlock);
}

function buildPatchedContent(content) {
  const eol = detectEol(content);
  const recorderBlock = loadTemplate('recorder-block.js');

  let out = content;
  out = ensureImport(out, eol);
  out = ensureStackTraceLimit(out, eol);
  out = ensureRecorderBlock(out, eol, recorderBlock);
  out = ensureHookLine(
    out,
    'addDirectVideoOutputSink',
    'void startRecorder(streamId);',
    'notifyActiveSinksChange(streamId);',
    eol,
  );
  out = ensureHookLine(
    out,
    'removeDirectVideoOutputSink',
    'stopRecorder(streamId);',
    'notifyActiveSinksChange(streamId);',
    eol,
  );

  return out;
}

function buildUnpatchedContent(content) {
  const eol = detectEol(content);
  const recorderBlock = loadTemplate('recorder-block.js');

  let out = content;
  out = removeHookLine(out, 'addDirectVideoOutputSink', 'void startRecorder(streamId);', eol);
  out = removeHookLine(out, 'removeDirectVideoOutputSink', 'stopRecorder(streamId);', eol);
  out = removeRecorderBlock(out, eol, recorderBlock);
  out = removeStackTraceLimit(out, eol);
  out = removeImport(out, eol);

  return out;
}

function getTimestamp() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ];
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ];
  return `${parts.join('')}_${time.join('')}`;
}

function backupPathFor(targetPath) {
  return `${targetPath}.bak.recorder.${getTimestamp()}`;
}

function latestBackupFor(targetPath) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const prefix = `${base}.bak.recorder.`;

  const candidates = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();

  if (candidates.length === 0) {
    fail(`No recorder backups found for ${targetPath}`);
  }

  return path.join(dir, candidates[0]);
}

function runStatus() {
  const targetPath = resolveVoiceIndexPath();
  ensureExists(targetPath, 'Voice module file');

  const content = fs.readFileSync(targetPath, 'utf8');
  const patched = isPatched(content);

  info(`Voice module: ${targetPath}`);
  info(`Recorder patch: ${patched ? 'present' : 'missing'}`);
}

function runApply() {
  const targetPath = resolveVoiceIndexPath();
  ensureExists(targetPath, 'Voice module file');

  const original = fs.readFileSync(targetPath, 'utf8');
  if (isPatched(original)) {
    info(`Already patched: ${targetPath}`);
    return;
  }

  const patched = buildPatchedContent(original);
  if (patched === original) {
    info(`No changes needed: ${targetPath}`);
    return;
  }

  const backupPath = backupPathFor(targetPath);
  fs.copyFileSync(targetPath, backupPath);
  fs.writeFileSync(targetPath, patched, 'utf8');

  info(`Backup created: ${backupPath}`);
  info(`Patch applied: ${targetPath}`);
}

function runRestore() {
  const targetPath = resolveVoiceIndexPath();
  ensureExists(targetPath, 'Voice module file');

  const selectedBackup = process.argv[3] != null ? process.argv[3] : latestBackupFor(targetPath);
  ensureExists(selectedBackup, 'Backup file');

  fs.copyFileSync(selectedBackup, targetPath);
  info(`Restored ${targetPath} from ${selectedBackup}`);
}

function runRemove() {
  const targetPath = resolveVoiceIndexPath();
  ensureExists(targetPath, 'Voice module file');

  const original = fs.readFileSync(targetPath, 'utf8');
  const unpatched = buildUnpatchedContent(original);

  if (unpatched === original) {
    info(`Already unpatched: ${targetPath}`);
    return;
  }

  const backupPath = backupPathFor(targetPath);
  fs.copyFileSync(targetPath, backupPath);
  fs.writeFileSync(targetPath, unpatched, 'utf8');

  info(`Backup created: ${backupPath}`);
  info(`Patch removed: ${targetPath}`);
}

switch (command) {
  case 'status':
    runStatus();
    break;
  case 'apply':
    runApply();
    break;
  case 'restore':
    runRestore();
    break;
  case 'remove':
    runRemove();
    break;
  default:
    fail(`Unknown command "${command}". Use status, apply, restore, or remove.`);
}
