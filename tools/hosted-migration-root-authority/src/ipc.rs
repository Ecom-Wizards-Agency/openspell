//! Connected sequenced-packet handle validation and bounded receives.

use std::io::IoSliceMut;
use std::mem::MaybeUninit;
use std::mem::align_of;
use std::os::fd::OwnedFd;

use rustix::io;
use rustix::net::sockopt::{
    set_socket_passcred, socket_acceptconn, socket_domain, socket_error, socket_passcred,
    socket_peercred, socket_type,
};
use rustix::net::{
    AddressFamily, RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, ReturnFlags, SendFlags,
    SocketAddrAny, SocketType, UCred, getpeername, recvmsg, send,
};

use crate::protocol::{
    MAX_FRAME_BYTES, OperatorDecode, OperatorRefusal, OperatorRequest, OperatorRequestFamily,
    OperatorResponse, OperatorResponseFrame, RefusalCode, SupervisorDecode, SupervisorRefusal,
    SupervisorRequest, SupervisorRequestFamily, SupervisorResponse, SupervisorResponseFrame,
    decode_operator, decode_supervisor, encode_operator_response, encode_supervisor_response,
};

const CREDENTIAL_CONTROL_BYTES: usize = rustix::cmsg_space!(ScmCredentials(1));
const CREDENTIAL_ALIGNED_BYTES: usize = rustix::cmsg_aligned_space!(ScmCredentials(1));
const MINIMUM_SECOND_ALIGNED_BYTES: usize = rustix::cmsg_aligned_space!(ScmRights(0));
const CONTROL_BYTES: usize = CREDENTIAL_CONTROL_BYTES;
const RECEIVE_FLAGS: RecvFlags = RecvFlags::DONTWAIT.union(RecvFlags::CMSG_CLOEXEC);
const ALLOWED_RECORD_FLAGS: ReturnFlags = ReturnFlags::EOR.union(ReturnFlags::CMSG_CLOEXEC);
const ALLOWED_EOF_FLAGS: ReturnFlags = ReturnFlags::CMSG_CLOEXEC;

const _: () = assert!(CONTROL_BYTES - (align_of::<usize>() - 1) >= CREDENTIAL_ALIGNED_BYTES);
const _: () = assert!(CONTROL_BYTES < CREDENTIAL_ALIGNED_BYTES + MINIMUM_SECOND_ALIGNED_BYTES);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum IpcError {
    Endpoint,
    Peer,
    Receive,
    Record,
    OpenWriteHalf,
    Send,
    PartialSend,
}

pub(crate) struct PeerPolicy {
    required_pid: i32,
    required_uid: u32,
    required_gid: u32,
}

impl PeerPolicy {
    #[cfg(test)]
    pub(crate) fn synthetic(required: UCred) -> Self {
        Self {
            required_pid: required.pid.as_raw_pid(),
            required_uid: required.uid.as_raw(),
            required_gid: required.gid.as_raw(),
        }
    }

    #[cfg(test)]
    fn synthetic_components(required_pid: i32, required_uid: u32, required_gid: u32) -> Self {
        Self {
            required_pid,
            required_uid,
            required_gid,
        }
    }

    fn permits(&self, peer: UCred) -> bool {
        peer.pid.as_raw_pid() == self.required_pid
            && peer.uid.as_raw() == self.required_uid
            && peer.gid.as_raw() == self.required_gid
    }
}

struct AuthenticatedPacket {
    bytes: Vec<u8>,
    reply: ReplyOnce,
}

impl AuthenticatedPacket {
    fn into_parts(self) -> (Vec<u8>, ReplyOnce) {
        (self.bytes, self.reply)
    }
}

struct ReplyOnce {
    socket: OwnedFd,
}

impl ReplyOnce {
    fn send_bytes(self, response: &[u8]) -> Result<(), IpcError> {
        let sent = send(
            &self.socket,
            response,
            SendFlags::DONTWAIT | SendFlags::NOSIGNAL,
        )
        .map_err(|_| IpcError::Send)?;
        if sent != response.len() {
            return Err(IpcError::PartialSend);
        }
        Ok(())
    }

    #[cfg(test)]
    fn send_prefix_for_test(self, response: &[u8], prefix_len: usize) -> Result<(), IpcError> {
        let prefix = response
            .get(..prefix_len)
            .filter(|prefix| prefix.len() < response.len())
            .ok_or(IpcError::PartialSend)?;
        let sent = send(
            &self.socket,
            prefix,
            SendFlags::DONTWAIT | SendFlags::NOSIGNAL,
        )
        .map_err(|_| IpcError::Send)?;
        if sent != response.len() {
            return Err(IpcError::PartialSend);
        }
        Ok(())
    }
}

pub(crate) struct SupervisorReply(ReplyOnce);

impl SupervisorReply {
    pub(crate) fn send(self, response: SupervisorResponseFrame) -> Result<(), IpcError> {
        self.0.send_bytes(response.as_bytes())
    }

    #[cfg(test)]
    pub(crate) fn send_prefix_for_test(
        self,
        response: SupervisorResponseFrame,
        prefix_len: usize,
    ) -> Result<(), IpcError> {
        self.0.send_prefix_for_test(response.as_bytes(), prefix_len)
    }
}

pub(crate) struct OperatorReply(ReplyOnce);

impl OperatorReply {
    pub(crate) fn send(self, response: OperatorResponseFrame) -> Result<(), IpcError> {
        self.0.send_bytes(response.as_bytes())
    }

    #[cfg(test)]
    pub(crate) fn send_prefix_for_test(
        self,
        response: OperatorResponseFrame,
        prefix_len: usize,
    ) -> Result<(), IpcError> {
        self.0.send_prefix_for_test(response.as_bytes(), prefix_len)
    }
}

pub(crate) enum SupervisorIngress {
    Request {
        request: SupervisorRequest,
        reply: SupervisorReply,
    },
    Malformed(MalformedSupervisor),
    Unclassified,
}

pub(crate) enum OperatorIngress {
    Request {
        request: OperatorRequest,
        reply: OperatorReply,
    },
    Malformed(MalformedOperator),
    Unclassified,
}

pub(crate) struct MalformedSupervisor {
    family: SupervisorRequestFamily,
    reply: SupervisorReply,
}

impl MalformedSupervisor {
    pub(crate) fn attempt(self) -> Result<(), IpcError> {
        let frame = encode_supervisor_response(SupervisorResponse::Refusal(SupervisorRefusal {
            family: self.family,
            code: RefusalCode::InvalidRequest,
        }))
        .map_err(|_| IpcError::Send)?;
        self.reply.send(frame)
    }
}

pub(crate) struct MalformedOperator {
    family: OperatorRequestFamily,
    reply: OperatorReply,
}

impl MalformedOperator {
    pub(crate) fn attempt(self) -> Result<(), IpcError> {
        let frame = encode_operator_response(OperatorResponse::Refusal(OperatorRefusal {
            family: self.family,
            code: RefusalCode::InvalidRequest,
        }))
        .map_err(|_| IpcError::Send)?;
        self.reply.send(frame)
    }
}

struct PreparedTransport {
    socket: OwnedFd,
    expected_peer: UCred,
    expected_address: SocketAddrAny,
}

pub(crate) struct PreparedSupervisor(PreparedTransport);

impl PreparedSupervisor {
    pub(crate) fn receive(self) -> Result<SupervisorIngress, IpcError> {
        let (bytes, reply) = self.0.receive()?.into_parts();
        Ok(match decode_supervisor(&bytes) {
            SupervisorDecode::Request(request) => SupervisorIngress::Request {
                request,
                reply: SupervisorReply(reply),
            },
            SupervisorDecode::Malformed(family) => {
                SupervisorIngress::Malformed(MalformedSupervisor {
                    family,
                    reply: SupervisorReply(reply),
                })
            }
            SupervisorDecode::Unclassified => SupervisorIngress::Unclassified,
        })
    }
}

pub(crate) struct PreparedOperator(PreparedTransport);

impl PreparedOperator {
    pub(crate) fn receive(self) -> Result<OperatorIngress, IpcError> {
        let (bytes, reply) = self.0.receive()?.into_parts();
        Ok(match decode_operator(&bytes) {
            OperatorDecode::Request(request) => OperatorIngress::Request {
                request,
                reply: OperatorReply(reply),
            },
            OperatorDecode::Malformed(family) => OperatorIngress::Malformed(MalformedOperator {
                family,
                reply: OperatorReply(reply),
            }),
            OperatorDecode::Unclassified => OperatorIngress::Unclassified,
        })
    }
}

pub(crate) fn prepare_supervisor(
    socket: OwnedFd,
    policy: &PeerPolicy,
) -> Result<PreparedSupervisor, IpcError> {
    Ok(PreparedSupervisor(PreparedTransport::prepare(
        socket, policy,
    )?))
}

pub(crate) fn prepare_operator(
    socket: OwnedFd,
    policy: &PeerPolicy,
) -> Result<PreparedOperator, IpcError> {
    Ok(PreparedOperator(PreparedTransport::prepare(
        socket, policy,
    )?))
}

impl PreparedTransport {
    fn prepare(socket: OwnedFd, policy: &PeerPolicy) -> Result<Self, IpcError> {
        let (expected_peer, expected_address) = validate_endpoint(&socket, policy)?;
        set_socket_passcred(&socket, true).map_err(|_| IpcError::Endpoint)?;
        if !socket_passcred(&socket).map_err(|_| IpcError::Endpoint)? {
            return Err(IpcError::Endpoint);
        }
        Ok(Self {
            socket,
            expected_peer,
            expected_address,
        })
    }

    fn receive(self) -> Result<AuthenticatedPacket, IpcError> {
        let (bytes, message_peer) = receive_request(&self.socket, &self.expected_address)?;
        if message_peer != self.expected_peer {
            return Err(IpcError::Peer);
        }
        require_write_half_eof(&self.socket, &self.expected_address)?;
        require_no_socket_error(&self.socket)?;

        Ok(AuthenticatedPacket {
            bytes,
            reply: ReplyOnce {
                socket: self.socket,
            },
        })
    }
}

fn validate_endpoint(
    socket: &OwnedFd,
    policy: &PeerPolicy,
) -> Result<(UCred, SocketAddrAny), IpcError> {
    if socket_domain(socket).map_err(|_| IpcError::Endpoint)? != AddressFamily::UNIX
        || socket_type(socket).map_err(|_| IpcError::Endpoint)? != SocketType::SEQPACKET
        || socket_acceptconn(socket).map_err(|_| IpcError::Endpoint)?
    {
        return Err(IpcError::Endpoint);
    }
    require_no_socket_error(socket)?;
    let peer_address = getpeername(socket)
        .map_err(|_| IpcError::Endpoint)?
        .ok_or(IpcError::Endpoint)?;
    if peer_address.address_family() != AddressFamily::UNIX {
        return Err(IpcError::Endpoint);
    }
    let peer = socket_peercred(socket).map_err(|_| IpcError::Peer)?;
    if !policy.permits(peer) {
        return Err(IpcError::Peer);
    }
    Ok((peer, peer_address))
}

fn require_no_socket_error(socket: &OwnedFd) -> Result<(), IpcError> {
    socket_error(socket)
        .map_err(|_| IpcError::Endpoint)?
        .map_err(|_| IpcError::Endpoint)
}

fn receive_request(
    socket: &OwnedFd,
    expected_address: &SocketAddrAny,
) -> Result<(Vec<u8>, UCred), IpcError> {
    let mut bytes = [0_u8; MAX_FRAME_BYTES];
    let mut io_vectors = [IoSliceMut::new(&mut bytes)];
    let mut control_space = [MaybeUninit::<u8>::uninit(); CONTROL_BYTES];
    let mut ancillary = RecvAncillaryBuffer::new(&mut control_space);
    let message = recvmsg(socket, &mut io_vectors, &mut ancillary, RECEIVE_FLAGS)
        .map_err(|_| IpcError::Receive)?;
    if message.bytes == 0
        || message.bytes > MAX_FRAME_BYTES
        || !message_address_matches(message.address.as_ref(), expected_address)
        || !message.flags.difference(ALLOWED_RECORD_FLAGS).is_empty()
    {
        return Err(IpcError::Record);
    }
    let received = message.bytes;
    let peer = exactly_one_credential(&mut ancillary)?;
    Ok((bytes[..received].to_vec(), peer))
}

fn exactly_one_credential(ancillary: &mut RecvAncillaryBuffer<'_>) -> Result<UCred, IpcError> {
    let mut credential = None;
    let mut control_count = 0_usize;
    for control in ancillary.drain() {
        control_count = control_count.checked_add(1).ok_or(IpcError::Record)?;
        match control {
            RecvAncillaryMessage::ScmCredentials(value) => {
                if credential.replace(value).is_some() {
                    return Err(IpcError::Record);
                }
            }
            RecvAncillaryMessage::ScmRights(descriptors) => {
                for descriptor in descriptors {
                    drop(descriptor);
                }
                return Err(IpcError::Record);
            }
            _ => return Err(IpcError::Record),
        }
    }
    if control_count != 1 {
        return Err(IpcError::Record);
    }
    credential.ok_or(IpcError::Record)
}

fn require_write_half_eof(
    socket: &OwnedFd,
    expected_address: &SocketAddrAny,
) -> Result<(), IpcError> {
    let mut byte = [0_u8; 1];
    let mut io_vectors = [IoSliceMut::new(&mut byte)];
    let mut control_space = [MaybeUninit::<u8>::uninit(); CONTROL_BYTES];
    let mut ancillary = RecvAncillaryBuffer::new(&mut control_space);
    let message = match recvmsg(socket, &mut io_vectors, &mut ancillary, RECEIVE_FLAGS) {
        Ok(message) => message,
        Err(io::Errno::AGAIN) => return Err(IpcError::OpenWriteHalf),
        Err(_) => return Err(IpcError::Receive),
    };
    if message.bytes != 0
        || !message_address_matches(message.address.as_ref(), expected_address)
        || !message.flags.difference(ALLOWED_EOF_FLAGS).is_empty()
        || ancillary.drain().next().is_some()
    {
        return Err(IpcError::Record);
    }
    Ok(())
}

fn message_address_matches(received: Option<&SocketAddrAny>, expected: &SocketAddrAny) -> bool {
    received.is_none_or(|address| {
        address.address_family() == AddressFamily::UNIX && address == expected
    })
}

#[cfg(test)]
mod tests {
    use std::io::IoSlice;
    use std::mem::MaybeUninit;
    use std::os::fd::{AsFd, OwnedFd};
    use std::path::Path;

    use rustix::net::sockopt::{set_socket_send_buffer_size, socket_peercred};
    use rustix::net::{
        AddressFamily, RecvFlags, SendAncillaryBuffer, SendAncillaryMessage, SendFlags, Shutdown,
        SocketAddrUnix, SocketFlags, SocketType, accept_with, bind, connect, listen, recv, send,
        sendmsg, shutdown, socket_with, socketpair,
    };

    use super::{
        ALLOWED_EOF_FLAGS, CONTROL_BYTES, CREDENTIAL_ALIGNED_BYTES, IpcError, MAX_FRAME_BYTES,
        MINIMUM_SECOND_ALIGNED_BYTES, PeerPolicy, PreparedTransport,
    };

    fn connected_pair(socket_kind: SocketType) -> (OwnedFd, OwnedFd) {
        socketpair(AddressFamily::UNIX, socket_kind, SocketFlags::CLOEXEC, None)
            .expect("socket pair")
    }

    fn expected_policy(server: &OwnedFd) -> PeerPolicy {
        PeerPolicy::synthetic(socket_peercred(server).expect("peer credentials"))
    }

    fn send_record_and_eof(client: &OwnedFd, bytes: &[u8]) {
        assert_eq!(
            send(client, bytes, SendFlags::NOSIGNAL).expect("request send"),
            bytes.len()
        );
        shutdown(client, Shutdown::Write).expect("write shutdown");
    }

    fn receive_record(socket: &OwnedFd, capacity: usize) -> Vec<u8> {
        let mut buffer = vec![0_u8; capacity];
        let (received, reported) =
            recv(socket, buffer.as_mut_slice(), RecvFlags::empty()).expect("response receive");
        assert_eq!(received, reported);
        buffer.truncate(received);
        buffer
    }

    fn assert_read_eof(socket: &OwnedFd) {
        let mut byte = [0_u8; 1];
        let (received, reported) =
            recv(socket, &mut byte, RecvFlags::empty()).expect("response eof");
        assert_eq!(received, 0);
        assert_eq!(reported, 0);
    }

    fn descriptors_for_path(path: &Path) -> usize {
        std::fs::read_dir("/proc/self/fd")
            .expect("descriptor directory")
            .filter_map(Result::ok)
            .filter_map(|entry| std::fs::read_link(entry.path()).ok())
            .filter(|target| target == path)
            .count()
    }

    #[test]
    fn authenticated_seqpacket_requires_record_then_eof_and_replies_once() {
        let (client, server) = connected_pair(SocketType::SEQPACKET);
        let policy = expected_policy(&server);
        let prepared = PreparedTransport::prepare(server, &policy).expect("prepared endpoint");
        send_record_and_eof(&client, b"fixed request");

        let packet = prepared.receive().expect("authenticated packet");
        assert_eq!(packet.bytes, b"fixed request");
        packet.reply.send_bytes(b"fixed response").expect("reply");

        assert_eq!(receive_record(&client, 64), b"fixed response");
        assert_read_eof(&client);
    }

    #[test]
    fn deterministic_short_reply_sends_one_prefix_then_consumes_reply() {
        let (client, server) = connected_pair(SocketType::SEQPACKET);
        let reply = super::ReplyOnce { socket: server };
        let response = b"complete response";
        let prefix_len = 8;

        assert_eq!(
            reply.send_prefix_for_test(response, prefix_len),
            Err(IpcError::PartialSend)
        );
        assert_eq!(
            receive_record(&client, response.len()),
            &response[..prefix_len]
        );
        assert_read_eof(&client);
    }

    #[test]
    fn authenticated_malformed_known_opcodes_receive_fixed_invalid_request_refusals() {
        use crate::protocol::{
            FRAME_HEADER_BYTES, OPERATOR_APPROVE, OPERATOR_REFUSAL, SUPERVISOR_REFUSAL,
            SUPERVISOR_STATUS, encode_frame,
        };

        const PRIVACY_CANARY: &str = "PRIVATE_TARGET_CREDENTIAL_SQL_PATH_CANARY";
        let malformed_payload = format!("{{\n  \"privacyCanary\": \"{PRIVACY_CANARY}\"\n}}\n");

        let (supervisor_client, supervisor_server) = connected_pair(SocketType::SEQPACKET);
        let supervisor_policy = expected_policy(&supervisor_server);
        let supervisor = super::prepare_supervisor(supervisor_server, &supervisor_policy)
            .expect("prepared supervisor");
        let malformed = encode_frame(SUPERVISOR_STATUS, malformed_payload.as_bytes())
            .expect("supervisor frame");
        send_record_and_eof(&supervisor_client, &malformed);
        match supervisor.receive().expect("supervisor ingress") {
            super::SupervisorIngress::Malformed(refusal) => {
                refusal.attempt().expect("supervisor refusal")
            }
            _ => panic!("malformed supervisor opcode"),
        }
        let response = receive_record(&supervisor_client, MAX_FRAME_BYTES);
        assert_eq!(
            u16::from_be_bytes([response[10], response[11]]),
            SUPERVISOR_REFUSAL
        );
        let payload = std::str::from_utf8(&response[FRAME_HEADER_BYTES..]).expect("payload");
        assert!(payload.contains("\"requestFamily\": \"status\""));
        assert!(payload.contains("\"code\": \"invalid_request\""));
        assert!(!payload.contains(PRIVACY_CANARY));
        assert_read_eof(&supervisor_client);

        let (operator_client, operator_server) = connected_pair(SocketType::SEQPACKET);
        let operator_policy = expected_policy(&operator_server);
        let operator =
            super::prepare_operator(operator_server, &operator_policy).expect("prepared operator");
        let malformed =
            encode_frame(OPERATOR_APPROVE, malformed_payload.as_bytes()).expect("operator frame");
        send_record_and_eof(&operator_client, &malformed);
        match operator.receive().expect("operator ingress") {
            super::OperatorIngress::Malformed(refusal) => {
                refusal.attempt().expect("operator refusal")
            }
            _ => panic!("malformed operator opcode"),
        }
        let response = receive_record(&operator_client, MAX_FRAME_BYTES);
        assert_eq!(
            u16::from_be_bytes([response[10], response[11]]),
            OPERATOR_REFUSAL
        );
        let payload = std::str::from_utf8(&response[FRAME_HEADER_BYTES..]).expect("payload");
        assert!(payload.contains("\"requestFamily\": \"approve_candidate\""));
        assert!(payload.contains("\"code\": \"invalid_request\""));
        assert!(!payload.contains(PRIVACY_CANARY));
        assert_read_eof(&operator_client);
    }

    #[test]
    fn exact_maximum_record_is_accepted_without_truncation() {
        let (client, server) = connected_pair(SocketType::SEQPACKET);
        let policy = expected_policy(&server);
        let prepared = PreparedTransport::prepare(server, &policy).expect("prepared endpoint");
        let request = vec![b'x'; MAX_FRAME_BYTES];
        send_record_and_eof(&client, &request);

        let packet = prepared.receive().expect("maximum authenticated packet");
        assert_eq!(packet.bytes.len(), MAX_FRAME_BYTES);
        assert_eq!(packet.bytes, request);
    }

    #[test]
    fn endpoint_domain_type_connection_and_listener_state_are_checked_before_receive() {
        let (_stream_client, stream_server) = connected_pair(SocketType::STREAM);
        let stream_policy = expected_policy(&stream_server);
        assert_eq!(
            PreparedTransport::prepare(stream_server, &stream_policy).err(),
            Some(IpcError::Endpoint)
        );

        let (_datagram_client, datagram_server) = connected_pair(SocketType::DGRAM);
        let datagram_policy = expected_policy(&datagram_server);
        assert_eq!(
            PreparedTransport::prepare(datagram_server, &datagram_policy).err(),
            Some(IpcError::Endpoint)
        );

        let unconnected = socket_with(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .expect("unconnected socket");
        let (_policy_client, policy_server) = connected_pair(SocketType::SEQPACKET);
        let policy = expected_policy(&policy_server);
        assert_eq!(
            PreparedTransport::prepare(unconnected, &policy).err(),
            Some(IpcError::Endpoint)
        );

        let internet = socket_with(
            AddressFamily::INET,
            SocketType::STREAM,
            SocketFlags::CLOEXEC,
            None,
        )
        .expect("internet socket");
        assert_eq!(
            PreparedTransport::prepare(internet, &policy).err(),
            Some(IpcError::Endpoint)
        );
    }

    #[test]
    fn pid_uid_and_gid_policy_mismatches_are_each_rejected() {
        for mismatch in ["pid", "uid", "gid"] {
            let (_client, server) = connected_pair(SocketType::SEQPACKET);
            let actual = socket_peercred(&server).expect("peer credentials");
            let actual_pid = actual.pid.as_raw_pid();
            let actual_uid = actual.uid.as_raw();
            let actual_gid = actual.gid.as_raw();
            let required = match mismatch {
                "pid" => PeerPolicy::synthetic_components(
                    if actual_pid == 1 { 2 } else { 1 },
                    actual_uid,
                    actual_gid,
                ),
                "uid" => PeerPolicy::synthetic_components(
                    actual_pid,
                    if actual_uid == 0 { 1 } else { 0 },
                    actual_gid,
                ),
                "gid" => PeerPolicy::synthetic_components(
                    actual_pid,
                    actual_uid,
                    if actual_gid == 0 { 1 } else { 0 },
                ),
                _ => unreachable!(),
            };
            assert_eq!(
                PreparedTransport::prepare(server, &required).err(),
                Some(IpcError::Peer),
                "{mismatch} mismatch"
            );
        }
    }

    #[test]
    fn named_seqpacket_peer_is_accepted_but_listener_is_not() {
        let directory = tempfile::tempdir().expect("socket directory");
        let listener_address =
            SocketAddrUnix::new(directory.path().join("listener.sock")).expect("listener address");
        let client_address =
            SocketAddrUnix::new(directory.path().join("client.sock")).expect("client address");
        let listener = socket_with(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .expect("listener socket");
        bind(&listener, &listener_address).expect("listener bind");
        listen(&listener, 1).expect("listener listen");

        let (_policy_client, policy_server) = connected_pair(SocketType::SEQPACKET);
        let policy = expected_policy(&policy_server);
        let listener_copy = rustix::io::dup(&listener).expect("listener duplicate");
        assert_eq!(
            PreparedTransport::prepare(listener_copy, &policy).err(),
            Some(IpcError::Endpoint)
        );

        let client = socket_with(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .expect("client socket");
        bind(&client, &client_address).expect("client bind");
        connect(&client, &listener_address).expect("client connect");
        let server = accept_with(&listener, SocketFlags::CLOEXEC).expect("accepted socket");
        let policy = expected_policy(&server);
        let prepared = PreparedTransport::prepare(server, &policy).expect("named peer prepared");
        send_record_and_eof(&client, b"named request");

        assert_eq!(
            prepared
                .receive()
                .expect("named authenticated packet")
                .bytes,
            b"named request"
        );
    }

    #[test]
    fn duplicated_sender_handle_preserves_kernel_authenticated_identity() {
        let (client, server) = connected_pair(SocketType::SEQPACKET);
        let policy = expected_policy(&server);
        let prepared = PreparedTransport::prepare(server, &policy).expect("prepared endpoint");
        let transferred = rustix::io::dup(&client).expect("sender duplicate");
        let sender = std::thread::spawn(move || send_record_and_eof(&transferred, b"transferred"));
        sender.join().expect("sender thread");

        let packet = prepared
            .receive()
            .expect("transferred authenticated packet");
        assert_eq!(packet.bytes, b"transferred");
    }

    #[test]
    fn open_write_half_second_record_and_empty_record_are_not_eof() {
        let (open_client, open_server) = connected_pair(SocketType::SEQPACKET);
        let open_policy = expected_policy(&open_server);
        let open_prepared =
            PreparedTransport::prepare(open_server, &open_policy).expect("prepared endpoint");
        assert_eq!(
            send(&open_client, b"request", SendFlags::NOSIGNAL).expect("request send"),
            7
        );
        assert_eq!(open_prepared.receive().err(), Some(IpcError::OpenWriteHalf));

        let (second_client, second_server) = connected_pair(SocketType::SEQPACKET);
        let second_policy = expected_policy(&second_server);
        let second_prepared =
            PreparedTransport::prepare(second_server, &second_policy).expect("prepared endpoint");
        assert_eq!(
            send(&second_client, b"first", SendFlags::NOSIGNAL).expect("first send"),
            5
        );
        assert_eq!(
            send(&second_client, b"second", SendFlags::NOSIGNAL).expect("second send"),
            6
        );
        shutdown(&second_client, Shutdown::Write).expect("write shutdown");
        assert_eq!(second_prepared.receive().err(), Some(IpcError::Record));

        let (empty_client, empty_server) = connected_pair(SocketType::SEQPACKET);
        let empty_policy = expected_policy(&empty_server);
        let empty_prepared =
            PreparedTransport::prepare(empty_server, &empty_policy).expect("prepared endpoint");
        assert_eq!(
            send(&empty_client, b"request", SendFlags::NOSIGNAL).expect("request send"),
            7
        );
        assert_eq!(
            send(&empty_client, b"", SendFlags::NOSIGNAL).expect("empty send"),
            0
        );
        shutdown(&empty_client, Shutdown::Write).expect("write shutdown");
        assert_eq!(empty_prepared.receive().err(), Some(IpcError::Record));
    }

    #[test]
    fn truncation_and_rights_are_rejected_without_leaking_received_descriptors() {
        let (large_client, large_server) = connected_pair(SocketType::SEQPACKET);
        let large_policy = expected_policy(&large_server);
        let large_prepared =
            PreparedTransport::prepare(large_server, &large_policy).expect("prepared endpoint");
        send_record_and_eof(&large_client, &vec![b'x'; MAX_FRAME_BYTES + 1]);
        assert_eq!(large_prepared.receive().err(), Some(IpcError::Record));

        let (rights_client, rights_server) = connected_pair(SocketType::SEQPACKET);
        let rights_policy = expected_policy(&rights_server);
        let rights_prepared =
            PreparedTransport::prepare(rights_server, &rights_policy).expect("prepared endpoint");
        let descriptor = tempfile::NamedTempFile::new().expect("test descriptor");
        let descriptor_path = descriptor.path().to_path_buf();
        assert_eq!(descriptors_for_path(&descriptor_path), 1);
        let descriptors = [descriptor.as_file().as_fd()];
        let mut control_space = [MaybeUninit::<u8>::uninit(); rustix::cmsg_space!(ScmRights(1))];
        let mut ancillary = SendAncillaryBuffer::new(&mut control_space);
        assert!(ancillary.push(SendAncillaryMessage::ScmRights(&descriptors)));
        let io_vectors = [IoSlice::new(b"request")];
        assert_eq!(
            sendmsg(
                &rights_client,
                &io_vectors,
                &mut ancillary,
                SendFlags::NOSIGNAL
            )
            .expect("rights send"),
            7
        );
        shutdown(&rights_client, Shutdown::Write).expect("write shutdown");
        assert_eq!(rights_prepared.receive().err(), Some(IpcError::Record));
        assert_eq!(descriptors_for_path(&descriptor_path), 1);
    }

    #[test]
    fn control_space_survives_worst_alignment_and_cannot_fit_a_second_header() {
        let maximum_alignment_loss = std::mem::align_of::<usize>() - 1;
        let control_bytes = std::hint::black_box(CONTROL_BYTES);
        assert!(control_bytes - maximum_alignment_loss >= CREDENTIAL_ALIGNED_BYTES);
        assert!(control_bytes < CREDENTIAL_ALIGNED_BYTES + MINIMUM_SECOND_ALIGNED_BYTES);
        assert_eq!(ALLOWED_EOF_FLAGS, rustix::net::ReturnFlags::CMSG_CLOEXEC);
    }

    #[test]
    fn record_queued_before_passcred_enablement_is_not_authenticated() {
        let (client, server) = connected_pair(SocketType::SEQPACKET);
        let policy = expected_policy(&server);
        send_record_and_eof(&client, b"too early");
        let prepared = PreparedTransport::prepare(server, &policy).expect("prepared endpoint");
        assert!(matches!(
            prepared.receive(),
            Err(IpcError::Peer | IpcError::Record)
        ));
    }

    #[test]
    fn reply_reports_closed_and_saturated_peer_without_signals_or_blocking() {
        let (closed_client, closed_server) = connected_pair(SocketType::SEQPACKET);
        let closed_policy = expected_policy(&closed_server);
        let closed_prepared =
            PreparedTransport::prepare(closed_server, &closed_policy).expect("prepared endpoint");
        send_record_and_eof(&closed_client, b"request");
        let closed_packet = closed_prepared.receive().expect("authenticated packet");
        drop(closed_client);
        assert_eq!(
            closed_packet.reply.send_bytes(b"response").err(),
            Some(IpcError::Send)
        );

        let (saturated_client, saturated_server) = connected_pair(SocketType::SEQPACKET);
        set_socket_send_buffer_size(&saturated_server, 1_024).expect("small send buffer");
        let mut saturated = false;
        for _ in 0..10_000 {
            match send(
                &saturated_server,
                &[b'x'; 1_024],
                SendFlags::DONTWAIT | SendFlags::NOSIGNAL,
            ) {
                Ok(1_024) => {}
                Ok(other) => panic!("partial seqpacket prefill: {other}"),
                Err(rustix::io::Errno::AGAIN) => {
                    saturated = true;
                    break;
                }
                Err(error) => panic!("unexpected saturation error: {error}"),
            }
        }
        assert!(
            saturated,
            "send queue did not saturate within the fixed bound"
        );
        let saturated_policy = expected_policy(&saturated_server);
        let saturated_prepared = PreparedTransport::prepare(saturated_server, &saturated_policy)
            .expect("prepared saturated endpoint");
        send_record_and_eof(&saturated_client, b"request");
        let saturated_packet = saturated_prepared
            .receive()
            .expect("authenticated saturated packet");
        assert_eq!(
            saturated_packet.reply.send_bytes(b"response").err(),
            Some(IpcError::Send)
        );
    }
}
