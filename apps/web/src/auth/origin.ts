/** A fixed origin prevents forwarded-host input from poisoning auth links. */
export function authOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env['WIZARD_ADS_APP_URL'];
  if (!configured) {
    if (env['NODE_ENV'] === 'production') {
      throw new Error('WIZARD_ADS_APP_URL is required for authentication links in production');
    }
    return 'http://localhost:3000';
  }

  const url = new URL(configured);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.origin !== configured.replace(/\/$/, '')
  ) {
    throw new Error('WIZARD_ADS_APP_URL must be an http(s) origin without a path');
  }
  return url.origin;
}
