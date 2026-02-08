import { existsSync, statSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname$1 = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = new Map();
let dataDir = __dirname$1;

function loadJson(relativePath) {
  const fullPath = join(dataDir, relativePath);
  return JSON.parse(readFileSync(fullPath, 'utf8'));
}

function setSourceDir(dir) {
  const fullPath = join(__dirname$1, dir);
  if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
    dataDir = fullPath;
    cache.clear(); // Limpar cache para forçar recarregamento
    console.log(`Fonte de dados alterada para: ${dataDir}`);
  } else {
    throw new Error(`Diretório inválido: ${fullPath}`);
  }
}

function normalizeKeyword(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function deriveKeywords(name) {
  return normalizeKeyword(name).replace(/\s+/g, ' ');
}

const DEFAULT_PRIORITY = 5;

const CATEGORY_MAX_PRIORITY = {
  Entertainment: 10,
  Sports: 10,
  News: 9,
  Kids: 9,
  Music: 8,
  Lifestyle: 8,
  General: 8,
  Movies: 8,
  Series: 8,
  Documentary: 7,
  Educational: 7,
  Shop: 4,
  Business: 4,
  Religious: 4,
  Radio: 4,
  Other: 4
};

function normalizeChannel(ch, cat) {
  let priority = ch.priority !== undefined ? ch.priority : DEFAULT_PRIORITY;
  const maxPriority = CATEGORY_MAX_PRIORITY[cat] ?? DEFAULT_PRIORITY;
  if (priority > maxPriority) priority = maxPriority;
  // Channels with retransmits have minimum priority 8
  if (ch.retransmits != null && String(ch.retransmits).trim() !== '' && priority < 8) {
    priority = 8;
  }
  // Paid channels cannot have priority > 8
  const isFree = ch.isFree ?? true;
  if (!isFree && priority > 8) {
    priority = 8;
  }
  return {
    name: ch.name,
    keywords: ch.keywords !== undefined ? ch.keywords : deriveKeywords(ch.name),
    retransmits: ch.retransmits ?? null,
    shortName: ch.shortName !== undefined ? ch.shortName : ch.name,
    isFree,
    logo: ch.logo ?? null,
    website: ch.website ?? null,
    priority
  };
}

function sortByPriority(channels) {
  return [...channels].sort((a, b) => (b.priority ?? DEFAULT_PRIORITY) - (a.priority ?? DEFAULT_PRIORITY));
}

function weightedPriority(ch, countryIndex) {
  const base = ch.priority ?? DEFAULT_PRIORITY;
  const divisor = Math.max(1, countryIndex + 1);
  return base / divisor;
}

/** Filter by retransmits: 'all' | 'parents' (no retransmits) | 'affiliates' (has retransmits) */
function passesRetransmitsFilter(ch, mode) {
  if (!mode || mode === 'all') return true;
  const hasRetransmits = ch.retransmits != null && String(ch.retransmits).trim() !== '';
  if (mode === 'parents') return !hasRetransmits;
  if (mode === 'affiliates') return hasRetransmits;
  return true;
}

function normalizeChannels(data) {
  const out = {};
  for (const [cat, channels] of Object.entries(data)) {
    out[cat] = channels.map((ch) => normalizeChannel(ch, cat));
  }
  return out;
}

/**
 * Get channels (full schema with categories).
/**
 * Uses dynamic loading — loads only the requested country into memory (with cache).
 * @param {string} countryCode - ISO country code (e.g. 'br', 'us')
 * @param {object} [options={}] - Options
 * @param {boolean} [options.throwOnMissing=false] - If true, throw an error when the channel file is not found, instead of returning null
 * @returns {Promise<Record<string, object[]>|null>} Categories with channel objects, or null if not found
 */
async function getChannels(countryCode, options = {}) {
  if (!countryCode || typeof countryCode !== 'string') return null;
  const code = countryCode.toLowerCase().trim();
  const { throwOnMissing = false } = options;

  if (cache.has(code)) {
    return cache.get(code);
  }

  try {
    const raw = loadJson(`channels/${code}.json`);
    const data = normalizeChannels(raw);
    cache.set(code, data);
    return data;
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'MODULE_NOT_FOUND') {
      if (throwOnMissing) {
        const fullPath = join(__dirname$1, '..', `channels/${code}.json`);
        throw new Error(`Channel file not found: ${fullPath}`);
      }
      return null;
    }
    throw e;
  }
}

/**
 * List available country codes.
 * @returns {Promise<string[]>} Sorted list of country codes
 */
async function listCountries() {
  return loadJson('channels/countries.json');
}

/**
 * Search channels by keywords (matches name and keywords).
 * @param {string} keywords - Search term (case and accent insensitive)
 * @param {object} [opts]
 * @param {string[]|null} [opts.countries=null] - Country codes to search, null = all
 * @param {string[]|null} [opts.categories=null] - Category names to search, null = all
 * @param {'all'|'parents'|'affiliates'} [opts.retransmits='all'] - 'parents'=only originals, 'affiliates'=only retransmitters, 'all'=both
 * @param {number} [opts.limit=18] - Max results
 * @returns {Promise<Array<{country: string} & object>>} Matching channels with country
 */
async function search(keywords, opts = {}) {
  const { countries: countriesOpt = null, categories: categoriesOpt = null, retransmits: retransmitsOpt = 'all', limit = 18 } = opts;
  const countries = countriesOpt ?? (await listCountries());
  const needle = normalizeKeyword(keywords);
  const results = [];

  for (const code of countries) {
    if (results.length >= limit) break;
    const data = await getChannels(code);
    if (!data) continue;

    for (const [cat, channels] of Object.entries(data)) {
      if (categoriesOpt != null && !categoriesOpt.includes(cat)) continue;
      const matching = channels.filter((ch) => {
        if (!passesRetransmitsFilter(ch, retransmitsOpt)) return false;
        const haystack = normalizeKeyword((ch.keywords ?? '') + ' ' + (ch.name ?? ''));
        return haystack.includes(needle);
      });
      const sorted = sortByPriority(matching);
      for (const ch of sorted) {
        if (results.length >= limit) break;
        results.push({ ...ch, country: code });
      }
    }
  }
  return sortByPriority(results).slice(0, limit);
}

/**
 * Generate a list of channels from countries by priority, merging categories until each hits minPerCategory.
 * Then greedily fills remaining slots up to limit using weighted priority that favors earlier countries.
 * @param {object} opts
 * @param {string[]} opts.countries - Country codes in priority order
 * @param {string[]|null} [opts.categories=null] - Category names to include, null = all
 * @param {'all'|'parents'|'affiliates'} [opts.retransmits='all'] - 'parents'=only originals, 'affiliates'=only retransmitters, 'all'=both
 * @param {boolean} [opts.mainCountryFull=false] - When true, first country is the user's main: include ALL its channels, supplement only categories below minPerCategory from others
 * @param {number} [opts.limit=256] - Max total channels
 * @param {number} [opts.minPerCategory=18] - Min channels per category (stop adding when reached)
 * @param {boolean} [opts.throwOnMissingChannels=false] - If true, throw an error when a channel file for a country is not found, instead of skipping it
 * @returns {Promise<Array<{country: string, category: string} & object>>} Channels with country and category
 */
async function generate(opts = {}) {
  console.log('generate called', opts);
  const { countries = [], categories: categoriesOpt = null, retransmits: retransmitsOpt = 'all', mainCountryFull = false, limit = 256, minPerCategory = 18, freeOnly = false, throwOnMissingChannels = false } = opts;
  const byCategory = {};
  const remainingCandidates = [];
  const seen = new Set();
  let total = 0;

  const countriesToProcess = [...countries];
  const countryIndex = new Map(countriesToProcess.map((code, index) => [code, index]));
  const mainCountry = mainCountryFull && countriesToProcess.length > 0 ? countriesToProcess[0] : null;
  const others = mainCountryFull && countriesToProcess.length > 1 ? countriesToProcess.slice(1) : countriesToProcess;

  function keyFor(ch, country, category) {
    return `${country}::${category}::${ch.name}`;
  }

  function addChannel(ch, country, category) {
    const key = keyFor(ch, country, category);
    if (seen.has(key)) return false;
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push({ ...ch, country, category });
    seen.add(key);
    total += 1;
    return true;
  }

  function addRemainingCandidate(ch, country, category) {
    const key = keyFor(ch, country, category);
    if (seen.has(key)) return;
    const index = countryIndex.get(country) ?? countriesToProcess.length;
    remainingCandidates.push({ ch, country, category, score: weightedPriority(ch, index) });
  }

  // When mainCountryFull: add ALL channels from main country first
  if (mainCountry) {
    const data = await getChannels(mainCountry, { throwOnMissing: throwOnMissingChannels });
    if (data) {
      for (const cat of Object.keys(data).sort((a, b) => (CATEGORY_MAX_PRIORITY[b] ?? DEFAULT_PRIORITY) - (CATEGORY_MAX_PRIORITY[a] ?? DEFAULT_PRIORITY))) {
        const channels = data[cat];
        if (categoriesOpt != null && !categoriesOpt.includes(cat)) continue;
        let filtered = channels.filter((ch) => passesRetransmitsFilter(ch, retransmitsOpt));
        if (freeOnly) filtered = filtered.filter((ch) => ch.isFree === true);
        const list = sortByPriority(filtered);
        for (const ch of list) {
          addChannel(ch, mainCountry, cat);
        }
      }
    }
  }

  // Then supplement from others (or from all if not mainCountryFull)
  let limitReached = false;
  for (const code of others) {
    if (total >= limit) break;
    const data = await getChannels(code, { throwOnMissing: throwOnMissingChannels });
    if (!data) continue;

    for (const cat of Object.keys(data).sort((a, b) => (CATEGORY_MAX_PRIORITY[b] ?? DEFAULT_PRIORITY) - (CATEGORY_MAX_PRIORITY[a] ?? DEFAULT_PRIORITY))) {
      const channels = data[cat];
      if (categoriesOpt != null && !categoriesOpt.includes(cat)) continue;
      if (total >= limit) break;
      const current = byCategory[cat] ?? [];

      let filtered = channels.filter((ch) => passesRetransmitsFilter(ch, retransmitsOpt));
      if (freeOnly) filtered = filtered.filter((ch) => ch.isFree === true);
      const needed = Math.max(0, minPerCategory - current.length);
      const remaining = limit - total;
      const take = Math.min(needed, remaining, filtered.length);
      const sorted = sortByPriority(filtered);

      for (let i = 0; i < sorted.length; i++) {
        const ch = sorted[i];
        if (!ch) continue;
        if (i < take) {
          addChannel(ch, code, cat);
          if (total >= limit) {
            limitReached = true;
            break;
          }
        } else {
          addRemainingCandidate(ch, code, cat);
        }
      }
      byCategory[cat] = byCategory[cat] ?? current;
      if (limitReached) break;
    }
    if (limitReached) break;
  }

  if (total < limit && remainingCandidates.length > 0) {
    remainingCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aPriority = a.ch.priority ?? DEFAULT_PRIORITY;
      const bPriority = b.ch.priority ?? DEFAULT_PRIORITY;
      if (bPriority !== aPriority) return bPriority - aPriority;
      const aIndex = countryIndex.get(a.country) ?? countriesToProcess.length;
      const bIndex = countryIndex.get(b.country) ?? countriesToProcess.length;
      return aIndex - bIndex;
    });

    for (const item of remainingCandidates) {
      if (total >= limit) break;
      addChannel(item.ch, item.country, item.category);
    }
  }

  const out = [];
  for (const channels of Object.values(byCategory)) {
    out.push(...channels);
  }
  return sortByPriority(out).slice(0, limit);
}

export { generate, getChannels, listCountries, search, setSourceDir };
