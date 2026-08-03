/* =============================================================================
 * I Love Tobago — WebXR AR placement + photo
 * =============================================================================
 *
 * WHAT THIS FILE DOES, IN ORDER OF EXECUTION:
 *
 *   1. init()              builds the three.js scene, renderer and lighting
 *   2. buildEntryButton()  checks WebXR support and adds the "Start AR" button
 *   3. onSessionStart()    sets up hit-testing once the AR session begins
 *   4. renderFrame()       runs ~60x a second: hit-test, preview, anchors, draw
 *   5. place()             commits the model to a world-locked anchor
 *   6. capture()           composites the camera feed + model into a JPEG
 *   7. onSessionEnd()      tears everything down and shows the photo gallery
 *
 * KEY CONCEPTS IF YOU'RE NEW TO WEBXR:
 *
 *   Reference space  A coordinate system. 'local' is anchored roughly where you
 *                    started; 'viewer' moves with the device.
 *   Hit test         Casts a ray from the device into the real world and returns
 *                    where it meets a detected surface. This is what the reticle
 *                    follows.
 *   Anchor           Asks the AR runtime to remember a point in the real world.
 *                    As the phone refines its map of the room, the anchor's
 *                    reported pose is corrected, so the model stays put instead
 *                    of sliding. Without anchors, objects drift.
 *   Camera access    An optional feature that hands you the real camera frame as
 *                    a WebGL texture. Needed for photos — see the photo section.
 * ========================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XREstimatedLight } from 'three/addons/webxr/XREstimatedLight.js';
/* Object3D.clone() copies a skinned mesh's bones but does NOT rewire the mesh to
 * the new skeleton, so every clone silently animates the ORIGINAL model instead.
 * SkeletonUtils.clone() does the remapping. Safe for non-skinned models too. */
import { clone as cloneModel } from 'three/addons/utils/SkeletonUtils.js';

/* Two optional features, kept in their own files so each can be tested or
 * removed independently:
 *   record.js     in-app video recording (composites every frame itself)
 *   cleanmode.js  hides the UI so the phone's screen recorder sees only AR
 */
import { createRecorder } from './record.js';
import { createCleanMode } from './cleanmode.js';


/* =============================================================================
 * 1. CONFIGURATION — the knobs you're most likely to want to turn
 * ========================================================================== */

/** Path to your model. A .glb (single file) is far more reliable than a .gltf,
 *  which loads its .bin and every texture as separate requests — one wrong
 *  relative path and the model silently fails to appear. */
const MODEL_URL = '/assets/ILOVETOBAGO.glb';

/** How tall the model is in the real world, in metres, at 100% size.
 *  glTF units are metres, so a model authored at 100 units would otherwise be
 *  100 m tall. normalise() rescales it to exactly this height. */
const MODEL_HEIGHT = 0.35;

/** Limits for pinch-to-size, as multiples of MODEL_HEIGHT. */
const MIN_SCALE = 0.2;
const MAX_SCALE = 5.0;

/** Photos are downscaled to at most this width. readRenderTargetPixels stalls
 *  the GPU pipeline, so a full-resolution grab on a phone is noticeably slow. */
const MAX_PHOTO_WIDTH = 1600;

/** How quickly the ghost preview eases towards the raw hit-test pose. Higher is
 *  snappier, lower is smoother. Raw hit results jitter by a centimetre or two
 *  every frame, so following them directly makes the model shimmer. */
const PREVIEW_SMOOTHING = 12;

/** Camera image orientation varies by device. If your photos come out upside
 *  down, set this to true. */
const FLIP_CAMERA_Y = false;

/** Colour handling for the camera texture — see the photo section for why.
 *  Leave false. Set true ONLY if photos come out too dark. */
const CAMERA_TEXTURE_IS_LINEAR = false;


/* =============================================================================
 * 2. DOM HELPERS AND ERROR REPORTING
 * ========================================================================== */

/** Shorthand for document.getElementById. */
const $ = (id) => document.getElementById(id);

const overlayEl = $('overlay');   // the in-session UI layer (WebXR "dom overlay")
const introEl   = $('intro');     // the pre-session splash screen
const statusEl  = $('status');    // the pill of text at the top
const readoutEl = $('readout');   // "35 cm · facing you"

/** Updates the status pill, skipping the DOM write if the text is unchanged. */
const setStatus = (text) => {
  if (statusEl.textContent !== text) statusEl.textContent = text;
};

/** Constrains a number to a range. */
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/* A phone in an immersive session has no console you can read, and a silent
 * failure is indistinguishable from a crash. Every uncaught error is therefore
 * shown on screen for a few seconds. Remove this block in production if you
 * prefer, but it is the single most useful debugging tool here. */
let lastReported = '';
function reportError(e) {
  const message = (e && (e.message || e.reason?.message || e.reason)) || String(e);
  console.error(e);
  if (message === lastReported) return;   // don't spam the same error every frame
  lastReported = message;

  const box = $('errors');
  box.textContent = String(message).slice(0, 180);
  box.hidden = false;
  setTimeout(() => { box.hidden = true; lastReported = ''; }, 8000);
}
addEventListener('error', (e) => reportError(e.error || e.message));
addEventListener('unhandledrejection', (e) => reportError(e.reason));


/* =============================================================================
 * 3. MODULE STATE
 * ========================================================================== */

/* three.js objects */
let renderer;          // WebGLRenderer, with .xr enabled
let gl;                // the raw WebGL context, needed for the photo compositor
let scene;
let camera;            // placeholder; three swaps in the real XR camera each frame
let reticle;           // the ring that marks the detected surface
let modelTemplate;     // the loaded, normalised model — cloned for each placement
let modelClips = [];   // AnimationClips found in the glTF/GLB
let previewMixer = null;
let previewGroup;      // ghost copy that rides on the reticle before you commit
let previewPivot;      //   ↳ child that carries your rotation and scale
let fillLight;         // fallback lights, used until real lighting is available
let defaultEnvironment;// fallback image-based lighting (a synthetic room)

/* WebXR objects */
let hitTestSource = null;  // produces surface hits each frame
let anchorsEnabled = null; // true / false / null when the runtime doesn't say
let glBinding = null;      // XRWebGLBinding, used to fetch the camera texture

/* UI / interaction state */
let mode = 'placing';      // 'placing' | 'placed' | 'review'
let placeRequested = false;   // a tap happened; act on it in the next frame
let placeRetries = 0;         // frames spent waiting for a usable hit pose
let previewSettled = false;   // false until the preview has a pose to ease from
let captureRequested = false; // a photo was asked for; grab it in the next frame
let cameraAccess = false;     // does this device give us the raw camera texture?
let timerSeconds = 0;         // self-timer: 0, 3 or 10
let arButton = null;          // three's ARButton, kept so we can relabel it
let recorder = null;          // in-app video recorder (record.js)
let cleanMode = null;         // UI-hiding mode for screen recording (cleanmode.js)
let recTimer = 0;             // interval id for the recording clock

/* The model's pending transform, applied to the preview and baked in on place */
let userYaw = 0;              // radians of rotation about the vertical axis
let userScale = 1;            // multiplier on MODEL_HEIGHT
let yawFollowsViewer = true;  // auto-face the camera until you rotate manually

/* Results */
const placements = [];   // { group, anchor, mixer } for each placed model
const mixers = [];       // every live AnimationMixer, ticked once per frame
const animClock = new THREE.Clock();   // supplies the delta the mixers need
const gallery = [];      // { blob, url } for each photo taken this session
let lastBlob = null;     // the most recent photo, shown on the review screen


/* =============================================================================
 * 4. INITIALISATION
 * ========================================================================== */

init();

function init() {
  scene = new THREE.Scene();

  /* This camera's values barely matter: once an XR session starts, three
   * replaces its matrices with the ones the headset/phone reports each frame.
   * The near plane is small because AR objects can be very close to you. */
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 40);

  /* alpha: true is essential — the parts of the canvas we don't draw must be
   * transparent so the real world shows through behind it. */
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));  // cap for performance
  renderer.setSize(innerWidth, innerHeight);

  /* Colour management. glTF textures are authored in sRGB; three works
   * internally in linear light and converts on output. Without this line
   * everything looks washed out or oddly saturated. */
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  /* Hand the render loop over to WebXR. three then manages the framebuffer,
   * viewport and camera matrices for us — doing that by hand is the single
   * biggest source of bugs in WebXR samples. */
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');

  document.body.appendChild(renderer.domElement);
  gl = renderer.getContext();

  setupLighting();
  scene.add(makeReticle());
  loadModel();

  /* WebXR reports screen taps as a 'select' event on an input source. We only
   * use this as a fallback: when dom-overlay is available, the touch handlers
   * in bindGestures() drive placement instead (see beforexrselect below). */
  const controller = renderer.xr.getController(0);
  controller.addEventListener('select', () => {
    if (mode === 'placing') placeRequested = true;
  });
  scene.add(controller);

  /* Without this, tapping a button in the overlay ALSO fires an XR 'select',
   * so pressing "Place" would place two models. Cancelling beforexrselect
   * suppresses the XR event for taps that landed on the overlay. */
  overlayEl.addEventListener('beforexrselect', (e) => e.preventDefault());

  renderer.xr.addEventListener('sessionstart', onSessionStart);
  renderer.xr.addEventListener('sessionend', onSessionEnd);

  bindControls();
  bindGestures($('gesture'));
  setMode('placing');

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  setupRecording();
  buildEntryButton();

  /* setAnimationLoop, not requestAnimationFrame: in an XR session the frames
   * are driven by the headset/phone, not the browser's normal timer. */
  renderer.setAnimationLoop(render);
}

/**
 * Checks for WebXR AR support and, if present, adds three's ARButton.
 *
 * requiredFeatures  the session will not start without these
 * optionalFeatures  granted if available, silently skipped if not — so the app
 *                   degrades gracefully on devices that lack them
 */
function buildEntryButton() {
  if (!navigator.xr) {
    return $('unsupported').removeAttribute('hidden');
  }

  navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
    if (!supported) return $('unsupported').removeAttribute('hidden');

    const button = ARButton.createButton(renderer, {      requiredFeatures: ['hit-test'],
      optionalFeatures: [
        'anchors',           // world-locked placement (no drift)
        'light-estimation',  // real room lighting on the model
        'dom-overlay',       // our HTML UI visible during the session
        'camera-access'      // raw camera texture, needed for photos
      ],
      domOverlay: { root: overlayEl }
    });
    button.textContent = 'Start AR';
    arButton = button;
    $('ar-button-slot').appendChild(button);
  });
}


/* =============================================================================
 * 5. LIGHTING
 *
 * glTF materials are physically based: they need an environment to reflect, not
 * just a lamp. Three layers here, best first:
 *
 *   1. XREstimatedLight — the device measures the real room's brightness,
 *      direction and colour and feeds it in. The model then matches the space
 *      it's sitting in, which is most of what makes AR look convincing.
 *   2. RoomEnvironment — a synthetic studio, used as image-based lighting when
 *      the device can't estimate. Gives metals and gloss something to reflect.
 *   3. Hemisphere + directional lights — plain fallback fill.
 * ========================================================================== */

function setupLighting() {
  /* PMREMGenerator converts a scene into the blurred cube map that PBR
   * materials sample for reflections and ambient light. */
  const pmrem = new THREE.PMREMGenerator(renderer);
  defaultEnvironment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = defaultEnvironment;
  scene.background = null;   // must stay null or you'd cover the camera feed

  fillLight = new THREE.Group();
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1.5, 3, 1);   // a DirectionalLight at 0,0,0 emits nothing:
                                 // its direction is light.position → target,
                                 // which would be a zero-length vector
  fillLight.add(new THREE.HemisphereLight(0xffffff, 0x8d8378, 1.6), key);
  scene.add(fillLight);

  /* Swap the fallbacks out for measured lighting when the device offers it. */
  const xrLight = new XREstimatedLight(renderer);

  xrLight.addEventListener('estimationstart', () => {
    scene.add(xrLight);
    scene.remove(fillLight);
    if (xrLight.environment) scene.environment = xrLight.environment;
  });

  xrLight.addEventListener('estimationend', () => {
    scene.remove(xrLight);
    scene.add(fillLight);
    scene.environment = defaultEnvironment;
  });
}


/* =============================================================================
 * 6. MODEL LOADING
 * ========================================================================== */

function loadModel() {
  new GLTFLoader().load(
    MODEL_URL,

    // success
    (gltf) => {
      modelTemplate = normalise(gltf.scene);

      /* Animations live alongside the scene, not inside it. If this is empty,
       * the export didn't include them — see the Blender note in the README. */
      modelClips = gltf.animations || [];
      console.log(`Model loaded with ${modelClips.length} animation clip(s)`,
                  modelClips.map((c) => c.name));

      /* Build the ghost preview: a clone that follows the reticle so you see
       * exactly what you're about to place, at the size and angle you've set. */
      previewPivot = new THREE.Group();
      const preview = instantiate();
      previewMixer = preview.mixer;
      previewPivot.add(preview.object);

      previewGroup = new THREE.Group();
      previewGroup.matrixAutoUpdate = false;  // we write .matrix from the hit pose
      previewGroup.visible = false;
      previewGroup.add(previewPivot);
      scene.add(previewGroup);

      updateReadout();
      setStatus('Move your phone to find a surface');
    },

    // progress (unused)
    undefined,

    // failure — nearly always a wrong path or a missing .bin/texture
    (err) => {
      console.error(err);
      setStatus('Model failed to load — check the asset path');
    }
  );
}

/**
 * Fixes the two things that break glTF models in AR:
 *
 *   Pivot   Most models are centred on their bounding box, so half the object
 *           sinks below the floor. We shift it so its lowest point is at y = 0.
 *   Scale   glTF units are metres. A model authored at any other scale appears
 *           microscopic or enormous. We rescale it to exactly MODEL_HEIGHT.
 *
 * Returns a Group whose origin is the point that should touch the ground.
 */
function normalise(root) {
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const scale = MODEL_HEIGHT / Math.max(size.y, 1e-5);   // guard against zero height

  /* CRITICAL FOR ANIMATED MODELS: the fit transform goes on a wrapper, never on
   * the model root. An AnimationClip that targets the root node writes its own
   * position/scale every frame, which would wipe out anything set here — the
   * model would snap back to its authored size and sink through the floor the
   * moment the animation started. */
  const fitter = new THREE.Group();
  fitter.scale.setScalar(scale);
  fitter.position.set(
    -centre.x * scale,     // centre horizontally on the origin
    -box.min.y * scale,    // lift so the base sits exactly on y = 0
    -centre.z * scale
  );
  fitter.add(root);

  const holder = new THREE.Group();
  holder.add(fitter);
  holder.add(makeContactShadow(Math.max(size.x, size.z) * scale * 1.6));
  return holder;
}

/**
 * Produces one independent copy of the model, with its own animation mixer so
 * each placement animates separately.
 *
 * Every clone needs its OWN mixer — a mixer is bound to one root object, and
 * sharing one across copies animates only the first.
 *
 * @returns {{ object: THREE.Object3D, mixer: THREE.AnimationMixer|null }}
 */
function instantiate() {
  const object = cloneModel(modelTemplate);

  let mixer = null;
  if (modelClips.length) {
    mixer = new THREE.AnimationMixer(object);
    /* Clips are matched to nodes by name, which cloneModel preserves. */
    for (const clip of modelClips) mixer.clipAction(clip).play();
    mixers.push(mixer);
  }
  return { object, mixer };
}

/** Stops a mixer and drops it from the per-frame update list. */
function disposeMixer(mixer) {
  if (!mixer) return;
  mixer.stopAllAction();
  mixer.uncacheRoot(mixer.getRoot());
  const i = mixers.indexOf(mixer);
  if (i >= 0) mixers.splice(i, 1);
}

/**
 * A soft dark blob on the ground under the model. Cheap — no shadow mapping —
 * and it does most of the work of making the object look like it is really
 * resting on the floor rather than hovering.
 */
function makeContactShadow(width) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;

  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0,   'rgba(0,0,0,0.55)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.18)');
  grad.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthWrite: false,   // don't let the shadow occlude the model
      toneMapped: false    // it's a UI effect, not lit geometry
    })
  );
  mesh.rotation.x = -Math.PI / 2;  // lie flat
  mesh.position.y = 0.002;         // hair above the floor to avoid z-fighting
  mesh.renderOrder = -1;           // draw before the model
  return mesh;
}

/** The targeting ring drawn on the detected surface. */
function makeReticle() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.055, 0.075, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x35c1a1, transparent: true, opacity: 0.9, toneMapped: false })
  );
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.008, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
  );

  reticle = new THREE.Group();
  reticle.add(ring, dot);

  /* We assign .matrix directly from the hit-test pose each frame, so three
   * must not overwrite it from position/rotation/scale. */
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  return reticle;
}


/* =============================================================================
 * 7. UI MODES
 *
 *   placing  reticle + ghost preview + transform controls; taps place a model
 *   placed   everything locked; photo controls shown; taps do nothing
 *   review   the photo you just took, with share/save
 * ========================================================================== */

function setMode(next) {
  mode = next;
  const placing = next === 'placing';

  $('row-adjust').hidden   = !placing;
  $('row-adjust-2').hidden = !placing;
  $('row-photo').hidden    = next !== 'placed';
  $('row-video').hidden    = next !== 'placed';
  $('row-placed').hidden   = next !== 'placed';
  $('readout').style.visibility = placing ? 'visible' : 'hidden';
  $('review').classList.toggle('on', next === 'review');

  /* Disabling pointer events on the gesture layer stops a stray tap from
   * placing another model once you've committed. */
  $('gesture').classList.toggle('off', !placing);

  /* Hide the reticle and the ghost immediately. The render loop skips
   * hit-testing outside 'placing' mode, so nothing turns them back on. */
  if (reticle) reticle.visible = false;
  if (previewGroup) previewGroup.visible = false;

  if (next === 'placed') {
    setStatus(cameraAccess ? 'Placed — step into frame and shoot' : 'Placed');
    $('photo').disabled = !cameraAccess;
    $('timer').disabled = !cameraAccess;
    $('record').disabled = !cameraAccess;   // clean mode stays available to all
  }
}

/** Wires up every button in the overlay. */
function bindControls() {
  const turn = (degrees) => {
    yawFollowsViewer = false;   // you've taken manual control
    userYaw += THREE.MathUtils.degToRad(degrees);
    updateReadout();
  };
  const resize = (factor) => {
    userScale = clamp(userScale * factor, MIN_SCALE, MAX_SCALE);
    updateReadout();
  };

  // --- placing mode
  $('rot-left').onclick  = () => turn(-15);
  $('rot-right').onclick = () => turn(15);
  $('smaller').onclick   = () => resize(1 / 1.15);
  $('bigger').onclick    = () => resize(1.15);
  $('place').onclick     = () => { placeRequested = true; };
  $('reset').onclick     = () => { userScale = 1; yawFollowsViewer = true; updateReadout(); };

  // --- placed mode
  $('reposition').onclick = () => { removePlacement(placements.pop()); setMode('placing'); };
  $('another').onclick    = () => setMode('placing');
  $('clear').onclick      = () => {
    while (placements.length) removePlacement(placements.pop());
    setMode('placing');
  };

  // --- video
  $('record').onclick = () => (recorder?.active || pendingRecordStart ? stopRecording() : startRecording());
  $('hideui').onclick = () => cleanMode.enter();

  $('timer').onclick = () => {
    timerSeconds = timerSeconds === 0 ? 3 : timerSeconds === 3 ? 10 : 0;
    $('timer').textContent = timerSeconds ? `Timer: ${timerSeconds}s` : 'Timer: off';
  };
  $('photo').onclick = startCapture;

  // --- review mode
  $('retake').onclick = () => setMode('placed');

  /* Chrome suppresses downloads while an immersive session owns the screen, so
   * a programmatic <a download>.click() in-session goes nowhere visible. We
   * leave the session first; onSessionEnd then builds a gallery of real links
   * for the user to tap, which browsers never block. */
  $('save').onclick = async () => {
    if (!lastBlob) return;
    $('save').disabled = true;
    try {
      const session = renderer.xr.getSession();
      if (session) await session.end();
      else showGallery();
    } catch (e) {
      console.error(e);
      showGallery();          // fall through rather than dead-end
    } finally {
      $('save').disabled = false;
    }
  };

  /* Sharing works without leaving AR, and hands the JPEG straight to WhatsApp,
   * Photos, etc. Preferred over Save where it's supported. */
  $('share').onclick = async () => {
    if (!lastBlob) return;
    const file = new File([lastBlob], 'tobago-ar.jpg', { type: 'image/jpeg' });
    try { await navigator.share({ files: [file] }); }
    catch (e) { /* user dismissed the sheet */ }
  };
}

/** Builds the post-session photo strip. Each thumbnail is a real download link. */
function showGallery() {
  if (!gallery.length) return;

  const shots = $('shots');
  shots.textContent = '';   // clear without innerHTML

  gallery.forEach((item, i) => {
    const link = document.createElement('a');
    link.href = item.url;
    link.download = `tobago-ar-${i + 1}.jpg`;

    /* Videos get a muted <video> thumbnail; the link still downloads it. */
    if (item.kind === 'video') {
      link.download = `tobago-ar-${i + 1}.webm`;
      const video = document.createElement('video');
      video.src = item.url;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      link.appendChild(video);
      link.classList.add('is-video');
    } else {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = `AR photo ${i + 1}`;
      link.appendChild(img);
    }

    shots.appendChild(link);
  });

  $('gallery').removeAttribute('hidden');
}

/** "35 cm · facing you" — real-world size is the number that actually helps. */
function updateReadout() {
  const cm = Math.round(MODEL_HEIGHT * userScale * 100);
  const turned = yawFollowsViewer
    ? 'facing you'
    : `${Math.round(((THREE.MathUtils.radToDeg(userYaw) % 360) + 360) % 360)}°`;
  readoutEl.textContent = `${cm} cm · ${turned}`;
}


/* =============================================================================
 * 8. TOUCH GESTURES
 *
 *   one finger, dragged   rotate
 *   two fingers, pinched  scale
 *   two fingers, twisted  rotate
 *   one finger, tapped    place
 *
 * The tap and the drag share a finger, so we measure how far it moved: under
 * the slop threshold and inside the time limit, it's a tap.
 * ========================================================================== */

function bindGestures(el) {
  const TAP_SLOP = 12;   // pixels of movement still counted as a tap
  const TAP_MS = 500;    // longer than this is a press, not a tap
  let g = null;          // the in-progress gesture

  const distance = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const angle    = (t) => Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX);

  el.addEventListener('touchstart', (e) => {
    e.preventDefault();          // suppress browser scroll/zoom
    if (mode !== 'placing') return;

    const t = e.touches;
    if (t.length === 1) {
      g = { kind: 'turn', x: t[0].clientX, y: t[0].clientY, moved: 0, at: performance.now(), yaw0: userYaw };
    } else if (t.length === 2) {
      // moved: 999 means "definitely not a tap"
      g = { kind: 'pinch', d0: distance(t), a0: angle(t), scale0: userScale, yaw0: userYaw, moved: 999 };
    }
  }, { passive: false });

  el.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!g || mode !== 'placing') return;
    const t = e.touches;

    if (g.kind === 'turn' && t.length === 1) {
      const dx = t[0].clientX - g.x;
      const dy = t[0].clientY - g.y;
      g.moved = Math.max(g.moved, Math.hypot(dx, dy));

      if (g.moved > TAP_SLOP) {          // committed to a drag
        yawFollowsViewer = false;
        userYaw = g.yaw0 + dx * 0.012;   // ~0.7° per pixel
        updateReadout();
      }
    } else if (g.kind === 'pinch' && t.length === 2) {
      userScale = clamp(g.scale0 * (distance(t) / g.d0), MIN_SCALE, MAX_SCALE);
      yawFollowsViewer = false;
      userYaw = g.yaw0 + (angle(t) - g.a0);
      updateReadout();
    }
  }, { passive: false });

  const end = (e) => {
    e.preventDefault();
    const wasTap = g && mode === 'placing' && g.kind === 'turn'
      && g.moved <= TAP_SLOP && performance.now() - g.at < TAP_MS;

    if (wasTap) placeRequested = true;
    if (e.touches.length === 0) g = null;
  };
  el.addEventListener('touchend', end, { passive: false });
  el.addEventListener('touchcancel', end, { passive: false });
}


/* =============================================================================
 * 9. SESSION LIFECYCLE
 * ========================================================================== */

async function onSessionStart() {
  introEl.style.display = 'none';
  overlayEl.classList.remove('hidden');
  setMode('placing');
  setStatus(modelTemplate ? 'Move your phone to find a surface' : 'Loading model…');

  const session = renderer.xr.getSession();

  /* Which optional features did we actually get? Without 'anchors' the model is
   * fixed in a drifting reference space and will not stay put — worth knowing
   * rather than silently guessing. enabledFeatures is not implemented
   * everywhere, hence the null case. */
  const features = session.enabledFeatures;
  anchorsEnabled = features ? features.includes('anchors') : null;
  console.log('WebXR features granted:', features ?? '(not reported)');
  if (anchorsEnabled === false) {
    setStatus('No anchor support — placement may drift');
  }

  /* Hit-test from the viewer's position, along the direction it's facing —
   * this is what makes the reticle land wherever the phone is pointing. */
  const viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

  /* Needed to pull the camera texture for photos. Throws if the device or
   * session doesn't support it, in which case photos are simply disabled. */
  try { glBinding = new XRWebGLBinding(session, gl); }
  catch (e) { glBinding = null; }
}

function onSessionEnd() {
  /* Every XR object is already dead by the time this fires. Calling
   * anchor.delete() or hitTestSource.cancel() here throws InvalidStateError,
   * which would abort the rest of the teardown — so each step is isolated and
   * we don't touch XR objects the runtime has already released. */
  try { hitTestSource?.cancel?.(); } catch (e) { /* already gone */ }
  hitTestSource = null;
  glBinding = null;
  cameraAccess = false;
  captureRequested = false;

  for (const record of placements) {
    scene.remove(record.group);
    disposeMixer(record.mixer);
    record.mixer = null;
    record.anchor = null;
  }
  placements.length = 0;

  try { photoTarget?.dispose(); } catch (e) {}
  photoTarget = null;
  photoPixels = null;

  setMode('placing');
  overlayEl.classList.add('hidden');
  introEl.style.display = '';
  showGallery();

  /* Reset anything a second session would inherit in a broken state. ARButton
   * rewrites its own label on session end, so relabel after it (timeout 0 puts
   * us behind its handler in the queue). */
  $('photo').disabled = false;
  $('save').disabled = false;
  captureRequested = false;
  setTimeout(() => { if (arButton) arButton.textContent = 'Start AR'; }, 0);
}


/* =============================================================================
 * 10. PLACEMENT
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * Pose maths
 *
 * THE BUG THIS SOLVES: a hit-test pose carries its own yaw, usually derived from
 * the direction you're looking. Parenting the model to that pose and then adding
 * our own yaw on top meant the two were summed — the model never faced you
 * properly and swung as you moved.
 *
 * So we take only what we actually want from the pose — the position, and the
 * surface normal — and build the orientation ourselves: rotate by our yaw about
 * world up, then tilt so the model's up follows the surface. On a level floor
 * the tilt is identity and the result is exactly our yaw.
 *
 * All scratch objects are module-level so the render loop allocates nothing.
 * -------------------------------------------------------------------------- */

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

const _poseMatrix = new THREE.Matrix4();
const _posePos = new THREE.Vector3();
const _poseQuat = new THREE.Quaternion();
const _poseScale = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _alignQuat = new THREE.Quaternion();
const _yawQuat = new THREE.Quaternion();

/* Smoothing state for the ghost preview. */
const _targetPos = new THREE.Vector3();
const _targetQuat = new THREE.Quaternion();
const _smoothPos = new THREE.Vector3();
const _smoothQuat = new THREE.Quaternion();

/**
 * Converts a WebXR pose matrix plus a world-space yaw into a position and
 * orientation for the model.
 *
 * @param {Float32Array} matrixArray  pose.transform.matrix
 * @param {number} yaw                world-space rotation about vertical, radians
 * @param {THREE.Vector3} outPos
 * @param {THREE.Quaternion} outQuat
 */
function surfaceTransform(matrixArray, yaw, outPos, outQuat) {
  _poseMatrix.fromArray(matrixArray);
  _poseMatrix.decompose(_posePos, _poseQuat, _poseScale);

  /* The surface normal is the pose's own up vector expressed in world space. */
  _normal.copy(WORLD_UP).applyQuaternion(_poseQuat).normalize();

  /* Tilt that takes world up onto the surface normal — identity on a level
   * floor, a quarter turn on a wall. */
  _alignQuat.setFromUnitVectors(WORLD_UP, _normal);

  /* Our yaw is applied FIRST (about world up), then the tilt. Reversing these
   * would make the yaw axis depend on the surface angle. */
  _yawQuat.setFromAxisAngle(WORLD_UP, yaw);

  outQuat.copy(_alignQuat).multiply(_yawQuat);
  outPos.copy(_posePos);
}

/**
 * Commits a model at a hit-test result.
 *
 * Called from inside the render loop, never straight from the tap handler: an
 * XRHitTestResult can only create an anchor during the frame that produced it,
 * and 'select' events don't always fire inside that frame. The tap sets
 * placeRequested; this runs with a fresh, valid hit.
 *
 * @returns {boolean} true if the model was placed
 */
function place(hit, referenceSpace) {
  if (!modelTemplate) return false;

  const pose = hit.getPose(referenceSpace);
  if (!pose) return false;      // caller retries next frame rather than losing the tap

  /* Position and surface tilt come from the pose; the facing is ours. */
  surfaceTransform(pose.transform.matrix, userYaw, _targetPos, _targetQuat);

  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.matrix.compose(_targetPos, _targetQuat, UNIT_SCALE);

  /* A child carries the scale, leaving the outer group's matrix free to be
   * rewritten from the anchor's pose every frame. */
  const pivot = new THREE.Group();
  pivot.scale.setScalar(userScale);

  const instance = instantiate();
  pivot.add(instance.object);

  group.add(pivot);
  scene.add(group);

  /* yaw is stored because the anchor pose has its own, which we discard and
   * replace with this every frame. */
  const record = { group, anchor: null, mixer: instance.mixer, yaw: userYaw };
  placements.push(record);

  /* Anchoring is asynchronous. Until it resolves the model sits at the fixed
   * matrix above, which drifts — the anchor then takes over in the loop. */
  if (typeof hit.createAnchor === 'function') {
    hit.createAnchor().then(
      (anchor) => { record.anchor = anchor; },
      (err) => {
        console.warn('createAnchor failed', err);
        setStatus('Placed without an anchor — it may drift');
      }
    );
  } else {
    /* No createAnchor at all means the 'anchors' feature wasn't granted. */
    setStatus('Placed without an anchor — it may drift');
  }

  setMode('placed');
  return true;
}

function removePlacement(record) {
  if (!record) return;
  scene.remove(record.group);
  disposeMixer(record.mixer);
  record.mixer = null;

  /* delete() throws once the session has ended, and the runtime frees anchors
   * for us at that point — so only call it while the session is live. */
  if (record.anchor && renderer.xr.getSession()) {
    try { record.anchor.delete(); } catch (e) { /* already gone */ }
  }
  record.anchor = null;

  /* Geometry and materials are shared with modelTemplate via clone(), so they
   * must NOT be disposed here — that would break every other copy. */
}


/* =============================================================================
 * 11. PHOTO CAPTURE
 *
 * WHY THIS IS NOT JUST canvas.toDataURL():
 * Your canvas contains only the 3D content on a transparent background. The
 * camera feed is drawn behind it by the system compositor and never enters your
 * framebuffer. Grabbing the canvas gives you a model floating on nothing.
 *
 * The fix is the WebXR raw camera access module ('camera-access'), which
 * exposes the real camera frame as a WebGL texture. We then:
 *
 *   1. blit that texture into an offscreen render target
 *   2. render the scene on top of it using the live XR camera's matrices
 *   3. read the pixels back and encode a JPEG
 *
 * Chrome on Android only. Elsewhere the photo button disables itself.
 * ========================================================================== */

let quad = null;          // the raw-WebGL fullscreen-quad program
let photoTarget = null;   // offscreen render target the photo is built in
let photoPixels = null;   // reusable readback buffer

/* A camera whose matrices we copy from the live XR camera. Both auto-update
 * flags are off so three doesn't recompute and overwrite them. */
const photoCam = new THREE.PerspectiveCamera();
photoCam.matrixAutoUpdate = false;
photoCam.matrixWorldAutoUpdate = false;

/**
 * Compiles the little shader that draws the camera texture across the target.
 * Raw WebGL rather than a three material, because the camera texture is an
 * opaque WebGLTexture that three doesn't own.
 */
function makeQuad() {
  const vs = `
    attribute vec2 aPos;
    uniform vec2 uUvScale;
    varying vec2 vUv;
    void main(){
      vUv = aPos * 0.5 * uUvScale + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  /* The photo target is an sRGB framebuffer, so the GPU encodes everything
   * written to it. The camera texture already holds sRGB-encoded bytes — write
   * them straight through and they get encoded twice, lifting every midtone
   * towards white. Decoding here cancels that out. */
  const fs = `
    precision highp float;
    uniform sampler2D uTex;
    uniform float uFlip;
    uniform float uDecode;
    varying vec2 vUv;

    vec3 srgbToLinear(vec3 c){
      return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
    }

    void main(){
      vec2 uv = vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uFlip));
      vec3 c = texture2D(uTex, uv).rgb;
      gl_FragColor = vec4(mix(c, srgbToLinear(c), uDecode), 1.0);
    }`;

  const compile = (type, src) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(shader));
    return shader;
  };

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  return {
    program, buffer,
    aPos:     gl.getAttribLocation(program, 'aPos'),
    uTex:     gl.getUniformLocation(program, 'uTex'),
    uUvScale: gl.getUniformLocation(program, 'uUvScale'),
    uFlip:    gl.getUniformLocation(program, 'uFlip'),
    uDecode:  gl.getUniformLocation(program, 'uDecode')
  };
}

/** Runs the countdown, then flags the render loop to grab the next frame. */
async function startCapture() {
  if (!cameraAccess) return setStatus('No camera access — use your phone screenshot');
  $('photo').disabled = true;

  for (let n = timerSeconds; n > 0; n--) {
    $('countdown').textContent = n;
    $('countdown').classList.add('on');
    await new Promise((r) => setTimeout(r, 1000));
  }
  $('countdown').classList.remove('on');

  /* The camera texture is only valid inside an XR frame callback, so the actual
   * grab happens in renderFrame(), not here. */
  captureRequested = true;
}

/**
 * THE SHARED COMPOSITOR — used by both the photo path and record.js.
 *
 * Draws the real camera frame into `target`, then renders the scene on top of
 * it through the live XR camera, so the model lands exactly where it appears on
 * screen. Must be called inside an XR frame callback: the camera texture is only
 * valid for the frame that produced it.
 *
 * @param {XRView}   view        the frame's view, carrying view.camera
 * @param {object}   viewport    XR viewport, for the aspect ratio to match
 * @param {THREE.WebGLRenderTarget} target
 * @param {Function} [afterRender] run while `target` is still bound — this is
 *                                 where record.js queues its async pixel read
 * @returns {boolean} false if the camera texture was unavailable
 */
function compositeFrame(view, viewport, target, afterRender) {
  const camTex = glBinding.getCameraImage(view.camera);   // valid this frame only
  if (!camTex) return false;
  if (!quad) quad = makeQuad();

  const w = target.width;
  const h = target.height;
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;

  // --- step 1: the camera frame, cover-fitted to the viewport's aspect ratio
  renderer.setRenderTarget(target);
  renderer.clear(true, true, true);

  const camAspect = view.camera.width / view.camera.height;
  const rtAspect = w / h;
  const sx = camAspect > rtAspect ? rtAspect / camAspect : 1;
  const sy = camAspect > rtAspect ? 1 : camAspect / rtAspect;

  gl.useProgram(quad.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad.buffer);
  gl.enableVertexAttribArray(quad.aPos);
  gl.vertexAttribPointer(quad.aPos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, camTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(quad.uTex, 0);
  gl.uniform2f(quad.uUvScale, sx, sy);
  gl.uniform1f(quad.uFlip, FLIP_CAMERA_Y ? 1 : 0);
  gl.uniform1f(quad.uDecode, CAMERA_TEXTURE_IS_LINEAR ? 0 : 1);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  /* We changed GL state behind three's back. resetState() invalidates its
   * cache so the next draw doesn't rely on stale assumptions. */
  renderer.resetState();

  // --- step 2: the model on top, through a copy of the live XR camera
  const xrCam = renderer.xr.getCamera();
  const src = xrCam.cameras?.[0] ?? xrCam;   // AR has a single view
  photoCam.matrixWorld.copy(src.matrixWorld);
  photoCam.matrixWorldInverse.copy(src.matrixWorldInverse);
  photoCam.projectionMatrix.copy(src.projectionMatrix);
  photoCam.projectionMatrixInverse.copy(src.projectionMatrixInverse);

  renderer.xr.enabled = false;    // or three renders to the XR framebuffer instead
  renderer.autoClear = false;     // keep the camera frame we just drew
  renderer.setRenderTarget(target);
  renderer.render(scene, photoCam);
  renderer.xr.enabled = true;
  renderer.autoClear = prevAutoClear;

  /* The target is still bound here, which is what an async readPixels needs. */
  afterRender?.(target);

  renderer.setRenderTarget(prevTarget);
  return true;
}

/**
 * Builds the composite photo. Must be called from inside an XR frame callback.
 *
 * @param {XRView} view      the frame's view, carrying view.camera
 * @param {object} viewport  the XR viewport, giving us the aspect to match
 */
function capture(view, viewport) {
  const downscale = Math.min(1, MAX_PHOTO_WIDTH / viewport.width);
  const w = Math.round(viewport.width * downscale);
  const h = Math.round(viewport.height * downscale);

  if (!photoTarget || photoTarget.width !== w || photoTarget.height !== h) {
    photoTarget?.dispose();
    photoTarget = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false });
    photoTarget.texture.colorSpace = THREE.SRGBColorSpace;
    photoPixels = new Uint8Array(w * h * 4);
  }

  if (!compositeFrame(view, viewport, photoTarget)) {
    setStatus('Camera image unavailable');
    $('photo').disabled = false;
    return;
  }

  // --- pixels out, rows flipped, encoded as JPEG
  renderer.readRenderTargetPixels(photoTarget, 0, 0, w, h, photoPixels);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);

  /* WebGL reads bottom-up, canvas expects top-down, so copy row by row in
   * reverse. */
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    image.data.set(photoPixels.subarray((h - 1 - y) * stride, (h - y) * stride), y * stride);
  }
  ctx.putImageData(image, 0, 0);

  $('flash').classList.add('on');
  setTimeout(() => $('flash').classList.remove('on'), 30);

  canvas.toBlob((blob) => {
    lastBlob = blob;
    const url = URL.createObjectURL(blob);
    gallery.push({ blob, url });

    $('shot').src = url;
    $('share').hidden = !(navigator.canShare?.({
      files: [new File([blob], 'p.jpg', { type: 'image/jpeg' })]
    }));
    $('photo').disabled = false;
    setMode('review');
  }, 'image/jpeg', 0.92);
}


/* =============================================================================
 * 11b. VIDEO — in-app recording and clean mode
 *
 * Two independent routes to a video, because they suit different jobs:
 *
 *   In-app recording (record.js)  Composites each frame itself, so the output
 *     has no UI in it and you control the format. Costs framerate, needs
 *     camera-access, and is Chrome-on-Android only — same limits as photos.
 *
 *   Clean mode (cleanmode.js)     Hides our UI and lets the phone's own screen
 *     recorder do the work: full framerate, audio, no GPU cost. Works on any
 *     device. Tap the screen to bring the UI back.
 * ========================================================================== */

/** Reads the XR viewport for a view, with a sensible fallback. */
function xrViewport(view) {
  return renderer.xr.getSession()?.renderState.baseLayer?.getViewport(view)
    ?? { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
}

function setupRecording() {
  recorder = createRecorder({
    renderer,
    gl,
    composite: compositeFrame,     // the shared compositor from section 11
    fps: 24,
    maxWidth: 1280,
    withAudio: false,              // true also records the mic (asks permission)
    onstop: (blob) => {
      const url = URL.createObjectURL(blob);
      gallery.push({ blob, url, kind: 'video' });
      setStatus('Video ready — Save exits AR so you can download it');
    }
  });

  cleanMode = createCleanMode({
    overlayEl,
    gestureEl: $('gesture'),
    hintEl: $('cleanhint'),
    onExit: () => setStatus('UI back')
  });
}

function startRecording() {
  if (!cameraAccess) return setStatus('No camera access — use screen recording');
  if (!recorder.isSupported()) return setStatus('Recording unsupported on this browser');
  if (recorder.active) return;

  /* Sizing the recording needs an XR viewport, which only exists inside a frame
   * callback — so flag it and let the render loop start us on the next frame. */
  pendingRecordStart = true;
  $('record').textContent = '● Starting…';
}

function stopRecording() {
  clearInterval(recTimer);
  recTimer = 0;
  $('record').textContent = '● Record';
  $('record').classList.remove('recording');
  if (recorder?.active) recorder.stop();
}

/** Called from the render loop once a valid frame exists. */
let pendingRecordStart = false;
function beginRecordingNow(view, viewport) {
  pendingRecordStart = false;

  recorder.start(view, viewport).then(() => {
    $('record').textContent = '■ Stop 0:00';
    $('record').classList.add('recording');
    recTimer = setInterval(() => {
      const s = Math.floor(recorder.elapsed());
      $('record').textContent = `■ Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
  }).catch((e) => {
    reportError(e);
    $('record').textContent = '● Record';
  });
}


/* =============================================================================
 * 12. RENDER LOOP
 * ========================================================================== */

/* Reused so the loop allocates nothing per frame. */
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * The outer loop. A throw inside setAnimationLoop kills the loop permanently
 * and looks exactly like a crash, so nothing is allowed to escape.
 */
function render(timestamp, frame) {
  try {
    renderFrame(timestamp, frame);
  } catch (e) {
    reportError(e);
    try { renderer.render(scene, camera); } catch (e2) { /* context is gone */ }
  }
}

function renderFrame(timestamp, frame) {
  /* Advance every animation. getDelta() must be called exactly once per frame:
   * it returns the time since the last call and resets, so a second call the
   * same frame would return ~0 and stall everything. */
  const delta = animClock.getDelta();
  for (const mixer of mixers) mixer.update(delta);

  /* No frame means we're not in an AR session — just draw and leave. */
  if (!frame) {
    renderer.render(scene, camera);
    return;
  }

  const referenceSpace = renderer.xr.getReferenceSpace();
  const viewerPose = frame.getViewerPose(referenceSpace);
  const view = viewerPose?.views[0];   // mobile AR has exactly one view

  /* view.camera only exists when 'camera-access' was granted. */
  cameraAccess = !!(view?.camera && glBinding);

  // --- surface tracking and the ghost preview (placing mode only)
  if (mode === 'placing' && hitTestSource) {
    const hits = frame.getHitTestResults(hitTestSource);

    if (hits.length > 0) {
      const pose = hits[0].getPose(referenceSpace);

      if (pose && previewGroup) {
        /* The reticle follows the raw pose so it reads as a live cursor. Its
         * ring is rotationally symmetric, so the pose's yaw doesn't show. */
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);

        /* Auto-face the viewer until the first manual rotation, so lettering on
         * the model reads the right way round. This is a world-space yaw, which
         * is exactly what surfaceTransform() expects. */
        if (yawFollowsViewer) {
          _poseMatrix.fromArray(pose.transform.matrix);
          _p.setFromMatrixPosition(_poseMatrix);
          _c.setFromMatrixPosition(camera.matrixWorld);
          userYaw = Math.atan2(_c.x - _p.x, _c.z - _p.z);
          updateReadout();
        }

        surfaceTransform(pose.transform.matrix, userYaw, _targetPos, _targetQuat);

        if (!previewSettled) {
          /* First frame after reacquiring a surface: snap, don't glide in. */
          _smoothPos.copy(_targetPos);
          _smoothQuat.copy(_targetQuat);
          previewSettled = true;
        } else {
          /* Exponential ease, framerate independent. */
          const a = 1 - Math.exp(-delta * PREVIEW_SMOOTHING);
          _smoothPos.lerp(_targetPos, a);
          _smoothQuat.slerp(_targetQuat, a);
        }

        previewGroup.visible = true;
        previewGroup.matrix.compose(_smoothPos, _smoothQuat, UNIT_SCALE);
        previewPivot.scale.setScalar(userScale);   // rotation now lives in the matrix
        setStatus('Drag to turn · pinch to size · tap to place');
      }

      /* A tap on a frame with no usable pose used to be lost silently. Retry
       * for a few frames before giving up. */
      if (placeRequested) {
        if (place(hits[0], referenceSpace)) {
          placeRequested = false;
          placeRetries = 0;
        } else if (++placeRetries > 10) {
          placeRequested = false;
          placeRetries = 0;
          setStatus('Could not place there — try again');
        }
      }

    } else {
      reticle.visible = false;
      previewSettled = false;
      if (previewGroup) previewGroup.visible = false;
      if (placeRequested) setStatus('No surface found — aim at the floor');
      else setStatus(modelTemplate ? 'Move your phone to find a surface' : 'Loading model…');
      placeRequested = false;
      placeRetries = 0;
    }
  } else {
    placeRequested = false;   // taps outside placing mode do nothing
  }

  // --- anchored models follow the runtime's corrections to its world map
  for (const record of placements) {
    if (!record.anchor) continue;

    /* An anchor can be dropped if tracking is lost. Hide rather than leave it
     * floating at a stale position. */
    if (frame.trackedAnchors && !frame.trackedAnchors.has(record.anchor)) {
      record.group.visible = false;
      continue;
    }

    const pose = frame.getPose(record.anchor.anchorSpace, referenceSpace);
    if (pose) {
      record.group.visible = true;
      /* Same treatment as placement: keep the anchor's position and surface
       * tilt, discard its yaw, reapply the yaw the user chose. An anchor's yaw
       * can shift as the runtime refines the plane, which would otherwise make
       * a placed model slowly rotate. */
      surfaceTransform(pose.transform.matrix, record.yaw, _targetPos, _targetQuat);
      record.group.matrix.compose(_targetPos, _targetQuat, UNIT_SCALE);
    }
  }

  renderer.render(scene, camera);

  // --- video: start on the first frame after the button was pressed
  if (pendingRecordStart && view && cameraAccess) {
    beginRecordingNow(view, xrViewport(view));
  }

  // --- video, if in-app recording is running
  if (recorder?.active && view && cameraAccess) {
    const viewport = xrViewport(view);
    try {
      recorder.frame(view, viewport);
    } catch (e) {
      reportError(e);
      stopRecording();
    }
  }

  // --- photo, after the normal render, still inside the valid frame
  if (captureRequested && view) {
    captureRequested = false;
    const viewport = xrViewport(view);

    try {
      capture(view, viewport);
    } catch (e) {
      console.error(e);
      setStatus('Photo failed — try a screenshot');
      $('photo').disabled = false;
    }
  }
} 