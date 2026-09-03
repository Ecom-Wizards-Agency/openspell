#![allow(dead_code)]
#![deny(unsafe_code)]

#[path = "linux_abi.rs"]
mod linux_abi;
#[path = "machine.rs"]
mod machine;

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use goblin::elf::Elf;
use goblin::elf::header::ET_DYN;
use goblin::elf::program_header::{PF_R, PF_W, PF_X, PT_LOAD};
use linux_abi::{CloneOutcome, ForkOutcome, WaitEvent, WaitKind};
use machine::{
    Effect, EffectKind, EffectReply, Observation, Progress, ProofRefusal, ProofResult,
    SyntheticProofMachine, VerifiedSyntheticCase,
};

const WAIT_BOUND: Duration = Duration::from_secs(8);
const TERMINAL_BOUND: Duration = Duration::from_secs(4);
const TIMEOUT_PROBE_BOUND: Duration = Duration::from_millis(25);
const MAX_EXECUTABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MAPPING_BYTES: usize = 512 * 1024;
const MAX_MAPPING_LINES: usize = 256;
const PAGE_SIZE: u64 = 4096;
const LABORATORY_PARENT: &str = "/tmp";
const LABORATORY: &str = "/tmp/openspell-wp200-proof";
const INTENT: &str = "/tmp/openspell-wp200-proof/intent";
const TERMINAL: &str = "/tmp/openspell-wp200-proof/terminal";
const CGROUP: &str = "/sys/fs/cgroup/openspell-wp200-proof";
const STATUS_FD: i32 = 199;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KernelError {
    KernelUnavailable,
    IdentityMapMismatch,
    NetworkMismatch,
    SupervisorNamespaceMismatch,
    SupervisorNamespaceReadMismatch,
    NamespaceReadMismatch,
    ChildMountNamespaceMismatch,
    ChildPidNamespaceMismatch,
    LeaderPidNamespaceMismatch,
    DelegatePidNamespaceMismatch,
    ChildUserNamespaceMismatch,
    ChildIpcNamespaceMismatch,
    ChildUtsNamespaceMismatch,
    ChildNetworkNamespaceMismatch,
    ProcMismatch,
    GateMismatch,
    ProcMountMismatch,
    TracemeMismatch,
    CgroupMismatch,
    CgroupCreateMismatch,
    LeaderCgroupMismatch,
    DescendantCgroupMismatch,
    ProcessMismatch,
    PtraceMismatch,
    LeaderInitialStopMismatch,
    LeaderExecStopMismatch,
    ForkStopMismatch,
    DelegateInitialStopMismatch,
    DelegateExecStopMismatch,
    DelegateReadyStopMismatch,
    LeaderReadyStopMismatch,
    ExecutableMismatch,
    ExecutableIdentityMismatch,
    RootIdentityMismatch,
    MappingMismatch,
    MappingCountMismatch,
    MappingMissing,
    MappingExtra,
    ProtectionMismatch,
    MachineMismatch,
    DeadlineExceeded,
    InjectedAdapterFault,
    UnexpectedPostResumeEvent,
    CleanupUncertain,
}

impl From<linux_abi::AbiError> for KernelError {
    fn from(value: linux_abi::AbiError) -> Self {
        match value {
            linux_abi::AbiError::KernelUnavailable => Self::KernelUnavailable,
            linux_abi::AbiError::DeadlineExceeded => Self::DeadlineExceeded,
            linux_abi::AbiError::OperationFailed | linux_abi::AbiError::ProtocolMismatch => {
                Self::ProcessMismatch
            }
        }
    }
}

impl From<machine::MachineError> for KernelError {
    fn from(_: machine::MachineError) -> Self {
        Self::MachineMismatch
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scenario {
    Success,
    Refusal,
    Timeout,
    Interruption,
    UnexpectedEvent,
    LostAfterResumeOne,
    LostAfterResumeTwo,
    LostAfterDrain,
    LostAfterEmptyCgroup,
    LostAfterTerminalProof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrontBehavior {
    Normal,
    UnexpectedForkAfterResume,
    HoldAfterResume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FaultPoint {
    Intent,
    Namespace,
    Cgroup,
    Spawn,
    LeaderAttestation,
    Bootstrap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TracerDeathCut {
    Stopped,
    MixedResume,
    FullResume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileMappingRecord {
    offset: u64,
    length: u64,
    readable: bool,
    writable: bool,
    executable: bool,
    private: bool,
    identity: FileIdentity,
}

#[derive(Debug, Clone, Copy)]
struct AllowedLoadSegment {
    first_file_page: u64,
    after_last_file_page: u64,
    readable: bool,
    writable: bool,
    executable: bool,
}

#[derive(Debug)]
struct RuntimeInventory {
    executable: FileIdentity,
    root: FileIdentity,
    loads: Vec<AllowedLoadSegment>,
    ready_records: Vec<FileMappingRecord>,
}

#[derive(Debug)]
struct NamespaceInventory {
    outer: BTreeMap<&'static str, PathBuf>,
    private: BTreeMap<&'static str, PathBuf>,
    child_pid: PathBuf,
}

#[derive(Debug)]
struct TrackedProcess {
    pid: i32,
    pidfd: OwnedFd,
    start_time: Option<u64>,
    reaped: bool,
}

impl TrackedProcess {
    fn acquired(pid: i32, pidfd: OwnedFd) -> Self {
        Self {
            pid,
            pidfd,
            start_time: None,
            reaped: false,
        }
    }

    fn attest_live(&mut self) -> Result<(), KernelError> {
        if linux_abi::pidfd_is_terminal(self.pidfd.as_raw_fd(), Duration::ZERO)? {
            return Err(KernelError::ProcessMismatch);
        }
        let start_time = read_start_time(self.pid)?;
        if start_time == 0 {
            return Err(KernelError::ProcessMismatch);
        }
        self.start_time = Some(start_time);
        Ok(())
    }

    fn from_witness(pid: i32, start_time: u64) -> Result<Self, KernelError> {
        if pid <= 0 || start_time == 0 {
            return Err(KernelError::ProcessMismatch);
        }
        let mut process = Self::acquired(pid, linux_abi::open_pidfd(pid)?);
        process.attest_live()?;
        if process.start_time != Some(start_time) {
            return Err(KernelError::ProcessMismatch);
        }
        Ok(process)
    }

    fn verify_identity(&self) -> Result<(), KernelError> {
        if self.start_time.is_some()
            && Some(read_start_time(self.pid)?) == self.start_time
            && !linux_abi::pidfd_is_terminal(self.pidfd.as_raw_fd(), Duration::ZERO)?
        {
            Ok(())
        } else {
            Err(KernelError::ProcessMismatch)
        }
    }

    fn verify_terminal(&self) -> Result<(), KernelError> {
        if linux_abi::pidfd_is_terminal(self.pidfd.as_raw_fd(), TERMINAL_BOUND)? {
            Ok(())
        } else {
            Err(KernelError::CleanupUncertain)
        }
    }

    fn witness(&self) -> Result<ProcessWitness, KernelError> {
        Ok(ProcessWitness {
            pid: self.pid,
            start_time: self.start_time.ok_or(KernelError::ProcessMismatch)?,
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct ProcessWitness {
    pid: i32,
    start_time: u64,
}

#[derive(Debug)]
struct CaseResources {
    laboratory_owned: bool,
    cgroup_owned: bool,
    leader: Option<TrackedProcess>,
    delegate: Option<TrackedProcess>,
    unexpected_descendants: Vec<TrackedProcess>,
}

impl CaseResources {
    fn new() -> Self {
        Self {
            laboratory_owned: false,
            cgroup_owned: false,
            leader: None,
            delegate: None,
            unexpected_descendants: Vec::new(),
        }
    }

    fn leader(&self) -> Result<&TrackedProcess, KernelError> {
        self.leader.as_ref().ok_or(KernelError::ProcessMismatch)
    }

    fn leader_mut(&mut self) -> Result<&mut TrackedProcess, KernelError> {
        self.leader.as_mut().ok_or(KernelError::ProcessMismatch)
    }

    fn delegate(&self) -> Result<&TrackedProcess, KernelError> {
        self.delegate.as_ref().ok_or(KernelError::ProcessMismatch)
    }

    fn delegate_mut(&mut self) -> Result<&mut TrackedProcess, KernelError> {
        self.delegate.as_mut().ok_or(KernelError::ProcessMismatch)
    }

    fn recover_programs_and_cgroup(&mut self) -> Result<(), KernelError> {
        let mut exact = true;
        if self.cgroup_owned && fs::write(format!("{CGROUP}/cgroup.kill"), b"1\n").is_err() {
            exact = false;
        }
        for process in self
            .unexpected_descendants
            .iter_mut()
            .chain(self.delegate.iter_mut())
            .chain(self.leader.iter_mut())
        {
            if recover_process(process).is_err() {
                exact = false;
            }
        }
        if self.cgroup_owned {
            let empty = wait_for_empty_cgroup().is_ok();
            let removed = fs::remove_dir(CGROUP).is_ok();
            if !empty || !removed {
                exact = false;
            } else {
                self.cgroup_owned = false;
            }
        }
        if exact {
            self.unexpected_descendants.clear();
            self.delegate.take();
            self.leader.take();
        }
        if exact {
            Ok(())
        } else {
            Err(KernelError::CleanupUncertain)
        }
    }

    fn cleanup_laboratory(&mut self) -> Result<(), KernelError> {
        if !self.laboratory_owned {
            return Ok(());
        }
        cleanup_owned_laboratory()?;
        self.laboratory_owned = false;
        Ok(())
    }

    fn recover_all(&mut self) -> Result<(), KernelError> {
        let programs = self.recover_programs_and_cgroup();
        let laboratory = self.cleanup_laboratory();
        if programs.is_ok() && laboratory.is_ok() {
            Ok(())
        } else {
            Err(KernelError::CleanupUncertain)
        }
    }

    fn release_terminal_custody(&mut self) -> Result<(), KernelError> {
        if self.cgroup_owned
            || self
                .unexpected_descendants
                .iter()
                .chain(self.delegate.iter())
                .chain(self.leader.iter())
                .any(|process| process.verify_terminal().is_err())
        {
            return Err(KernelError::CleanupUncertain);
        }
        self.unexpected_descendants.clear();
        self.delegate.take();
        self.leader.take();
        Ok(())
    }
}

struct PreparedCase {
    machine: SyntheticProofMachine,
    resources: CaseResources,
}

enum Preparation {
    Ready(Box<PreparedCase>),
    InjectedAndRecovered,
}

fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    let status = if linux_abi::ignore_sigpipe().is_err() {
        Err(KernelError::ProcessMismatch)
    } else {
        match arguments.as_slice() {
            [_, mode] if mode == "success" => run_scenario(Scenario::Success),
            [_, mode] if mode == "refusal" => run_scenario(Scenario::Refusal),
            [_, mode] if mode == "timeout" => run_scenario(Scenario::Timeout),
            [_, mode] if mode == "interruption" => run_scenario(Scenario::Interruption),
            [_, mode] if mode == "unexpected-event" => run_scenario(Scenario::UnexpectedEvent),
            [_, mode] if mode == "lost-resume-one" => run_scenario(Scenario::LostAfterResumeOne),
            [_, mode] if mode == "lost-resume-two" => run_scenario(Scenario::LostAfterResumeTwo),
            [_, mode] if mode == "lost-drain" => run_scenario(Scenario::LostAfterDrain),
            [_, mode] if mode == "lost-empty-cgroup" => {
                run_scenario(Scenario::LostAfterEmptyCgroup)
            }
            [_, mode] if mode == "lost-terminal-proof" => {
                run_scenario(Scenario::LostAfterTerminalProof)
            }
            [_, mode] if mode == "fault-intent" => run_adapter_fault(FaultPoint::Intent),
            [_, mode] if mode == "fault-namespace" => run_adapter_fault(FaultPoint::Namespace),
            [_, mode] if mode == "fault-cgroup" => run_adapter_fault(FaultPoint::Cgroup),
            [_, mode] if mode == "fault-spawn" => run_adapter_fault(FaultPoint::Spawn),
            [_, mode] if mode == "fault-leader-attest" => {
                run_adapter_fault(FaultPoint::LeaderAttestation)
            }
            [_, mode] if mode == "fault-bootstrap" => run_adapter_fault(FaultPoint::Bootstrap),
            [_, mode] if mode == "tracer-death-stopped" => {
                run_tracer_death(TracerDeathCut::Stopped)
            }
            [_, mode] if mode == "tracer-death-mixed" => {
                run_tracer_death(TracerDeathCut::MixedResume)
            }
            [_, mode] if mode == "tracer-death-resumed" => {
                run_tracer_death(TracerDeathCut::FullResume)
            }
            [_, mode] if mode == "front" => run_front_controller(FrontBehavior::Normal),
            [_, mode] if mode == "front-unexpected" => {
                run_front_controller(FrontBehavior::UnexpectedForkAfterResume)
            }
            [_, mode] if mode == "front-held" => {
                run_front_controller(FrontBehavior::HoldAfterResume)
            }
            [_, mode] if mode == "delegate" => run_delegate(false),
            [_, mode] if mode == "delegate-held" => run_delegate(true),
            _ => Err(KernelError::ProcessMismatch),
        }
    };

    match status {
        Ok(()) if matches!(arguments.get(1).map(String::as_str), Some("success")) => {
            println!("openspell synthetic kernel proof: success complete=1 residue=0");
        }
        Ok(()) if matches!(arguments.get(1).map(String::as_str), Some("refusal")) => {
            println!("openspell synthetic kernel proof: refusal recovery=1 residue=0");
        }
        Ok(()) if matches!(arguments.get(1).map(String::as_str), Some("timeout")) => {
            println!("openspell synthetic kernel proof: timeout recovery=1 residue=0");
        }
        Ok(()) if matches!(arguments.get(1).map(String::as_str), Some("interruption")) => {
            println!("openspell synthetic kernel proof: interruption recovery=1 residue=0");
        }
        Ok(())
            if matches!(
                arguments.get(1).map(String::as_str),
                Some("unexpected-event")
            ) =>
        {
            println!("openspell synthetic kernel proof: unexpected-event recovery=1 residue=0");
        }
        Ok(())
            if arguments
                .get(1)
                .is_some_and(|mode| mode.starts_with("fault-")) =>
        {
            println!("openspell synthetic kernel proof: adapter-fault recovery=1 residue=0");
        }
        Ok(())
            if arguments
                .get(1)
                .is_some_and(|mode| mode.starts_with("lost-")) =>
        {
            println!("openspell synthetic kernel proof: adapter-loss recovery=1 residue=0");
        }
        Ok(())
            if arguments
                .get(1)
                .is_some_and(|mode| mode.starts_with("tracer-death-")) =>
        {
            println!("openspell synthetic kernel proof: tracer-death exitkill=1 residue=0");
        }
        Ok(()) => linux_abi::exit_immediately(0),
        Err(_) => {
            eprintln!("openspell synthetic kernel proof refused");
            linux_abi::exit_immediately(111);
        }
    }
}

fn run_scenario(scenario: Scenario) -> Result<(), KernelError> {
    let behavior = if scenario == Scenario::UnexpectedEvent {
        FrontBehavior::UnexpectedForkAfterResume
    } else {
        FrontBehavior::Normal
    };
    let Preparation::Ready(mut prepared) = prepare_case(behavior, None)? else {
        return Err(KernelError::MachineMismatch);
    };
    let outcome = match scenario {
        Scenario::Success => finish_success(&mut prepared),
        Scenario::Refusal => finish_refusal(&mut prepared),
        Scenario::Timeout => finish_timeout(&mut prepared),
        Scenario::Interruption => finish_interruption(&mut prepared),
        Scenario::UnexpectedEvent => finish_unexpected_event(&mut prepared),
        Scenario::LostAfterResumeOne => finish_lost_after_resume_one(&mut prepared),
        Scenario::LostAfterResumeTwo => finish_lost_after_resume_two(&mut prepared),
        Scenario::LostAfterDrain => finish_lost_after_drain(&mut prepared),
        Scenario::LostAfterEmptyCgroup => finish_lost_after_empty_cgroup(&mut prepared),
        Scenario::LostAfterTerminalProof => finish_lost_after_terminal_proof(&mut prepared),
    };
    if let Err(primary) = outcome {
        let _ = prepared.machine.interrupt();
        return if prepared.resources.recover_all().is_ok() {
            Err(primary)
        } else {
            Err(KernelError::CleanupUncertain)
        };
    }
    prepared.resources.cleanup_laboratory()?;
    prove_fixed_residue_absent()
}

fn run_adapter_fault(point: FaultPoint) -> Result<(), KernelError> {
    match prepare_case(FrontBehavior::Normal, Some(point))? {
        Preparation::InjectedAndRecovered => prove_fixed_residue_absent(),
        Preparation::Ready(mut prepared) => {
            let _ = prepared.resources.recover_all();
            Err(KernelError::InjectedAdapterFault)
        }
    }
}

fn prepare_case(
    behavior: FrontBehavior,
    fault: Option<FaultPoint>,
) -> Result<Preparation, KernelError> {
    let mut resources = CaseResources::new();
    let mut machine = SyntheticProofMachine::begin(VerifiedSyntheticCase::sealed_fixture(1));
    match prepare_case_inner(&mut machine, &mut resources, behavior, fault) {
        Ok(true) => {
            resources.recover_all()?;
            Ok(Preparation::InjectedAndRecovered)
        }
        Ok(false) => Ok(Preparation::Ready(Box::new(PreparedCase {
            machine,
            resources,
        }))),
        Err(primary) => {
            if resources.recover_all().is_ok() {
                Err(primary)
            } else {
                Err(KernelError::CleanupUncertain)
            }
        }
    }
}

fn prepare_case_inner(
    machine: &mut SyntheticProofMachine,
    resources: &mut CaseResources,
    behavior: FrontBehavior,
    fault: Option<FaultPoint>,
) -> Result<bool, KernelError> {
    verify_supervisor_boundary()?;
    let runtime = capture_runtime_inventory(linux_abi::current_pid())?;
    let mut namespaces = NamespaceInventory {
        outer: capture_self_namespace_inventory()
            .map_err(|_| KernelError::SupervisorNamespaceReadMismatch)?,
        private: BTreeMap::new(),
        child_pid: PathBuf::new(),
    };
    let outer_ids = linux_abi::current_ids();
    let intent_effect = offer_expected(machine, EffectKind::PersistLaunchIntent)?;
    create_intent(resources)?;
    if resolve_or_inject(machine, intent_effect, fault, FaultPoint::Intent)? {
        return Ok(true);
    }

    let namespace_effect = offer_expected(machine, EffectKind::EstablishPrivateNamespaces)?;
    linux_abi::unshare_proof_namespaces()?;
    install_self_identity_map(outer_ids)?;
    linux_abi::enable_supervisor_proc_inspection()?;
    linux_abi::set_fixed_hostname()?;
    assert_private_network()?;
    namespaces.private = capture_self_namespace_inventory()
        .map_err(|_| KernelError::SupervisorNamespaceReadMismatch)?;
    verify_supervisor_namespaces(&namespaces)?;
    if resolve_or_inject(machine, namespace_effect, fault, FaultPoint::Namespace)? {
        return Ok(true);
    }

    let cgroup_effect = offer_expected(machine, EffectKind::EstablishExclusiveChildCgroup)?;
    create_cgroup(resources).map_err(|_| KernelError::CgroupCreateMismatch)?;
    if resolve_or_inject(machine, cgroup_effect, fault, FaultPoint::Cgroup)? {
        return Ok(true);
    }

    let executable = File::open("/proc/self/exe").map_err(|_| KernelError::ExecutableMismatch)?;
    let fixed_executable = linux_abi::duplicate_executable_fd(executable.as_raw_fd())?;
    let gate = linux_abi::make_pipe()?;
    let spawn_effect = offer_expected(machine, EffectKind::SpawnStoppedLeaderAndOpenPidfd)?;
    match linux_abi::clone_with_pidfd()? {
        CloneOutcome::Child => {
            drop(gate.write);
            let child_result = child_before_exec(gate.read.as_raw_fd());
            drop(gate.read);
            if child_result.is_err() {
                eprintln!("openspell synthetic child refused");
                linux_abi::exit_immediately(111);
            }
            let role: &'static [u8] = match behavior {
                FrontBehavior::Normal => b"front\0",
                FrontBehavior::UnexpectedForkAfterResume => b"front-unexpected\0",
                FrontBehavior::HoldAfterResume => b"front-held\0",
            };
            let _ = linux_abi::exec_role(linux_abi::EXECUTABLE_FD, role);
            linux_abi::exit_immediately(111);
        }
        CloneOutcome::Parent { pid, pidfd } => {
            drop(gate.read);
            resources.leader = Some(TrackedProcess::acquired(pid, pidfd));
            resources.leader_mut()?.attest_live()?;
            write_cgroup_pid(pid).map_err(|_| KernelError::LeaderCgroupMismatch)?;
            linux_abi::write_gate(gate.write.as_raw_fd())?;
            drop(gate.write);
        }
    }
    drop(fixed_executable);
    let leader_pid = resources.leader()?.pid;
    expect_plain_stop(wait(leader_pid)?, linux_abi::STOP_SIGNAL)
        .map_err(|_| KernelError::LeaderInitialStopMismatch)?;
    linux_abi::ptrace_set_fixed_options(leader_pid)?;
    namespaces.child_pid = namespace_path(Some(leader_pid), "pid")
        .map_err(|_| KernelError::ChildPidNamespaceMismatch)?;
    if namespaces.outer.get("pid") == Some(&namespaces.child_pid) {
        return Err(KernelError::SupervisorNamespaceMismatch);
    }
    verify_stopped_leader_namespaces(&namespaces, leader_pid)?;
    verify_cgroup_members(&[leader_pid]).map_err(|_| KernelError::LeaderCgroupMismatch)?;
    if resolve_or_inject(machine, spawn_effect, fault, FaultPoint::Spawn)? {
        return Ok(true);
    }

    let leader_attestation = offer_expected(machine, EffectKind::AttestLeaderExecAndMaps)?;
    // This is the sole pre-exec leader continue and therefore needs no post-exec permit.
    linux_abi::ptrace_continue(leader_pid)?;
    expect_ptrace_event(wait(leader_pid)?, linux_abi::EVENT_EXEC)
        .map_err(|_| KernelError::LeaderExecStopMismatch)?;
    resources.leader()?.verify_identity()?;
    let leader_exec_maps = attest_exec_stop(&runtime, resources.leader()?, MappingStage::ExecStop)?;
    verify_prebootstrap_authority(resources.leader()?)?;
    if resolve_or_inject(
        machine,
        leader_attestation,
        fault,
        FaultPoint::LeaderAttestation,
    )? {
        return Ok(true);
    }

    let bootstrap = offer_expected(machine, EffectKind::BootstrapVerifiedProcesses)?;
    if !bootstrap.carries_bootstrap_permit() {
        return Err(KernelError::MachineMismatch);
    }
    bootstrap_continue(&bootstrap, leader_pid)?;
    expect_ptrace_event(wait(leader_pid)?, linux_abi::EVENT_FORK)
        .map_err(|_| KernelError::ForkStopMismatch)?;
    let delegate_pid = linux_abi::ptrace_event_pid(leader_pid)?;
    resources.delegate = Some(TrackedProcess::acquired(
        delegate_pid,
        linux_abi::open_pidfd(delegate_pid)?,
    ));
    resources.delegate_mut()?.attest_live()?;
    expect_plain_stop(wait(delegate_pid)?, linux_abi::STOP_SIGNAL)
        .map_err(|_| KernelError::DelegateInitialStopMismatch)?;
    linux_abi::ptrace_set_fixed_options(delegate_pid)?;
    verify_cgroup_members(&[leader_pid, delegate_pid])
        .map_err(|_| KernelError::DescendantCgroupMismatch)?;
    verify_child_namespaces(&namespaces, leader_pid, delegate_pid)?;

    // The delegate has not executed yet, so this is the sole bootstrap pre-exec continue.
    linux_abi::ptrace_continue(delegate_pid)?;
    expect_ptrace_event(wait(delegate_pid)?, linux_abi::EVENT_EXEC)
        .map_err(|_| KernelError::DelegateExecStopMismatch)?;
    resources.delegate()?.verify_identity()?;
    let delegate_exec_maps =
        attest_exec_stop(&runtime, resources.delegate()?, MappingStage::ExecStop)?;
    verify_prebootstrap_authority(resources.delegate()?)?;
    if leader_exec_maps != delegate_exec_maps {
        return Err(KernelError::MappingMismatch);
    }
    bootstrap_continue(&bootstrap, delegate_pid)?;
    expect_plain_stop(wait(delegate_pid)?, linux_abi::STOP_SIGNAL)
        .map_err(|_| KernelError::DelegateReadyStopMismatch)?;
    bootstrap_continue(&bootstrap, leader_pid)?;
    expect_plain_stop(wait(leader_pid)?, linux_abi::STOP_SIGNAL)
        .map_err(|_| KernelError::LeaderReadyStopMismatch)?;
    let leader_ready_maps =
        attest_exec_stop(&runtime, resources.leader()?, MappingStage::ReadyStop)?;
    let delegate_ready_maps =
        attest_exec_stop(&runtime, resources.delegate()?, MappingStage::ReadyStop)?;
    if leader_ready_maps != delegate_ready_maps {
        return Err(KernelError::MappingMismatch);
    }
    verify_process_protections(resources.leader()?)?;
    verify_process_protections(resources.delegate()?)?;
    verify_cgroup_members(&[leader_pid, delegate_pid])?;
    if resolve_or_inject(machine, bootstrap, fault, FaultPoint::Bootstrap)? {
        return Ok(true);
    }

    Ok(false)
}

fn finish_success(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    resume_both(prepared)?;
    drain_delegate(prepared)?;
    observe_terminal_and_empty_cgroup(prepared)?;

    let proof = offer_expected(&mut prepared.machine, EffectKind::PersistTerminalProof)?;
    create_terminal()?;
    let progress = prepared.machine.resolve(
        proof,
        EffectReply::Observed(Observation::exact(EffectKind::PersistTerminalProof)),
    )?;
    if !matches!(progress, Progress::Complete(_))
        || !matches!(prepared.machine.result(), Some(ProofResult::Complete(_)))
    {
        return Err(KernelError::MachineMismatch);
    }
    prepared.resources.release_terminal_custody()
}

fn resume_both(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let resume = offer_expected(&mut prepared.machine, EffectKind::ResumeVerifiedProcesses)?;
    if !resume.carries_resume_permit() {
        return Err(KernelError::MachineMismatch);
    }
    resume_continue(&resume, prepared.resources.delegate()?.pid)?;
    resume_continue(&resume, prepared.resources.leader()?.pid)?;
    resolve_exact(&mut prepared.machine, resume)
}

fn drain_delegate(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let drain = offer_expected(&mut prepared.machine, EffectKind::DrainDescendants)?;
    wait_successful_exit(prepared.resources.delegate_mut()?)?;
    resolve_exact(&mut prepared.machine, drain)
}

fn observe_terminal_and_empty_cgroup(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let terminal = offer_expected(
        &mut prepared.machine,
        EffectKind::ObserveTerminalAndEmptyCgroup,
    )?;
    wait_successful_exit(prepared.resources.leader_mut()?)?;
    prove_empty_cgroup_and_remove()?;
    prepared.resources.cgroup_owned = false;
    resolve_exact(&mut prepared.machine, terminal)
}

fn finish_refusal(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let resume = offer_expected(&mut prepared.machine, EffectKind::ResumeVerifiedProcesses)?;
    let progress = prepared.machine.resolve(resume, EffectReply::Refused)?;
    assert_recovery(progress, prepared.machine.result())?;
    terminate_case(prepared)?;
    Ok(())
}

fn finish_timeout(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let started = Instant::now();
    match linux_abi::wait_for_pid(prepared.resources.leader()?.pid, TIMEOUT_PROBE_BOUND) {
        Err(linux_abi::AbiError::DeadlineExceeded) if started.elapsed() >= TIMEOUT_PROBE_BOUND => {}
        _ => return Err(KernelError::DeadlineExceeded),
    }
    let progress = prepared.machine.interrupt()?;
    assert_recovery(progress, prepared.machine.result())?;
    terminate_case(prepared)?;
    Ok(())
}

fn finish_interruption(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let effect = offer_expected(&mut prepared.machine, EffectKind::ResumeVerifiedProcesses)?;
    if !effect.carries_resume_permit() {
        return Err(KernelError::MachineMismatch);
    }
    let progress = prepared.machine.interrupt()?;
    assert_recovery(progress, prepared.machine.result())?;
    terminate_case(prepared)?;
    Ok(())
}

fn finish_unexpected_event(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let resume = offer_expected(&mut prepared.machine, EffectKind::ResumeVerifiedProcesses)?;
    if !resume.carries_resume_permit() {
        return Err(KernelError::MachineMismatch);
    }
    resume_continue(&resume, prepared.resources.delegate()?.pid)?;
    resume_continue(&resume, prepared.resources.leader()?.pid)?;
    resolve_exact(&mut prepared.machine, resume)?;

    let deadline = Instant::now() + WAIT_BOUND;
    let leader_pid = prepared.resources.leader()?.pid;
    let delegate_pid = prepared.resources.delegate()?.pid;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(KernelError::DeadlineExceeded);
        }
        let event = linux_abi::wait_for_any(remaining)?;
        match event {
            WaitEvent {
                pid,
                kind: WaitKind::Exited(0),
            } if pid == delegate_pid => {
                prepared.resources.delegate_mut()?.reaped = true;
            }
            WaitEvent {
                pid,
                kind: WaitKind::Stopped { event, .. },
            } if pid == leader_pid && event != 0 => {
                let descendant_pid = linux_abi::ptrace_event_pid(leader_pid)?;
                retain_unexpected_descendant(&mut prepared.resources, descendant_pid)?;
                break;
            }
            WaitEvent {
                pid,
                kind: WaitKind::Stopped { .. },
            } if pid != leader_pid && pid != delegate_pid => {
                retain_unexpected_descendant(&mut prepared.resources, pid)?;
                break;
            }
            _ => return Err(KernelError::UnexpectedPostResumeEvent),
        }
    }

    let progress = prepared.machine.interrupt()?;
    assert_recovery(progress, prepared.machine.result())?;
    terminate_case(prepared)
}

fn finish_lost_after_resume_one(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let resume = offer_expected(&mut prepared.machine, EffectKind::ResumeVerifiedProcesses)?;
    if !resume.carries_resume_permit() {
        return Err(KernelError::MachineMismatch);
    }
    resume_continue(&resume, prepared.resources.delegate()?.pid)?;
    let progress = prepared.machine.interrupt()?;
    assert_recovery(progress, prepared.machine.result())?;
    terminate_case(prepared)
}

fn finish_lost_after_resume_two(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let resume = offer_expected(&mut prepared.machine, EffectKind::ResumeVerifiedProcesses)?;
    if !resume.carries_resume_permit() {
        return Err(KernelError::MachineMismatch);
    }
    resume_continue(&resume, prepared.resources.delegate()?.pid)?;
    resume_continue(&resume, prepared.resources.leader()?.pid)?;
    let progress = prepared
        .machine
        .resolve(resume, EffectReply::LostAfterAcceptance)?;
    assert_recovery(progress, prepared.machine.result())?;
    terminate_case(prepared)
}

fn finish_lost_after_drain(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    resume_both(prepared)?;
    let drain = offer_expected(&mut prepared.machine, EffectKind::DrainDescendants)?;
    wait_successful_exit(prepared.resources.delegate_mut()?)?;
    let progress = prepared
        .machine
        .resolve(drain, EffectReply::LostAfterAcceptance)?;
    assert_recovery(progress, prepared.machine.result())?;
    terminate_case(prepared)
}

fn finish_lost_after_empty_cgroup(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    resume_both(prepared)?;
    drain_delegate(prepared)?;
    let observe = offer_expected(
        &mut prepared.machine,
        EffectKind::ObserveTerminalAndEmptyCgroup,
    )?;
    wait_successful_exit(prepared.resources.leader_mut()?)?;
    prove_empty_cgroup_and_remove()?;
    prepared.resources.cgroup_owned = false;
    let progress = prepared
        .machine
        .resolve(observe, EffectReply::LostAfterAcceptance)?;
    assert_recovery(progress, prepared.machine.result())?;
    terminate_case(prepared)
}

fn finish_lost_after_terminal_proof(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    resume_both(prepared)?;
    drain_delegate(prepared)?;
    observe_terminal_and_empty_cgroup(prepared)?;
    let proof = offer_expected(&mut prepared.machine, EffectKind::PersistTerminalProof)?;
    create_terminal()?;
    let progress = prepared
        .machine
        .resolve(proof, EffectReply::LostAfterAcceptance)?;
    assert_recovery(progress, prepared.machine.result())?;
    terminate_case(prepared)
}

fn assert_recovery(progress: Progress, result: Option<ProofResult>) -> Result<(), KernelError> {
    if matches!(progress, Progress::Refused(ProofRefusal::RecoveryRequired))
        && matches!(
            result,
            Some(ProofResult::Refused {
                refusal: ProofRefusal::RecoveryRequired,
                ..
            })
        )
    {
        Ok(())
    } else {
        Err(KernelError::MachineMismatch)
    }
}

fn terminate_case(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    prepared.resources.recover_programs_and_cgroup()
}

fn run_tracer_death(cut: TracerDeathCut) -> Result<(), KernelError> {
    let report_pipe = linux_abi::make_pipe()?;
    let command_pipe = linux_abi::make_pipe()?;
    let status_pipe = linux_abi::make_pipe()?;
    let mut tracer = match linux_abi::fork_process()? {
        ForkOutcome::Child => {
            drop(report_pipe.read);
            drop(command_pipe.write);
            drop(status_pipe.read);
            let inherited_status =
                linux_abi::duplicate_inherited_fd(status_pipe.write.as_raw_fd(), STATUS_FD)
                    .unwrap_or_else(|_| linux_abi::exit_immediately(111));
            drop(status_pipe.write);
            let behavior = if cut == TracerDeathCut::Stopped {
                FrontBehavior::Normal
            } else {
                FrontBehavior::HoldAfterResume
            };
            let Preparation::Ready(mut prepared) =
                prepare_case(behavior, None).unwrap_or_else(|_| {
                    linux_abi::exit_immediately(111);
                })
            else {
                linux_abi::exit_immediately(111);
            };
            drop(inherited_status);
            let report = encode_custody_report(
                prepared
                    .resources
                    .leader()
                    .and_then(TrackedProcess::witness)
                    .unwrap_or_else(|_| linux_abi::exit_immediately(111)),
                prepared
                    .resources
                    .delegate()
                    .and_then(TrackedProcess::witness)
                    .unwrap_or_else(|_| linux_abi::exit_immediately(111)),
            );
            if linux_abi::write_all_bounded(report_pipe.write.as_raw_fd(), &report, WAIT_BOUND)
                .is_err()
            {
                linux_abi::exit_immediately(111);
            }
            drop(report_pipe.write);
            if linux_abi::read_gate(command_pipe.read.as_raw_fd()).is_err() {
                linux_abi::exit_immediately(111);
            }
            drop(command_pipe.read);
            if cut != TracerDeathCut::Stopped {
                let resume =
                    offer_expected(&mut prepared.machine, EffectKind::ResumeVerifiedProcesses)
                        .unwrap_or_else(|_| linux_abi::exit_immediately(111));
                let delegate_pid = prepared
                    .resources
                    .delegate()
                    .map(|process| process.pid)
                    .unwrap_or_else(|_| linux_abi::exit_immediately(111));
                resume_continue(&resume, delegate_pid)
                    .unwrap_or_else(|_| linux_abi::exit_immediately(111));
                if cut == TracerDeathCut::FullResume {
                    let leader_pid = prepared
                        .resources
                        .leader()
                        .map(|process| process.pid)
                        .unwrap_or_else(|_| linux_abi::exit_immediately(111));
                    resume_continue(&resume, leader_pid)
                        .unwrap_or_else(|_| linux_abi::exit_immediately(111));
                }
                // Intentionally keep the one-use resume authority in flight until tracer death.
                std::hint::black_box(&resume);
                loop {
                    std::thread::park();
                }
            }
            loop {
                std::thread::park();
            }
        }
        ForkOutcome::Parent(pid) => {
            drop(report_pipe.write);
            drop(command_pipe.read);
            drop(status_pipe.write);
            let mut handle = TrackedProcess::acquired(pid, linux_abi::open_pidfd(pid)?);
            handle.attest_live()?;
            handle
        }
    };

    let witnesses = (|| -> Result<(TrackedProcess, TrackedProcess), KernelError> {
        let mut report = [0_u8; 32];
        linux_abi::read_exact_bounded(report_pipe.read.as_raw_fd(), &mut report, WAIT_BOUND)?;
        let (leader, delegate) = decode_custody_report(report)?;
        if leader.pid == delegate.pid {
            return Err(KernelError::ProcessMismatch);
        }
        let leader = TrackedProcess::from_witness(leader.pid, leader.start_time)?;
        let delegate = TrackedProcess::from_witness(delegate.pid, delegate.start_time)?;
        verify_cgroup_members(&[leader.pid, delegate.pid])?;
        Ok((leader, delegate))
    })();
    let (leader, delegate) = match witnesses {
        Ok(processes) => processes,
        Err(primary) => return cleanup_failed_tracer(&mut tracer, primary),
    };
    drop(report_pipe.read);

    let outcome = (|| -> Result<(), KernelError> {
        linux_abi::write_gate(command_pipe.write.as_raw_fd())?;
        drop(command_pipe.write);
        let mut expected_tags = match cut {
            TracerDeathCut::Stopped => Vec::new(),
            TracerDeathCut::MixedResume => vec![b'D'],
            TracerDeathCut::FullResume => vec![b'D', b'L'],
        };
        if !expected_tags.is_empty() {
            let mut actual_tags = vec![0_u8; expected_tags.len()];
            linux_abi::read_exact_bounded(
                status_pipe.read.as_raw_fd(),
                &mut actual_tags,
                WAIT_BOUND,
            )?;
            expected_tags.sort_unstable();
            actual_tags.sort_unstable();
            if actual_tags != expected_tags {
                return Err(KernelError::ProcessMismatch);
            }
        }

        linux_abi::signal_pidfd(tracer.pidfd.as_raw_fd(), libc::SIGKILL)?;
        match wait(tracer.pid)? {
            WaitEvent {
                kind: WaitKind::Signaled(signal),
                ..
            } if signal == libc::SIGKILL => {}
            _ => return Err(KernelError::ProcessMismatch),
        }
        tracer.reaped = true;
        tracer.verify_terminal()?;
        leader.verify_terminal()?;
        delegate.verify_terminal()?;
        linux_abi::expect_eof_bounded(status_pipe.read.as_raw_fd(), WAIT_BOUND)?;
        wait_for_empty_cgroup()?;
        fs::remove_dir(CGROUP).map_err(|_| KernelError::CleanupUncertain)?;
        cleanup_owned_laboratory()?;
        prove_fixed_residue_absent()
    })();
    if let Err(primary) = outcome {
        return cleanup_failed_tracer_with_witnesses(&mut tracer, &leader, &delegate, primary);
    }
    drop(status_pipe.read);
    drop((leader, delegate, tracer));
    Ok(())
}

fn cleanup_failed_tracer_with_witnesses(
    tracer: &mut TrackedProcess,
    leader: &TrackedProcess,
    delegate: &TrackedProcess,
    primary: KernelError,
) -> Result<(), KernelError> {
    let mut exact = true;
    if matches!(Path::new(CGROUP).try_exists(), Ok(true))
        && fs::write(format!("{CGROUP}/cgroup.kill"), b"1\n").is_err()
    {
        exact = false;
    }
    if recover_process(tracer).is_err()
        || leader.verify_terminal().is_err()
        || delegate.verify_terminal().is_err()
    {
        exact = false;
    }
    match Path::new(CGROUP).try_exists() {
        Ok(true) => {
            if wait_for_empty_cgroup().is_err() || fs::remove_dir(CGROUP).is_err() {
                exact = false;
            }
        }
        Ok(false) => {}
        Err(_) => exact = false,
    }
    match Path::new(LABORATORY).try_exists() {
        Ok(true) if cleanup_owned_laboratory().is_err() => exact = false,
        Ok(_) => {}
        Err(_) => exact = false,
    }
    if exact && prove_fixed_residue_absent().is_ok() {
        Err(primary)
    } else {
        Err(KernelError::CleanupUncertain)
    }
}

fn cleanup_failed_tracer(
    tracer: &mut TrackedProcess,
    primary: KernelError,
) -> Result<(), KernelError> {
    let mut exact = recover_process(tracer).is_ok();
    match Path::new(CGROUP).try_exists() {
        Ok(true) => {
            let killed = fs::write(format!("{CGROUP}/cgroup.kill"), b"1\n").is_ok();
            let empty = wait_for_empty_cgroup().is_ok();
            let removed = fs::remove_dir(CGROUP).is_ok();
            if !killed || !empty || !removed {
                exact = false;
            }
        }
        Ok(false) => {}
        Err(_) => exact = false,
    }
    match Path::new(LABORATORY).try_exists() {
        Ok(true) if cleanup_owned_laboratory().is_err() => exact = false,
        Ok(_) => {}
        Err(_) => exact = false,
    }
    if exact && prove_fixed_residue_absent().is_ok() {
        Err(primary)
    } else {
        Err(KernelError::CleanupUncertain)
    }
}

fn encode_custody_report(leader: ProcessWitness, delegate: ProcessWitness) -> [u8; 32] {
    let mut bytes = [0_u8; 32];
    bytes[..8].copy_from_slice(b"WP200PFD");
    bytes[8..12].copy_from_slice(&leader.pid.to_le_bytes());
    bytes[12..20].copy_from_slice(&leader.start_time.to_le_bytes());
    bytes[20..24].copy_from_slice(&delegate.pid.to_le_bytes());
    bytes[24..32].copy_from_slice(&delegate.start_time.to_le_bytes());
    bytes
}

fn decode_custody_report(bytes: [u8; 32]) -> Result<(ProcessWitness, ProcessWitness), KernelError> {
    if &bytes[..8] != b"WP200PFD" {
        return Err(KernelError::ProcessMismatch);
    }
    let leader = ProcessWitness {
        pid: i32::from_le_bytes(
            bytes[8..12]
                .try_into()
                .map_err(|_| KernelError::ProcessMismatch)?,
        ),
        start_time: u64::from_le_bytes(
            bytes[12..20]
                .try_into()
                .map_err(|_| KernelError::ProcessMismatch)?,
        ),
    };
    let delegate = ProcessWitness {
        pid: i32::from_le_bytes(
            bytes[20..24]
                .try_into()
                .map_err(|_| KernelError::ProcessMismatch)?,
        ),
        start_time: u64::from_le_bytes(
            bytes[24..32]
                .try_into()
                .map_err(|_| KernelError::ProcessMismatch)?,
        ),
    };
    Ok((leader, delegate))
}

fn child_before_exec(gate_fd: i32) -> Result<(), KernelError> {
    linux_abi::read_gate(gate_fd).map_err(|_| KernelError::GateMismatch)?;
    linux_abi::unshare_child_mount_namespace()
        .map_err(|_| KernelError::ChildMountNamespaceMismatch)?;
    linux_abi::make_mounts_private_and_replace_proc()
        .map_err(|_| KernelError::ProcMountMismatch)?;
    assert_private_network()?;
    if !Path::new("/proc/1/status").is_file() {
        return Err(KernelError::ProcMismatch);
    }
    linux_abi::ptrace_traceme().map_err(|_| KernelError::TracemeMismatch)?;
    linux_abi::stop_self().map_err(|_| KernelError::TracemeMismatch)?;
    // The tracer verifies the stopped namespace/proc setup, then this is the only path to exec.
    drop_authority_before_exec()?;
    Ok(())
}

fn run_front_controller(behavior: FrontBehavior) -> Result<(), KernelError> {
    linux_abi::ignore_sigchld().map_err(|_| KernelError::ProtectionMismatch)?;
    restore_and_self_check_post_exec_protections()?;
    match linux_abi::fork_process()? {
        ForkOutcome::Child => {
            let role: &'static [u8] = if behavior == FrontBehavior::HoldAfterResume {
                b"delegate-held\0"
            } else {
                b"delegate\0"
            };
            let _ = linux_abi::exec_role(linux_abi::EXECUTABLE_FD, role);
            linux_abi::exit_immediately(111);
        }
        ForkOutcome::Parent(_) => {}
    }
    linux_abi::stop_self()?;
    if behavior == FrontBehavior::HoldAfterResume {
        linux_abi::write_all_bounded(STATUS_FD, b"L", WAIT_BOUND)?;
        loop {
            std::thread::park();
        }
    }
    if behavior == FrontBehavior::UnexpectedForkAfterResume {
        match linux_abi::fork_process()? {
            ForkOutcome::Child => linux_abi::exit_immediately(0),
            ForkOutcome::Parent(_) => {}
        }
    }
    Ok(())
}

fn run_delegate(hold_after_resume: bool) -> Result<(), KernelError> {
    restore_and_self_check_post_exec_protections()?;
    linux_abi::stop_self()?;
    if hold_after_resume {
        linux_abi::write_all_bounded(STATUS_FD, b"D", WAIT_BOUND)?;
        loop {
            std::thread::park();
        }
    }
    Ok(())
}

fn drop_authority_before_exec() -> Result<(), KernelError> {
    let cap_last = fs::read_to_string("/proc/sys/kernel/cap_last_cap")
        .map_err(|_| KernelError::ProtectionMismatch)?
        .trim()
        .parse::<u32>()
        .map_err(|_| KernelError::ProtectionMismatch)?;
    if cap_last > 255 {
        return Err(KernelError::ProtectionMismatch);
    }
    linux_abi::drop_authority_before_exec(cap_last).map_err(|_| KernelError::ProtectionMismatch)
}

fn restore_and_self_check_post_exec_protections() -> Result<(), KernelError> {
    linux_abi::restore_post_exec_dumpability().map_err(|_| KernelError::ProtectionMismatch)
}

fn verify_supervisor_boundary() -> Result<(), KernelError> {
    const REQUIRED_BOUNDING_CAPABILITIES: &str = "0000000080200000";
    let status =
        fs::read_to_string("/proc/self/status").map_err(|_| KernelError::ProtectionMismatch)?;
    let required = [
        ("CapInh", "0000000000000000"),
        ("CapPrm", REQUIRED_BOUNDING_CAPABILITIES),
        ("CapEff", REQUIRED_BOUNDING_CAPABILITIES),
        ("CapBnd", REQUIRED_BOUNDING_CAPABILITIES),
        ("CapAmb", "0000000000000000"),
        ("NoNewPrivs", "1"),
    ];
    for (key, expected) in required {
        let actual = status
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{key}:")))
            .map(str::trim)
            .ok_or(KernelError::ProtectionMismatch)?;
        if actual != expected {
            return Err(KernelError::ProtectionMismatch);
        }
    }
    Ok(())
}

fn create_intent(resources: &mut CaseResources) -> Result<(), KernelError> {
    fs::create_dir(LABORATORY).map_err(|_| KernelError::MachineMismatch)?;
    resources.laboratory_owned = true;
    write_synced_new_file(INTENT, b"openspell.synthetic-launch-intent.v1\n")?;
    File::open(LABORATORY_PARENT)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| KernelError::MachineMismatch)
}

fn create_terminal() -> Result<(), KernelError> {
    write_synced_new_file(TERMINAL, b"openspell.synthetic-terminal-proof.v1\n")
}

fn write_synced_new_file(path: &str, contents: &[u8]) -> Result<(), KernelError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| KernelError::MachineMismatch)?;
    file.write_all(contents)
        .map_err(|_| KernelError::MachineMismatch)?;
    file.sync_all().map_err(|_| KernelError::MachineMismatch)?;
    File::open(LABORATORY)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| KernelError::MachineMismatch)
}

fn cleanup_owned_laboratory() -> Result<(), KernelError> {
    let mut exact = true;
    for file in [TERMINAL, INTENT] {
        match fs::remove_file(file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => exact = false,
        }
    }
    if fs::remove_dir(LABORATORY).is_err() {
        exact = false;
    }
    if File::open(LABORATORY_PARENT)
        .and_then(|directory| directory.sync_all())
        .is_err()
    {
        exact = false;
    }
    if exact {
        Ok(())
    } else {
        Err(KernelError::CleanupUncertain)
    }
}

fn install_self_identity_map((uid, gid): (u32, u32)) -> Result<(), KernelError> {
    fs::write("/proc/self/setgroups", b"deny\n").map_err(|_| KernelError::IdentityMapMismatch)?;
    fs::write("/proc/self/uid_map", format!("0 {uid} 1\n"))
        .map_err(|_| KernelError::IdentityMapMismatch)?;
    fs::write("/proc/self/gid_map", format!("0 {gid} 1\n"))
        .map_err(|_| KernelError::IdentityMapMismatch)?;
    Ok(())
}

fn assert_private_network() -> Result<(), KernelError> {
    let names = fs::read_dir("/sys/class/net")
        .map_err(|_| KernelError::NetworkMismatch)?
        .map(|entry| {
            entry
                .map(|value| value.file_name())
                .map_err(|_| KernelError::NetworkMismatch)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if names.len() == 1 && names[0] == "lo" {
        Ok(())
    } else {
        Err(KernelError::NetworkMismatch)
    }
}

fn create_cgroup(resources: &mut CaseResources) -> Result<(), KernelError> {
    if fs::read_to_string("/proc/self/cgroup").map_err(|_| KernelError::CgroupMismatch)? != "0::/\n"
        || !Path::new("/sys/fs/cgroup/cgroup.controllers").is_file()
        || !Path::new("/sys/fs/cgroup/cgroup.kill").is_file()
    {
        return Err(KernelError::CgroupMismatch);
    }
    fs::create_dir(CGROUP).map_err(|_| KernelError::CgroupMismatch)?;
    resources.cgroup_owned = true;
    if !read_cgroup_pids()?.is_empty() {
        return Err(KernelError::CgroupMismatch);
    }
    Ok(())
}

fn write_cgroup_pid(pid: i32) -> Result<(), KernelError> {
    fs::write(format!("{CGROUP}/cgroup.procs"), format!("{pid}\n"))
        .map_err(|_| KernelError::CgroupMismatch)
}

fn read_cgroup_pids() -> Result<Vec<i32>, KernelError> {
    let mut pids = fs::read_to_string(format!("{CGROUP}/cgroup.procs"))
        .map_err(|_| KernelError::CgroupMismatch)?
        .lines()
        .map(|line| line.parse::<i32>().map_err(|_| KernelError::CgroupMismatch))
        .collect::<Result<Vec<_>, _>>()?;
    pids.sort_unstable();
    Ok(pids)
}

fn verify_cgroup_members(expected: &[i32]) -> Result<(), KernelError> {
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    if read_cgroup_pids()? != expected
        || expected.iter().any(|pid| {
            fs::read_to_string(format!("/proc/{pid}/cgroup"))
                .map(|value| value != "0::/openspell-wp200-proof\n")
                .unwrap_or(true)
        })
        || expected.contains(&linux_abi::current_pid())
    {
        Err(KernelError::CgroupMismatch)
    } else {
        Ok(())
    }
}

fn wait_for_empty_cgroup() -> Result<(), KernelError> {
    let deadline = Instant::now() + TERMINAL_BOUND;
    loop {
        if read_cgroup_pids()?.is_empty() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(KernelError::CleanupUncertain);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn prove_empty_cgroup_and_remove() -> Result<(), KernelError> {
    wait_for_empty_cgroup()?;
    fs::remove_dir(CGROUP).map_err(|_| KernelError::CleanupUncertain)
}

fn offer_expected(
    machine: &mut SyntheticProofMachine,
    expected: EffectKind,
) -> Result<Effect, KernelError> {
    let effect = machine.offer()?;
    if effect.kind() == expected {
        Ok(effect)
    } else {
        Err(KernelError::MachineMismatch)
    }
}

fn resolve_exact(machine: &mut SyntheticProofMachine, effect: Effect) -> Result<(), KernelError> {
    let kind = effect.kind();
    if matches!(
        machine.resolve(effect, EffectReply::Observed(Observation::exact(kind)))?,
        Progress::Advanced
    ) {
        Ok(())
    } else {
        Err(KernelError::MachineMismatch)
    }
}

fn resolve_or_inject(
    machine: &mut SyntheticProofMachine,
    effect: Effect,
    configured: Option<FaultPoint>,
    current: FaultPoint,
) -> Result<bool, KernelError> {
    if configured == Some(current) {
        let progress = machine.resolve(effect, EffectReply::LostAfterAcceptance)?;
        assert_recovery(progress, machine.result())?;
        Ok(true)
    } else {
        resolve_exact(machine, effect)?;
        Ok(false)
    }
}

fn bootstrap_continue(effect: &Effect, pid: i32) -> Result<(), KernelError> {
    if !effect.carries_bootstrap_permit() {
        return Err(KernelError::MachineMismatch);
    }
    linux_abi::ptrace_continue(pid).map_err(Into::into)
}

fn resume_continue(effect: &Effect, pid: i32) -> Result<(), KernelError> {
    if !effect.carries_resume_permit() {
        return Err(KernelError::MachineMismatch);
    }
    linux_abi::ptrace_continue(pid).map_err(Into::into)
}

fn wait(pid: i32) -> Result<WaitEvent, KernelError> {
    linux_abi::wait_for_pid(pid, WAIT_BOUND).map_err(Into::into)
}

fn expect_plain_stop(event: WaitEvent, signal: i32) -> Result<(), KernelError> {
    if matches!(
        event.kind,
        WaitKind::Stopped {
            signal: actual,
            event: 0
        } if actual == signal
    ) {
        Ok(())
    } else {
        Err(KernelError::PtraceMismatch)
    }
}

fn expect_ptrace_event(event: WaitEvent, expected: u32) -> Result<(), KernelError> {
    if matches!(
        event.kind,
        WaitKind::Stopped { signal, event } if signal == linux_abi::TRAP_SIGNAL && event == expected
    ) {
        Ok(())
    } else {
        Err(KernelError::PtraceMismatch)
    }
}

fn wait_successful_exit(process: &mut TrackedProcess) -> Result<(), KernelError> {
    match wait(process.pid)?.kind {
        WaitKind::Exited(0) => process.reaped = true,
        WaitKind::Stopped { .. } => return Err(KernelError::UnexpectedPostResumeEvent),
        WaitKind::Exited(_) | WaitKind::Signaled(_) => {
            return Err(KernelError::ProcessMismatch);
        }
    }
    process.verify_terminal()
}

fn recover_process(process: &mut TrackedProcess) -> Result<(), KernelError> {
    if !linux_abi::pidfd_is_terminal(process.pidfd.as_raw_fd(), Duration::ZERO)?
        && linux_abi::signal_pidfd(process.pidfd.as_raw_fd(), libc::SIGKILL).is_err()
        && !linux_abi::pidfd_is_terminal(process.pidfd.as_raw_fd(), Duration::ZERO)?
    {
        return Err(KernelError::CleanupUncertain);
    }
    let deadline = Instant::now() + TERMINAL_BOUND;
    while !process.reaped && Instant::now() < deadline {
        match linux_abi::wait_for_pid(process.pid, Duration::from_millis(5)) {
            Ok(WaitEvent {
                kind: WaitKind::Exited(_) | WaitKind::Signaled(_),
                ..
            }) => process.reaped = true,
            Ok(WaitEvent {
                kind: WaitKind::Stopped { .. },
                ..
            }) => {
                let _ = linux_abi::signal_pidfd(process.pidfd.as_raw_fd(), libc::SIGKILL);
                let _ = linux_abi::ptrace_continue(process.pid);
            }
            Err(linux_abi::AbiError::DeadlineExceeded) => {}
            Err(_) if linux_abi::pidfd_is_terminal(process.pidfd.as_raw_fd(), Duration::ZERO)? => {
                break;
            }
            Err(_) => return Err(KernelError::CleanupUncertain),
        }
    }
    process.verify_terminal()
}

fn retain_unexpected_descendant(
    resources: &mut CaseResources,
    pid: i32,
) -> Result<(), KernelError> {
    if pid <= 0
        || resources.leader()?.pid == pid
        || resources.delegate()?.pid == pid
        || resources
            .unexpected_descendants
            .iter()
            .any(|process| process.pid == pid)
    {
        return Err(KernelError::UnexpectedPostResumeEvent);
    }
    let mut process = TrackedProcess::acquired(pid, linux_abi::open_pidfd(pid)?);
    process.attest_live()?;
    resources.unexpected_descendants.push(process);
    Ok(())
}

fn prove_fixed_residue_absent() -> Result<(), KernelError> {
    for path in [CGROUP, LABORATORY, INTENT, TERMINAL] {
        if !matches!(Path::new(path).try_exists(), Ok(false)) {
            return Err(KernelError::CleanupUncertain);
        }
    }
    Ok(())
}

fn read_start_time(pid: i32) -> Result<u64, KernelError> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_err(|_| KernelError::ProcessMismatch)?;
    let (_, suffix) = stat.rsplit_once(") ").ok_or(KernelError::ProcessMismatch)?;
    suffix
        .split_ascii_whitespace()
        .nth(19)
        .ok_or(KernelError::ProcessMismatch)?
        .parse::<u64>()
        .map_err(|_| KernelError::ProcessMismatch)
}

fn identity(path: impl AsRef<Path>) -> Result<FileIdentity, KernelError> {
    let metadata = fs::metadata(path).map_err(|_| KernelError::ExecutableMismatch)?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[derive(Debug, Clone, Copy)]
enum MappingStage {
    ExecStop,
    ReadyStop,
}

fn align_down(value: u64) -> u64 {
    value & !(PAGE_SIZE - 1)
}

fn align_up(value: u64) -> Result<u64, KernelError> {
    value
        .checked_add(PAGE_SIZE - 1)
        .map(align_down)
        .ok_or(KernelError::MappingMismatch)
}

fn device_major(device: u64) -> u64 {
    ((device >> 8) & 0xfff) | ((device >> 32) & 0xffff_f000)
}

fn device_minor(device: u64) -> u64 {
    (device & 0xff) | ((device >> 12) & 0xffff_ff00)
}

fn parse_mapping_device(value: &str) -> Result<(u64, u64), KernelError> {
    let (major, minor) = value.split_once(':').ok_or(KernelError::MappingMismatch)?;
    Ok((
        u64::from_str_radix(major, 16).map_err(|_| KernelError::MappingMismatch)?,
        u64::from_str_radix(minor, 16).map_err(|_| KernelError::MappingMismatch)?,
    ))
}

fn mapped_file_records(
    pid: i32,
    expected: &RuntimeInventory,
) -> Result<Vec<FileMappingRecord>, KernelError> {
    let maps = fs::read_to_string(format!("/proc/{pid}/maps"))
        .map_err(|_| KernelError::ExecutableMismatch)?;
    if maps.len() > MAX_MAPPING_BYTES {
        return Err(KernelError::MappingMismatch);
    }
    let mut files = Vec::new();
    let mut line_count = 0_usize;
    for line in maps.lines() {
        line_count += 1;
        if line_count > MAX_MAPPING_LINES || line.len() > 4096 {
            return Err(KernelError::MappingMismatch);
        }
        let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
        if fields.len() < 5 {
            return Err(KernelError::ExecutableMismatch);
        }
        let permissions = fields[1];
        let permission_bytes = permissions.as_bytes();
        if permission_bytes.len() != 4
            || !matches!(permission_bytes[0], b'r' | b'-')
            || !matches!(permission_bytes[1], b'w' | b'-')
            || !matches!(permission_bytes[2], b'x' | b'-')
            || permission_bytes[3] != b'p'
        {
            return Err(KernelError::MappingMismatch);
        }
        let readable = permission_bytes[0] == b'r';
        let writable = permission_bytes[1] == b'w';
        let executable = permission_bytes[2] == b'x';
        if writable && executable {
            return Err(KernelError::ExecutableMismatch);
        }
        let (first_address, last_address) = fields[0]
            .split_once('-')
            .ok_or(KernelError::MappingMismatch)?;
        let first_address =
            u64::from_str_radix(first_address, 16).map_err(|_| KernelError::MappingMismatch)?;
        let last_address =
            u64::from_str_radix(last_address, 16).map_err(|_| KernelError::MappingMismatch)?;
        let length = last_address
            .checked_sub(first_address)
            .filter(|length| *length > 0 && *length % PAGE_SIZE == 0)
            .ok_or(KernelError::MappingMismatch)?;
        let offset =
            u64::from_str_radix(fields[2], 16).map_err(|_| KernelError::MappingMismatch)?;
        if offset % PAGE_SIZE != 0 {
            return Err(KernelError::MappingMismatch);
        }

        if fields.get(5).is_some_and(|path| path.starts_with('/')) {
            if fields.len() != 6 || line.ends_with(" (deleted)") {
                return Err(KernelError::ExecutableMismatch);
            }
            let inode = fields[4]
                .parse::<u64>()
                .map_err(|_| KernelError::MappingMismatch)?;
            let (major, minor) = parse_mapping_device(fields[3])?;
            if inode == 0
                || inode != expected.executable.inode
                || major != device_major(expected.executable.device)
                || minor != device_minor(expected.executable.device)
            {
                return Err(KernelError::MappingExtra);
            }
            let record = FileMappingRecord {
                offset,
                length,
                readable,
                writable,
                executable,
                private: true,
                identity: expected.executable,
            };
            if !mapping_matches_allowed_load(&record, &expected.loads) {
                return Err(KernelError::MappingExtra);
            }
            files.push(record);
        } else if executable && !matches!(fields.get(5), Some(&"[vdso]") | Some(&"[vsyscall]")) {
            return Err(KernelError::MappingMismatch);
        }
    }
    if files.is_empty() {
        return Err(KernelError::MappingMissing);
    }
    for load in &expected.loads {
        if !files.iter().any(|record| {
            record.offset < load.after_last_file_page
                && record.offset.saturating_add(record.length) > load.first_file_page
        }) {
            return Err(KernelError::MappingMissing);
        }
    }
    Ok(files)
}

fn mapping_matches_allowed_load(record: &FileMappingRecord, loads: &[AllowedLoadSegment]) -> bool {
    let Some(end) = record.offset.checked_add(record.length) else {
        return false;
    };
    loads.iter().any(|load| {
        record.offset >= load.first_file_page
            && end <= load.after_last_file_page
            && record.readable == load.readable
            && (!record.writable || load.writable)
            && record.executable == load.executable
    })
}

fn expected_exec_records(runtime: &RuntimeInventory) -> Vec<FileMappingRecord> {
    runtime
        .loads
        .iter()
        .map(|load| FileMappingRecord {
            offset: load.first_file_page,
            length: load.after_last_file_page - load.first_file_page,
            readable: load.readable,
            writable: load.writable,
            executable: load.executable,
            private: true,
            identity: runtime.executable,
        })
        .collect()
}

fn attest_exec_stop(
    runtime: &RuntimeInventory,
    process: &TrackedProcess,
    stage: MappingStage,
) -> Result<Vec<FileMappingRecord>, KernelError> {
    process.verify_identity()?;
    verify_runtime_identity(runtime, process.pid)?;
    let records = mapped_file_records(process.pid, runtime)?;
    let expected = match stage {
        MappingStage::ExecStop => expected_exec_records(runtime),
        MappingStage::ReadyStop => runtime.ready_records.clone(),
    };
    if records != expected {
        return Err(match records.len().cmp(&expected.len()) {
            std::cmp::Ordering::Less => KernelError::MappingMissing,
            std::cmp::Ordering::Greater => KernelError::MappingExtra,
            std::cmp::Ordering::Equal => KernelError::MappingMismatch,
        });
    }
    Ok(records)
}

fn capture_runtime_inventory(pid: i32) -> Result<RuntimeInventory, KernelError> {
    let executable_link = format!("/proc/{pid}/exe");
    let mut executable_file =
        File::open(&executable_link).map_err(|_| KernelError::ExecutableMismatch)?;
    let metadata = executable_file
        .metadata()
        .map_err(|_| KernelError::ExecutableMismatch)?;
    if metadata.len() == 0 || metadata.len() > MAX_EXECUTABLE_BYTES {
        return Err(KernelError::ExecutableMismatch);
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len()).map_err(|_| KernelError::ExecutableMismatch)?,
    );
    executable_file
        .read_to_end(&mut bytes)
        .map_err(|_| KernelError::ExecutableMismatch)?;
    if u64::try_from(bytes.len()).map_err(|_| KernelError::ExecutableMismatch)? != metadata.len() {
        return Err(KernelError::ExecutableMismatch);
    }
    let elf = Elf::parse(&bytes).map_err(|_| KernelError::ExecutableMismatch)?;
    if elf.header.e_type != ET_DYN || elf.interpreter.is_some() || !elf.libraries.is_empty() {
        return Err(KernelError::ExecutableMismatch);
    }
    let mut loads = Vec::new();
    for header in elf
        .program_headers
        .iter()
        .filter(|header| header.p_type == PT_LOAD && header.p_filesz > 0)
    {
        if header.p_memsz < header.p_filesz
            || header.p_offset % PAGE_SIZE != header.p_vaddr % PAGE_SIZE
        {
            return Err(KernelError::ExecutableMismatch);
        }
        let first_file_page = align_down(header.p_offset);
        let after_last_file_page = align_up(
            header
                .p_offset
                .checked_add(header.p_filesz)
                .ok_or(KernelError::ExecutableMismatch)?,
        )?;
        loads.push(AllowedLoadSegment {
            first_file_page,
            after_last_file_page,
            readable: header.p_flags & PF_R != 0,
            writable: header.p_flags & PF_W != 0,
            executable: header.p_flags & PF_X != 0,
        });
    }
    if loads.is_empty()
        || loads
            .windows(2)
            .any(|pair| pair[0].first_file_page >= pair[1].first_file_page)
    {
        return Err(KernelError::ExecutableMismatch);
    }
    let mut runtime = RuntimeInventory {
        executable: FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        },
        root: identity(format!("/proc/{pid}/root"))?,
        loads,
        ready_records: Vec::new(),
    };
    runtime.ready_records = mapped_file_records(pid, &runtime)?;
    Ok(runtime)
}

fn verify_runtime_identity(expected: &RuntimeInventory, pid: i32) -> Result<(), KernelError> {
    if identity(format!("/proc/{pid}/exe"))? != expected.executable {
        return Err(KernelError::ExecutableIdentityMismatch);
    }
    if identity(format!("/proc/{pid}/root"))? != expected.root {
        return Err(KernelError::RootIdentityMismatch);
    }
    Ok(())
}

fn namespace_path(pid: Option<i32>, name: &'static str) -> Result<PathBuf, KernelError> {
    let path = pid.map_or_else(
        || format!("/proc/self/ns/{name}"),
        |value| format!("/proc/{value}/ns/{name}"),
    );
    fs::read_link(path).map_err(|_| KernelError::NamespaceReadMismatch)
}

fn capture_self_namespace_inventory() -> Result<BTreeMap<&'static str, PathBuf>, KernelError> {
    ["mnt", "pid", "user", "ipc", "uts", "net"]
        .into_iter()
        .map(|name| namespace_path(None, name).map(|value| (name, value)))
        .collect()
}

fn verify_supervisor_namespaces(inventory: &NamespaceInventory) -> Result<(), KernelError> {
    for name in ["mnt", "user", "ipc", "uts", "net"] {
        if inventory.outer.get(name) == inventory.private.get(name) {
            return Err(KernelError::SupervisorNamespaceMismatch);
        }
    }
    Ok(())
}

fn verify_stopped_leader_namespaces(
    inventory: &NamespaceInventory,
    leader: i32,
) -> Result<(), KernelError> {
    if namespace_path(Some(leader), "mnt").map_err(|_| KernelError::ChildMountNamespaceMismatch)?
        == inventory.private["mnt"]
    {
        return Err(KernelError::ChildMountNamespaceMismatch);
    }
    for name in ["user", "ipc", "uts", "net"] {
        if namespace_path(Some(leader), name).map_err(|_| KernelError::NamespaceReadMismatch)?
            != inventory.private[name]
        {
            return Err(KernelError::NamespaceReadMismatch);
        }
    }
    if namespace_path(Some(leader), "pid").map_err(|_| KernelError::NamespaceReadMismatch)?
        != inventory.child_pid
    {
        return Err(KernelError::ChildPidNamespaceMismatch);
    }
    let mounts = fs::read_to_string(format!("/proc/{leader}/mountinfo"))
        .map_err(|_| KernelError::ProcMismatch)?;
    if !mounts
        .lines()
        .any(|line| line.contains(" /proc ") && line.contains(" - proc proc "))
        || !Path::new(&format!("/proc/{leader}/root/proc/1/status")).is_file()
    {
        return Err(KernelError::ProcMismatch);
    }
    Ok(())
}

fn verify_child_namespaces(
    inventory: &NamespaceInventory,
    leader: i32,
    delegate: i32,
) -> Result<(), KernelError> {
    let leader_mount = namespace_path(Some(leader), "mnt")
        .map_err(|_| KernelError::ChildMountNamespaceMismatch)?;
    if leader_mount == inventory.private["mnt"]
        || namespace_path(Some(delegate), "mnt")
            .map_err(|_| KernelError::ChildMountNamespaceMismatch)?
            != leader_mount
    {
        return Err(KernelError::ChildMountNamespaceMismatch);
    }
    for pid in [leader, delegate] {
        for name in ["user", "ipc", "uts", "net"] {
            let mismatch = match name {
                "mnt" => KernelError::ChildMountNamespaceMismatch,
                "user" => KernelError::ChildUserNamespaceMismatch,
                "ipc" => KernelError::ChildIpcNamespaceMismatch,
                "uts" => KernelError::ChildUtsNamespaceMismatch,
                "net" => KernelError::ChildNetworkNamespaceMismatch,
                _ => KernelError::NamespaceReadMismatch,
            };
            if namespace_path(Some(pid), name).map_err(|_| mismatch)? != inventory.private[name] {
                return Err(mismatch);
            }
        }
        if namespace_path(Some(pid), "pid").map_err(|_| KernelError::NamespaceReadMismatch)?
            != inventory.child_pid
        {
            return Err(if pid == leader {
                KernelError::LeaderPidNamespaceMismatch
            } else {
                KernelError::DelegatePidNamespaceMismatch
            });
        }
    }
    let leader_mounts = fs::read_to_string(format!("/proc/{leader}/mountinfo"))
        .map_err(|_| KernelError::ProcMismatch)?;
    let proc_mounts = leader_mounts
        .lines()
        .filter(|line| line.contains(" /proc ") && line.contains(" - proc proc "))
        .count();
    if proc_mounts == 0 || !Path::new(&format!("/proc/{leader}/root/proc/1/status")).is_file() {
        return Err(KernelError::ProcMismatch);
    }
    Ok(())
}

fn verify_process_protections(process: &TrackedProcess) -> Result<(), KernelError> {
    process.verify_identity()?;
    let status = fs::read_to_string(format!("/proc/{}/status", process.pid))
        .map_err(|_| KernelError::ProtectionMismatch)?;
    let required = [
        ("CapInh", "0000000000000000"),
        ("CapPrm", "0000000000000000"),
        ("CapEff", "0000000000000000"),
        ("CapBnd", "0000000000000000"),
        ("CapAmb", "0000000000000000"),
        ("NoNewPrivs", "1"),
        ("Seccomp", "2"),
        ("CoreDumping", "0"),
    ];
    for (key, expected) in required {
        let actual = status
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{key}:")))
            .map(str::trim)
            .ok_or(KernelError::ProtectionMismatch)?;
        if actual != expected {
            return Err(KernelError::ProtectionMismatch);
        }
    }
    for key in ["Uid", "Gid"] {
        let values = status
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{key}:")))
            .ok_or(KernelError::ProtectionMismatch)?
            .split_ascii_whitespace()
            .collect::<Vec<_>>();
        if values != ["0", "0", "0", "0"] {
            return Err(KernelError::ProtectionMismatch);
        }
    }
    let limits = fs::read_to_string(format!("/proc/{}/limits", process.pid))
        .map_err(|_| KernelError::ProtectionMismatch)?;
    let core = limits
        .lines()
        .find(|line| line.starts_with("Max core file size"))
        .ok_or(KernelError::ProtectionMismatch)?
        .split_ascii_whitespace()
        .collect::<Vec<_>>();
    if core.get(4) != Some(&"0") || core.get(5) != Some(&"0") {
        return Err(KernelError::ProtectionMismatch);
    }
    Ok(())
}

fn verify_prebootstrap_authority(process: &TrackedProcess) -> Result<(), KernelError> {
    process.verify_identity()?;
    let status = fs::read_to_string(format!("/proc/{}/status", process.pid))
        .map_err(|_| KernelError::ProtectionMismatch)?;
    for (key, expected) in [
        ("CapInh", "0000000000000000"),
        ("CapPrm", "0000000000000000"),
        ("CapEff", "0000000000000000"),
        ("CapBnd", "0000000000000000"),
        ("CapAmb", "0000000000000000"),
        ("NoNewPrivs", "1"),
        ("Seccomp", "2"),
        ("CoreDumping", "0"),
    ] {
        let actual = status
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{key}:")))
            .map(str::trim)
            .ok_or(KernelError::ProtectionMismatch)?;
        if actual != expected {
            return Err(KernelError::ProtectionMismatch);
        }
    }
    let limits = fs::read_to_string(format!("/proc/{}/limits", process.pid))
        .map_err(|_| KernelError::ProtectionMismatch)?;
    let core = limits
        .lines()
        .find(|line| line.starts_with("Max core file size"))
        .ok_or(KernelError::ProtectionMismatch)?
        .split_ascii_whitespace()
        .collect::<Vec<_>>();
    if core.get(4) != Some(&"0") || core.get(5) != Some(&"0") {
        return Err(KernelError::ProtectionMismatch);
    }
    Ok(())
}
