/**
 * Checking that a statement came from where it says it came from.
 *
 * This is the anti-fabrication mechanism, and it is deterministic code rather
 * than prompt wording, because prompt wording is a request and this is a
 * guarantee. Every node id a model returns is checked against the set the
 * digest actually contains; every passage id against the passages the parser
 * actually produced. An id outside those sets did not come from the source,
 * whatever the model believes.
 *
 * A statement whose evidence does not resolve is **demoted**, not deleted. A
 * model's guess about a hover state is often right and always worth a question
 * -- it simply is not a requirement. Demotion keeps it where a reader will see
 * it, under inferences, labelled with why it is there.
 *
 * The cost is accepted deliberately: a true observation attributed to the wrong
 * node id is demoted too. In a workflow whose whole premise is that the design
 * is the source of truth, an unverifiable requirement presented as verified is
 * the more expensive error.
 */

import type { DesignElement, Evidence, Gap, Inference, Requirement, TicketClaim } from '#shared/analysis';

import type { ReconcileOutput } from './schema';

export interface EvidenceSets {
  /** Every node id the digest mentioned. */
  nodeIds: ReadonlySet<string>;
  /** Every passage id the ticket parser produced, comments included. */
  passageIds: ReadonlySet<string>;
}

/**
 * Strips the decoration the prompts themselves put around an id.
 *
 * The lesson this encodes was learned twice, from real runs, in the same hour.
 * The design outline writes a node as `#1:3`; the ticket labels a section
 * `[passage acceptancecriteria]`. Both sigils exist so a human can find an id
 * in a wall of text, and both prompts ask for the id "verbatim" — so the model
 * returned `#1:3` and `[passage acceptancecriteria]`, which is precisely what
 * it was told to do. A naive set lookup called both fabrications and threw
 * away two entirely correct passes.
 *
 * **Any sigil added for readability becomes part of what the model copies.**
 * Asking more firmly is not the fix; accepting the decoration is, because the
 * decoration is ours.
 *
 * This is normalisation, not coercion. None of these characters occurs in a
 * Figma node id or in a passage slug, so nothing is being guessed at: the id
 * either survives the strip and matches, or it does not exist.
 */
export function normaliseId(value: string): string {
  return value
    .trim()
    // `[passage acceptancecriteria]`, `[#1:3]`, `[c1]`
    .replace(/^\[(.*)\]$/s, '$1')
    .trim()
    // The label word, when the whole label was copied.
    .replace(/^(?:passage|node|comment on)\s+/i, '')
    // The outline's own sigil.
    .replace(/^#/, '')
    .trim();
}

export function evidenceSets(
  nodeIds: readonly string[],
  passageIds: readonly string[],
): EvidenceSets {
  return {
    nodeIds: new Set(nodeIds.map(normaliseId)),
    passageIds: new Set(passageIds.map(normaliseId)),
  };
}

interface Checked {
  evidence: Evidence;
  /** Ids that did not resolve, so a message can name them. */
  unknown: string[];
}

function check(
  nodeIds: readonly string[],
  passageIds: readonly string[],
  sets: EvidenceSets,
): Checked {
  const nodes = nodeIds.map(normaliseId);
  const passages = passageIds.map(normaliseId);

  return {
    // Stored normalised, so nothing downstream has to know about the sigil.
    evidence: {
      nodeIds: nodes.filter((id) => sets.nodeIds.has(id)),
      passageIds: passages.filter((id) => sets.passageIds.has(id)),
    },
    unknown: [
      ...nodes.filter((id) => !sets.nodeIds.has(id)),
      ...passages.filter((id) => !sets.passageIds.has(id)),
    ],
  };
}

export interface CheckedAnalysis {
  requirements: Requirement[];
  inferences: Inference[];
  gaps: Gap[];
}

/**
 * Splits a pass-3 result into what the sources support and what they do not.
 *
 * A requirement survives when at least one id resolves. One with no evidence at
 * all, or with only ids that do not exist, becomes an inference.
 */
export function checkEvidence(reconciled: ReconcileOutput, sets: EvidenceSets): CheckedAnalysis {
  const requirements: Requirement[] = [];
  const inferences: Inference[] = [];

  for (const entry of reconciled.requirements) {
    const { evidence, unknown } = check(entry.nodeIds, entry.passageIds, sets);
    const supported = evidence.nodeIds.length > 0 || evidence.passageIds.length > 0;

    if (supported) {
      requirements.push({ id: entry.id, statement: entry.statement, evidence });
      continue;
    }

    inferences.push({
      id: entry.id,
      statement: entry.statement,
      reason:
        unknown.length > 0
          ? `cited ${unknown.map((id) => `"${id}"`).join(', ')}, which ${
              unknown.length === 1 ? 'is not' : 'are not'
            } in the design or the ticket`
          : 'no design node or ticket passage was cited',
    });
  }

  // Gaps keep whatever evidence resolved and are never demoted: a gap is a
  // question, and a question with weak evidence is still a question. The
  // unresolvable ids are dropped so nothing downstream can follow them.
  const gaps = reconciled.gaps.map((gap): Gap => ({
    ...gap,
    evidence: check(gap.evidence.nodeIds, gap.evidence.passageIds, sets).evidence,
  }));

  return { requirements, inferences, gaps };
}

/**
 * Drops elements pass 1 attributed to nodes that are not in the digest.
 *
 * Run before pass 3 rather than after, so a fabricated element never reaches
 * the reconciliation and cannot father a requirement that then has to be
 * demoted.
 */
export function checkElements(
  elements: readonly DesignElement[],
  sets: EvidenceSets,
): { kept: DesignElement[]; dropped: DesignElement[] } {
  const kept: DesignElement[] = [];
  const dropped: DesignElement[] = [];
  for (const element of elements) {
    const nodeId = normaliseId(element.nodeId);
    if (sets.nodeIds.has(nodeId)) kept.push({ ...element, nodeId });
    else dropped.push(element);
  }
  return { kept, dropped };
}

/** The same, for pass 2's claims against the ticket's passages. */
export function checkClaims(
  claims: readonly TicketClaim[],
  sets: EvidenceSets,
): { kept: TicketClaim[]; dropped: TicketClaim[] } {
  const kept: TicketClaim[] = [];
  const dropped: TicketClaim[] = [];
  for (const claim of claims) {
    const passageId = normaliseId(claim.passageId);
    if (sets.passageIds.has(passageId)) kept.push({ ...claim, passageId });
    else dropped.push(claim);
  }
  return { kept, dropped };
}
