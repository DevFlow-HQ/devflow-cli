import type { CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { ProjectionPort } from "../application/projection-port.js";
import { createLivePreferencesView } from "./preferences-view.js";
import { App } from "./app.js";
import { createLiveBundleCatalogView } from "./bundle-view.js";
import { createLiveHarnessCatalogView } from "./harness-view.js";
import { createLiveLaunchPreparationView } from "./launch-preparation-view.js";
import type { RendererPort } from "./renderer/renderer.js";
import { createLiveRunActionsView } from "./run-actions-view.js";
import { createLiveRunLaunchView } from "./run-launch-view.js";
import { createLiveRunListView } from "./run-list-view.js";
import { createLiveRunWorkbenchView } from "./run-view.js";
import type { Exit } from "./vendor/exit.js";
import { createLiveWorkspaceView } from "./workspace-view.js";

// Mounts the shell onto a renderer the composition root owns. The live view is
// built inside the render root (Solid owner) so its Projection subscription and
// cleanup are tied to the mounted tree. Drawing goes through OpenTUI's Solid
// `render` directly — the Renderer Port never carries it.

export interface MountOptions {
  readonly projectionPort: ProjectionPort;
  /** The lifecycle Renderer Port the composition root owns; the Run Workbench is
   *  its first production caller of `size`/`onKey`/`onResize` (A13, #91). */
  readonly rendererPort: RendererPort;
  /** Draw motion as static marks: the working scanner becomes `[⋯]` (#292).
   *  Composition reads it from the environment; the presentation never does. */
  readonly reducedMotion: boolean;
  readonly exit: Exit;
}

export function mountTui(
  renderer: CliRenderer,
  options: MountOptions,
): Promise<void> {
  return render(
    () => (
      <App
        preferences={createLivePreferencesView(options.projectionPort)}
        view={createLiveWorkspaceView(options.projectionPort)}
        bundles={createLiveBundleCatalogView(options.projectionPort)}
        harnesses={createLiveHarnessCatalogView(options.projectionPort)}
        preparation={createLiveLaunchPreparationView(options.projectionPort)}
        launch={createLiveRunLaunchView(options.projectionPort)}
        run={createLiveRunWorkbenchView(options.projectionPort)}
        runList={createLiveRunListView(options.projectionPort)}
        actions={createLiveRunActionsView(options.projectionPort)}
        renderer={options.rendererPort}
        reducedMotion={options.reducedMotion}
        exit={options.exit}
      />
    ),
    renderer,
  );
}
