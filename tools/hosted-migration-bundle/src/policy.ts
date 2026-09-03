export interface MigrationPolicyEntry {
  readonly filename: string;
  readonly byteCount: number;
  readonly sha256: string;
}

export interface AdditionPolicyEntry extends MigrationPolicyEntry {
  readonly workPackage: string;
  readonly repositoryPath: string;
}

export interface HostedMigrationBundlePolicy {
  readonly baseline: readonly MigrationPolicyEntry[];
  readonly additions: readonly AdditionPolicyEntry[];
  readonly baselineByteCount: number;
  readonly baselineLastVersion: string;
  readonly baselineLedgerSha256: string;
  readonly bundleByteCount: number;
  readonly bundleLastVersion: string;
  readonly bundleLedgerSha256: string;
}

function migrationPath(filename: string): string {
  return ['supabase', 'migrations', filename].join('/');
}

export const HOSTED_MIGRATION_BUNDLE_POLICY: HostedMigrationBundlePolicy = Object.freeze({
  baseline: Object.freeze([
    { filename: '20260813183448_20260813120000_platform.sql', byteCount: 6553, sha256: 'ff1d2bc7b281c8482476a7076be4fdac300464ddca07d75a10fa398513d4989d' },
    { filename: '20260813183526_20260813120100_tenancy.sql', byteCount: 10673, sha256: 'a46773c3bcf40fff73971aded6cfe8ad4672653b1d1722664f51126835acb538' },
    { filename: '20260813183557_20260813120200_entity_mirror.sql', byteCount: 9278, sha256: '74f7f8c290bafbf951e5df3fb7f398077648ec7fdc6c26d841f0641f897e4c28' },
    { filename: '20260813183644_20260813120300_facts.sql', byteCount: 13797, sha256: 'b4a98f973dfb9f37ce1a4b0f58660c5e96f21613897d4295c4dd04197021c274' },
    { filename: '20260813183720_20260813120400_partition_automation.sql', byteCount: 9613, sha256: 'ae78c0057292b25975225badcef5e16887f5d735ac13dea3d09374bb258285c9' },
    { filename: '20260813183827_20260813120500_sync.sql', byteCount: 15778, sha256: 'e7397db9bfe54a34fc4b3f9ba9e130ae44ba7beaf9aecff000ea80e416a3c630' },
    { filename: '20260813183855_20260813120600_analysis.sql', byteCount: 6677, sha256: '49991b8b0502ae2be712f788d7562e61691abbb3b1b91130ea3ad46d23973aa6' },
    { filename: '20260813183930_20260813120700_writes.sql', byteCount: 6674, sha256: '77d1ad14dc73dc2d0cf7f690bab55c8e9c49594b8a6e8efd8f36805d4e913465' },
    { filename: '20260813183958_20260813120800_product_surface.sql', byteCount: 6728, sha256: 'dce20b147a1123839f6f6411107147d8b85e7d1647b4d664d54f4e3df6c5996e' },
    { filename: '20260813184020_20260813120900_vault_rpcs.sql', byteCount: 4253, sha256: '5fe72fb35b5e20f38ecd0d0ea36b62ff456cc517e0ce3dd398f4ac1a91993869' },
    { filename: '20260814011921_20260813121000_cron.sql', byteCount: 2246, sha256: '4de3d00c5b95cc0b6eadf7556c208c4153b490ac875655406b65e0535f4b24d6' },
    { filename: '20260814012040_20260813121100_reserved_seams.sql', byteCount: 9420, sha256: '994054e36157c6100ee0abfe90af3da9a9a5e4ec6d94da47de2bac93f32e0da0' },
    { filename: '20260814012320_20260814070000_rpc_grants_hardening.sql', byteCount: 1444, sha256: '2851a52ed8f2afb434f36e76346cddb6c46ae499b9d2597078aaab9ac9b60201' },
    { filename: '20260814035854_20260814120000_mcp_api_keys.sql', byteCount: 3359, sha256: '828134913d34f088f1d1480f48704e024364a6fb60f51b08b03f1f58d2a4c052' },
    { filename: '20260814051941_20260814130000_profile_target_total_acos.sql', byteCount: 589, sha256: 'd443056deccafa00a8db4d05c26cf1872bff9c5ad35e65a7f48ea7db24e6521c' },
    { filename: '20260814055804_20260814140000_sync_schedule_variant.sql', byteCount: 1903, sha256: 'eb87e0b084e73c115476be55b0fb1939974e76fd255867bb4f253f773176c19a' },
    { filename: '20260814080742_20260814150000_feedback.sql', byteCount: 9375, sha256: '512305894b42f160b79dcc486ae92840af05f38e164806952768e4c246cbfa04' },
    { filename: '20260814092051_20260814160000_report_request_source.sql', byteCount: 633, sha256: '0a6b0554009a0a0cd249bc71fe0b00b2f6638066f81b1c57b78f9f7ebf522678' },
    { filename: '20260814150715_20260814170000_profile_sync_schedule_prefs.sql', byteCount: 3645, sha256: '4d64c3a5b9a4fd64f4aae126f1623726fad01a0e4ef84db27fb26dde7a8023ef' },
    { filename: '20260814172712_20260814180000_experiments.sql', byteCount: 6932, sha256: 'f78487d3cd0b8e9e373f50a2078abea2e3bc7d389d06578a8655033ca0e24cdc' },
    { filename: '20260814182546_20260814190000_bid_series.sql', byteCount: 1659, sha256: '9bd664fc680d65c2549f90742d66d63296c8d8be4914be4330e5118c2b13dac3' },
    { filename: '20260827070831_invitations.sql', byteCount: 2567, sha256: '33f3e29a8b147773678e7a0307f9de1467a3406f66f37034868c11d5af237426' },
    { filename: '20260827071956_feedback_dedup.sql', byteCount: 3320, sha256: '14669a76b38540982d1494e6e084afea73ea253a75cdd5d141b93027cf83c48e' },
    { filename: '20260827082124_sync_job_types.sql', byteCount: 232, sha256: '17ec750dfc06e2a54032dfc3b0d1fa668e81734242b0847d07d084b6580b7f8a' },
    { filename: '20260827082140_filtered_job_claims.sql', byteCount: 1680, sha256: '2d9acf6a6287be4484fe83dc27cc141df1ef6b40570b0b6c802c770e5fb22180' },
    { filename: '20260827082158_sqp_schedule_payload.sql', byteCount: 3400, sha256: 'bfc8fc4331c6b442f78544814f7d73690e92db8ff4f9e8e181dc3e3d486b11c7' },
    { filename: '20260827082430_integration_connections.sql', byteCount: 5018, sha256: 'd8095e827614e77ab42ed2611949900f20c586c2c238ff0eaafffb6ef49d2148' },
    { filename: '20260827085603_product_economics.sql', byteCount: 1119, sha256: 'a11bdef45fa4e66e3e81535090280fd4a450f010ed965e499afa949d86c9465e' },
    { filename: '20260827085807_keepa_market.sql', byteCount: 1139, sha256: 'c2473c3130e10d160cd70f206f830003819e0242e3e5e89b0b5ec6bcbe9e89dd' },
    { filename: '20260827094639_comparison_report_windows.sql', byteCount: 4297, sha256: '7af8c485f863dd718a01cf96465d78971389c22f2adca62033455b382ba40fc0' },
    { filename: '20260829120000_operator_intelligence_foundations.sql', byteCount: 36981, sha256: 'cc6038aa92434a57182a1981c7ca7ed2225928f393bd0b8b4aab1afbbc5f6ece' },
    { filename: '20260829130000_time_machine_v2.sql', byteCount: 14237, sha256: 'b08d2ca4e097a5f32c907f15bd16155020d89d30350cb35cc49390463dfbef58' },
    { filename: '20260829140000_feature_job_types.sql', byteCount: 622, sha256: 'e0ac64f896b689b38dee30ddf7b5267ade11a98869d9a7a13cb42678cdc0afce' },
    { filename: '20260829150000_spapi_profile_bindings.sql', byteCount: 11063, sha256: '3dc46d96867936047d95dc14ad9973c5ab3fe237f0c4b4ac2868a6ae194cde0e' },
    { filename: '20260829160000_sb_video_report_type.sql', byteCount: 215, sha256: 'c082f5dad8eb2bbcd286fe7d62ecfa53dd7e697c4f318f96be6f8de1feaeb07d' },
    { filename: '20260829160100_sb_video_observed_ingestion.sql', byteCount: 9076, sha256: '5bcd52464c9905c86584790eab0b13394fd40a66f7ab13da42295e549be7f073' },
    { filename: '20260830170000_marketing_stream_correctness.sql', byteCount: 7972, sha256: '6fb46658f7248bf8a4f7da009ad9ae4f94c88f594561f959d697e96d22685e82' },
    { filename: '20260830180000_optimization_weekday_schedules.sql', byteCount: 7868, sha256: 'b6c03a3c7ad44faa9f2596024f6ee64a2fca3de39c03df412c2f464f796d9990' },
    { filename: '20260831100000_unified_reporting_dual_run.sql', byteCount: 15490, sha256: '9f1a09f1150fe4b7b9a08155da7aaacc72fad4b724a49e7f07fc50388f198c40' },
    { filename: '20260901000000_contextual_negative_review_exports.sql', byteCount: 5703, sha256: '0e6b9aa49fab446728ca481af8140e4ba80abf5f181ff998f757a296d769f498' },
    { filename: '20260901010000_authenticated_relation_privilege_hardening.sql', byteCount: 16449, sha256: 'f4721315b409266f94939d7dc1bc1df4af28ee07cdeffe404ec6de5f6df3a8cd' },
  ]),
  additions: Object.freeze([
    { workPackage: 'WP-187', repositoryPath: migrationPath('20260901020000_sp_write_persistence_ledger.sql'), filename: '20260901020000_sp_write_persistence_ledger.sql', byteCount: 179749, sha256: 'd28e2c3630ac4b59732cde8bb7021ae955c9b36f0b58d0567a7751c14259df67' },
    { workPackage: 'WP-192', repositoryPath: migrationPath('20260901030000_sp_write_outbox_delivery.sql'), filename: '20260901030000_sp_write_outbox_delivery.sql', byteCount: 46611, sha256: 'c34fc0a1902abe27f0c33d66c1a083fb32f0fd5df30974baecace674a2219a2c' },
    { workPackage: 'WP-194', repositoryPath: migrationPath('20260901040000_fenced_sync_claims.sql'), filename: '20260901040000_fenced_sync_claims.sql', byteCount: 20101, sha256: 'ec96b16f6c2c487404ee15d24cdf58d40d2d079ed0ed12fd5b12bc7abbcd9bf2' },
    { workPackage: 'WP-195', repositoryPath: migrationPath('20260901050000_recommendation_preview_scopes.sql'), filename: '20260901050000_recommendation_preview_scopes.sql', byteCount: 6379, sha256: 'af126c432ca8d523d7483139de3cbf267f3c1d2c68a14b236f2b171fc3811021' },
    { workPackage: 'WP-196', repositoryPath: migrationPath('20260901060000_recommendation_claim_custody.sql'), filename: '20260901060000_recommendation_claim_custody.sql', byteCount: 114111, sha256: '937fe566de09413df7a7578bcd3889c36d4465b81c6d03ad0a1773ca3cf0cb84' },
  ]),
  baselineByteCount: 279677,
  baselineLastVersion: '20260901010000',
  baselineLedgerSha256: '9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea',
  bundleByteCount: 646628,
  bundleLastVersion: '20260901060000',
  bundleLedgerSha256: 'baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458',
});
