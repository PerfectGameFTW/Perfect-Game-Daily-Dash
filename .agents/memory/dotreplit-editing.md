---
name: Editing .replit safely
description: How to modify the .replit config file and the bash guard quirk that blocks certain heredocs
---

# Editing `.replit`

Direct edits to `.replit` (via `edit`/`write`/`cat >`) are blocked. Use the
`verifyAndReplaceDotReplit` code-execution callback.

- **Signature:** `verifyAndReplaceDotReplit({ tempFilePath })` — it does NOT
  accept inline `content`. Write the FULL new file contents to a workspace file
  first (e.g. `.local/tmp_dotreplit.toml`), pass its path, then delete the temp file.
- Returns `{ success: true }` on success.

**Why:** the callback validates the proposed file before swapping it in, so it
needs a real file path to read, not a string.

## Bash guard quirk
The bash tool blocks any command whose text contains the literal string
`npm run dev` (it intercepts with "Use the restart_workflow tool"). This trips
heredocs that write `.replit` (which contains `args = "npm run dev"`). Work
around it by using the `write` tool to create the file instead of a shell heredoc.

## Secrets vs userenv
- `[userenv.shared]` / `[userenv.production]` blocks in `.replit` ARE committed to
  git. Never put real secrets there — especially in a public repo.
- Replit Secrets are global (not env-scoped), encrypted, and NOT in `.replit`.
- The agent cannot set secret VALUES directly; use `requestEnvVar({requestType:'secret', keys})`
  to have the user set them. `setEnvVars` only writes non-secret env vars.
