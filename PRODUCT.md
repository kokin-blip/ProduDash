# ProduDash

ProduDash is a local-first Electron workspace for merchant operations and content creation. Operators connect their own Shopify and AI providers, inspect bounded commerce snapshots, review drafts, edit local media, and make explicit publishing decisions.

## Product commitments

- Keep Dashboard, AI Inbox, Orders, Signals, Content Studio, Analytics and Integrations as the seven primary sections.
- Studio contains Library, Projects, Templates, Create Clips and Publishing. Preserve the actual editor, transcript and timeline rather than substituting a visual prototype.
- Shopify is a bounded read-only commerce source. Signals are verified attention items, not a task backend. Analytics report only supported data with definitions, freshness, comparison limits and CSV export.
- Inbox drafts require human approval and remain distinct from sending. TikTok browser snapshots and explicit manual or approved-draft sends are available when its custom API and account are ready. Other unimplemented social imports and sending remain unavailable.
- Local media processing is the default. Cloud modes identify the exact provider, model and data categories and require the existing consent. Local voice/likeness terms and provider boundaries remain explicit.
- Publishing times are local planning reminders. Approval freezes a snapshot. Actual YouTube or TikTok browser publishing requires a separate manual dispatch; other destinations retain their capability-based export/unavailable states. TikTok submission is recorded as processing, not proof of publication.
- Juanito retains his artwork, customizable name, visible history, consent, bounded read-only tools, cancellation and event-driven reactions.
- User data and schema compatibility are preserved. Credentials remain encrypted in the main process, behind validated IPC. No remote runtime asset or font dependencies are introduced.

Custom APIs run only on request in macOS builds, stop on request or app quit, and never auto-start on launch.

## Approved redesign

Use the owner's Figma kit Gz7WEiN8Y3Vvivvae0ZPlP across its shared, Music, Mail, Messages, Notes, Reminders and Calendar families. Adapt those patterns into one compact working interface with ProduDash branding, shared blue selection, solid surfaces and system-following light/dark appearance. The owner subsequently approved optional Glass Light and Glass Dark variants from the kit’s Native Fidelity Lab, plus explicit Light/Dark choices. System remains the default solid appearance; the device-local choice never changes workspace data. Details and reference nodes are in docs/figma-redesign.md.

Keep Electron/vanilla JS/HTML/CSS, native window controls, the 1120×760 minimum window and keyboard accessibility. At narrow effective widths, reflow panels without whole-window horizontal overflow; the timeline retains intentional internal scrolling. Background updates preserve draft inputs, focus/selection, disclosures and playback where the record is unchanged.

Acceptance requires existing tests, renderer interaction regressions, isolated Electron workflows and populated/empty/error/disabled/approval captures in both appearances. Verification never uses real credentials, paid requests, live uploads or destructive operations on a user's workspace.
