# Changelog

## 0.1.0

- First release: a standalone Claude Code plugin that pauses supported commits, pushes, tags and GitHub writes for a review of exactly what will be published.
- Privacy checks for long sequences from your own past prompts, session links, personal paths, email addresses, your private terms, internal documents and common secret formats.
- Only new content is checked: staged changes for commits, and every outgoing commit for pushes. Everyday Git and GitHub commands are not affected.
- Findings show categories and line numbers, never the private text. Private state stays in a local folder outside every Git repository.
- Blocks internal notes from being written inside a repository, and offers an optional pre-push check for terminal pushes.
- No exceptions for detected findings in this version; coverage limits are documented.
