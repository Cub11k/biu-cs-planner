# A State File's revision is a hash of its bytes, and the page carries it

**Every save names the revision of the State File it was based on, and the Workspace adapter
refuses the overwrite when the file on disk is no longer that revision. A revision is a SHA-256 of
the file's bytes as read, taken in the adapter, and the page holds it between a read and the next
save.** [ADR-0003](0003-workspace-folder-is-source-of-truth.md) promised "version-checked saves that
refuse to overwrite a file changed externally" without choosing what a version is. #90 chose it,
and PR #103 built it; this records the choice and the two alternatives it turned down, which until
now lived only in `docs/design.md` "Storage" and in the doc comment on `revisionOf` in
`server/src/workspace.fs.ts` (#110).

The question the guard asks is "is the file still what I read?", and only the content answers it.
Dropbox, git, an editor and a second tab can each rewrite a State File between the read a student
is looking at and the save their next edit makes. A save that went through anyway would destroy work
the student cannot see, which is why this is one of the app's few refusals rather than a Warning
(`StateFileChangedError` in `app/src/workspace.ts` says why at length).

**Bytes as read, not the document they parse to.** This is the sub-decision that goes the less
obvious way. `parseStateFile` in `core/src/state/file.ts` is forgiving on purpose: it drops an
entry it cannot read and keeps the rest. A hash of what it parsed would be a hash of the
*repaired* document. An external edit that damaged only an entry the reader drops would then
produce the same revision as before, and the guard would be blind exactly where the file is
damaged. Hashing bytes also needs no canonical form of the JSON. It is also why the hash cannot be
taken in `core`: `core` is handed already-parsed JSON and does no I/O, so the bytes never reach
it. A leading UTF-8 BOM is part of the bytes too. It is dropped before parsing, but one State File
stored with and without a BOM has two revisions, because a guard that called them one would be
blind to whichever tool added or removed it.

SHA-256 because `node:crypto` has it on all three runtimes. This is conflict detection and not a
security boundary, so the choice is about availability rather than strength. `memoryWorkspace`
in `app/src/workspace.memory.ts` uses the stored text itself as its revision. That is the limit
case of the same idea (no collisions at all), and it is only possible in a double that never has
to hand the value to a browser.

## Considered Options

- **An mtime, or an mtime plus a size.** Nearly free, and wrong in the cases the guard exists
  for. `git checkout` stamps an mtime to now with the content unchanged. Sync clients differ on
  whether they preserve one. Granularity varies by filesystem, so two writes inside one tick look
  like none. The first two refuse saves nobody endangered, the third lets one through, and a guard
  that misfires teaches a student to ignore it. A size does not repair this: an edit that keeps the
  length is the ordinary case for a changed grade or a changed Group number.
- **The adapter remembering the bytes it last read or wrote.** Needs no hash at all, and would be
  enough for a guard that lived only in the adapter. It loses the two-tab case, which is a way of
  working this app supports (`docs/design.md`, "Purpose and audience"): once the first tab saves,
  that memory matches the disk again, so the second tab's stale save is allowed and the first
  tab's edit is silently gone. The revision has to belong to the view that read it, so it has to
  travel to the page, and what travels to a page has to be small. That is what makes it a hash.

## Consequences

- **The revision travels the whole path.** The adapter produces it on `readStateFile`, the use
  case hands it out, the API serves it as `version`, the page holds it, and the save brings it
  back as `basedOn`. `saveStateFile` hands back the revision it wrote, so the page's next save
  needs no re-read. `editStateFile` in `app/src/edit.ts` is the one place above the port that
  carries it, which is why it is the only write path (`CLAUDE.md`).
- **A save based on no revision claims the file does not exist**, and is refused when it does. A
  client that forgets to send one can create a State File and can never overwrite one: forgetting
  fails closed.
- **The prose word is "revision".** The type keeps its name, `StateFileVersion`, because it is in
  `core`'s surface and on the wire, and the API field stays `version`. "Version" alone is ambiguous
  three ways in this repo: the `schemaVersion` a file records, the Workspace change count
  `GET /api/workspace/changes` serves, and the app's own release. `CONTEXT.md` glosses
  **Revision** and says which spelling belongs in which register.
- **Nothing compares a file against anything else.** A snapshot's `takenAt` and the change count
  are both explicitly not revisions, and neither may be used to decide whether a save goes
  through. The watcher reports the app's own writes too (#88), because telling the app's write from
  somebody else's is this guard's job, done from content.
- **Reading costs a hash of a file a few kilobytes long**, once per read and once per save. That is
  the whole price, and it is paid only for State Files: a Catalog is re-importable from its Raw
  Crawl and nothing edits one in place, so `read` and `write` carry no revision.
