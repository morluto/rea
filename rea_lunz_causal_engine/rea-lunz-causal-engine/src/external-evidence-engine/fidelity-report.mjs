import { sha256 } from './security.mjs';

const ORIGIN_SCORES = Object.freeze({
  original_source: 0.98,
  runtime_observation: 0.94,
  static_analysis: 0.78,
  decompiled: 0.64,
  pseudocode: 0.55,
  generated: 0.34,
  metadata: 0.27,
  stub: 0.16,
  unknown: 0.08
});

const COMPLETENESS_SCORES = Object.freeze({ complete: 1, partial: 0.64, summary: 0.35, not_visible: 0.02 });

const SIGNALS = Object.freeze([
  ['placeholder', /\b(?:TODO|FIXME|placeholder|stub|mock implementation|not implemented)\b/i, 0.24],
  ['unresolved_behavior', /\b(?:unknown|unresolved|not observed|not available|unavailable|unsupported|could not inspect)\b/i, 0.12],
  ['truncated_or_omitted', /(?:\.\.\.|truncated|omitted|elided|partial decompilation|incomplete dump)/i, 0.18],
  ['simulation_or_assumption', /\b(?:simulated|simulation|assumed|approximation|inferred behavior|synthetic result)\b/i, 0.22],
  ['dynamic_dispatch_gap', /\b(?:dynamic dispatch|reflection|indirect call|runtime target|unresolved import|missing source map)\b/i, 0.12]
]);

const ISSUE_PENALTIES = Object.freeze({
  source_diff: 0.3,
  behavior_mismatch: 0.35,
  missing_dependency: 0.2,
  unresolved_dynamic_dispatch: 0.14,
  test_failure: 0.22,
  truncated_decompilation: 0.2,
  no_source_map: 0.1,
  unsupported_construct: 0.18
});

const clamp = value => Math.min(1, Math.max(0, value));

export const generateCodeFidelityReport = input => {
  const observations = Array.isArray(input?.observations) ? input.observations : [];
  const parts = observations.map((observation, index) => {
    const origin = ORIGIN_SCORES[observation.origin] === undefined ? 'unknown' : observation.origin;
    const completeness = COMPLETENESS_SCORES[observation.completeness] === undefined ? 'not_visible' : observation.completeness;
    const text = `${observation.content_excerpt ?? ''}\n${(observation.limitations ?? []).join(' ')}\n${(observation.issues ?? []).join(' ')}`;
    const detectedSignals = SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
    const issues = [...new Set((Array.isArray(observation.issues) ? observation.issues : []).filter(issue => Object.hasOwn(ISSUE_PENALTIES, issue)))];
    const originScore = ORIGIN_SCORES[origin];
    const completenessScore = COMPLETENESS_SCORES[completeness];
    const issuePenalty = issues.reduce((sum, issue) => sum + ISSUE_PENALTIES[issue], 0);
    const signalPenalty = Math.min(0.52, detectedSignals.length * 0.09);
    const simulationPenalty = observation.attempted_simulation === true ? 0.16 : 0;
    const fidelityScore = clamp(originScore * completenessScore - issuePenalty - signalPenalty - simulationPenalty);
    const simulates = observation.attempted_simulation === true || ['decompiled', 'generated', 'pseudocode', 'stub'].includes(origin) || detectedSignals.includes('simulation_or_assumption');
    const cannotSee = observation.source_visible === false || completeness === 'not_visible' || origin === 'metadata' || origin === 'unknown' || (simulates && observation.source_visible !== true) || /\b(?:not observed|not visible|unavailable|not available|could not inspect)\b/i.test(text);
    const likelyUnfaithful = fidelityScore < 0.45 || issues.some(issue => ['source_diff', 'behavior_mismatch', 'test_failure'].includes(issue));
    const state = cannotSee ? 'not_observable' : simulates ? 'simulated_or_inferred' : fidelityScore >= 0.82 ? 'high_fidelity_evidence' : fidelityScore >= 0.58 ? 'partially_faithful' : 'low_fidelity_or_unverified';
    const reasons = [];
    if (cannotSee) reasons.push('The required implementation or behavior is not directly observable in the supplied evidence.');
    if (simulates) reasons.push('Part of this area is represented by inference, generated code, pseudocode, a stub, or an explicit simulation flag.');
    if (detectedSignals.length) reasons.push(`Detected evidence limitations: ${detectedSignals.join(', ')}.`);
    if (issues.length) reasons.push(`Reported fidelity issues: ${issues.join(', ')}.`);
    if (!reasons.length) reasons.push('No fidelity warning was detected in the supplied metadata; this is not a proof of equivalence.');
    return {
      id: String(observation.id ?? `part_${index + 1}`),
      path: String(observation.path ?? 'unknown'),
      origin,
      completeness,
      original_source_visible: observation.source_visible === true,
      state,
      fidelity_score: Number(fidelityScore.toFixed(4)),
      cannot_see_but_may_simulate: cannotSee && simulates,
      attempted_simulation: simulates,
      likely_not_faithful_to_original: likelyUnfaithful,
      detected_signals: detectedSignals,
      issues,
      limitations: Array.isArray(observation.limitations) ? observation.limitations.slice(0, 30) : [],
      reasons,
      source_evidence_ids: Array.isArray(observation.source_evidence_ids) ? observation.source_evidence_ids.filter(value => typeof value === 'string').slice(0, 30) : []
    };
  });
  const weightTotal = parts.reduce((sum, part) => sum + (part.completeness === 'not_visible' ? 1.35 : 1), 0);
  const fidelityScore = weightTotal ? parts.reduce((sum, part) => sum + part.fidelity_score * (part.completeness === 'not_visible' ? 1.35 : 1), 0) / weightTotal : 0;
  const unseenCount = parts.filter(part => part.state === 'not_observable').length;
  const simulatedCount = parts.filter(part => part.attempted_simulation).length;
  const unfaithfulCount = parts.filter(part => part.likely_not_faithful_to_original).length;
  const completeOriginalCount = parts.filter(part => part.origin === 'original_source' && part.completeness === 'complete').length;
  const report = {
    schema_version: 'rea-lunz.code-fidelity-report.v1',
    report_id: `fidelity_${sha256(JSON.stringify({ target: input?.target ?? 'unknown', ids: parts.map(part => part.id), scores: parts.map(part => part.fidelity_score) })).slice(0, 20)}`,
    generated_at: new Date().toISOString(),
    target: String(input?.target ?? 'unknown'),
    overall_fidelity_score: Number(fidelityScore.toFixed(4)),
    grade: fidelityScore >= 0.85 ? 'A' : fidelityScore >= 0.72 ? 'B' : fidelityScore >= 0.58 ? 'C' : fidelityScore >= 0.4 ? 'D' : 'E',
    part_count: parts.length,
    not_observable_count: unseenCount,
    simulated_or_inferred_count: simulatedCount,
    likely_unfaithful_count: unfaithfulCount,
    complete_original_source_count: completeOriginalCount,
    visibility_coverage: parts.length ? Number(((parts.length - unseenCount) / parts.length).toFixed(4)) : 0,
    simulated_parts: parts.filter(part => part.attempted_simulation || part.cannot_see_but_may_simulate).map(part => ({ id: part.id, path: part.path, state: part.state, fidelity_score: part.fidelity_score, reasons: part.reasons })),
    suspected_fidelity_gaps: parts.filter(part => part.likely_not_faithful_to_original).map(part => ({ id: part.id, path: part.path, issues: part.issues, reasons: part.reasons })),
    parts,
    limitations: ['Scores rank supplied evidence quality; they are not probabilities that the implementation is correct.', 'Unreported regions cannot be evaluated and are not counted as verified.', 'Behavioral equivalence requires independent tests, source comparison, and observations that cover the relevant environment.']
  };
  report.markdown = renderCodeFidelityMarkdown(report);
  return report;
};

export const renderCodeFidelityMarkdown = report => {
  const lines = [
    `# Code Fidelity and Visibility Report`,
    '',
    `Target: ${report.target}`,
    `Report: ${report.report_id}`,
    `Overall fidelity score: ${report.overall_fidelity_score} (${report.grade})`,
    `Visibility coverage: ${Math.round(report.visibility_coverage * 100)}%`,
    `Unobservable parts: ${report.not_observable_count}`,
    `Simulated or inferred parts: ${report.simulated_or_inferred_count}`,
    `Likely fidelity gaps: ${report.likely_unfaithful_count}`,
    '',
    '## Parts',
    ''
  ];
  for (const part of report.parts) {
    lines.push(`### ${part.path}`, '', `- State: ${part.state}`, `- Fidelity score: ${part.fidelity_score}`, `- Not observable: ${part.cannot_see_but_may_simulate}`, `- Simulation/inference: ${part.attempted_simulation}`, `- Likely not faithful: ${part.likely_not_faithful_to_original}`, `- Origin/completeness: ${part.origin} / ${part.completeness}`);
    for (const reason of part.reasons) lines.push(`- ${reason}`);
    lines.push('');
  }
  lines.push('## Report limitations', '', ...report.limitations.map(value => `- ${value}`));
  return lines.join('\n');
};
