export const TOTP_POLICIES = [
  'off',
  'enrollment-only',
  'enforce-when-enrolled',
  'require-for-privileged',
] as const;

export type TotpPolicy = (typeof TOTP_POLICIES)[number];

export const PASSKEY_POLICIES = ['off', 'manage-only', 'enroll', 'sign-in'] as const;

export type PasskeyPolicy = (typeof PASSKEY_POLICIES)[number];

export interface AuthFeatureConfig {
  passwordLogin: boolean;
  passwordRecovery: boolean;
  totpPolicy: TotpPolicy;
  passkeyPolicy: PasskeyPolicy;
}

/** Parse auth rollout controls once at the server boundary. Missing means off. */
export function authFeatureConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AuthFeatureConfig {
  return {
    passwordLogin: binaryFlag(env, 'WIZARD_ADS_PASSWORD_LOGIN'),
    passwordRecovery: binaryFlag(env, 'WIZARD_ADS_PASSWORD_RECOVERY'),
    totpPolicy: enumFlag(env, 'WIZARD_ADS_TOTP_POLICY', TOTP_POLICIES, 'off'),
    passkeyPolicy: enumFlag(env, 'WIZARD_ADS_PASSKEYS', PASSKEY_POLICIES, 'off'),
  };
}

function binaryFlag(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error(`${name} must be 0 or 1`);
}

function enumFlag<const Values extends readonly string[]>(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  values: Values,
  fallback: Values[number],
): Values[number] {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if ((values as readonly string[]).includes(value)) return value as Values[number];
  throw new Error(`${name} must be one of: ${values.join(', ')}`);
}
