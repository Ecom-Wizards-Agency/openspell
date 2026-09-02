import { once } from 'node:events';
import { RecommendationClaimantCustodyError } from './claimant.js';
import { recommendationLaneConfigFromEnv } from './config.js';
import { RecommendationHealthMonitor, listenRecommendationHealth } from './health.js';
import { createRecommendationLaneRuntime } from './postgres.js';

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = recommendationLaneConfigFromEnv(env);
  const runtime = createRecommendationLaneRuntime(config);
  let server: Awaited<ReturnType<typeof listenRecommendationHealth>> | null = null;
  let claimantLoop: Promise<void> | null = null;
  try {
    const authority = await runtime.healthDatabase.getAuthority();
    if (
      config.claimArmed
      && (authority.protocol !== 'fenced' || authority.authorizedRevision !== config.revision)
    ) {
      throw new RecommendationLaneUnsafeExitError('authority_mismatch');
    }
    const monitor = new RecommendationHealthMonitor(
      config,
      runtime.healthDatabase,
      runtime.claimant,
      authority,
    );
    server = await listenRecommendationHealth(monitor, config.healthHost, config.healthPort);
    if (config.claimArmed) {
      claimantLoop = runtime.claimant.start();
    }

    const signal = firstSignal();
    const exit = claimantLoop === null
      ? await signal.promise.then(() => ({ kind: 'signal' as const }))
      : await Promise.race([
          signal.promise.then(() => ({ kind: 'signal' as const })),
          claimantLoop.then(
            () => ({ kind: 'claimant_stopped' as const }),
            (error: unknown) => ({ kind: 'claimant_failed' as const, error }),
          ),
        ]);
    signal.dispose();
    monitor.stop();
    const shutdown = await runtime.claimant.shutdown();
    server.close();
    await once(server, 'close');
    if (shutdown.unresolved > 0) {
      throw new RecommendationLaneUnsafeExitError('unresolved_custody');
    }
    if (exit.kind === 'claimant_failed') throw exit.error;
    if (exit.kind === 'claimant_stopped') {
      throw new Error('recommendation claimant stopped before shutdown');
    }
    // A bounded drain may deliberately leave non-expiring custody for an
    // attended same-identity recovery. Do not turn that bounded contract into
    // an unbounded process wait on the still-running database operation.
    if (claimantLoop !== null && shutdown.unresolved === 0) await claimantLoop;
  } finally {
    if (server?.listening) server.close();
    await runtime.close();
  }
}

export class RecommendationLaneUnsafeExitError extends Error {
  override readonly name = 'RecommendationLaneUnsafeExitError';

  constructor(readonly kind: 'authority_mismatch' | 'unresolved_custody') {
    super(`recommendation lane unsafe exit: ${kind}`);
  }
}

/** systemd must not restart a revision whose custody state needs attendance. */
export function recommendationLaneExitCode(error: unknown): 1 | 78 {
  return error instanceof RecommendationLaneUnsafeExitError
      || error instanceof RecommendationClaimantCustodyError
    ? 78
    : 1;
}

function firstSignal(): { promise: Promise<NodeJS.Signals>; dispose: () => void } {
  let resolveSignal: (signal: NodeJS.Signals) => void = () => undefined;
  const promise = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });
  const onInterrupt = (): void => resolveSignal('SIGINT');
  const onTerminate = (): void => resolveSignal('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  return {
    promise,
    dispose: () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.exitCode = recommendationLaneExitCode(error);
  });
}
