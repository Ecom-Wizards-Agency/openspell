import { headers } from 'next/headers';
import { actorFromHeaders, openWebDatabase, requireOrgMembership } from '../../src/server/request-context';
import { listCampaignsByTagFilter, listTagTree } from '@wizard-ads/db';
import type { JsonValue } from '@wizard-ads/db';
import { TagManager } from './tag-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function parseState(value: string | string[] | undefined): JsonValue | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

export default async function TagsPage({ searchParams }: { searchParams: SearchParams }) {
  const database = openWebDatabase();
  try {
    const actor = actorFromHeaders(await headers());
    await requireOrgMembership(database, actor);
    const [tags, campaigns] = await Promise.all([
      listTagTree(database, actor.orgId),
      listCampaignsByTagFilter(database, actor.orgId),
    ]);
    const query = await searchParams;
    return (
      <TagManager
        initialState={parseState(query['state'])}
        tags={tags.map((tag) => ({
          id: tag.id,
          parentId: tag.parentId,
          name: tag.name,
          color: tag.color,
          children: tag.children,
        }))}
        campaigns={campaigns}
      />
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tags are unavailable';
    return (
      <main style={{ maxWidth: 760, margin: '48px auto', fontFamily: 'system-ui' }}>
        <h1>Tags</h1>
        <p role="alert">{message}</p>
        <p>
          This surface requires the authenticated request context supplied by the web auth
          middleware.
        </p>
      </main>
    );
  } finally {
    await database.close();
  }
}
