import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  LayoutChangeEvent,
  PanResponder,
  PixelRatio,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ExpoWebGLRenderingContext, GLView } from 'expo-gl';
import * as THREE from 'three';

import { BodyResult } from '../body/buildBody';
import { theme } from '../theme';

/**
 * three.js is driven directly against expo-gl rather than through
 * @react-three/fiber: its native canvas renders nothing on current Expo SDKs,
 * while a plain GLView context works fine. Doing it by hand is about a hundred
 * lines and removes the reconciler from the dependency tree entirely.
 */

interface OrbitState {
  yaw: number;
  pitch: number;
  /** Current (smoothed) camera distance. */
  distance: number;
  /** Distance that exactly frames the current stature. */
  fitDistance: number;
  /** Pinch multiplier on fitDistance, so zoom survives a model rebuild. */
  zoom: number;
  velocity: number;
  dragging: boolean;
  autoRotate: boolean;
}

interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  body: THREE.Mesh;
  shadow: THREE.Mesh;
  ring: THREE.Mesh;
  gl: ExpoWebGLRenderingContext;
  /** Off-screen buffer the lit scene is drawn into; see `renderSize`. */
  target: THREE.WebGLRenderTarget | null;
  /** Full-screen quad that copies `target` onto the real surface. */
  blitScene: THREE.Scene;
  blitCamera: THREE.OrthographicCamera;
  frame: number;
  /** Frames still to be force-flushed; see the note in the render loop. */
  prime: number;
  /**
   * Something changed that the last drawn frame does not show yet. The loop is
   * otherwise allowed to draw nothing at all -- see the note on `tick`.
   */
  dirty: boolean;
  /**
   * Which render loop owns this stage. A surface can be handed to us more than
   * once (backgrounding on iOS, a TextureView recreation on Android), and the
   * old loop keeps its own `requestAnimationFrame` chain alive -- so without a
   * generation check two loops end up drawing the same scene and every frame
   * costs twice what it should.
   */
  loop: number;
}

const MIN_PITCH = -0.35;
const MAX_PITCH = 0.85;
const HOME_YAW = 0.4;
const HOME_PITCH = 0.06;
/** Fraction of angular velocity surviving one second of coasting. */
const DAMPING = 0.02;
const FOV = 32;
/** How many frames to force-flush before trusting the surface. */
const PRIME_FRAMES = 6;
/**
 * Rotating was fill-rate bound, not geometry bound. GLView hands back a
 * drawing buffer at the full native scale -- ~1290x2790 on a 3x phone, 3.6M
 * pixels -- and every one of them was running a four-light PBR shader. The
 * figure is 36k triangles, which any phone GPU eats for breakfast; it was the
 * pixels that cost.
 *
 * So the lit scene is drawn into a smaller off-screen target and copied up.
 * The expensive shading runs at a fraction of the pixel count while the copy
 * -- one texture fetch per pixel -- runs at full resolution, so edges stay as
 * sharp as the panel allows. expo-gl exposes no pixel-ratio control (checked
 * against the v57 GLView docs), so the target is the only lever there is.
 *
 * 2x is the point past which a figure this size stops gaining visible detail.
 * The absolute budget catches tablets, where 2x of a large panel is still more
 * pixels than is worth shading.
 *
 * This doubles as the antialiasing control. expo-gl cannot multisample a render
 * target on most devices (see `makeBlit`), so on those the silhouette is
 * antialiased only by resolution and by the linear filter that scales the
 * target up to the panel. If edges against the dark background read as rough,
 * raise this -- 2.5 keeps most of the saving, 3 gives the old image back at the
 * old cost. It is the one number to turn.
 */
const MAX_RENDER_RATIO = 2;
const PIXEL_BUDGET = 1_600_000;
/** Yaw per pixel of horizontal drag: ~360 degrees per 340 px, close to grabbing it. */
const YAW_PER_PX = 0.0185;
const PITCH_PER_PX = 0.006;
/** Share of the release speed that carries into the coast. */
const FLING = 0.85;
/** Ceiling on the coast, in rad/s -- about one turn a second. */
const MAX_FLING = 6.5;

/**
 * Gesture readout, for working out why a drag does nothing. The previous
 * version of this drove a `setInterval` at 400ms, so it re-rendered the viewer
 * 2.5 times a second forever -- a hitch in the middle of every drag, and worse
 * than the problem it was diagnosing. This one only writes state when a
 * gesture starts and ends, so an idle viewer pays nothing.
 *
 * Reading it: `raw` counts touches that reached the overlay at all, `grant`
 * that the responder took the gesture, `move` that it is receiving movement.
 * raw 0 means the touch never arrives -- a hit-testing problem, not a gesture
 * one. grant with move 0 means the responder is being taken away again.
 */
const SHOW_GESTURE_DEBUG = __DEV__;

export interface BodyViewerHandle {
  resetView: () => void;
  toggleAutoRotate: () => boolean;
}

/** Radial alpha falloff, used as a fake contact shadow under the figure. */
function makeShadowTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x / (size - 1)) * 2 - 1;
      const dy = (y / (size - 1)) * 2 - 1;
      const d = Math.min(1, Math.hypot(dx, dy));
      const i = (y * size + x) * 4;
      data[i + 3] = Math.round(255 * Math.pow(1 - d, 2.2));
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

function geometryFor(body: BodyResult): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(body.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(body.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(body.colors, 3));
  g.setIndex(new THREE.BufferAttribute(body.indices, 1));
  return g;
}

/**
 * Rebuilding a body produces the same vertex count every time -- the ring
 * counts are fixed -- so a rebuild can overwrite the existing buffers instead
 * of allocating new ones and re-uploading the index. That is what keeps
 * dragging a slider smooth.
 */
function updateGeometry(g: THREE.BufferGeometry, body: BodyResult): boolean {
  const position = g.getAttribute('position') as THREE.BufferAttribute;
  const normal = g.getAttribute('normal') as THREE.BufferAttribute;
  const color = g.getAttribute('color') as THREE.BufferAttribute;
  if (
    !position ||
    position.array.length !== body.positions.length ||
    g.getIndex()?.array.length !== body.indices.length
  ) {
    return false;
  }
  (position.array as Float32Array).set(body.positions);
  (normal.array as Float32Array).set(body.normals);
  (color.array as Float32Array).set(body.colors);
  position.needsUpdate = true;
  normal.needsUpdate = true;
  color.needsUpdate = true;
  return true;
}

/**
 * expo-gl hands back a bare context, but three insists on something
 * canvas-shaped. These are the only members WebGLRenderer actually touches.
 */
function canvasShim(gl: ExpoWebGLRenderingContext) {
  return {
    width: gl.drawingBufferWidth,
    height: gl.drawingBufferHeight,
    clientWidth: gl.drawingBufferWidth,
    clientHeight: gl.drawingBufferHeight,
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getContext: () => gl,
  } as unknown as HTMLCanvasElement;
}

/**
 * Pixel dimensions to shade at, for a drawing buffer of `w` x `h`. See the note
 * on MAX_RENDER_RATIO. Never upscales: a 1x panel is already at the budget.
 */
function renderSize(w: number, h: number): { width: number; height: number } {
  const byRatio = MAX_RENDER_RATIO / Math.max(1, PixelRatio.get());
  const byBudget = Math.sqrt(PIXEL_BUDGET / Math.max(1, w * h));
  const scale = Math.min(1, byRatio, byBudget);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * The off-screen buffer and the quad that copies it to the screen.
 *
 * Half-float, not bytes: three skips tone mapping when the destination is a
 * render target, so what lands here is linear light that routinely goes above
 * 1.0 around the key light. In an 8-bit target those values would clamp before
 * ACES ever saw them and the highlights would flatten. The quad then draws to
 * the real surface, where tone mapping and the sRGB conversion do run -- so the
 * final image matches what a direct render produced, only shaded at fewer
 * pixels.
 */
function makeBlit(gl: ExpoWebGLRenderingContext, width: number, height: number) {
  // RGBA16F is not color-renderable in bare WebGL 2; it takes one of these
  // extensions. Without the check a driver that lacks them leaves the
  // framebuffer incomplete, which does not throw -- it just draws nothing, and
  // the viewer comes up black. Bytes clip the highlights a little early, which
  // is a far better failure than no picture.
  const floatTarget =
    !!gl.getExtension('EXT_color_buffer_float') ||
    !!gl.getExtension('EXT_color_buffer_half_float');

  const target = new THREE.WebGLRenderTarget(width, height, {
    type: floatTarget ? THREE.HalfFloatType : THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    // Asking for samples > 0 makes three allocate a multisampled renderbuffer,
    // and expo-gl does not implement `renderbufferStorageMultisample` -- it
    // throws outright from the first render. The one multisampling route it can
    // take is WEBGL_multisampled_render_to_texture, which three uses instead
    // when it is present, so probe for it rather than assume either way. Absent
    // it, the target carries no antialiasing and RENDER_RATIO is doing that job
    // (see the note there).
    samples: gl.getExtension('WEBGL_multisampled_render_to_texture') ? 2 : 0,
  });
  const blitScene = new THREE.Scene();
  const blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ map: target.texture, depthTest: false, depthWrite: false }),
  );
  quad.frustumCulled = false;
  blitScene.add(quad);
  return { target, blitScene, blitCamera };
}

/**
 * three r163+ refuses any context that is `instanceof WebGLRenderingContext`,
 * on the assumption that it must be WebGL 1. expo-gl hands back a WebGL 2
 * context whose class *subclasses* WebGLRenderingContext (browsers keep the two
 * interfaces separate), so the guard misfires. Hiding the global for the length
 * of the constructor call is enough to get past it.
 */
function createRenderer(gl: ExpoWebGLRenderingContext): THREE.WebGLRenderer {
  const canvas = canvasShim(gl);
  // three's state reset reads gl.canvas for the scissor/viewport defaults, and
  // expo-gl's context doesn't carry one.
  (gl as unknown as { canvas: HTMLCanvasElement }).canvas = canvas;

  const scope = globalThis as unknown as { WebGLRenderingContext?: unknown };
  const saved = scope.WebGLRenderingContext;
  scope.WebGLRenderingContext = undefined;
  try {
    return new THREE.WebGLRenderer({
      canvas,
      context: gl as unknown as WebGLRenderingContext,
      // No antialias on the default framebuffer: nothing is shaded there any
      // more, only a full-screen texture copy, and asking for MSAA on it would
      // allocate a multisampled buffer at native size for no benefit.
      antialias: false,
    });
  } finally {
    scope.WebGLRenderingContext = saved;
  }
}

export default function BodyViewer({
  body,
  onReady,
  onFirstFrame,
}: {
  body: BodyResult;
  onReady?: (handle: BodyViewerHandle) => void;
  /** Fires once the first frame is actually on screen, not merely submitted. */
  onFirstFrame?: () => void;
}) {
  const orbit = useRef<OrbitState>({
    yaw: HOME_YAW,
    pitch: HOME_PITCH,
    distance: 0,
    fitDistance: 0,
    zoom: 1,
    velocity: 0,
    dragging: false,
    autoRotate: false,
  });
  const stage = useRef<Stage | null>(null);
  /** Bumped per surface, so only the newest render loop survives. */
  const loopGen = useRef(0);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const lastDx = useRef(0);
  const lastDy = useRef(0);
  const pinchDist = useRef(0);
  /** Yaw speed in rad/s, smoothed across moves, so a flick can be handed to the coast. */
  const yawRate = useRef(0);
  const lastMoveAt = useRef(0);
  // Held in a ref so the render loop never closes over a stale callback.
  const onFirstFrameRef = useRef(onFirstFrame);
  onFirstFrameRef.current = onFirstFrame;
  const diag = useRef({ raw: 0, grant: 0, move: 0, noTouchList: 0 });
  const [diagText, setDiagText] = useState('');
  const reportDiag = useCallback(() => {
    if (!SHOW_GESTURE_DEBUG) return;
    const d = diag.current;
    const o = orbit.current;
    setDiagText(
      `raw ${d.raw}  grant ${d.grant}  move ${d.move}  noTouchList ${d.noTouchList}\n` +
        `yaw ${o.yaw.toFixed(2)}  drag ${o.dragging ? 1 : 0}`,
    );
  }, []);

  // Coming back from the background can hand us a fresh surface, so the
  // flush-priming has to happen again or the canvas returns black.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && stage.current) stage.current.prime = PRIME_FRAMES;
    });
    return () => sub.remove();
  }, []);

  /** Resize the floor decorations and re-frame the camera for a new stature. */
  const applyBody = useCallback((next: BodyResult) => {
    const s = stage.current;
    if (!s) return;
    const H = next.metrics.height;

    if (!updateGeometry(s.body.geometry, next)) {
      s.body.geometry.dispose();
      s.body.geometry = geometryFor(next);
    }

    s.shadow.scale.set(H * 0.7, H * 0.5, 1);
    s.shadow.updateMatrix();
    s.ring.scale.setScalar(H / 1.75);
    s.ring.updateMatrix();
    s.dirty = true;

    const vFov = (FOV * Math.PI) / 180;
    const fit = (H * 0.62) / Math.tan(vFov / 2);
    const first = orbit.current.fitDistance === 0;
    orbit.current.fitDistance = fit;
    if (first) orbit.current.distance = fit * orbit.current.zoom;
  }, []);

  useEffect(() => {
    applyBody(body);
  }, [body, applyBody]);

  useEffect(() => {
    onReady?.({
      resetView: () => {
        const s = orbit.current;
        s.yaw = HOME_YAW;
        s.pitch = HOME_PITCH;
        s.velocity = 0;
        s.zoom = 1;
        s.autoRotate = false;
        if (stage.current) stage.current.dirty = true;
      },
      toggleAutoRotate: () => {
        orbit.current.autoRotate = !orbit.current.autoRotate;
        orbit.current.velocity = 0;
        if (stage.current) stage.current.dirty = true;
        return orbit.current.autoRotate;
      },
    });
  }, [onReady]);

  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      const loopId = ++loopGen.current;

      // expo-gl only wires up its default framebuffer once a frame has been
      // ended. Without this priming frame three renders happily -- correct draw
      // calls, no GL errors -- into a surface that is never presented.
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.endFrameEXP();

      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;

      const renderer = createRenderer(gl);
      const shade = renderSize(width, height);
      const { target, blitScene, blitCamera } = makeBlit(gl, shade.width, shade.height);
      renderer.setSize(width, height, false);
      renderer.setClearColor(new THREE.Color(theme.bgSunken), 1);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.05, 60);

      // Three-point studio lighting: a warm key above and to the right, a cool
      // fill to knock the shadow side back in, and a rim behind to lift the
      // silhouette off the background.
      scene.add(new THREE.HemisphereLight(0xa8c0dd, 0x141a24, 0.85));
      const key = new THREE.DirectionalLight(0xfff2e2, 1.85);
      key.position.set(2.4, 3.6, 2.4);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x89aee8, 0.55);
      fill.position.set(-3.2, 1.2, 1.6);
      scene.add(fill);
      const rim = new THREE.DirectionalLight(0xd4e4ff, 1.15);
      rim.position.set(-0.6, 2.2, -3.4);
      scene.add(rim);

      const bodyMesh = new THREE.Mesh(
        geometryFor(bodyRef.current),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(theme.skin),
          roughness: 0.72,
          metalness: 0.02,
          // Baked occlusion rides in as vertex colour, which three multiplies
          // into the material colour.
          vertexColors: true,
        }),
      );
      // Always on screen (see geometryFor) and never transformed, so neither
      // the cull test nor the per-frame matrix refresh has anything to decide.
      bodyMesh.frustumCulled = false;
      bodyMesh.matrixAutoUpdate = false;
      bodyMesh.updateMatrix();
      scene.add(bodyMesh);

      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: makeShadowTexture(),
          transparent: true,
          depthWrite: false,
          opacity: 0.8,
        }),
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.002;
      shadow.matrixAutoUpdate = false;
      shadow.updateMatrix();
      scene.add(shadow);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.52, 96),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(theme.border),
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.001;
      ring.matrixAutoUpdate = false;
      ring.updateMatrix();
      scene.add(ring);

      stage.current = {
        renderer, scene, camera, body: bodyMesh, shadow, ring, gl,
        target, blitScene, blitCamera,
        frame: 0,
        prime: PRIME_FRAMES,
        dirty: true,
        loop: loopId,
      };
      applyBody(bodyRef.current);

      let last = Date.now();
      /**
       * The loop runs every frame but only *draws* on frames that would look
       * different from the one already on screen. A still figure is the common
       * case -- reading the numbers, mid-thought, anything that isn't an active
       * drag -- and drawing it again 60 times a second buys nothing while
       * keeping the JS thread busy. That matters here beyond battery: touches
       * are delivered on the JS thread too, so a render that is always running
       * is a render the next `onPanResponderMove` has to queue behind, which is
       * exactly what a laggy drag feels like.
       */
      const tick = () => {
        const s = stage.current;
        // A stale loop from a previous surface: let it die.
        if (!s || s.loop !== loopId) return;
        s.frame = requestAnimationFrame(tick);

        const now = Date.now();
        const step = Math.min((now - last) / 1000, 1 / 20);
        last = now;

        const o = orbit.current;
        let moving = o.dragging || o.autoRotate || o.velocity !== 0;
        if (!o.dragging) {
          o.yaw += o.velocity * step;
          o.velocity *= Math.pow(DAMPING, step);
          if (Math.abs(o.velocity) < 0.001) o.velocity = 0;
          if (o.autoRotate) o.yaw += 0.55 * step;
        }

        const target = o.fitDistance * o.zoom;
        const gap = target - o.distance;
        if (Math.abs(gap) > 1e-4 * Math.max(1e-6, target)) {
          o.distance += gap * Math.min(1, step * 10);
          moving = true;
        } else {
          o.distance = target;
        }

        if (!moving && !s.dirty && s.prime <= 0) return;
        s.dirty = false;

        const focusY = bodyRef.current.metrics.height * 0.52;
        const cp = Math.cos(o.pitch);
        s.camera.position.set(
          Math.sin(o.yaw) * cp * o.distance,
          focusY + Math.sin(o.pitch) * o.distance,
          Math.cos(o.yaw) * cp * o.distance,
        );
        s.camera.lookAt(0, focusY, 0);

        // Shade small, present large.
        //
        // Every GL call three makes here is WebGL 1 core, but expo-gl is a
        // partial implementation and this path already turned up one function
        // it does not have. A viewer that draws nothing is a far worse outcome
        // than one that draws at full resolution, so a gap costs the
        // optimisation and nothing else.
        if (s.target) {
          try {
            s.renderer.setRenderTarget(s.target);
            s.renderer.render(s.scene, s.camera);
            s.renderer.setRenderTarget(null);
            s.renderer.render(s.blitScene, s.blitCamera);
          } catch (err) {
            console.warn(
              'BodyViewer: rendering through a scaled target failed, falling back to ' +
                'full resolution. Rotation will cost more.',
              err,
            );
            s.renderer.setRenderTarget(null);
            s.target.dispose();
            s.target = null;
            s.renderer.render(s.scene, s.camera);
          }
        } else {
          s.renderer.render(s.scene, s.camera);
        }

        // Draining expo-gl's command queue is what actually gets a frame onto
        // the screen the first time -- but it blocks the JS thread on a
        // round-trip to the GL thread, which costs ~24ms a frame. Priming a
        // handful of frames is enough; after that the surface stays live and
        // the loop runs at 60fps.
        if (s.prime > 0) {
          gl.getError();
          s.prime--;
          if (s.prime === 0) onFirstFrameRef.current?.();
        }
        gl.endFrameEXP();
      };
      tick();
    },
    [applyBody],
  );

  useEffect(
    () => () => {
      const s = stage.current;
      if (!s) return;
      cancelAnimationFrame(s.frame);
      s.body.geometry.dispose();
      (s.body.material as THREE.Material).dispose();
      s.shadow.geometry.dispose();
      (s.shadow.material as THREE.MeshBasicMaterial).map?.dispose();
      (s.shadow.material as THREE.Material).dispose();
      s.ring.geometry.dispose();
      (s.ring.material as THREE.Material).dispose();
      s.blitScene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      });
      s.target?.dispose();
      s.renderer.dispose();
      stage.current = null;
    },
    [],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    const s = stage.current;
    if (!s) return;
    const { width, height } = e.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    s.camera.aspect = width / height;
    s.camera.updateProjectionMatrix();

    // A rotation or a split-screen resize gives the surface a new drawing
    // buffer; the renderer and the shading target both have to follow it, or
    // the scene keeps being drawn at the old size and arrives stretched.
    const bw = s.gl.drawingBufferWidth;
    const bh = s.gl.drawingBufferHeight;
    const current = s.renderer.getSize(new THREE.Vector2());
    if (current.x !== bw || current.y !== bh) {
      s.renderer.setSize(bw, bh, false);
      const shade = renderSize(bw, bh);
      s.target?.setSize(shade.width, shade.height);
    }
    s.dirty = true;
  };

  /**
   * Mark the stage for a redraw. Every gesture callback calls this rather than
   * relying on `orbit.dragging` to imply it: the loop only draws when
   * something says it should, and a handler that moves the camera without
   * saying so leaves the last frame on screen -- a viewer that silently
   * ignores the drag.
   */
  const invalidate = useCallback(() => {
    if (stage.current) stage.current.dirty = true;
  }, []);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // A 3D viewer owns its gestures outright: never hand one back to an
        // ancestor part-way through a drag, and don't let a native scroll
        // container underneath decide it wanted the touch after all.
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: () => {
          const s = orbit.current;
          s.dragging = true;
          s.autoRotate = false;
          s.velocity = 0;
          lastDx.current = 0;
          lastDy.current = 0;
          pinchDist.current = 0;
          yawRate.current = 0;
          lastMoveAt.current = Date.now();
          invalidate();
          diag.current.grant++;
          reportDiag();
        },
        onPanResponderMove: (evt, gesture) => {
          const s = orbit.current;
          invalidate();
          diag.current.move++;
          // Not every platform hands back a touch list on every move event,
          // and an unguarded `.length` here throws inside the handler -- which
          // surfaces as a drag that does nothing at all, silently.
          const touches = evt.nativeEvent.touches;
          if (!touches) diag.current.noTouchList++;

          if (touches && touches.length >= 2) {
            const d = Math.hypot(
              touches[0].pageX - touches[1].pageX,
              touches[0].pageY - touches[1].pageY,
            );
            if (pinchDist.current > 0 && d > 0) {
              s.zoom = Math.min(1.8, Math.max(0.42, s.zoom * (pinchDist.current / d)));
            }
            pinchDist.current = d;
            // Deltas are meaningless mid-pinch; re-baseline so the model
            // doesn't jump when the second finger lifts.
            lastDx.current = gesture.dx;
            lastDy.current = gesture.dy;
            yawRate.current = 0;
            return;
          }

          pinchDist.current = 0;
          const dx = gesture.dx - lastDx.current;
          const dy = gesture.dy - lastDy.current;
          lastDx.current = gesture.dx;
          lastDy.current = gesture.dy;

          s.yaw -= dx * YAW_PER_PX;
          s.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, s.pitch + dy * PITCH_PER_PX));

          // Fling speed has to come from pixels *per second*, not from the size
          // of one frame's delta: derived per frame it scales with the frame
          // rate, so the same flick coasts twice as far on a slow device as on
          // a fast one. Smoothed, because the last sample before a finger lifts
          // is usually a stray.
          const now = Date.now();
          const dt = Math.max(1, now - lastMoveAt.current) / 1000;
          lastMoveAt.current = now;
          const instant = -(dx * YAW_PER_PX) / dt;
          yawRate.current += (instant - yawRate.current) * 0.35;
        },
        onPanResponderRelease: () => {
          const s = orbit.current;
          s.dragging = false;
          pinchDist.current = 0;
          // A finger that stopped before lifting means "hold it here".
          const stale = Date.now() - lastMoveAt.current > 90;
          const coast = stale ? 0 : yawRate.current * FLING;
          s.velocity = Math.max(-MAX_FLING, Math.min(MAX_FLING, coast));
          yawRate.current = 0;
          invalidate();
          reportDiag();
        },
        onPanResponderTerminate: () => {
          orbit.current.dragging = false;
          orbit.current.velocity = 0;
          pinchDist.current = 0;
          yawRate.current = 0;
          invalidate();
        },
      }),
    [invalidate, reportDiag],
  );

  // The gesture lives on a plain transparent View laid over the canvas rather
  // than on the canvas's own container. GLView is a native surface (a GLKView
  // on iOS, a TextureView on Android); hanging the responder off an ancestor of
  // one means every touch has to travel back out of native hit-testing before
  // the responder negotiation sees it. An ordinary RN view on top is a touch
  // target the responder system owns end to end, so a drag can't go missing.
  return (
    <View
      style={styles.root}
      onLayout={onLayout}
      onTouchStart={
        SHOW_GESTURE_DEBUG
          ? () => {
              diag.current.raw++;
            }
          : undefined
      }
    >
      <GLView
        style={styles.canvas}
        // Nothing is shaded on this surface any more -- it receives one
        // full-screen textured quad, which has no interior edges to
        // antialias -- so MSAA here would allocate and resolve a multisampled
        // buffer at native resolution every frame for no visible gain.
        msaaSamples={0}
        onContextCreate={onContextCreate}
      />
      <View style={styles.touch} collapsable={false} {...responder.panHandlers} />
      {SHOW_GESTURE_DEBUG && diagText ? (
        <Text style={styles.diag} pointerEvents="none">
          {diagText}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bgSunken },
  canvas: { flex: 1 },
  touch: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  diag: {
    position: 'absolute',
    top: 6,
    left: 8,
    color: '#6EE7B7',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
});
