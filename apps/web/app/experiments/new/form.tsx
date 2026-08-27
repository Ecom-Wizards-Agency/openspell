'use client';

/**
 * The create form.
 *
 * The scope is shown, not merely carried: a grid selection that pre-filled the
 * campaigns is visible and editable before anything is stored, the same
 * discipline the feedback widget follows with its page context. The scope is
 * edited as comma-separated id lists — plain, and honest about what an
 * experiment's scope actually is (a set of Amazon ids), rather than pretending
 * to a picker this surface does not need yet.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ProfileOption } from '../../../src/experiments/data';
import {
  EXPERIMENT_METRIC_OPTIONS,
  EXPERIMENT_TYPE_OPTIONS,
  METRIC_LABELS,
  TYPE_LABELS,
} from '../../../src/experiments/labels';
import { banner, colors, heading, muted, page } from '../../../src/ui/tokens';

export interface PrefilledScope {
  campaignIds: string[];
  adGroupIds: string[];
  targetIds: string[];
  asins: string[];
  searchTerms: string[];
}

const field = {
  border: `1px solid ${colors.border}`,
  borderRadius: '0.25rem',
  fontSize: '0.875rem',
  padding: '0.375rem 0.5rem',
  width: '100%',
} as const;

const toList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

export function NewExperimentForm({
  profiles,
  selectedProfileId,
  prefillName,
  scope,
}: {
  profiles: ProfileOption[];
  selectedProfileId: string | null;
  prefillName: string;
  scope: PrefilledScope;
}) {
  const [profileId, setProfileId] = useState(selectedProfileId ?? profiles[0]?.id ?? '');
  const [name, setName] = useState(prefillName);
  const [type, setType] = useState<(typeof EXPERIMENT_TYPE_OPTIONS)[number]>('bid_push');
  const [metric, setMetric] = useState<(typeof EXPERIMENT_METRIC_OPTIONS)[number]>('sales');
  const [hypothesis, setHypothesis] = useState('');
  const [campaigns, setCampaigns] = useState(scope.campaignIds.join(', '));
  const [targets, setTargets] = useState(scope.targetIds.join(', '));
  const [asins, setAsins] = useState(scope.asins.join(', '));
  const [terms, setTerms] = useState(scope.searchTerms.join(', '));
  const [startNow, setStartNow] = useState(true);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage('Sending…');
    void (async () => {
      try {
        const response = await fetch('/api/experiments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            profileId,
            name,
            hypothesis,
            type,
            metricFocus: metric,
            status: startNow ? 'running' : 'planned',
            scope: {
              campaignIds: toList(campaigns),
              adGroupIds: scope.adGroupIds,
              targetIds: toList(targets),
              asins: toList(asins),
              searchTerms: toList(terms),
            },
          }),
        });
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          item?: { id: string };
        } | null;
        if (!response.ok || !payload?.item) {
          throw new Error(payload?.error ?? `Could not create the experiment (${response.status})`);
        }
        window.location.href = `/experiments/${payload.item.id}`;
      } catch (error) {
        setPending(false);
        setMessage(error instanceof Error ? error.message : 'Could not create the experiment');
      }
    })();
  };

  return (
    <main style={page} data-interactive={ready ? 'true' : 'false'}>
      <h1 style={heading}>Start an experiment</h1>
      <p style={muted}>
        Record a deliberate test so its window shades every chart and its outcome is measurable in
        the facts later. This is tracking, not a randomized experiment — see the comparison note on
        the detail page.
      </p>

      {message && (
        <p role="status" style={banner(pending ? 'warn' : 'bad')}>
          {message}
        </p>
      )}

      <form onSubmit={submit} style={{ display: 'grid', gap: '0.875rem', maxWidth: '42rem' }}>
        <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.875rem' }}>
          Profile
          <select
            value={profileId}
            data-testid="experiment-profile"
            onChange={(event) => setProfileId(event.target.value)}
            style={field}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label} · {profile.countryCode}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.875rem' }}>
          Name
          <input
            required
            maxLength={200}
            value={name}
            data-testid="experiment-name"
            onChange={(event) => setName(event.target.value)}
            style={field}
          />
        </label>

        <div style={{ display: 'flex', gap: '0.875rem', flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.875rem', flex: '1 1 12rem' }}>
            Type
            <select
              value={type}
              data-testid="experiment-type"
              onChange={(event) => setType(event.target.value as typeof type)}
              style={field}
            >
              {EXPERIMENT_TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {TYPE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.875rem', flex: '1 1 12rem' }}>
            Metric focus
            <select
              value={metric}
              data-testid="experiment-metric"
              onChange={(event) => setMetric(event.target.value as typeof metric)}
              style={field}
            >
              {EXPERIMENT_METRIC_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {METRIC_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.875rem' }}>
          Hypothesis
          <textarea
            rows={3}
            value={hypothesis}
            data-testid="experiment-hypothesis"
            onChange={(event) => setHypothesis(event.target.value)}
            style={{ ...field, fontFamily: 'inherit' }}
          />
        </label>

        <fieldset
          data-testid="experiment-scope"
          style={{ border: `1px solid ${colors.border}`, borderRadius: '0.375rem', padding: '0.75rem', display: 'grid', gap: '0.625rem' }}
        >
          <legend style={{ ...muted, padding: '0 0.25rem' }}>Scope — the entities under test</legend>
          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.8125rem' }}>
            Campaign ids
            <input value={campaigns} data-testid="scope-campaigns" onChange={(event) => setCampaigns(event.target.value)} style={field} />
          </label>
          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.8125rem' }}>
            Keyword / target ids
            <input value={targets} data-testid="scope-targets" onChange={(event) => setTargets(event.target.value)} style={field} />
          </label>
          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.8125rem' }}>
            ASINs
            <input value={asins} data-testid="scope-asins" onChange={(event) => setAsins(event.target.value)} style={field} />
          </label>
          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.8125rem' }}>
            Search terms
            <input value={terms} data-testid="scope-terms" onChange={(event) => setTerms(event.target.value)} style={field} />
          </label>
        </fieldset>

        <label style={{ fontSize: '0.875rem' }}>
          <input
            type="checkbox"
            checked={startNow}
            data-testid="experiment-start-now"
            onChange={(event) => setStartNow(event.target.checked)}
          />{' '}
          Start it running now (otherwise it is planned)
        </label>

        <div>
          <button type="submit" disabled={pending} data-testid="experiment-submit" className="wa-btn">
            {pending ? 'Creating…' : 'Create experiment'}
          </button>{' '}
          <a href="/experiments" style={{ ...muted, marginLeft: '0.5rem' }}>
            Cancel
          </a>
        </div>
      </form>
    </main>
  );
}
