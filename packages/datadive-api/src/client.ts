import { DataDiveConfigError, DataDiveParseError } from './errors.js';
import { createHttpContext, httpGetJson, type HttpContext } from './http.js';
import { parseQuota, parseRankRadarData, parseRankRadarPage } from './parsers.js';
import type {
  DataDiveClientOptions,
  DataDiveQuota,
  RankRadarData,
  RankRadarDateRange,
  RankRadarList,
} from './types.js';
import { IsoDate } from '@wizard-ads/shared';

const DEFAULT_BASE_URL = 'https://api.datadive.tools';
const RANK_RADARS_PATH = '/v1/niches/rank-radars';
const QUOTA_PATH = '/v1/quota';
const PAGE_SIZE = 50;

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new DataDiveConfigError(`${name} cannot be empty`);
  return trimmed;
}

function dateRange(input: RankRadarDateRange): RankRadarDateRange {
  if (!IsoDate.safeParse(input.startDate).success || !IsoDate.safeParse(input.endDate).success) {
    throw new DataDiveConfigError('DataDive rank date range must use yyyy-mm-dd dates');
  }
  if (input.startDate > input.endDate) {
    throw new DataDiveConfigError('DataDive rank startDate cannot be after endDate');
  }
  return input;
}

export class DataDiveClient {
  private readonly credential: string;
  private readonly baseUrl: string;
  private readonly http: HttpContext;

  constructor(options: DataDiveClientOptions) {
    this.credential = required(options.apiKey, 'DataDive API key');
    this.baseUrl = required(options.baseUrl ?? DEFAULT_BASE_URL, 'DataDive base URL').replace(/\/+$/, '');
    this.http = createHttpContext(options);
  }

  async listRankRadars(): Promise<RankRadarList> {
    const items: RankRadarList['items'] = [];
    const ids = new Set<string>();
    let currentPage = 1;
    let total = 0;

    for (;;) {
      const query = new URLSearchParams({ currentPage: String(currentPage), pageSize: String(PAGE_SIZE) });
      const raw = await httpGetJson(this.http, {
        url: `${this.baseUrl}${RANK_RADARS_PATH}?${query.toString()}`,
        path: RANK_RADARS_PATH,
        apiKey: this.credential,
      });
      const page = parseRankRadarPage(raw);
      if (page.currentPage !== currentPage) {
        throw new DataDiveParseError(
          `rank radar list returned page ${page.currentPage} while page ${currentPage} was requested`,
        );
      }
      if (currentPage === 1) total = page.total;
      else if (page.total !== total) throw new DataDiveParseError('rank radar total changed during pagination');
      if (page.hasNext && page.items.length === 0) {
        throw new DataDiveParseError('rank radar list advertised a next page after an empty page');
      }
      for (const radar of page.items) {
        if (ids.has(radar.id)) throw new DataDiveParseError(`rank radar ${radar.id} appeared on multiple pages`);
        ids.add(radar.id);
        items.push(radar);
      }
      if (!page.hasNext) break;
      currentPage += 1;
    }

    if (items.length !== total) {
      throw new DataDiveParseError(`rank radar list declared ${total} items but returned ${items.length}`);
    }
    return { items, pages: currentPage, total };
  }

  async getRankRadarData(id: string, input: RankRadarDateRange): Promise<RankRadarData> {
    const radarId = required(id, 'DataDive Rank Radar id');
    const range = dateRange(input);
    const path = `${RANK_RADARS_PATH}/${encodeURIComponent(radarId)}`;
    const query = new URLSearchParams({ startDate: range.startDate, endDate: range.endDate });
    const raw = await httpGetJson(this.http, {
      url: `${this.baseUrl}${path}?${query.toString()}`,
      path,
      apiKey: this.credential,
    });
    return parseRankRadarData(raw);
  }

  async getQuota(): Promise<DataDiveQuota> {
    const raw = await httpGetJson(this.http, {
      url: `${this.baseUrl}${QUOTA_PATH}`,
      path: QUOTA_PATH,
      apiKey: this.credential,
    });
    return parseQuota(raw);
  }
}
