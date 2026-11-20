# Agent Note: Per-account harness data roots

Status: implemented

English | [中文](2026-11-10-per-account-data-roots.zh.md)

## Problem

Sign-in is the product's only entry to the workspace, and one machine serves several accounts: a shared workstation, one person with two accounts, or a developer switching between a personal and a work identity. The harness home is a single directory holding sessions, settings, todos, instruction files, skills, spilled output, and stored credentials, and every consumer derived that one path. Two accounts on the same machine therefore read each other's Session history and configuration, and the local Host API has no per-account authorization, so any process holding the machine's home can serve another person's data. Product isolation requires that a signed-in account's data not be reachable from another account on the same machine, while an upgraded machine keeps working for whoever owned its existing data.

## Decision

One pointer file plus one resolver change owns the isolation, so no consumer learns about accounts. `@deepseek-ai/dsh-home-paths` resolves the base home with the existing precedence ([one harness home resolver](2026-07-24-single-harness-home-resolver.md)), then reads `<base>/account.json` and narrows:

```
no pointer, or activeUid === firstOwnerUid  >  <base>
any other activeUid                          >  <base>/accounts/<uid>
```

The pointer holds `activeUid` and `firstOwnerUid`, where `firstOwnerUid` is written once and never reassigned: the account that first signs in on a machine owns the data already in the base home, and every later account gets its own root under `accounts/`. `resolveDshHome()` reads the pointer on every call rather than caching, because a sign-in rewrites it while the process is running; each consumer still resolves once at startup, which is what turns a root change into a restart. `dshBaseHome()` reports the unnarrowed root for the code that owns the pointer file itself, and `accountDataRoot()` / `ownsHarnessHome()` are the same primitives the account provider uses to decide where to hand off a credential.

Sign-out sets `activeUid` to null and keeps `firstOwnerUid`, so ownership survives the person who earned it leaving and returning. Pointer writes create the base home `0700` and the file `0600`, write to a `tmp-<pid>-<uuid>` sibling, and `rename` it into place. `readAccountPointer()` treats only a missing file as "no pointer": any other failure or an id outside `ACCOUNT_UID_PATTERN` throws, because silently skipping a damaged pointer would serve a second account the first account's data.

The account provider commits the pointer last in a confirmed sign-in: it writes the grant into the target root, then writes the pointer, then removes the copy in the starting root, and only when that write was confirmed. An unconfirmed target write leaves the pointer untouched so the next launch reads the credential still in place.

Because every process fixes its root at startup, a root the pointer selected that differs from the running process's own root is reported as `AccountView.restartRequired` instead of being silently honored. Desktop owns its Host process, so the main process offers the restart once per run and relaunches without the quit confirmation; Web keeps to a manual-restart notice on the sign-in screen, since one deployment can serve other windows and in-flight sessions that an automatic restart would kill.

Subprocess isolation follows from the environment rather than from another resolver: `dsh-subprocess` re-declares the resolved `DSH_HOME` in its child environment allowlist, so nested commands launched by an agent land in the same account root instead of falling back to `~/.dsh`.

## Alternatives considered

**Pass the account id to every home consumer.** Sessions, settings, skills, spill, todos, and credentials each take a path today; threading a uid through all of them means every new consumer can get isolation wrong, and one stale caller leaks across accounts. Narrowing inside the single resolver makes correct isolation the only available behavior.

**One top-level root per account (`~/.dsh-<uid>`).** It abandons the one-root rule the resolver owns, makes `$DSH_HOME` mean two things depending on the account, orphans the data already in `~/.dsh`, and rewrites every support document and instruction path that names `~/.dsh`.

**Migrate the existing base home into the first account's root at first sign-in.** A uniform layout is tidier, but it copies or moves a user's entire history before any confirmed write covers it, and the account that signs in second on an upgraded machine inherits nothing. Inheriting the base home gives the same isolation for later accounts with no bulk move.

**Restart the Host automatically in Web too.** Desktop's restart cannot harm anyone else; a Web deployment can hold several windows and background sessions, and a sign-in triggered process restart would destroy work the signed-in person does not own. W1 ships the prompt only.

**Cache the narrowed root per process.** A cache would keep serving the starting root after a sign-in rewrote the pointer, which is exactly the state `restartRequired` reports; reading the pointer per call keeps the resolver honest and costs one small file read at each startup.

## Consequences

- A sign-in that changes the root takes effect only in the next process, so the product pays one restart prompt per account switch and needs an explicit `restartRequired` state plus a credential handoff that never leaves two readable copies behind.
- The base home is shared machinery: the pointer and `accounts/` live in it, so a damaged pointer stops every launch until it is repaired, and the account provider is the only writer.
- `$DSH_HOME` aimed at an account root resolves unchanged, which keeps nested processes and deliberate single-account launches working without a second environment variable.
- Isolation is directory-scoped, not encrypted or access-controlled: it stops another account on the same machine from reading through the harness, not a process running as the same OS user that names the path directly.
- Model API keys and credentials follow the same rule because they are stored under the home; no separate key namespace was added.
