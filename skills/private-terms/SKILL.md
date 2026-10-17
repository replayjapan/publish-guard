---
name: private-terms
description: Explain how the owner can manage local private terms without adding them to a repository or plugin package.
disable-model-invocation: true
---

Private terms are local configuration, never plugin source or test fixtures. Do not ask the owner to paste private terms into this conversation. Explain that they can supply a JSON array through stdin to `node "${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs" terms replace` from their own terminal, using a private local editor or input source outside all repositories. This replaces the complete list; an empty array clears it. The command reports only a count.

The state directory defaults to the user's local data directory under `publish-guard`. `PUBLISH_GUARD_DATA_DIR` can select another absolute private directory outside repositories. The directory must be accessible only by the current account. Do not set it inside an ignored repository directory. Never include this state in a release or support bundle.

Use `terms status` only when a count is useful. Never read and echo existing terms. Do not insert terms on the owner's behalf unless they explicitly authorized that action. Hashed prompt detection and generic checks operate separately from this list.
