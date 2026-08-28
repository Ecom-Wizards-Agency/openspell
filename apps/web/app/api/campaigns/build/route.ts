/**
 * Campaign Builder preflight and XLSX export.
 *
 * This route never calls Amazon and never records an apply. UPDATE mode reads
 * the synced mirror, builds sparse rows, and hands the operator a workbook for
 * manual Bulk Operations upload — the v1 approval boundary.
 */
import { loadCampaignUpdateEntities } from '@wizard-ads/db';
import type { EntityRow } from '@wizard-ads/shared';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
  requireOrgMembership,
} from '../../../../src/server/request-context';
import { listOrgProfiles } from '../../../../src/recommendations/data';
import {
  buildCampaignBuilderArtifact,
  type CampaignBuilderMode,
} from '../../../../src/campaigns/artifact';

export const runtime = 'nodejs';
export const CAMPAIGN_BUILD_EFFECT = 'export-only' as const;

export interface CampaignBuildRequest {
  mode: CampaignBuilderMode;
  output: 'preview' | 'xlsx';
  profileId: unknown;
  config: unknown;
}

/** Keep the HTTP surface closed to apply/write-shaped actions. */
export function parseCampaignBuildRequest(value: unknown): CampaignBuildRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (body['mode'] !== 'create' && body['mode'] !== 'update') {
    throw new Error('mode must be create or update');
  }
  const output = body['output'] ?? 'preview';
  if (output !== 'preview' && output !== 'xlsx') {
    throw new Error('output must be preview or xlsx');
  }
  return {
    mode: body['mode'],
    output,
    profileId: body['profileId'],
    config: body['config'],
  };
}

function attachment(filename: string): string {
  return `attachment; filename="${filename.replaceAll('"', '')}"`;
}

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgMembership(database, actor);
    const body = parseCampaignBuildRequest(await request.json());
    const { mode, output } = body;

    let client = 'campaigns';
    let marketplace = 'US';
    let entities: EntityRow[] | undefined;
    if (mode === 'update') {
      if (typeof body.profileId !== 'string' || body.profileId.length === 0) {
        throw new Error('profileId is required for UPDATE mode');
      }
      const profiles = await listOrgProfiles(database, actor.orgId);
      const profile = profiles.find((candidate) => candidate.id === body.profileId);
      if (profile === undefined) throw new Error('Not found');
      client = profile.label;
      marketplace = profile.countryCode;
      entities = (await loadCampaignUpdateEntities(database, {
        orgId: actor.orgId,
        profileId: profile.id,
      })).entities;
    }

    const artifact = buildCampaignBuilderArtifact(mode, body.config, {
      client,
      marketplace,
      entities,
      today: new Date().toISOString().slice(0, 10),
    });
    if (output === 'preview') return Response.json(artifact.preview);
    if (artifact.workbook === null || !artifact.preview.exportable) {
      return Response.json(
        {
          error: artifact.preview.issues[0] ?? 'The preflight produced zero effective rows',
          preview: artifact.preview,
        },
        { status: 422 },
      );
    }
    return new Response(new Uint8Array(artifact.workbook.bytes), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': attachment(artifact.workbook.filename),
        'x-wizard-ads-bulk-rows': String(artifact.preview.rows.length),
      },
    });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
