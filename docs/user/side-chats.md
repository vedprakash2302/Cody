# Side chats in Cody

Cody uses T3 Code's [side chats](./thread-sidebar.md#side-chats) and adds a few ways to start
them, keep them current, and bring them back.

## Start one

- Press `mod+alt+s` (`thread.sideChat`) in a thread, or choose **+** in a side chat's header.
- Choose **New side chat** in the command palette. With several side chats, the palette lists an
  **Open side chat** entry for each.
- Choose the side chat icon under a response to start one that knows the thread up to that
  response. Its header then counts the thread's later replies as new.
- Select text in a response and choose **Ask in** _side chat_. The text goes into that side chat's
  composer as a quote with the comment box open: **Enter** saves the comment, **mod+Enter** sends.
  The button names the side chat it uses: the one whose tab is open, else the newest. Choose the
  arrow to pick another or start a new one. With the button focused, press **1** to **9** to pick
  a side chat or **N** for a new one. Shift-click also starts a new one.

Side chats start with the thread's model and permission mode.

## Switch between them

Choose the title in a side chat's header to see the thread's other side chats and switch to one.
The same menu starts a new side chat, renames this one, or continues it as a thread.

## Keep up with the thread

When the thread finishes replies the side chat hasn't seen, the side chat's header shows how many,
such as **2 new in main**. Choose it to add the thread to your next message there. That message
brings the side chat up to date with the thread's replies since it last caught up. If the thread
went back to an earlier reply, the header says **Main went back** instead.

## Bring back

**Bring back** adds the side chat to the thread's composer as a chip. Your next message there
brings what the side chat said since you last brought it back. The button shows a rough token
count for that. It works while the thread is running, and the message steers the running turn
like any other.

To bring back less:

- Select text in a side chat reply and choose **Cite in main**. Only that text goes to the
  thread's composer, with the comment box open.
- Choose the share icon under a side chat reply to send that whole reply.
- Choose the arrow beside **Bring back**, then **Summary**. The side chat writes a summary in one
  more turn, and Cody puts it in the thread's composer as text you can edit before sending.

## Continue as a thread

**Continue as thread** in the title menu makes a normal thread from the side chat's latest reply,
with its conversation as context, and opens it. That thread can change files like any other. The
side chat stays where it was.

## Other differences

A side chat is told not to change anything unless you ask, on every message, not only the first.

Side chats made in Cody 0.1.6 and earlier move to **Archived** the first time a newer Cody server
starts.
