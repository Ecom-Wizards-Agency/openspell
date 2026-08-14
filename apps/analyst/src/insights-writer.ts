/**
 * The one write the analyst makes.
 *
 * Reads travel through MCP; this does not. The insight is a first-class row the
 * UI and future runs consume, and there is no MCP tool that writes one — the
 * write surface is gated — so the finished analysis is inserted straight into
 * `public.insights` over a separate, write-capable connection. That separation
 * is what keeps the acceptance claim honest: the read-only MCP key's audit trail
 * stays free of writes because the write never went near it.
 *
 * The org id is not supplied by the caller and never taken from the MCP payload.
 * It is resolved inside the statement from the profile's own row, so an insight
 * cannot be misfiled under an org the profile does not belong to.
 *
 * This helper lives in the analyst rather than in `@wizard-ads/db` on purpose:
 * WP-13 owns `apps/analyst` and must not modify another package's files, and a
 * single scoped insert does not need to become part of the shared query surface.
 */
import type { DbHandle } from '@wizard-ads/db';

export interface InsightInput {
  profileId: string;
  /** Report day, `YYYY-MM-DD`. Not null: `insights.date` is a required column. */
  date: string;
  kind: string;
  title: string;
  /** Markdown digest. */
  body: string;
  /** The numbers the prose refers to. Serialized to jsonb. */
  figures: unknown;
  source?: string;
}

export interface WrittenInsight {
  id: string;
  orgId: string;
  profileId: string;
  date: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function writeInsight(
  handle: Pick<DbHandle, 'sql'>,
  input: InsightInput,
): Promise<WrittenInsight> {
  if (!ISO_DATE.test(input.date)) {
    throw new Error(`insight date must be YYYY-MM-DD, got ${JSON.stringify(input.date)}`);
  }
  const figuresJson = JSON.stringify(input.figures ?? {});
  if (figuresJson === undefined) throw new Error('insight figures must be JSON-serializable');

  const rows = await handle.sql<{ id: string; org_id: string; profile_id: string; date: string }[]>`
    insert into public.insights (org_id, profile_id, date, kind, title, body, figures, source)
    select p.org_id, p.id, ${input.date}::date, ${input.kind}, ${input.title}, ${input.body},
           ${figuresJson}::text::jsonb, ${input.source ?? 'headless_analyst'}
      from public.ad_profiles p
     where p.id = ${input.profileId}
    returning id, org_id, profile_id, date::text as date
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`no profile "${input.profileId}" to attach an insight to`);
  }
  return { id: row.id, orgId: row.org_id, profileId: row.profile_id, date: row.date };
}
