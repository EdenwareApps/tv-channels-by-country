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
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'channels');

// Espelha src/index.js: o build normaliza esses limites, o JSON nao precisa respeitar.
const CATEGORY_MAX_PRIORITY = { Religious: 4, Shop: 4 };
const RETRANSMITS_MIN = 8;
const ASCII = /^[\x20-\x7E]*$/;

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const only = (() => {
  const i = args.indexOf('--country');
  if (i === -1) return null;
  const list = args[i + 1];
  if (!list) throw new Error('--country needs a comma separated list, e.g. --country br,pt');
  return new Set(list.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
})();

const keyOf = name => String(name)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function validate(data) {
  const errors = [];
  const warnings = [];
  const fail = message => errors.push(message);
  const warn = message => warnings.push(message);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('root must be an object of category -> channel list');
    return { errors, warnings };
  }
  const categories = Object.keys(data);
  const seen = new Map();

  for (const category of categories) {
    const list = data[category];
    if (!Array.isArray(list)) {
      fail(`${category}: value must be an array`);
      continue;
    }
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
        warn(`${label}: retransmits with priority ${channel.priority} (build raises it to ${RETRANSMITS_MIN})`);
      }
      if (maxPriority && !retransmits && channel.priority !== undefined && channel.priority > maxPriority) {
        warn(`${label}: priority above the ${maxPriority} cap of ${category} (build clamps it)`);
      }
      if (typeof channel.keywords === 'string' && !ASCII.test(channel.keywords)) {
        warn(`${label}: keywords must be ASCII, no accents`);
      }

      const key = keyOf(channel.name);
      if (key) {
        if (seen.has(key)) {
          warn(`${label}: duplicated name, same as ${seen.get(key)}`);
        } else {
          seen.set(key, where);
        }
      }
    });
  }
  return { errors, warnings };
}

const files = (await readdir(DIR))
  .filter(file => file.endsWith('.json') && file !== 'countries.json')
  .sort()
  .filter(file => !only || only.has(file.replace(/\.json$/, '')));

let failed = 0;
let warned = 0;
const totals = {};
for (const file of files) {
  let data;
  try {
    data = JSON.parse(await readFile(path.join(DIR, file), 'utf8'));
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
  }
  if (warnings.length) {
    warned++;
    warnings.forEach(message => {
      const key = message.replace(/^.*?: /, '').replace(/[\d.,]+/g, '#').split(' (')[0];
      totals[key] = (totals[key] ?? 0) + 1;
    });
  }
}

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
