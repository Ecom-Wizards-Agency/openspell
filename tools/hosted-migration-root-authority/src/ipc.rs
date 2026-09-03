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
    MAX_FRAME_BYTES, OperatorDecode, OperatorRequest, OperatorRequestFamily, OperatorResponseFrame,
    SupervisorDecode, SupervisorRequest, SupervisorRequestFamily, SupervisorResponseFrame,
    decode_operator, decode_supervisor,
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
    required: UCred,
}

impl PeerPolicy {
    #[cfg(test)]
    pub(crate) fn synthetic(required: UCred) -> Self {
        Self { required }
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
}

pub(crate) struct SupervisorReply(ReplyOnce);

impl SupervisorReply {
    pub(crate) fn send(self, response: SupervisorResponseFrame) -> Result<(), IpcError> {
        self.0.send_bytes(response.as_bytes())
    }
}

pub(crate) struct OperatorReply(ReplyOnce);

impl OperatorReply {
    pub(crate) fn send(self, response: OperatorResponseFrame) -> Result<(), IpcError> {
        self.0.send_bytes(response.as_bytes())
    }
}

pub(crate) enum SupervisorIngress {
    Request {
        request: SupervisorRequest,
        reply: SupervisorReply,
    },
    Malformed {
        family: SupervisorRequestFamily,
        reply: SupervisorReply,
    },
    Unclassified,
}

pub(crate) enum OperatorIngress {
    Request {
        request: OperatorRequest,
        reply: OperatorReply,
    },
    Malformed {
        family: OperatorRequestFamily,
        reply: OperatorReply,
    },
    Unclassified,
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
            SupervisorDecode::Malformed(family) => SupervisorIngress::Malformed {
                family,
                reply: SupervisorReply(reply),
            },
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
            OperatorDecode::Malformed(family) => OperatorIngress::Malformed {
                family,
                reply: OperatorReply(reply),
            },
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
    if peer != policy.required {
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
    use std::io::{IoSlice, Read};
    use std::mem::MaybeUninit;
    use std::os::fd::{AsFd, OwnedFd};

    use rustix::fs::Uid;
    use rustix::net::sockopt::socket_peercred;
    use rustix::net::{
        AddressFamily, SendAncillaryBuffer, SendAncillaryMessage, SendFlags, Shutdown, SocketFlags,
        SocketType, send, sendmsg, shutdown, socketpair,
    };

    use super::{IpcError, MAX_FRAME_BYTES, PeerPolicy, PreparedTransport};

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

    #[test]
    fn authenticated_seqpacket_requires_record_then_eof_and_replies_once() {
        let (client, server) = connected_pair(SocketType::SEQPACKET);
        let policy = expected_policy(&server);
        let prepared = PreparedTransport::prepare(server, &policy).expect("prepared endpoint");
        send_record_and_eof(&client, b"fixed request");

        let packet = prepared.receive().expect("authenticated packet");
        assert_eq!(packet.bytes, b"fixed request");
        packet.reply.send_bytes(b"fixed response").expect("reply");

        let mut response = std::fs::File::from(client);
        let mut bytes = Vec::new();
        response.read_to_end(&mut bytes).expect("response read");
        assert_eq!(bytes, b"fixed response");
    }

    #[test]
    fn endpoint_type_and_exact_peer_policy_are_checked_before_receive() {
        let (_stream_client, stream_server) = connected_pair(SocketType::STREAM);
        let stream_policy = expected_policy(&stream_server);
        assert_eq!(
            PreparedTransport::prepare(stream_server, &stream_policy).err(),
            Some(IpcError::Endpoint)
        );

        let (_client, server) = connected_pair(SocketType::SEQPACKET);
        let actual = socket_peercred(&server).expect("peer credentials");
        let wrong = PeerPolicy::synthetic(rustix::net::UCred {
            pid: actual.pid,
            uid: Uid::from_raw(actual.uid.as_raw().wrapping_add(1)),
            gid: actual.gid,
        });
        assert_eq!(
            PreparedTransport::prepare(server, &wrong).err(),
            Some(IpcError::Peer)
        );
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
    fn truncation_and_rights_are_rejected() {
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
        let descriptor = std::fs::File::open("/dev/null").expect("test descriptor");
        let descriptors = [descriptor.as_fd()];
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
}
