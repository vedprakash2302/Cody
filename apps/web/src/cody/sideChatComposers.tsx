import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { createContext, use, type ReactNode } from "react";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { formatAssistantCitationForComposer } from "../composer-logic";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  ComposerHandleContext,
  useComposerHandleContext,
  type ComposerHandleRef,
} from "../composerHandleContext";
import type { AssistantCitationSourceAnchor } from "../lib/assistantTextSelection";

interface PendingQuote {
  readonly threadRef: ScopedThreadRef;
  readonly citation: AssistantCitation;
  readonly sourceAnchor: AssistantCitationSourceAnchor | null;
}

const sideChatComposerRefs = new Map<string, ComposerHandleRef>();
const pendingQuotes = new Map<string, ReadonlyArray<PendingQuote>>();
/** How long a quote waits for its side chat's composer before going to the draft. */
const PENDING_QUOTE_MS = 5000;
const pendingQuoteTimers = new Map<string, ReturnType<typeof setTimeout>>();

function takePendingQuotes(key: string): ReadonlyArray<PendingQuote> {
  const quotes = pendingQuotes.get(key) ?? [];
  pendingQuotes.delete(key);
  clearTimeout(pendingQuoteTimers.get(key));
  pendingQuoteTimers.delete(key);
  return quotes;
}

/** Appends `text` to the thread's draft, for when its composer can't take it in place. */
export function appendToDraft(threadRef: ScopedThreadRef, text: string, gap = " ") {
  const store = useComposerDraftStore.getState();
  const prompt = store.getComposerDraft(threadRef)?.prompt ?? "";
  const separator =
    prompt.length === 0 || prompt.endsWith(gap) || (gap === " " && /\s$/.test(prompt)) ? "" : gap;
  store.setPrompt(threadRef, `${prompt}${separator}${text}`);
}

/**
 * Quotes into `handle`'s composer and opens the comment box over the source,
 * as Cite does. Without a live composer, or one that refuses the quote, the
 * quote goes to the end of the thread's draft instead.
 */
export function citeInComposer(
  handle: ChatComposerHandle | null | undefined,
  quote: PendingQuote,
): void {
  const placed =
    handle != null &&
    (quote.sourceAnchor === null
      ? handle.insertTextAtEnd(formatAssistantCitationForComposer(quote.citation), {
          ensureLeadingBoundary: true,
        })
      : handle.citeAssistantText(quote.citation, quote.sourceAnchor));
  if (!placed) appendToDraft(quote.threadRef, formatAssistantCitationForComposer(quote.citation));
}

function deliverPendingQuote(key: string) {
  const handle = sideChatComposerRefs.get(key)?.current;
  if (!pendingQuotes.has(key) || handle == null) return;
  const quotes = takePendingQuotes(key);
  // One comment box at a time: earlier quotes go in as they are, the last one opens it.
  quotes.forEach((quote, index) =>
    citeInComposer(handle, index === quotes.length - 1 ? quote : { ...quote, sourceAnchor: null }),
  );
}

/** Quotes whose composer never mounted, as when the tab closed first, keep them in its draft. */
function draftPendingQuotes(key: string) {
  for (const quote of takePendingQuotes(key)) {
    appendToDraft(quote.threadRef, formatAssistantCitationForComposer(quote.citation));
  }
}

/**
 * The side chat's composer ref. React sets it when the composer mounts, which
 * delivers a quote sent while its tab was still opening.
 */
export function sideChatComposerRef(key: string): ComposerHandleRef {
  const existing = sideChatComposerRefs.get(key);
  if (existing !== undefined) return existing;
  let current: ChatComposerHandle | null = null;
  const ref: ComposerHandleRef = {
    get current() {
      return current;
    },
    set current(handle) {
      current = handle;
      // React sets refs while committing; the composer takes text once that is done.
      if (handle !== null && pendingQuotes.has(key)) queueMicrotask(() => deliverPendingQuote(key));
    },
  };
  sideChatComposerRefs.set(key, ref);
  return ref;
}

/**
 * Opening a side chat tab asks the workspace to focus the panel once its
 * content mounts, which would pull focus out of the comment box the quote
 * just opened. For a moment, focus landing in the panel goes back to the box.
 */
export function holdCommentFocus() {
  const release = () => {
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("pointerdown", release, true);
    window.clearTimeout(timer);
  };
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    const comment = document.querySelector<HTMLTextAreaElement>(
      "[data-citation-comment-editor] textarea",
    );
    if (comment === null || !(target instanceof Element) || comment === target) return;
    if (target.closest('[data-workspace-area="panel"]') === null) return;
    release();
    // After the workspace's focus call returns, so it counts as done and stops retrying.
    queueMicrotask(() => comment.focus({ preventScroll: true }));
  };
  const timer = window.setTimeout(release, 2000);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("pointerdown", release, true);
}

/** Quotes into a side chat's composer with the comment box open, once its tab shows it. */
export function quoteIntoSideChatComposer(
  sideChatRef: ScopedThreadRef,
  citation: AssistantCitation,
  sourceAnchor: AssistantCitationSourceAnchor,
) {
  const key = scopedThreadKey(sideChatRef);
  const queued = pendingQuotes.get(key) ?? [];
  pendingQuotes.set(key, [...queued, { threadRef: sideChatRef, citation, sourceAnchor }]);
  deliverPendingQuote(key);
  if (pendingQuotes.has(key) && !pendingQuoteTimers.has(key)) {
    pendingQuoteTimers.set(
      key,
      setTimeout(() => draftPendingQuotes(key), PENDING_QUOTE_MS),
    );
  }
}

const MainComposerContext = createContext<ComposerHandleRef | null>(null);

/** The main thread's composer, from inside one of its side chats. */
export function useMainComposer(): ComposerHandleRef | null {
  return use(MainComposerContext);
}

/**
 * Gives a side chat's chat its own composer ref that quotes can reach, and
 * keeps the main thread's composer within reach for Cite in main.
 */
export function CodySideChatComposers(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly children: ReactNode;
}) {
  const main = useComposerHandleContext();
  const ref = sideChatComposerRef(
    scopedThreadKey(scopeThreadRef(props.parentRef.environmentId, props.threadId)),
  );
  return (
    <MainComposerContext value={main}>
      <ComposerHandleContext value={ref}>{props.children}</ComposerHandleContext>
    </MainComposerContext>
  );
}
