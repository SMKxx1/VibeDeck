// Registry of inline-SVG diagrams. A slide references one by key
// (image.inline = "architecture") so the slide data stays serializable while the
// diagram's labels render as real DOM text.

import type { ComponentType } from "react";
import { ArchitectureDiagram } from "./ArchitectureDiagram";

export const diagrams: Record<string, ComponentType> = {
  architecture: ArchitectureDiagram,
};
