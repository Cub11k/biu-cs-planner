# Undo is a stack of State File snapshots, not a command with an inverse

`docs/design.md` said every edit was "a command in `app`" with "the undo history for the session",
which was written as settled but never argued. #64 forced the choice before the first editing use
cases (#63 and what follows) fixed the shape. **An edit is a plain `state -> state` function in
`core`; `app` wraps it, keeps the previous value on a stack, and undo writes an earlier value back
through the ordinary guarded save.** There is no command concept, and nothing implements an inverse.

The State File is one small JSON document that is rewritten whole on every save, so commands buy
nothing at the storage layer: they would be an in-memory luxury paid for in every use case. Their
one real advantage over snapshots, a per-edit description for the UI, is not an advantage at all —
the entry carries a label the use case supplies. Meanwhile every check in this app is a Warning and
edits always go through, so an inverse would have to be correct over states a checker would flag,
and re-picking a Group or deleting a Variant would each need to remember what they displaced.
Restoring a value cannot drift that way.

## Consequences

- **Use cases stay pure.** Recording a Pick, creating a Variant, adding an Attempt and setting a
  Blocked Time are `state -> state` functions in `core`, and undo costs one wrapper in `app` rather
  than an inverse apiece.
- **The stack belongs to the State File, not to a browser tab.** Undo restores the document, and
  there is one document; the server has no session concept to key it to. Two tabs on one file share
  one history, which is the truth rather than a compromise.
- **It does not survive a restart.** The stack is in memory. `.backups/` is the durable record, and
  a second durable history of the same document would be a trap rather than a feature.
- **It is bounded**: the last 100 edits, dropped sooner if the stack passes 8 MB.
  **Amended 2026-10-11 (#145): the byte bound never drops the only entry.** The 8 MB protects the
  process from a *long session*, a stack that grows an edit at a time without limit; it does not
  protect it from a *large document*. The process already holds the document in order to have saved
  it, so one snapshot of it costs no more than what is already in memory, and dropping it would make
  the edit just made the one edit that cannot be taken back. An 8 MB State File is effectively
  unreachable in any case. The count bound has no such exception.
- **One API call is one entry.** The UI decides what an intent is, so a drag sends one call on drop
  and "apply all Plan Diffs" is a single labelled entry.
- **One stack covers the document, minus settings.** Language and exam spacing are preferences that
  the control which set them can set back, and folding them in would let undoing a Pick flip the UI
  language.
- **The save path is the undo path**, so the State File writer takes the revision it is based on and
  the external-edit guard applies equally to an undo. A file changed on disk invalidates the stack.
- **Amended 2026-10-25 (#412): a restore over a State File that cannot be read is not on the
  stack.** It is the one edit allowed to replace such a file, because putting a backup back is the
  remedy for exactly that file. There is no previous value to keep: the file was never a State, and
  a snapshot of `newState()` would make an undo empty the document rather than put the file back.
  The unreadable bytes are kept in `.backups/` instead, by the same guarded save that keeps every
  replaced file, and the Workspace screen says so rather than offering an undo. The stack is
  emptied too, by the rule above: the save was based on a revision the stack never wrote. And it
  brings the snapshot's `settings` back, the one restore that does: there are no current settings
  to keep, and the defaults would flip a Hebrew reader's page to English.
