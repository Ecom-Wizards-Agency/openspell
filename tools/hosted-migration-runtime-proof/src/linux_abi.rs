#![allow(unsafe_code)]

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("synthetic kernel proof requires linux x86-64");

use std::ffi::c_void;
use std::fmt;
use std::mem::size_of;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::ptr;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AbiError {
    KernelUnavailable,
    OperationFailed,
    ProtocolMismatch,
    DeadlineExceeded,
}

impl fmt::Display for AbiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::KernelUnavailable => "kernel unavailable",
            Self::OperationFailed => "operation failed",
            Self::ProtocolMismatch => "protocol mismatch",
            Self::DeadlineExceeded => "deadline exceeded",
        })
    }
}

#[repr(C)]
#[derive(Default)]
struct CloneArgs {
    flags: u64,
    pidfd: u64,
    child_tid: u64,
    parent_tid: u64,
    exit_signal: u64,
    stack: u64,
    stack_size: u64,
    tls: u64,
    set_tid: u64,
    set_tid_size: u64,
    cgroup: u64,
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

const _: () = assert!(size_of::<CloneArgs>() == 88);
const _: () = assert!(size_of::<CapHeader>() == 8);
const _: () = assert!(size_of::<CapData>() == 12);
const _: () = assert!(size_of::<libc::sock_filter>() == 8);
const _: () = assert!(size_of::<libc::sock_fprog>() == 16);

#[derive(Debug)]
pub(crate) struct PipePair {
    pub(crate) read: OwnedFd,
    pub(crate) write: OwnedFd,
}

#[derive(Debug)]
pub(crate) enum CloneOutcome {
    Child,
    Parent { pid: i32, pidfd: OwnedFd },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ForkOutcome {
    Child,
    Parent(i32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WaitKind {
    Stopped { signal: i32, event: u32 },
    Exited(i32),
    Signaled(i32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WaitEvent {
    pub(crate) pid: i32,
    pub(crate) kind: WaitKind,
}

pub(crate) const EVENT_FORK: u32 = libc::PTRACE_EVENT_FORK as u32;
pub(crate) const EVENT_EXEC: u32 = libc::PTRACE_EVENT_EXEC as u32;
pub(crate) const STOP_SIGNAL: i32 = libc::SIGSTOP;
pub(crate) const TRAP_SIGNAL: i32 = libc::SIGTRAP;
pub(crate) const EXECUTABLE_FD: RawFd = 198;

fn last_errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn owned_fd(raw: i32) -> OwnedFd {
    // SAFETY: every caller passes a new, successful descriptor returned by the kernel.
    unsafe { OwnedFd::from_raw_fd(raw) }
}

pub(crate) fn current_ids() -> (u32, u32) {
    // SAFETY: getuid/getgid have no preconditions and cannot fail.
    unsafe { (libc::getuid(), libc::getgid()) }
}

pub(crate) fn current_pid() -> i32 {
    // SAFETY: getpid has no preconditions and cannot fail.
    unsafe { libc::getpid() }
}

pub(crate) fn make_pipe() -> Result<PipePair, AbiError> {
    let mut descriptors = [-1_i32; 2];
    // SAFETY: descriptors points to space for exactly two descriptors.
    let status = unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) };
    if status != 0 {
        return Err(AbiError::OperationFailed);
    }
    Ok(PipePair {
        read: owned_fd(descriptors[0]),
        write: owned_fd(descriptors[1]),
    })
}

pub(crate) fn read_gate(fd: RawFd) -> Result<(), AbiError> {
    let mut byte = 0_u8;
    loop {
        // SAFETY: byte is writable for one byte and fd is borrowed for this call.
        let count = unsafe { libc::read(fd, (&mut byte as *mut u8).cast::<c_void>(), 1) };
        if count == 1 {
            return if byte == 0x57 {
                Ok(())
            } else {
                Err(AbiError::ProtocolMismatch)
            };
        }
        if count == -1 && last_errno() == libc::EINTR {
            continue;
        }
        return Err(AbiError::OperationFailed);
    }
}

pub(crate) fn write_gate(fd: RawFd) -> Result<(), AbiError> {
    let byte = 0x57_u8;
    loop {
        // SAFETY: byte is readable for one byte and fd is borrowed for this call.
        let count = unsafe { libc::write(fd, (&byte as *const u8).cast::<c_void>(), 1) };
        if count == 1 {
            return Ok(());
        }
        if count == -1 && last_errno() == libc::EINTR {
            continue;
        }
        return Err(AbiError::OperationFailed);
    }
}

pub(crate) fn unshare_proof_namespaces() -> Result<(), AbiError> {
    let flags = libc::CLONE_NEWUSER
        | libc::CLONE_NEWNS
        | libc::CLONE_NEWPID
        | libc::CLONE_NEWIPC
        | libc::CLONE_NEWUTS
        | libc::CLONE_NEWNET;
    // SAFETY: flags request only new namespaces for the calling single-threaded test process.
    let status = unsafe { libc::unshare(flags) };
    if status == 0 {
        Ok(())
    } else {
        Err(AbiError::KernelUnavailable)
    }
}

pub(crate) fn unshare_child_mount_namespace() -> Result<(), AbiError> {
    // SAFETY: the child is single-threaded and creates a private mount namespace for proc.
    if unsafe { libc::unshare(libc::CLONE_NEWNS) } == 0 {
        Ok(())
    } else {
        Err(AbiError::KernelUnavailable)
    }
}

pub(crate) fn clone_with_pidfd() -> Result<CloneOutcome, AbiError> {
    let mut pidfd = -1_i32;
    let mut arguments = CloneArgs {
        flags: libc::CLONE_PIDFD as u64,
        pidfd: (&mut pidfd as *mut i32) as u64,
        exit_signal: libc::SIGCHLD as u64,
        ..CloneArgs::default()
    };
    // SAFETY: arguments has the clone3 ABI layout and the kernel writes one pidfd i32.
    let result = unsafe {
        libc::syscall(
            libc::SYS_clone3,
            (&mut arguments as *mut CloneArgs).cast::<c_void>(),
            size_of::<CloneArgs>(),
        )
    };
    if result == 0 {
        Ok(CloneOutcome::Child)
    } else if result > 0 && pidfd >= 0 {
        Ok(CloneOutcome::Parent {
            pid: i32::try_from(result).map_err(|_| AbiError::ProtocolMismatch)?,
            pidfd: owned_fd(pidfd),
        })
    } else {
        Err(AbiError::KernelUnavailable)
    }
}

pub(crate) fn open_pidfd(pid: i32) -> Result<OwnedFd, AbiError> {
    // SAFETY: pidfd_open copies the integer pid and returns a fresh descriptor.
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0_u32) };
    if descriptor < 0 {
        Err(AbiError::OperationFailed)
    } else {
        Ok(owned_fd(
            i32::try_from(descriptor).map_err(|_| AbiError::ProtocolMismatch)?,
        ))
    }
}

pub(crate) fn signal_pidfd(fd: RawFd, signal: i32) -> Result<(), AbiError> {
    // SAFETY: pidfd_send_signal copies its arguments; the siginfo pointer is intentionally null.
    let status = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd,
            signal,
            ptr::null::<libc::siginfo_t>(),
            0_u32,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(AbiError::OperationFailed)
    }
}

pub(crate) fn pidfd_is_terminal(fd: RawFd, timeout: Duration) -> Result<bool, AbiError> {
    let milliseconds = i32::try_from(timeout.as_millis()).unwrap_or(i32::MAX);
    let mut descriptor = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: descriptor points to one initialized pollfd for the duration of poll.
    let count = unsafe { libc::poll(&mut descriptor, 1, milliseconds) };
    if count < 0 {
        return Err(AbiError::OperationFailed);
    }
    Ok(count == 1 && descriptor.revents & libc::POLLIN != 0)
}

pub(crate) fn ptrace_traceme() -> Result<(), AbiError> {
    // SAFETY: PTRACE_TRACEME ignores address arguments and changes only the calling process.
    let status = unsafe {
        libc::ptrace(
            libc::PTRACE_TRACEME,
            0,
            ptr::null_mut::<c_void>(),
            ptr::null_mut::<c_void>(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(AbiError::OperationFailed)
    }
}

pub(crate) fn ptrace_set_fixed_options(pid: i32) -> Result<(), AbiError> {
    let options = libc::PTRACE_O_EXITKILL
        | libc::PTRACE_O_TRACEFORK
        | libc::PTRACE_O_TRACEVFORK
        | libc::PTRACE_O_TRACECLONE
        | libc::PTRACE_O_TRACEEXEC;
    // SAFETY: the tracee is stopped and options is passed by value through the data word.
    let status = unsafe {
        libc::ptrace(
            libc::PTRACE_SETOPTIONS,
            pid,
            ptr::null_mut::<c_void>(),
            options as usize as *mut c_void,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(AbiError::OperationFailed)
    }
}

pub(crate) fn ptrace_continue(pid: i32) -> Result<(), AbiError> {
    // SAFETY: the tracee is stopped; null address/data requests continuation without a signal.
    let status = unsafe {
        libc::ptrace(
            libc::PTRACE_CONT,
            pid,
            ptr::null_mut::<c_void>(),
            ptr::null_mut::<c_void>(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(AbiError::OperationFailed)
    }
}

pub(crate) fn ptrace_event_pid(pid: i32) -> Result<i32, AbiError> {
    let mut message = 0_usize;
    // SAFETY: message is writable and the stopped tracee has a ptrace event message.
    let status = unsafe {
        libc::ptrace(
            libc::PTRACE_GETEVENTMSG,
            pid,
            ptr::null_mut::<c_void>(),
            (&mut message as *mut usize).cast::<c_void>(),
        )
    };
    if status != 0 {
        return Err(AbiError::OperationFailed);
    }
    i32::try_from(message).map_err(|_| AbiError::ProtocolMismatch)
}

fn decode_wait(pid: i32, status: i32) -> Result<WaitEvent, AbiError> {
    if libc::WIFSTOPPED(status) {
        Ok(WaitEvent {
            pid,
            kind: WaitKind::Stopped {
                signal: libc::WSTOPSIG(status),
                event: ((status as u32) >> 16) & 0xffff,
            },
        })
    } else if libc::WIFEXITED(status) {
        Ok(WaitEvent {
            pid,
            kind: WaitKind::Exited(libc::WEXITSTATUS(status)),
        })
    } else if libc::WIFSIGNALED(status) {
        Ok(WaitEvent {
            pid,
            kind: WaitKind::Signaled(libc::WTERMSIG(status)),
        })
    } else {
        Err(AbiError::ProtocolMismatch)
    }
}

pub(crate) fn wait_for_pid(pid: i32, timeout: Duration) -> Result<WaitEvent, AbiError> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(AbiError::DeadlineExceeded)?;
    loop {
        let mut status = 0_i32;
        // SAFETY: status is writable and __WALL|WNOHANG are valid waitpid options on Linux.
        let result = unsafe { libc::waitpid(pid, &mut status, libc::__WALL | libc::WNOHANG) };
        if result == pid {
            return decode_wait(pid, status);
        }
        if result < 0 && last_errno() != libc::EINTR {
            return Err(AbiError::OperationFailed);
        }
        if Instant::now() >= deadline {
            return Err(AbiError::DeadlineExceeded);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

pub(crate) fn wait_for_any(timeout: Duration) -> Result<WaitEvent, AbiError> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(AbiError::DeadlineExceeded)?;
    loop {
        let mut status = 0_i32;
        // SAFETY: status is writable and __WALL|WNOHANG are valid waitpid options on Linux.
        let result = unsafe { libc::waitpid(-1, &mut status, libc::__WALL | libc::WNOHANG) };
        if result > 0 {
            return decode_wait(result, status);
        }
        if result < 0 && last_errno() != libc::EINTR {
            return Err(AbiError::OperationFailed);
        }
        if Instant::now() >= deadline {
            return Err(AbiError::DeadlineExceeded);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

pub(crate) fn stop_self() -> Result<(), AbiError> {
    // SAFETY: raise targets the calling process with a fixed catchable signal.
    if unsafe { libc::raise(libc::SIGSTOP) } == 0 {
        Ok(())
    } else {
        Err(AbiError::OperationFailed)
    }
}

pub(crate) fn fork_process() -> Result<ForkOutcome, AbiError> {
    // SAFETY: the harness-free executable is single-threaded at every fork point.
    let result = unsafe { libc::fork() };
    if result == 0 {
        Ok(ForkOutcome::Child)
    } else if result > 0 {
        Ok(ForkOutcome::Parent(result))
    } else {
        Err(AbiError::OperationFailed)
    }
}

pub(crate) fn wait_child_success(pid: i32) -> Result<(), AbiError> {
    loop {
        let mut status = 0_i32;
        // SAFETY: status is writable and pid names the process created by fork_process.
        let result = unsafe { libc::waitpid(pid, &mut status, 0) };
        if result == pid {
            return if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0 {
                Ok(())
            } else {
                Err(AbiError::ProtocolMismatch)
            };
        }
        if result < 0 && last_errno() == libc::EINTR {
            continue;
        }
        return Err(AbiError::OperationFailed);
    }
}

pub(crate) fn make_mounts_private_and_replace_proc() -> Result<(), AbiError> {
    let root = b"/\0";
    let proc_path = b"/proc\0";
    let proc_type = b"proc\0";
    // SAFETY: all pointers reference fixed NUL-terminated strings or are null as required.
    let private_status = unsafe {
        libc::mount(
            ptr::null(),
            root.as_ptr().cast(),
            ptr::null(),
            libc::MS_REC | libc::MS_PRIVATE,
            ptr::null(),
        )
    };
    if private_status != 0 {
        return Err(AbiError::OperationFailed);
    }
    // SAFETY: all pointers reference fixed NUL-terminated strings or are null as required.
    let mount_status = unsafe {
        libc::mount(
            proc_type.as_ptr().cast(),
            proc_path.as_ptr().cast(),
            proc_type.as_ptr().cast(),
            libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
            ptr::null(),
        )
    };
    if mount_status == 0 {
        Ok(())
    } else {
        Err(AbiError::OperationFailed)
    }
}

pub(crate) fn set_fixed_hostname() -> Result<(), AbiError> {
    let hostname = b"openspell-proof";
    // SAFETY: hostname points to exactly hostname.len() initialized bytes.
    let status = unsafe { libc::sethostname(hostname.as_ptr().cast(), hostname.len()) };
    if status == 0 {
        Ok(())
    } else {
        Err(AbiError::OperationFailed)
    }
}

pub(crate) fn enable_supervisor_proc_inspection() -> Result<(), AbiError> {
    // SAFETY: this applies only to the disposable supervisor before any synthetic program exists.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 1, 0, 0, 0) } == 0 {
        Ok(())
    } else {
        Err(AbiError::OperationFailed)
    }
}

pub(crate) fn clear_close_on_exec(fd: RawFd) -> Result<(), AbiError> {
    // SAFETY: F_GETFD/F_SETFD operate on the borrowed descriptor and copy integer flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(AbiError::OperationFailed);
    }
    // SAFETY: fd remains open and flags contains only descriptor flags returned by F_GETFD.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } == 0 {
        Ok(())
    } else {
        Err(AbiError::OperationFailed)
    }
}

pub(crate) fn duplicate_executable_fd(fd: RawFd) -> Result<OwnedFd, AbiError> {
    let source = if fd == EXECUTABLE_FD {
        // SAFETY: F_DUPFD_CLOEXEC returns a new descriptor at or above the fixed boundary.
        let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, EXECUTABLE_FD + 1) };
        if duplicated < 0 {
            return Err(AbiError::OperationFailed);
        }
        Some(owned_fd(duplicated))
    } else {
        None
    };
    let source_fd = source.as_ref().map_or(fd, |owned| {
        use std::os::fd::AsRawFd;
        owned.as_raw_fd()
    });
    // SAFETY: dup3 atomically installs a duplicate at the fixed unused test descriptor.
    let duplicated = unsafe { libc::dup3(source_fd, EXECUTABLE_FD, 0) };
    if duplicated != EXECUTABLE_FD {
        return Err(AbiError::OperationFailed);
    }
    Ok(owned_fd(duplicated))
}

pub(crate) fn exec_role(executable_fd: RawFd, role: &'static [u8]) -> Result<(), AbiError> {
    if role.last() != Some(&0) || role[..role.len() - 1].contains(&0) {
        return Err(AbiError::ProtocolMismatch);
    }
    let name = b"kernel-proof\0";
    let argv = [
        name.as_ptr().cast::<i8>(),
        role.as_ptr().cast::<i8>(),
        ptr::null(),
    ];
    let environment = [ptr::null::<i8>()];
    let empty = b"\0";
    // SAFETY: argv/environment are null-terminated arrays of valid NUL-terminated strings;
    // executable_fd identifies the already-open fixed executable and AT_EMPTY_PATH selects it.
    let status = unsafe {
        libc::syscall(
            libc::SYS_execveat,
            executable_fd,
            empty.as_ptr().cast::<i8>(),
            argv.as_ptr(),
            environment.as_ptr(),
            libc::AT_EMPTY_PATH,
        )
    };
    if status == -1 {
        Err(AbiError::OperationFailed)
    } else {
        Err(AbiError::ProtocolMismatch)
    }
}

pub(crate) fn install_process_protections(cap_last: u32) -> Result<(), AbiError> {
    // SAFETY: every prctl call uses the documented scalar argument form.
    if unsafe {
        libc::prctl(
            libc::PR_CAP_AMBIENT,
            libc::PR_CAP_AMBIENT_CLEAR_ALL,
            0,
            0,
            0,
        )
    } != 0
    {
        return Err(AbiError::OperationFailed);
    }
    for capability in 0..=cap_last {
        // SAFETY: the capability number came from the kernel's cap_last_cap boundary.
        let present = unsafe { libc::prctl(libc::PR_CAPBSET_READ, capability, 0, 0, 0) };
        if present < 0 {
            return Err(AbiError::OperationFailed);
        }
        if present == 1 {
            // SAFETY: the fixed front controller still owns CAP_SETPCAP before the first drop;
            // a delegate inherits the already-empty set and therefore performs no drop.
            if unsafe { libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0) } != 0 {
                return Err(AbiError::OperationFailed);
            }
        }
    }
    let mut header = CapHeader {
        version: 0x2008_0522,
        pid: 0,
    };
    let data = [
        CapData {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
        CapData {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
    ];
    // SAFETY: header/data use the Linux capability v3 layout for exactly two u32 words.
    if unsafe {
        libc::syscall(
            libc::SYS_capset,
            (&mut header as *mut CapHeader).cast::<c_void>(),
            data.as_ptr().cast::<c_void>(),
        )
    } != 0
    {
        return Err(AbiError::OperationFailed);
    }
    let limits = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: limits is initialized and RLIMIT_CORE accepts a pointer to libc::rlimit.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limits) } != 0 {
        return Err(AbiError::OperationFailed);
    }
    // SAFETY: fixed scalar prctl requests.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0
        || unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0
    {
        return Err(AbiError::OperationFailed);
    }
    install_dumpability_filter()?;
    // SAFETY: this deliberately exercises the one denied prctl tuple.
    let denied = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 1, 0, 0, 0) };
    if denied != -1 || last_errno() != libc::EPERM {
        return Err(AbiError::ProtocolMismatch);
    }
    // SAFETY: PR_GET_DUMPABLE ignores remaining scalar arguments.
    if unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(AbiError::ProtocolMismatch);
    }
    Ok(())
}

fn install_dumpability_filter() -> Result<(), AbiError> {
    const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
    const RET_KILL_PROCESS: u32 = 0x8000_0000;
    const RET_ALLOW: u32 = 0x7fff_0000;
    const RET_ERRNO: u32 = 0x0005_0000;
    const LD_W_ABS: u16 = 0x20;
    const JMP_JEQ_K: u16 = 0x15;
    const RET_K: u16 = 0x06;
    let filters = [
        libc::sock_filter {
            code: LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 4,
        },
        libc::sock_filter {
            code: JMP_JEQ_K,
            jt: 1,
            jf: 0,
            k: AUDIT_ARCH_X86_64,
        },
        libc::sock_filter {
            code: RET_K,
            jt: 0,
            jf: 0,
            k: RET_KILL_PROCESS,
        },
        libc::sock_filter {
            code: LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 0,
        },
        libc::sock_filter {
            code: JMP_JEQ_K,
            jt: 0,
            jf: 5,
            k: libc::SYS_prctl as u32,
        },
        libc::sock_filter {
            code: LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 16,
        },
        libc::sock_filter {
            code: JMP_JEQ_K,
            jt: 0,
            jf: 3,
            k: libc::PR_SET_DUMPABLE as u32,
        },
        libc::sock_filter {
            code: LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 24,
        },
        libc::sock_filter {
            code: JMP_JEQ_K,
            jt: 1,
            jf: 0,
            k: 0,
        },
        libc::sock_filter {
            code: RET_K,
            jt: 0,
            jf: 0,
            k: RET_ERRNO | libc::EPERM as u32,
        },
        libc::sock_filter {
            code: RET_K,
            jt: 0,
            jf: 0,
            k: RET_ALLOW,
        },
    ];
    let program = libc::sock_fprog {
        len: u16::try_from(filters.len()).map_err(|_| AbiError::ProtocolMismatch)?,
        filter: filters.as_ptr().cast_mut(),
    };
    // SAFETY: program references the fixed filter array for the duration of prctl.
    let status = unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER,
            &program as *const libc::sock_fprog,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(AbiError::KernelUnavailable)
    }
}

pub(crate) fn exit_immediately(code: i32) -> ! {
    // SAFETY: _exit terminates only the calling process and never returns.
    unsafe { libc::_exit(code) }
}
