#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runCompare } from './compare.js';
import { loadConfig } from './config.js';
import { fetchAll, readCatalog, readModel } from './fetch.js';
import { scaffoldConceptMap } from './mappings.js';
import { runProgress } from './progress.js';
import { renderAll } from './render.js';
import { toMarkdown } from './report.js';
import { buildSite, openBrowser, serveSite } from './site.js';

const USAGE = `Usage: ehds-tools <command> [options]

Commands:
  fetch [--only ehds|be]    Fetch the EHDS models (configured repository) and the Belgian models
  render                    Write the PlantUML of every model (modelgram and UML) and render SVGs
  new-mapping <EHDS id> --target <Belgian id or url>
                            Create a ConceptMap with every EHDS element listed, nothing mapped,
                            and the versions of both models recorded
  compare [--format md|json] [--profiles]
                            Which models have mappings, coverage, remarks, model changes (stdout)
  progress                  Mapping progress over time, from the git history of mappings/ (JSON)
  site [--fetch]            Build the static site (as published on GitHub Pages)
  serve [--port <n>] [--open] [--fetch]
                            Build the site and preview it on http://localhost

Options:
  -c, --config <file>   Config file (default: ehds-tools.config.json)
      --url <url>       GitHub repository of the EHDS models (overrides ehds.url)
      --ref <ref>       Branch, tag or commit (overrides ehds.ref)
      --mode <mode>     auto | published | source (overrides ehds.mode)
      --package <url>   Use this package.tgz for the EHDS models (overrides ehds.packageUrl)
  -o, --output <dir>    Fetched data directory (overrides output)
      --mappings <dir>  ConceptMaps directory (overrides mappings.dir)
      --site <dir>      Site directory (overrides site)
  -h, --help            Show this help
`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      url: { type: 'string' },
      ref: { type: 'string' },
      mode: { type: 'string' },
      package: { type: 'string' },
      output: { type: 'string', short: 'o' },
      mappings: { type: 'string' },
      site: { type: 'string' },
      only: { type: 'string' },
      target: { type: 'string' },
      format: { type: 'string', default: 'md' },
      profiles: { type: 'boolean' },
      fetch: { type: 'boolean' },
      port: { type: 'string', default: '8080' },
      open: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 1;
  }

  const config = await loadConfig({
    configFile: values.config,
    overrides: {
      ehds: { url: values.url, ref: values.ref, mode: values.mode, packageUrl: values.package },
      output: values.output,
      site: values.site,
      mappings: { dir: values.mappings },
    },
  });

  switch (command) {
    case 'fetch': {
      if (values.only && !['ehds', 'be'].includes(values.only)) throw new Error('--only must be ehds or be');
      await fetchAll(config, { only: values.only ?? null });
      return 0;
    }

    case 'render':
      await renderAll(config);
      return 0;

    case 'new-mapping': {
      const [model] = args;
      if (!model || !values.target) throw new Error('usage: ehds-tools new-mapping <EHDS model id> --target <Belgian model id or canonical url>');
      const catalog = await readCatalog(config.output);
      const source = catalog.models.find((m) => m.side === 'ehds' && m.preferred && (m.id === model || m.name === model));
      if (!source) throw new Error(`EHDS model ${model} not found - check the id or run "ehds-tools fetch"`);
      const target = catalog.models.find((m) => m.side === 'be' && m.preferred && [m.id, m.name, m.url].includes(values.target));
      if (!target && !/^https?:\/\//.test(values.target)) throw new Error(`Belgian model ${values.target} not found - give its id or canonical url`);
      if (!target) console.error(`warning: ${values.target} is not a fetched Belgian model; its version is not recorded`);
      const cm = scaffoldConceptMap({
        source: { sd: await readModel(config.output, source), entry: source },
        target: target ? { entry: target } : { url: values.target },
        canonical: config.mappings.canonical,
      });
      const file = path.join(config.mappings.dir, `ConceptMap-${cm.id}.json`);
      await mkdir(config.mappings.dir, { recursive: true });
      await writeFile(file, JSON.stringify(cm, null, 2) + '\n', { flag: 'wx' }).catch((err) => {
        throw err.code === 'EEXIST' ? new Error(`${file} already exists`) : err;
      });
      console.log(`${file}: ${cm.group[0].element.length} elements to map (EHDS ${cm.sourceScopeCanonical}, BE ${cm.targetScopeCanonical})`);
      return 0;
    }

    case 'compare': {
      const report = await runCompare(config);
      if (values.format === 'json') process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else if (values.format === 'md') process.stdout.write(toMarkdown(report, { kind: values.profiles ? 'profile' : 'logical' }));
      else throw new Error('--format must be md or json');
      return 0;
    }

    case 'progress':
      process.stdout.write(JSON.stringify(await runProgress(config), null, 2) + '\n');
      return 0;

    case 'site':
    case 'serve': {
      if (values.fetch) await fetchAll(config);
      await buildSite(config);
      if (command === 'site') return 0;
      const server = await serveSite(config.site, { port: Number(values.port) });
      if (values.open) openBrowser(`http://localhost:${server.address().port}/`);
      return new Promise(() => {}); // until Ctrl+C
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      process.stdout.write(USAGE);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  },
);
