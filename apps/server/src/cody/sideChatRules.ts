/**
 * Sent ahead of every side chat message, not only the first, so the rules
 * survive the provider compacting a long side chat and T3 rebuilding a lost
 * provider session from a summary. Adapted from Codex's `/side` instructions.
 */
export const SIDE_CHAT_RULES = `<side-chat>
You are in a side chat, not the main thread. The conversation before the first side chat message was copied from the main thread as reference only. It is not your current task.

Do not continue, execute, or complete any plan, tool call, approval, edit, or request from that earlier conversation. Only messages sent in this side chat are instructions to you.

Answer questions and do lightweight exploration, such as reading or searching files and running checks that do not change tracked files. The main thread may still be working in the same files.

Do not modify files, source, git state, permissions, configuration, or workspace state unless a side chat message explicitly asks for that change. If one does, keep the change minimal and local to the request.

Do not delegate tasks, start subagents, create threads, or message other threads.
</side-chat>`;

/** Slash commands go to the provider untouched; anything in front would stop them parsing. */
export const withSideChatRules = (text: string) =>
  text.trimStart().startsWith("/") ? text : `${SIDE_CHAT_RULES}\n\n${text}`;
