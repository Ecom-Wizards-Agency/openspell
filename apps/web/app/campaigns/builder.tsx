'use client';

/** Guided campaign planning, preflight, and export-only bulksheet handoff. */
import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  BIDDING_STRATEGIES,
  CAMPAIGN_TYPE_GOALS,
  NAMING_VARIABLES,
  type BulkRow,
} from '@wizard-ads/campaigns';
import type {
  CampaignBuilderMode,
  CampaignBuilderPreview,
} from '../../src/campaigns/artifact';
import {
  CREATE_RECIPES,
  UPDATE_RECIPES,
  createConfigFromGuide,
  defaultCreateGuide,
  defaultUpdateGuide,
  previewCreateNames,
  selectCreateRecipe,
  updateConfigFromGuide,
  validateCreateGuide,
  validateUpdateGuide,
  type CreateGuideState,
  type UpdateGuideState,
} from '../../src/campaigns/guided';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Select,
  TableFrame,
  Textarea,
} from '../../src/ui/primitives';

export interface CampaignBuilderProps {
  profileId: string | null;
  profileLabel: string;
  marketplace: string;
}

const ID_COLUMNS = [
  'Keyword ID',
  'Product Targeting ID',
  'Ad ID',
  'Ad Group ID',
  'Campaign ID',
] as const;

const CONTROL_COLUMNS = new Set([
  'Product',
  'Entity',
  'Operation',
  ...ID_COLUMNS,
]);

const recipeGrid: CSSProperties = {
  display: 'grid',
  gap: '0.625rem',
  gridTemplateColumns: 'repeat(auto-fit, minmax(10.5rem, 1fr))',
};

const selectedRecipe: CSSProperties = {
  background: 'var(--wa-indigo-soft)',
  borderColor: 'var(--wa-info-border)',
  color: 'var(--wa-text)',
};

const namePreview: CSSProperties = {
  background: 'var(--wa-surface-2)',
  border: '1px solid var(--wa-border)',
  borderRadius: 'var(--wa-radius)',
  padding: '0.75rem',
};

export function updateRowId(row: BulkRow): string {
  for (const column of ID_COLUMNS) {
    const value = String(row[column] ?? '').trim();
    if (value) return value;
  }
  return '—';
}

export function updateRowDetails(row: BulkRow): string {
  const values = Object.entries(row)
    .filter(([column, value]) => !CONTROL_COLUMNS.has(column) && String(value).trim() !== '')
    .map(([column, value]) => `${column}: ${String(value)}`);
  return values.join(' · ') || 'ID-only archive';
}

function responseFilename(response: Response): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'campaign-bulk.xlsx';
}

function CreateRecipePicker({
  state,
  onChange,
}: {
  state: CreateGuideState;
  onChange: (state: CreateGuideState) => void;
}): ReactNode {
  return (
    <div style={recipeGrid} aria-label="Creation recipe">
      {CREATE_RECIPES.map((recipe) => (
        <Button
          key={recipe.id}
          aria-pressed={state.recipe === recipe.id}
          onClick={() => onChange(selectCreateRecipe(state, recipe.id))}
          style={{
            ...(state.recipe === recipe.id ? selectedRecipe : undefined),
            alignItems: 'flex-start',
            flexDirection: 'column',
            minHeight: '4.75rem',
            padding: '0.625rem 0.75rem',
            textAlign: 'left',
            whiteSpace: 'normal',
          }}
        >
          <strong>{recipe.label}</strong>
          <span className="wa-hint">{recipe.description}</span>
        </Button>
      ))}
    </div>
  );
}

function CreateFields({
  state,
  onChange,
}: {
  state: CreateGuideState;
  onChange: (state: CreateGuideState) => void;
}): ReactNode {
  const recipe = CREATE_RECIPES.find((candidate) => candidate.id === state.recipe)
    ?? CREATE_RECIPES[0]!;
  const update = <Key extends keyof CreateGuideState>(key: Key, value: CreateGuideState[Key]) => {
    onChange({ ...state, [key]: value });
  };
  return (
    <div className="wa-stack" style={{ gap: '0.75rem' }}>
      <div className="wa-grid-2">
        <Field label="Product name" htmlFor="campaign-product" hint="Used in generated names.">
          <Input
            id="campaign-product"
            value={state.productName}
            onChange={(event) => update('productName', event.target.value)}
            placeholder="e.g. Travel mug"
          />
        </Field>
        <Field label="Target descriptor" htmlFor="campaign-descriptor" hint="A short theme such as core, category, or long-tail.">
          <Input
            id="campaign-descriptor"
            value={state.targetDescriptor}
            onChange={(event) => update('targetDescriptor', event.target.value)}
            placeholder="e.g. long-tail"
          />
        </Field>
        <Field label="Goal" htmlFor="campaign-goal">
          <Select id="campaign-goal" value={state.goal} onChange={(event) => update('goal', event.target.value)}>
            {CAMPAIGN_TYPE_GOALS[state.recipe].map((goal) => <option key={goal}>{goal}</option>)}
          </Select>
        </Field>
        <Field label="Initial state" htmlFor="campaign-state" hint="Paused is the safe default for every exported create row.">
          <Select
            id="campaign-state"
            value={state.state}
            onChange={(event) => update('state', event.target.value as CreateGuideState['state'])}
          >
            <option value="paused">Paused</option>
            <option value="enabled">Enabled in upload file</option>
          </Select>
        </Field>
      </div>
      <div className="wa-grid-2">
        <Field label="Seller SKU" htmlFor="campaign-sku" hint="One SKU per line. These become Product Ad rows.">
          <Textarea
            id="campaign-sku"
            rows={5}
            value={state.sku}
            onChange={(event) => update('sku', event.target.value)}
            placeholder={'SKU-ONE\nSKU-TWO'}
          />
        </Field>
        {state.recipe === 'Auto' ? (
          <div style={namePreview}>
            <strong>Automatic targeting</strong>
            <p className="wa-hint" style={{ margin: '0.25rem 0 0' }}>
              The existing campaign engine creates close match, loose match, substitutes, and complements.
            </p>
          </div>
        ) : (
          <Field label={recipe.inputLabel} htmlFor="campaign-targets" hint={recipe.inputHint}>
            <Textarea
              id="campaign-targets"
              rows={5}
              value={state.targets}
              onChange={(event) => update('targets', event.target.value)}
              placeholder={state.recipe === 'PAT' ? 'B000000001' : 'synthetic keyword'}
            />
          </Field>
        )}
      </div>
      <div className="wa-grid-2">
        <Field label="Daily budget" htmlFor="campaign-budget" hint="Written to the export; no spend starts here.">
          <Input
            id="campaign-budget"
            type="number"
            min="1"
            step="0.01"
            value={state.dailyBudget}
            onChange={(event) => update('dailyBudget', event.target.value)}
          />
        </Field>
        <Field label="Default bid" htmlFor="campaign-bid">
          <Input
            id="campaign-bid"
            type="number"
            min="0.02"
            step="0.01"
            value={state.keywordBid}
            onChange={(event) => update('keywordBid', event.target.value)}
          />
        </Field>
      </div>
    </div>
  );
}

function NamingEditor({
  state,
  today,
  onChange,
}: {
  state: CreateGuideState;
  today: string;
  onChange: (state: CreateGuideState) => void;
}): ReactNode {
  const names = previewCreateNames(state, today);
  const updateOrder = (variableOrder: string[]) => onChange({ ...state, variableOrder });
  const move = (index: number, direction: -1 | 1) => {
    const next = [...state.variableOrder];
    const destination = index + direction;
    if (destination < 0 || destination >= next.length) return;
    [next[index], next[destination]] = [next[destination] as string, next[index] as string];
    updateOrder(next);
  };
  return (
    <div className="wa-stack" style={{ gap: '0.75rem' }}>
      <div>
        <span className="wa-label">Name tokens · order matters</span>
        <div className="wa-row" style={{ marginTop: '0.375rem' }} data-testid="campaign-name-tokens">
          {state.variableOrder.map((token, index) => (
            <span key={`${token}-${index}`} className="wa-pill">
              <span>{index + 1}. {token}</span>
              <button
                type="button"
                aria-label={`Move ${token} left`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                style={{ background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}
              >←</button>
              <button
                type="button"
                aria-label={`Move ${token} right`}
                disabled={index === state.variableOrder.length - 1}
                onClick={() => move(index, 1)}
                style={{ background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}
              >→</button>
              <button
                type="button"
                aria-label={`Remove ${token}`}
                onClick={() => updateOrder(state.variableOrder.filter((_, item) => item !== index))}
                style={{ background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}
              >×</button>
            </span>
          ))}
        </div>
      </div>
      <div>
        <span className="wa-label">Add token</span>
        <div className="wa-row" style={{ marginTop: '0.375rem' }}>
          {NAMING_VARIABLES.filter((token) => !state.variableOrder.includes(token)).map((token) => (
            <Button
              key={token}
              size="sm"
              variant="ghost"
              onClick={() => updateOrder([...state.variableOrder, token])}
            >+ {token}</Button>
          ))}
        </div>
      </div>
      <div className="wa-grid-2">
        <Field label="Delimiter" htmlFor="campaign-delimiter">
          <Input
            id="campaign-delimiter"
            value={state.delimiter}
            onChange={(event) => onChange({ ...state, delimiter: event.target.value })}
          />
        </Field>
        <Field label="Suffix token value" htmlFor="campaign-suffix">
          <Input
            id="campaign-suffix"
            value={state.suffix}
            onChange={(event) => onChange({ ...state, suffix: event.target.value })}
          />
        </Field>
      </div>
      <div style={namePreview} aria-live="polite" data-testid="campaign-name-preview">
        <span className="wa-label">Live engine preview</span>
        {names.length === 0 ? (
          <p className="wa-hint" style={{ margin: '0.25rem 0 0' }}>Add the recipe inputs to preview a generated name.</p>
        ) : (
          <>
            {names.slice(0, 3).map((name) => (
              <code key={name} style={{ display: 'block', marginTop: '0.375rem', overflowWrap: 'anywhere' }}>{name}</code>
            ))}
            {names.length > 3 ? <p className="wa-hint" style={{ margin: '0.375rem 0 0' }}>+ {names.length - 3} more names</p> : null}
          </>
        )}
      </div>
    </div>
  );
}

function UpdateRecipePicker({
  state,
  onChange,
}: {
  state: UpdateGuideState;
  onChange: (state: UpdateGuideState) => void;
}): ReactNode {
  return (
    <div style={recipeGrid} aria-label="Update recipe">
      {UPDATE_RECIPES.map((recipe) => (
        <Button
          key={recipe.id}
          aria-pressed={state.recipe === recipe.id}
          onClick={() => onChange({ ...defaultUpdateGuide(), recipe: recipe.id })}
          style={{
            ...(state.recipe === recipe.id ? selectedRecipe : undefined),
            alignItems: 'flex-start',
            flexDirection: 'column',
            minHeight: '4.75rem',
            padding: '0.625rem 0.75rem',
            textAlign: 'left',
            whiteSpace: 'normal',
          }}
        >
          <strong>{recipe.label}</strong>
          <span className="wa-hint">{recipe.description}</span>
        </Button>
      ))}
    </div>
  );
}

function StateSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Leave unchanged</option>
      <option value="paused">Paused</option>
      <option value="enabled">Enabled</option>
    </Select>
  );
}

function UpdateFields({
  state,
  onChange,
}: {
  state: UpdateGuideState;
  onChange: (state: UpdateGuideState) => void;
}): ReactNode {
  const update = <Key extends keyof UpdateGuideState>(key: Key, value: UpdateGuideState[Key]) => {
    onChange({ ...state, [key]: value });
  };
  if (state.recipe === 'archive-campaigns') {
    return (
      <Field label="Campaign IDs" htmlFor="update-ids" hint="One numeric Amazon ID per line. Child archives are deduplicated by the diff engine.">
        <Textarea id="update-ids" rows={5} value={state.ids} onChange={(event) => update('ids', event.target.value)} />
      </Field>
    );
  }
  if (state.recipe === 'campaign') {
    return (
      <div className="wa-stack" style={{ gap: '0.75rem' }}>
        <div className="wa-grid-2">
          <Field label="Campaign ID" htmlFor="update-campaign-id" hint="Numeric ID from this profile’s synced mirror.">
            <Input id="update-campaign-id" inputMode="numeric" value={state.campaignId} onChange={(event) => update('campaignId', event.target.value)} />
          </Field>
          <Field label="Daily budget" htmlFor="update-amount" hint="Leave blank to keep the current value.">
            <Input id="update-amount" type="number" min="1" step="0.01" value={state.amount} onChange={(event) => update('amount', event.target.value)} />
          </Field>
          <Field label="Campaign name" htmlFor="update-name">
            <Input id="update-name" value={state.name} onChange={(event) => update('name', event.target.value)} placeholder="Leave unchanged" />
          </Field>
          <Field label="State" htmlFor="update-state">
            <StateSelect id="update-state" value={state.state} onChange={(value) => update('state', value)} />
          </Field>
          <Field label="Bidding strategy" htmlFor="update-bidding">
            <Select id="update-bidding" value={state.biddingStrategy} onChange={(event) => update('biddingStrategy', event.target.value)}>
              <option value="">Leave unchanged</option>
              {BIDDING_STRATEGIES.map((strategy) => <option key={strategy}>{strategy}</option>)}
            </Select>
          </Field>
          <Field label="End date" htmlFor="update-end-date" hint="Leave blank to keep the current date.">
            <Input id="update-end-date" type="date" disabled={state.clearEndDate} value={state.endDate} onChange={(event) => update('endDate', event.target.value)} />
          </Field>
        </div>
        <label className="wa-row" htmlFor="update-clear-date">
          <Checkbox id="update-clear-date" checked={state.clearEndDate} onChange={(event) => update('clearEndDate', event.target.checked)} />
          <span>Explicitly clear the current end date</span>
        </label>
      </div>
    );
  }
  if (state.recipe === 'ad-group') {
    return (
      <div className="wa-grid-2">
        <Field label="Ad group ID" htmlFor="update-ad-group-id">
          <Input id="update-ad-group-id" inputMode="numeric" value={state.adGroupId} onChange={(event) => update('adGroupId', event.target.value)} />
        </Field>
        <Field label="Default bid" htmlFor="update-amount">
          <Input id="update-amount" type="number" min="0.02" step="0.01" value={state.amount} onChange={(event) => update('amount', event.target.value)} />
        </Field>
        <Field label="Ad group name" htmlFor="update-name">
          <Input id="update-name" value={state.name} onChange={(event) => update('name', event.target.value)} placeholder="Leave unchanged" />
        </Field>
        <Field label="State" htmlFor="update-state">
          <StateSelect id="update-state" value={state.state} onChange={(value) => update('state', value)} />
        </Field>
      </div>
    );
  }
  const adding = state.recipe === 'add-keyword' || state.recipe === 'add-target';
  const target = state.recipe === 'add-target';
  return (
    <div className="wa-stack" style={{ gap: '0.75rem' }}>
      <div className="wa-grid-2">
        {adding ? (
          <>
            <Field label="Campaign ID" htmlFor="update-campaign-id">
              <Input id="update-campaign-id" inputMode="numeric" value={state.campaignId} onChange={(event) => update('campaignId', event.target.value)} />
            </Field>
            <Field label="Ad group ID" htmlFor="update-ad-group-id">
              <Input id="update-ad-group-id" inputMode="numeric" value={state.adGroupId} onChange={(event) => update('adGroupId', event.target.value)} />
            </Field>
          </>
        ) : (
          <Field label="Current keyword ID" htmlFor="update-entity-id" hint="The old row is archived; a replacement row keeps its current bid unless overridden.">
            <Input id="update-entity-id" inputMode="numeric" value={state.entityId} onChange={(event) => update('entityId', event.target.value)} />
          </Field>
        )}
        <Field label={target ? 'Target ASIN' : 'Keyword text'} htmlFor="update-text">
          <Input id="update-text" value={state.text} onChange={(event) => update('text', event.target.value)} />
        </Field>
        {target ? null : (
          <Field label="Match type" htmlFor="update-match">
            <Select id="update-match" value={state.matchType} onChange={(event) => update('matchType', event.target.value)}>
              <option value="">{state.recipe === 'replace-keyword' ? 'Keep current' : 'Choose match type'}</option>
              <option value="EXACT">Exact</option>
              <option value="PHRASE">Phrase</option>
              <option value="BROAD">Broad</option>
            </Select>
          </Field>
        )}
        <Field label="Bid" htmlFor="update-amount" hint="Leave blank to use the engine’s existing/default behavior.">
          <Input id="update-amount" type="number" min="0.02" step="0.01" value={state.amount} onChange={(event) => update('amount', event.target.value)} />
        </Field>
        <Field label="State" htmlFor="update-state">
          <StateSelect id="update-state" value={state.state} onChange={(value) => update('state', value)} />
        </Field>
      </div>
      {target ? (
        <label className="wa-row" htmlFor="update-expanded">
          <Checkbox id="update-expanded" checked={state.expanded} onChange={(event) => update('expanded', event.target.checked)} />
          <span>Use expanded ASIN targeting</span>
        </label>
      ) : null}
    </div>
  );
}

function AdvancedJson({
  document,
  active,
  onChange,
  onReset,
  onImport,
  onDownload,
}: {
  document: string;
  active: boolean;
  onChange: (document: string) => void;
  onReset: () => void;
  onImport: (file: File) => Promise<void>;
  onDownload: () => void;
}): ReactNode {
  return (
    <details data-testid="campaign-builder-advanced" style={{ marginTop: '0.25rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Advanced · JSON import, edit, and export</summary>
      <div className="wa-stack" style={{ gap: '0.75rem', marginTop: '0.75rem' }}>
        {active ? (
          <Banner tone="warn" role="status">
            Preflight is using the edited JSON below. Reset to return to the guided fields.
          </Banner>
        ) : (
          <p className="wa-hint" style={{ margin: 0 }}>
            The guided form generates this document. Editing or importing switches preflight to the advanced document.
          </p>
        )}
        <Field label="Campaign plan JSON" hideLabel htmlFor="campaign-builder-json">
          <Textarea
            id="campaign-builder-json"
            data-testid="campaign-builder-json"
            rows={16}
            spellCheck={false}
            value={document}
            onChange={(event) => onChange(event.target.value)}
            style={{ fontFamily: 'var(--wa-font-mono)', lineHeight: 1.5, width: '100%' }}
          />
        </Field>
        <div className="wa-row">
          <label className="wa-btn wa-btn--sm" htmlFor="campaign-json-file" style={{ cursor: 'pointer' }}>
            Import JSON
          </label>
          <input
            id="campaign-json-file"
            className="wa-sr-only"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void onImport(file);
            }}
          />
          <Button size="sm" onClick={onDownload}>Download JSON</Button>
          <Button size="sm" variant="ghost" disabled={!active} onClick={onReset}>Reset to guided form</Button>
        </div>
      </div>
    </details>
  );
}

export function CampaignBuilder({
  profileId,
  profileLabel,
  marketplace,
}: CampaignBuilderProps): ReactNode {
  const [mode, setMode] = useState<CampaignBuilderMode>('update');
  const [createGuide, setCreateGuide] = useState(() => defaultCreateGuide(profileLabel, marketplace));
  const [updateGuide, setUpdateGuide] = useState(defaultUpdateGuide);
  const [advancedDocument, setAdvancedDocument] = useState<string | null>(null);
  const [preview, setPreview] = useState<CampaignBuilderPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'xlsx' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  const guidedConfig = mode === 'create'
    ? createConfigFromGuide(createGuide)
    : updateConfigFromGuide(updateGuide);
  const guidedDocument = useMemo(() => JSON.stringify(guidedConfig, null, 2), [guidedConfig]);
  const document = advancedDocument ?? guidedDocument;
  const validationIssues = advancedDocument === null
    ? mode === 'create'
      ? validateCreateGuide(createGuide, today)
      : validateUpdateGuide(updateGuide)
    : [];

  const clearResult = (): void => {
    setPreview(null);
    setError(null);
  };

  const changeCreate = (state: CreateGuideState): void => {
    setCreateGuide(state);
    clearResult();
  };

  const changeUpdate = (state: UpdateGuideState): void => {
    setUpdateGuide(state);
    clearResult();
  };

  const selectMode = (next: CampaignBuilderMode): void => {
    setMode(next);
    setAdvancedDocument(null);
    clearResult();
  };

  const request = async (output: 'preview' | 'xlsx'): Promise<void> => {
    setError(null);
    if (advancedDocument === null && validationIssues.length > 0) {
      setError(validationIssues[0] ?? 'Complete the required fields.');
      return;
    }
    let config: unknown = guidedConfig;
    if (advancedDocument !== null) {
      try {
        config = JSON.parse(advancedDocument) as unknown;
      } catch {
        setError('Advanced JSON is not valid. Fix it or reset to the guided form.');
        return;
      }
    }
    setBusy(output);
    try {
      const response = await fetch('/api/campaigns/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, output, profileId, config }),
      });
      if (output === 'preview') {
        const body = (await response.json()) as CampaignBuilderPreview | { error?: string };
        if (!response.ok || !('rows' in body)) {
          throw new Error('error' in body && body.error ? body.error : 'Preflight failed');
        }
        setPreview(body);
        return;
      }
      if (!response.ok) {
        const body = (await response.json()) as { error?: string; preview?: CampaignBuilderPreview };
        if (body.preview !== undefined) setPreview(body.preview);
        throw new Error(body.error ?? 'Workbook export failed');
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = responseFilename(response);
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Campaign Builder failed');
    } finally {
      setBusy(null);
    }
  };

  const downloadJson = (): void => {
    const url = URL.createObjectURL(new Blob([document], { type: 'application/json' }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `campaign-${mode}-plan.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const updateWithoutProfile = mode === 'update' && profileId === null;

  return (
    <div className="wa-stack">
      <Banner tone="info" role="status">
        Export-only workflow. Preview creates a plan; download creates a bulksheet. Neither action changes Amazon.
      </Banner>

      <div aria-label="Campaign builder mode" role="tablist" className="wa-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'create'}
          aria-current={mode === 'create' ? 'page' : undefined}
          className="wa-tab wa-tab--btn"
          onClick={() => selectMode('create')}
        >
          Create new
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'update'}
          aria-current={mode === 'update' ? 'page' : undefined}
          className="wa-tab wa-tab--btn"
          onClick={() => selectMode('update')}
        >
          Update existing
        </button>
      </div>

      {updateWithoutProfile ? (
        <EmptyState
          title="Choose a synced profile"
          body="Updates are checked against that profile’s latest synced campaigns, ad groups, keywords, targets, negatives, and product ads."
          action={<a className="wa-btn wa-btn--sm" href="/settings/profiles">Open profiles</a>}
        />
      ) : (
        <>
          <Card
            title={mode === 'create' ? '1. Choose a creation recipe' : '1. Choose one change'}
            subtitle={mode === 'create'
              ? 'Start with a campaign structure. The existing engine handles match type, targeting, and fan-out.'
              : `Every ID is resolved against ${profileLabel} (${marketplace}) before an export can be built.`}
          >
            {mode === 'create' ? (
              <CreateRecipePicker state={createGuide} onChange={changeCreate} />
            ) : (
              <UpdateRecipePicker state={updateGuide} onChange={changeUpdate} />
            )}
          </Card>

          <fieldset disabled={advancedDocument !== null} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
            <Card
              title={mode === 'create' ? '2. Set the campaign details' : '2. Describe the desired change'}
              subtitle={mode === 'create'
                ? 'Required fields stay visible; the generated plan remains paused unless you explicitly choose otherwise.'
                : 'Blank fields mean leave unchanged. Preflight shows only effective differences.'}
            >
              {mode === 'create' ? (
                <CreateFields state={createGuide} onChange={changeCreate} />
              ) : (
                <UpdateFields state={updateGuide} onChange={changeUpdate} />
              )}
            </Card>

            {mode === 'create' ? (
              <Card
                title="3. Build the name"
                subtitle="Choose and order tokens. The live preview uses the same naming and campaign-generation functions as the export."
              >
                <NamingEditor state={createGuide} today={today} onChange={changeCreate} />
              </Card>
            ) : null}
          </fieldset>

          <Card
            title={mode === 'create' ? '4. Review the export' : '3. Review the diff'}
            subtitle="Preflight is the approval boundary: inspect every row before downloading the file."
          >
            <div className="wa-stack" style={{ gap: '0.75rem' }}>
              {advancedDocument === null && validationIssues.length > 0 ? (
                <Banner tone="warn" role="status" data-testid="campaign-validation">
                  {validationIssues.length} field {validationIssues.length === 1 ? 'needs' : 'fields need'} attention. First: {validationIssues[0]}
                </Banner>
              ) : null}
              <div className="wa-row">
                <Button
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => void request('preview')}
                >
                  {busy === 'preview' ? 'Checking…' : mode === 'create' ? 'Preview campaign plan' : 'Preview changes'}
                </Button>
                <Button
                  disabled={busy !== null || preview?.exportable !== true}
                  onClick={() => void request('xlsx')}
                >
                  {busy === 'xlsx' ? 'Building…' : 'Download bulksheet'}
                </Button>
                <span className="wa-hint">Manual upload file · no Amazon API write</span>
              </div>
              <AdvancedJson
                document={document}
                active={advancedDocument !== null}
                onChange={(value) => {
                  setAdvancedDocument(value);
                  clearResult();
                }}
                onReset={() => {
                  setAdvancedDocument(null);
                  clearResult();
                }}
                onImport={async (file) => {
                  setAdvancedDocument(await file.text());
                  clearResult();
                }}
                onDownload={downloadJson}
              />
            </div>
          </Card>
        </>
      )}

      {error === null ? null : <Banner tone="bad" role="alert">{error}</Banner>}

      {preview === null ? null : (
        <Card
          title={mode === 'create' ? 'Campaign plan preview' : 'Preflight diff'}
          subtitle={`${preview.rows.length} bulksheet row(s) · every exported row is shown below`}
          actions={
            <div className="wa-row">
              <Badge tone={preview.ready ? 'good' : 'bad'} dot>
                {preview.ready ? 'Ready to export' : 'Blocked'}
              </Badge>
              <Badge>{preview.counts.update} update</Badge>
              <Badge>{preview.counts.archive} archive</Badge>
              <Badge>{preview.counts.create} create</Badge>
            </div>
          }
          flush
        >
          {preview.issues.length === 0 ? null : (
            <div className="wa-stack" style={{ padding: '1rem 1rem 0' }}>
              {preview.issues.map((issue) => <Banner key={issue} tone="bad">{issue}</Banner>)}
            </div>
          )}
          {preview.notes.length === 0 ? null : (
            <div className="wa-stack" style={{ padding: '1rem 1rem 0' }}>
              {preview.notes.map((note) => <Banner key={note} tone="info">{note}</Banner>)}
            </div>
          )}
          {preview.rows.length === 0 ? (
            <EmptyState
              title="No effective rows"
              body="Every requested change was a no-op, cascade skip, or blocked by preflight. There is no file to download."
            />
          ) : (
            <TableFrame data-testid="campaign-update-rows">
              <table className="wa-table">
                <thead>
                  <tr><th>Action</th><th>Entity</th><th>Amazon / temp ID</th><th>Exported fields</th></tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => (
                    <tr key={`${row.Operation}-${row.Entity}-${updateRowId(row)}-${index}`}>
                      <td>
                        <Badge tone={row.Operation === 'Archive' ? 'bad' : row.Operation === 'Create' ? 'info' : 'warn'}>
                          {row.Operation}
                        </Badge>
                      </td>
                      <td>{row.Entity}</td>
                      <td><code>{updateRowId(row)}</code></td>
                      <td>{updateRowDetails(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
          {preview.review.length === 0 ? null : (
            <details style={{ margin: '1rem' }}>
              <summary style={{ cursor: 'pointer' }}>Plain-English review ({preview.review.length})</summary>
              <ul>
                {preview.review.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
              </ul>
            </details>
          )}
        </Card>
      )}
    </div>
  );
}
