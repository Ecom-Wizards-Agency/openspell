/**
 * Private WP-192 Sponsored Products outbox-delivery state.
 *
 * The immutable wake remains in `public.sp_write_outbox`. These `app` schema
 * relations mirror mutable delivery custody and its immutable transition
 * journal for typed database inspection only. Controlled SQL functions remain
 * the sole mutation boundary.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgSchema,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
import { spWriteOutbox } from './sp-writes.js';

const appSchema = pgSchema('app');

export type SpWriteOutboxDeliveryState = 'available' | 'leased' | 'completed';
export type SpWriteOutboxDeliveryEventKind =
  | 'claimed'
  | 'expired_reclaimed'
  | 'renewed'
  | 'deferred'
  | 'completed';
export type SpWriteOutboxDeferReason =
  | 'reservation_busy'
  | 'observation_pending'
  | 'recovery_pending'
  | 'shutdown';

export const spWriteOutboxDeliveryHeads = appSchema.table(
  'sp_write_outbox_delivery_heads',
  {
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    outboxId: uuid('outbox_id').primaryKey(),
    state: text('state').$type<SpWriteOutboxDeliveryState>().notNull(),
    claimEpoch: bigint('claim_epoch', { mode: 'bigint' }).notNull(),
    transitionSequence: bigint('transition_sequence', { mode: 'bigint' }).notNull(),
    claimantId: text('claimant_id'),
    tokenDigest: text('token_digest'),
    claimedAt: ts('claimed_at'),
    leaseExpiresAt: ts('lease_expires_at'),
    availableAt: ts('available_at'),
    attemptCount: bigint('attempt_count', { mode: 'bigint' }).notNull(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_outbox_delivery_heads_outbox_fkey',
      columns: [t.orgId, t.profileId, t.outboxId],
      foreignColumns: [spWriteOutbox.orgId, spWriteOutbox.profileId, spWriteOutbox.outboxId],
    }).onDelete('cascade'),
    unique('sp_write_outbox_delivery_heads_tenant_identity_key').on(
      t.orgId,
      t.profileId,
      t.outboxId,
    ),
    index('sp_write_outbox_delivery_heads_available_idx')
      .on(t.availableAt, t.outboxId)
      .where(sql`${t.state} = 'available'`),
    index('sp_write_outbox_delivery_heads_lease_expiry_idx')
      .on(t.leaseExpiresAt, t.outboxId)
      .where(sql`${t.state} = 'leased'`),
    check(
      'sp_write_outbox_delivery_heads_counters_check',
      sql`${t.claimEpoch} >= 0 and ${t.transitionSequence} >= ${t.claimEpoch} and ${t.attemptCount} = ${t.claimEpoch}`,
    ),
    check(
      'sp_write_outbox_delivery_heads_shape_check',
      sql`(
        ${t.state} = 'available'
        and ${t.availableAt} is not null
        and ${t.claimantId} is null
        and ${t.tokenDigest} is null
        and ${t.claimedAt} is null
        and ${t.leaseExpiresAt} is null
        and ${t.completedAt} is null
      ) or (
        ${t.state} = 'leased'
        and ${t.availableAt} is null
        and ${t.claimantId} is not null
        and ${t.claimantId} = btrim(${t.claimantId})
        and ${t.claimantId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ${t.tokenDigest} is not null
        and ${t.tokenDigest} ~ '^[a-f0-9]{64}$'
        and ${t.claimedAt} is not null
        and ${t.leaseExpiresAt} is not null
        and ${t.leaseExpiresAt} > ${t.claimedAt}
        and ${t.leaseExpiresAt} <= ${t.claimedAt} + interval '300 seconds'
        and ${t.completedAt} is null
      ) or (
        ${t.state} = 'completed'
        and ${t.availableAt} is null
        and ${t.claimantId} is null
        and ${t.tokenDigest} is null
        and ${t.claimedAt} is null
        and ${t.leaseExpiresAt} is null
        and ${t.completedAt} is not null
      )`,
    ),
  ],
);

export const spWriteOutboxDeliveryEvents = appSchema.table(
  'sp_write_outbox_delivery_events',
  {
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    outboxId: uuid('outbox_id').notNull(),
    transitionSequence: bigint('transition_sequence', { mode: 'bigint' }).notNull(),
    claimEpoch: bigint('claim_epoch', { mode: 'bigint' }).notNull(),
    eventKind: text('event_kind').$type<SpWriteOutboxDeliveryEventKind>().notNull(),
    actorClaimantId: text('actor_claimant_id').notNull(),
    actorTokenDigest: text('actor_token_digest').notNull(),
    recordedAt: ts('recorded_at').notNull(),
    claimedAt: ts('claimed_at'),
    leaseExpiresAt: ts('lease_expires_at'),
    availableAt: ts('available_at'),
    completedAt: ts('completed_at'),
    deferReason: text('defer_reason').$type<SpWriteOutboxDeferReason>(),
  },
  (t) => [
    primaryKey({
      name: 'sp_write_outbox_delivery_events_pkey',
      columns: [t.outboxId, t.transitionSequence],
    }),
    foreignKey({
      name: 'sp_write_outbox_delivery_events_head_fkey',
      columns: [t.orgId, t.profileId, t.outboxId],
      foreignColumns: [
        spWriteOutboxDeliveryHeads.orgId,
        spWriteOutboxDeliveryHeads.profileId,
        spWriteOutboxDeliveryHeads.outboxId,
      ],
    }).onDelete('cascade'),
    unique('sp_write_outbox_delivery_events_identity_key').on(
      t.orgId,
      t.profileId,
      t.outboxId,
      t.transitionSequence,
    ),
    check(
      'sp_write_outbox_delivery_events_actor_check',
      sql`${t.transitionSequence} >= 1 and ${t.claimEpoch} >= 1 and ${t.actorClaimantId} = btrim(${t.actorClaimantId}) and ${t.actorClaimantId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${t.actorTokenDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'sp_write_outbox_delivery_events_shape_check',
      sql`(
        ${t.eventKind} in ('claimed', 'expired_reclaimed')
        and ${t.claimedAt} is not null
        and ${t.leaseExpiresAt} is not null
        and ${t.claimedAt} = ${t.recordedAt}
        and ${t.leaseExpiresAt} > ${t.claimedAt}
        and ${t.leaseExpiresAt} <= ${t.claimedAt} + interval '300 seconds'
        and ${t.availableAt} is null
        and ${t.completedAt} is null
        and ${t.deferReason} is null
      ) or (
        ${t.eventKind} = 'renewed'
        and ${t.claimedAt} is not null
        and ${t.leaseExpiresAt} is not null
        and ${t.claimedAt} <= ${t.recordedAt}
        and ${t.leaseExpiresAt} > ${t.recordedAt}
        and ${t.leaseExpiresAt} <= ${t.claimedAt} + interval '300 seconds'
        and ${t.availableAt} is null
        and ${t.completedAt} is null
        and ${t.deferReason} is null
      ) or (
        ${t.eventKind} = 'deferred'
        and ${t.claimedAt} is null
        and ${t.leaseExpiresAt} is null
        and ${t.availableAt} is not null
        and ${t.availableAt} > ${t.recordedAt}
        and ${t.completedAt} is null
        and ${t.deferReason} is not null
        and ${t.deferReason} in (
          'reservation_busy', 'observation_pending', 'recovery_pending', 'shutdown'
        )
      ) or (
        ${t.eventKind} = 'completed'
        and ${t.claimedAt} is null
        and ${t.leaseExpiresAt} is null
        and ${t.availableAt} is null
        and ${t.completedAt} is not null
        and ${t.completedAt} = ${t.recordedAt}
        and ${t.deferReason} is null
      )`,
    ),
  ],
);

export type SpWriteOutboxDeliveryHeadRow = typeof spWriteOutboxDeliveryHeads.$inferSelect;
export type SpWriteOutboxDeliveryEventRow = typeof spWriteOutboxDeliveryEvents.$inferSelect;
