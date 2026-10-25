/**
 * The frame snapshot's pictures, made drawable off the shell's main thread
 * (ARCHITECTURE.md §5; §1, performance rule 1). Main's snapshot events come
 * here on a port of their own. A picture arrives as captured (BGRA), becomes
 * RGBA and then an ImageBitmap, and goes to the shell without a copy. Events
 * keep their order: a picture still being made holds back the move behind it.
 */
import type { FrameSnapshotEvent } from '@chord/ipc';
import { bgraToRgba, imageData } from './pixels';
import type { DrawableSnapshotEvent } from './snapshot-events';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: DrawableSnapshotEvent, transfer: Transferable[]): void;
};

async function drawable(event: FrameSnapshotEvent): Promise<[DrawableSnapshotEvent, Transferable[]]> {
  if (event.phase !== 'show') return [event, []];
  const panes = await Promise.all(
    event.panes.map(async ({ rect, width, height, pixels, header }) => ({
      rect,
      width,
      height,
      ...(header ? { header } : {}),
      bitmap: await createImageBitmap(imageData(bgraToRgba(pixels), width, height), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }),
    })),
  );
  return [{ seq: event.seq, phase: 'show', panes }, panes.map((p) => p.bitmap)];
}

let queue = Promise.resolve();

// The shell hands over main's port; a new one (the shell asked again) replaces it.
scope.onmessage = (handover) => {
  const port = handover.ports[0];
  if (!port) return;
  port.onmessage = (message: MessageEvent<FrameSnapshotEvent>) => {
    queue = queue
      .then(async () => {
        const [event, transfer] = await drawable(message.data);
        scope.postMessage(event, transfer);
      })
      // A picture that can't be made never shows: main stops waiting for it and changes the frame at once.
      .catch(() => undefined);
  };
};
