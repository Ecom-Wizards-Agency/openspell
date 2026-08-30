'use client';

/** Guided experiment setup with optional, profile-scoped entity selectors. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  ExperimentScopeOptions,
  ProfileOption,
} from '../../../src/experiments/data';
import {
  EXPERIMENT_METRIC_OPTIONS,
  EXPERIMENT_TYPE_OPTIONS,
  METRIC_LABELS,
  TYPE_LABELS,
} from '../../../src/experiments/labels';
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from '../../../src/ui/primitives';

export interface PrefilledScope {
  campaignIds: string[];
  adGroupIds: string[];
  targetIds: string[];
  asins: string[];
  searchTerms: string[];
}

interface SelectorOption {
  id: string;
  label: string;
  secondary: string;
  available: boolean;
}

const DISPLAY_LIMIT = 50;

const cleanList = (values: readonly string[]): string[] =>
  Array.from(new Set(values.map((entry) => entry.trim()).filter((entry) => entry !== '')));

const toList = (value: string): string[] => cleanList(value.split(','));

const campaignsFrom = (options: ExperimentScopeOptions): SelectorOption[] =>
  options.campaigns.map((campaign) => ({
    id: campaign.id,
    label: campaign.name,
    secondary: `Campaign ID ${campaign.id}`,
    available: campaign.available,
  }));

const productsFrom = (options: ExperimentScopeOptions): SelectorOption[] =>
  options.products.map((product) => ({
    id: product.asin,
    label: product.name ?? (product.sku === null ? 'Unnamed synced product' : `SKU ${product.sku}`),
    secondary: `ASIN ${product.asin}`,
    available: product.available,
  }));

export function SearchableScopeSelector({
  id,
  label,
  hint,
  searchLabel,
  options,
  selectedIds,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  searchLabel: string;
  options: readonly SelectorOption[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const optionIds = useMemo(() => new Set(options.map((option) => option.id)), [options]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = options.filter((option) => {
    if (!option.available && !selected.has(option.id)) return false;
    if (normalizedQuery === '') return true;
    return `${option.label} ${option.secondary} ${option.id}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
  const selectableFiltered = filtered.filter((option) => option.available);
  const shown = filtered.slice(0, DISPLAY_LIMIT);
  const unavailableSelections = selectedIds.filter((selectedId) => {
    const option = options.find((candidate) => candidate.id === selectedId);
    return !optionIds.has(selectedId) || option?.available === false;
  });
  const allFilteredSelected =
    selectableFiltered.length > 0 && selectableFiltered.every((option) => selected.has(option.id));

  const toggle = (optionId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(optionId);
    else next.delete(optionId);
    onChange([...next]);
  };

  const selectAllFiltered = () => {
    const next = new Set(selectedIds);
    for (const option of selectableFiltered) next.add(option.id);
    onChange([...next]);
  };

  return (
    <section className="wa-scope-selector" aria-labelledby={`${id}-title`}>
      <div className="wa-scope-selector__head">
        <div>
          <h3 id={`${id}-title`} className="wa-scope-selector__title">
            {label} <span>Optional</span>
          </h3>
          <p>{hint}</p>
        </div>
        <strong aria-live="polite" data-testid={`${id}-selected-count`}>
          {selectedIds.length} selected
        </strong>
      </div>

      {unavailableSelections.length === 0 ? null : (
        <div className="wa-scope-selector__unavailable" role="status">
          <span>Not in the current sync</span>
          <div>
            {unavailableSelections.map((selectedId) => (
              <span className="wa-scope-selector__unknown" key={selectedId}>
                <code>{selectedId}</code>
                <button
                  type="button"
                  aria-label={`Remove ${selectedId}`}
                  onClick={() => toggle(selectedId, false)}
                >
                  Remove
                </button>
              </span>
            ))}
          </div>
          <small>Preserved from the link or manual entry. Remove it if it no longer belongs.</small>
        </div>
      )}

      <Field label={searchLabel} htmlFor={`${id}-search`}>
        <Input
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${label.toLocaleLowerCase()}`}
        />
      </Field>

      <div className="wa-scope-selector__actions">
        <Button
          size="sm"
          onClick={selectAllFiltered}
          disabled={selectableFiltered.length === 0 || allFilteredSelected}
        >
          Select all filtered
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange([])}
          disabled={selectedIds.length === 0}
        >
          Clear selection
        </Button>
        <span aria-live="polite">
          {filtered.length > DISPLAY_LIMIT
            ? `Showing ${DISPLAY_LIMIT} of ${filtered.length} matches`
            : `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`}
        </span>
      </div>

      <div className="wa-scope-selector__list" role="group" aria-label={`${label} choices`}>
        {shown.length === 0 ? (
          <p className="wa-scope-selector__empty">No synced matches for this profile.</p>
        ) : (
          shown.map((option) => (
            <label className="wa-scope-selector__option" key={option.id}>
              <Checkbox
                checked={selected.has(option.id)}
                onChange={(event) => toggle(option.id, event.target.checked)}
                data-testid={`${id}-option-${option.id}`}
              />
              <span>
                <b>{option.label}</b>
                <small>
                  {option.secondary}
                  {option.available ? '' : ' · no longer in current sync'}
                </small>
              </span>
            </label>
          ))
        )}
      </div>
    </section>
  );
}

function ManualIdAdder({
  id,
  label,
  value,
  onChange,
  onAdd,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onAdd: (value: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id} hint="Use only when the entity is missing from the current sync.">
      <div className="wa-experiment-manual-add">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            onAdd(value);
          }}
        />
        <Button size="sm" onClick={() => onAdd(value)} disabled={value.trim() === ''}>
          Add
        </Button>
      </div>
    </Field>
  );
}

export function NewExperimentForm({
  profiles,
  selectedProfileId,
  prefillName,
  scope,
  initialScopeOptions,
}: {
  profiles: ProfileOption[];
  selectedProfileId: string | null;
  prefillName: string;
  scope: PrefilledScope;
  initialScopeOptions: ExperimentScopeOptions;
}) {
  const initialProfileId = selectedProfileId ?? profiles[0]?.id ?? '';
  const [profileId, setProfileId] = useState(initialProfileId);
  const [name, setName] = useState(prefillName);
  const [type, setType] = useState<(typeof EXPERIMENT_TYPE_OPTIONS)[number]>('bid_push');
  const [metric, setMetric] = useState<(typeof EXPERIMENT_METRIC_OPTIONS)[number]>('sales');
  const [hypothesis, setHypothesis] = useState('');
  const [campaignIds, setCampaignIds] = useState(cleanList(scope.campaignIds));
  const [asins, setAsins] = useState(cleanList(scope.asins));
  const [adGroups, setAdGroups] = useState(scope.adGroupIds.join(', '));
  const [targets, setTargets] = useState(scope.targetIds.join(', '));
  const [terms, setTerms] = useState(scope.searchTerms.join(', '));
  const [manualCampaign, setManualCampaign] = useState('');
  const [manualAsin, setManualAsin] = useState('');
  const [scopeOptions, setScopeOptions] = useState(initialScopeOptions);
  const [scopeOptionsProfileId, setScopeOptionsProfileId] = useState<string | null>(
    initialProfileId || null,
  );
  const [scopeOptionsStatus, setScopeOptionsStatus] = useState<'ready' | 'loading' | 'error'>(
    'ready',
  );
  const [scopeOptionsMessage, setScopeOptionsMessage] = useState('');
  const [scopeReloadKey, setScopeReloadKey] = useState(0);
  const [startNow, setStartNow] = useState(true);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const scopeRequestId = useRef(0);

  useEffect(() => setReady(true), []);

  useEffect(() => {
    if (profileId === '') {
      setScopeOptions({ campaigns: [], products: [] });
      setScopeOptionsProfileId(null);
      setScopeOptionsStatus('ready');
      setScopeOptionsMessage('');
      return;
    }
    if (scopeOptionsProfileId === profileId && scopeOptionsStatus === 'ready') return;
    if (scopeOptionsStatus === 'error') return;

    const controller = new AbortController();
    const requestId = scopeRequestId.current;
    setScopeOptionsStatus('loading');
    setScopeOptionsMessage('Loading synced scope options…');
    void fetch(`/api/experiments/scope-options?profile=${encodeURIComponent(profileId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (ExperimentScopeOptions & { error?: string })
          | null;
        if (!response.ok || payload === null) {
          throw new Error(payload?.error ?? 'Could not load synced scope options');
        }
        if (controller.signal.aborted || requestId !== scopeRequestId.current) return;
        setScopeOptions({ campaigns: payload.campaigns, products: payload.products });
        setScopeOptionsProfileId(profileId);
        setScopeOptionsStatus('ready');
        setScopeOptionsMessage('');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestId !== scopeRequestId.current) return;
        setScopeOptions({ campaigns: [], products: [] });
        setScopeOptionsProfileId(null);
        setScopeOptionsStatus('error');
        setScopeOptionsMessage(
          error instanceof Error ? error.message : 'Could not load synced scope options',
        );
      });
    return () => controller.abort();
  }, [profileId, scopeOptionsProfileId, scopeOptionsStatus, scopeReloadKey]);

  const changeProfile = (nextProfileId: string) => {
    if (nextProfileId === profileId) return;
    // Profile-bound scope and its labels move as one state transition. This
    // prevents a new profile heading from ever painting above old selections.
    scopeRequestId.current += 1;
    setProfileId(nextProfileId);
    setCampaignIds([]);
    setAsins([]);
    setAdGroups('');
    setTargets('');
    setTerms('');
    setManualCampaign('');
    setManualAsin('');
    setScopeOptions({ campaigns: [], products: [] });
    setScopeOptionsProfileId(null);
    setScopeOptionsStatus(nextProfileId === '' ? 'ready' : 'loading');
    setScopeOptionsMessage(nextProfileId === '' ? '' : 'Loading synced scope options…');
  };

  const retryScopeOptions = () => {
    scopeRequestId.current += 1;
    setScopeOptions({ campaigns: [], products: [] });
    setScopeOptionsProfileId(null);
    setScopeOptionsStatus('loading');
    setScopeOptionsMessage('Loading synced scope options…');
    setScopeReloadKey((key) => key + 1);
  };

  const addManual = (
    value: string,
    current: readonly string[],
    update: (values: string[]) => void,
    clear: () => void,
  ) => {
    const additions = toList(value);
    if (additions.length === 0) return;
    update(cleanList([...current, ...additions]));
    clear();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (scopeOptionsStatus !== 'ready' || scopeOptionsProfileId !== profileId) return;
    setPending(true);
    setMessage('Creating experiment…');
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
              campaignIds,
              adGroupIds: toList(adGroups),
              targetIds: toList(targets),
              asins,
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
    <main className="wa-experiment-create" data-interactive={ready ? 'true' : 'false'}>
      <header className="wa-page-head wa-experiment-create__head">
        <div>
          <span className="wa-eyebrow">Experiment tracker</span>
          <h1 className="wa-page-title">Plan an experiment</h1>
          <p className="wa-page-sub">
            Define the change and how success will be measured. Scope is optional; leave it empty
            to measure the whole profile.
          </p>
        </div>
      </header>

      {profiles.length === 0 ? (
        <Banner tone="warn" role="alert">
          Connect and sync an advertising profile before creating an experiment.
        </Banner>
      ) : null}
      {message === '' ? null : (
        <Banner tone={pending ? 'warn' : 'bad'} role={pending ? 'status' : 'alert'}>
          {message}
        </Banner>
      )}

      <form onSubmit={submit} className="wa-experiment-create__form">
        <Card
          title="Test setup"
          subtitle="Name the test, choose the active profile, and define the outcome that matters."
        >
          <div className="wa-experiment-create__setup-grid">
            <Field label="Experiment name" htmlFor="experiment-name" grow>
              <Input
                id="experiment-name"
                required
                maxLength={200}
                value={name}
                data-testid="experiment-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="Example: Raise exact-match bid on priority query"
              />
            </Field>
            <Field label="Profile" htmlFor="experiment-profile">
              <Select
                id="experiment-profile"
                required
                value={profileId}
                data-testid="experiment-profile"
                onChange={(event) => changeProfile(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label} · {profile.countryCode}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Test type" htmlFor="experiment-type">
              <Select
                id="experiment-type"
                value={type}
                data-testid="experiment-type"
                onChange={(event) => setType(event.target.value as typeof type)}
              >
                {EXPERIMENT_TYPE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {TYPE_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Primary metric" htmlFor="experiment-metric">
              <Select
                id="experiment-metric"
                value={metric}
                data-testid="experiment-metric"
                onChange={(event) => setMetric(event.target.value as typeof metric)}
              >
                {EXPERIMENT_METRIC_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {METRIC_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="Hypothesis"
            htmlFor="experiment-hypothesis"
            hint="Optional. State what should change and why."
          >
            <Textarea
              id="experiment-hypothesis"
              rows={3}
              value={hypothesis}
              data-testid="experiment-hypothesis"
              onChange={(event) => setHypothesis(event.target.value)}
              placeholder="If we make this change, then… because…"
            />
          </Field>
        </Card>

        <Card
          title="Scope"
          subtitle="Optional. Choose only the entities under test, or leave everything empty for profile-wide tracking."
          className="wa-experiment-create__scope-card"
        >
          {scopeOptionsMessage === '' ? null : (
            <div className="wa-experiment-create__scope-status">
              <Banner
                tone={scopeOptionsStatus === 'loading' ? 'info' : 'bad'}
                role={scopeOptionsStatus === 'loading' ? 'status' : 'alert'}
              >
                {scopeOptionsMessage}
              </Banner>
              {scopeOptionsStatus === 'error' ? (
                <Button size="sm" onClick={retryScopeOptions}>
                  Retry loading
                </Button>
              ) : null}
            </div>
          )}
          <div
            className="wa-experiment-create__scope-grid"
            data-testid="experiment-scope"
            aria-busy={scopeOptionsStatus === 'loading'}
          >
            <SearchableScopeSelector
              key={`campaigns-${profileId}`}
              id="scope-campaigns"
              label="Campaigns"
              hint="Search the active profile by campaign name or Amazon campaign ID."
              searchLabel="Find campaigns"
              options={campaignsFrom(scopeOptions)}
              selectedIds={campaignIds}
              onChange={setCampaignIds}
            />
            <SearchableScopeSelector
              key={`products-${profileId}`}
              id="scope-products"
              label="Products"
              hint="Search advertised products synchronized from Amazon."
              searchLabel="Find products by name, SKU, or ASIN"
              options={productsFrom(scopeOptions)}
              selectedIds={asins}
              onChange={setAsins}
            />
          </div>

          <details className="wa-experiment-create__advanced" data-testid="experiment-scope-advanced">
            <summary>Advanced: manual IDs and additional filters</summary>
            <p>
              These filters are optional. Manual identifiers are for entities that do not appear in
              the current synchronized lists.
            </p>
            <div className="wa-experiment-create__advanced-grid">
              <ManualIdAdder
                id="manual-campaign-id"
                label="Add campaign ID manually"
                value={manualCampaign}
                onChange={setManualCampaign}
                onAdd={(value) =>
                  addManual(value, campaignIds, setCampaignIds, () => setManualCampaign(''))
                }
              />
              <ManualIdAdder
                id="manual-product-asin"
                label="Add ASIN manually"
                value={manualAsin}
                onChange={setManualAsin}
                onAdd={(value) => addManual(value, asins, setAsins, () => setManualAsin(''))}
              />
              <Field
                label="Keyword / target IDs (optional)"
                htmlFor="scope-targets"
                hint="Comma-separated stable Amazon IDs."
              >
                <Input
                  id="scope-targets"
                  value={targets}
                  data-testid="scope-targets"
                  onChange={(event) => setTargets(event.target.value)}
                />
              </Field>
              <Field
                label="Search terms (optional)"
                htmlFor="scope-terms"
                hint="Comma-separated customer search terms."
              >
                <Input
                  id="scope-terms"
                  value={terms}
                  data-testid="scope-terms"
                  onChange={(event) => setTerms(event.target.value)}
                />
              </Field>
              <Field
                label="Ad group IDs (optional)"
                htmlFor="scope-ad-groups"
                hint="Deep-linked ad-group scope is preserved here."
              >
                <Input
                  id="scope-ad-groups"
                  value={adGroups}
                  data-testid="scope-ad-groups"
                  onChange={(event) => setAdGroups(event.target.value)}
                />
              </Field>
            </div>
          </details>
        </Card>

        <Card title="Start status" subtitle="Choose whether the measurement window starts now.">
          <label className="wa-experiment-create__start">
            <Checkbox
              checked={startNow}
              data-testid="experiment-start-now"
              onChange={(event) => setStartNow(event.target.checked)}
            />
            <span>
              <b>Start tracking now</b>
              <small>Turn this off to save the experiment as planned.</small>
            </span>
          </label>
        </Card>

        <footer className="wa-experiment-create__footer">
          <Button
            type="submit"
            variant="primary"
            disabled={
              pending ||
              profileId === '' ||
              scopeOptionsStatus !== 'ready' ||
              scopeOptionsProfileId !== profileId
            }
            data-testid="experiment-submit"
          >
            {pending ? 'Creating…' : startNow ? 'Create and start' : 'Save as planned'}
          </Button>
          <a href="/experiments" className="wa-btn wa-btn--ghost">
            Cancel
          </a>
        </footer>
      </form>
    </main>
  );
}
