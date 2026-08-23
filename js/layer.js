export function createTileLayer({
  name,
  status,
  build,
  show,
  hide,
  reuse,
  dispose,
  beginJob,
  endJob,
}) {
  let loaded = null;
  let request = null;

  async function update(target) {
    if (!target) {
      request?.abort();
      request = null;
      // Hiding keeps the texture; discarding it made re-toggling refetch.
      hide();
      return;
    }

    if (loaded && reuse(loaded, target)) {
      show(loaded, target);
      return;
    }

    request?.abort();
    const controller = new AbortController();
    request = controller;

    try {
      const built = await build(target, {
        signal: controller.signal,
        onProgress: (done, total) => {
          if (!controller.signal.aborted) beginJob(name, done, total);
        },
      });

      if (controller.signal.aborted) {
        dispose(built);
        return;
      }

      if (loaded) dispose(loaded);
      loaded = { ...target, ...built };
      show(loaded, target);
    } catch (error) {
      if (error.name === "AbortError") return;
      hide();
      status.textContent = `${name} failed: ${error.message}`;
    } finally {
      endJob(name);
      if (request === controller) request = null;
    }
  }

  return {
    update,
    get loaded() {
      return loaded;
    },
  };
}
