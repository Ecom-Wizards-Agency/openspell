use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProofRefusal {
    SourceUnavailable,
    SourceMismatch,
    ArchiveRejected,
    RetentionUncertain,
    RuntimeMismatch,
    TicketMismatch,
    KernelInvariantUnavailable,
    TopologyMismatch,
    ProcessProtectionFailed,
    RecoveryRequired,
    CleanupUncertain,
}

impl fmt::Display for ProofRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::SourceUnavailable => "source unavailable",
            Self::SourceMismatch => "source mismatch",
            Self::ArchiveRejected => "archive rejected",
            Self::RetentionUncertain => "retention uncertain",
            Self::RuntimeMismatch => "runtime mismatch",
            Self::TicketMismatch => "ticket mismatch",
            Self::KernelInvariantUnavailable => "kernel invariant unavailable",
            Self::TopologyMismatch => "topology mismatch",
            Self::ProcessProtectionFailed => "process protection failed",
            Self::RecoveryRequired => "recovery required",
            Self::CleanupUncertain => "cleanup uncertain",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MachineError {
    EffectAlreadyInFlight,
    MachineClosed,
    UnexpectedEffect,
    InternalInvariant,
}

impl fmt::Display for MachineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::EffectAlreadyInFlight => "effect already in flight",
            Self::MachineClosed => "machine closed",
            Self::UnexpectedEffect => "unexpected effect",
            Self::InternalInvariant => "internal invariant unavailable",
        })
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResourceCounts {
    pub(crate) durable_intents: u8,
    pub(crate) namespaces: u8,
    pub(crate) cgroups: u8,
    pub(crate) children: u8,
    pub(crate) descendants: u8,
    pub(crate) pidfds: u8,
    pub(crate) execs: u8,
    pub(crate) processes: u8,
    pub(crate) protected_processes: u8,
    pub(crate) resumes: u8,
    pub(crate) terminal_children: u8,
    pub(crate) terminal_descendants: u8,
    pub(crate) terminal_pidfds: u8,
    pub(crate) empty_cgroups: u8,
    pub(crate) terminal_proofs: u8,
}

impl ResourceCounts {
    fn add(&mut self, other: Self) -> Result<(), MachineError> {
        macro_rules! checked_add_fields {
            ($($field:ident),+ $(,)?) => {
                $(self.$field = self.$field.checked_add(other.$field)
                    .ok_or(MachineError::InternalInvariant)?;)+
            };
        }

        checked_add_fields!(
            durable_intents,
            namespaces,
            cgroups,
            children,
            descendants,
            pidfds,
            execs,
            processes,
            protected_processes,
            resumes,
            terminal_children,
            terminal_descendants,
            terminal_pidfds,
            empty_cgroups,
            terminal_proofs,
        );
        Ok(())
    }

    pub(crate) fn has_no_runtime_resources(self) -> bool {
        self.namespaces == 0
            && self.cgroups == 0
            && self.children == 0
            && self.descendants == 0
            && self.pidfds == 0
            && self.execs == 0
            && self.processes == 0
            && self.protected_processes == 0
            && self.resumes == 0
            && self.terminal_children == 0
            && self.terminal_descendants == 0
            && self.terminal_pidfds == 0
            && self.empty_cgroups == 0
            && self.terminal_proofs == 0
    }

    pub(crate) fn is_conserved_success(self) -> bool {
        self == SUCCESS_RESOURCES
            && self.processes == self.children + self.descendants
            && self.pidfds == self.processes
            && self.execs == self.processes
            && self.protected_processes == self.processes
            && self.resumes == self.processes
            && self.terminal_children == self.children
            && self.terminal_descendants == self.descendants
            && self.terminal_pidfds == self.pidfds
    }
}

const SUCCESS_RESOURCES: ResourceCounts = ResourceCounts {
    durable_intents: 1,
    namespaces: 7,
    cgroups: 1,
    children: 1,
    descendants: 1,
    pidfds: 2,
    execs: 2,
    processes: 2,
    protected_processes: 2,
    resumes: 2,
    terminal_children: 1,
    terminal_descendants: 1,
    terminal_pidfds: 2,
    empty_cgroups: 1,
    terminal_proofs: 1,
};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Accounting {
    pub(crate) cases_offered: u8,
    pub(crate) cases_accepted: u8,
    pub(crate) effects_offered: u8,
    pub(crate) effects_accepted: u8,
    pub(crate) effects_refused: u8,
    pub(crate) effects_uncertain: u8,
    pub(crate) responses_lost: u8,
    pub(crate) interruptions: u8,
    pub(crate) resources: ResourceCounts,
}

impl Accounting {
    pub(crate) fn effect_events_conserve(self) -> bool {
        self.effects_offered
            == self.effects_accepted + self.effects_refused + self.effects_uncertain
            && self.responses_lost <= self.effects_accepted
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProofSummary {
    pub(crate) accounting: Accounting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProofResult {
    Complete(ProofSummary),
    Refused {
        refusal: ProofRefusal,
        accounting: Accounting,
    },
}

impl ProofResult {
    pub(crate) fn accounting(self) -> Accounting {
        match self {
            Self::Complete(summary) => summary.accounting,
            Self::Refused { accounting, .. } => accounting,
        }
    }

    pub(crate) fn refusal(self) -> Option<ProofRefusal> {
        match self {
            Self::Complete(_) => None,
            Self::Refused { refusal, .. } => Some(refusal),
        }
    }
}

struct CaseSeal(u64);

pub(crate) struct VerifiedSyntheticCase {
    seal: CaseSeal,
    expected: ResourceCounts,
}

#[cfg(test)]
impl VerifiedSyntheticCase {
    pub(crate) fn sealed_fixture() -> Self {
        Self {
            seal: CaseSeal(0x5750_3230_3053_594e),
            expected: SUCCESS_RESOURCES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EffectKind {
    PersistLaunchIntent,
    EstablishPrivateNamespaces,
    EstablishExclusiveChildCgroup,
    SpawnStoppedLeaderAndOpenPidfd,
    EstablishPtraceAndDescendantCustody,
    AttestExecsAndMaps,
    AttestProcessProtections,
    ResumeVerifiedProcesses,
    DrainDescendants,
    ObserveTerminalAndEmptyCgroup,
    PersistTerminalProof,
}

impl EffectKind {
    pub(crate) fn declaration(self) -> EffectDeclaration {
        let resources = match self {
            Self::PersistLaunchIntent => ResourceCounts {
                durable_intents: 1,
                ..ResourceCounts::default()
            },
            Self::EstablishPrivateNamespaces => ResourceCounts {
                namespaces: 6,
                ..ResourceCounts::default()
            },
            Self::EstablishExclusiveChildCgroup => ResourceCounts {
                cgroups: 1,
                ..ResourceCounts::default()
            },
            Self::SpawnStoppedLeaderAndOpenPidfd => ResourceCounts {
                namespaces: 1,
                children: 1,
                pidfds: 1,
                processes: 1,
                ..ResourceCounts::default()
            },
            Self::EstablishPtraceAndDescendantCustody => ResourceCounts {
                descendants: 1,
                pidfds: 1,
                processes: 1,
                ..ResourceCounts::default()
            },
            Self::AttestExecsAndMaps => ResourceCounts {
                execs: 2,
                ..ResourceCounts::default()
            },
            Self::AttestProcessProtections => ResourceCounts {
                protected_processes: 2,
                ..ResourceCounts::default()
            },
            Self::ResumeVerifiedProcesses => ResourceCounts {
                resumes: 2,
                ..ResourceCounts::default()
            },
            Self::DrainDescendants => ResourceCounts {
                terminal_descendants: 1,
                terminal_pidfds: 1,
                ..ResourceCounts::default()
            },
            Self::ObserveTerminalAndEmptyCgroup => ResourceCounts {
                terminal_children: 1,
                terminal_pidfds: 1,
                empty_cgroups: 1,
                ..ResourceCounts::default()
            },
            Self::PersistTerminalProof => ResourceCounts {
                terminal_proofs: 1,
                ..ResourceCounts::default()
            },
        };
        EffectDeclaration {
            resources,
            requires_resume_permit: self == Self::ResumeVerifiedProcesses,
        }
    }

    fn next(self) -> Option<Self> {
        Some(match self {
            Self::PersistLaunchIntent => Self::EstablishPrivateNamespaces,
            Self::EstablishPrivateNamespaces => Self::EstablishExclusiveChildCgroup,
            Self::EstablishExclusiveChildCgroup => Self::SpawnStoppedLeaderAndOpenPidfd,
            Self::SpawnStoppedLeaderAndOpenPidfd => Self::EstablishPtraceAndDescendantCustody,
            Self::EstablishPtraceAndDescendantCustody => Self::AttestExecsAndMaps,
            Self::AttestExecsAndMaps => Self::AttestProcessProtections,
            Self::AttestProcessProtections => Self::ResumeVerifiedProcesses,
            Self::ResumeVerifiedProcesses => Self::DrainDescendants,
            Self::DrainDescendants => Self::ObserveTerminalAndEmptyCgroup,
            Self::ObserveTerminalAndEmptyCgroup => Self::PersistTerminalProof,
            Self::PersistTerminalProof => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EffectDeclaration {
    pub(crate) resources: ResourceCounts,
    pub(crate) requires_resume_permit: bool,
}

struct OneUseSeal(u64);

pub(crate) struct ResumePermit {
    seal: OneUseSeal,
    issuance: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EffectHeader {
    case_seal: u64,
    sequence: u8,
    kind: EffectKind,
}

pub(crate) enum Effect {
    Closed(EffectHeader),
    Resume {
        header: EffectHeader,
        permit: ResumePermit,
    },
}

impl Effect {
    pub(crate) fn kind(&self) -> EffectKind {
        match self {
            Self::Closed(header) | Self::Resume { header, .. } => header.kind,
        }
    }

    fn header(&self) -> EffectHeader {
        match self {
            Self::Closed(header) | Self::Resume { header, .. } => *header,
        }
    }

    pub(crate) fn carries_resume_permit(&self) -> bool {
        matches!(self, Self::Resume { .. })
    }

    fn has_valid_resume_permit(&self) -> bool {
        match self {
            Self::Closed(_) => self.kind() != EffectKind::ResumeVerifiedProcesses,
            Self::Resume { header, permit } => {
                header.kind == EffectKind::ResumeVerifiedProcesses
                    && permit.seal.0 == header.case_seal
                    && permit.issuance == 1
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn substitute_kind(mut self, kind: EffectKind) -> Self {
        match &mut self {
            Self::Closed(header) | Self::Resume { header, .. } => header.kind = kind,
        }
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Attestation {
    Exact,
    WrongResult,
    StaleOrReusedPid,
    PidfdLost,
    CgroupEscape,
    UnexpectedFork,
    UnexpectedClone,
    UnexpectedVfork,
    UnexpectedExec,
    ExecutableReordered,
    ExecutableSubstituted,
    ExtraMapping,
    WritableMapping,
    DeletedMapping,
    HostMapping,
    NamespaceRootDrift,
    CapabilitiesPresent,
    NoNewPrivilegesMissing,
    CoreLimitNonzero,
    DumpabilityReset,
    SeccompRefusal,
    CleanupAmbiguous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Observation {
    pub(crate) effect: EffectKind,
    pub(crate) resources: ResourceCounts,
    pub(crate) attestation: Attestation,
}

impl Observation {
    pub(crate) fn exact(effect: EffectKind) -> Self {
        Self {
            effect,
            resources: effect.declaration().resources,
            attestation: Attestation::Exact,
        }
    }

    pub(crate) fn with_attestation(effect: EffectKind, attestation: Attestation) -> Self {
        Self {
            attestation,
            ..Self::exact(effect)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EffectReply {
    Observed(Observation),
    Refused,
    LostAfterAcceptance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Progress {
    Advanced,
    Complete(ProofSummary),
    Refused(ProofRefusal),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MachineState {
    Ready(EffectKind),
    InFlight(EffectHeader),
    Closed,
}

pub(crate) struct SyntheticProofMachine {
    state: MachineState,
    case_seal: u64,
    expected: ResourceCounts,
    next_sequence: u8,
    resume_permit: Option<ResumePermit>,
    accounting: Accounting,
    result: Option<ProofResult>,
}

impl SyntheticProofMachine {
    pub(crate) fn begin(case: VerifiedSyntheticCase) -> Self {
        Self {
            state: MachineState::Ready(EffectKind::PersistLaunchIntent),
            case_seal: case.seal.0,
            expected: case.expected,
            next_sequence: 0,
            resume_permit: None,
            accounting: Accounting {
                cases_offered: 1,
                cases_accepted: 1,
                ..Accounting::default()
            },
            result: None,
        }
    }

    pub(crate) fn offer(&mut self) -> Result<Effect, MachineError> {
        let kind = match self.state {
            MachineState::Ready(kind) => kind,
            MachineState::InFlight(_) => return Err(MachineError::EffectAlreadyInFlight),
            MachineState::Closed => return Err(MachineError::MachineClosed),
        };
        let header = EffectHeader {
            case_seal: self.case_seal,
            sequence: self.next_sequence,
            kind,
        };
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(MachineError::InternalInvariant)?;
        self.accounting.effects_offered = self
            .accounting
            .effects_offered
            .checked_add(1)
            .ok_or(MachineError::InternalInvariant)?;
        self.state = MachineState::InFlight(header);

        if kind == EffectKind::ResumeVerifiedProcesses {
            let permit = self
                .resume_permit
                .take()
                .ok_or(MachineError::InternalInvariant)?;
            Ok(Effect::Resume { header, permit })
        } else {
            Ok(Effect::Closed(header))
        }
    }

    pub(crate) fn resolve(
        &mut self,
        effect: Effect,
        reply: EffectReply,
    ) -> Result<Progress, MachineError> {
        let expected_header = match self.state {
            MachineState::InFlight(header) => header,
            MachineState::Ready(_) => return Err(MachineError::UnexpectedEffect),
            MachineState::Closed => return Err(MachineError::MachineClosed),
        };
        if effect.header() != expected_header || !effect.has_valid_resume_permit() {
            self.close_refused(ProofRefusal::RecoveryRequired);
            return Err(MachineError::UnexpectedEffect);
        }

        match reply {
            EffectReply::Refused => {
                self.accounting.effects_refused = self
                    .accounting
                    .effects_refused
                    .checked_add(1)
                    .ok_or(MachineError::InternalInvariant)?;
                let refusal = self.refusal_for_known_failure();
                Ok(self.close_refused(refusal))
            }
            EffectReply::LostAfterAcceptance => {
                self.accounting.effects_accepted = self
                    .accounting
                    .effects_accepted
                    .checked_add(1)
                    .ok_or(MachineError::InternalInvariant)?;
                self.accounting.responses_lost = self
                    .accounting
                    .responses_lost
                    .checked_add(1)
                    .ok_or(MachineError::InternalInvariant)?;
                Ok(self.close_refused(ProofRefusal::RecoveryRequired))
            }
            EffectReply::Observed(observation) => {
                self.accounting.effects_accepted = self
                    .accounting
                    .effects_accepted
                    .checked_add(1)
                    .ok_or(MachineError::InternalInvariant)?;
                if observation != Observation::exact(expected_header.kind) {
                    let refusal = if expected_header.kind == EffectKind::PersistLaunchIntent
                        || self.intent_is_durable()
                    {
                        ProofRefusal::RecoveryRequired
                    } else {
                        ProofRefusal::KernelInvariantUnavailable
                    };
                    return Ok(self.close_refused(refusal));
                }
                self.accounting.resources.add(observation.resources)?;

                if expected_header.kind == EffectKind::AttestProcessProtections {
                    self.resume_permit = Some(ResumePermit {
                        seal: OneUseSeal(self.case_seal),
                        issuance: 1,
                    });
                }
                match expected_header.kind.next() {
                    Some(next) => {
                        self.state = MachineState::Ready(next);
                        Ok(Progress::Advanced)
                    }
                    None => self.complete(),
                }
            }
        }
    }

    pub(crate) fn interrupt(&mut self) -> Result<Progress, MachineError> {
        let in_flight = match self.state {
            MachineState::Ready(_) => false,
            MachineState::InFlight(_) => true,
            MachineState::Closed => return Err(MachineError::MachineClosed),
        };
        self.accounting.interruptions = self
            .accounting
            .interruptions
            .checked_add(1)
            .ok_or(MachineError::InternalInvariant)?;
        if in_flight {
            self.accounting.effects_uncertain = self
                .accounting
                .effects_uncertain
                .checked_add(1)
                .ok_or(MachineError::InternalInvariant)?;
        }
        let refusal = if self.intent_is_durable() || in_flight {
            ProofRefusal::RecoveryRequired
        } else {
            ProofRefusal::KernelInvariantUnavailable
        };
        Ok(self.close_refused(refusal))
    }

    pub(crate) fn result(&self) -> Option<ProofResult> {
        self.result
    }

    pub(crate) fn accounting(&self) -> Accounting {
        self.accounting
    }

    fn intent_is_durable(&self) -> bool {
        self.accounting.resources.durable_intents == 1
    }

    fn refusal_for_known_failure(&self) -> ProofRefusal {
        if self.intent_is_durable() {
            ProofRefusal::RecoveryRequired
        } else {
            ProofRefusal::KernelInvariantUnavailable
        }
    }

    fn close_refused(&mut self, refusal: ProofRefusal) -> Progress {
        self.resume_permit = None;
        self.state = MachineState::Closed;
        let result = ProofResult::Refused {
            refusal,
            accounting: self.accounting,
        };
        self.result = Some(result);
        Progress::Refused(refusal)
    }

    fn complete(&mut self) -> Result<Progress, MachineError> {
        if self.resume_permit.is_some()
            || self.accounting.resources != self.expected
            || !self.accounting.resources.is_conserved_success()
            || !self.accounting.effect_events_conserve()
        {
            return Ok(self.close_refused(ProofRefusal::RecoveryRequired));
        }
        self.state = MachineState::Closed;
        let summary = ProofSummary {
            accounting: self.accounting,
        };
        self.result = Some(ProofResult::Complete(summary));
        Ok(Progress::Complete(summary))
    }
}
