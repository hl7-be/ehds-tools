import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = 'ehds-tools.config.json';

const DEFAULTS = {
  // The EHDS side: a GitHub repository holding an IG with the logical models (and later profiles).
  ehds: {
    url: 'https://github.com/EEHRxF/logical-model/',
    ref: null, // null = the repository's default branch
    mode: 'auto', // auto | published | source
    packageUrl: null, // explicit package.tgz, skips URL discovery
    kinds: ['logical', 'profile'],
  },
  // The Belgian side: the same source list as the CareSets tool (caresets.json).
  belgian: {
    kinds: ['logical', 'profile'],
    sources: [],
  },
  output: 'data', // fetched models and rendered diagrams
  site: 'site', // static site for GitHub Pages / local preview
  compositions: 'compositions.json', // which models matter: compositions, sections, components, tags
  mappings: {
    dir: 'mappings', // ConceptMaps from the EHDS models to the Belgian models
    canonical: 'https://www.ehealth.fgov.be/standards/fhir/ehds/ConceptMap', // base for new ConceptMap urls
  },
};

export const MODES = ['auto', 'published', 'source'];
export const KINDS = ['logical', 'profile'];

/**
 * Load the configuration. Precedence (highest first):
 * command-line options, environment variables (EHDS_SOURCE_URL, EHDS_SOURCE_REF,
 * EHDS_SOURCE_MODE, EHDS_PACKAGE_URL, EHDS_OUTPUT, EHDS_MAPPINGS), the config file, defaults.
 */
export async function loadConfig({ configFile, overrides = {}, env = process.env } = {}) {
  const file = configFile ?? DEFAULT_CONFIG_FILE;
  let fromFile = {};
  try {
    fromFile = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT' || configFile) {
      throw new Error(`Cannot read config file ${file}: ${err.message}`);
    }
  }

  const fromEnv = {
    ehds: {
      url: env.EHDS_SOURCE_URL,
      ref: env.EHDS_SOURCE_REF,
      mode: env.EHDS_SOURCE_MODE,
      packageUrl: env.EHDS_PACKAGE_URL,
    },
    output: env.EHDS_OUTPUT,
    mappings: { dir: env.EHDS_MAPPINGS },
  };

  const config = {
    ehds: { ...DEFAULTS.ehds, ...defined(fromFile.ehds), ...defined(fromEnv.ehds), ...defined(overrides.ehds) },
    belgian: { ...DEFAULTS.belgian, ...defined(fromFile.belgian) },
    output: overrides.output ?? fromEnv.output ?? fromFile.output ?? DEFAULTS.output,
    site: overrides.site ?? fromFile.site ?? DEFAULTS.site,
    compositions: overrides.compositions ?? fromFile.compositions ?? DEFAULTS.compositions,
    mappings: {
      ...DEFAULTS.mappings,
      ...defined(fromFile.mappings),
      ...defined(fromEnv.mappings),
      ...defined(overrides.mappings),
    },
  };

  if (!MODES.includes(config.ehds.mode)) {
    throw new Error(`ehds.mode must be one of ${MODES.join(', ')} (got "${config.ehds.mode}")`);
  }
  for (const side of ['ehds', 'belgian']) {
    const bad = config[side].kinds.filter((k) => !KINDS.includes(k));
    if (bad.length) throw new Error(`${side}.kinds: unknown ${bad.join(', ')} (use ${KINDS.join(', ')})`);
  }
  config.output = path.resolve(config.output);
  config.site = path.resolve(config.site);
  config.compositions = path.resolve(config.compositions);
  config.mappings.dir = path.resolve(config.mappings.dir);
  return config;
}

function defined(obj = {}) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined && v !== ''));
}
