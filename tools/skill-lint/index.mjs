#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const registryPath = join(root, 'apps/mcp/src/server.ts');
const skillsPath = join(root, 'skills');

function registeredTools(source) {
  const names = new Set();
  const pattern = /server\.registerTool\(\s*(['"])([a-z][a-z0-9_]*)\1/g;
  for (const match of source.matchAll(pattern)) names.add(match[2]);
  return names;
}

function requiredToolSection(markdown) {
  const heading = /^## Required MCP tools\s*$/m.exec(markdown);
  if (heading === null) return null;

  const rest = markdown.slice(heading.index + heading[0].length);
  const nextHeading = /^## /m.exec(rest);
  return nextHeading === null ? rest : rest.slice(0, nextHeading.index);
}

function declaredTools(section) {
  const names = [];
  const pattern = /^- `([a-z][a-z0-9_]*)`(?:\s+—\s+.+)?\s*$/gm;
  for (const match of section.matchAll(pattern)) names.push(match[1]);
  return names;
}

function main() {
  const registry = registeredTools(readFileSync(registryPath, 'utf8'));
  const failures = [];

  if (registry.size === 0) {
    failures.push(`no literal MCP tool registrations found in ${registryPath}`);
  }

  const skillFiles = readdirSync(skillsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsPath, entry.name, 'SKILL.md'))
    .filter((path) => existsSync(path))
    .sort();

  if (skillFiles.length === 0) failures.push(`no SKILL.md files found below ${skillsPath}`);

  for (const skillFile of skillFiles) {
    const skillName = skillFile.slice(skillsPath.length + 1, -'/SKILL.md'.length);
    const section = requiredToolSection(readFileSync(skillFile, 'utf8'));
    if (section === null) {
      failures.push(`${skillName}: missing "## Required MCP tools" section`);
      continue;
    }

    const declared = declaredTools(section);
    if (declared.length === 0) {
      failures.push(`${skillName}: declares no MCP tools`);
      continue;
    }

    const duplicates = declared.filter((name, index) => declared.indexOf(name) !== index);
    if (duplicates.length > 0) {
      failures.push(`${skillName}: duplicate declarations: ${[...new Set(duplicates)].join(', ')}`);
    }

    const missing = declared.filter((name) => !registry.has(name));
    if (missing.length > 0) {
      failures.push(`${skillName}: tools absent from MCP registry: ${missing.join(', ')}`);
      continue;
    }

    process.stdout.write(`skill-lint: ${skillName} declares ${declared.length} registered tool(s)\n`);
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`skill-lint: ERROR: ${failure}\n`);
    return 1;
  }

  process.stdout.write(
    `skill-lint: ${skillFiles.length} skill(s) passed against ${registry.size} registered MCP tool(s)\n`,
  );
  return 0;
}

process.exit(main());
