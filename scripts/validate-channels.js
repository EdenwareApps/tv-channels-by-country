#!/usr/bin/env node
/**
 * Validate every file in channels/.
 *
 * Errors break the contract of the dataset (invalid JSON, category that is not
 * an array, channel without a name, priority out of range).
 * Warnings are data-quality signals we are still cleaning up (accents in
 * keywords, duplicated names, priority that the build has to clamp).
 *
 * Usage:
 *   node scripts/validate-channels.js                # errors + warning summary
 *   node scripts/validate-channels.js --strict       # warnings also fail
 *   node scripts/validate-channels.js --country br,pt
 *   node scripts/validate-channels.js --fix          # rewrite the files fixing warnings
 *
 * --fix only applies changes the build already makes silently (priority clamps,
 * accent removal in keywords) or that do not change the resulting lookup index
 * (duplicated names in the same category are merged). Duplicated names in
 * different categories are allowed and never touched.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'channels');

// Espelha src/index.js: o build normaliza esses limites, o JSON nao precisa respeitar.
const CATEGORY_MAX_PRIORITY = { Religious: 4, Shop: 4 };
const RETRANSMITS_MIN = 8;
const hasStrippedMarks = value => /\p{M}/u.test(value.normalize('NFD'));

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const fix = args.includes('--fix');
const only = (() => {
  const i = args.indexOf('--country');
  if (i === -1) return null;
  const list = args[i + 1];
  if (!list) throw new Error('--country needs a comma separated list, e.g. --country br,pt');
  return new Set(list.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
})();

// Chave de comparacao que espelha o que o matcher considera "o mesmo canal":
// "&" e "+" carregam significado (o matcher os le como "and" e "plus"), entao nao
// podem ser descartados como simples pontuacao.
const keyOf = name => String(name)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\+/g, ' plus ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function validate(data) {
  const errors = [];
  const warnings = [];
  const fail = message => errors.push(message);
  const warn = (rule, message) => warnings.push({ rule, message });

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('root must be an object of category -> channel list');
    return { errors, warnings };
  }
  const categories = Object.keys(data);

  for (const category of categories) {
    const list = data[category];
    if (!Array.isArray(list)) {
      fail(`${category}: value must be an array`);
      continue;
    }
    // Duplicated names are only a problem inside the same category: the same
    // channel legitimately appears under Entertainment and News, for instance.
    const seen = new Map();
    const maxPriority = CATEGORY_MAX_PRIORITY[category];
    list.forEach((channel, index) => {
      const where = `${category}[${index}]`;
      if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
        fail(`${where}: must be an object`);
        return;
      }
      if (typeof channel.name !== 'string' || !channel.name.trim()) {
        fail(`${where}: name is required`);
        return;
      }
      const label = `${where} ${channel.name}`;

      if ('isFree' in channel && channel.isFree !== null && typeof channel.isFree !== 'boolean') {
        fail(`${label}: isFree must be a boolean`);
      }
      for (const field of ['shortName', 'keywords', 'retransmits', 'logo', 'website']) {
        if (field in channel && channel[field] !== null && typeof channel[field] !== 'string') {
          fail(`${label}: ${field} must be a string or null`);
        }
      }
      if ('priority' in channel) {
        if (!Number.isInteger(channel.priority) || channel.priority < 0 || channel.priority > 10) {
          fail(`${label}: priority must be an integer between 0 and 10`);
        }
      }

      const retransmits = typeof channel.retransmits === 'string' && channel.retransmits.trim() !== '';
      if (retransmits && channel.priority !== undefined && channel.priority < RETRANSMITS_MIN) {
        warn('retransmits below the minimum priority', `${label}: retransmits with priority ${channel.priority} (build raises it to ${RETRANSMITS_MIN})`);
      }
      if (maxPriority && !retransmits && channel.priority !== undefined && channel.priority > maxPriority) {
        warn(`priority above the ${maxPriority} cap of ${category}`, `${label}: priority above the ${maxPriority} cap of ${category} (build clamps it)`);
      }
      if (typeof channel.keywords === 'string' && hasStrippedMarks(channel.keywords)) {
        warn('keywords with accents', `${label}: keywords must not carry diacritics (the matcher strips them)`);
      }

      const key = keyOf(channel.name);
      if (key) {
        if (seen.has(key)) {
          warn('duplicated name in this category', `${label}: duplicated name in this category (same as ${seen.get(key)})`);
        } else {
          seen.set(key, where);
        }
      }
    });
  }
  return { errors, warnings };
}

const toAscii = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function mergeKeywords(target, extra) {
  const items = String(target).split('|').map(item => item.trim()).filter(Boolean);
  const seen = new Set(items);
  for (const item of String(extra).split('|').map(item => item.trim()).filter(Boolean)) {
    if (!seen.has(item)) {
      seen.add(item);
      items.push(item);
    }
  }
  return items.join(' | ');
}

/** Keeps the first entry of a duplicated pair and folds in whatever only the other one had. */
function mergeChannel(target, extra) {  for (const field of ['shortName', 'retransmits', 'logo', 'website']) {
    if ((target[field] === undefined || target[field] === null) && extra[field] !== undefined && extra[field] !== null) {
      target[field] = extra[field];
    }
  }
  if (typeof extra.keywords === 'string' && extra.keywords.trim()) {
    target.keywords = typeof target.keywords === 'string' && target.keywords.trim()
      ? mergeKeywords(target.keywords, extra.keywords)
      : extra.keywords;
  }
}

/**
 * Applies the warning fixes in place. Every change is behaviour neutral: the
 * build clamps those priorities and strips accents anyway, and merging the
 * duplicated names keeps the same names and a superset of the keywords.
 */
function applyFixes(data) {
  let changes = 0;
  for (const [category, list] of Object.entries(data)) {
    if (!Array.isArray(list)) continue;
    const maxPriority = CATEGORY_MAX_PRIORITY[category];
    const seen = new Map();
    const out = [];
    for (const channel of list) {
      if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
        out.push(channel);
        continue;
      }
      const retransmits = typeof channel.retransmits === 'string' && channel.retransmits.trim() !== '';
      if (retransmits && channel.priority !== undefined && channel.priority < RETRANSMITS_MIN) {
        channel.priority = RETRANSMITS_MIN;
        changes++;
      } else if (maxPriority && !retransmits && channel.priority !== undefined && channel.priority > maxPriority) {
        channel.priority = maxPriority;
        changes++;
      }
      if (typeof channel.keywords === 'string' && hasStrippedMarks(channel.keywords)) {
        channel.keywords = toAscii(channel.keywords);
        changes++;
      }
      const key = typeof channel.name === 'string' ? keyOf(channel.name) : '';
      const previous = key ? seen.get(key) : null;
      if (previous) {
        mergeChannel(previous, channel);
        changes++;
        continue;
      }
      if (key) seen.set(key, channel);
      out.push(channel);
    }
    if (out.length !== list.length) data[category] = out;
  }
  return changes;
}

const files = (await readdir(DIR))
  .filter(file => file.endsWith('.json') && file !== 'countries.json')
  .sort()
  .filter(file => !only || only.has(file.replace(/\.json$/, '')));

let failed = 0;
let warned = 0;
let fixedFiles = 0;
let fixedChanges = 0;
const totals = {};
for (const file of files) {
  let data;
  const filePath = path.join(DIR, file);
  try {
    data = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    failed++;
    console.error(`FAIL ${file}: invalid JSON (${error.message})`);
    continue;
  }
  const { errors, warnings } = validate(data);
  if (errors.length) {
    failed++;
    console.error(`FAIL ${file} (${errors.length} error(s))`);
    errors.slice(0, 10).forEach(message => console.error(`  - ${message}`));
    if (errors.length > 10) console.error(`  ... and ${errors.length - 10} more`);
    continue;
  }
  const countWarnings = list => {
    if (!list.length) return;
    warned++;
    list.forEach(({ rule }) => {
      totals[rule] = (totals[rule] ?? 0) + 1;
    });
  };
  if (fix) {
    // Merging a duplicated name can move fields (retransmits, keywords) onto the
    // surviving entry, which may expose a new warning, so repeat until stable.
    let changes = 0;
    for (let pass = 0; pass < 5; pass++) {
      const applied = applyFixes(data);
      changes += applied;
      if (!applied) break;
    }
    if (changes) {
      await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fixedFiles++;
      fixedChanges += changes;
    }
    countWarnings(validate(data).warnings);
    continue;
  }
  countWarnings(warnings);
}

if (fix) console.warn(`FIXED ${fixedChanges} issue(s) in ${fixedFiles} file(s).`);

const summary = Object.entries(totals).sort((a, b) => b[1] - a[1]);
if (summary.length) {
  console.warn(`${strict ? 'FAIL' : 'WARN'} ${warned} file(s) with warnings:`);
  summary.forEach(([rule, count]) => console.warn(`  - ${count} x ${rule}`));
  if (!strict) console.warn('  (use --strict to make warnings fail)');
}

if (failed || (strict && warned)) {
  console.error(`\n${failed} file(s) with errors, ${warned} with warnings, out of ${files.length}.`);
  process.exit(1);
}
console.log(`OK ${files.length} file(s) valid.`);
