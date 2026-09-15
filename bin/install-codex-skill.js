#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'agenthook';
const EXCLUDED = new Set(['.git', 'node_modules']);

function usage() {
  return `Usage: node bin/install-codex-skill.js [--force] [--link] [--dest <skills-dir>]

Installs this checkout as the Codex skill "${SKILL_NAME}".

Options:
  --dest <dir>   Skills directory. Defaults to $CODEX_HOME/skills or ~/.codex/skills.
  --force        Replace an existing agenthook skill install.
  --link         Symlink this checkout instead of copying it. Useful for development.
`;
}

function codexSkillsDir(env = process.env) {
  return env.CODEX_HOME
    ? path.join(env.CODEX_HOME, 'skills')
    : path.join(os.homedir(), '.codex', 'skills');
}

function parseArgs(argv) {
  const args = { force: false, link: false, dest: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--force') args.force = true;
    else if (arg === '--link') args.link = true;
    else if (arg === '--dest') {
      const value = argv[++index];
      if (!value) throw new Error('--dest requires a directory');
      args.dest = value;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

function assertSkillSource(sourceDir) {
  const skillMd = path.join(sourceDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) throw new Error(`SKILL.md not found in ${sourceDir}`);
  const text = fs.readFileSync(skillMd, 'utf8');
  if (!/^name:\s*agenthook\s*$/m.test(text)) {
    throw new Error('SKILL.md does not declare name: agenthook');
  }
}

function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to install symbolic link: ${source}`);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: stat.mode & 0o777 });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue;
      copyTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`unsupported file type: ${source}`);
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, stat.mode & 0o777);
}

function replaceDestination(destination, force) {
  if (!fs.existsSync(destination)) return;
  if (!force) {
    throw new Error(`${destination} already exists. Re-run with --force to replace it.`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
}

function sameRealPath(first, second) {
  try {
    return fs.realpathSync(first) === fs.realpathSync(second);
  } catch {
    return false;
  }
}

export function installCodexSkill(options = {}) {
  const sourceDir = path.resolve(options.sourceDir || repoRoot);
  const skillsDir = path.resolve(options.dest || codexSkillsDir(options.env));
  const destination = path.join(skillsDir, SKILL_NAME);
  assertSkillSource(sourceDir);
  fs.mkdirSync(skillsDir, { recursive: true });

  if (fs.existsSync(destination) && sameRealPath(destination, sourceDir)) {
    return { destination, mode: options.link ? 'link' : 'copy', changed: false };
  }

  if (options.link) {
    replaceDestination(destination, options.force);
    fs.symlinkSync(sourceDir, destination, 'dir');
    return { destination, mode: 'link', changed: true };
  }

  replaceDestination(destination, options.force);
  const temp = fs.mkdtempSync(path.join(skillsDir, `.${SKILL_NAME}-install-`));
  try {
    copyTree(sourceDir, temp);
    fs.renameSync(temp, destination);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return { destination, mode: 'copy', changed: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(usage());
      process.exit(0);
    }
    const result = installCodexSkill({ dest: args.dest, force: args.force, link: args.link });
    const verb = result.changed ? 'Installed' : 'Already installed';
    process.stdout.write(`${verb} ${SKILL_NAME} Codex skill at ${result.destination} (${result.mode})\n`);
    process.stdout.write('Restart Codex or start a new turn for the skill list to refresh.\n');
  } catch (error) {
    process.stderr.write(`Codex skill install failed: ${error.message}\n\n${usage()}`);
    process.exit(1);
  }
}
