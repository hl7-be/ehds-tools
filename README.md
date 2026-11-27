# ehds-tools

The EHDS logical models and profiles next to the Belgian ones: a site with the layout of the
CareSets tool, showing every model as a tree, a PlantUML (modelgram) diagram and a UML class
diagram, the mappings to the Belgian models with their remarks, and mapping progress over time.
It is built as a static site, published on GitHub Pages and previewed locally.

| Tab | What it shows |
|---|---|
| **Models** | EHDS and Belgian models and profiles, as a table or gallery, grouped by composition (the models that matter first), package, side or status, filtered by role. Each model opens with a **tree view**, the **PlantUML (modelgram)** diagram, the **UML class diagram**, the **PlantUML source** of both, and the **JSON**, plus its mappings. |
| **Mappings** | Per EHDS model: the Belgian model it is mapped to, how much is mapped, has no equivalent or is open, the remarks, and whether either model changed since the mapping. Each mapping opens with both diagrams side by side and every line. |
| **Progress** | Elements decided over time (from the git history of `mappings/`), for all models, the focus and section models, or one composition, with the events where a mapping started or moved to another model version. |
| **Profiles** | The same comparison for profiles, once the EHDS repository publishes them. |

## Running it

```sh
npm install        # also downloads vendor/plantuml.jar
npm run fetch      # EHDS and Belgian models -> data/
npm start          # builds site/ and opens http://localhost:8080 in Firefox
```

Requirements: Node 20+, Java 17+ for the diagrams (without it they are rendered on plantuml.com),
SUSHI (`npm i -g fsh-sushi`) only when the EHDS models are built from source.

| Command | Does |
|---|---|
| `node src/cli.js fetch [--only ehds\|be]` | Fetch both sides (or one) into `data/` |
| `node src/cli.js render` | Write the PlantUML of every model and render the SVGs (cached in `.cache/diagrams`) |
| `node src/cli.js new-mapping <EHDS id> --target <Belgian id or url>` | Start a ConceptMap |
| `node src/cli.js compare [--format md\|json] [--profiles]` | The comparison, in the terminal |
| `node src/cli.js progress` | Progress over time, as JSON |
| `node src/cli.js compositions` | Where each EHDS model is placed: focus, section, supporting, component |
| `node src/cli.js site [--fetch]` | Build `site/` (renders, compares, progress) |
| `node src/cli.js serve [--open] [--fetch] [--port n]` | Build and preview on localhost |

## Configuration

[ehds-tools.config.json](ehds-tools.config.json):

| Setting | Meaning | Env variable | Option |
|---|---|---|---|
| `ehds.url` | GitHub repository of the EHDS models (a `/tree/<ref>` URL also works) | `EHDS_SOURCE_URL` | `--url` |
| `ehds.ref` | branch, tag or commit; `null` = default branch | `EHDS_SOURCE_REF` | `--ref` |
| `ehds.mode` | `auto`, `published` or `source` (below) | `EHDS_SOURCE_MODE` | `--mode` |
| `ehds.packageUrl` | use this `package.tgz` instead of looking for one | `EHDS_PACKAGE_URL` | `--package` |
| `ehds.kinds`, `belgian.kinds` | `logical`, `profile` | | |
| `belgian.sources` | the Belgian packages - the same list as the CareSets tool's `caresets.json` | | |
| `output` | fetched data | `EHDS_OUTPUT` | `-o` |
| `site` | built site | | `--site` |
| `mappings.dir` | the ConceptMaps | `EHDS_MAPPINGS` | `--mappings` |
| `mappings.canonical` | base url of new ConceptMaps | | |
| `compositions` | the compositions file (below), default `compositions.json` | | |

Options override environment variables, which override the file.

EHDS modes: **published** reads the IG's built package (`build.fhir.org/ig/<owner>/<repo>/package.tgz`,
or `/branches/<ref>/`, then GitHub Pages); **source** builds the commit with SUSHI (for branches that
are not built, or when the build is behind - the fetch warns when the package is older than the
latest commit); **auto** (default) tries published, then source.

Belgian sources, as in `caresets.json`: `release` (`packageId`, `version` "latest" or a specific
one), `ci` (`from` = a build.fhir.org address, or `repo` + `branch`), `url` (one
StructureDefinition). Optional: `package` (grouping label), `names` (only these). When the same
model comes from two sources, the first one listed prevails; the other is shown as a variant.

## Compositions

Not every EHDS model matters on its own: `EHDSHumanName` is a building block, the Patient Summary
is what is exchanged. [compositions.json](compositions.json) gives every EHDS model a role:

| Role | Which models |
|---|---|
| **Focus** | the `focus` models of a composition, e.g. `EHDSPatientSummary`, `EHDSMedicationPrescription`, `EHDSMedicationDispense` |
| **Section** | the first-level sections of a focus model: `"sections": "auto"` reads its `Section: ...` elements and the models in them (Alerts → `EHDSAlert`, Medical problems → `EHDSCondition`, ...); or list them, `["EHDSX", { "title": "...", "models": [...] }]` |
| **Component** | listed in `components`: building blocks such as `EHDSHumanName`, `EHDSAddress` - hidden on the Models tab by default |
| **Supporting** | every other EHDS model |

`tags` adds free tags per model (EHDS or Belgian name), shown as `#tag` and searchable on the
Models tab. A Belgian model takes the role of the EHDS model mapped to it. The roles sort and
group the Models and Mappings tabs, and the Progress tab charts each composition on its own.
`node src/cli.js compositions` shows the result, and names configured models that do not exist.

## Mappings

FHIR ConceptMaps (JSON) in [mappings/](mappings/), one per EHDS model and Belgian model:

| In the ConceptMap | Means |
|---|---|
| `sourceScopeCanonical` / `targetScopeCanonical` | the models **and the versions** it was made against (`url\|version`) |
| `date` | when the mapping was last changed |
| `group.element.code` | an EHDS element id, e.g. `EHDSPatient.name` |
| `target` with a `code` and a `relationship` | mapped |
| `target` without `code`, `relationship: not-related-to` (or `noMap: true`) | no Belgian equivalent |
| no `target` | still to be mapped |
| `target.comment` | the remark on that line |

```sh
node src/cli.js new-mapping EHDSCondition --target BeModelProblem
```

writes `mappings/ConceptMap-EHDSCondition-to-BeModelProblem.json` with every EHDS element listed,
both model versions and today's date. Update `date` when you change a mapping (and the versions
when you remap against a newer model).

**Model changed**: a mapping is flagged when a model's version differs from the one recorded, or
the model was published after the ConceptMap's `date`. **Problems** lists mapped elements that do
not exist (any more) on either side, Belgian models that were not fetched, and ConceptMaps whose
source is not an EHDS model.

## Progress

Every commit that changes `mappings/` is one point (its commit date), plus uncommitted changes.
Each point is compared with today's models; the chart shows elements mapped, with no equivalent
and open, out of all EHDS logical models or only the mapped ones. When a ConceptMap starts, or its
recorded model versions change, that is an event on the chart. So commit mapping work as you go.

## Profiles

Fetched with the models on both sides (`kinds`). Map an EHDS profile to a Belgian one with a
ConceptMap exactly like a model (element ids of the profiles); they show on the Profiles tab.

## On GitHub

[.github/workflows/models.yml](.github/workflows/models.yml) fetches, renders, compares and
publishes the site on GitHub Pages - daily, on push to `main`, or on demand with a ref and mode.
Enable Pages with source "GitHub Actions" in the repository settings.

## Layout

```
src/
  cli.js              commands
  config.js           configuration
  github.js           GitHub repository -> published package URLs, commit
  ehds-source.js      EHDS side: published package or SUSHI build
  belgian-source.js   Belgian side: release / ci / url (as caresets.json)
  catalog.js          catalog entries: kind, stage, variants
  fetch.js            both sides -> data/catalog.json + StructureDefinitions
  diagrams/
    modelgram.js      StructureDefinition -> PlantUML, modelgram style (from CareSets)
    uml.js            StructureDefinition -> PlantUML UML class diagram
    plantuml.js       PlantUML -> SVG (local jar, batched; plantuml.com fallback)
  render.js           diagrams for every model, cached
  mappings.js         ConceptMaps: read, scaffold
  compare.js          mappings vs models, both sides
  progress.js         progress from git history
  compositions.js     roles of the models: focus, section, supporting, component; tags
  report.js           Markdown report
  site.js             site build, local server
public/               the site (CareSets stylesheet + ehds.css, app.js)
scripts/fetch-plantuml.js
```

## Tests

```sh
npm test
```
