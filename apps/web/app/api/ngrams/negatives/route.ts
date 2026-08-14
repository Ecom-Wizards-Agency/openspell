/**
 * "Propose as negative" from the n-gram explorer.
 *
 * It creates proposals. It negates nothing: v1 writes nothing to Amazon, and a
 * one-click negative that actually negated would be the one place in this
 * product where a click leaves the review loop. The rows land in their own run
 * marked `ngram-explorer`, so a proposal an operator clicked is never
 * indistinguishable from one the White Box formula produced.
 *
 * Each proposal carries the gram's own evidence as its `inputs`, so it arrives
 * in the review surface with its work shown like every other proposal rather
 * than as an assertion.
 */
import { createNegativeProposals } from '@wizard-ads/db';
import type { NegativeProposalInput } from '@wizard-ads/db';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
} from '../../../../src/server/request-context';
import { requireCapability } from '../../../../src/server/org-role';

export const runtime = 'nodejs';

const MATCH_TYPES: readonly string[] = ['negative_exact', 'negative_phrase'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface IncomingProposal {
  searchTerm?: unknown;
  campaignId?: unknown;
  adGroupId?: unknown;
  matchType?: unknown;
  clicks?: unknown;
  rpc?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'editTargets');

    const body = (await request.json()) as {
      profileId?: unknown;
      window?: unknown;
      proposals?: unknown;
    };
    if (typeof body.profileId !== 'string') throw new Error('profileId is required');
    const incomingWindow = body.window as { start?: unknown; end?: unknown } | undefined;
    if (
      incomingWindow === undefined ||
      typeof incomingWindow.start !== 'string' ||
      typeof incomingWindow.end !== 'string' ||
      !ISO_DATE.test(incomingWindow.start) ||
      !ISO_DATE.test(incomingWindow.end)
    ) {
      throw new Error('window must carry ISO start and end dates');
    }
    const window: { start: string; end: string } = {
      start: incomingWindow.start,
      end: incomingWindow.end,
    };
    if (!Array.isArray(body.proposals) || body.proposals.length === 0) {
      throw new Error('proposals must be a non-empty array');
    }

    // The profile has to belong to the caller's org. `ad_profiles` carries the
    // org, so this is one statement and not a trust decision.
    const owned = await database.sql<{ exists: boolean }[]>`
      select exists(
        select 1 from public.ad_profiles
         where id = ${body.profileId} and org_id = ${actor.orgId}
      ) as exists
    `;
    if (!owned[0]?.exists) throw new Error('Not found');

    const proposals: NegativeProposalInput[] = (body.proposals as IncomingProposal[]).map(
      (proposal, index) => {
        if (typeof proposal.searchTerm !== 'string' || proposal.searchTerm.trim().length === 0) {
          throw new Error(`proposal ${index} needs a search term`);
        }
        if (typeof proposal.campaignId !== 'string') {
          throw new Error(`proposal ${index} needs a campaign id`);
        }
        const matchType =
          typeof proposal.matchType === 'string' && MATCH_TYPES.includes(proposal.matchType)
            ? (proposal.matchType as NegativeProposalInput['matchType'])
            : 'negative_exact';
        const clicks =
          typeof proposal.clicks === 'number' && Number.isFinite(proposal.clicks)
            ? Math.max(0, Math.trunc(proposal.clicks))
            : 0;
        const rpc = typeof proposal.rpc === 'number' && Number.isFinite(proposal.rpc) ? proposal.rpc : null;
        return {
          searchTerm: proposal.searchTerm.trim(),
          campaignId: proposal.campaignId,
          adGroupId: typeof proposal.adGroupId === 'string' ? proposal.adGroupId : null,
          matchType,
          inputs: {
            rpc,
            clicks,
            // `keyword` is the most specific level the contract has, and it is
            // the right one: the evidence is the search term's own pooled
            // performance under the target it matched through, not a benchmark
            // borrowed from a level above it.
            cvrSourceLevel: 'keyword',
            ceilingApplied: null,
            capClamped: false,
            window: { start: window.start, end: window.end },
          },
        };
      },
    );

    const lookbackDays =
      Math.round(
        (Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) /
          86_400_000,
      ) + 1;

    const result = await createNegativeProposals(database, {
      orgId: actor.orgId,
      profileId: body.profileId,
      window: { start: window.start, end: window.end },
      lookbackDays,
      proposals,
      actorId: actor.userId,
    });

    return Response.json({ ...result, offered: proposals.length }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
