#!/usr/bin/env bash
set -euo pipefail

: "${WIZARD_ADS_CLOUDFLARED_UID:?Set WIZARD_ADS_CLOUDFLARED_UID to the tunnel-token file owner uid}"
: "${WIZARD_ADS_CLOUDFLARED_GID:?Set WIZARD_ADS_CLOUDFLARED_GID to the tunnel-token file owner gid}"

case "$WIZARD_ADS_CLOUDFLARED_UID:$WIZARD_ADS_CLOUDFLARED_GID" in
  *[!0-9:]* | :* | *: | *:*:*)
    echo "cloudflared UID and GID must be numeric" >&2
    exit 1
    ;;
esac

expected_identity="$WIZARD_ADS_CLOUDFLARED_UID:$WIZARD_ADS_CLOUDFLARED_GID"
compose_file="$(dirname "$0")/mcp-evo.compose.yaml"

WIZARD_ADS_MCP_ENV_FILE=/dev/null \
WIZARD_ADS_MCP_CLOUDFLARED_TOKEN_FILE=/dev/null \
WIZARD_ADS_MCP_REVISION=0000000000000000000000000000000000000000 \
  docker compose -f "$compose_file" config --format json | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const config = JSON.parse(input);
  const expectedIdentity = process.argv[1];
  const cloudflared = config.services?.cloudflared;
  const mountedSecret = cloudflared?.secrets?.find(
    (secret) => secret.source === "tunnel-token",
  );

  if (cloudflared?.user !== expectedIdentity) {
    throw new Error(
      `expected cloudflared user ${expectedIdentity}, received ${String(cloudflared?.user)}`,
    );
  }
  if (mountedSecret?.target !== "/run/secrets/tunnel-token") {
    throw new Error("tunnel-token is not mounted at the expected read-only secret path");
  }
  if (config.secrets?.["tunnel-token"]?.file !== "/dev/null") {
    throw new Error("synthetic tunnel-token source was not preserved in the rendered config");
  }

  process.stdout.write(`mcp-evo compose check passed for cloudflared user ${expectedIdentity}\n`);
});
' "$expected_identity"
