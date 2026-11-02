# Side chats in Cody

Cody uses T3 Code's [side chats](./thread-sidebar.md#side-chats) and adds a few ways to start
them, keep them current, and bring them back.

## Start one

- Press `mod+alt+s` (`thread.sideChat`) in a thread.
- Choose **New side chat** in the command palette. **Open side chat** shows the one whose tab you
  last had open, or the newest one.
- Select text in a response and choose **Ask in side chat**. The text goes into the side chat's
  composer as a quote, ready for your question. If the thread has no side chat, a new one starts.

## Keep up with the thread

When the thread finishes replies the side chat hasn't seen, the side chat's header shows how many,
such as **2 new in main**. Choose it to add the thread to your next message there. That message
brings the side chat up to date with the thread's replies since it last caught up. If the thread
went back to an earlier reply, the header says **Main went back** instead.

## Bring back

**Bring back** adds the side chat to the thread's composer as a chip. Your next message there
brings what the side chat said since you last brought it back. It works while the thread is
running, and the message steers the running turn like any other.

## Rename

Choose the pencil in the side chat's header to rename it.

## Other differences

A side chat starts in its thread's permission mode, and its first reply uses that mode too. T3 Code
instead starts every side chat in approval required.

A side chat is told not to change anything unless you ask, on every message, not only the first.

Side chats made in Cody 0.1.6 and earlier move to **Archived** the first time a newer Cody server
starts.
