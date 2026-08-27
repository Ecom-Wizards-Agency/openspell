/** Pure boundary validation shared by the account action and its unit test. */
export function passwordChangeError(password: string, confirmation: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password !== confirmation) return 'The two passwords do not match.';
  return null;
}
