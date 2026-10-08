# Local edition

This branch removes the former platform's account, device session, account billing, feedback, telemetry, Relay providers, and automatic updater. The desktop opens a persistent local workspace directly. Existing workspace IDs, projects, media, and independently configured DPAPI-protected provider credentials are retained.

Node and Electron reject requests to the retired operator's domain and subdomains, including redirect hops and obsolete proxy settings. The domain remains in the deny rule and regression tests. Legacy Relay keys are ignored, and interrupted Relay tasks are not queried or resubmitted. Local user isolation, named pipes, path validation, and credential protection remain enabled.

The model catalog contains 71 independent models after removing 51 Relay entries. ComfyUI and independently configured providers remain optional. Image angle and panorama tools create local drafts with no model selected; users select a model and generate explicitly.

Automatic drama/fight recipes that require the retired scene provider are disabled when scene assets are incomplete. The entire paid asset batch is rejected before an attempt is recorded, so character generation cannot incur a partial charge before the recipe becomes blocked. Plans and prompts remain available. Users can manually create workflows with their own models. No new local asset-binding API is implied. Complete historical asset receipts remain usable.

## Validation

Validated on Windows x64 with Node.js 24.20.0 and Electron 44.3.0:

- `npm run check`: type checking, 19 regression tests, model catalog generation, canvas build, and launcher build passed.
- Actual Electron testing covered the dashboard, five settings sections, canvas, save/restart persistence, workspace switching and return, video import, trimming, and frame extraction.
- Application HTTP/HTTPS/WS/WSS public requests were refused during the core test. Core flows produced zero requests to the retired operator and zero public network attempts; separate intentional Electron main/renderer probes were blocked. This was application boundary observation, not packet capture.
- Existing files and database records were compared with a pre-change backup and preserved. Test projects, media, and temporary workspaces were removed.
- Independent text generation and ComfyUI HTTP/WebSocket compatibility were tested with loopback mocks. Paid generation and real ComfyUI model weights were not tested or installed.

The source snapshot also includes minimal runtime launch, parent IPC, lifecycle, and static-serving modules omitted from the original source snapshot. Dependencies, binaries, built assets, credentials, local workspaces, backups, and raw test/session logs are excluded from Git.

## Running and updating

Follow the README's Windows setup instructions. Install ComfyUI and its model weights separately for offline AI generation, or explicitly configure an independent API provider. Keep local-edition changes when updating this branch; an original-platform installer can restore removed dependencies. The original license and attribution remain applicable.
