import { McpWriteKeyIssueRequest } from '@wizard-ads/shared/mcp-writes';
import { issueMcpWriteKey } from '../../../../src/data/mcp-keys';
import { JsonMutationError, readJsonMutation } from '../../../../src/server/json-mutation';
import { handleMcpKeyMutation } from '../../../../src/server/mcp-key-mutations';

export const runtime = 'nodejs';

export const POST = (request: Request): Promise<Response> => handleMcpKeyMutation(request, async (database, actor) => {
  const parsed = McpWriteKeyIssueRequest.safeParse(await readJsonMutation(request));
  if (!parsed.success) throw new JsonMutationError(400, 'invalid_request');
  const issued = await issueMcpWriteKey(database, actor, parsed.data);
  return Response.json(issued, { status: 201 });
});
