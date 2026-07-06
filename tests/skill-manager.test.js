import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAssetImportDeepLink } from '../src/lib/provider-catalog.js';
import {
  applySkillImport,
  extractSkillImportItems,
  listSkillInventory,
  previewSkillImport,
} from '../src/lib/skill-manager.js';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyaiconfig-skills-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('listSkillInventory scans skill directories and extracts markdown metadata', async () => {
  await withTempDir(async (dir) => {
    const codexSkills = path.join(dir, 'codex-skills');
    const claudeSkills = path.join(dir, 'claude-skills');
    await fs.mkdir(path.join(codexSkills, 'reviewer'), { recursive: true });
    await fs.mkdir(path.join(codexSkills, 'no-doc'), { recursive: true });
    await fs.mkdir(path.join(claudeSkills, 'publisher'), { recursive: true });

    await fs.writeFile(path.join(codexSkills, 'reviewer', 'SKILL.md'), '# Code Reviewer\n\nFind bugs before summaries.');
    await fs.writeFile(path.join(claudeSkills, 'publisher', 'README.md'), '# Publisher\n\nPrepare release notes.');

    const inventory = await listSkillInventory({
      sources: [
        { id: 'codex-test', tool: 'codex', label: 'Codex test skills', rootPath: codexSkills },
        { id: 'claude-test', tool: 'claudecode', label: 'Claude test skills', rootPath: claudeSkills },
        { id: 'missing-test', tool: 'gemini', label: 'Missing skills', rootPath: path.join(dir, 'missing') },
      ],
    });

    assert.equal(inventory.schema, 'easyaiconfig.skill-inventory.v1');
    assert.equal(inventory.summary.sources, 3);
    assert.equal(inventory.summary.existingSources, 2);
    assert.equal(inventory.summary.skills, 3);
    assert.equal(inventory.summary.documented, 2);
    assert.equal(inventory.summary.tools.codex, 2);
    assert.equal(inventory.summary.tools.claudecode, 1);
    assert.equal(inventory.summary.tools.gemini, 0);

    const reviewer = inventory.skills.find((skill) => skill.name === 'reviewer');
    assert.equal(reviewer.title, 'Code Reviewer');
    assert.match(reviewer.description, /Find bugs/);
    assert.equal(reviewer.sha256.length, 64);

    const noDoc = inventory.skills.find((skill) => skill.name === 'no-doc');
    assert.equal(noDoc.hasDoc, false);
    assert.equal(noDoc.title, 'no-doc');
  });
});

test('skill import preview accepts asset bundles and protects existing skills by default', async () => {
  await withTempDir(async (dir) => {
    const codexSkillsRoot = path.join(dir, 'codex-skills');
    await fs.mkdir(path.join(codexSkillsRoot, 'reviewer'), { recursive: true });
    await fs.writeFile(path.join(codexSkillsRoot, 'reviewer', 'SKILL.md'), '# Old Reviewer\n\nKeep old rules.');

    const payload = {
      schema: 'easyaiconfig.asset-bundle.v1',
      app: 'EasyAIConfig',
      assets: {
        skills: [
          { name: 'reviewer', tools: ['codex'], content: '# Reviewer\n\nFind bugs first.' },
          { name: 'publisher', tools: ['codex'], files: { 'SKILL.md': '# Publisher\n\nPrepare release notes.' } },
          { name: 'remote-only', repositoryUrl: 'https://github.com/example/skills' },
        ],
      },
    };

    const extracted = extractSkillImportItems({ payload }, { targetTool: 'codex' });
    assert.equal(extracted.totalSkills, 3);
    assert.deepEqual(extracted.skills.map((skill) => skill.skillName), ['reviewer', 'publisher']);
    assert.equal(extracted.skipped[0].reason, 'external_source_requires_installer');

    const preview = await previewSkillImport({ url: buildAssetImportDeepLink(payload) }, {
      targetTool: 'codex',
      codexSkillsRoot,
    });

    assert.equal(preview.schema, 'easyaiconfig.skill-import-preview.v1');
    assert.equal(preview.summary.totalSkills, 3);
    assert.equal(preview.summary.created, 1);
    assert.equal(preview.summary.conflicts, 1);
    assert.equal(preview.summary.skipped, 1);
    assert.equal(preview.summary.written, false);
    assert.equal(preview.operations.find((operation) => operation.skillName === 'reviewer').action, 'conflict');
    assert.equal(JSON.stringify(preview).includes('Find bugs first'), false);
  });
});

test('skill import apply defaults to dry-run and writes inline skills with backups when explicit', async () => {
  await withTempDir(async (dir) => {
    const codexSkillsRoot = path.join(dir, 'codex-skills');
    const backupsRoot = path.join(dir, 'backups');
    const payload = {
      schema: 'easyaiconfig.asset-bundle.v1',
      assets: {
        skills: [
          {
            name: 'publisher',
            files: {
              'SKILL.md': '# Publisher\n\nPrepare release notes.',
              'references/checklist.md': 'Ship with tests.',
            },
          },
        ],
      },
    };

    const dryRun = await applySkillImport({ payload }, { codexSkillsRoot, backupsRoot, targetTool: 'codex' });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.summary.created, 1);
    assert.equal(dryRun.summary.written, false);
    await assert.rejects(() => fs.readFile(path.join(codexSkillsRoot, 'publisher', 'SKILL.md'), 'utf8'), /ENOENT/);

    const applied = await applySkillImport(
      { payload, dryRun: false },
      { codexSkillsRoot, backupsRoot, targetTool: 'codex' },
    );
    assert.equal(applied.dryRun, false);
    assert.equal(applied.summary.created, 1);
    assert.equal(applied.summary.written, true);
    assert.ok(applied.backupPath);
    assert.match(await fs.readFile(path.join(codexSkillsRoot, 'publisher', 'SKILL.md'), 'utf8'), /Publisher/);
    assert.match(await fs.readFile(path.join(codexSkillsRoot, 'publisher', 'references', 'checklist.md'), 'utf8'), /tests/);
    const manifest = JSON.parse(await fs.readFile(path.join(applied.backupPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema, 'easyaiconfig.skill-backup.v1');
    assert.equal(manifest.skills[0].existed, false);
  });
});

test('skill import supports overwrite and local symlink install mode', async () => {
  await withTempDir(async (dir) => {
    const codexSkillsRoot = path.join(dir, 'codex-skills');
    const claudeSkillsRoot = path.join(dir, 'claude-skills');
    const sourceSkill = path.join(dir, 'source-reviewer');
    const backupsRoot = path.join(dir, 'backups');
    await fs.mkdir(path.join(codexSkillsRoot, 'reviewer'), { recursive: true });
    await fs.mkdir(sourceSkill, { recursive: true });
    await fs.writeFile(path.join(codexSkillsRoot, 'reviewer', 'SKILL.md'), '# Old Reviewer\n\nKeep old rules.');
    await fs.writeFile(path.join(sourceSkill, 'SKILL.md'), '# Source Reviewer\n\nUse source rules.');

    const payload = {
      schema: 'easyaiconfig.asset-bundle.v1',
      assets: {
        skills: [
          { name: 'reviewer', sourcePath: sourceSkill, tools: ['codex', 'claudecode'], installMode: 'symlink' },
        ],
      },
    };

    const protectedResult = await applySkillImport(
      { payload, dryRun: false },
      { codexSkillsRoot, claudeSkillsRoot, backupsRoot, targetTool: 'codex' },
    );
    assert.equal(protectedResult.summary.conflicts, 1);
    assert.equal(protectedResult.summary.written, false);
    assert.match(await fs.readFile(path.join(codexSkillsRoot, 'reviewer', 'SKILL.md'), 'utf8'), /Old Reviewer/);

    const linked = await applySkillImport(
      { payload, dryRun: false },
      { codexSkillsRoot, claudeSkillsRoot, backupsRoot, targetTool: 'all', overwrite: true },
    );
    assert.equal(linked.summary.updated, 1);
    assert.equal(linked.summary.created, 1);
    assert.equal(linked.summary.written, true);
    const codexLink = await fs.readlink(path.join(codexSkillsRoot, 'reviewer'));
    const claudeLink = await fs.readlink(path.join(claudeSkillsRoot, 'reviewer'));
    assert.equal(codexLink, sourceSkill);
    assert.equal(claudeLink, sourceSkill);
    const manifest = JSON.parse(await fs.readFile(path.join(linked.backupPath, 'manifest.json'), 'utf8'));
    assert.match(await fs.readFile(manifest.skills.find((skill) => skill.existed).backupPath + '/SKILL.md', 'utf8'), /Old Reviewer/);
  });
});
