/**
 * Scaffold baseline only. WP-04 owns auth, orgs and the OAuth routes; WP-06
 * owns the dashboard and the grid. This page exists so `next build` has
 * something to build and so the App Router wiring is proven from day one.
 */
export default function Page() {
  return (
    <main>
      <h1>wizard-ads</h1>
      <p>Scaffold. Nothing is wired up yet.</p>
    </main>
  );
}
