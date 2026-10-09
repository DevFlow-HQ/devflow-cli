import type { JSX } from "@opentui/solid";
import { createMemo, splitProps } from "solid-js";
import { screenText } from "./screen-text.js";

/** Unbounded screen text uses the same rule as counted and clipped lines. */
export function DisplayText(
  props: Omit<JSX.IntrinsicElements["text"], "children"> & {
    children: string | number;
  },
) {
  const [content, attributes] = splitProps(props, ["children"]);
  const text = createMemo(() => screenText(String(content.children)).text);
  return <text {...attributes}>{text()}</text>;
}
