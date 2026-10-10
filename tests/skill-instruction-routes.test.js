import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseSkillInstructionManifest,
  readSkillInstructionFiles,
} from '../server/agent/drama/officialDramaBundle.js';
import { createAgentSkillLibrary } from '../server/agent/agentSkillLibrary.js';

const temporaryRoots = [];
const rootText = '---\nname: route-test\ndescription: isolated instruction fixture\n---\nROOT_INSTRUCTIONS';
const core = 'references/core.md';
const h3 = 'references/h3.txt';
const assets = 'references/assets.md';
const fallback = 'references/fallback.md';
const routedManifest = () => ({
  instructionReferences: [core],
  instructionRoutes: [
    { keywords: ['H3', '视频'], references: [h3] },
    { keywords: ['资产'], references: [assets, h3] },
    { keywords: ['unrelated fallback label'], references: [fallback], fallback: true },
  ],
});
const manifestText = (manifest) => JSON.stringify(manifest);
const upload = (filename, content) => ({
  path: `fixture/${filename}`,
  contentBase64: Buffer.from(content).toString('base64'),
});

async function fixture(manifest, references = {
  [core]: 'CORE_ALWAYS', [h3]: 'H3_SELECTED', [assets]: 'ASSETS_SELECTED', [fallback]: 'FALLBACK_SELECTED',
}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aifisher-skill-routes-'));
  temporaryRoots.push(directory);
  await fs.writeFile(path.join(directory, 'SKILL.md'), rootText);
  if (manifest !== undefined) await fs.writeFile(path.join(directory, 'agent-skill.json'), manifestText(manifest));
  for (const [relative, content] of Object.entries(references)) {
    const filename = path.join(directory, ...relative.split('/'));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
  }
  return directory;
}

async function libraryFixture() {
  const directory = await fixture(undefined, {});
  return createAgentSkillLibrary({
    libraryDirectory: path.join(directory, 'workspace', 'library'),
    officialRegistry: { list: () => [], readInstructions: () => { throw new Error('No official calls in fixture'); } },
  });
}

afterEach(async () => {
  for (const directory of temporaryRoots.splice(0)) {
    expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(directory)).toMatch(/^aifisher-skill-routes-/);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('skill instruction route selection through real files', () => {
  it('keeps core instructions and reads only the matched route, even when an unselected file is missing', async () => {
    const directory = await fixture(routedManifest(), { [core]: 'CORE_ALWAYS', [h3]: 'H3_SELECTED' });
    const result = await readSkillInstructionFiles(directory, 'Write H3 video prompts');
    expect(result).toContain('ROOT_INSTRUCTIONS');
    expect(result).toContain('CORE_ALWAYS');
    expect(result).toContain('H3_SELECTED');
    expect(result).not.toContain('ASSETS_SELECTED');
    expect(result).not.toContain('FALLBACK_SELECTED');
  });

  it('selects every matching nonfallback route and reads shared references only once', async () => {
    const directory = await fixture(routedManifest());
    const result = await readSkillInstructionFiles(directory, '制作视频与资产');
    expect(result).toContain('H3_SELECTED');
    expect(result).toContain('ASSETS_SELECTED');
    expect(result.match(/### 参考文件：references\/h3.txt/g)).toHaveLength(1);
    expect(result).not.toContain('FALLBACK_SELECTED');
  });

  it('uses fallback references only when no nonfallback route matches', async () => {
    const manifest = routedManifest();
    manifest.instructionRoutes.push({ keywords: ['another fallback'], references: [h3, fallback], fallback: true });
    const directory = await fixture(manifest);
    const unmatched = await readSkillInstructionFiles(directory, 'unrelated task');
    expect(unmatched).toContain('CORE_ALWAYS');
    expect(unmatched).toContain('FALLBACK_SELECTED');
    expect(unmatched).toContain('H3_SELECTED');
    expect(unmatched.match(/### 参考文件：references\/fallback.md/g)).toHaveLength(1);
    const matched = await readSkillInstructionFiles(directory, '资产');
    expect(matched).toContain('ASSETS_SELECTED');
    expect(matched).not.toContain('FALLBACK_SELECTED');
  });

  it('normalizes Unicode compatibility forms and case in both context and keywords', async () => {
    const manifest = {
      instructionReferences: [core],
      instructionRoutes: [{ keywords: ['Ｈ３', 'CAFÉ'], references: [h3] }],
    };
    const directory = await fixture(manifest);
    expect(await readSkillInstructionFiles(directory, 'compile h3')).toContain('H3_SELECTED');
    expect(await readSkillInstructionFiles(directory, 'ｃａｆｅ\u0301')).toContain('H3_SELECTED');
  });

  it.each([undefined, null, {}, [], 123, false])('treats nonstring context %j as empty for fallback', async (context) => {
    const directory = await fixture(routedManifest());
    const result = await readSkillInstructionFiles(directory, context);
    expect(result).toContain('FALLBACK_SELECTED');
    expect(result).not.toContain('H3_SELECTED');
  });

  it('keeps a shared base reference in place without reading it twice', async () => {
    const directory = await fixture({
      instructionReferences: [core],
      instructionRoutes: [{ keywords: ['视频'], references: [core, h3] }],
    });
    const result = await readSkillInstructionFiles(directory, '视频');
    expect(result.match(/### 参考文件：references\/core.md/g)).toHaveLength(1);
    expect(result.indexOf('CORE_ALWAYS')).toBeLessThan(result.indexOf('H3_SELECTED'));
  });

  it('deduplicates shared references across routes case insensitively before touching the filesystem', async () => {
    const directory = await fixture({
      instructionReferences: [core],
      instructionRoutes: [
        { keywords: ['H3'], references: [h3] },
        { keywords: ['video'], references: ['references/H3.txt'] },
      ],
    }, { [core]: 'CORE_ALWAYS', [h3]: 'H3_SELECTED' });
    const result = await readSkillInstructionFiles(directory, 'H3 video');
    expect(result.match(/H3_SELECTED/g)).toHaveLength(1);
    expect(parseSkillInstructionManifest(await fs.readFile(path.join(directory, 'agent-skill.json'), 'utf8'))).toEqual([core, h3]);
  });

  it('matches literal keywords without interpreting regular expressions', async () => {
    const directory = await fixture({
      instructionReferences: [core],
      instructionRoutes: [
        { keywords: ['H3.*'], references: [h3] },
        { keywords: ['default'], references: [fallback], fallback: true },
      ],
    });
    expect(await readSkillInstructionFiles(directory, 'H3 prompt')).toContain('FALLBACK_SELECTED');
    expect(await readSkillInstructionFiles(directory, 'literal H3.* marker')).toContain('H3_SELECTED');
  });

  it.each([
    ['样例10', false, true, false],
    ['样例１０', false, true, false],
    ['样例1', true, false, false],
    ['请用样例1。', true, false, false],
    ['样例10，然后再用样例1', true, true, false],
    ['样例100', false, false, true],
  ])('applies a following-digit boundary to numbered reference keywords in %s', async (context, first, tenth, useFallback) => {
    const directory = await fixture({
      instructionReferences: [core],
      instructionRoutes: [
        { keywords: ['样例1'], references: [h3] },
        { keywords: ['样例10'], references: [assets] },
        { keywords: ['default'], references: [fallback], fallback: true },
      ],
    });
    const result = await readSkillInstructionFiles(directory, context);
    expect(result.includes('H3_SELECTED')).toBe(first);
    expect(result.includes('ASSETS_SELECTED')).toBe(tenth);
    expect(result.includes('FALLBACK_SELECTED')).toBe(useFallback);
    expect(result).toContain('CORE_ALWAYS');
  });

  it('retains ordinary substring matching when a keyword does not end with a digit', async () => {
    const directory = await fixture({
      instructionReferences: [], instructionRoutes: [{ keywords: ['guide'], references: [h3] }],
    });
    expect(await readSkillInstructionFiles(directory, 'follow these guidelines')).toContain('H3_SELECTED');
  });
});

describe('manifest compatibility and strict route validation', () => {
  it('returns the complete deduplicated import-validation union in declaration order', () => {
    expect(parseSkillInstructionManifest(manifestText(routedManifest()))).toEqual([core, h3, assets, fallback]);
  });

  it('keeps legacy manifests and missing optional manifests compatible', async () => {
    expect(parseSkillInstructionManifest(undefined)).toEqual([]);
    expect(parseSkillInstructionManifest(null)).toEqual([]);
    expect(parseSkillInstructionManifest(manifestText({ instructionReferences: [core] }))).toEqual([core]);
    expect(parseSkillInstructionManifest(manifestText({ instructionReferences: [], instructionRoutes: [] }))).toEqual([]);
    expect(await readSkillInstructionFiles(await fixture(undefined))).toBe(rootText);
    expect(await readSkillInstructionFiles(await fixture({ instructionReferences: [core] }), 'H3')).toContain('CORE_ALWAYS');
  });

  it.each([
    null, {}, 'route',
    [{ keywords: [], references: [h3] }],
    [{ keywords: [''], references: [h3] }],
    [{ keywords: ['  '], references: [h3] }],
    [{ keywords: [123], references: [h3] }],
    [{ keywords: ['a'.repeat(121)], references: [h3] }],
    [{ keywords: 'H3', references: [h3] }],
    [{ keywords: ['H3'], references: h3 }],
    [{ keywords: ['H3'], references: [h3], fallback: 'true' }],
    [{ keywords: ['H3'], references: [h3], fallback: null }],
    [{ keywords: ['H3'], references: [h3], fallback: 0 }],
    [{ keywords: ['H3'], references: [h3], script: 'ignored.js' }],
    [null], [[]],
    [{ keywords: Array.from({ length: 65 }, (_, index) => `key${index}`), references: [h3] }],
    Array.from({ length: 129 }, () => ({ keywords: ['H3'], references: [h3] })),
  ])('rejects invalid instructionRoutes %#', (instructionRoutes) => {
    expect(() => parseSkillInstructionManifest(manifestText({ instructionReferences: [], instructionRoutes })))
      .toThrow();
  });

  it('accepts Chinese keywords and explicit false fallback at the route limits', () => {
    const instructionRoutes = Array.from({ length: 128 }, () => ({
      keywords: Array.from({ length: 64 }, (_, index) => `参考${index}`),
      references: [h3], fallback: false,
    }));
    expect(parseSkillInstructionManifest(manifestText({ instructionReferences: [], instructionRoutes }))).toEqual([h3]);
  });

  it.each([
    '../outside.md', 'references/../outside.md', '/references/file.md', 'references/中文.md',
    'references/file.js', 'references\\file.md', 'references/file.MD', 'references/file.md\0',
  ])('rejects an invalid route reference %s', (reference) => {
    expect(() => parseSkillInstructionManifest(manifestText({
      instructionReferences: [], instructionRoutes: [{ keywords: ['H3'], references: [reference] }],
    }))).toThrow();
  });

  it('retains base duplicate rejection and rejects duplicates within one route', () => {
    expect(() => parseSkillInstructionManifest(manifestText({ instructionReferences: [core, 'references/CORE.md'] }))).toThrow();
    expect(() => parseSkillInstructionManifest(manifestText({
      instructionReferences: [], instructionRoutes: [{ keywords: ['H3'], references: [h3, 'references/H3.txt'] }],
    }))).toThrow();
  });
});

describe('route imports validate every declared reference before saving', () => {
  it('rejects missing route and fallback references even before that task is selected', async () => {
    const library = await libraryFixture();
    const files = [upload('SKILL.md', rootText), upload('agent-skill.json', manifestText(routedManifest())), upload(core, 'CORE')];
    await expect(library.importFiles(files)).rejects.toThrow(/参考文件/);
    expect(await library.list()).toEqual([]);
  });

  it('rejects a null byte in an unselected route reference', async () => {
    const library = await libraryFixture();
    const files = [upload('SKILL.md', rootText), upload('agent-skill.json', manifestText({
      instructionReferences: [core], instructionRoutes: [{ keywords: ['H3'], references: [h3] }],
    })), upload(core, 'CORE'), upload(h3, Buffer.from([65, 0, 66]))];
    await expect(library.importFiles(files)).rejects.toThrow(/参考文件/);
    expect(await library.list()).toEqual([]);
  });

  it('rejects a traversal declaration through the real import API', async () => {
    const library = await libraryFixture();
    await expect(library.importFiles([
      upload('SKILL.md', rootText), upload('agent-skill.json', manifestText({
        instructionReferences: [], instructionRoutes: [{ keywords: ['H3'], references: ['references/../SKILL.md'] }],
      })),
    ])).rejects.toThrow(/references/);
    expect(await library.list()).toEqual([]);
  });

  it('imports valid shared route references and retains all declared files', async () => {
    const library = await libraryFixture();
    const manifest = routedManifest();
    const imported = await library.importFiles([
      upload('SKILL.md', rootText), upload('agent-skill.json', manifestText(manifest)),
      ...[core, h3, assets, fallback].map((reference) => upload(reference, reference)),
    ]);
    expect(imported.slug).toBe('route-test');
    expect(imported.fileCount).toBe(6);
    for (const relative of [core, h3, assets, fallback]) {
      expect(await fs.readFile(path.join(library.rootDirectory, imported.slug, ...relative.split('/')), 'utf8')).toBe(relative);
    }
  });
});

describe('selected route files retain bounded file protection', () => {
  it('rejects missing selected files and binary selected files', async () => {
    const directory = await fixture({ instructionReferences: [], instructionRoutes: [{ keywords: ['H3'], references: [h3] }] }, {});
    await expect(readSkillInstructionFiles(directory, 'H3')).rejects.toMatchObject({ code: 'INVALID_AGENT_SKILL_INSTRUCTIONS' });
    await fs.mkdir(path.join(directory, 'references'));
    await fs.writeFile(path.join(directory, ...h3.split('/')), Buffer.from([65, 0, 66]));
    await expect(readSkillInstructionFiles(directory, 'H3')).rejects.toMatchObject({ code: 'INVALID_AGENT_SKILL_INSTRUCTIONS' });
  });

  it('checks the opened selected file identity before reading its contents', async () => {
    const directory = await fixture({
      instructionReferences: [], instructionRoutes: [{ keywords: ['H3'], references: [h3] }],
    });
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...arguments_) => {
      const handle = await originalOpen(...arguments_);
      if (arguments_[0] === path.join(directory, ...h3.split('/'))) {
        const originalStat = handle.stat.bind(handle);
        handle.stat = async () => {
          const stat = await originalStat();
          return { ...stat, ino: -1, isFile: () => stat.isFile() };
        };
      }
      return handle;
    });
    try {
      await expect(readSkillInstructionFiles(directory, 'H3')).rejects.toMatchObject({
        code: 'INVALID_AGENT_SKILL_INSTRUCTIONS', message: 'SKILL 指令文件在读取期间发生变化',
      });
    } finally {
      openSpy.mockRestore();
    }
  });

  it('rejects junction or symlink route components and linked skill roots', async () => {
    const directory = await fixture({
      instructionReferences: [], instructionRoutes: [{ keywords: ['H3'], references: ['references/linked/secret.md'] }],
    }, {});
    const outside = await fixture(undefined, {});
    await fs.writeFile(path.join(outside, 'secret.md'), 'OUTSIDE_SECRET_MARKER');
    await fs.mkdir(path.join(directory, 'references'));
    await fs.symlink(outside, path.join(directory, 'references', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readSkillInstructionFiles(directory, 'H3')).rejects.toMatchObject({ code: 'INVALID_AGENT_SKILL_INSTRUCTIONS' });
    const linkedRoot = path.join(directory, 'linked-root');
    await fs.symlink(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readSkillInstructionFiles(linkedRoot, 'H3')).rejects.toMatchObject({ code: 'INVALID_AGENT_SKILL_INSTRUCTIONS' });
  });
});
