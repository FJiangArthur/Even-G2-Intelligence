# Historical v0.3 gateway deployment

Do not follow this for the v0.4 G2 app. No Helix gateway or server address is required. See G2_DEPLOYMENT.md for current instructions. The old configure:gateway npm command has been removed to prevent changing the phone-only manifest accidentally.

Helix G2 ships as two independently deployed pieces:

1. the Even Hub plugin, bundled into `apps/g2-plugin/helix-g2.ehpk`; and
2. the user's self-hosted Helix server, reachable from the phone as a `wss://` endpoint.

The plugin bundle contains no Deepgram, Soniox, OpenAI, or Omi credential.
Keys may be entered at runtime in the companion or supplied as optional server
environment fallbacks. The checked-in server is a
single-operator deployment: one optional shared gateway token protects all
sessions, and per-user token issuance/expiry is not implemented yet.

## 1. Prepare the G2 account and device

- Pair the G2 with the Even Realities phone app and install current firmware.
- Sign in to the Even Hub web portal with the same account.
- Enable Developer Mode, then force-quit and reopen the phone app.
- Confirm the Even Hub developer section appears in the phone app.

## 2. Deploy the gateway

Install and build the workspace on a Node.js 22 host:

```bash
npm ci
npm run build -w @helix/conversation-sdk
npm run build -w @helix/gateway
```

Configure provider metadata and allowlists on the host. This example enables
switchable Deepgram and Soniox transcription with OpenAI Responses answering;
the commented keys are optional administrator fallbacks because the user may
enter them in the companion instead:

```dotenv
HELIX_MODE=mock
HELIX_HOST=0.0.0.0
HELIX_PORT=8787
HELIX_GATEWAY_TOKEN=replace-with-a-long-random-operator-token

# HELIX_DEEPGRAM_API_KEY=optional-server-fallback
# HELIX_SONIOX_API_KEY=optional-server-fallback
# HELIX_OPENAI_API_KEY=optional-server-fallback

HELIX_TRANSCRIPTION_PROVIDER=deepgram
HELIX_ANSWER_PROVIDER=openai-responses
HELIX_ALLOWED_TRANSCRIPTION_PROFILES=deepgram,soniox
HELIX_ALLOWED_ANSWER_PROFILES=openai-responses,openai-compatible

HELIX_OMI_WRITE_ENABLED=false
```

Start the built service with the environment injected by the host:

```bash
npm run start -w @helix/gateway
```

Terminate TLS at a trusted reverse proxy or hosting platform and expose:

```text
wss://helix.example.com/v2/conversations
https://helix.example.com/health
```

The proxy must preserve WebSocket upgrades and the `Sec-WebSocket-Protocol`
header. Helix uses the `helix.v2` subprotocol and, when a gateway token is
configured, a second `helix-auth.<base64url>` subprotocol. Do not place a token
in the URL.

Check the deployed health route before packing:

```bash
curl -fsS https://helix.example.com/health
```

## 3. Bind and pack the plugin

Replace the manifest's development whitelist with the fixed production gateway
origin:

```bash
npm run configure:gateway -w @helix/g2-plugin -- wss://helix.example.com
```

Set the complete WebSocket route as the plugin's non-secret production default,
run the gate, and build the `.ehpk` with the pinned Even Hub SDK floor:

```bash
npm run check
VITE_HELIX_GATEWAY_URL=wss://helix.example.com/v2/conversations npm run pack:g2
```

The package is written to:

```text
apps/g2-plugin/helix-g2.ehpk
```

Authenticate the pinned CLI and check that the manifest package ID is still
available before the first portal upload:

```bash
npx evenhub login
npx evenhub pack apps/g2-plugin/app.json apps/g2-plugin/dist \
  --sdk-ver 0.0.14 --check -o apps/g2-plugin/helix-g2.ehpk
```

The availability check is account-backed; an unauthenticated CLI stops with
`Not authenticated` and does not reserve the package ID.

Before uploading, confirm that `apps/g2-plugin/app.json` contains only the real
gateway origin in the network whitelist. Never add provider endpoints or API
keys to the manifest or `VITE_*` values.

## 4. Install a private build

1. Open the Even Hub developer portal and select the Helix project.
2. Open **Private builds** and upload `apps/g2-plugin/helix-g2.ehpk`.
3. In the Even Realities phone app, open **Even Hub** in Developer Mode.
4. Go to **Me → Apps → Private builds**, choose Helix, and tap **Install**.
5. Launch Helix from the glasses home screen.
6. In the phone companion, open **Session setup**, confirm the production WSS
   URL, choose **Deepgram**, **Soniox**, or **Gateway default**, enter the
   matching provider API keys, optionally choose **Save API keys on this
   phone**, enter the separate Helix server access token, and connect.

Provider keys are sent once in `session.start` over WSS. The self-hosted Helix
server connects directly to the provider and holds the submitted keys only for
that active session. Phone persistence is ordinary Even App plugin local
storage for convenience, not documented Keychain or encrypted secure storage;
use **Clear saved API keys** to overwrite the dedicated record.

Private builds exercise the real package, manifest, permission, and install
path, but installation is currently a manual portal/phone workflow.

## 5. Promote to beta after private smoke testing

In the portal, create a beta group, add the tester account, upload the same
`.ehpk` under **Builds**, and assign it to the group. On the phone, install it
from **Me → Beta tester**. Use this build for the five-minute locked-phone test,
permission-denial paths, system exit confirmation, clean relaunch, and a final
console check. Beta is the reviewer-parity gate; simulator and local QR runs do
not replace it.

## 6. Physical G2 acceptance

Verify both Deepgram and Soniox separately on real speech:

- select the provider, connect, and confirm `session.started` reports the same
  transcription profile;
- ask punctuated and unpunctuated questions with different speakers;
- measure speech-end to first answer delta and completed answer latency;
- pause, resume, commit, double-tap exit, relaunch, and repeat after phone lock;
- confirm no provider/Omi key appears in the phone console or `.ehpk`;
- enable Omi read/write only with explicit user intent, and distinguish
  `pending`, `synced`, and `failed` outcomes.

Record Private build, Beta, and physical-G2 results separately. A green local
gate proves the package and contracts, not the provider account, network, or
hardware path.
