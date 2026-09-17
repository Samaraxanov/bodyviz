import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, LayoutChangeEvent, PanResponder, StyleSheet, Text, View } from 'react-native';
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
  frame: number;
  /** Frames still to be force-flushed; see the note in the render loop. */
  prime: number;
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
/** Yaw per pixel of horizontal drag: ~360 degrees per 340 px, close to grabbing it. */
const YAW_PER_PX = 0.0185;
const PITCH_PER_PX = 0.006;
/** Share of the release speed that carries into the coast. */
const FLING = 0.85;
/** Ceiling on the coast, in rad/s -- about one turn a second. */
const MAX_FLING = 6.5;

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
  g.computeBoundingSphere();
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
  g.computeBoundingSphere();
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
      antialias: true,
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

  /* DEBUG-HUD START */
  const dbg = useRef({ frames: 0, grants: 0, moves: 0, raw: 0, touches: 'n/a', err: '' });
  const [hud, setHud] = React.useState('');
  useEffect(() => {
    const id = setInterval(() => {
      const d = dbg.current;
      setHud(
        `f=${d.frames} raw=${d.raw} grant=${d.grants} move=${d.moves} t=${d.touches}\n` +
          `yaw=${orbit.current.yaw.toFixed(2)} dist=${orbit.current.distance.toFixed(2)} ` +
          `drag=${orbit.current.dragging ? 1 : 0}` +
          (d.err ? `\nERR ${d.err}` : ''),
      );
    }, 400);
    return () => clearInterval(id);
  }, []);
  /* DEBUG-HUD END */

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
    s.ring.scale.setScalar(H / 1.75);

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
      },
      toggleAutoRotate: () => {
        orbit.current.autoRotate = !orbit.current.autoRotate;
        orbit.current.velocity = 0;
        return orbit.current.autoRotate;
      },
    });
  }, [onReady]);

  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      // expo-gl only wires up its default framebuffer once a frame has been
      // ended. Without this priming frame three renders happily -- correct draw
      // calls, no GL errors -- into a surface that is never presented.
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.endFrameEXP();

      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;

      const renderer = createRenderer(gl);
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
      scene.add(ring);

      stage.current = {
        renderer, scene, camera, body: bodyMesh, shadow, ring, gl,
        frame: 0,
        prime: PRIME_FRAMES,
      };
      applyBody(bodyRef.current);

      let last = Date.now();
      const tick = () => {
        const s = stage.current;
        if (!s) return;
        s.frame = requestAnimationFrame(tick);

        const now = Date.now();
        const step = Math.min((now - last) / 1000, 1 / 20);
        last = now;

        const o = orbit.current;
        if (!o.dragging) {
          o.yaw += o.velocity * step;
          o.velocity *= Math.pow(DAMPING, step);
          if (Math.abs(o.velocity) < 0.001) o.velocity = 0;
          if (o.autoRotate) o.yaw += 0.55 * step;
        }
        const target = o.fitDistance * o.zoom;
        o.distance += (target - o.distance) * Math.min(1, step * 10);

        const focusY = bodyRef.current.metrics.height * 0.52;
        const cp = Math.cos(o.pitch);
        s.camera.position.set(
          Math.sin(o.yaw) * cp * o.distance,
          focusY + Math.sin(o.pitch) * o.distance,
          Math.cos(o.yaw) * cp * o.distance,
        );
        s.camera.lookAt(0, focusY, 0);

        dbg.current.frames++;
        s.renderer.render(s.scene, s.camera);

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
  };

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
          dbg.current.grants++;
          const s = orbit.current;
          s.dragging = true;
          s.autoRotate = false;
          s.velocity = 0;
          lastDx.current = 0;
          lastDy.current = 0;
          pinchDist.current = 0;
          yawRate.current = 0;
          lastMoveAt.current = Date.now();
        },
        onPanResponderMove: (evt, gesture) => {
          dbg.current.moves++;
          const s = orbit.current;
          const touches = evt.nativeEvent.touches;
          dbg.current.touches = touches === undefined ? 'undef' : String(touches.length);

          if (touches.length >= 2) {
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
        },
        onPanResponderTerminate: () => {
          orbit.current.dragging = false;
          orbit.current.velocity = 0;
          pinchDist.current = 0;
          yawRate.current = 0;
        },
      }),
    [],
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
      onTouchStart={() => {
        dbg.current.raw++;
      }}
    >
      <GLView style={styles.canvas} onContextCreate={onContextCreate} />
      <View style={styles.touch} collapsable={false} {...responder.panHandlers} />
      <Text style={styles.hud} pointerEvents="none">{hud}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bgSunken },
  canvas: { flex: 1 },
  touch: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  hud: { position: 'absolute', top: 6, left: 8, color: '#6EE7B7', fontSize: 11, fontVariant: ['tabular-nums'] },
});
