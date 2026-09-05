import { previewSpWriteInverse } from '@wizard-ads/db/sp-write-application';
import { SpWriteInversePreviewRequest } from '@wizard-ads/shared/sp-write-application';
import { handleSpWriteRequest } from '../../../../src/writes/http';

export const runtime = 'nodejs';
export const POST = (request: Request): Promise<Response> =>
  handleSpWriteRequest(request, SpWriteInversePreviewRequest, previewSpWriteInverse);
