/* =============================================================================
 * record.js — in-app AR video recording
 * =============================================================================
 *
 * THE PROBLEM
 * Same one as photos, sixty times a second. The WebGL canvas holds only your 3D
 * content on a transparent background; the camera feed is composited by the
 * system and never enters your framebuffer. So canvas.captureStream() records a
 * model floating on nothing. To record what the user actually sees, every frame
 * has to be composited by hand — camera texture first, model on top — and then
 * pulled off the GPU.
 *
 * THE EXPENSIVE PART
 * Pulling pixels off the GPU. A plain gl.readPixels() blocks until the GPU has
 * finished the frame, stalling the pipeline. Doing that every frame on a phone
 * costs framerate and, worse, hurts AR tracking.
 *
 * The fix is an asynchronous read (WebGL2 only):
 *
 *   1. readPixels into a Pixel Buffer Object — this returns immediately, since
 *      it just queues a GPU-side copy
 *   2. drop a fence in the command stream
 *   3. on later frames, poll the fence; when it signals, the data is ready and
 *      getBufferSubData costs nothing
 *
 * Up to MAX_INFLIGHT frames are in the pipeline at once, so the CPU is never
 * waiting on the GPU. On WebGL1 we fall back to a synchronous read, which works
 * but will visibly cost framerate.
 *
 * OUTPUT
 * Finished frames are drawn to a 2D canvas, which feeds a MediaRecorder via
 * captureStream(0). The 0 means "manual" — we call requestFrame() ourselves, so
 * the video has exactly the frames we produced with no duplicates or gaps.
 *
 * USAGE
 *   const recorder = createRecorder({ renderer, gl, composite, onstop });
 *   recorder.start(view, viewport);      // from a user gesture
 *   recorder.frame(view, viewport);      // every XR frame, inside the loop
 *   recorder.stop();                     // onstop receives the Blob
 * ========================================================================== */

import * as THREE from 'three';

/** Candidate container/codec combinations, best first. */
const MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4'
];

/** How many async reads may be in flight before we start waiting. */
const MAX_INFLIGHT = 3;

/**
 * @param {object}   opts
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {WebGLRenderingContext|WebGL2RenderingContext} opts.gl
 * @param {Function} opts.composite  composite(view, viewport, target, afterRender)
 *                                   — renders camera + scene into `target` and
 *                                   calls afterRender() while it is still bound
 * @param {Function} opts.onstop     receives the finished Blob
 * @param {number}   [opts.fps]      target framerate (default 24)
 * @param {number}   [opts.maxWidth] frames are downscaled to this (default 1280)
 * @param {boolean}  [opts.withAudio] also record the microphone (default false)
 */
export function createRecorder({
  renderer, gl, composite, onstop,
  fps = 24, maxWidth = 1280, withAudio = false
}) {
  /* WebGL2 gives us fences and pixel buffer objects; WebGL1 does not. */
  const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

  let active = false;
  let target = null;          // render target the composite is built in
  let width = 0, height = 0;
  let canvas = null, ctx = null, imageData = null;
  let pixels = null;          // scratch buffer for one frame of RGBA
  let stream = null, videoTrack = null, audioStream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let lastFrameAt = 0;
  const inflight = [];        // { pbo, sync } queue of pending GPU reads

  /** True if this browser can record at all. */
  function isSupported() {
    return typeof MediaRecorder !== 'undefined'
      && !!HTMLCanvasElement.prototype.captureStream
      && !!pickMime();
  }

  function pickMime() {
    return MIME_TYPES.find((type) => {
      try { return MediaRecorder.isTypeSupported(type); } catch (e) { return false; }
    });
  }

  /**
   * Begins recording. Must be called from a user gesture if withAudio is set,
   * because the microphone prompt requires one.
   */
  async function start(view, viewport) {
    if (active) return;

    /* Size the recording. Even dimensions keep video encoders happy. */
    const scale = Math.min(1, maxWidth / viewport.width);
    width  = Math.round(viewport.width  * scale / 2) * 2;
    height = Math.round(viewport.height * scale / 2) * 2;

    target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, stencilBuffer: false });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    pixels = new Uint8Array(width * height * 4);

    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d');
    imageData = ctx.createImageData(width, height);

    /* captureStream(0) = manual frame control via requestFrame(). */
    stream = canvas.captureStream(0);
    videoTrack = stream.getVideoTracks()[0];

    if (withAudio) {
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioStream.getAudioTracks().forEach((t) => stream.addTrack(t));
      } catch (e) {
        console.warn('Microphone unavailable, recording video only', e);
      }
    }

    chunks = [];
    recorder = new MediaRecorder(stream, {
      mimeType: pickMime(),
      videoBitsPerSecond: 6_000_000
    });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType.split(';')[0] });
      cleanup();
      onstop?.(blob);
    };

    recorder.start();
    active = true;
    startedAt = performance.now();
    lastFrameAt = 0;
  }

  /**
   * Call once per XR frame while recording. Composites the frame, queues the
   * GPU read, and pushes any finished frames into the video stream.
   */
  function frame(view, viewport) {
    if (!active || !target) return;

    /* Throttle to the target framerate — recording every XR frame is wasted
     * work and a bigger encoder load than the result justifies. */
    const now = performance.now();
    if (now - lastFrameAt < 1000 / fps) { drain(); return; }
    lastFrameAt = now;

    /* Don't let reads pile up if the GPU is behind. */
    if (inflight.length >= MAX_INFLIGHT) { drain(); return; }

    composite(view, viewport, target, () => {
      /* Runs while `target`'s framebuffer is still bound, which is what
       * readPixels reads from. */
      if (isGL2) queueAsyncRead();
    });

    if (!isGL2) {
      /* WebGL1: no fences, so take the synchronous hit. */
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      publish(pixels);
    }

    drain();
  }

  /** Queues a non-blocking GPU→CPU copy and a fence to track it. */
  function queueAsyncRead() {
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);

    /* Offset 0 rather than a typed array: with a PIXEL_PACK_BUFFER bound this
     * writes into the buffer object and returns immediately. */
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();   // make sure the fence is actually submitted
    inflight.push({ pbo, sync });
  }

  /** Publishes every queued read whose fence has signalled. */
  function drain() {
    if (!isGL2) return;

    while (inflight.length) {
      const item = inflight[0];
      const status = gl.clientWaitSync(item.sync, 0, 0);   // 0 timeout = poll
      if (status === gl.TIMEOUT_EXPIRED) break;            // not ready; try later

      inflight.shift();
      gl.deleteSync(item.sync);

      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, item.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(item.pbo);

      publish(pixels);
    }
  }

  /** Flips the rows and hands one frame to the video stream. */
  function publish(src) {
    const stride = width * 4;
    for (let y = 0; y < height; y++) {
      // WebGL reads bottom-up; canvas is top-down
      imageData.data.set(src.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
    }
    ctx.putImageData(imageData, 0, 0);
    videoTrack?.requestFrame();
  }

  /** Stops recording. The Blob arrives via the onstop callback. */
  function stop() {
    if (!active) return;
    active = false;
    drain();                                  // flush what we can
    try { recorder.stop(); } catch (e) { cleanup(); }
  }

  /** Releases GPU and media resources. Safe to call twice. */
  function cleanup() {
    for (const item of inflight) {
      try { gl.deleteSync(item.sync); gl.deleteBuffer(item.pbo); } catch (e) {}
    }
    inflight.length = 0;

    try { target?.dispose(); } catch (e) {}
    target = null;
    pixels = null;
    imageData = null;
    ctx = null;
    canvas = null;

    audioStream?.getTracks().forEach((t) => t.stop());
    audioStream = null;
    videoTrack = null;
    stream = null;
  }

  /** Seconds elapsed, for the on-screen timer. */
  function elapsed() {
    return active ? (performance.now() - startedAt) / 1000 : 0;
  }

  return {
    isSupported,
    start,
    frame,
    stop,
    elapsed,
    get active() { return active; }
  };
}
