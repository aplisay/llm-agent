#!/usr/bin/env node
/**
 * Build environment-example, environment-example.polite-ai and
 * docs/self-hosting/configuration.md from config/env.schema.json.
 *
 *   yarn env:generate           write the files
 *   yarn env:generate --check   exit 1 if any file is out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './scan.mjs';

export function loadSchema() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/env.schema.json'), 'utf8'));
}

function wrap(text, width, prefix = '') {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (prefix + line + ' ' + word).length > width) {
      lines.push(prefix + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(prefix + line);
  return lines;
}

function envFile(schema, kinds, header) {
  const out = [...header, ''];
  for (const group of schema.groups) {
    const vars = schema.variables.filter((v) => v.group === group.id && kinds.includes(v.template));
    if (!vars.length) continue;
    out.push(`# ── ${group.title} ${'─'.repeat(Math.max(3, 74 - group.title.length))}`);
    out.push(...wrap(group.description, 78, '# '));
    for (const v of vars) {
      out.push('');
      out.push(...wrap(v.description, 78, '# '));
      const line = `${v.name}=${v.example ?? ''}`;
      out.push(v.template.endsWith('commented') ? `# ${line}` : line);
    }
    out.push('');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

export function mainTemplate(schema) {
  return envFile(schema, ['set', 'commented'], [
    '# Example environment for the API server. Copy it to .env and edit it.',
    '#',
    '# Generated from config/env.schema.json by `yarn env:generate`. Edit the',
    '# schema, not this file. docs/self-hosting/configuration.md describes every',
    '# variable, including the ones not listed here.',
    '#',
    '# A value written as <...> is treated as unset, with a warning at start.',
    '# Settings for user sign-up and email are in environment-example.polite-ai.',
  ]);
}

export function politeTemplate(schema) {
  return envFile(schema, ['polite-ai-set', 'polite-ai-commented'], [
    '# Extra settings for running the API server behind a front end that signs',
    '# users up and sends email, such as polite.ai. A self-hosted instance that',
    '# uses API keys alone does not need any of this. Append what you need to .env.',
    '#',
    '# Generated from config/env.schema.json by `yarn env:generate`. Edit the',
    '# schema, not this file.',
  ]);
}

const COMPONENT_NAMES = { api: 'API', livekit: 'LiveKit', pipecat: 'Pipecat', sipbridge: 'sipbridge' };

function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|');
}

export function configurationDoc(schema) {
  const out = [
    '# Configuration reference',
    '',
    '<!-- Generated from config/env.schema.json by `yarn env:generate`. Edit the schema, not this file. -->',
    '',
    'Every component reads plain environment variables. The API server and the LiveKit worker also read a `.env` file from their working directory.',
    'Start from [`environment-example`](../../environment-example): `cp environment-example .env`.',
    '',
    '- A value written as `<...>` is treated as unset, and the server says so at start.',
    '- `yarn doctor`, the start-up log and `GET /api/health` show which runtimes and providers are enabled, and which variables are missing for the rest.',
    '- A runtime whose variables are unset is disabled, and its models are not listed in `GET /models`.',
    '',
    'Components: **API** is the API server, **LiveKit** and **Pipecat** are the voice workers, **sipbridge** is the Pipecat SIP gateway.',
    '',
  ];
  for (const group of schema.groups) {
    const vars = schema.variables.filter((v) => v.group === group.id);
    if (!vars.length) continue;
    out.push(`## ${group.title}`, '', group.description, '');
    out.push('| Variable | Components | Default | Description |', '|---|---|---|---|');
    for (const v of vars) {
      const notes = [
        v.required ? `Required ${v.required === 'always' ? 'always' : v.required}.` : '',
        v.secret ? 'Secret.' : '',
      ].filter(Boolean).join(' ');
      out.push(`| \`${v.name}\` | ${v.components.map((c) => COMPONENT_NAMES[c]).join(', ')} | ${v.default ? `\`${cell(v.default)}\`` : ''} | ${cell(v.description)}${notes ? ` ${notes}` : ''} |`);
    }
    out.push('');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

export function generatedFiles(schema = loadSchema()) {
  return {
    'environment-example': mainTemplate(schema),
    'environment-example.polite-ai': politeTemplate(schema),
    'docs/self-hosting/configuration.md': configurationDoc(schema),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [file, content] of Object.entries(generatedFiles())) {
    const target = path.join(repoRoot, file);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === content) continue;
    if (check) {
      console.error(`${file} is out of date: run yarn env:generate`);
      stale++;
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      console.log(`wrote ${file}`);
    }
  }
  process.exit(stale ? 1 : 0);
}
