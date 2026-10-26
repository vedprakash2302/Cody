# Cody side chats

Side chats are a Cody feature that must stay invisible to official T3 Code clients and servers.
These constraints are why the code looks the way it does; the user guide is
[Side chats](../user/side-chats.md).

## A side chat is an ordinary fork

A side chat is a `thread.fork` at `latest_stable` plus `thread.runtime-mode.set` to
`approval-required`. There are no side chat commands, events, or `relationshipToParent` values.
Official clients decode those enums strictly, and the shell snapshot carries every thread, so one
unknown value would stop them loading any thread from a Cody server.

## Membership lives outside statev2.sqlite

The side chat ids are in `cody-side-chats.json` next to `statev2.sqlite`
([`SideChatStore`](../../apps/server/src/cody/SideChatStore.ts)). Migrations share one numbered
list, so a Cody migration would make an official server skip upstream's migration with the same
number. Without the file, side chats are plain forks.

Upstream code reads membership through `SideChatMembership`, a reference whose default says no
thread is a side chat. Its consumers need no new layer, and their tests run unchanged.

## Only Cody clients receive side chats

A client asks for side chats with `codyFeatures=sideChat` on its WebSocket URL and shell snapshot
request ([`sideChatVisibility`](../../apps/server/src/cody/sideChatVisibility.ts)). Those clients
get side chat shells marked `codySideChat`; every other client never receives them, in the shell,
archive, thread family and older settled pages, search, or pull request links. The push relay skips side chats for everyone, because it
reaches the official mobile app.

The opt-in is a query parameter, not a header: a custom header needs a CORS preflight that an
official server rejects. Hidden shell items are dropped, not sent as removals; a client cursor
tolerates gaps.

Promotion removes the id and renames the thread, so the rename event is what makes it appear in
official clients. Thread routes are not filtered: official clients only learn thread ids from the
paths above.

## Rules ride on every turn

`ProviderTurnStartService` prefixes the side chat rules
([`sideChatRules`](../../apps/server/src/cody/sideChatRules.ts)) to the message that starts each
side chat turn, not just the first, so compaction or a rebuilt provider session cannot drop them.
A message that steers a running turn joins a turn that already has them. Slash commands pass
through untouched.

## Providers

`SideChatService.open` refuses providers without a native fork from a turn, which today excludes
Cursor, Grok, and ACP agents. Opening while the parent runs depends on the provider forking at a
cut point while the source session is busy; OpenCode 2 needed an adapter change for that.
