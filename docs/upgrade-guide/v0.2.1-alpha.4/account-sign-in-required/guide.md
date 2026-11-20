---
kind: upgrade-guide
description: "Opening the desktop app or Web client requires a signed-in FustAI account; the desktop Welcome window no longer accepts an inference key instead."
---

# Opening the app requires a FustAI account sign-in

English | [中文](guide.zh.md)

## Change

The desktop Welcome window offered two ways in: sign in to a FustAI account, or store an inference API key. In the next release only the account works. `needsWelcome` in [welcome-api.ts](../../../../apps/desktop/src/welcome-api.ts) returns true whenever no account credential is stored, so an inference key alone leaves the app closed, and Welcome keeps only the sign-in page and the account page.

The Web client opened the workspace without checking the account. It now holds a full-screen sign-in card in the `shell.overlay` slot until an account credential is stored; the workspace underneath is inert and hidden, and releasing it needs no reload.

Accounts come from `https://account.fustai.com` and sign in through the browser device-code flow, which asks for an invite code. Sign-in stores no inference key, so model providers and their keys belong in Settings → Models.

## Migration

1. Get a FustAI account and its invite code at `https://account.fustai.com`.
2. On desktop, finish the browser sign-in shown by Welcome. In a browser, open the Web client and choose Sign in; the workspace appears once the credential is stored.
3. Add each model provider you use in Settings → Models together with its own API key. A missing key now fails a run with a model error instead of blocking entry.
4. Confirm by launching with no stored inference key: a signed-in account opens the workspace, and a missing one opens the sign-in page.
