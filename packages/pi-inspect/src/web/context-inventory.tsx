import { useState } from "react";
import type { Snapshot } from "../model.js";
import { Data } from "./components.js";

/** Current prompt only; resource catalogs live in Environment, never historical evidence. */
export function ContextInventory({ snapshot }: { snapshot?: Snapshot }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="context-inventory" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Current runtime information · not historical request evidence</summary>
      {open && (
        <div className="inventory-scroll">
          <Data
            label="Current runtime effective prompt · may not yet be sent"
            data={snapshot?.currentPrompt}
            defaultOpen={false}
          />
          <p>Current tools, MCP registrations and the startup skill catalog are in Environment.</p>
        </div>
      )}
    </details>
  );
}
