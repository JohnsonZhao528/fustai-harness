---
description: "Shared resolution of the DeepSeek Harness home and the shared agent configuration root, plus user-data paths, tilde expansion, and stable watch paths."
kind: "package-library"
---

# @deepseek-ai/dsh-home-paths

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-home-paths` resolves the DeepSeek Harness home, the signed-in account's data root inside it, and the shared agent configuration root. An explicit path wins over the environment variable, which wins over the default under the operating-system home; blank environment values are ignored. A signed-in account narrows the home to its own root, so two accounts on one machine never read each other's sessions, settings, or credentials. Its helpers label a root symbolically, expand only bare or current-user tilde forms, and canonicalize watch targets whose final components do not yet exist. Use it as a direct library dependency, not through `cordis.yml`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use these helpers wherever a package must agree with the rest of the harness about where user data lives: resolve the home once, then derive every child path from it.

### Resolving the home

```ts
import { resolveDshHome, dshBaseHome, dshHomePath, dshCachePath } from '@deepseek-ai/dsh-home-paths'

const home = resolveDshHome()                // active account's root, else the default home
const base = dshBaseHome()                   // the home before per-account narrowing
const settings = dshHomePath('settings')     // join one child onto the resolved home
const cache = dshCachePath('models')         // <home>/cache/models, default ~/.dsh/cache/models
```

An explicit configured path has the highest precedence, then `$DSH_HOME`, then the default `~/.dsh`. An empty or whitespace-only `$DSH_HOME` is treated as unset, so a blank override never resolves the home to the current working directory. {@link dshBaseHome} reports that home before narrowing; a child path under `DSH_HOME` is a configuration value, never a re-declaration of the harness home.

`dshCachePath(...segments)` derives paths from the `cache` directory under the resolved home, so a signed-in account keeps its own downloaded models, mirrors, and caches. With no segments it returns the cache directory itself. Pass an initial options object, `dshCachePath({ dshHome: home }, ...segments)`, to use an explicit configured home with the same precedence and tilde expansion. It returns an absolute path without creating directories.

### Isolating one account's data

```ts
import { ACCOUNT_UID_PATTERN, accountDataRoot, dshBaseHome, ownsHarnessHome, readAccountPointer, writeAccountPointer, type AccountPointer } from '@deepseek-ai/dsh-home-paths'

const uid = 'u_1a2b'
const base = dshBaseHome()
const previous = readAccountPointer(base)                                // undefined until the first sign-in
const next: AccountPointer = { activeUid: uid, firstOwnerUid: previous?.firstOwnerUid ?? uid }
writeAccountPointer(base, next)
const home = ownsHarnessHome(next, uid) ? base : accountDataRoot(base, uid)   // ~/.dsh or ~/.dsh/accounts/u_1a2b
if (!ACCOUNT_UID_PATTERN.test(uid)) throw new Error(`unusable account id ${uid}`)
```

`<base>/account.json` holds the {@link AccountPointer}: `activeUid` names the account whose root `resolveDshHome` returns, is `null` after local sign-out, and is absent before the first sign-in; `firstOwnerUid` names the account whose existing data already filled the home, and is never reassigned. {@link ownsHarnessHome} reports that inheritance, {@link accountDataRoot} builds every other account's path under {@link DSH_ACCOUNTS_DIR_NAME}, and {@link ACCOUNT_UID_PATTERN} is the grammar all of them accept, so the directory name, the pointer, and a grant's recorded id cannot disagree.

`resolveDshHome` narrows the home with this pointer on every call; `dshBaseHome` never narrows. The pointer lives in the home itself, so a home that already names an account root — the `DSH_HOME` a Host re-declares for its children — has no pointer beside its sessions and resolves unchanged. Only the account provider writes the pointer: it records the first account to sign in as `firstOwnerUid`, which keeps the data already on the machine with that account, and later accounts start in their own empty root. Consumers read the result and never compare directories themselves.

A process that must keep one root for its whole lifetime calls `resolveDshHome` once at startup and stores the value, the way the account provider does; a caller that repeats the call sees a sign-in from the next frame onward.

### Resolving the shared agents root

```ts
import { resolveAgentsHome, agentsHomeDisplay } from '@deepseek-ai/dsh-home-paths'

const agents = resolveAgentsHome()   // configured path, else $DSH_AGENTS_HOME, else ~/.agents
agentsHomeDisplay(agents)            // ~/.agents, or $DSH_AGENTS_HOME for any configured root
```

`resolveAgentsHome` applies the same precedence, blank-value handling, and tilde expansion as `resolveDshHome`. The root is deliberately outside `$DSH_HOME` because other agent tools share it; `dsh-agent-instructions` reads its user-global `AGENTS.md`, and `dsh-skill-filesystem` scans its `skills/` directory.

### Displaying a home

For user-facing paths, render a root symbolically rather than as a machine path: the default harness home displays as `~/.dsh`, an account root inside it as `~/.dsh/accounts/<id>`, any configured harness home as `$DSH_HOME`, the default shared agents root as `~/.agents`, and any configured shared agents root as `$DSH_AGENTS_HOME`. Neither display form leaks an absolute machine path.

### Expanding user paths

`expandHomePath` expands a leading `~`, `~/`, or `~\` against the operating-system home and leaves everything else untouched — non-tilde paths and named-user forms such as `~alice/...` pass through unchanged.

### Canonicalizing watch paths

`canonicalizeWatchPath` gives a native filesystem watcher one canonical spelling of its target: the deepest existing ancestor is resolved through `realpath` and any missing suffix is restored, so a file or directory can be watched before it is created. This prevents Windows from treating a regular-file ancestor as ordinary absence, and prevents 8.3 short-name aliases from mixing with the long paths the native watcher backend emits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is built on two rules: harness user data lives under one home, narrowed to the signed-in account's own root, and the shared agent configuration root stays separate because other agent tools read it too. `resolveRoot` and `rootDisplay` own the precedence and display rules for both roots, so neither can drift from the other.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Home resolution, account-pointer narrowing, path joining, display, tilde expansion, and watch-path canonicalization |

### Resolution rules

`resolveDshHome` reads the explicit override, then `$DSH_HOME`, then falls back to the operating-system home joined with `.dsh`, and finally narrows that home to the active account's root. `resolveAgentsHome` reads the same three levels for `$DSH_AGENTS_HOME` and `~/.agents`. The chosen value is tilde-expanded and normalized to an absolute path; `dshHomePath` joins child segments with Node's platform path rules. `dshHomeDisplay` and `agentsHomeDisplay` compare the resolved path against the default root and return the symbolic label, so a configured root never leaks its absolute path.

### Account pointer rules

`readAccountPointer` reports absence only when `account.json` is missing: a file that cannot be read, parsed, or matched against {@link AccountPointer} throws, so a damaged pointer stops startup instead of silently resolving the shared home. `writeAccountPointer` creates the home directory when it is missing and replaces the file through a same-directory temporary file, so a reader never observes a half-written pointer. The temporary file and the pointer keep the restrictive modes the harness home already uses, `0700` on the directory and `0600` on the file.

### Canonicalization mechanics

`canonicalizeWatchPath` walks up from the target until it finds an existing ancestor, resolves it with `realpath`, proves it is an enumerable directory, and restores the missing suffix. Errors other than absence propagate, and a missing-suffix ancestor that is not a directory is rejected.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the launcher or the consumers that depend on a single home root.

- [Boot package](../../boot/app-boot/README.md) — the launcher that resolves the home before any plugin mounts.
- [Shell environment](../../shell/shell-env/README.md) — how `DSH_HOME` reaches model shell calls.
- [Anonymous user id](../../identity/anonymous-user-id/README.md) — a stored identity file under the resolved home.
- [DeepSeek account Platform provider](../../credentials/deepseek-account-platform/README.md) — the plugin that writes the pointer and moves a grant between roots.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the helpers are not the right tool. They are current package constraints, not a task backlog.

- **Expansion is deliberately narrow** — only bare `~`, `~/...`, and `~\...` use the current operating-system home; named-user forms such as `~alice/...`, environment variables, and shell expressions remain unchanged.
- **Canonicalization reads but never mutates** — `canonicalizeWatchPath` performs `realpath` probes and propagates errors other than absence; callers still own directory creation, permissions, and trust policy for the resulting path.
- **A damaged pointer stops resolution** — `readAccountPointer` and `resolveDshHome` throw when `account.json` exists but is not this layout, because the alternative, falling back to the shared home, would show one account another account's data.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
