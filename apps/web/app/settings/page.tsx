/** `/settings` has no content of its own; connections is the first screen. */
import { redirect } from 'next/navigation';

export default function SettingsIndex(): never {
  redirect('/settings/connections');
}
