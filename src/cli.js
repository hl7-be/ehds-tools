#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runCompare } from './compare.js';
import { loadConfig } from './config.js';
import { fetchAll, readCatalog, readModel } from './fetch.js';
import { modelElements } from './catalog.js';
import { runMaps, scaffoldCsv } from './csv-mappings.js';
import { runProgress } from './progress.js';
import { renderAll } from './render.js';
import { toMarkdown } from './report.js';
import { buildSite, openBrowser, serveSite } from './site.js';

const USAGE = `Usage: ehds-tools <command> [options]

Commands:
  fetch [--only ehds|be]    Fetch the EHDS models (configured repository) and the Belgian models
  render                    Write the PlantUML of every model (modelgram and UML) and render SVGs
  new-mapping <EHDS id> --target <Belgian id>
                            Start a mapping: mappings/<EHDS>--<BE>.csv with every EHDS element
                            listed (open), and its ConceptMap with both model versions
  maps [--check] [--remap <file>] [csv files]
                            Generate mappings/generated/ConceptMap-*.json from the CSVs;
                            --check only reports (fails when out of date or a CSV is wrong);
                            --remap moves a mapping to the current model versions
  compare [--format md|json] [--profiles]
                            Which models have mappings, coverage, remarks, model changes (stdout)
  progress                  Mapping progress over time, from the git history of mappings/ (JSON)
  compositions              Where each EHDS model is placed (compositions.json): focus, section,
                            supporting, component
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
      check: { type: 'boolean' },
      remap: { type: 'string', multiple: true },
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
      if (!model || !values.target) throw new Error('usage: ehds-tools new-mapping <EHDS model id> --target <Belgian model id>');
      const catalog = await readCatalog(config.output);
      const source = catalog.models.find((m) => m.side === 'ehds' && m.preferred && (m.id === model || m.name === model));
      if (!source) throw new Error(`EHDS model ${model} not found - check the id or run "ehds-tools fetch"`);
      const target = catalog.models.find((m) => m.side === 'be' && m.preferred && [m.id, m.name, m.url].includes(values.target));
      if (!target) throw new Error(`Belgian model ${values.target} not found - give its name or id, or run "ehds-tools fetch"`);
      const name = `${source.name}--${target.name}.csv`;
      const file = path.join(config.mappings.dir, name);
      await mkdir(config.mappings.dir, { recursive: true });
      const sd = await readModel(config.output, source);
      await writeFile(file, scaffoldCsv(sd), { flag: 'wx' }).catch((err) => {
        throw err.code === 'EEXIST' ? new Error(`${file} already exists`) : err;
      });
      const { errors } = await runMaps({ dir: config.mappings.dir, canonical: config.mappings.canonical, models: catalog.models, only: [name], log: () => {} });
      if (errors.length) throw new Error(errors.join('\n'));
      console.log(`${file}: ${modelElements(sd).length} elements to map (EHDS ${source.version ?? '?'}, BE ${target.version ?? '?'})`);
      console.log(`fill in relationship, targetCode and comment, then run "ehds-tools maps"`);
      return 0;
    }

    case 'maps': {
      let catalog = null;
      try {
        catalog = await readCatalog(config.output);
      } catch {
        console.error('no fetched models: element codes are not checked');
      }
      const sets = new Map();
      const elementsOf = catalog
        ? async (entry) => {
            if (!sets.has(entry.key)) sets.set(entry.key, new Set(modelElements(await readModel(config.output, entry)).flatMap((e) => [e.id, e.path])));
            return sets.get(entry.key);
          }
        : null;
      const { results, errors, warnings } = await runMaps({
        dir: config.mappings.dir,
        canonical: config.mappings.canonical,
        models: catalog?.models ?? [],
        elementsOf,
        check: values.check,
        remap: values.remap ?? [],
        only: args.length ? args.map((a) => path.basename(a)) : null,
      });
      for (const w of warnings) console.error(`warning: ${w}`);
      for (const e of errors) console.error(`error: ${e}`);
      const csvs = results.filter((r) => r.csv);
      console.log(`${csvs.length} mapping CSV${csvs.length === 1 ? '' : 's'}: ${['new', 'updated', 'remapped', 'ok', 'error'].map((k) => [k, csvs.filter((r) => r.status === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`);
      return errors.length ? 1 : 0;
    }

    case 'compare': {
      const report = await runCompare(config);
      if (values.format === 'json') process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else if (values.format === 'md') process.stdout.write(toMarkdown(report, { kind: values.profiles ? 'profile' : 'logical' }));
      else throw new Error('--format must be md or json');
      return 0;
    }

    case 'compositions': {
      const report = await runCompare(config);
      const pad = (t, n) => String(t).padEnd(n);
      for (const c of report.compositions) {
        console.log(`${c.title} (${c.id})`);
        for (const m of c.members) console.log(`  ${pad(m.role, 8)} ${pad(m.name, 32)} ${m.section ?? ''}`);
      }
      for (const tier of ['supporting', 'component']) {
        const names = report.models.filter((m) => m.kind === 'logical' && m.place?.tier === tier).map((m) => m.id);
        console.log(`${tier} (${names.length}): ${names.join(', ')}`);
      }
      const tagged = report.models.filter((m) => m.place?.tags.length);
      if (tagged.length) console.log(`tags: ${tagged.map((m) => `${m.id} ${m.place.tags.map((t) => `#${t}`).join(' ')}`).join(', ')}`);
      if (report.unknownPlacements.length) console.log(`not among the models: ${report.unknownPlacements.join(', ')}`);
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
