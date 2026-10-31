import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isSeq, parseDocument } from 'yaml';

export interface SyncOptions {
  source: string;
  output: string;
  yes?: boolean;
  syncCollectionHeaders?: boolean;
}

function mergeJsonBody(existing: unknown, imported: unknown): unknown {
  if (existing === null || existing === undefined || existing === '') return imported;
  if (Array.isArray(existing)) return existing.length ? existing : imported;
  if (typeof existing === 'object') {
    if (imported === null || typeof imported !== 'object' || Array.isArray(imported)) {
      return Object.keys(existing).length ? existing : imported;
    }
    const merged = new Map(Object.entries(imported));
    for (const [key, value] of Object.entries(existing)) {
      const preserved = mergeJsonBody(value, merged.get(key));
      if (preserved !== undefined) merged.set(key, preserved);
    }
    return Object.fromEntries(merged);
  }
  return existing;
}

function preserveJsonBody(existingFile: string, importedFile: string): void {
  const extension = path.extname(importedFile);
  if (!['.bru', '.yml', '.yaml'].includes(extension)) return;
  const existingContent = fs.readFileSync(existingFile, 'utf-8');
  const importedContent = fs.readFileSync(importedFile, 'utf-8');

  function mergeData(existingData: string, importedData: string): string {
    try {
      const existing = JSON.parse(existingData);
      const imported = JSON.parse(importedData);
      const merged = mergeJsonBody(existing, imported);
      if (isDeepStrictEqual(merged, existing)) return existingData;
      if (isDeepStrictEqual(merged, imported)) return importedData;
      return JSON.stringify(merged, null, 2);
    } catch {
      throw new Error(`Cannot preserve JSON body in ${existingFile}: body must contain valid JSON`);
    }
  }

  if (extension === '.bru') {
    const bodyBlock = /^body:json\s*\{\r?\n([\s\S]*?)^\}/m;
    const existingBody = existingContent.match(bodyBlock);
    const importedBody = importedContent.match(bodyBlock);
    if (!existingBody || !importedBody) return;
    const merged = mergeData(existingBody[1], importedBody[1]);
    const block = merged === existingBody[1] ? existingBody[0]
      : merged === importedBody[1] ? importedBody[0]
        : `body:json {\n${merged.split('\n').map((line) => `  ${line}`).join('\n')}\n}`;
    fs.writeFileSync(importedFile, importedContent.replace(bodyBlock, () => block));
    return;
  }

  const existing = parseDocument(existingContent);
  const imported = parseDocument(importedContent);
  if (existing.errors.length || imported.errors.length) {
    throw new Error(`Cannot read request body in ${existingFile}: invalid YAML`);
  }
  if (existing.getIn(['http', 'body', 'type']) !== 'json'
    || imported.getIn(['http', 'body', 'type']) !== 'json') return;
  const dataPath = ['http', 'body', 'data'];
  const existingData = existing.getIn(dataPath);
  const importedData = imported.getIn(dataPath);
  if (typeof existingData !== 'string' || typeof importedData !== 'string') return;
  const merged = mergeData(existingData, importedData);
  if (merged === importedData) return;
  imported.setIn(dataPath, merged);
  fs.writeFileSync(importedFile, isDeepStrictEqual(existing.toJS(), imported.toJS())
    ? existingContent : imported.toString());
}

function preserveParamValues(existingFile: string, importedFile: string): void {
  const extension = path.extname(importedFile);
  if (!['.bru', '.yml', '.yaml'].includes(extension)) return;
  const existingContent = fs.readFileSync(existingFile, 'utf-8');
  const importedContent = fs.readFileSync(importedFile, 'utf-8');
  const values = new Map<string, unknown[]>();
  const paramKey = (type: string, name: string): string => JSON.stringify([type, name]);
  const remember = (key: string, value: unknown): void => {
    const entries = values.get(key) ?? [];
    entries.push(value);
    values.set(key, entries);
  };

  if (extension === '.bru') {
    const blocks = /^(params:query|params:path|query)\s*\{\r?\n([\s\S]*?)^\}/gm;
    // Keep the imported key and enabled state; replace only its value.
    const entries = /^([ \t]*~?("(?:\\.|[^"\\])*"|[^:\s][^:\r\n]*?)[ \t]*:[ \t]*)('''[\s\S]*?'''|[^\r\n]*)/gm;
    const keyFor = (block: string, name: string): string => paramKey(
      block === 'params:path' ? 'path' : 'query',
      name.startsWith('"') ? JSON.parse(name) : name.trim(),
    );
    for (const [, block, content] of existingContent.matchAll(blocks)) {
      for (const [, , name, value] of content.matchAll(entries)) {
        remember(keyFor(block, name), value);
      }
    }
    const content = importedContent.replace(blocks, (whole, block: string, body: string) => {
      const merged = body.replace(entries, (entry, prefix: string, name: string) => {
        const value = values.get(keyFor(block, name))?.shift();
        if (typeof value !== 'string') return entry;
        const filled = value.startsWith("'''") ? value.slice(3, -3).trim() : value.trim();
        return filled ? `${prefix}${value}` : entry;
      });
      return whole.replace(body, () => merged);
    });
    if (content !== importedContent) fs.writeFileSync(importedFile, content);
    return;
  }

  const existing = parseDocument(existingContent);
  const imported = parseDocument(importedContent);
  if (existing.errors.length || imported.errors.length) {
    throw new Error(`Cannot read parameters in ${existingFile}: invalid YAML`);
  }
  const existingParams = existing.getIn(['http', 'params']);
  const importedParams = imported.getIn(['http', 'params']);
  if (!isSeq(existingParams) || !isSeq(importedParams)) return;
  for (const param of existingParams.items) {
    if (!isMap(param) || typeof param.get('name') !== 'string') continue;
    remember(paramKey(String(param.get('type') ?? 'query'), param.get('name') as string), param.get('value'));
  }
  let changed = false;
  for (const param of importedParams.items) {
    if (!isMap(param) || typeof param.get('name') !== 'string') continue;
    const value = values.get(paramKey(String(param.get('type') ?? 'query'), param.get('name') as string))?.shift();
    if ((typeof value !== 'string' || !value.trim()) && typeof value !== 'number' && typeof value !== 'boolean') continue;
    if (isDeepStrictEqual(value, param.get('value'))) continue;
    param.set('value', value);
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(importedFile, isDeepStrictEqual(existing.toJS(), imported.toJS())
      ? existingContent : imported.toString());
  }
}

function preserveInheritedAuth(existingFile: string, importedFile: string): void {
  const extension = path.extname(importedFile);
  if (!['.bru', '.yml', '.yaml'].includes(extension)) return;
  const existingContent = fs.readFileSync(existingFile, 'utf-8');
  const importedContent = fs.readFileSync(importedFile, 'utf-8');

  if (extension === '.bru') {
    const requestBlock = /^(?:get|post|put|patch|delete|head|options|trace|connect|http|grpc|ws)\s*\{\r?\n[\s\S]*?^\}/gm;
    const inherited = [...existingContent.matchAll(requestBlock)]
      .some(([block]) => /^\s*auth:\s*inherit\s*$/m.test(block));
    if (!inherited || !requestBlock.test(importedContent)) return;
    requestBlock.lastIndex = 0;
    const content = importedContent.replace(requestBlock, (block) => {
      const authLine = /^[ \t]*auth:[^\r\n]*/m;
      return authLine.test(block)
        ? block.replace(authLine, '  auth: inherit')
        : block.replace(/^\}/m, '  auth: inherit\n}');
    }).replace(/^auth:[\w-]+\s*\{\r?\n[\s\S]*?^\}\r?\n?/gm, '');
    fs.writeFileSync(importedFile, content);
    return;
  }

  const existing = parseDocument(existingContent);
  const imported = parseDocument(importedContent);
  if (existing.errors.length || imported.errors.length) {
    throw new Error(`Cannot read authentication in ${existingFile}: invalid YAML`);
  }
  let changed = false;
  for (const section of ['http', 'request', 'grpc', 'websocket']) {
    const authPath = [section, 'auth'];
    if (existing.getIn(authPath) === 'inherit' && (section === 'request' || imported.has(section))
      && imported.getIn(authPath) !== 'inherit') {
      imported.setIn(authPath, 'inherit');
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(importedFile, isDeepStrictEqual(existing.toJS(), imported.toJS())
      ? existingContent : imported.toString());
  }
}

function preserveCollectionSettings(existingFile: string, importedFile: string, syncHeaders: boolean): void {
  const existingContent = fs.readFileSync(existingFile, 'utf-8');
  const importedContent = fs.readFileSync(importedFile, 'utf-8');
  if (path.basename(importedFile) === 'collection.bru') {
    const blocks = ['vars:pre-request', 'vars:post-response'];
    if (!syncHeaders) blocks.push('headers');
    const authBlocks = /^auth(?::[\w:-]+)?(?=\s*\{)/gm;
    blocks.push(...new Set([
      ...(existingContent.match(authBlocks) ?? []),
      ...(importedContent.match(authBlocks) ?? []),
    ]));
    let content = importedContent;
    for (const name of blocks) {
      const block = new RegExp(`^${name}\\s*\\{\\r?\\n[\\s\\S]*?^\\}`, 'm');
      const existingBlock = existingContent.match(block)?.[0];
      const hasBlock = block.test(content);
      content = content.replace(block, () => existingBlock ?? '');
      if (existingBlock && !hasBlock) content = `${content.trimEnd()}\n\n${existingBlock}\n`;
    }
    fs.writeFileSync(importedFile, content);
    return;
  }

  const existing = parseDocument(existingContent);
  const imported = parseDocument(importedContent);
  for (const [document, file] of [[existing, existingFile], [imported, importedFile]] as const) {
    if (document.errors.length) {
      throw new Error(`Cannot read collection settings in ${file}: ${document.errors[0].message}`);
    }
  }

  const fields = ['variables', 'auth'];
  if (!syncHeaders) fields.push('headers');
  let changed = false;
  for (const field of fields) {
    const fieldPath = ['request', field];
    if (isDeepStrictEqual(existing.toJS()?.request?.[field], imported.toJS()?.request?.[field])) continue;
    changed = true;
    if (existing.hasIn(fieldPath)) {
      imported.setIn(fieldPath, imported.createNode(existing.toJS().request[field]));
    } else {
      imported.deleteIn(fieldPath);
      const request = imported.get('request', true);
      if (isMap(request) && request.items.length === 0) imported.delete('request');
    }
  }
  if (!changed) return;

  // Avoid prompting for a change caused solely by YAML formatting.
  fs.writeFileSync(importedFile, isDeepStrictEqual(existing.toJS(), imported.toJS())
    ? existingContent
    : imported.toString());
}

export function getBruCommand(): string {
  try {
    execSync('bru --version', { stdio: 'ignore' });
    return 'bru';
  } catch {
    return 'npx @usebruno/cli';
  }
}

export function walkDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

/**
 * Returns all directories (recursively) within a directory, as a Set of
 * normalised absolute paths (including the root dir itself).
 */
export function walkDirs(dir: string): Set<string> {
  const dirs = new Set<string>();
  dirs.add(path.normalize(dir));
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const full = path.join(dir, entry.name);
      for (const d of walkDirs(full)) dirs.add(d);
    }
  }
  return dirs;
}

/** Preserve existing folder names; use spaces instead of underscores for new folders. */
function mapDirectories(importedDirs: Set<string>, tmpDir: string, outputDir: string): Map<string, string> {
  const directories = new Map<string, string>([[tmpDir, outputDir]]);
  const usedTargets = new Set<string>();
  const folderKey = (name: string): string => name.replace(/\s/g, '_');

  // walkDirs visits parents before their children, so nested folders resolve too.
  for (const importedDir of importedDirs) {
    const parent = directories.get(path.dirname(importedDir))!;
    const name = path.basename(importedDir);
    let target = path.join(parent, name);

    if (!fs.existsSync(target)) {
      const matches = fs.existsSync(parent)
        ? fs.readdirSync(parent, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && folderKey(entry.name) === folderKey(name))
        : [];
      if (matches.length > 1) {
        throw new Error(`Ambiguous folder match for ${importedDir}: ${matches.map((entry) => path.join(parent, entry.name)).join(', ')}`);
      }
      target = path.join(parent, matches.length === 1 ? matches[0].name : name.replace(/_/g, ' '));
    }

    if (usedTargets.has(target)) {
      throw new Error(`Multiple imported folders map to the same output folder: ${target}`);
    }
    usedTargets.add(target);
    directories.set(importedDir, target);
  }
  return directories;
}

export function showDiff(existingFile: string, newFile: string): void {
  // Use --no-pager and GIT_PAGER=cat to prevent git from launching `less`
  spawnSync('git', ['--no-pager', 'diff', '--no-index', '--color=always', existingFile, newFile], {
    stdio: 'inherit',
    env: { ...process.env, GIT_PAGER: 'cat', LESS: '-FRX' },
  });
}

/**
 * Remove empty directories bottom-up within a root directory.
 * The root itself is never removed.
 */
function pruneEmptyDirs(dir: string, root: string): void {
  if (!fs.existsSync(dir) || dir === root) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      pruneEmptyDirs(path.join(dir, entry.name), root);
    }
  }
  const remaining = fs.readdirSync(dir);
  if (remaining.length === 0) {
    fs.rmdirSync(dir);
  }
}

export async function sync(options: SyncOptions): Promise<void> {
  const { source, output: outputDir, yes = false, syncCollectionHeaders = false } = options;
  const bruCmd = getBruCommand();
  const rl = createInterface({ input, output });

  async function askUser(question: string): Promise<string> {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase();
  }

  const sourcePath = path.resolve(source);
  const outputPath = path.resolve(outputDir);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`OpenAPI source file not found: ${sourcePath}`);
  }

  // Place tmpDir as a sibling of outputPath to avoid any path collision
  const tmpDir = path.join(path.dirname(outputPath), '.bruno-sync-tmp');

  if (path.normalize(tmpDir) === path.normalize(outputPath)) {
    throw new Error(`Output path cannot be ".bruno-sync-tmp" — choose a different output directory`);
  }

  try {
    // Clean and recreate temp dir
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    const cwd = process.cwd();
    const relSource = path.relative(cwd, sourcePath).replace(/\\/g, '/');
    const relOutput = path.relative(cwd, tmpDir).replace(/\\/g, '/');

    console.log(`→ Importing OpenAPI to temp dir (using ${bruCmd})...`);

    execSync(`${bruCmd} import openapi --source ${relSource} --output ${relOutput}`, {
      stdio: 'inherit',
      cwd,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    });

    // bru always creates a single named subdirectory inside the output dir
    // (e.g. "Simple Test API/"). Detect it and use it as the canonical root.
    const topLevelEntries = fs.readdirSync(tmpDir, { withFileTypes: true });
    const collectionDirs = topLevelEntries.filter((e) => e.isDirectory());
    if (collectionDirs.length !== 1) {
      throw new Error(
        `Expected bru to create exactly one collection directory in ${tmpDir}, got: ${topLevelEntries.map((e) => e.name).join(', ')}`,
      );
    }
    const collectionName = collectionDirs[0].name;
    const tmpRoot = path.join(tmpDir, collectionName);

    // Collect all files and directories produced by bru import
    const tmpFiles = walkDir(tmpRoot);
    const tmpDirs = walkDirs(tmpRoot);
    const directories = mapDirectories(tmpDirs, tmpDir, outputPath);
    const outputRoot = directories.get(tmpRoot)!;
    const managedDirs = new Set([...tmpDirs].map((dir) => directories.get(dir)!));
    const targetFile = (file: string): string =>
      path.join(directories.get(path.dirname(file))!, path.basename(file));
    const expectedFiles = new Set(tmpFiles.map(targetFile));

    // Bruno displays info.name from folder.yml rather than the directory name.
    for (const importedDir of tmpDirs) {
      if (importedDir === tmpRoot) continue;
      const importedFile = path.join(importedDir, 'folder.yml');
      if (!fs.existsSync(importedFile)) continue;
      const existingDir = directories.get(importedDir)!;
      const existingFile = path.join(existingDir, 'folder.yml');
      const imported = parseDocument(fs.readFileSync(importedFile, 'utf-8'));
      const existing = fs.existsSync(existingFile)
        ? parseDocument(fs.readFileSync(existingFile, 'utf-8'))
        : undefined;
      if (imported.errors.length || existing?.errors.length) {
        throw new Error(`Cannot read folder metadata for ${existingDir}`);
      }
      const name = existing?.getIn(['info', 'name']) ?? path.basename(existingDir);
      if (imported.getIn(['info', 'name']) !== name) {
        imported.setIn(['info', 'name'], name);
        fs.writeFileSync(importedFile, imported.toString());
      }
    }

    for (const name of ['opencollection.yml', 'opencollection.yaml', 'collection.bru']) {
      const importedFile = path.join(tmpRoot, name);
      const existingFile = path.join(outputRoot, name);
      if (fs.existsSync(importedFile) && fs.existsSync(existingFile)) {
        preserveCollectionSettings(existingFile, importedFile, syncCollectionHeaders);
      }
    }

    for (const tmpFile of tmpFiles) {
      const existingFile = targetFile(tmpFile);
      if (fs.existsSync(existingFile)) {
        preserveJsonBody(existingFile, tmpFile);
        preserveParamValues(existingFile, tmpFile);
        preserveInheritedAuth(existingFile, tmpFile);
      }
    }

    let acceptAll = yes;
    let quit = false;

    // ── Phase 1: add / update files ──────────────────────────────────────────
    for (const tmpFile of tmpFiles) {
      if (quit) break;

      const existingFile = targetFile(tmpFile);
      const relPath = path.relative(outputRoot, existingFile);

      if (!fs.existsSync(existingFile)) {
        // New file — auto-add without prompting
        fs.mkdirSync(path.dirname(existingFile), { recursive: true });
        fs.copyFileSync(tmpFile, existingFile);
        console.log(`\n✚ Added: ${path.join(collectionName, relPath)}`);
        continue;
      }

      const existingContent = fs.readFileSync(existingFile, 'utf-8');
      const newContent = fs.readFileSync(tmpFile, 'utf-8');

      if (existingContent === newContent) {
        continue; // Identical — skip silently
      }

      // Changed — show diff and prompt
      console.log(`\n── Changed: ${path.join(collectionName, relPath)} ──`);
      showDiff(existingFile, tmpFile);

      if (!acceptAll) {
        const answer = await askUser('\nApply this change? [y/n/a(all)/q(quit)] ');
        if (answer === 'q') {
          console.log('Quitting — no further changes applied.');
          quit = true;
          break;
        } else if (answer === 'a') {
          acceptAll = true;
        } else if (answer !== 'y') {
          console.log('  Skipped.');
          continue;
        }
      }

      fs.copyFileSync(tmpFile, existingFile);
      console.log(`  ✔ Updated: ${path.join(collectionName, relPath)}`);
    }

    // ── Phase 2: delete files no longer in spec ───────────────────────────────
    // Only consider files whose parent directory was produced by THIS bru import.
    // This prevents touching files that belong to a different spec synced into
    // the same parent output directory.
    if (!quit && fs.existsSync(outputRoot)) {
      const existingFiles = walkDir(outputRoot);

      for (const existingFile of existingFiles) {
        if (quit) break;

        const relPath = path.relative(outputRoot, existingFile);
        // Only flag as stale if the parent directory is known to bru's output
        if (!managedDirs.has(path.dirname(existingFile))) {
          continue; // Not managed by this spec — leave it alone
        }

        if (!expectedFiles.has(existingFile)) {
          console.log(`\n── Removed from spec: ${path.join(collectionName, relPath)} ──`);

          if (!acceptAll) {
            const answer = await askUser('Delete this file? [y/n] ');
            if (answer !== 'y') {
              console.log('  Kept.');
              continue;
            }
          }

          fs.unlinkSync(existingFile);
          console.log(`  ✖ Deleted: ${path.join(collectionName, relPath)}`);
        }
      }

      // Clean up any directories that became empty after deletions
      for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          pruneEmptyDirs(path.join(outputRoot, entry.name), outputRoot);
        }
      }
    }

    console.log('\n✓ Bruno sync complete.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    rl.close();
  }
}
