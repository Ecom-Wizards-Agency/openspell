import type { Region } from '@wizard-ads/shared';

interface Waiter {
  resolve: () => void;
}

class TokenBucket {
  private available: number;
  private readonly waiters: Waiter[] = [];
  private active = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('token bucket capacity must be a positive integer');
    }
    this.available = capacity;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.take();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  snapshot(): { active: number; waiting: number; capacity: number } {
    return { active: this.active, waiting: this.waiters.length, capacity: this.capacity };
  }

  private async take(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push({ resolve }));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve();
    else this.available += 1;
  }
}

export class RegionTokenBuckets {
  private readonly buckets: Record<Region, TokenBucket>;

  constructor(capacityPerRegion = 2) {
    this.buckets = {
      NA: new TokenBucket(capacityPerRegion),
      EU: new TokenBucket(capacityPerRegion),
      FE: new TokenBucket(capacityPerRegion),
    };
  }

  run<T>(region: Region, operation: () => Promise<T>): Promise<T> {
    return this.buckets[region].run(operation);
  }

  snapshot(region: Region): { active: number; waiting: number; capacity: number } {
    return this.buckets[region].snapshot();
  }
}

/** Shared by worker instances in the single Fly VM. */
export const defaultRegionTokenBuckets = new RegionTokenBuckets(2);
