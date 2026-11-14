import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  MessageSquareShareIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Group, GroupSeparator } from "../components/ui/group";
import { Kbd } from "../components/ui/kbd";
import type { AssistantCitationSourceAnchor } from "../lib/assistantTextSelection";
import { cn } from "../lib/utils";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useQuietThreadShell } from "../state/entities";
import { environmentThreadShells } from "../state/threads";
import { useSideChatsOffered } from "./sideChatPalette";
import { citeInComposer, useMainComposer } from "./sideChatComposers";
import { orderSideChats, pickSideChat, quoteInSideChat, sideChatInUse } from "./sideChats";
import { SideChatWorkingIndicator } from "./CodySideChatTitle";
import { useStartSideChat } from "./useStartSideChat";

interface SelectionActionProps {
  readonly threadRef: ScopedThreadRef;
  readonly citation: AssistantCitation;
  readonly sourceAnchor: AssistantCitationSourceAnchor;
  readonly disabled: boolean;
  readonly onDone: () => void;
}

/**
 * Cody's selection actions beside Cite: "Ask in side chat" in a thread that
 * offers side chats, and "Cite in main" inside a side chat.
 */
export function CodyAskInSideChat(props: SelectionActionProps) {
  const shell = useQuietThreadShell(props.threadRef);
  const parentThreadId = shell?.lineage.sideChat === true ? shell.lineage.parentThreadId : null;
  if (parentThreadId != null) {
    return (
      <CiteInMain
        {...props}
        parentRef={scopeThreadRef(props.threadRef.environmentId, parentThreadId)}
      />
    );
  }
  return <AskInSideChat {...props} />;
}

/** Quotes side chat text into the main thread's composer, with the comment box open. */
function CiteInMain(props: SelectionActionProps & { readonly parentRef: ScopedThreadRef }) {
  const mainComposer = useMainComposer();
  return (
    <Button
      type="button"
      size="xs"
      variant="glass"
      disabled={props.disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        citeInComposer(mainComposer?.current, {
          threadRef: props.parentRef,
          citation: props.citation,
          sourceAnchor: props.sourceAnchor,
        });
        props.onDone();
      }}
    >
      <MessageSquareShareIcon aria-hidden="true" className="size-3.5" />
      Cite in main
    </Button>
  );
}

const PICKER_HEIGHT = 280;

/**
 * "Ask in <side chat>" quotes the selection into the side chat in use, or a
 * new one when there is none. The chevron, Shift+click, N and 1-9 pick another.
 */
function AskInSideChat(props: SelectionActionProps) {
  const { threadRef } = props;
  const offered = useSideChatsOffered(useQuietThreadShell(threadRef));
  const sideChats = orderSideChats(useAtomValue(environmentThreadShells.sideChatsAtom(threadRef)));
  const activeSurfaceId = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).activeSurfaceId,
  );
  const start = useStartSideChat(offered ? threadRef : null);
  const [picker, setPicker] = useState<{
    readonly placement: "above" | "below";
    readonly focusFirst: boolean;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  if (!offered) return null;
  const target = pickSideChat(sideChats, activeSurfaceId);

  const askIn = (sideChatId: ThreadId) => {
    const { citation, sourceAnchor } = props;
    props.onDone();
    quoteInSideChat(threadRef, sideChatId, citation, sourceAnchor);
  };
  const askInNew = async () => {
    const { citation, sourceAnchor } = props;
    props.onDone();
    if (!(await start.open())) return;
    const started = sideChatInUse(threadRef);
    if (started !== null) quoteInSideChat(threadRef, started, citation, sourceAnchor);
  };
  const openPicker = (focusFirst: boolean) => {
    const bottom = rootRef.current?.getBoundingClientRect().bottom ?? 0;
    setPicker({
      placement: bottom + PICKER_HEIGHT > window.innerHeight ? "above" : "below",
      focusFirst,
    });
  };
  const focusItem = (step: 1 | -1) => {
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = index === -1 ? 0 : (index + step + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : null;
    const choice = digit === null ? undefined : sideChats[digit - 1];
    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      void askInNew();
    } else if (choice !== undefined) {
      event.preventDefault();
      askIn(choice.id);
    } else if (event.key === "Escape" && picker !== null) {
      // Closes the picker before the toolbar's own Escape dismisses the selection.
      event.preventDefault();
      event.stopPropagation();
      setPicker(null);
      rootRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (sideChats.length === 0) return;
      event.preventDefault();
      if (picker === null) {
        openPicker(true);
      } else {
        focusItem(event.key === "ArrowDown" ? 1 : -1);
      }
    }
  };
  const title = target?.title ?? "side chat";

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <Group aria-label="Ask in side chat">
        <Button
          type="button"
          size="xs"
          variant="glass"
          disabled={props.disabled}
          aria-label={
            target === null ? "Ask in a new side chat" : `Ask in side chat "${target.title}"`
          }
          aria-keyshortcuts="N 1 2 3 4 5 6 7 8 9"
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            if (target === null || event.shiftKey) void askInNew();
            else askIn(target.id);
          }}
        >
          <MessagesSquareIcon aria-hidden="true" className="size-3.5" />
          Ask in <span className="max-w-40 truncate">{title}</span>
        </Button>
        {sideChats.length > 0 ? (
          <>
            <GroupSeparator />
            <Button
              type="button"
              size="icon-xs"
              variant="glass"
              disabled={props.disabled}
              aria-label="Choose a side chat"
              aria-haspopup="menu"
              aria-expanded={picker !== null}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => (picker === null ? openPicker(false) : setPicker(null))}
            >
              <ChevronDownIcon aria-hidden="true" />
            </Button>
          </>
        ) : null}
      </Group>
      {picker !== null ? (
        <div
          role="menu"
          aria-label="Ask in side chat"
          className={cn(
            "dropdown-glass absolute right-0 flex w-64 max-w-[calc(100vw-1rem)] flex-col rounded-lg p-1 shadow-lg",
            picker.placement === "above" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {sideChats.map((sideChat, index) => (
            <PickerItem
              key={sideChat.id}
              autoFocus={picker.focusFirst && index === 0}
              shortcut={index < 9 ? String(index + 1) : null}
              onSelect={() => askIn(sideChat.id)}
            >
              <span className="min-w-0 flex-1 truncate">{sideChat.title}</span>
              <SideChatWorkingIndicator
                sideChatRef={scopeThreadRef(threadRef.environmentId, sideChat.id)}
              />
              {sideChat.id === target?.id ? (
                <CheckIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
              ) : null}
            </PickerItem>
          ))}
          <div role="separator" className="my-1 h-px bg-border" />
          <PickerItem shortcut="N" onSelect={() => void askInNew()}>
            <span className="min-w-0 flex-1 truncate">New side chat</span>
          </PickerItem>
        </div>
      ) : null}
    </div>
  );
}

function PickerItem(props: {
  readonly autoFocus?: boolean;
  readonly shortcut: string | null;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      ref={props.autoFocus ? (element) => element?.focus({ preventScroll: true }) : undefined}
      className="flex min-h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onSelect}
    >
      {props.shortcut === null ? (
        <span className="w-5" />
      ) : (
        <Kbd aria-hidden="true">{props.shortcut}</Kbd>
      )}
      {props.children}
    </button>
  );
}
