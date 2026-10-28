import type { AssistantCitation } from "@t3tools/contracts";
import { assistantCitationLabel } from "@t3tools/shared/assistantCitations";
import { QuoteIcon, XIcon } from "lucide-react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../components/ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

/** Thread text quoted into the side chat composer; the next message carries it. */
export function SideChatQuoteChip(props: {
  readonly citation: AssistantCitation;
  readonly onRemove: () => void;
}) {
  const label = assistantCitationLabel(props.citation);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip kind="citation" aria-label={`Quoted thread text: ${label}`}>
            <QuoteIcon aria-hidden="true" />
            <ContextChipLabel className="max-w-[16em]">{label}</ContextChipLabel>
            <ContextChipAction aria-label="Remove quote" onClick={props.onRemove}>
              <XIcon aria-hidden="true" />
            </ContextChipAction>
          </ContextChip>
        }
      />
      <TooltipPopup>
        <span className="line-clamp-6 block max-w-sm whitespace-pre-wrap">
          {props.citation.text}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
