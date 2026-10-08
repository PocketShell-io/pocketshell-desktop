# Private hosts through the PocketShell gateway

Desktop can carry its regular SSH sessions through an enrolled host's outbound
gateway tunnel. The existing terminal, session, SFTP and port-forwarding services
use the same end-to-end SSH connection. The host's gateway agent must already be
running, and the host endpoint must accept the client's SSH user key.

Sign in from Desktop's Account window. Desktop exchanges the Google ID token at
the trusted PocketShell sync broker's `POST /gateway/token`. Only the resulting
scoped, short-lived gateway JWT reaches the gateway; the Google token never does.
There is no fallback to direct TCP when a gateway target is malformed or offline.

Provision `gateway-hosts.json` in Electron's `userData` directory (development on
Windows: `%APPDATA%/pocketshell-desktop/gateway-hosts.json`). Its array entries are
local enrollments, not a synced source of host trust:

```json
[
  {
    "name": "win35-gateway",
    "user": "User",
    "identityFile": "C:/Users/alexey/.ssh/id_win35",
    "gateway": {
      "serverUrl": "wss://gateway.pocketshell.io",
      "deviceId": "YOUR_ENROLLED_DEVICE_ID"
    },
    "sshHostKeyFingerprint": "SHA256:YOUR_INDEPENDENTLY_VERIFIED_HOST_FINGERPRINT"
  }
]
```

Read the fingerprint through trusted access to the endpoint or its enrollment
state. The gateway's ready-frame key is advisory and is never accepted as a pin.
Invalid registrations are omitted; absent or mismatched pins refuse connections
before user authentication. Entries appear in Desktop's host picker after a
refresh or restart. The client requires WSS; plaintext WS is only available to
transport tests with explicit development opt-in.

For a Windows endpoint provisioned with the reviewed native CLI, main's local
registration may additionally contain `nativeWindowsCli: { "executable":
"C:/Users/User/PROVISIONED_RUNTIME/Scripts/pocketshell.exe" }`. Provisioning must
provide the actual protected installation path; this example is not a deployed
path. Use forward slashes and the endpoint's allowed SSH username (`user` for
Win35). Invalid policies omit the entire registration rather than selecting a
global executable.

This opt-in selects the absolute executable for version/platform qualification,
schema-3 session discovery, tree reads and schema-1 workspace queries, and
session attach by immutable UUID. The adapter requires native CLI 0.5.8 and the
advertised workspaces/tree/list/attach capabilities. It never retries through
global `pocketshell`, raw `a`, cached Aplexer executors or tmux. Other hosts keep
their existing selection behavior. Native create/rename/kill remain explicitly
unavailable until their host contract is implemented; workspace queries do not
yet replace Desktop's existing root preferences in the shared UI.
Native tree writes also refuse explicitly: upsert requires a corresponding
`expected_version`, which the existing Desktop caller does not retain. A
version-aware client must implement conflict handling before these writes run.
