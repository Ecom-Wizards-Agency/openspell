const DIAGNOSTIC_ENVIRONMENT = ['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'PWDEBUG'] as const;

for (const name of DIAGNOSTIC_ENVIRONMENT) delete process.env[name];

void import('./verify-release-candidate')
  .then(async ({ runReleaseCandidateCli }) => runReleaseCandidateCli())
  .catch(() => {
    console.error('OPENSPELL_RELEASE_ERROR:unexpected_failure');
    process.exitCode = 1;
  });
