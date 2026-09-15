import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installCodexSkill } from '../bin/install-codex-skill.js';

function sourceFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthook-install-source-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: agenthook\n---\n# agenthook\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# copied\n');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'private metadata');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'ignored'), 'dependency cache');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function skillsFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthook-install-dest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Codex installer copies the skill without repo metadata or dependencies', (t) => {
  const sourceDir = sourceFixture(t);
  const dest = skillsFixture(t);
  const result = installCodexSkill({ sourceDir, dest });

  assert.equal(result.mode, 'copy');
  assert.equal(result.changed, true);
  assert.equal(result.destination, path.join(dest, 'agenthook'));
  assert.equal(fs.readFileSync(path.join(result.destination, 'README.md'), 'utf8'), '# copied\n');
  assert.equal(fs.existsSync(path.join(result.destination, '.git')), false);
  assert.equal(fs.existsSync(path.join(result.destination, 'node_modules')), false);
});

test('Codex installer refuses to replace an existing install unless forced', (t) => {
  const sourceDir = sourceFixture(t);
  const dest = skillsFixture(t);
  installCodexSkill({ sourceDir, dest });

  assert.throws(() => installCodexSkill({ sourceDir, dest }), /already exists/);
  const result = installCodexSkill({ sourceDir, dest, force: true });
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(path.join(dest, 'agenthook', 'SKILL.md')), true);
});

test('Codex installer can link a checkout for local development', (t) => {
  const sourceDir = sourceFixture(t);
  const dest = skillsFixture(t);
  const result = installCodexSkill({ sourceDir, dest, link: true });

  assert.equal(result.mode, 'link');
  assert.equal(result.changed, true);
  assert.equal(fs.realpathSync(result.destination), fs.realpathSync(sourceDir));

  const repeated = installCodexSkill({ sourceDir, dest, link: true });
  assert.equal(repeated.changed, false);
});

test('Codex installer does not remove itself when already installed', (t) => {
  const dest = skillsFixture(t);
  const installed = path.join(dest, 'agenthook');
  fs.mkdirSync(installed);
  fs.writeFileSync(path.join(installed, 'SKILL.md'), '---\nname: agenthook\n---\n# agenthook\n');

  const result = installCodexSkill({ sourceDir: installed, dest, force: true });
  assert.equal(result.changed, false);
  assert.equal(fs.existsSync(path.join(installed, 'SKILL.md')), true);
});
