// Repository checks for CI (no npm dependencies):
//  1. frontmatter of agents/*.md and skills/*/SKILL.md: present, simple `key: value` lines, name/description set,
//     agent name = file name, quoted values closed (a strict YAML check runs separately with PyYAML in CI);
//  2. every plugin path mentioned in agents, skills, knowledge, templates and README (scripts/…, knowledge/…,
//     templates/…, skills/…, agents/…) exists;
//  3. every `scripts/<name>.mjs … --flag` in agents, skills and knowledge is a flag the script knows;
//  4. no links to the private build contract (ARCHITECTURE.md) anywhere in the repository.
// Usage: node tools/ci/check-repo.mjs   → code 0 when clean, 1 with a list of problems.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = join(R, 'plugins', 'revizor');
const problems = [];
const rel = f => relative(R, f).replace(/\\/g, '/');
function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    if (n === '.git' || n === 'node_modules') continue;
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
}

// 1. frontmatter
const fmFiles = [...readdirSync(join(P, 'agents')).filter(n => n.endsWith('.md')).map(n => join(P, 'agents', n)),
  ...readdirSync(join(P, 'skills')).map(n => join(P, 'skills', n, 'SKILL.md')).filter(existsSync)];
for (const f of fmFiles) {
  const t = readFileSync(f, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) problems.push(`${rel(f)}: BOM before frontmatter`);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(t.replace(/^﻿/, ''));
  if (!m) { problems.push(`${rel(f)}: no frontmatter`); continue; }
  const kv = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!p) { problems.push(`${rel(f)}: frontmatter line is not "key: value": ${line.slice(0, 60)}`); continue; }
    let v = p[2];
    if (/^["']/.test(v) && !(v.length > 1 && v.endsWith(v[0]))) problems.push(`${rel(f)}: unclosed quote in ${p[1]}`);
    if (/^[^"'].*:\s/.test(v)) problems.push(`${rel(f)}: unquoted value with ": " in ${p[1]} (invalid YAML)`);
    kv[p[1]] = v.replace(/^["']|["']$/g, '');
  }
  for (const k of ['name', 'description']) if (!kv[k]) problems.push(`${rel(f)}: ${k} is empty`);
  if (f.includes(`${join('revizor', 'agents')}`) && kv.name !== basename(f, '.md')) problems.push(`${rel(f)}: name "${kv.name}" differs from file name`);
}

// 2. plugin paths
const docs = walk(R).filter(f => /\.(md|mjs|json|html|js|yml)$/.test(f) && !/[\\/](demo-site[\\/](site|partner)|fixtures)[\\/]/.test(f) && !f.startsWith(join(R, 'claude-ai')));
const pathRe = /(?<![\w./-])((?:\$\{CLAUDE_PLUGIN_ROOT\}\/|<ROOT>\/|plugins\/revizor\/)?(?:scripts|knowledge|templates|skills|agents)\/[\w./-]+?\.(?:mjs|md|json|html|css|js))/g;
for (const f of docs) {
  const t = readFileSync(f, 'utf8');
  for (const m of t.matchAll(pathRe)) {
    const p = m[1].replace(/^(\$\{CLAUDE_PLUGIN_ROOT\}\/|<ROOT>\/|plugins\/revizor\/)/, '');
    if (!existsSync(join(P, p)) && !existsSync(join(dirname(f), p))) problems.push(`${rel(f)}:${t.slice(0, m.index).split('\n').length}: missing file ${p}`);
  }
}

// 3. script flags
const codeOf = new Map();
const lib = ['util', 'cdp', 'dom'].map(n => readFileSync(join(P, 'scripts', 'lib', n + '.mjs'), 'utf8')).join('\n');
const flagDocs = walk(P).filter(f => f.endsWith('.md'));
for (const f of [...flagDocs, join(R, 'README.md'), join(R, 'README.en.md')].filter(existsSync)) {
  readFileSync(f, 'utf8').split('\n').forEach((ln, i) => {
    const hits = [...ln.matchAll(/scripts\/((?:collectors\/)?[\w-]+)\.mjs/g)];
    hits.forEach((h, k) => {
      const name = h[1];
      const file = join(P, 'scripts', name + '.mjs');
      if (!existsSync(file)) return; // reported by check 2
      if (!codeOf.has(name)) codeOf.set(name, readFileSync(file, 'utf8'));
      const code = codeOf.get(name);
      const cmd = ln.slice(h.index, k + 1 < hits.length ? hits[k + 1].index : ln.length).split('`')[0];
      for (const fm of cmd.matchAll(/(?<![\w-])--([a-z][\w-]*)/g)) {
        const flag = fm[1];
        const re = new RegExp(`--${flag.replace(/-/g, '\\-')}(?![\\w-])`);
        if (!(code.includes(`'${flag}'`) || code.includes(`"${flag}"`) || re.test(code) || lib.includes(`'${flag}'`))) problems.push(`${rel(f)}:${i + 1}: ${name}.mjs has no flag --${flag}`);
      }
    });
  });
}

// 4. no links to the private contract
for (const f of walk(R).filter(f => /\.(md|mjs|json|js|html|yml)$/.test(f) && !f.endsWith(join('ci', 'check-repo.mjs')))) {
  const t = readFileSync(f, 'utf8');
  const i = t.search(/ARCHITECTURE(\.md| §)/);
  if (i >= 0) problems.push(`${rel(f)}:${t.slice(0, i).split('\n').length}: link to ARCHITECTURE (not in the repository)`);
}

if (problems.length) { console.log(`check-repo: ${problems.length} problem(s)`); for (const p of problems) console.log('  ' + p); process.exit(1); }
console.log(`check-repo: ok · frontmatter ${fmFiles.length} files · paths and flags in ${docs.length} files`);
