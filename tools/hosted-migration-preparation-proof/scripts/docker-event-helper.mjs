import { Buffer } from "node:buffer";
import { closeSync, createReadStream, writeSync } from "node:fs";
import { createConnection } from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
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
const maximumJsonDepth = 64;
const maximumJsonNodes = 10_000;
const maximumAttributeBytes = 4_096;
const maximumAttributes = 32;
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

export const DOCKER_EVENT_LIMITS = Object.freeze({
  headerBytes: maximumHeaderBytes,
  httpChunkBytes: maximumHttpChunkBytes,
  eventFrameBytes: maximumEventFrameBytes,
  streamBytes: maximumStreamBytes,
  attributes: maximumAttributes,
  attributeBytes: maximumAttributeBytes,
  jsonDepth: maximumJsonDepth,
  jsonNodes: maximumJsonNodes,
});

export class DockerEventProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = "DockerEventProtocolError";
    this.code = code;
  }
}

function protocolError(code) {
  throw new DockerEventProtocolError(code);
}

function byteBuffer(bytes, label) {
  if (!(bytes instanceof Uint8Array)) protocolError(`${label}-bytes`);
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function appendBounded(current, addition, maximum, code) {
  const incoming = byteBuffer(addition, "input");
  if (incoming.length > maximum - current.length) protocolError(code);
  return current.length === 0
    ? Buffer.from(incoming)
    : Buffer.concat([current, incoming], current.length + incoming.length);
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
    if (this.text[0] !== "{") protocolError("event-json-root");
    const value = this.parseObject(0);
    if (this.offset !== this.text.length) protocolError("event-json-trailing");
    return value;
  }

  countNode() {
    this.nodes += 1;
    if (this.nodes > maximumJsonNodes) protocolError("event-json-nodes");
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
    if (depth > maximumJsonDepth) protocolError("event-json-depth");
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
      if (this.text[this.offset] !== '"') {
        protocolError("event-json-object-key");
      }
      const key = this.parseString();
      if (entries.has(key)) protocolError("event-json-duplicate-key");
      this.skipWhitespace();
      if (this.text[this.offset] !== ":") protocolError("event-json-colon");
      this.offset += 1;
      entries.set(key, this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.text[this.offset] === "}") {
        this.offset += 1;
        return entries;
      }
      if (this.text[this.offset] !== ",") {
        protocolError("event-json-object-comma");
      }
      this.offset += 1;
    }
    protocolError("event-json-object-eof");
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
      if (this.text[this.offset] !== ",") {
        protocolError("event-json-array-comma");
      }
      this.offset += 1;
    }
    protocolError("event-json-array-eof");
  }

  parseString() {
    this.countNode();
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset += 1;
        try {
          return JSON.parse(this.text.slice(start, this.offset));
        } catch {
          protocolError("event-json-string");
        }
      }
      if (code < 0x20) protocolError("event-json-string-control");
      if (code !== 0x5c) {
        this.offset += 1;
        continue;
      }
      this.offset += 1;
      const escape = this.text[this.offset];
      if (escape !== undefined && '"\\/bfnrt'.includes(escape)) {
        this.offset += 1;
        continue;
      }
      if (
        escape !== "u" ||
        !/^[0-9a-fA-F]{4}$/u.test(
          this.text.slice(this.offset + 1, this.offset + 5),
        )
      ) {
        protocolError("event-json-string-escape");
      }
      this.offset += 5;
    }
    protocolError("event-json-string-eof");
  }

  parseLiteral(token, value) {
    this.countNode();
    if (!this.text.startsWith(token, this.offset)) {
      protocolError("event-json-literal");
    }
    this.offset += token.length;
    return value;
  }

  parseNumber() {
    this.countNode();
    const match =
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
        this.text.slice(this.offset),
      );
    if (match === null) protocolError("event-json-number");
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
  if (!isObject(object)) protocolError("event-json-object");
  for (const key of object.keys()) {
    if (!allowed.has(key)) protocolError("event-json-unknown-key");
  }
  for (const key of required) {
    if (!object.has(key)) protocolError("event-json-missing-key");
  }
}

function requireString(object, key) {
  const value = object.get(key);
  if (typeof value !== "string") protocolError("event-json-string-field");
  return value;
}

function validateInvocation(invocation) {
  if (!/^[0-9a-f]{64}$/u.test(invocation)) {
    protocolError("event-invocation");
  }
}

function validateRole(role) {
  if (!allowedRoles.has(role)) protocolError("event-role");
}

export function parseDockerCreateEventFrame(frame, invocation, role) {
  validateInvocation(invocation);
  validateRole(role);
  const bytes = byteBuffer(frame, "event-frame");
  if (bytes.length === 0 || bytes.length > maximumEventFrameBytes) {
    protocolError("event-frame-cap");
  }

  let text;
  try {
    text = fatalUtf8.decode(bytes);
  } catch {
    protocolError("event-json-utf8");
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
    protocolError("event-kind");
  }
  if (event.has("status") && requireString(event, "status") !== "create") {
    protocolError("event-status");
  }

  const actor = event.get("Actor");
  requireExactKeys(
    actor,
    new Set(["ID", "Attributes"]),
    new Set(["ID", "Attributes"]),
  );
  const actorId = requireString(actor, "ID");
  if (!/^[0-9a-f]{64}$/u.test(actorId)) protocolError("event-actor-id");
  if (event.has("id") && requireString(event, "id") !== actorId) {
    protocolError("event-id-mismatch");
  }
  if (
    event.has("from") &&
    byteLength(requireString(event, "from")) > maximumAttributeBytes
  ) {
    protocolError("event-from-cap");
  }

  const attributes = actor.get("Attributes");
  if (!isObject(attributes) || attributes.size > maximumAttributes) {
    protocolError("event-attributes");
  }
  for (const [key, value] of attributes) {
    if (
      typeof value !== "string" ||
      byteLength(key) > maximumAttributeBytes ||
      byteLength(value) > maximumAttributeBytes
    ) {
      protocolError("event-attribute-value");
    }
  }
  if (!attributes.has(invocationAttribute) || !attributes.has(roleAttribute)) {
    protocolError("event-attribute-missing");
  }

  const time = event.get("time");
  if (
    !isNumberToken(time) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(time.numberToken) ||
    !Number.isSafeInteger(Number(time.numberToken))
  ) {
    protocolError("event-time");
  }
  const timeNano = event.get("timeNano");
  if (
    !isNumberToken(timeNano) ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(timeNano.numberToken)
  ) {
    protocolError("event-time-nano");
  }

  if (attributes.get(invocationAttribute) !== invocation) return undefined;
  if (attributes.get(roleAttribute) !== role) {
    protocolError("event-role-collision");
  }
  return actorId;
}

function parseHeaders(bytes) {
  const headerBytes = byteBuffer(bytes, "headers");
  if (headerBytes.length + 4 > maximumHeaderBytes) {
    protocolError("event-header-cap");
  }
  for (const byte of headerBytes) {
    if (
      byte > 0x7e ||
      (byte < 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a)
    ) {
      protocolError("event-header-byte");
    }
  }
  const lines = headerBytes.toString("ascii").split("\r\n");
  const statusLine = lines.shift();
  if (!/^HTTP\/1\.1 200(?: [\x20-\x7e]*)?$/u.test(statusLine ?? "")) {
    protocolError("event-http-status");
  }
  const headers = new Map();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) protocolError("event-header-field");
    const name = line.slice(0, colon);
    const rawValue = line.slice(colon + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
      protocolError("event-header-name");
    }
    for (const character of rawValue) {
      const code = character.charCodeAt(0);
      if (code !== 0x09 && (code < 0x20 || code > 0x7e)) {
        protocolError("event-header-value");
      }
    }
    const lowerName = name.toLowerCase();
    if (headers.has(lowerName)) protocolError("event-header-duplicate");
    headers.set(lowerName, rawValue.trim());
  }
  if (headers.has("content-length") || headers.has("content-encoding")) {
    protocolError("event-http-encoding");
  }
  if (headers.get("transfer-encoding")?.toLowerCase() !== "chunked") {
    protocolError("event-http-transfer");
  }
  if (
    headers.has("upgrade") ||
    headers
      .get("connection")
      ?.split(",")
      .some((token) => token.trim().toLowerCase() === "upgrade") === true
  ) {
    protocolError("event-http-upgrade");
  }
}

export function buildDockerEventRequest(invocation) {
  validateInvocation(invocation);
  const filter = `{"event":["create"],"label":["${invocationAttribute}=${invocation}"],"type":["container"]}`;
  const target =
    "/v1.47/events" + "?since=0&filters=" + encodeURIComponent(filter);
  return Buffer.from(
    `GET ${target} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`,
    "ascii",
  );
}

export class DockerEventHttpStreamParser {
  constructor(invocation, role) {
    validateInvocation(invocation);
    validateRole(role);
    this.invocation = invocation;
    this.role = role;
    this.phase = "headers";
    this.requestFlushed = false;
    this.headersAccepted = false;
    this.headerBuffer = Buffer.alloc(0);
    this.pendingBody = Buffer.alloc(0);
    this.chunkBuffer = Buffer.alloc(0);
    this.expectedChunkBytes = undefined;
    this.eventBuffer = Buffer.alloc(0);
    this.rawStreamBytes = 0;
    this.decodedStreamBytes = 0;
    this.matchingEventId = undefined;
  }

  markRequestFlushed() {
    if (this.phase === "closed" || this.requestFlushed) {
      protocolError("event-request-order");
    }
    this.requestFlushed = true;
    return this.enterStreamingIfReady();
  }

  acceptSocketBytes(bytes) {
    if (this.phase === "closed") protocolError("event-socket-after-close");
    const input = byteBuffer(bytes, "socket");
    if (input.length === 0) return [];
    if (!this.headersAccepted) return this.acceptHeaderBytes(input);
    if (this.phase === "waiting-for-request-flush") {
      this.pendingBody = appendBounded(
        this.pendingBody,
        input,
        maximumStreamBytes,
        "event-stream-cap",
      );
      return [];
    }
    if (this.phase !== "streaming") protocolError("event-socket-order");
    return this.acceptBodyBytes(input);
  }

  acceptHeaderBytes(bytes) {
    this.headerBuffer = appendBounded(
      this.headerBuffer,
      bytes,
      maximumHeaderBytes + maximumStreamBytes,
      "event-header-cap",
    );
    const headerEnd = this.headerBuffer.indexOf("\r\n\r\n", 0, "ascii");
    if (headerEnd < 0) {
      if (this.headerBuffer.length > maximumHeaderBytes) {
        protocolError("event-header-cap");
      }
      for (let index = 0; index < this.headerBuffer.length; index += 1) {
        if (
          this.headerBuffer[index] === 0x0a &&
          this.headerBuffer[index - 1] !== 0x0d
        ) {
          protocolError("event-header-line");
        }
        if (
          this.headerBuffer[index] === 0x0d &&
          index + 1 < this.headerBuffer.length &&
          this.headerBuffer[index + 1] !== 0x0a
        ) {
          protocolError("event-header-line");
        }
      }
      return [];
    }

    const completeLength = headerEnd + 4;
    if (completeLength > maximumHeaderBytes) protocolError("event-header-cap");
    parseHeaders(this.headerBuffer.subarray(0, headerEnd));
    const body = Buffer.from(this.headerBuffer.subarray(completeLength));
    if (body.length > maximumStreamBytes) protocolError("event-stream-cap");
    this.headerBuffer = Buffer.alloc(0);
    this.headersAccepted = true;
    this.pendingBody = body;
    this.phase = "waiting-for-request-flush";
    return this.enterStreamingIfReady();
  }

  enterStreamingIfReady() {
    if (!this.headersAccepted || !this.requestFlushed) return [];
    if (this.phase !== "waiting-for-request-flush") {
      protocolError("event-ready-order");
    }
    this.phase = "streaming";
    const body = this.pendingBody;
    this.pendingBody = Buffer.alloc(0);
    const actions = [{ type: "ready" }];
    if (body.length > 0) actions.push(...this.acceptBodyBytes(body));
    return Object.freeze(actions);
  }

  acceptBodyBytes(bytes) {
    const input = byteBuffer(bytes, "body");
    if (input.length > maximumStreamBytes - this.rawStreamBytes) {
      protocolError("event-stream-cap");
    }
    this.rawStreamBytes += input.length;
    this.chunkBuffer = appendBounded(
      this.chunkBuffer,
      input,
      maximumStreamBytes,
      "event-stream-cap",
    );
    const actions = [];

    while (true) {
      if (this.expectedChunkBytes === undefined) {
        const lineEnd = this.chunkBuffer.indexOf("\r\n", 0, "ascii");
        if (lineEnd < 0) {
          if (this.chunkBuffer.length > 8) protocolError("event-chunk-size");
          break;
        }
        const sizeLine = this.chunkBuffer.subarray(0, lineEnd).toString("ascii");
        if (!/^[0-9a-fA-F]+$/u.test(sizeLine) || sizeLine.length > 8) {
          protocolError("event-chunk-size");
        }
        const size = Number.parseInt(sizeLine, 16);
        if (size === 0) protocolError("event-socket-eof-before-close");
        if (size > maximumHttpChunkBytes) protocolError("event-chunk-cap");
        this.expectedChunkBytes = size;
        this.chunkBuffer = Buffer.from(this.chunkBuffer.subarray(lineEnd + 2));
      }
      if (this.chunkBuffer.length < this.expectedChunkBytes + 2) break;
      if (
        this.chunkBuffer[this.expectedChunkBytes] !== 0x0d ||
        this.chunkBuffer[this.expectedChunkBytes + 1] !== 0x0a
      ) {
        protocolError("event-chunk-ending");
      }
      const decoded = this.chunkBuffer.subarray(0, this.expectedChunkBytes);
      this.chunkBuffer = Buffer.from(
        this.chunkBuffer.subarray(this.expectedChunkBytes + 2),
      );
      this.expectedChunkBytes = undefined;
      actions.push(...this.acceptDecodedBytes(decoded));
    }
    return Object.freeze(actions);
  }

  acceptDecodedBytes(bytes) {
    if (bytes.length > maximumStreamBytes - this.decodedStreamBytes) {
      protocolError("event-stream-cap");
    }
    this.decodedStreamBytes += bytes.length;
    this.eventBuffer = appendBounded(
      this.eventBuffer,
      bytes,
      maximumEventFrameBytes + maximumHttpChunkBytes,
      "event-frame-cap",
    );
    const actions = [];
    while (true) {
      const newline = this.eventBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline === 0 || newline > maximumEventFrameBytes) {
        protocolError("event-frame-cap");
      }
      const frame = this.eventBuffer.subarray(0, newline);
      this.eventBuffer = Buffer.from(this.eventBuffer.subarray(newline + 1));
      const id = parseDockerCreateEventFrame(
        frame,
        this.invocation,
        this.role,
      );
      if (id === undefined) continue;
      if (this.matchingEventId !== undefined) {
        protocolError("event-duplicate");
      }
      this.matchingEventId = id;
      actions.push(Object.freeze({ type: "event", id }));
    }
    if (this.eventBuffer.length > maximumEventFrameBytes) {
      protocolError("event-frame-cap");
    }
    return Object.freeze(actions);
  }

  closeAtControlLinearization() {
    if (this.phase !== "streaming") protocolError("event-close-order");
    if (
      this.pendingBody.length !== 0 ||
      this.chunkBuffer.length !== 0 ||
      this.expectedChunkBytes !== undefined ||
      this.eventBuffer.length !== 0
    ) {
      protocolError("event-incomplete-at-close");
    }
    this.phase = "closed";
  }
}

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

function runDockerEventHelper() {
  let phase = "open";
  let terminal = false;
  let controlEnded = false;
  let controlBuffer = Buffer.alloc(0);
  let socket;
  let socketClosed = false;
  let streamParser;

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

  function applyActions(actions) {
    try {
      for (const action of actions) {
        if (action.type === "ready") {
          if (phase !== "headers") throw new Error("ready order");
          writeAll(readyFd, readyFrame);
          phase = "streaming";
        } else if (action.type === "event") {
          if (phase !== "streaming") throw new Error("event order");
          writeAll(
            eventFd,
            Buffer.concat([
              eventPrefix,
              Buffer.from(`${action.id}\n`, "ascii"),
            ]),
          );
        } else {
          throw new Error("unknown action");
        }
      }
    } catch {
      refuse("output-pipe");
    }
  }

  function finishIfSettled() {
    if (terminal || phase !== "closing" || !controlEnded || !socketClosed) {
      return;
    }
    terminal = true;
    closeIgnoringErrors(controlFd);
    process.exit(0);
  }

  function beginClose() {
    if (phase !== "streaming" || streamParser === undefined) {
      refuse("control-close-order");
    }
    try {
      streamParser.closeAtControlLinearization();
    } catch (error) {
      refuse(
        error instanceof DockerEventProtocolError
          ? error.code
          : "event-close",
      );
    }
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

  function connectToEngine(invocation, role) {
    phase = "connecting";
    try {
      streamParser = new DockerEventHttpStreamParser(invocation, role);
    } catch (error) {
      refuse(
        error instanceof DockerEventProtocolError
          ? error.code
          : "event-parser",
      );
    }
    const request = buildDockerEventRequest(invocation);
    socket = createConnection({ path: socketPath });
    socket.on("connect", () => {
      if (terminal || phase !== "connecting") return;
      phase = "headers";
      socket.write(request, (error) => {
        if (terminal || phase === "closing") return;
        if (error !== undefined && error !== null) {
          refuse("event-request-write");
          return;
        }
        try {
          applyActions(streamParser.markRequestFlushed());
        } catch (error) {
          refuse(
            error instanceof DockerEventProtocolError
              ? error.code
              : "request-flush",
          );
        }
      });
    });
    socket.on("data", (bytes) => {
      if (terminal || phase === "closing") return;
      try {
        applyActions(streamParser.acceptSocketBytes(bytes));
      } catch (error) {
        refuse(
          error instanceof DockerEventProtocolError
            ? error.code
            : "event-stream",
        );
      }
    });
    socket.on("end", () => {
      if (!terminal && phase !== "closing") {
        refuse("event-socket-eof-before-close");
      }
    });
    socket.on("error", () => {
      if (!terminal && phase !== "closing") refuse("event-socket-error");
    });
    socket.on("close", () => {
      if (terminal) return;
      if (phase !== "closing") refuse("event-socket-close-before-control");
      socketClosed = true;
      finishIfSettled();
    });
  }

  function parseOpenControl() {
    if (controlBuffer.length > maximumControlBytes) refuse("control-cap");
    const firstNewline = controlBuffer.indexOf(0x0a);
    if (firstNewline < 0) {
      const comparable = Math.min(controlBuffer.length, openPrefix.length);
      if (
        !controlBuffer
          .subarray(0, comparable)
          .equals(openPrefix.subarray(0, comparable))
      ) {
        refuse("control-open");
      }
      return;
    }
    const secondNewline = controlBuffer.indexOf(0x0a, firstNewline + 1);
    const thirdNewline =
      secondNewline < 0
        ? -1
        : controlBuffer.indexOf(0x0a, secondNewline + 1);
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
    controlBuffer = Buffer.from(controlBuffer.subarray(thirdNewline + 1));
    if (controlBuffer.length !== 0) refuse("control-order");
    connectToEngine(lines[1], lines[2]);
  }

  function parseCloseControl() {
    if (controlBuffer.length > closeFrame.length) {
      refuse("control-trailing");
    }
    const comparable = Math.min(controlBuffer.length, closeFrame.length);
    if (
      !controlBuffer
        .subarray(0, comparable)
        .equals(closeFrame.subarray(0, comparable))
    ) {
      refuse("control-close");
    }
    if (controlBuffer.length === closeFrame.length) beginClose();
  }

  function handleControlBytes(bytes) {
    if (terminal) return;
    if (phase === "closing") refuse("control-trailing");
    try {
      controlBuffer = appendBounded(
        controlBuffer,
        bytes,
        maximumControlBytes,
        "control-cap",
      );
    } catch (error) {
      refuse(
        error instanceof DockerEventProtocolError ? error.code : "control-cap",
      );
    }
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDockerEventHelper();
}
