# Publish Guard

## FOR HUMANS

**Check for private information before your AI shares project changes.** Publish Guard pauses supported Git and GitHub actions so your AI can review what is about to be saved or uploaded. It checks for things such as private phrases, email addresses, chat links and secrets. It works with Claude Code on its own or alongside Fabex.

### Install

You need Claude Code 2.1.295 or later, Node.js 20 or later, and Git. In Claude Code, run:

```text
/plugin marketplace add https://github.com/replayjapan/publish-guard.git
/plugin install publish-guard@publish-guard
/reload-plugins
```

### When it stops something

A pause does not always mean a leak was found: the first attempt asks your AI to review the files and text. If it finds something private or doubtful, the AI should explain the concern without repeating the private information. Fix it, then retry. Changed content needs another review. There is no bypass for detected findings in this version.

### Add your private terms

Run `/publish-guard:private-terms` for instructions on adding names or phrases through your own terminal. Keep them out of chat and project files. The list stays in a private folder on your computer; replacing it replaces the whole list. Publish Guard also checks local chat history without saving another copy of your messages or uploading them for analysis.

### Know the limits

- It covers supported Claude Code actions. Browser uploads and commands outside its hooks are not covered; ordinary terminal pushes need a separate optional setup.
- It can miss short quotes, paraphrases and private names you have not configured. Existing unchanged content is not a full privacy audit.
- It may stop unfamiliar actions or report a false match. A successful check still needs your usual review and permission to publish.

### Related plugins

Each plugin is independently installed and optional.

| Plugin | What it does |
| --- | --- |
| [Fabex](https://github.com/replayjapan/fabex) | Coordinates Claude and Codex as development partners. |
| [Modes](https://github.com/replayjapan/modes) | Provides Work, Discussion and Ask activities. |
| [Design Loop](https://github.com/replayjapan/design-loop) | Guides UI research and browser review. |
| [AI Usage Tracker](https://github.com/replayjapan/ai-usage-tracker) | Reports recorded AI allowance and project token usage. |

## FOR AI BROTHREN

Treat this package as generic product source. Keep personal fixtures, reproduction payloads, private configuration and investigation records out of the repository and release. Do not evade detectors by encoding real private content. Tests construct fictional sensitive-looking strings at runtime solely to keep fixtures safe for distribution.

The hook output is a review request, not publication authorization. Use `/publish-guard:review` to inspect every item and record product classifications. Never classify an unread item as product. Surface doubt without copying private text. Follow the owner's existing delivery permissions.

`scripts/commands.mjs` recognizes publication commands without executing them. `scripts/inventory.mjs` builds bounded inventories with changed-line ranges. `scripts/privacy.mjs` scans content and derives prompt hashes. `scripts/exclusions.mjs` identifies prompt sequences already present in baseline or installed product files. `scripts/history.mjs` maintains a streamed private index with per-file inode, device, size, timestamps and byte offsets. Hashes are stored in bounded pages and obsolete pages are removed under an exclusive index lock. `scripts/state.mjs` handles private state and expiring reviews. `scripts/guard.mjs` emits hook decisions. `scripts/control.mjs` provides review, redacted inventory, private-term and owner-terminal controls. None logs raw errors.

History indexing has a sixty-second work budget inside a 120-second pre-tool hook timeout. Progress survives a budget pause, including within a skipped output record. Interrupted locks are recovered only when their owning process no longer exists. Cached growing files assume normal append-only transcript writes; same-size changes, inode replacements and truncation invalidate that file's index. The index never grants a clean result while incomplete or unavailable.

The control interface accepts review classifications and replacement private terms as JSON on stdin. Reviews require exactly every item ID, with every classification equal to `product`. Missing, private or doubtful classifications are rejected. Reviews never override findings. State contains redacted inventories, classifications, index progress and file metadata, timestamps, a hash key, sequence hashes and owner-maintained terms. Redacted pending records remain local until the owner removes them; expiry invalidates permission, not retention.

When Fabex is active, both main partners should independently review the same digest and destination. Claude remains the owner-facing delivery interface. Automatic two-partner attestation is not implemented in this standalone release.

Run `npm test` to execute the dependency-free Node test suite. Tests create isolated temporary repositories and fictional history; they must never read real user history or contact a network. No install is required. Contributors should also check real host startup failure, timeout blocking, plugin loading and a blocked/approved synthetic operation. Passing unit tests alone does not demonstrate those host properties.

### How it works

The first supported attempt stops with an inventory of files and text fields. The inventory shows item IDs, safe labels, sizes and finding categories. It never prints matching private text. The AI reviews the actual local content, identifies doubtful items to you without quoting private material, and records a classification for every item. Only a fully product-related inventory without findings can pass. Changes to content or destination require a new review; reviews expire after thirty minutes. A clean scan does not grant permission to publish.

A commit or local tag creates local Git objects. A push or GitHub write transfers or exposes content externally. Both are checked, with the operation identified in the inventory. Push checks read the destination's actual advertised refs and inspect commits and objects it lacks, including outgoing content removed by a later commit. Local remote-tracking refs are not trusted. An empty remote, or advertised objects missing locally, triggers a full-history scan. An unreachable remote stops the push check.

For commits, content findings apply to staged lines added or changed since HEAD. Pushes inspect the additions in every outgoing commit against its first parent, including commits on merged branches and content later removed. Root commits and newly introduced paths receive a full content check, even when the blob already exists remotely. Unchanged lines, unchanged assets and deletions do not create content findings. New commit and tag metadata is still checked. The review digest binds the complete snapshots, and findings retain their original file line numbers. This incremental policy does not audit or certify old content already in the baseline.

Checks include long sequences from eligible local owner prompts, session references, personal filesystem paths, email addresses, local private terms, internal documents and common secret patterns. No-reply email addresses are allowed. Ordinary names require private terms or matching prompt context; pattern matching cannot identify every private fact or paraphrase.

Internal-document checks apply to document paths ending in `.md`, `.txt`, `.rst` or `.jsonl` with internal names or folders. Source filenames and text that merely mentions documentation paths are not classified as internal documents. Bare home-directory shorthand is allowed; personal paths with a following name remain checked.

### Your information stays local

The distributed plugin contains no personal configuration or conversation extracts. Examples and tests use generated fictional values. Private state lives outside all Git repositories, including ignored locations, in the current account's local data directory under `publish-guard`. Set `PUBLISH_GUARD_DATA_DIR` to an absolute private directory to change that location. Directories require mode 0700 and files mode 0600. Symlinks and hard-linked state files are rejected.

The plugin indexes eligible user text records from local Claude Code project history. It excludes assistant messages, tool results, marked metadata, sidechain records, recognized skill and command expansions, and known notifications. Unrecognized injected formats can still produce false matches. It stores keyed one-way hashes of twelve-word sequences and per-file progress, never conversation text or raw history filenames. The key also stays in private local state. These hashes remain sensitive derived data and must not be shared. No history or scanned content is uploaded for analysis. Git inspection disables lazy object fetching; push inspection reads remote ref advertisements without fetching objects. For GitHub writes whose destination depends on the authenticated account, the plugin performs a read-only account lookup through the GitHub CLI; lookup failure stops the operation.

To avoid attributing existing product text to the owner, prompt matching excludes sequences found in the commit baseline, the advertised remote tip trees for pushes, or files listed by Claude Code's installed-plugin registry. A push never uses unpublished local HEAD as exclusion evidence. This exception affects only owner-message findings; new emails, secrets and private terms remain checked. Installed plugin files and the registry are trusted local inputs, not proof that their contents are public. Do not put private material there to bypass a finding. Exclusion hashes are computed in memory and changes affect the review digest. Optional evidence is bounded to 2,000 files, 32 MiB total, 2 MiB per file and a fifteen-second work budget; skipped or inaccessible evidence grants no exclusion. Linked files, Git metadata and dependency directories are not searched. The history index is rebuilt once when the prompt-filter version changes.

The history reader streams JSONL records and skips non-user records before JSON parsing. Unchanged files reuse their index; growing files resume at the saved byte offset. Truncated, replaced or same-size edited files are rebuilt, and disappeared files lose their cached hashes. There is no total transcript-size limit. The first index can pause at its time budget and resume on the next attempt; publication stays blocked until indexing finishes. Ordinary development commands never trigger indexing.

Missing, malformed, inaccessible or unsupported history makes the check unavailable. Incomplete trailing records wait for completion. Individual candidate user records larger than 32 MiB remain unsupported; large recognized assistant/tool records are streamed past. Short quotes, paraphrases, image content, absent history and unrecognized history formats cannot be comprehensively matched. The directory can be selected by `CLAUDE_CONFIG_DIR`; it is never searched outside that configured history root.

Use `/publish-guard:private-terms` for instructions on maintaining private terms through your own terminal. Never add personal terms to plugin files or repository configuration. Diagnostics contain categories and line numbers, with suspicious labels redacted. Unrecognized private names in otherwise ordinary filenames can still appear; configure private terms before relying on label redaction. The plugin writes no debug logs or telemetry. Existing host transcripts and operating-system backups remain outside its control.

### Coverage

The table describes supported forms and limits. Unsupported detected forms stop rather than receive a clean review.

| Channel | Supported form and limits |
| --- | --- |
| Git commit | Explicit message argument or message file; scans staged additions and changes, new paths, message, parent ID and identities. Partial, amended, signed and interactive commits are blocked. Existing commit hooks are allowed; changes they make are checked in the resulting objects before a supported push. |
| Git commit-tree | Explicit tree object, optional explicit parent objects, and explicit message. Scans additions versus the first parent, new paths and identities; root trees are scanned in full. |
| Git push | One named remote; accepts a branch name, branch-to-branch, HEAD-to-branch or full refspecs. Scans every outgoing commit's additions, new paths, tag objects and commit metadata. Supports set-upstream and force-with-lease. No omitted refspecs, mirror pushes, automatic tag following or unconditional force flags. |
| Git tag | Literal tag name and explicit target or HEAD; annotated tags require an explicit message. Scans target history. Signed tags are blocked. |
| GitHub issues and PR updates | Explicit repository and literal title/body or body file. Issue creation, edits and comments; PR edits and comments. PR creation is blocked pending inspection of the remote diff. |
| GitHub releases | Explicit repository, existing tag, title and release text for creation; explicit text edits; UTF-8 text assets. Creation requires the existing-tag verification flag. Generated text, new-tag creation, binary assets and archives are blocked. |
| GitHub repositories | Explicit new repository name and visibility; description and homepage edits. No source-directory import, automatic push, templates or visibility changes. |
| GitHub gists | Creation from named UTF-8 text files; explicit optional description and visibility. Edits support a literal gist ID with a replacement file and filename, an added file, or a description. Stdin and interactive inputs are blocked. A secret gist is still external publication. |
| GitHub API writes | Explicit POST, PUT, PATCH or DELETE to a limited set of issue, PR, release, gist and repository endpoints; literal raw fields or a JSON file. Encoded, generated, remote-file and unsupported endpoint payloads are blocked. |
| GitHub MCP | Known issue/comment/update/file-write tools with recognized fields. File-write content is decoded from base64 where required. Unknown writes, PR creation and repository creation with an unresolved account destination are blocked. |
| Direct file placement | Write, Edit and MultiEdit to internal-document paths inside a repository are blocked unless Git ignores the target. Canonical paths prevent symlink aliases from evading the location check. |
| Terminal Git | Optional pre-push hook, installed only when the owner runs the installer. Uses Git's actual object IDs and destination, then performs the same review. |

Only recognized publication operations enter the gate. Other Git verbs, ordinary GitHub CLI commands and composed reads pass unchanged. Commands that search or quote Git commands as data also pass. Composed or wrapped publication operations stop when their outgoing content cannot be inventoried.

Uncovered paths include indirect publication inside arbitrary scripts or executables, preconfigured shell/Git aliases, unrecognized MCP server aliases, non-GitHub services, raw HTTP clients, browser uploads, tools outside Claude Code, disabled hooks, and Git's hook-bypass flag. Command recognition is not a complete shell interpreter. Read commands and unrelated development commands are not sandboxed. Shell-based file writes do not receive the placement check.

Binary objects requiring inspection, archives, Git LFS payloads, unsupported submodule or symbolic-link tree entries, shallow or grafted history, and oversized inventories stop inspection. Defaults cap inspection at 500 outgoing commits, 2,000 items, 32 MiB total content, 2 MiB per text item and a 128 KiB redacted report. A full-history fallback applies those limits to the complete history being inspected.

GitHub inspection covers the explicit outgoing payload, not content inherited from remote objects or a server's generated metadata. CLI or MCP schema changes require adapter review. MCP destinations bind the tool/server name and explicit repository; server configuration and credentials must remain stable. Host tools can modify content between the pre-tool check and execution; this plugin does not make those actions atomic. A commit-time review sees the pre-hook snapshot; commit hooks can change the final local commit. A subsequent supported push rescans its actual objects. The terminal pre-push hook narrows the execution window for Git objects. Git hooks, signing programs, other plugins and credentials remain part of the trusted environment. This is an accidental-disclosure guard, not protection against an adversarial process with your account permissions.

The literal repository-edit and gist-edit adapters follow the [GitHub repository edit manual](https://cli.github.com/manual/gh_repo_edit) and [gist edit manual](https://cli.github.com/manual/gh_gist_edit). Pull-request creation remains blocked: the [PR creation manual](https://cli.github.com/manual/gh_pr_create) describes automatic pushes unless an explicit head is supplied, and this release does not inventory the remote diff.

### Owner exceptions

`/publish-guard:allow DIGEST` is deliberately disabled in 0.1.0. The expansion hook recognizes the owner-command shape and digest but grants no exception. A script running with the AI's account permissions cannot establish an unforgeable owner approval merely by writing a local file. Enabling exceptions requires a protected host authorization mechanism. Until then, resolve findings in the material to be published.

### Optional terminal check

From a repository, the owner may run `node PATH_TO_PLUGIN/scripts/control.mjs install-pre-push` directly in a terminal. The installer creates a local pre-push hook with exclusive creation, refuses to overwrite an existing hook or modify a custom hooks configuration, and never changes Git configuration. Assistant tool calls to this installer are blocked. Nothing installs automatically.

A terminal push can stop with a digest and redacted inventory. Review it through the plugin's review procedure and retry. Hook installation points at the current plugin location; moving or removing the plugin makes that Git hook fail. The generated hook is machine-local and must not be distributed. This command is an owner-run convention, not a separate operating-system identity.

### Installation and validation

The repository is its own Claude Code marketplace. The plugin never initializes repositories, installs software, commits or pushes on its own. Do not enable it in a host that ignores hook failures.

The hook configuration sets `onFailure` to `block`. Claude Code documents this behavior for version 2.1.295 and later, including failed startup and timeouts. Confirm it on the installed host before relying on enforcement. See the [Claude Code hook reference](https://code.claude.com/docs/en/hooks).

