# Side chats

A side chat is a conversation beside a thread. It knows the thread's history, so you can ask about
the work while the agent keeps going, without adding your question to the thread's context.

Side chats are a Cody feature. They need a Cody server; the official T3 Code apps don't show them.

## Open a side chat

From a thread, do any of the following:

- Type `/side` in the composer, or `/side` followed by your question to open the side chat and
  ask it in one step.
- Press `mod+alt+s` (`thread.sideChat`).
- Choose **Side chat** from the right panel's **+** menu.
- Choose **Open side chat** in the command palette.
- Select text in a response and choose **Ask in side chat**. The selection goes into the side
  chat's composer as a quote, ready for your question. Select more text to add another quote.

The side chat opens as a tab in the right panel. A thread has one open side chat at a time; opening
it again shows the one you have.

Side chats are available after the thread's first response finishes. They need a provider that can
fork a conversation natively: Codex, Claude, OpenCode, or Pi.

## What a side chat sees

A side chat copies the thread's history up to its last finished response. It doesn't see a
response that is still running, and it doesn't follow the thread on its own. When the thread
finishes new work, the side chat shows how many responses and files changed. Then you can:

- Choose **Catch up** to attach the thread to your next message. The side chat gets the thread's
  messages and changed files since it last looked. Send the attachment alone to have the side
  chat summarize what changed. Catch up is also in the side chat's **⋯** menu and in the command
  palette as **Catch up side chat**.
- Choose **Start fresh** to start a new side chat from the thread's latest point.

Asking in the side chat about a response it hasn't seen attaches the thread for you. Remove the
attachment if you don't want it. If the thread was rolled back past what the side chat saw, only
**Start fresh** is offered.

The side chat works in the same files as the thread. It asks before it edits files or runs
commands, and it is told not to change anything unless you ask it to.

## When you're done

- Hide the right panel or switch threads to keep the side chat; it keeps running.
- Close its tab to close it. A side chat you never asked anything is deleted; any other is
  archived.
- Choose **Bring back to main** to send a summary of the side chat to the thread with your next
  message there.
- Choose **Keep as thread** to turn the side chat into an ordinary fork in your thread list.

The thread's details list its side chats. Select a closed one to reopen it; that closes the one
that is open. Archiving or deleting a thread does the same to its side chats.

Side chats notify you only when they need an approval or an answer.
