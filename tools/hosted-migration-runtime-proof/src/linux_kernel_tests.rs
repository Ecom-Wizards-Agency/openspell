#![allow(dead_code)]
#![deny(unsafe_code)]

#[path = "linux_abi.rs"]
mod linux_abi;
#[path = "machine.rs"]
mod machine;

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use linux_abi::{CloneOutcome, ForkOutcome, WaitEvent, WaitKind};
use machine::{
    Effect, EffectKind, EffectReply, Observation, Progress, ProofRefusal, ProofResult,
    SyntheticProofMachine, VerifiedSyntheticCase,
};

const WAIT_BOUND: Duration = Duration::from_secs(8);
const TERMINAL_BOUND: Duration = Duration::from_secs(4);
const LABORATORY: &str = "/tmp/openspell-wp200-proof";
const INTENT: &str = "/tmp/openspell-wp200-proof/intent";
const TERMINAL: &str = "/tmp/openspell-wp200-proof/terminal";
const CGROUP: &str = "/sys/fs/cgroup/openspell-wp200-proof";

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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[derive(Debug)]
struct RuntimeInventory {
    executable: FileIdentity,
    root: FileIdentity,
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
    start_time: u64,
}

impl TrackedProcess {
    fn new(pid: i32, pidfd: OwnedFd) -> Result<Self, KernelError> {
        if linux_abi::pidfd_is_terminal(pidfd.as_raw_fd(), Duration::ZERO)? {
            return Err(KernelError::ProcessMismatch);
        }
        Ok(Self {
            pid,
            pidfd,
            start_time: read_start_time(pid)?,
        })
    }

    fn verify_identity(&self) -> Result<(), KernelError> {
        if read_start_time(self.pid)? == self.start_time
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
}

struct PreparedCase {
    machine: SyntheticProofMachine,
    leader: TrackedProcess,
    delegate: TrackedProcess,
}

fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    let status = match arguments.as_slice() {
        [_, mode] if mode == "success" => run_scenario(Scenario::Success),
        [_, mode] if mode == "refusal" => run_scenario(Scenario::Refusal),
        [_, mode] if mode == "timeout" => run_scenario(Scenario::Timeout),
        [_, mode] if mode == "interruption" => run_scenario(Scenario::Interruption),
        [_, mode] if mode == "tracer-death" => run_tracer_death(),
        [_, mode] if mode == "front" => run_front_controller(),
        [_, mode] if mode == "delegate" => run_delegate(),
        _ => Err(KernelError::ProcessMismatch),
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
        Ok(()) if matches!(arguments.get(1).map(String::as_str), Some("tracer-death")) => {
            println!("openspell synthetic kernel proof: tracer-death exitkill=1 residue=0");
        }
        Ok(()) => linux_abi::exit_immediately(0),
        Err(error) => {
            eprintln!("openspell synthetic kernel proof refused: {error:?}");
            linux_abi::exit_immediately(111);
        }
    }
}

fn run_scenario(scenario: Scenario) -> Result<(), KernelError> {
    let mut prepared = prepare_case()?;
    match scenario {
        Scenario::Success => finish_success(&mut prepared)?,
        Scenario::Refusal => finish_refusal(&mut prepared)?,
        Scenario::Timeout => finish_timeout(&mut prepared)?,
        Scenario::Interruption => finish_interruption(&mut prepared)?,
    }
    cleanup_laboratory()?;
    Ok(())
}

fn prepare_case() -> Result<PreparedCase, KernelError> {
    let runtime = capture_runtime_inventory(linux_abi::current_pid())?;
    let mut namespaces = NamespaceInventory {
        outer: capture_self_namespace_inventory()
            .map_err(|_| KernelError::SupervisorNamespaceReadMismatch)?,
        private: BTreeMap::new(),
        child_pid: PathBuf::new(),
    };
    let outer_ids = linux_abi::current_ids();
    let mut machine = SyntheticProofMachine::begin(VerifiedSyntheticCase::sealed_fixture());

    let intent_effect = offer_expected(&mut machine, EffectKind::PersistLaunchIntent)?;
    create_intent()?;
    resolve_exact(&mut machine, intent_effect)?;

    let namespace_effect = offer_expected(&mut machine, EffectKind::EstablishPrivateNamespaces)?;
    linux_abi::unshare_proof_namespaces()?;
    install_self_identity_map(outer_ids)?;
    linux_abi::enable_supervisor_proc_inspection()?;
    linux_abi::set_fixed_hostname()?;
    assert_private_network()?;
    namespaces.private = capture_self_namespace_inventory()
        .map_err(|_| KernelError::SupervisorNamespaceReadMismatch)?;
    verify_supervisor_namespaces(&namespaces)?;
    resolve_exact(&mut machine, namespace_effect)?;

    let cgroup_effect = offer_expected(&mut machine, EffectKind::EstablishExclusiveChildCgroup)?;
    create_cgroup().map_err(|_| KernelError::CgroupCreateMismatch)?;
    resolve_exact(&mut machine, cgroup_effect)?;

    let executable = File::open("/proc/self/exe").map_err(|_| KernelError::ExecutableMismatch)?;
    let fixed_executable = linux_abi::duplicate_executable_fd(executable.as_raw_fd())?;
    let gate = linux_abi::make_pipe()?;
    let spawn_effect = offer_expected(&mut machine, EffectKind::SpawnStoppedLeaderAndOpenPidfd)?;
    let leader = match linux_abi::clone_with_pidfd()? {
        CloneOutcome::Child => {
            drop(gate.write);
            let child_result = child_before_exec(gate.read.as_raw_fd());
            drop(gate.read);
            if let Err(error) = child_result {
                eprintln!("openspell synthetic child refused: {error:?}");
                linux_abi::exit_immediately(111);
            }
            let _ = linux_abi::exec_role(linux_abi::EXECUTABLE_FD, b"front\0");
            linux_abi::exit_immediately(111);
        }
        CloneOutcome::Parent { pid, pidfd } => {
            drop(gate.read);
            write_cgroup_pid(pid).map_err(|_| KernelError::LeaderCgroupMismatch)?;
            linux_abi::write_gate(gate.write.as_raw_fd())?;
            drop(gate.write);
            TrackedProcess::new(pid, pidfd)?
        }
    };
    drop(fixed_executable);
    verify_cgroup_members(&[leader.pid]).map_err(|_| KernelError::LeaderCgroupMismatch)?;
    resolve_exact(&mut machine, spawn_effect)?;

    let custody_effect = offer_expected(
        &mut machine,
        EffectKind::EstablishPtraceAndDescendantCustody,
    )?;
    expect_plain_stop(wait(leader.pid)?, linux_abi::STOP_SIGNAL)
        .map_err(|_| KernelError::LeaderInitialStopMismatch)?;
    namespaces.child_pid = namespace_path(Some(leader.pid), "pid")
        .map_err(|_| KernelError::ChildPidNamespaceMismatch)?;
    if namespaces.outer.get("pid") == Some(&namespaces.child_pid) {
        return Err(KernelError::ChildPidNamespaceMismatch);
    }
    linux_abi::ptrace_set_fixed_options(leader.pid)?;
    linux_abi::ptrace_continue(leader.pid)?;
    expect_ptrace_event(wait(leader.pid)?, linux_abi::EVENT_EXEC)
        .map_err(|_| KernelError::LeaderExecStopMismatch)?;
    leader.verify_identity()?;
    linux_abi::ptrace_continue(leader.pid)?;
    expect_ptrace_event(wait(leader.pid)?, linux_abi::EVENT_FORK)
        .map_err(|_| KernelError::ForkStopMismatch)?;
    let delegate_pid = linux_abi::ptrace_event_pid(leader.pid)?;
    let delegate = TrackedProcess::new(delegate_pid, linux_abi::open_pidfd(delegate_pid)?)?;
    expect_plain_stop(wait(delegate.pid)?, linux_abi::STOP_SIGNAL)
        .map_err(|_| KernelError::DelegateInitialStopMismatch)?;
    verify_cgroup_members(&[leader.pid, delegate.pid])
        .map_err(|_| KernelError::DescendantCgroupMismatch)?;
    verify_child_namespaces(&namespaces, leader.pid, delegate.pid)?;
    resolve_exact(&mut machine, custody_effect)?;

    let exec_effect = offer_expected(&mut machine, EffectKind::AttestExecsAndMaps)?;
    linux_abi::ptrace_continue(delegate.pid)?;
    expect_ptrace_event(wait(delegate.pid)?, linux_abi::EVENT_EXEC)
        .map_err(|_| KernelError::DelegateExecStopMismatch)?;
    delegate.verify_identity()?;
    linux_abi::ptrace_continue(delegate.pid)?;
    expect_plain_stop(wait(delegate.pid)?, linux_abi::STOP_SIGNAL)
        .map_err(|_| KernelError::DelegateReadyStopMismatch)?;
    linux_abi::ptrace_continue(leader.pid)?;
    expect_plain_stop(wait(leader.pid)?, linux_abi::STOP_SIGNAL)
        .map_err(|_| KernelError::LeaderReadyStopMismatch)?;
    verify_runtime_identity(&runtime, leader.pid)?;
    verify_runtime_identity(&runtime, delegate.pid)?;
    if mapped_files(leader.pid)? != mapped_files(delegate.pid)? {
        return Err(KernelError::MappingMismatch);
    }
    resolve_exact(&mut machine, exec_effect)?;

    let protection_effect = offer_expected(&mut machine, EffectKind::AttestProcessProtections)?;
    verify_process_protections(&leader)?;
    verify_process_protections(&delegate)?;
    verify_cgroup_members(&[leader.pid, delegate.pid])?;
    resolve_exact(&mut machine, protection_effect)?;

    Ok(PreparedCase {
        machine,
        leader,
        delegate,
    })
}

fn finish_success(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let resume = offer_expected(&mut prepared.machine, EffectKind::ResumeVerifiedProcesses)?;
    if !resume.carries_resume_permit() {
        return Err(KernelError::MachineMismatch);
    }
    linux_abi::ptrace_continue(prepared.delegate.pid)?;
    linux_abi::ptrace_continue(prepared.leader.pid)?;
    resolve_exact(&mut prepared.machine, resume)?;

    let drain = offer_expected(&mut prepared.machine, EffectKind::DrainDescendants)?;
    wait_successful_exit(&prepared.delegate)?;
    resolve_exact(&mut prepared.machine, drain)?;

    let terminal = offer_expected(
        &mut prepared.machine,
        EffectKind::ObserveTerminalAndEmptyCgroup,
    )?;
    wait_successful_exit(&prepared.leader)?;
    prove_empty_cgroup_and_remove()?;
    resolve_exact(&mut prepared.machine, terminal)?;

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
    Ok(())
}

fn finish_refusal(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    let resume = offer_expected(&mut prepared.machine, EffectKind::ResumeVerifiedProcesses)?;
    let progress = prepared.machine.resolve(resume, EffectReply::Refused)?;
    assert_recovery(progress, prepared.machine.result())?;
    terminate_case(prepared)?;
    Ok(())
}

fn finish_timeout(prepared: &mut PreparedCase) -> Result<(), KernelError> {
    std::thread::sleep(Duration::from_millis(5));
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

fn terminate_case(prepared: &PreparedCase) -> Result<(), KernelError> {
    fs::write(format!("{CGROUP}/cgroup.kill"), b"1\n")
        .map_err(|_| KernelError::CleanupUncertain)?;
    wait_killed_exit(&prepared.delegate)?;
    wait_killed_exit(&prepared.leader)?;
    prove_empty_cgroup_and_remove()?;
    Ok(())
}

fn run_tracer_death() -> Result<(), KernelError> {
    let gate = linux_abi::make_pipe()?;
    let tracer = match linux_abi::fork_process()? {
        ForkOutcome::Child => {
            drop(gate.read);
            let prepared = prepare_case();
            if prepared.is_err() || linux_abi::write_gate(gate.write.as_raw_fd()).is_err() {
                linux_abi::exit_immediately(111);
            }
            drop(gate.write);
            loop {
                std::thread::park();
            }
        }
        ForkOutcome::Parent(pid) => {
            drop(gate.write);
            let handle = TrackedProcess::new(pid, linux_abi::open_pidfd(pid)?)?;
            linux_abi::read_gate(gate.read.as_raw_fd())?;
            drop(gate.read);
            handle
        }
    };

    linux_abi::signal_pidfd(tracer.pidfd.as_raw_fd(), libc::SIGKILL)?;
    match wait(tracer.pid)? {
        WaitEvent {
            kind: WaitKind::Signaled(signal),
            ..
        } if signal == libc::SIGKILL => {}
        _ => return Err(KernelError::ProcessMismatch),
    }
    tracer.verify_terminal()?;
    wait_for_empty_cgroup()?;
    fs::remove_dir(CGROUP).map_err(|_| KernelError::CleanupUncertain)?;
    cleanup_laboratory()?;
    Ok(())
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
    Ok(())
}

fn run_front_controller() -> Result<(), KernelError> {
    install_and_self_check_protections()?;
    let delegate = match linux_abi::fork_process()? {
        ForkOutcome::Child => {
            let _ = linux_abi::exec_role(linux_abi::EXECUTABLE_FD, b"delegate\0");
            linux_abi::exit_immediately(111);
        }
        ForkOutcome::Parent(pid) => pid,
    };
    linux_abi::stop_self()?;
    linux_abi::wait_child_success(delegate)?;
    Ok(())
}

fn run_delegate() -> Result<(), KernelError> {
    install_and_self_check_protections()?;
    linux_abi::stop_self()?;
    Ok(())
}

fn install_and_self_check_protections() -> Result<(), KernelError> {
    let cap_last = fs::read_to_string("/proc/sys/kernel/cap_last_cap")
        .map_err(|_| KernelError::ProtectionMismatch)?
        .trim()
        .parse::<u32>()
        .map_err(|_| KernelError::ProtectionMismatch)?;
    if cap_last > 255 {
        return Err(KernelError::ProtectionMismatch);
    }
    linux_abi::install_process_protections(cap_last).map_err(|_| KernelError::ProtectionMismatch)
}

fn create_intent() -> Result<(), KernelError> {
    fs::create_dir(LABORATORY).map_err(|_| KernelError::MachineMismatch)?;
    write_synced_new_file(INTENT, b"openspell.synthetic-launch-intent.v1\n")
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

fn cleanup_laboratory() -> Result<(), KernelError> {
    for file in [TERMINAL, INTENT] {
        match fs::remove_file(file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(KernelError::CleanupUncertain),
        }
    }
    fs::remove_dir(LABORATORY).map_err(|_| KernelError::CleanupUncertain)
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

fn create_cgroup() -> Result<(), KernelError> {
    if fs::read_to_string("/proc/self/cgroup").map_err(|_| KernelError::CgroupMismatch)? != "0::/\n"
        || !Path::new("/sys/fs/cgroup/cgroup.controllers").is_file()
        || !Path::new("/sys/fs/cgroup/cgroup.kill").is_file()
    {
        return Err(KernelError::CgroupMismatch);
    }
    fs::create_dir(CGROUP).map_err(|_| KernelError::CgroupMismatch)?;
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

fn wait_successful_exit(process: &TrackedProcess) -> Result<(), KernelError> {
    loop {
        match wait(process.pid)?.kind {
            WaitKind::Exited(0) => break,
            WaitKind::Stopped { .. } => linux_abi::ptrace_continue(process.pid)?,
            WaitKind::Exited(_) | WaitKind::Signaled(_) => {
                return Err(KernelError::ProcessMismatch);
            }
        }
    }
    process.verify_terminal()
}

fn wait_killed_exit(process: &TrackedProcess) -> Result<(), KernelError> {
    loop {
        match wait(process.pid)?.kind {
            WaitKind::Exited(_) | WaitKind::Signaled(_) => break,
            WaitKind::Stopped { .. } => {
                linux_abi::signal_pidfd(process.pidfd.as_raw_fd(), libc::SIGKILL)?;
                let _ = linux_abi::ptrace_continue(process.pid);
            }
        }
    }
    process.verify_terminal()
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

fn mapped_files(pid: i32) -> Result<BTreeSet<FileIdentity>, KernelError> {
    let maps = fs::read_to_string(format!("/proc/{pid}/maps"))
        .map_err(|_| KernelError::ExecutableMismatch)?;
    if maps.len() > 512 * 1024 {
        return Err(KernelError::MappingMismatch);
    }
    let mut files = BTreeSet::new();
    let mut line_count = 0_usize;
    for line in maps.lines() {
        line_count += 1;
        if line_count > 256 || line.len() > 4096 {
            return Err(KernelError::MappingMismatch);
        }
        let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
        if fields.len() < 5 {
            return Err(KernelError::ExecutableMismatch);
        }
        let permissions = fields[1];
        if permissions.contains('w') && permissions.contains('x') {
            return Err(KernelError::ExecutableMismatch);
        }
        if let Some(path) = fields.get(5).filter(|path| path.starts_with('/')) {
            if line.ends_with(" (deleted)") {
                return Err(KernelError::ExecutableMismatch);
            }
            files.insert(identity(path)?);
        } else if permissions.contains('x')
            && !matches!(fields.get(5), Some(&"[vdso]") | Some(&"[vsyscall]"))
        {
            return Err(KernelError::MappingMismatch);
        }
    }
    if files.is_empty() || files.len() > 16 {
        Err(KernelError::ExecutableMismatch)
    } else {
        Ok(files)
    }
}

fn capture_runtime_inventory(pid: i32) -> Result<RuntimeInventory, KernelError> {
    Ok(RuntimeInventory {
        executable: identity(format!("/proc/{pid}/exe"))?,
        root: identity(format!("/proc/{pid}/root"))?,
    })
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
        if namespace_path(Some(pid), "pid").map_err(|_| KernelError::ChildPidNamespaceMismatch)?
            != inventory.child_pid
        {
            return Err(KernelError::ChildPidNamespaceMismatch);
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
