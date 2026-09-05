import { readSpWriteOperation } from '@wizard-ads/db/sp-write-application';
import { SpWriteOperationRequest } from '@wizard-ads/shared/sp-write-application';
import { handleSpWriteRequest } from '../../../../src/writes/http';

export const runtime = 'nodejs';
export const GET = (request: Request): Promise<Response> =>
  handleSpWriteRequest(request, SpWriteOperationRequest, readSpWriteOperation);
