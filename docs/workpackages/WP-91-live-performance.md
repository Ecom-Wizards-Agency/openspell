# WP-91 — Live operator-route performance

## Outcome

Meet the live responsiveness target on realistic account sizes instead of relying only on an
isolated in-memory fixture.

## Evidence sequence

1. Record server response time, query count/time, response bytes, hydration time and first useful
   render for Grid and Time Machine.
2. Identify the dominant stage before changing code.
3. Fix bounded data reads, serialization, component boundaries and rendering work as supported by
   the trace; do not hide the delay behind a longer skeleton.
4. Repeat the authenticated production measurement on the known 3,597-row profile and preserve a
   synthetic CI benchmark.

## Acceptance

- Grid is usable in under two seconds on the reference development machine and production route.
- Grid p95 filter plus three-level grouping response is below 150 ms.
- Route payload and query-count ceilings are explicit tests.
- Time Machine has an evidence-backed target after its trace is captured and improves materially
  from the verified 5.36-second first load.
- Loaded, empty, partial, stale and error states remain truthful.
- No Amazon write is invoked.
