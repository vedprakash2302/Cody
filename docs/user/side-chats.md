# Side chats

A side chat is a conversation beside a thread. It knows the thread's history, so you can ask about
the work while the agent keeps going, without adding your question to the thread's context.

Side chats are a Cody feature. They need a Cody server; the official T3 Code apps don't show them.

## Open a side chat

From a thread, do any of the following to start a new side chat:

- Type `/side` in the composer, or `/side` followed by your question to start a side chat and
  ask it in one step.
- Press `mod+alt+s` (`thread.sideChat`).
- Choose **Side chat** from the right panel's **+** menu.
- Choose **New side chat** in the command palette.

Each side chat opens as its own tab in the right panel, so you can keep several going. To get back
to one, select its tab, or choose **Open side chat** in the command palette for the one you used
last.

Select text in a response and choose **Ask in side chat** to quote it into the side chat you used
last, ready for your question. If none is open, a new one starts. Select more text to add another
quote.

Side chats are available after the thread's first response finishes. They need a provider that can
fork a conversation natively: Codex, Claude, OpenCode, or Pi.

## Names

A side chat is called "New side chat" until you send its first message. Then it gets a title from
that message, the way a thread does. To rename it, double-click its tab, choose **Rename** from its
**⋯** menu or the tab's right-click menu, or right-click it in the thread's details. A name you give
it stays, and **Keep as thread** keeps it too.

## Keeping up with the thread

A side chat starts with the thread's history up to its last finished response. The header shows
which response that is. When the thread finishes new responses, they attach to the side chat's
composer as a chip with the thread's name and how many responses and files changed. Your next
message brings the side chat up to date. Send the chip alone to have the side chat summarize what
changed, or remove it to leave the update out until the thread's next response.

If the thread goes back to an earlier response, the side chat still knows the responses the
thread dropped. Start a new side chat to follow the thread from there; the old one stays as it is.

The side chat works in the same files as the thread. It asks before it edits files or runs
commands, and it is told not to change anything unless you ask it to.

## When you're done

- Hide the right panel or switch threads to keep the side chat; it keeps running.
- Choose **Merge back** (the button beside **⋯**) to send a summary of the side chat to the thread
  with your next message there.
- Choose **Keep as thread** from the **⋯** menu to turn the side chat into an ordinary fork in
  your thread list.
- Close its tab to close it. A side chat you never asked anything is deleted; any other moves to
  **Closed** in the thread's details, where you can reopen it.
- Choose **Delete** from its **⋯** menu or the tab's right-click menu to delete it for good.
  Deleting asks first, the same as deleting a thread.

The thread's details list its side chats, with closed ones folded under **Closed**. Select one to
show or reopen it, hover to delete it, and right-click to rename it. The section's **⋯** menu has
**Delete all side chats**. Archiving or deleting a thread does the same to its side chats.

Side chats notify you only when they need an approval or an answer.
