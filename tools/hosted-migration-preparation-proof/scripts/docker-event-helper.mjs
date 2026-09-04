import { Buffer } from "node:buffer";
import { closeSync, createReadStream, writeSync } from "node:fs";
import { createConnection } from "node:net";
import process from "node:process";
import { TextDecoder } from "node:util";

const socketPath = "/var/run/docker.sock";
const controlFd = 3;
const readyFd = 4;
const eventFd = 5;
const maximumControlBytes = 256;
const maximumHeaderBytes = 8_192;
const maximumHttpChunkBytes = 65_536;
const maximumEventFrameBytes = 65_536;
const maximumStreamBytes = 1024 * 1024;
const maximumBufferedPreReadyBytes =
  maximumStreamBytes + maximumHttpChunkBytes + 1024;
const maximumJsonDepth = 64;
const maximumJsonNodes = 10_000;
const invocationAttribute = "com.openspell.wp201.invocation";
const roleAttribute = "com.openspell.wp201.role";
const allowedRoles = new Set([
  "dependency-acquisition-v1",
  "root-bridge-proof-v1",
]);
const openPrefix = Buffer.from(
  "openspell.wp201.docker-event-open.v1\n",
  "ascii",
);
const closeFrame = Buffer.from(
  "openspell.wp201.docker-event-close.v1\n",
  "ascii",
);
const readyFrame = Buffer.from(
  "openspell.wp201.docker-event-ready.v1\n",
  "ascii",
);
const eventPrefix = Buffer.from(
  "openspell.wp201.docker-event-id.v1\n",
  "ascii",
);
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

let phase = "open";
let terminal = false;
let controlEnded = false;
let controlBuffer = Buffer.alloc(0);
let socket;
let socketClosed = false;
let requestFlushed = false;
let headersAccepted = false;
let pendingBody = Buffer.alloc(0);
let headerBuffer = Buffer.alloc(0);
let chunkBuffer = Buffer.alloc(0);
let expectedChunkBytes;
let eventBuffer = Buffer.alloc(0);
let decodedStreamBytes = 0;
let matchingEventSeen = false;
let invocationValue;
let selectedRole;

function closeIgnoringErrors(fd) {
  try {
    closeSync(fd);
  } catch {
    // A refusal remains a refusal when its peer has already closed the pipe.
  }
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("short write");
    offset += written;
  }
}

function refuse(code) {
  if (terminal) return;
  terminal = true;
  try {
    writeAll(
      2,
      Buffer.from(
        `openspell.wp201.docker-event-helper.refused.v1\n${code}\n`,
        "ascii",
      ),
    );
  } catch {
    // The exit status remains authoritative when the diagnostic peer is gone.
  }
  if (socket !== undefined) socket.destroy();
  closeIgnoringErrors(readyFd);
  closeIgnoringErrors(eventFd);
  process.exit(125);
}

function appendBounded(current, addition, maximum, code) {
  if (current.length + addition.length > maximum) refuse(code);
  return current.length === 0
    ? Buffer.from(addition)
    : Buffer.concat([current, addition], current.length + addition.length);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

class JsonDecoder {
  constructor(text) {
    this.text = text;
    this.offset = 0;
    this.nodes = 0;
  }

  decodeObjectFrame() {
    if (this.text[0] !== "{") throw new Error("root");
    const value = this.parseObject(0);
    if (this.offset !== this.text.length) throw new Error("trailing");
    return value;
  }

  countNode() {
    this.nodes += 1;
    if (this.nodes > maximumJsonNodes) throw new Error("nodes");
  }

  skipWhitespace() {
    while (
      this.offset < this.text.length &&
      (this.text[this.offset] === " " ||
        this.text[this.offset] === "\t" ||
        this.text[this.offset] === "\r" ||
        this.text[this.offset] === "\n")
    ) {
      this.offset += 1;
    }
  }

  parseValue(depth) {
    if (depth > maximumJsonDepth) throw new Error("depth");
    this.skipWhitespace();
    const next = this.text[this.offset];
    if (next === "{") return this.parseObject(depth);
    if (next === "[") return this.parseArray(depth);
    if (next === '"') return this.parseString();
    if (next === "t") return this.parseLiteral("true", true);
    if (next === "f") return this.parseLiteral("false", false);
    if (next === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  parseObject(depth) {
    this.countNode();
    this.offset += 1;
    const entries = new Map();
    this.skipWhitespace();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return entries;
    }
    while (this.offset < this.text.length) {
      this.skipWhitespace();
      if (this.text[this.offset] !== '"') throw new Error("object-key");
      const key = this.parseString();
      if (entries.has(key)) throw new Error("duplicate-key");
      this.skipWhitespace();
      if (this.text[this.offset] !== ":") throw new Error("colon");
      this.offset += 1;
      entries.set(key, this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.text[this.offset] === "}") {
        this.offset += 1;
        return entries;
      }
      if (this.text[this.offset] !== ",") throw new Error("object-comma");
      this.offset += 1;
    }
    throw new Error("object-eof");
  }

  parseArray(depth) {
    this.countNode();
    this.offset += 1;
    const values = [];
    this.skipWhitespace();
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return values;
    }
    while (this.offset < this.text.length) {
      values.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.text[this.offset] === "]") {
        this.offset += 1;
        return values;
      }
      if (this.text[this.offset] !== ",") throw new Error("array-comma");
      this.offset += 1;
    }
    throw new Error("array-eof");
  }

  parseString() {
    this.countNode();
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset += 1;
        return JSON.parse(this.text.slice(start, this.offset));
      }
      if (code < 0x20) throw new Error("string-control");
      if (code !== 0x5c) {
        this.offset += 1;
        continue;
      }
      this.offset += 1;
      const escape = this.text[this.offset];
      if ('"\\/bfnrt'.includes(escape)) {
        this.offset += 1;
        continue;
      }
      if (
        escape !== "u" ||
        !/^[0-9a-fA-F]{4}$/u.test(
          this.text.slice(this.offset + 1, this.offset + 5),
        )
      ) {
        throw new Error("string-escape");
      }
      this.offset += 5;
    }
    throw new Error("string-eof");
  }

  parseLiteral(token, value) {
    this.countNode();
    if (!this.text.startsWith(token, this.offset)) throw new Error("literal");
    this.offset += token.length;
    return value;
  }

  parseNumber() {
    this.countNode();
    const match =
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
        this.text.slice(this.offset),
      );
    if (match === null) throw new Error("number");
    this.offset += match[0].length;
    return { numberToken: match[0] };
  }
}

function isObject(value) {
  return value instanceof Map;
}

function isNumberToken(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.numberToken === "string"
  );
}

function requireExactKeys(object, allowed, required) {
  if (!isObject(object)) throw new Error("object");
  for (const key of object.keys()) {
    if (!allowed.has(key)) throw new Error("unknown-key");
  }
  for (const key of required) {
    if (!object.has(key)) throw new Error("missing-key");
  }
}

function requireString(object, key) {
  const value = object.get(key);
  if (typeof value !== "string") throw new Error("string-field");
  return value;
}

function classifyEvent(frame) {
  let text;
  try {
    text = fatalUtf8.decode(frame);
  } catch {
    throw new Error("utf8");
  }
  const event = new JsonDecoder(text).decodeObjectFrame();
  requireExactKeys(
    event,
    new Set([
      "status",
      "id",
      "from",
      "Type",
      "Action",
      "Actor",
      "scope",
      "time",
      "timeNano",
    ]),
    new Set(["Type", "Action", "Actor", "scope", "time", "timeNano"]),
  );
  if (
    requireString(event, "Type") !== "container" ||
    requireString(event, "Action") !== "create" ||
    requireString(event, "scope") !== "local"
  ) {
    throw new Error("event-kind");
  }
  if (event.has("status") && requireString(event, "status") !== "create") {
    throw new Error("status");
  }

  const actor = event.get("Actor");
  requireExactKeys(
    actor,
    new Set(["ID", "Attributes"]),
    new Set(["ID", "Attributes"]),
  );
  const actorId = requireString(actor, "ID");
  if (!/^[0-9a-f]{64}$/u.test(actorId)) throw new Error("actor-id");
  if (event.has("id") && requireString(event, "id") !== actorId) {
    throw new Error("id-mismatch");
  }
  if (event.has("from") && byteLength(requireString(event, "from")) > 4096) {
    throw new Error("from-size");
  }

  const attributes = actor.get("Attributes");
  if (!isObject(attributes) || attributes.size > 32) {
    throw new Error("attributes");
  }
  for (const [key, value] of attributes) {
    if (
      typeof value !== "string" ||
      byteLength(key) > 4096 ||
      byteLength(value) > 4096
    ) {
      throw new Error("attribute-value");
    }
  }
  if (!attributes.has(invocationAttribute) || !attributes.has(roleAttribute)) {
    throw new Error("attribute-missing");
  }

  const time = event.get("time");
  if (
    !isNumberToken(time) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(time.numberToken) ||
    !Number.isSafeInteger(Number(time.numberToken))
  ) {
    throw new Error("time");
  }
  const timeNano = event.get("timeNano");
  if (
    !isNumberToken(timeNano) ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(timeNano.numberToken)
  ) {
    throw new Error("time-nano");
  }

  if (attributes.get(invocationAttribute) !== invocationValue) {
    return undefined;
  }
  if (attributes.get(roleAttribute) !== selectedRole) {
    throw new Error("role-collision");
  }
  return actorId;
}

function emitEvent(frame) {
  let id;
  try {
    id = classifyEvent(frame);
  } catch {
    refuse("event-json");
  }
  if (id === undefined) return;
  if (matchingEventSeen) refuse("duplicate-event");
  matchingEventSeen = true;
  try {
    writeAll(eventFd, Buffer.concat([eventPrefix, Buffer.from(`${id}\n`, "ascii")]));
  } catch {
    refuse("event-pipe");
  }
}

function acceptDecodedBytes(bytes) {
  decodedStreamBytes += bytes.length;
  if (decodedStreamBytes > maximumStreamBytes) refuse("stream-cap");
  eventBuffer = appendBounded(
    eventBuffer,
    bytes,
    maximumEventFrameBytes + maximumHttpChunkBytes,
    "event-cap",
  );
  while (true) {
    const newline = eventBuffer.indexOf(0x0a);
    if (newline < 0) {
      if (eventBuffer.length > maximumEventFrameBytes) refuse("event-cap");
      return;
    }
    if (newline > maximumEventFrameBytes) refuse("event-cap");
    const frame = eventBuffer.subarray(0, newline);
    eventBuffer = Buffer.from(eventBuffer.subarray(newline + 1));
    emitEvent(frame);
  }
}

function acceptChunkedBytes(bytes) {
  chunkBuffer = appendBounded(
    chunkBuffer,
    bytes,
    maximumHttpChunkBytes * 2 + 128,
    "chunk-cap",
  );
  while (true) {
    if (expectedChunkBytes === undefined) {
      const lineEnd = chunkBuffer.indexOf("\r\n", 0, "ascii");
      if (lineEnd < 0) {
        if (chunkBuffer.length > 16) refuse("chunk-size");
        return;
      }
      const sizeLine = chunkBuffer.subarray(0, lineEnd).toString("ascii");
      if (!/^[0-9a-fA-F]+$/u.test(sizeLine) || sizeLine.length > 8) {
        refuse("chunk-size");
      }
      const size = Number.parseInt(sizeLine, 16);
      if (size === 0) refuse("socket-eof-before-close");
      if (size > maximumHttpChunkBytes) refuse("chunk-cap");
      expectedChunkBytes = size;
      chunkBuffer = Buffer.from(chunkBuffer.subarray(lineEnd + 2));
    }
    if (chunkBuffer.length < expectedChunkBytes + 2) return;
    if (
      chunkBuffer[expectedChunkBytes] !== 0x0d ||
      chunkBuffer[expectedChunkBytes + 1] !== 0x0a
    ) {
      refuse("chunk-ending");
    }
    const decoded = chunkBuffer.subarray(0, expectedChunkBytes);
    chunkBuffer = Buffer.from(chunkBuffer.subarray(expectedChunkBytes + 2));
    expectedChunkBytes = undefined;
    acceptDecodedBytes(decoded);
  }
}

function parseHeaders(bytes) {
  headerBuffer = appendBounded(
    headerBuffer,
    bytes,
    maximumHeaderBytes + maximumBufferedPreReadyBytes,
    "header-cap",
  );
  const headerEnd = headerBuffer.indexOf("\r\n\r\n", 0, "ascii");
  if (headerEnd < 0) {
    if (headerBuffer.length > maximumHeaderBytes) refuse("header-cap");
    for (let index = 0; index < headerBuffer.length; index += 1) {
      if (headerBuffer[index] === 0x0a && headerBuffer[index - 1] !== 0x0d) {
        refuse("header-line");
      }
      if (
        headerBuffer[index] === 0x0d &&
        index + 1 < headerBuffer.length &&
        headerBuffer[index + 1] !== 0x0a
      ) {
        refuse("header-line");
      }
    }
    return;
  }
  const completeLength = headerEnd + 4;
  if (completeLength > maximumHeaderBytes) refuse("header-cap");
  const headerBytes = headerBuffer.subarray(0, headerEnd);
  for (const byte of headerBytes) {
    if (byte > 0x7e || (byte < 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a)) {
      refuse("header-byte");
    }
  }
  const lines = headerBytes.toString("ascii").split("\r\n");
  const statusLine = lines.shift();
  if (!/^HTTP\/1\.1 200(?: [\x20-\x7e]*)?$/u.test(statusLine ?? "")) {
    refuse("http-status");
  }
  const headers = new Map();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) refuse("header-field");
    const name = line.slice(0, colon);
    const rawValue = line.slice(colon + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
      refuse("header-name");
    }
    for (const character of rawValue) {
      const code = character.charCodeAt(0);
      if (code !== 0x09 && (code < 0x20 || code > 0x7e)) {
        refuse("header-value");
      }
    }
    const lowerName = name.toLowerCase();
    if (headers.has(lowerName)) refuse("header-duplicate");
    headers.set(lowerName, rawValue.trim());
  }
  if (headers.has("content-length") || headers.has("content-encoding")) {
    refuse("http-encoding");
  }
  if (headers.get("transfer-encoding")?.toLowerCase() !== "chunked") {
    refuse("http-transfer");
  }
  if (
    headers.has("upgrade") ||
    headers
      .get("connection")
      ?.split(",")
      .some((token) => token.trim().toLowerCase() === "upgrade") === true
  ) {
    refuse("http-upgrade");
  }
  pendingBody = Buffer.from(headerBuffer.subarray(completeLength));
  if (pendingBody.length > maximumBufferedPreReadyBytes) refuse("stream-cap");
  headerBuffer = Buffer.alloc(0);
  headersAccepted = true;
  phase = "ready";
  enterStreamingIfReady();
}

function enterStreamingIfReady() {
  if (!headersAccepted || !requestFlushed || phase === "streaming") return;
  if (phase !== "ready") refuse("ready-order");
  try {
    writeAll(readyFd, readyFrame);
  } catch {
    refuse("ready-pipe");
  }
  phase = "streaming";
  const body = pendingBody;
  pendingBody = Buffer.alloc(0);
  if (body.length > 0) acceptChunkedBytes(body);
}

function handleSocketBytes(bytes) {
  if (terminal || phase === "closing") return;
  if (!headersAccepted) {
    parseHeaders(bytes);
    return;
  }
  if (phase === "ready") {
    pendingBody = appendBounded(
      pendingBody,
      bytes,
      maximumBufferedPreReadyBytes,
      "stream-cap",
    );
    return;
  }
  if (phase !== "streaming") refuse("socket-order");
  acceptChunkedBytes(bytes);
}

function finishIfSettled() {
  if (terminal || phase !== "closing" || !controlEnded || !socketClosed) return;
  terminal = true;
  closeIgnoringErrors(controlFd);
  process.exit(0);
}

function beginClose() {
  if (phase !== "streaming") refuse("close-order");
  phase = "closing";
  try {
    closeSync(readyFd);
    closeSync(eventFd);
  } catch {
    refuse("output-close");
  }
  socket.destroy();
  finishIfSettled();
}

function connectToEngine() {
  phase = "connecting";
  const filter = `{"event":["create"],"label":["${invocationAttribute}=${invocationValue}"],"type":["container"]}`;
  const target = `/v1.47/events?since=0&filters=${encodeURIComponent(filter)}`;
  const request = Buffer.from(
    `GET ${target} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`,
    "ascii",
  );
  socket = createConnection({ path: socketPath });
  socket.on("connect", () => {
    if (terminal || phase !== "connecting") return;
    phase = "headers";
    socket.write(request, () => {
      if (terminal || phase === "closing") return;
      requestFlushed = true;
      enterStreamingIfReady();
    });
  });
  socket.on("data", (bytes) => {
    if (terminal) return;
    handleSocketBytes(bytes);
  });
  socket.on("end", () => {
    if (!terminal && phase !== "closing") refuse("socket-eof-before-close");
  });
  socket.on("error", () => {
    if (!terminal && phase !== "closing") refuse("socket-error");
  });
  socket.on("close", () => {
    if (terminal) return;
    if (phase !== "closing") refuse("socket-close-before-control");
    socketClosed = true;
    finishIfSettled();
  });
}

function parseOpenControl() {
  if (controlBuffer.length > maximumControlBytes) refuse("control-cap");
  const firstNewline = controlBuffer.indexOf(0x0a);
  if (firstNewline < 0) {
    const comparable = Math.min(controlBuffer.length, openPrefix.length);
    if (!controlBuffer.subarray(0, comparable).equals(openPrefix.subarray(0, comparable))) {
      refuse("control-open");
    }
    return;
  }
  const secondNewline = controlBuffer.indexOf(0x0a, firstNewline + 1);
  const thirdNewline =
    secondNewline < 0 ? -1 : controlBuffer.indexOf(0x0a, secondNewline + 1);
  if (thirdNewline < 0) return;
  const open = controlBuffer.subarray(0, thirdNewline + 1);
  let text;
  try {
    text = fatalUtf8.decode(open);
  } catch {
    refuse("control-utf8");
  }
  const lines = text.split("\n");
  if (
    lines.length !== 4 ||
    lines[0] !== "openspell.wp201.docker-event-open.v1" ||
    !/^[0-9a-f]{64}$/u.test(lines[1]) ||
    !allowedRoles.has(lines[2]) ||
    lines[3] !== ""
  ) {
    refuse("control-open");
  }
  invocationValue = lines[1];
  selectedRole = lines[2];
  controlBuffer = Buffer.from(controlBuffer.subarray(thirdNewline + 1));
  if (controlBuffer.length !== 0) refuse("control-order");
  connectToEngine();
}

function parseCloseControl() {
  if (controlBuffer.length > closeFrame.length) refuse("control-trailing");
  const comparable = Math.min(controlBuffer.length, closeFrame.length);
  if (!controlBuffer.subarray(0, comparable).equals(closeFrame.subarray(0, comparable))) {
    refuse("control-close");
  }
  if (controlBuffer.length === closeFrame.length) beginClose();
}

function handleControlBytes(bytes) {
  if (terminal) return;
  if (phase === "closing") refuse("control-trailing");
  controlBuffer = appendBounded(
    controlBuffer,
    bytes,
    maximumControlBytes,
    "control-cap",
  );
  if (phase === "open") {
    parseOpenControl();
    return;
  }
  if (phase !== "streaming") refuse("control-order");
  parseCloseControl();
}

if (process.argv.length !== 2) refuse("arguments");

const control = createReadStream("/dev/null", {
  fd: controlFd,
  autoClose: false,
});
control.on("data", (bytes) => handleControlBytes(bytes));
control.on("end", () => {
  if (terminal) return;
  controlEnded = true;
  if (phase !== "closing") refuse("control-eof-before-close");
  finishIfSettled();
});
control.on("error", () => refuse("control-read"));

process.on("uncaughtException", () => refuse("uncaught"));
process.on("unhandledRejection", () => refuse("rejection"));
