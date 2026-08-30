const DIAGNOSTIC_ENVIRONMENT = [
  'DEBUG',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'NODE_OPTIONS',
  'NODE_V8_COVERAGE',
  'PWDEBUG',
] as const;

for (const name of DIAGNOSTIC_ENVIRONMENT) delete process.env[name];

void import('./verify-release-candidate')
  .then(async ({ runReleaseCandidateCli }) => {
    await runReleaseCandidateCli();
    process.exit(process.exitCode ?? 0);
  })
  .catch(() => {
    console.error('OPENSPELL_RELEASE_ERROR:unexpected_failure');
    process.exit(1);
  });
