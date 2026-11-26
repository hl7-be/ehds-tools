/** The comparison as Markdown (terminal, GitHub). The site renders the same data from comparison.json. */

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

function sourceLine(source) {
  if (!source) return '';
  const commit = source.commit ? ` (${source.commit.sha.slice(0, 7)})` : '';
  const pkg = source.package ? `, ${source.package.id}#${source.package.version}` : '';
  return `EHDS models: ${source.url} @ ${source.ref}${commit}${pkg}, fetched ${String(source.fetchedAt ?? '').slice(0, 10)}`;
}

export function toMarkdown(report, { kind = 'logical' } = {}) {
  const s = kind === 'profile' ? report.profiles : report.summary;
  const models = report.models.filter((m) => m.kind === kind);
  const what = kind === 'profile' ? 'profiles' : 'models';
  const out = [`# EHDS ${what} compared with the Belgian ${what}`, ''];
  const src = sourceLine(report.source);
  if (src) out.push(src, '');
  out.push(`${s.mapped} of ${s.models} ${what} have a mapping (${s.conceptMaps} ConceptMaps); ${s.withRemarks} have remarks (${s.remarks} in total); ${s.outdated} made against an older model.`, '');
  if (!models.length) return out.join('\n') + '\n';

  out.push(`| EHDS ${kind === 'profile' ? 'profile' : 'model'} | Belgian | Mapped | No equivalent | Open | Remarks | Model changed |`, '|---|---|---|---|---|---|---|');
  for (const m of models) {
    if (!m.mapped) {
      out.push(`| ${m.id} | – | | | ${m.elementCount} | | |`);
      continue;
    }
    for (const g of m.mappings) {
      const c = g.counts;
      const changed = g.changes.map((x) => `${x.side === 'ehds' ? 'EHDS' : 'BE'} ${x.what === 'date' ? `changed ${String(x.now).slice(0, 10)}, after the mapping (${String(x.mapped).slice(0, 10)})` : `${x.mapped} → ${x.now}`}`).join('; ');
      out.push(`| ${m.id} | ${g.targetName}${g.targetFound ? '' : ' (not fetched)'} | ${c.mapped} (${pct(c.mapped, m.elementCount)}) | ${c.noMap} | ${c.open} | ${g.remarks.length || ''} | ${changed} |`);
    }
  }

  const withRemarks = models.filter((m) => m.remarkCount > 0);
  if (withRemarks.length) {
    out.push('', '## Remarks');
    for (const m of withRemarks) {
      for (const g of m.mappings.filter((g) => g.remarks.length)) {
        out.push('', `### ${m.id} → ${g.targetName}`, '', `\`${g.file}\``, '', '| EHDS element | Belgian element | Relationship | Remark |', '|---|---|---|---|');
        for (const r of g.remarks) out.push(`| ${r.element} | ${r.target ?? '–'} | ${r.relationship ?? ''} | ${cell(r.remark)} |`);
      }
    }
  }

  const problems = problemLines(report, models);
  if (problems.length) out.push('', '## Problems', '', ...problems.map((p) => `- ${p}`));
  return out.join('\n') + '\n';
}

export function problemLines(report, models = report.models) {
  const lines = [];
  for (const m of models)
    for (const g of m.mappings) {
      if (g.unknownElements.length) lines.push(`${g.file}: elements not in ${m.id}: ${g.unknownElements.join(', ')}`);
      if (!g.targetFound) lines.push(`${g.file}: Belgian model ${g.target} was not fetched`);
      if (g.unknownTargets.length) lines.push(`${g.file}: elements not in ${g.targetName}: ${g.unknownTargets.join(', ')}`);
    }
  for (const u of report.unknownSources) lines.push(`${u.file}: source ${u.source} is not one of the fetched EHDS models`);
  return lines;
}
