---
name: allow
description: Report the availability of an owner-only exception for a specific Publish Guard digest.
argument-hint: <digest>
disable-model-invocation: true
---

Version 0.1.0 does not issue privacy exceptions. The UserPromptExpansion hook checks the command origin and digest, then blocks with an explanation. A process with the same filesystem permissions could otherwise fabricate approval state, so this release does not claim owner-only authorization from JSON hook metadata alone.

Explain the limitation without repeating sensitive material. Resolve or remove the finding. Never manufacture an approval, write an exception file, or bypass the hook. A later host integration must provide protected authorization before this command can allow a finding.
