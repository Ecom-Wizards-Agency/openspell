#![forbid(unsafe_code)]
#![allow(dead_code)]

mod canonical;

#[cfg(feature = "wp201-internal")]
mod authority_registry;

#[cfg(all(test, feature = "wp201-internal"))]
mod authority_registry_tests;

#[cfg(test)]
mod corruption_tests;

mod crypto;
mod ipc;
mod journal;
mod protocol;
mod records;
mod state;

#[cfg(feature = "wp201-internal")]
mod preparation_v2;

#[cfg(all(test, feature = "wp201-internal"))]
mod preparation_v2_tests;

#[cfg(all(test, feature = "wp201-internal"))]
mod cross_version_tests;

#[cfg(feature = "wp201-internal")]
mod super_lock;

#[cfg(test)]
mod mutation_tests;

#[cfg(test)]
mod policy_matrix_tests;

#[cfg(test)]
mod tests;

#[cfg(feature = "wp201-internal")]
#[doc(hidden)]
pub mod wp201_internal {
    //! Narrow installation-only bridge for WP-201 step 3.

    use std::os::fd::OwnedFd;

    use crate::authority_registry::{
        BootstrapLease, GenerationOneBindings, InstalledPolicy, RegistryGenerationOne,
        RegistryPublicationError, inspect_bootstrap, inspect_generation_one, inspect_policy,
        inspect_registry_seed, installation_expires_at, render_millisecond, revalidate_bootstrap,
        revalidate_generation_one, revalidate_registry_seed, same_clock_path, sample_clock,
        verify_installation_authorization,
    };
    use crate::preparation_v2::{EmptyPreparationJournal, create as create_journal};
    use crate::super_lock::{
        ExpectedOwner, HeldStateRoot, create_and_lock, inspect_empty_root, open_and_lock,
    };

    /// Fixed refusal without caller-controlled diagnostics.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct PreparationRefusal;

    /// Verified exact synthetic deny-live installed policy.
    pub struct InstalledPreparationRootPolicyV1(InstalledPolicy);

    /// Verified immutable synthetic bootstrap with its shared OFD lock retained.
    pub struct PreparationBootstrapLeaseV1(BootstrapLease);

    /// Exact generation-one registry and empty preparation-v2 journal under both locks.
    pub struct FreshPreparationStateRootV1(Box<FreshPreparationStateRootInner>);

    struct FreshPreparationStateRootInner {
        registry: Option<RegistryGenerationOne>,
        journal: Option<EmptyPreparationJournal>,
        state: Option<HeldStateRoot>,
        bootstrap: Option<BootstrapLease>,
    }

    impl FreshPreparationStateRootInner {
        fn release(&mut self, mut after: impl FnMut(ReleaseStage)) {
            drop(self.registry.take());
            after(ReleaseStage::Registry);
            drop(self.journal.take());
            after(ReleaseStage::Journal);
            drop(self.state.take());
            after(ReleaseStage::State);
            drop(self.bootstrap.take());
            after(ReleaseStage::Bootstrap);
        }
    }

    impl Drop for FreshPreparationStateRootInner {
        fn drop(&mut self) {
            self.release(|_| {});
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum ReleaseStage {
        Registry,
        Journal,
        State,
        Bootstrap,
    }

    /// Installation either durably verified or crossed the final-name uncertainty boundary.
    pub enum StateRootInstallationOutcomeV1 {
        Installed(FreshPreparationStateRootV1),
        CommitOutcomeUnknown,
    }

    /// Verify the exact compiled synthetic policy through a consumed descriptor.
    pub fn inspect_installed_preparation_policy(
        policy: OwnedFd,
    ) -> Result<InstalledPreparationRootPolicyV1, PreparationRefusal> {
        inspect_policy(policy, ExpectedOwner::root())
            .map(InstalledPreparationRootPolicyV1)
            .map_err(|()| PreparationRefusal)
    }

    /// Verify and retain the immutable source bootstrap's shared-lock lease.
    pub fn inspect_preparation_bootstrap(
        policy: InstalledPreparationRootPolicyV1,
        synthetic_proof_bootstrap_root: OwnedFd,
    ) -> Result<PreparationBootstrapLeaseV1, PreparationRefusal> {
        inspect_bootstrap(
            policy.0,
            synthetic_proof_bootstrap_root,
            ExpectedOwner::root(),
        )
        .map(PreparationBootstrapLeaseV1)
        .map_err(|()| PreparationRefusal)
    }

    /// Install the exact empty v2 root and signed generation-one registry.
    pub fn install_preparation_state_root(
        bootstrap: PreparationBootstrapLeaseV1,
        empty_state_root: OwnedFd,
        registry_signing_key: OwnedFd,
        trusted_clock_procfs_root: OwnedFd,
        installation_authorization_bytes: &[u8],
        installation_authorization_signature: &[u8; 64],
    ) -> Result<StateRootInstallationOutcomeV1, PreparationRefusal> {
        install_with_owner(
            bootstrap.0,
            empty_state_root,
            registry_signing_key,
            trusted_clock_procfs_root,
            installation_authorization_bytes,
            installation_authorization_signature,
            ExpectedOwner::root(),
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn install_owned(
        bootstrap: BootstrapLease,
        empty_state_root: OwnedFd,
        registry_signing_key: OwnedFd,
        trusted_clock_procfs_root: OwnedFd,
        authorization_bytes: &[u8],
        authorization_signature: &[u8; 64],
        uid: u32,
        gid: u32,
    ) -> Result<StateRootInstallationOutcomeV1, PreparationRefusal> {
        install_with_owner(
            bootstrap,
            empty_state_root,
            registry_signing_key,
            trusted_clock_procfs_root,
            authorization_bytes,
            authorization_signature,
            ExpectedOwner::for_test(uid, gid),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn install_with_owner(
        bootstrap: BootstrapLease,
        empty_state_root: OwnedFd,
        registry_signing_key: OwnedFd,
        trusted_clock_procfs_root: OwnedFd,
        authorization_bytes: &[u8],
        authorization_signature: &[u8; 64],
        expected_owner: ExpectedOwner,
    ) -> Result<StateRootInstallationOutcomeV1, PreparationRefusal> {
        revalidate_bootstrap(&bootstrap).map_err(|()| PreparationRefusal)?;
        let owner = inspect_empty_root(&empty_state_root, expected_owner)
            .map_err(|()| PreparationRefusal)?;
        let root_identity = crate::super_lock::state_root_identity(&empty_state_root, owner)
            .map_err(|()| PreparationRefusal)?;
        let signing_key = inspect_registry_seed(registry_signing_key, expected_owner)
            .map_err(|()| PreparationRefusal)?;
        if signing_key.verifying_key_bytes() != bootstrap.policy.registry_key {
            return Err(PreparationRefusal);
        }
        let initial = sample_clock(&trusted_clock_procfs_root).map_err(|()| PreparationRefusal)?;
        let authorization = verify_installation_authorization(
            authorization_bytes,
            authorization_signature,
            &bootstrap,
            &root_identity,
            &signing_key.verifying_key_bytes(),
            initial.realtime,
        )
        .map_err(|()| PreparationRefusal)?;
        let expires = installation_expires_at(&authorization).map_err(|()| PreparationRefusal)?;
        let remaining_ns = (expires - initial.realtime).whole_nanoseconds();
        if remaining_ns <= 0 {
            return Err(PreparationRefusal);
        }
        let deadline = initial
            .boottime_ns
            .checked_add(remaining_ns)
            .ok_or(PreparationRefusal)?;
        let installed_at = render_millisecond(initial.realtime).map_err(|()| PreparationRefusal)?;
        rustix::fs::fsync(&empty_state_root).map_err(|_| PreparationRefusal)?;
        let state = create_and_lock(empty_state_root, owner).map_err(|()| PreparationRefusal)?;
        let journal = match create_journal(&state) {
            Ok(journal) => journal,
            Err(()) => {
                drop(signing_key);
                drop(state);
                drop(bootstrap);
                return Err(PreparationRefusal);
            }
        };
        let bindings = GenerationOneBindings {
            auth_bytes: authorization_bytes,
            auth_signature: authorization_signature,
            bootstrap: &bootstrap,
            held: &state,
            journal: &journal,
            installed_at,
        };
        let registry = match crate::authority_registry::create_generation_one(
            bindings,
            signing_key.signing_key(),
            |pending| {
                revalidate_bootstrap(&bootstrap)?;
                crate::super_lock::revalidate(&state)?;
                crate::preparation_v2::revalidate(&state, &journal)?;
                revalidate_registry_seed(&signing_key)?;
                let final_sample = sample_clock(&trusted_clock_procfs_root)?;
                if final_sample.boot_id != initial.boot_id
                    || !same_clock_path(&initial, &final_sample)
                    || final_sample.boottime_ns < initial.boottime_ns
                    || final_sample.realtime < initial.realtime
                    || final_sample.boottime_ns >= deadline
                {
                    return Err(());
                }
                pending.revalidate()
            },
        ) {
            Ok(registry) => registry,
            Err(RegistryPublicationError::BeforeFinal) => {
                drop(signing_key);
                drop(journal);
                drop(state);
                drop(bootstrap);
                return Err(PreparationRefusal);
            }
            Err(RegistryPublicationError::OutcomeUnknown) => {
                drop(signing_key);
                drop(journal);
                drop(state);
                drop(bootstrap);
                return Ok(StateRootInstallationOutcomeV1::CommitOutcomeUnknown);
            }
        };
        if revalidate_bootstrap(&bootstrap).is_err()
            || crate::super_lock::revalidate(&state).is_err()
            || crate::preparation_v2::revalidate(&state, &journal).is_err()
            || revalidate_generation_one(&registry, &state, &bootstrap, &journal).is_err()
        {
            drop(signing_key);
            drop(registry);
            drop(journal);
            drop(state);
            drop(bootstrap);
            return Ok(StateRootInstallationOutcomeV1::CommitOutcomeUnknown);
        }
        drop(signing_key);
        Ok(StateRootInstallationOutcomeV1::Installed(
            FreshPreparationStateRootV1(Box::new(FreshPreparationStateRootInner {
                registry: Some(registry),
                journal: Some(journal),
                state: Some(state),
                bootstrap: Some(bootstrap),
            })),
        ))
    }

    /// Recover only a complete generation-one registry plus exact empty v2 journal.
    pub fn inspect_fresh_preparation_state_root(
        bootstrap: PreparationBootstrapLeaseV1,
        state_root: OwnedFd,
    ) -> Result<FreshPreparationStateRootV1, PreparationRefusal> {
        inspect_fresh_with_owner(bootstrap.0, state_root, ExpectedOwner::root())
    }

    #[cfg(test)]
    pub(crate) fn inspect_fresh_owned(
        bootstrap: BootstrapLease,
        state_root: OwnedFd,
        uid: u32,
        gid: u32,
    ) -> Result<FreshPreparationStateRootV1, PreparationRefusal> {
        inspect_fresh_with_owner(bootstrap, state_root, ExpectedOwner::for_test(uid, gid))
    }

    fn inspect_fresh_with_owner(
        bootstrap: BootstrapLease,
        state_root: OwnedFd,
        expected_owner: ExpectedOwner,
    ) -> Result<FreshPreparationStateRootV1, PreparationRefusal> {
        revalidate_bootstrap(&bootstrap).map_err(|()| PreparationRefusal)?;
        let state = open_and_lock(state_root, expected_owner).map_err(|()| PreparationRefusal)?;
        crate::journal::storage::require_names(
            &state.root,
            &[
                "AUTHORITY_SUPER_LOCK",
                "AUTHORITY_REGISTRY",
                "PREPARATION_JOURNAL_V2",
            ],
        )
        .map_err(|()| PreparationRefusal)?;
        let journal = crate::preparation_v2::inspect(&state).map_err(|()| PreparationRefusal)?;
        let registry = inspect_generation_one(&state, &bootstrap, &journal)
            .map_err(|()| PreparationRefusal)?;
        crate::super_lock::revalidate(&state).map_err(|()| PreparationRefusal)?;
        crate::preparation_v2::revalidate(&state, &journal).map_err(|()| PreparationRefusal)?;
        revalidate_bootstrap(&bootstrap).map_err(|()| PreparationRefusal)?;
        revalidate_generation_one(&registry, &state, &bootstrap, &journal)
            .map_err(|()| PreparationRefusal)?;
        Ok(FreshPreparationStateRootV1(Box::new(
            FreshPreparationStateRootInner {
                registry: Some(registry),
                journal: Some(journal),
                state: Some(state),
                bootstrap: Some(bootstrap),
            },
        )))
    }

    impl FreshPreparationStateRootV1 {
        /// Test-only observation of the exact retained generation; confers no mutation authority.
        #[cfg(test)]
        pub(crate) fn generation_for_test(&self) -> u64 {
            let inner = &self.0;
            let _ = (
                &inner.bootstrap,
                &inner.state,
                &inner.journal,
                &inner.registry,
            );
            1
        }

        #[cfg(test)]
        pub(crate) fn revalidate_for_test(&self) -> Result<(), PreparationRefusal> {
            let inner = &self.0;
            let bootstrap = inner.bootstrap.as_ref().ok_or(PreparationRefusal)?;
            let state = inner.state.as_ref().ok_or(PreparationRefusal)?;
            let journal = inner.journal.as_ref().ok_or(PreparationRefusal)?;
            let registry = inner.registry.as_ref().ok_or(PreparationRefusal)?;
            revalidate_bootstrap(bootstrap).map_err(|()| PreparationRefusal)?;
            crate::super_lock::revalidate(state).map_err(|()| PreparationRefusal)?;
            crate::preparation_v2::revalidate(state, journal).map_err(|()| PreparationRefusal)?;
            revalidate_generation_one(registry, state, bootstrap, journal)
                .map_err(|()| PreparationRefusal)
        }

        #[cfg(test)]
        pub(crate) fn release_staged_for_test(mut self, mut after: impl FnMut(&'static str)) {
            self.0.release(|stage| {
                after(match stage {
                    ReleaseStage::Registry => "registry",
                    ReleaseStage::Journal => "journal",
                    ReleaseStage::State => "state",
                    ReleaseStage::Bootstrap => "bootstrap",
                });
            });
        }
    }

    #[cfg(test)]
    pub(crate) struct LegacyV1RecoveryProbe {
        store: Option<crate::journal::storage::JournalStore>,
        journal_root: Option<OwnedFd>,
        state: Option<HeldStateRoot>,
    }

    #[cfg(test)]
    impl LegacyV1RecoveryProbe {
        pub(crate) fn release_staged_for_test(mut self, mut after: impl FnMut(&'static str)) {
            drop(self.store.take());
            drop(self.journal_root.take());
            after("journal");
            drop(self.state.take());
            after("state");
        }
    }

    #[cfg(test)]
    impl Drop for LegacyV1RecoveryProbe {
        fn drop(&mut self) {
            drop(self.store.take());
            drop(self.journal_root.take());
            drop(self.state.take());
        }
    }

    #[cfg(test)]
    pub(crate) fn inspect_legacy_v1_recovery_probe(
        state_root: OwnedFd,
        uid: u32,
        gid: u32,
        pinned_public_key: [u8; 32],
    ) -> Result<LegacyV1RecoveryProbe, PreparationRefusal> {
        let expected = ExpectedOwner::for_test(uid, gid);
        let state = crate::super_lock::open_and_lock_untyped_for_test(state_root, expected)
            .map_err(|()| PreparationRefusal)?;
        let journal_root = crate::super_lock::open_directory_any_links(
            &state.root,
            "ROOT_JOURNAL_V1",
            state.owner,
        )
        .map_err(|()| PreparationRefusal)?;
        let retained_journal_root =
            rustix::io::dup(&journal_root).map_err(|_| PreparationRefusal)?;
        let store = crate::journal::storage::JournalStore::open_from_fd(
            journal_root,
            uid,
            gid,
            pinned_public_key,
        )
        .map_err(|_| PreparationRefusal)?;
        crate::super_lock::revalidate_untyped_for_test(&state).map_err(|()| PreparationRefusal)?;
        crate::journal::storage::verify_entry_matches_fd(
            &state.root,
            c"ROOT_JOURNAL_V1",
            &retained_journal_root,
            state.owner.storage(),
            rustix::fs::FileType::Directory,
            0o700,
            4,
        )
        .map_err(|()| PreparationRefusal)?;
        Ok(LegacyV1RecoveryProbe {
            store: Some(store),
            journal_root: Some(retained_journal_root),
            state: Some(state),
        })
    }
}
