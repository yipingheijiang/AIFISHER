# Local edition

This branch removes the former platform's account, device session, account billing, feedback, telemetry, Relay providers, and automatic updater. The desktop opens a persistent local workspace directly. Existing workspace IDs, projects, media, and independently configured DPAPI-protected provider credentials are retained.

Node and Electron reject requests to the retired operator's domain and subdomains, including redirect hops and obsolete proxy settings. The domain remains in the deny rule and regression tests. Legacy Relay keys are ignored, and interrupted Relay tasks are not queried or resubmitted. Local user isolation, named pipes, path validation, and credential protection remain enabled.

The model catalog retains 71 independent provider models after removing 51 Relay entries, and adds a native Codex image adapter. ComfyUI and independently configured providers remain optional. Image angle and panorama tools create local drafts with no model selected; users select a model and generate explicitly.

Automatic drama/fight recipes that require the retired scene provider are disabled when scene assets are incomplete. The entire paid asset batch is rejected before an attempt is recorded, so character generation cannot incur a partial charge before the recipe becomes blocked. Plans and prompts remain available. Users can manually create workflows with their own models. No new local asset-binding API is implied. Complete historical asset receipts remain usable.

## Validation

Validated on Windows x64 with Node.js 24.20.0 and Electron 44.3.0:

- `npm run check`: type checking, regression tests, model catalog generation, canvas build, and launcher build passed. The latest unit suite contains 62 passing tests after node-level queue cancellation and Ctrl+Enter keyboard integration.
- Actual Electron testing covered the dashboard, five settings sections, canvas, save/restart persistence, workspace switching and return, video import, trimming, and frame extraction.
- Application HTTP/HTTPS/WS/WSS public requests were refused during the core test. Core flows produced zero requests to the retired operator and zero public network attempts; separate intentional Electron main/renderer probes were blocked. This was application boundary observation, not packet capture.
- Existing files and database records were compared with a pre-change backup and preserved. Test projects, media, and temporary workspaces were removed.
- Independent text generation and ComfyUI HTTP/WebSocket compatibility were tested with loopback mocks. Paid third-party API generation and real ComfyUI model weights were not tested or installed.
- Third-party image configuration was tested through the settings component and actual config/generation routes, including separate JSON generation and multipart editing endpoints, Base64 and URL image responses, configuration readback, invalid/retired address rejection, and credential masking. Only the final media-library write was mocked in the API test. The actual Electron settings fields were also verified without modifying provider credentials.

Native Codex was tested with a real image result and a real Electron canvas submission: model selection, local media save, image display and restart persistence passed. Read-only recovery returned the same image hash without a new generation. Cancellation, concurrency, interrupted submission, quota failure, reference restrictions and result validation were also checked with mocks.

The source snapshot also includes minimal runtime launch, parent IPC, lifecycle, and static-serving modules omitted from the original source snapshot. Dependencies, binaries, built assets, credentials, local workspaces, backups, and raw test/session logs are excluded from Git.

## Independent compatible image APIs

Open Settings → Model services → 厂商直连与兼容 API → OpenAI / 第三方兼容 API. Select the existing GPT Image 2 adapter, enter your provider's key and actual model ID, and supply complete request URLs for text-to-image, image-to-image, and inpainting as needed. Save with 保存连接配置. The model ID changes the remote model, while the selected adapter determines the request format and canvas capabilities.

This connection uses the OpenAI Images protocol. Common endpoints end in `/v1/images/generations` and `/v1/images/edits`; use the exact paths supplied by your provider. A base URL ending in `/v1` is not expanded automatically. Other image protocols need their own adapters. Blank URLs use the displayed defaults, and 恢复默认 resets the model ID and URLs while retaining the saved key. Compatible image/text connections share the OpenAI credential slot.

This fills a missing settings entry that was also absent upstream. Removing the retired platform's Relay models did not remove independent provider adapters or the existing per-model URL override mechanism. The retired domain remains blocked.

## Native Codex images

Open Settings → Model services → Codex 内置生图, connect your ChatGPT account in the official browser authorization flow, then select Codex → Codex 内置生图 in an image node. This uses Codex account usage, not the OpenAI Images API key. The login and runtime home belong to the current AIFISHER workspace; credentials from the desktop Codex app are not copied.

New image-generation nodes default to Codex 内置生图 with one image per request, including nodes created from a connector or a text-to-image action. The model selector remains available. Restored, copied, imported and preset nodes retain their saved models and parameters; uploads and tools with an explicit model keep their existing behavior.

The adapter delivers one image per request and supports text-to-image or up to five local PNG/JPEG/WebP references, each under 10 MB. Aspect ratio and resolution are requests to the native tool; the actual image model and dimensions are provided by Codex. Third-party model IDs do not apply. Native images require internet access and account access to the tool.

The original Codex thread and attempt are recorded before submission. Transport loss, timeout or cancellation after submission preserves an unconfirmed task for read-only recovery; it does not replay generation. A task stopped before submission is marked as not submitted. Output must be a fully decoded image under 32 MB before it is saved to the local media library. Ordinary canvas assistant conversations disable native image generation; the image node is the explicit generation entry point.

The native protocol has no hard generation-count or spending-ceiling field. The adapter requests one image and interrupts the agent on the first image result; this is not a guaranteed numeric quota ceiling. Account usage and availability are controlled by Codex. See the [official image generation guide](https://learn.chatgpt.com/docs/image-generation).

Existing canvas assistant conversations created under the previous runtime permissions require a new conversation; their original records are retained.

## Generation queue and prompt keys

When a model reaches its configured concurrency limit, the canvas still accepts new generation requests. They wait in submission order for the same physical model; different models can run independently. The canvas shows 排队中 and the current queue position, then starts automatically when a slot is free. Waiting does not call the provider or consume the generation observation timeout. Each waiting node displays 取消排队 directly on the card, including when it is not selected; the selected generation composer also offers this action. Both entries share the same bound cancellation request. 取消排队 only cancels a still-waiting task; if it has already started, that action leaves generation running.

In image, video, audio and text generation prompt fields, Ctrl+Enter submits through the same action as the generate button. Enter restores normal paragraph editing, and Shift+Enter inserts a hard line break. Chinese input method confirmation and active reference/preset menus take priority, and held Ctrl+Enter cannot submit repeated tasks. Ordinary text-node content retains its editing behavior.

The queue is scheduled by the current local service. Restarting the service ends tasks that were still waiting with a clear not-submitted result; users can submit them again manually. It does not automatically replay waiting or unconfirmed provider requests. Mock-provider execution and actual Electron canvas checks verified admission order, queue cancellation, automatic start, prompt keys and saved results without using image-generation quota or changing provider credentials.

## Running and updating

Follow the README's Windows setup instructions. Install ComfyUI and its model weights separately for offline AI generation, or explicitly configure an independent API provider. Keep local-edition changes when updating this branch; an original-platform installer can restore removed dependencies. The original license and attribution remain applicable.
