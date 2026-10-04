import { TextAttributes } from "@opentui/core";
import { For, Show, type Accessor, type JSX } from "solid-js";
import type {
  HarnessCapabilityView,
  HarnessFocus,
} from "../application/projection-port.js";
import {
  capabilityLabel,
  discoveryLabel,
  effortsLine,
  FREE_TEXT_MODEL_ENTRY,
  modelName,
  qualificationLabel,
  qualificationObservation,
} from "./harness-format.js";
import { useTheme } from "./vendor/theme-context.js";

export function HarnessCatalogInspector(props: {
  harness: Accessor<HarnessFocus>;
}) {
  const { theme } = useTheme();
  const harness = props.harness;
  const observation = () => qualificationObservation(harness().qualification);
  const checkedAt = () => {
    const qualification = harness().qualification;
    return qualification.state === "not-checked"
      ? "Not checked"
      : qualification.state === "not-ready"
        ? qualification.checkedAt
        : qualification.observation.checkedAt;
  };
  const authentication = () =>
    harness().authenticationInstructions ??
    (observation() === undefined ? "Not checked" : "Ready");

  return (
    <box flexDirection="column" gap={1} flexShrink={0}>
      <box flexDirection="column" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {`${harness().name} · ${qualificationLabel(harness().qualification.state)}`}
        </text>
        <text fg={theme.textMuted}>
          {`Discovery · ${discoveryLabel(harness().discovery)}`}
        </text>
      </box>
      <Show when={harness().unavailable}>
        {(problem) => (
          <box flexDirection="column" flexShrink={0}>
            <text
              fg={theme.error}
            >{`Unavailable · ${problem().explanation}`}</text>
            <text
              fg={theme.textMuted}
            >{`Remediation · ${problem().remediation}`}</text>
          </box>
        )}
      </Show>
      <box flexDirection="column" flexShrink={0}>
        <Fact label="Harness" value={harness().id} />
        <Fact
          label="Executable"
          value={observation()?.executable ?? "Not available"}
        />
        <Fact
          label="Version"
          value={observation()?.executableVersion ?? "Not available"}
        />
        <Fact
          label="Platform"
          value={observation()?.platform ?? "Not available"}
        />
        <Fact label="Checked" value={checkedAt()} />
        <Fact label="Authentication" value={authentication()} />
      </box>
      <Section title="Supported models">
        <SupportedModels harness={harness} />
      </Section>
      <Section title="Reported settings">
        <ReportedSettings harness={harness} />
      </Section>
      <Section title="Capabilities">
        <box flexDirection="column" gap={1} flexShrink={0}>
          <For each={harness().capabilities}>
            {(capability) => <Capability capability={capability} />}
          </For>
        </box>
      </Section>
      <Section title="Configuration">
        <text fg={theme.text}>
          {harness().configurationPosture ?? "Not checked"}
        </text>
        <text fg={theme.textMuted}>
          Harness-owned settings stay with the Harness. Secant asks only for
          relevant Run choices during launch or resume.
        </text>
      </Section>
    </box>
  );
}

function Fact(props: { label: string; value: string }) {
  const { theme } = useTheme();
  return <text fg={theme.text}>{`${props.label} · ${props.value}`}</text>;
}

function Section(props: { title: string; children: JSX.Element }) {
  const { theme } = useTheme();
  return (
    <box flexDirection="column" flexShrink={0}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {props.title}
      </text>
      {props.children}
    </box>
  );
}

function SupportedModels(props: { harness: Accessor<HarnessFocus> }) {
  const { theme } = useTheme();
  const declaration = () => props.harness().modelDeclaration;
  const entries = () => {
    const current = declaration();
    return current === undefined || current.kind === "free-text"
      ? []
      : current.models;
  };
  // Efforts for a name typed outside the entries; a `list` admits none.
  const otherEfforts = () => {
    const current = declaration();
    return current === undefined || current.kind === "list"
      ? undefined
      : current.efforts;
  };
  const kindLine = () => {
    const current = declaration();
    return current === undefined
      ? "Models not available yet"
      : current.kind === "list"
        ? "Listed by the Harness · only these can be chosen"
        : current.kind === "suggested"
          ? "Suggested · any other model name is accepted"
          : FREE_TEXT_MODEL_ENTRY;
  };
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={declaration() === undefined ? theme.textMuted : theme.text}>
        {kindLine()}
      </text>
      <For each={entries()}>
        {(entry) => (
          <ModelLines
            name={modelName(entry)}
            efforts={effortsLine(entry.efforts, entry.defaultEffort)}
          />
        )}
      </For>
      <Show when={otherEfforts()}>
        {(efforts) => (
          <ModelLines name="Any other model" efforts={effortsLine(efforts())} />
        )}
      </Show>
    </box>
  );
}

function ModelLines(props: { name: string; efforts: string }) {
  const { theme } = useTheme();
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.text}>{`· ${props.name}`}</text>
      <box paddingLeft={2} flexShrink={0}>
        <text fg={theme.textMuted}>{props.efforts}</text>
      </box>
    </box>
  );
}

/** The Model choice the Harness itself reports, or the fallback and why. The
 *  source is a word, never only a colour. */
function ReportedSettings(props: { harness: Accessor<HarnessFocus> }) {
  const { theme } = useTheme();
  const defaults = () => props.harness().harnessDefaults;
  const choiceLine = () => {
    const current = defaults();
    if (current === undefined) return "Not checked";
    if (current.kind === "unavailable") return "None";
    const declaration = props.harness().modelDeclaration;
    const label =
      declaration === undefined || declaration.kind === "free-text"
        ? undefined
        : declaration.models.find(
            (entry) => entry.model === current.choice.model,
          )?.label;
    const name = modelName({
      model: current.choice.model,
      ...(label === undefined ? {} : { label }),
    });
    return current.choice.effort === undefined
      ? `${name} · no effort setting`
      : `${name} at ${current.choice.effort}`;
  };
  const sourceLine = () => {
    const current = defaults();
    if (current === undefined) return undefined;
    return current.kind === "reported"
      ? "Reported by the Harness"
      : current.kind === "fallback"
        ? `Fallback · ${current.reason}`
        : current.reason;
  };
  const lock = () => {
    const current = defaults();
    return current === undefined || current.kind === "unavailable"
      ? undefined
      : current.effortLock;
  };
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={defaults() === undefined ? theme.textMuted : theme.text}>
        {choiceLine()}
      </text>
      <Show when={sourceLine()}>
        {(line) => <text fg={theme.textMuted}>{line()}</text>}
      </Show>
      <Show when={lock()}>
        {(locked) => (
          <text
            fg={theme.textMuted}
          >{`Locked by ${locked().source}. Change that setting outside Secant.`}</text>
        )}
      </Show>
    </box>
  );
}

function Capability(props: { capability: HarnessCapabilityView }) {
  const { theme } = useTheme();
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.text}>
        {`${props.capability.name} · ${capabilityLabel(props.capability.state)}`}
      </text>
      <box flexDirection="column" paddingLeft={2} flexShrink={0}>
        <text fg={theme.textMuted}>{props.capability.description}</text>
        <Show
          when={
            props.capability.state === "available-with-limits"
              ? props.capability.limits
              : undefined
          }
        >
          {(limits) => (
            <text fg={theme.textMuted}>{`Limits · ${limits()}`}</text>
          )}
        </Show>
      </box>
    </box>
  );
}
