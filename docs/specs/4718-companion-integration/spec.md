# Draft companion integration contract

Status: proposal for design review. Related: [#4718](https://github.com/morluto/rea/issues/4718).
This adds documentation and an illustrative fixture; the integration is not implemented.

## Problem and outcome

Issue #4718 reports that adding a companion block to managed REA skill text causes
canonical-file drift. I rechecked the source on 28 October 2026 at upstream main
`1e421242b97a533a5c03458ac074d4353ec17bf3`:
[setup inspects the managed files](https://github.com/morluto/rea/blob/1e421242b97a533a5c03458ac074d4353ec17bf3/src/application/SetupSkill.ts#L481-L510),
including the [byte comparison](https://github.com/morluto/rea/blob/1e421242b97a533a5c03458ac074d4353ec17bf3/src/application/SetupSkill.ts#L509),
and [doctor's alignment predicate requires canonical content](https://github.com/morluto/rea/blob/1e421242b97a533a5c03458ac074d4353ec17bf3/src/application/Doctor.ts#L431-L436).
The [update workflow](https://github.com/morluto/rea/blob/1e421242b97a533a5c03458ac074d4353ec17bf3/src/application/Update.ts#L148-L153)
does not itself apply setup changes; its
[post-install path returns a maintenance plan and remediation](https://github.com/morluto/rea/blob/1e421242b97a533a5c03458ac074d4353ec17bf3/src/application/Update.ts#L238-L252).

These are source observations, not a reproduced setup/doctor/update sequence or
proof of the proposed integration. The earlier pinned inspection was at
`6b180783ed04ebc87548c8385c80e05725804c47`; its byte comparison is at
[SetupSkill.ts line 437](https://github.com/morluto/rea/blob/6b180783ed04ebc87548c8385c80e05725804c47/src/application/SetupSkill.ts#L437).
The previous line 406 link pointed to per-root loop setup, not that comparison.

I propose explicit companion co-loading for relevant tasks while preserving those
canonical checks. V1 would cover personal client profiles, using existing local
facilities. Remote catalogs, automatic downloads, executable discovery hooks,
project registrations and background checks are outside this proposal.

## Loading and installation ownership

My preferred route is a fixed upstream-owned instruction in the canonical REA
skill, backed by a local read-only resolver. A supported host registration
mechanism is an alternative. Either adapter must establish the trusted active
client/profile, registry, selected REA installation and delivery mechanism in a
fresh session. Shared skill directories and repository instructions cannot supply
that trust. Missing binding must remain visible; manual selection is not evidence
of automatic discovery.

I prefer registering one explicitly selected existing companion installation.
A dedicated per-client/profile registry would allowlist its resolved root and
manifest path, record the exact manifest digest, and bind approval to the scope,
delivery mode and desired enabled state. The publisher owns its package and
manifest; registration operations own the integration records. A manifest cannot
enable itself or redirect its grant. Copies remain an alternative only with
explicit installation, helper-path and update-state ownership.

Use supported host selection where it honors this contract. Otherwise validate
the registry and manifest identity, expose only approved routing metadata, and
resolve full instructions for a relevant selected ID. Metadata selection is not
a complete content-health check. Narrow diagnostics should not activate unrelated
companion workflows.

Before instruction delivery, validate compatibility and inventoried content.
Checked-text delivery returns the bytes actually checked; further instruction
references use the same identity and an inventoried relative path. Native delivery
must select that same installation, not another copy found by name. Preserve base
directories for references/helpers, disclose unverified native/helper reads, and
avoid recursive or duplicate activation. Relevance and repetition controls depend
on model/host cooperation unless an adapter demonstrably enforces them.

## Content and approval

The inventory covers entry text, instruction references and relevant package-owned
helper code/dependencies. Mutable data, caches and updater state stay outside it;
unlisted files do not become approved instructions or helper code. The manifest
does not hash itself. Relative paths must remain inside the approved root, with
bounded reads and rejection of traversal, unsafe links, filesystem collisions,
duplicate keys and unknown schema semantics. Hashes detect changes; they do not
authenticate publishers or guarantee protection from same-user tampering and races.

Discovery, doctor and resolution perform no network, package execution or repair.
Integration consent grants no additional tool, network or spending authority.
One explicit approval may cover an exact package update and its resulting grant
when the reviewed action includes both. Different assets, content or scope require
a revised plan. Updating a disabled entry preserves disabled intent unless
enablement was included. Generic REA setup approval supplies no new integration
consent. Weekly-check opt-in and its cooldown belong to the Companion's own
installer/updater, not REA; they also supply no integration consent.

Schema versions are distinct from package and host versions. Unknown schemas
remain intact and unloadable with a warning. V1 needs no speculative migration
engine. Future bounded representation-only migrations may fit authorized
maintenance if content and effective trust remain unchanged; changed semantics
require review. Registration tools do not silently rewrite publisher manifests.

## Lifecycle and failure behavior

- Disable affects subsequent REA-mediated loading. It does not disable a native
  host skill, revoke tools or erase already supplied instructions. A new session
  does not prevent independent native discovery.
- An unavailable adapter can lead to explicitly selected manual use with its
  verification limits stated. Changed, unsafe, unreadable or incompatible content
  suspends co-loading; it must not automatically return through that fallback.
- An approved in-place update can invalidate the old grant before completion.
  Partial outcomes stay inactive with recovery evidence. Shared installations may
  suspend several profiles; approval for one does not change the others. There is
  no cross-tool atomicity or automatic rollback over concurrent edits.
- Ordinary setup reads integration records without rewriting them. Setup/update
  reports preservation or suspension for the selected scope, or that it was not
  assessed. Doctor separates canonical identity, intent, checked content, adapter
  prerequisites and actual session delivery. Static files cannot prove delivery.
- I prefer companion-installer ownership of exact legacy-block removal. Preserve
  newer surrounding REA bytes, selected paths/client aliases, backups, and the
  Companion installer/updater's update opt-in and cooldown; expose changes to
  pending update decisions. Stage disabled,
  then enable only after canonical/content/binding prerequisites verify. Avoid dual
  routes and automatic re-patching. Refuse customized or ambiguous blocks; migrate
  updater state explicitly without transferring old approval to a new mode.

## Illustrative manifest

[The manifest](example/manifest.json) inventories
[one instruction fixture](example/instructions.example.md). Paths are relative to
the selected example installation root, the `example` directory. Its SHA-256
covers the exact UTF-8 file bytes.

`example-contract-v1` is a placeholder, not an advertised runtime capability.
There is no implemented parser, resolver or client support implied by this
example. The separate registration record would hold the approved manifest
digest, selected root/profile/mode and enabled state; none is granted by the
manifest. Concrete field names, limits, compatibility capabilities and doctor
output remain design choices.

## Decisions requested

1. Canonical instruction plus local resolver, or which specific supported host
   registration mechanism?
2. What trusted source supplies active client/profile, registry and executable
   binding when several clients share a skill directory?
3. Can V1 allowlist an existing installation, or should separately owned copies
   be required? Who owns helpers and update state in that alternative?

## Verification before implementation claims

Demonstrate one pinned client path first and verify each additional client before
claiming support. Cover fresh sessions, custom/shared roots, exact native
selection, relative references/helpers, irrelevant tasks, disabled and changed
content, schema/path failures, combined approvals, interrupted updates and legacy
migration. Record configuration checks separately from observed delivery. These
are proposed acceptance checks, not completed runtime results.
