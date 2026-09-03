use std::collections::BTreeMap;

use super::machine::{
    Accounting, Attestation, Effect, EffectKind, EffectReply, MachineError, Observation, Progress,
    ProofRefusal, ProofResult, ResourceCounts, SyntheticProofMachine, VerifiedSyntheticCase,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cut {
    Refusal,
    WrongResult,
    LostResult,
}

#[derive(Debug)]
struct ModelRun {
    result: ProofResult,
    actual: Accounting,
    offered: Vec<EffectKind>,
}

#[derive(Debug, Default)]
struct ModelKernel {
    actual: Accounting,
    offered: Vec<EffectKind>,
}

impl ModelKernel {
    fn offer(&mut self, effect: &Effect) {
        self.actual.effects_offered += 1;
        self.offered.push(effect.kind());
    }

    fn accept(&mut self, effect: &Effect) {
        self.actual.effects_accepted += 1;
        self.actual
            .resources
            .add_for_model(effect.kind().declaration().resources);
    }

    fn refuse(&mut self) {
        self.actual.effects_refused += 1;
    }

    fn start_case(&mut self) {
        self.actual.cases_offered = 1;
        self.actual.cases_accepted = 1;
    }

    fn successful_tape() -> ModelRun {
        let mut machine = SyntheticProofMachine::begin(VerifiedSyntheticCase::sealed_fixture());
        let mut kernel = Self::default();
        kernel.start_case();

        loop {
            let effect = machine.offer().expect("next closed effect");
            kernel.offer(&effect);
            kernel.accept(&effect);
            let kind = effect.kind();
            match machine
                .resolve(effect, EffectReply::Observed(Observation::exact(kind)))
                .expect("legal observation")
            {
                Progress::Advanced => {}
                Progress::Complete(_) => break,
                Progress::Refused(refusal) => panic!("successful tape refused: {refusal}"),
            }
        }

        let result = machine.result().expect("closed success");
        assert_eq!(result.accounting(), kernel.actual);
        ModelRun {
            result,
            actual: kernel.actual,
            offered: kernel.offered,
        }
    }

    fn run_effect_cut(tape: &[EffectKind], cut_index: usize, cut: Cut) -> ModelRun {
        let mut machine = SyntheticProofMachine::begin(VerifiedSyntheticCase::sealed_fixture());
        let mut kernel = Self::default();
        kernel.start_case();

        for (index, expected_kind) in tape.iter().copied().enumerate() {
            let effect = machine.offer().expect("tape effect remains reachable");
            kernel.offer(&effect);
            assert_eq!(effect.kind(), expected_kind, "successful tape drift");

            if index == cut_index {
                let progress = match cut {
                    Cut::Refusal => {
                        kernel.refuse();
                        machine.resolve(effect, EffectReply::Refused)
                    }
                    Cut::WrongResult => {
                        kernel.accept(&effect);
                        machine.resolve(
                            effect,
                            EffectReply::Observed(Observation::with_attestation(
                                expected_kind,
                                Attestation::WrongResult,
                            )),
                        )
                    }
                    Cut::LostResult => {
                        kernel.accept(&effect);
                        kernel.actual.responses_lost += 1;
                        machine.resolve(effect, EffectReply::LostAfterAcceptance)
                    }
                }
                .expect("cut closes without adapter detail");
                assert!(matches!(progress, Progress::Refused(_)));
                break;
            }

            kernel.accept(&effect);
            let progress = machine
                .resolve(
                    effect,
                    EffectReply::Observed(Observation::exact(expected_kind)),
                )
                .expect("successful prefix");
            assert!(matches!(progress, Progress::Advanced));
        }

        assert!(matches!(machine.offer(), Err(MachineError::MachineClosed)));

        ModelRun {
            result: machine.result().expect("cut closes machine"),
            actual: kernel.actual,
            offered: kernel.offered,
        }
    }

    fn run_interruption(tape: &[EffectKind], prefix_len: usize) -> ModelRun {
        let mut machine = SyntheticProofMachine::begin(VerifiedSyntheticCase::sealed_fixture());
        let mut kernel = Self::default();
        kernel.start_case();

        for expected_kind in tape.iter().copied().take(prefix_len) {
            let effect = machine.offer().expect("prefix effect");
            kernel.offer(&effect);
            assert_eq!(effect.kind(), expected_kind, "successful tape drift");
            kernel.accept(&effect);
            machine
                .resolve(
                    effect,
                    EffectReply::Observed(Observation::exact(expected_kind)),
                )
                .expect("successful prefix");
        }
        kernel.actual.interruptions += 1;
        machine.interrupt().expect("interruption closes machine");

        ModelRun {
            result: machine.result().expect("interruption result"),
            actual: kernel.actual,
            offered: kernel.offered,
        }
    }

    fn run_in_flight_interruption(tape: &[EffectKind], cut_index: usize) -> ModelRun {
        let mut machine = SyntheticProofMachine::begin(VerifiedSyntheticCase::sealed_fixture());
        let mut kernel = Self::default();
        kernel.start_case();

        for (index, expected_kind) in tape.iter().copied().enumerate().take(cut_index + 1) {
            let effect = machine.offer().expect("in-flight prefix effect");
            kernel.offer(&effect);
            assert_eq!(effect.kind(), expected_kind, "successful tape drift");
            if index == cut_index {
                kernel.actual.effects_uncertain += 1;
                kernel.actual.interruptions += 1;
                machine.interrupt().expect("in-flight interruption closes");
                break;
            }
            kernel.accept(&effect);
            machine
                .resolve(
                    effect,
                    EffectReply::Observed(Observation::exact(expected_kind)),
                )
                .expect("successful prefix");
        }

        assert!(matches!(machine.offer(), Err(MachineError::MachineClosed)));
        ModelRun {
            result: machine.result().expect("in-flight interruption result"),
            actual: kernel.actual,
            offered: kernel.offered,
        }
    }

    fn run_hostile_observation(
        tape: &[EffectKind],
        effect_kind: EffectKind,
        attestation: Attestation,
    ) -> ModelRun {
        let cut_index = tape
            .iter()
            .position(|kind| *kind == effect_kind)
            .expect("hostile effect appears in successful tape");
        let mut machine = SyntheticProofMachine::begin(VerifiedSyntheticCase::sealed_fixture());
        let mut kernel = Self::default();
        kernel.start_case();

        for expected_kind in tape.iter().copied().take(cut_index + 1) {
            let effect = machine.offer().expect("hostile prefix effect");
            kernel.offer(&effect);
            assert_eq!(effect.kind(), expected_kind, "successful tape drift");
            kernel.accept(&effect);
            let observation = if expected_kind == effect_kind {
                Observation::with_attestation(expected_kind, attestation)
            } else {
                Observation::exact(expected_kind)
            };
            machine
                .resolve(effect, EffectReply::Observed(observation))
                .expect("bounded hostile observation");
        }

        ModelRun {
            result: machine.result().expect("hostile observation closes"),
            actual: kernel.actual,
            offered: kernel.offered,
        }
    }
}

impl ResourceCounts {
    fn add_for_model(&mut self, other: Self) {
        self.durable_intents += other.durable_intents;
        self.namespaces += other.namespaces;
        self.cgroups += other.cgroups;
        self.children += other.children;
        self.descendants += other.descendants;
        self.pidfds += other.pidfds;
        self.execs += other.execs;
        self.processes += other.processes;
        self.protected_processes += other.protected_processes;
        self.resumes += other.resumes;
        self.terminal_children += other.terminal_children;
        self.terminal_descendants += other.terminal_descendants;
        self.terminal_pidfds += other.terminal_pidfds;
        self.empty_cgroups += other.empty_cgroups;
        self.terminal_proofs += other.terminal_proofs;
    }
}

fn expected_lifecycle() -> [EffectKind; 11] {
    [
        EffectKind::PersistLaunchIntent,
        EffectKind::EstablishPrivateNamespaces,
        EffectKind::EstablishExclusiveChildCgroup,
        EffectKind::SpawnStoppedLeaderAndOpenPidfd,
        EffectKind::EstablishPtraceAndDescendantCustody,
        EffectKind::AttestExecsAndMaps,
        EffectKind::AttestProcessProtections,
        EffectKind::ResumeVerifiedProcesses,
        EffectKind::DrainDescendants,
        EffectKind::ObserveTerminalAndEmptyCgroup,
        EffectKind::PersistTerminalProof,
    ]
}

fn assert_recovery_only(run: &ModelRun) {
    assert_eq!(run.result.refusal(), Some(ProofRefusal::RecoveryRequired));
    assert!(run.result.accounting().effect_events_conserve());
}

#[test]
fn legal_transition_table_completes_with_exact_conservation() {
    let run = ModelKernel::successful_tape();
    assert_eq!(run.offered, expected_lifecycle());
    assert!(matches!(run.result, ProofResult::Complete(_)));
    assert!(run.actual.effect_events_conserve());
    assert!(run.actual.resources.is_conserved_success());
    assert_eq!(run.actual.cases_offered, 1);
    assert_eq!(run.actual.cases_accepted, 1);

    let mut durable_predecessor_seen = false;
    for kind in &run.offered {
        let declaration = kind.declaration();
        if !declaration.resources.has_no_runtime_resources() {
            assert!(durable_predecessor_seen);
        }
        if *kind == EffectKind::PersistLaunchIntent {
            assert_eq!(declaration.resources.durable_intents, 1);
            durable_predecessor_seen = true;
        }
        assert_eq!(
            declaration.requires_resume_permit,
            *kind == EffectKind::ResumeVerifiedProcesses
        );
    }
}

#[test]
fn illegal_transitions_never_advance_or_reissue() {
    let mut machine = SyntheticProofMachine::begin(VerifiedSyntheticCase::sealed_fixture());
    let effect = machine.offer().expect("first effect");
    assert!(matches!(
        machine.offer(),
        Err(MachineError::EffectAlreadyInFlight)
    ));

    let substituted = effect.substitute_kind(EffectKind::EstablishPrivateNamespaces);
    assert_eq!(
        machine.resolve(
            substituted,
            EffectReply::Observed(Observation::exact(EffectKind::EstablishPrivateNamespaces,)),
        ),
        Err(MachineError::UnexpectedEffect)
    );
    assert_eq!(
        machine.result().and_then(ProofResult::refusal),
        Some(ProofRefusal::RecoveryRequired)
    );
    assert!(matches!(machine.offer(), Err(MachineError::MachineClosed)));
    assert_eq!(machine.interrupt(), Err(MachineError::MachineClosed));
}

#[test]
fn permit_is_minted_only_after_every_verification_and_consumed_by_resume() {
    let tape = ModelKernel::successful_tape().offered;
    let mut machine = SyntheticProofMachine::begin(VerifiedSyntheticCase::sealed_fixture());

    for expected_kind in tape {
        let effect = machine.offer().expect("next effect");
        assert_eq!(effect.kind(), expected_kind);
        assert_eq!(
            effect.carries_resume_permit(),
            expected_kind == EffectKind::ResumeVerifiedProcesses
        );
        let progress = machine
            .resolve(
                effect,
                EffectReply::Observed(Observation::exact(expected_kind)),
            )
            .expect("exact result");
        if expected_kind == EffectKind::ResumeVerifiedProcesses {
            assert!(matches!(progress, Progress::Advanced));
        }
    }
    assert!(matches!(machine.result(), Some(ProofResult::Complete(_))));
    assert!(matches!(machine.offer(), Err(MachineError::MachineClosed)));
}

#[test]
fn every_fault_wrong_result_and_lost_result_cut_comes_from_successful_tape() {
    let success = ModelKernel::successful_tape();
    for cut_index in 0..success.offered.len() {
        for cut in [Cut::Refusal, Cut::WrongResult, Cut::LostResult] {
            let run = ModelKernel::run_effect_cut(&success.offered, cut_index, cut);
            assert_eq!(run.offered, success.offered[..=cut_index]);
            assert!(run.actual.effect_events_conserve());
            assert_eq!(run.actual.effects_offered as usize, cut_index + 1);

            if cut_index == 0 && cut == Cut::Refusal {
                assert_eq!(
                    run.result.refusal(),
                    Some(ProofRefusal::KernelInvariantUnavailable)
                );
                assert!(run.result.accounting().resources.has_no_runtime_resources());
                assert_eq!(run.result.accounting().resources.durable_intents, 0);
            } else {
                assert_recovery_only(&run);
            }
            assert!(matches!(
                run.result,
                ProofResult::Refused {
                    refusal: _,
                    accounting: _
                }
            ));
        }
    }
}

#[test]
fn every_interruption_boundary_comes_from_successful_tape() {
    let success = ModelKernel::successful_tape();
    for prefix_len in 0..success.offered.len() {
        let run = ModelKernel::run_interruption(&success.offered, prefix_len);
        assert_eq!(run.offered, success.offered[..prefix_len]);
        assert!(run.actual.effect_events_conserve());
        if prefix_len == 0 {
            assert_eq!(
                run.result.refusal(),
                Some(ProofRefusal::KernelInvariantUnavailable)
            );
            assert!(run.result.accounting().resources.has_no_runtime_resources());
        } else {
            assert_recovery_only(&run);
        }
    }

    for cut_index in 0..success.offered.len() {
        let run = ModelKernel::run_in_flight_interruption(&success.offered, cut_index);
        assert_eq!(run.offered, success.offered[..=cut_index]);
        assert_eq!(run.result.accounting(), run.actual);
        assert!(run.actual.effect_events_conserve());
        assert_recovery_only(&run);
        if success.offered[cut_index] == EffectKind::ObserveTerminalAndEmptyCgroup {
            assert_eq!(run.result.accounting().resources.terminal_children, 0);
            assert_eq!(run.result.accounting().resources.empty_cgroups, 0);
        }
    }
}

#[test]
fn lost_spawn_response_cannot_spawn_twice_or_recover_the_case() {
    let success = ModelKernel::successful_tape();
    let spawn_index = success
        .offered
        .iter()
        .position(|kind| *kind == EffectKind::SpawnStoppedLeaderAndOpenPidfd)
        .expect("spawn is in successful tape");
    let run = ModelKernel::run_effect_cut(&success.offered, spawn_index, Cut::LostResult);

    assert_recovery_only(&run);
    assert_eq!(
        run.offered
            .iter()
            .filter(|kind| **kind == EffectKind::SpawnStoppedLeaderAndOpenPidfd)
            .count(),
        1
    );
    assert_eq!(run.actual.resources.children, 1);
    assert_eq!(run.actual.resources.pidfds, 1);
    assert_eq!(run.result.accounting().resources.children, 0);
    assert_eq!(run.result.accounting().resources.pidfds, 0);
}

#[test]
fn pre_intent_refusal_is_exact_zero_but_intent_loss_is_recovery_only() {
    let tape = ModelKernel::successful_tape().offered;
    let refused = ModelKernel::run_effect_cut(&tape, 0, Cut::Refusal);
    assert_eq!(
        refused.result.refusal(),
        Some(ProofRefusal::KernelInvariantUnavailable)
    );
    assert_eq!(
        refused.result.accounting().resources,
        ResourceCounts::default()
    );

    let lost = ModelKernel::run_effect_cut(&tape, 0, Cut::LostResult);
    assert_recovery_only(&lost);
    assert_eq!(lost.actual.resources.durable_intents, 1);
    assert_eq!(lost.result.accounting().resources.durable_intents, 0);
    assert!(
        lost.result
            .accounting()
            .resources
            .has_no_runtime_resources()
    );
}

#[test]
fn post_intent_refusals_are_recovery_only_and_never_claim_terminal_resources() {
    let success = ModelKernel::successful_tape();
    for cut_index in 1..success.offered.len() {
        let run = ModelKernel::run_effect_cut(&success.offered, cut_index, Cut::Refusal);
        assert_recovery_only(&run);
        assert_eq!(run.result.accounting().resources.terminal_proofs, 0);
        if success.offered[cut_index] == EffectKind::ObserveTerminalAndEmptyCgroup {
            assert_eq!(run.result.accounting().resources.terminal_children, 0);
            assert_eq!(run.result.accounting().resources.empty_cgroups, 0);
        }
    }
}

#[test]
fn hostile_kernel_observations_are_all_fixed_recovery_outcomes() {
    let tape = ModelKernel::successful_tape().offered;
    let cases = [
        (
            EffectKind::EstablishPtraceAndDescendantCustody,
            Attestation::StaleOrReusedPid,
        ),
        (
            EffectKind::EstablishPtraceAndDescendantCustody,
            Attestation::PidfdLost,
        ),
        (
            EffectKind::EstablishPtraceAndDescendantCustody,
            Attestation::CgroupEscape,
        ),
        (
            EffectKind::EstablishPtraceAndDescendantCustody,
            Attestation::UnexpectedFork,
        ),
        (
            EffectKind::EstablishPtraceAndDescendantCustody,
            Attestation::UnexpectedClone,
        ),
        (
            EffectKind::EstablishPtraceAndDescendantCustody,
            Attestation::UnexpectedVfork,
        ),
        (EffectKind::AttestExecsAndMaps, Attestation::UnexpectedExec),
        (
            EffectKind::AttestExecsAndMaps,
            Attestation::ExecutableReordered,
        ),
        (
            EffectKind::AttestExecsAndMaps,
            Attestation::ExecutableSubstituted,
        ),
        (EffectKind::AttestExecsAndMaps, Attestation::ExtraMapping),
        (EffectKind::AttestExecsAndMaps, Attestation::WritableMapping),
        (EffectKind::AttestExecsAndMaps, Attestation::DeletedMapping),
        (EffectKind::AttestExecsAndMaps, Attestation::HostMapping),
        (
            EffectKind::AttestExecsAndMaps,
            Attestation::NamespaceRootDrift,
        ),
        (
            EffectKind::AttestProcessProtections,
            Attestation::CapabilitiesPresent,
        ),
        (
            EffectKind::AttestProcessProtections,
            Attestation::NoNewPrivilegesMissing,
        ),
        (
            EffectKind::AttestProcessProtections,
            Attestation::CoreLimitNonzero,
        ),
        (
            EffectKind::AttestProcessProtections,
            Attestation::DumpabilityReset,
        ),
        (
            EffectKind::AttestProcessProtections,
            Attestation::SeccompRefusal,
        ),
        (
            EffectKind::ObserveTerminalAndEmptyCgroup,
            Attestation::CleanupAmbiguous,
        ),
    ];

    for (effect, attestation) in cases {
        let run = ModelKernel::run_hostile_observation(&tape, effect, attestation);
        assert_recovery_only(&run);
        assert!(!run.result.accounting().resources.is_conserved_success());
        if effect == EffectKind::AttestProcessProtections {
            assert_eq!(run.result.accounting().resources.resumes, 0);
        }
        if effect == EffectKind::ObserveTerminalAndEmptyCgroup {
            assert_eq!(run.result.accounting().resources.terminal_children, 0);
            assert_eq!(run.result.accounting().resources.empty_cgroups, 0);
        }
    }
}

#[test]
fn effect_and_resource_counts_conserve_at_every_successful_prefix() {
    let success = ModelKernel::successful_tape();
    let mut cumulative = ResourceCounts::default();
    let mut offers_by_kind = BTreeMap::new();

    for kind in &success.offered {
        cumulative.add_for_model(kind.declaration().resources);
        *offers_by_kind.entry(format!("{kind:?}")).or_insert(0_u8) += 1;
    }

    assert_eq!(cumulative, success.actual.resources);
    assert!(cumulative.is_conserved_success());
    assert_eq!(offers_by_kind.len(), success.offered.len());
    assert!(offers_by_kind.values().all(|count| *count == 1));
}

#[test]
fn refusals_and_transition_errors_have_only_fixed_privacy_safe_text() {
    let refusals = [
        ProofRefusal::SourceUnavailable,
        ProofRefusal::SourceMismatch,
        ProofRefusal::ArchiveRejected,
        ProofRefusal::RetentionUncertain,
        ProofRefusal::RuntimeMismatch,
        ProofRefusal::TicketMismatch,
        ProofRefusal::KernelInvariantUnavailable,
        ProofRefusal::TopologyMismatch,
        ProofRefusal::ProcessProtectionFailed,
        ProofRefusal::RecoveryRequired,
        ProofRefusal::CleanupUncertain,
    ];
    let errors = [
        MachineError::EffectAlreadyInFlight,
        MachineError::MachineClosed,
        MachineError::UnexpectedEffect,
        MachineError::InternalInvariant,
    ];
    let canaries = ["/", "=", "pid", "target", "signature", "credential"];

    for text in refusals
        .into_iter()
        .map(|value| value.to_string())
        .chain(errors.into_iter().map(|value| value.to_string()))
    {
        assert!(text.is_ascii());
        assert!(text.len() <= 32);
        for canary in canaries {
            assert!(!text.contains(canary), "fixed refusal leaked {canary}");
        }
    }
}

#[test]
fn resume_permit_has_no_clone_or_copy_implementation() {
    let source = include_str!("machine.rs");
    assert!(!source.contains("impl Clone for ResumePermit"));
    assert!(!source.contains("impl Copy for ResumePermit"));
    let permit_declaration = source
        .split("pub(crate) struct ResumePermit")
        .nth(1)
        .expect("resume permit declaration");
    let preceding = source
        .split("pub(crate) struct ResumePermit")
        .next()
        .expect("source prefix")
        .lines()
        .rev()
        .take(2)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!preceding.contains("Clone"));
    assert!(!preceding.contains("Copy"));
    assert!(permit_declaration.contains("OneUseSeal"));
}
