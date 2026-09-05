import { approveAndQueueSpWrite } from '@wizard-ads/db/sp-write-application';
import { SpWriteManualApprovalRequest } from '@wizard-ads/shared/sp-write-application';
import { handleSpWriteRequest } from '../../../../src/writes/http';

export const runtime = 'nodejs';
export const POST = (request: Request): Promise<Response> =>
  handleSpWriteRequest(request, SpWriteManualApprovalRequest, approveAndQueueSpWrite);
