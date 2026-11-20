---
kind: upgrade-guide
description: "Each signed-in account gets its own Harness data root; the first account on a machine keeps the shared home and later accounts resolve <home>/accounts/<uid>."
---

# Accounts get their own data root

English | [中文](guide.zh.md)

## Change

One machine used one harness home (`~/.dsh`, or `DSH_HOME`) for every account: sessions, settings, and stored credentials all read and wrote the same directory, so signing in as a different account changed only who you were, not where your data lived.

`resolveDshHome()` in [index.ts](../../../../packages/util/home-paths/src/index.ts) now reads `<home>/account.json` after taking the base home and narrows the result. The first account recorded there keeps the harness home itself, so existing sessions, settings, and credentials stay with it; each later account resolves `<home>/accounts/<uid>`. The account provider writes that pointer when a sign-in commits, and it holds `activeUid` and `firstOwnerUid`; directories are created `0700` and pointer and credential files `0600`. Malformed or unreadable pointer content stops resolution with an error instead of falling back to the shared home.

A process resolves its root once at startup, so a sign-in that selects another account's root takes effect in the next process. Desktop asks once per run with Restart now or Not now and relaunches without the quit confirmation; the Web sign-in screen reports the same state and waits for you to restart the Host yourself. The credential is written into the target root before the pointer, and the copy left in the starting root is removed only after that write is confirmed. Child processes launched through [dsh-subprocess](../../../../packages/subprocess/subprocess/README.md) inherit the resolved `DSH_HOME`, so nested commands reach the same root. An explicit `DSH_HOME` that already points at an account root is used unchanged, because the pointer lives in the base home.

## Migration

1. Before the first sign-in on an upgraded machine, decide which account owns the data already in `~/.dsh`: the first one to sign in there keeps it, and each later account starts empty under `~/.dsh/accounts/<uid>`.
2. Sign in. Accept the restart prompt on Desktop; in a browser restart the Host once the sign-in screen reports the change.
3. Read `<home>/account.json` — `firstOwnerUid` names the account that owns the shared home, `activeUid` the account signed in now, null after sign-out — and confirm the second account's files appear only under `<home>/accounts/<uid>`.
4. Leave `DSH_HOME` pointed at the base home in scripts, CI, and private patches; point it at `<home>/accounts/<uid>` only for a deliberate single-account launch, which then resolves without narrowing further.
5. Move nothing by hand. Older sessions stay where they were written, and a later account never reads the first account's data.
