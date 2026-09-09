import * as THREE from "three";
import { EXPLORER_PALETTE_GLSL } from "./explorer-palette";
import { useMeshLocalBoneMatrices, LOCAL_SKINNING_VERTEX, LOCAL_SKIN_NORMAL_VERTEX } from "./local-skinning";
import { SUN_SHADOW_CASTER_LAYER } from "./render-layers";
import { planetSunlightFactor } from "./planet-sunlight";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

import astronautModelUrl from "../assets/models/astronaut/explorer.fbx?url";
// JPEG q92 rather than PNG: the source was a 6.56MB 2048x2048 PNG with
// colorType 2 (RGB, no alpha), and the shader reads only .rgb and writes
// alpha 1.0, so there was no packed channel to lose. Same resolution, so
// VRAM is unchanged -- this is 5.3x off the download.
import astronautTextureUrl from "../assets/models/astronaut/explorer.webp?url";
import fallingIdleUrl from "../assets/animations/locomotion_pack/falling_idle.fbx?url";
import fallingToLandUrl from "../assets/animations/locomotion_pack/falling_to_land.fbx?url";
import idleUrl from "../assets/animations/locomotion_pack/idle.fbx?url";
import jumpingUrl from "../assets/animations/locomotion_pack/jumping.fbx?url";
import runningUrl from "../assets/animations/locomotion_pack/running.fbx?url";
import walkingUrl from "../assets/animations/locomotion_pack/walking.fbx?url";

type GroundActionName = "idle" | "walk" | "run";
type AvatarActionName = GroundActionName | "jump" | "fall" | "land";

const DEFAULT_CLOUD_SHADOW_TEXTURE = new THREE.DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
  THREE.RGBAFormat
);
DEFAULT_CLOUD_SHADOW_TEXTURE.name = "default-player-cloud-shadow";
DEFAULT_CLOUD_SHADOW_TEXTURE.needsUpdate = true;

export interface PlayerAvatarPose {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  sunPosition: THREE.Vector3;
  sunColor: THREE.Color;
  atmosphereLightColor: THREE.Color;
  atmosphereInfluence: number;
  cloudMask: THREE.Texture | null;
  cloudMaskOffset: number;
  cloudHeight: number;
  cloudShadowStrength: number;
  cloudShadowInfluence: number;
  cloudLocalSurfaceDirection: THREE.Vector3;
  cloudLocalSunDirection: THREE.Vector3;
  /** Planet radius and the actor's distance from its centre, for the shadow test. */
  planetRadius: number;
  actorRadius: number;
  /** 1 at the ground, 0 outside the atmosphere. Widens the terminator. */
  atmosphereDepth: number;
  moveX: number;
  moveY: number;
  yawDelta: number;
  sprint: boolean;
  grounded: boolean;
  jumpStarted: boolean;
  speed: number;
  verticalSpeed: number;
}

const MODEL_HEIGHT_METERS = 1.78;
// Zero because prepareModel already drops the model's lowest point onto the
// group origin, and the group origin is the ground contact point. This was
// -0.89 for as long as the hips were pinned to the idle clip's value instead of
// to the model's bind pose: that pinning lifted the character by roughly half
// its height, and the offset was cancelling the lift rather than describing the
// rig. Kept as a named knob because a model whose feet are not its lowest point
// -- one wearing a long coat, say -- would need it again.
const MODEL_FOOT_GROUND_OFFSET = 0;
const CROSS_FADE_SECONDS = 0.32;
const AIR_TRANSITION_SECONDS = 0.22;
const LANDING_FADE_SECONDS = 0.16;
const FALL_START_VERTICAL_SPEED = 0.15;
const JUMP_SKIP_SECONDS = 0.3;
const ANIMATION_CLIP_FPS = 30;
const PROCEDURAL_BOB_HEIGHT = 0.035;
const ROOT_BONE_POSITION_TRACK = "mixamorigHips.position";

const ANIMATION_URLS: Record<AvatarActionName, string[]> = {
  idle: [idleUrl],
  walk: [walkingUrl],
  run: [runningUrl],
  jump: [jumpingUrl],
  fall: [fallingIdleUrl],
  land: [fallingToLandUrl],
};

function loadFbx(loader: FBXLoader, url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

/**
 * Rest position of the hips, read from the model's own bind pose and in the
 * model's own units.
 *
 * The locomotion clips are not allowed to drive the hips -- prepareAnimationClip
 * flattens that track to a constant -- so something has to supply the constant.
 * Taking it from the idle clip works only while every asset shares one unit.
 * The astronaut was authored in centimetres and normalised by a 0.01 scale, so
 * the clips' hips value of 102 was already in its units. The explorer is
 * authored in metres and normalised by 0.94, and that same 102 lifted the hips
 * 95.9 m: the avatar rendered high above the player, out of frame, and the
 * model looked like it had simply failed to load.
 */
function findRootBoneRestPosition(model: THREE.Object3D): THREE.Vector3 | null {
  const hips: THREE.Bone[] = [];
  model.traverse((child) => {
    if (child instanceof THREE.Bone && child.name.endsWith("Hips")) {
      hips.push(child);
    }
  });
  return hips.length > 0 ? hips[0].position.clone() : null;
}

function isRootBonePositionTrack(trackName: string): boolean {
  return (
    trackName === ROOT_BONE_POSITION_TRACK || trackName.endsWith("Hips.position")
  );
}

function chooseAction(
  pose: PlayerAvatarPose
): { name: GroundActionName; timeScale: number } {
  const absMoveX = Math.abs(pose.moveX);
  const absMoveY = Math.abs(pose.moveY);
  if (absMoveX < 0.1 && absMoveY < 0.1 && pose.speed < 0.2) {
    return { name: "idle", timeScale: 1 };
  }

  if (pose.sprint) {
    return { name: "run", timeScale: 1 };
  }

  return { name: "walk", timeScale: 0.95 };
}

export class PlayerAvatar {
  readonly group = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private model: THREE.Group | null = null;
  private texture: THREE.Texture | null = null;
  private avatarMaterial: THREE.ShaderMaterial | null = null;
  private actions = new Map<AvatarActionName, THREE.AnimationAction>();
  private currentAction: THREE.AnimationAction | null = null;
  private disposed = false;
  private loaded = false;
  private wantedVisible = false;
  private hasSkeletalAnimation = false;
  private modelBaseY = 0;
  private rootBoneRestPosition: THREE.Vector3 | null = null;
  private proceduralPhase = 0;
  private wasGrounded = true;
  private landingActive = false;

  constructor(scene: THREE.Scene) {
    this.group.name = "PlayerAvatar";
    this.group.visible = false;
    scene.add(this.group);
    void this.load();
  }

  setVisible(visible: boolean) {
    this.wantedVisible = visible;
    this.group.visible = visible && this.loaded;
  }

  update(dt: number, pose: PlayerAvatarPose) {
    this.applyPose(pose);
    this.updateMaterialUniforms(pose);
    if (!this.loaded) return;

    const groundAction = chooseAction(pose);
    const justLanded = pose.grounded && !this.wasGrounded;
    this.wasGrounded = pose.grounded;

    if (!pose.grounded) {
      this.landingActive = false;
      this.playAirborneAction(pose);
    } else if (justLanded && this.actions.has("land")) {
      this.landingActive = true;
      this.play("land", 1, LANDING_FADE_SECONDS);
    } else if (this.landingActive) {
      this.advanceLandingAction(groundAction);
    } else {
      this.play(groundAction.name, groundAction.timeScale);
    }

    this.mixer?.update(dt);

    if (!pose.grounded) {
      this.advanceAirborneAction(pose);
    } else if (this.landingActive) {
      this.advanceLandingAction(groundAction);
    }

    if (!this.hasSkeletalAnimation) {
      this.updateProceduralFallback(dt, pose);
    }
  }

  dispose() {
    this.disposed = true;
    this.group.parent?.remove(this.group);
    this.mixer?.stopAllAction();
    this.actions.clear();
    this.texture?.dispose();
    this.avatarMaterial?.dispose();
    this.model?.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      if (child instanceof THREE.SkinnedMesh) child.skeleton.dispose();
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const material of materials) {
        if (material !== this.avatarMaterial) material.dispose();
      }
    });
  }

  private async load() {
    const loader = new FBXLoader();
    const textureLoader = new THREE.TextureLoader();

    try {
      const [model, texture, animationGroups] = await Promise.all([
        loadFbx(loader, astronautModelUrl),
        textureLoader.loadAsync(astronautTextureUrl),
        Promise.all(
          Object.values(ANIMATION_URLS)
            .flat()
            .map((url) => loadFbx(loader, url))
        ),
      ]);
      if (this.disposed) return;

      this.texture = texture;
      texture.colorSpace = THREE.SRGBColorSpace;
      // Matches the terrain (16) and props. WebGLTextures clamps to the
      // hardware maximum, so this is safe to request unconditionally.
      texture.anisotropy = 16;
      texture.needsUpdate = true;

      this.model = model;
      this.prepareModel(model, texture);
      this.group.add(model);

      this.mixer = new THREE.AnimationMixer(model);
      let animationIndex = 0;
      const canUseSkeletalAnimations = this.hasSkinnedMesh(model);
      this.hasSkeletalAnimation = canUseSkeletalAnimations;
      for (const [name, urls] of Object.entries(ANIMATION_URLS) as Array<
        [AvatarActionName, string[]]
      >) {
        for (let i = 0; i < urls.length; i++) {
          const clip = animationGroups[animationIndex]?.animations[0];
          animationIndex++;
          if (!clip || !canUseSkeletalAnimations) continue;
          if (this.actions.has(name)) continue;

          const animationClip = this.prepareAnimationClip(clip, name);
          const action = this.mixer.clipAction(animationClip);
          action.enabled = true;
          action.setEffectiveWeight(1);
          if (name === "jump" || name === "land") {
            action.loop = THREE.LoopOnce;
            action.clampWhenFinished = true;
          } else {
            action.loop = THREE.LoopRepeat;
            action.clampWhenFinished = false;
          }
          this.actions.set(name, action);
        }
      }

      this.loaded = true;
      this.group.visible = this.wantedVisible;
      this.play("idle", 1);
      if (!canUseSkeletalAnimations && import.meta.env.DEV) {
        console.warn(
          "Player avatar model has no SkinnedMesh/skeleton; locomotion FBX clips cannot deform it."
        );
      }
    } catch (error) {
      console.warn("Failed to load player avatar assets", error);
    }
  }

  private prepareModel(model: THREE.Group, texture: THREE.Texture) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = size.y > 1e-5 ? MODEL_HEIGHT_METERS / size.y : 0.01;
    model.scale.setScalar(scale);

    const scaledBox = new THREE.Box3().setFromObject(model);
    model.position.y -= scaledBox.min.y;
    model.position.y += MODEL_FOOT_GROUND_OFFSET;
    this.modelBaseY = model.position.y;
    // Before any clip is prepared, so the clips inherit the model's units
    // instead of imposing their own.
    this.rootBoneRestPosition = findRootBoneRestPosition(model);
    this.avatarMaterial = this.createAvatarMaterial(texture);

    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.frustumCulled = false;
      if (child instanceof THREE.SkinnedMesh) useMeshLocalBoneMatrices(child);
      // castShadow/receiveShadow are three's own shadow system, which this
      // project does not use -- the sun shadow is a hand-rolled pass keyed on
      // a layer. Left set because they cost nothing and document the intent.
      child.castShadow = true;
      child.receiveShadow = true;
      child.layers.enable(SUN_SHADOW_CASTER_LAYER);
      const previous = Array.isArray(child.material)
        ? child.material
        : [child.material];
      child.material = this.avatarMaterial as THREE.ShaderMaterial;
      for (const material of previous) material.dispose();
    });
  }

  private createAvatarMaterial(texture: THREE.Texture): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xfff2c8) },
        uAtmosphereLightColor: { value: new THREE.Color(0xc4d5df) },
        uAtmosphereInfluence: { value: 1 },
        uSunlightFactor: { value: 1 },
        uPlanetUp: { value: new THREE.Vector3(0, 1, 0) },
        uCloudMask: { value: DEFAULT_CLOUD_SHADOW_TEXTURE },
        uCloudMaskOffset: { value: 0 },
        uCloudHeight: { value: 0.045 },
        uCloudShadowStrength: { value: 0 },
        uCloudShadowInfluence: { value: 0 },
        uCloudLocalSurfaceDirection: { value: new THREE.Vector3(0, 1, 0) },
        uCloudLocalSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <skinning_pars_vertex>
        #include <logdepthbuf_pars_vertex>

        uniform vec3 uSunDirection;
        uniform vec3 uSunColor;
        uniform vec3 uAtmosphereLightColor;
        uniform float uAtmosphereInfluence;
        uniform float uSunlightFactor;
        uniform vec3 uPlanetUp;

        varying vec2 vUv;
        varying vec3 vLight;

        void main() {
          vUv = uv;
          #include <skinbase_vertex>
          #include <beginnormal_vertex>
          ${LOCAL_SKIN_NORMAL_VERTEX}
          #include <begin_vertex>
          ${LOCAL_SKINNING_VERTEX}

          vec3 worldNormal = normalize(mat3(modelMatrix) * objectNormal);
          vec3 upDir = normalize(uPlanetUp);
          vec3 sunDir = normalize(uSunDirection);

          float upSun = dot(upDir, sunDir);
          float atmosphereInfluence = clamp(uAtmosphereInfluence, 0.0, 1.0);
          // The planet's own shadow, resolved on the CPU where it can account
          // for altitude -- see planetSunlightFactor. upSun is still used below
          // for the atmospheric terms (sunset tint, terminator glow), which are
          // gated by uAtmosphereInfluence and so vanish on their own in space.
          float day = uSunlightFactor;
          float direct = max(dot(worldNormal, sunDir), 0.0);
          float wrap = max(dot(worldNormal, sunDir) * 0.5 + 0.5, 0.0);
          float sky = 0.16 + 0.22 * max(dot(worldNormal, upDir) * 0.5 + 0.5, 0.0);
          float groundBounce = 0.10 * max(dot(worldNormal, -upDir) * 0.5 + 0.5, 0.0) * day;
          float lowSun = pow(1.0 - clamp(upSun * 0.92 + 0.08, 0.0, 1.0), 1.8)
            * smoothstep(-0.24, 0.50, upSun);
          float terminator = smoothstep(-0.34, 0.18, upSun) * (1.0 - smoothstep(0.22, 0.72, upSun));

          vec3 nightAmbient = vec3(0.018, 0.024, 0.038);
          vec3 dayAmbient = vec3(0.18, 0.19, 0.20);
          vec3 ambientTint = mix(vec3(1.0), uAtmosphereLightColor, atmosphereInfluence * (day * 0.20 + terminator * 0.08));
          vec3 ambient = mix(nightAmbient, dayAmbient, day) * sky * ambientTint;
          vec3 sunsetTint = mix(vec3(1.0, 0.34, 0.10), uSunColor, 0.36);
          sunsetTint = mix(sunsetTint, uAtmosphereLightColor, 0.18);
          vec3 atmosphericSunTint = mix(vec3(1.0), uAtmosphereLightColor, 0.70);
          atmosphericSunTint = mix(atmosphericSunTint, sunsetTint, lowSun * 0.59);
          vec3 sunTint = mix(uSunColor, atmosphericSunTint, atmosphereInfluence);
          vec3 sunlight = sunTint * (direct * 1.0 + wrap * 0.15) * day;
          vec3 terrain = vec3(0.23, 0.25, 0.20) * groundBounce;
          vec3 minimumLight = mix(vec3(0.010, 0.014, 0.022), vec3(0.035), day);
          vLight = max(ambient + sunlight + terrain, minimumLight);

          // Compose the camera-relative transform on the CPU before float32 skinning.
          gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <logdepthbuf_pars_fragment>

        uniform sampler2D uMap;
        uniform sampler2D uCloudMask;
        uniform float uCloudMaskOffset;
        uniform float uCloudHeight;
        uniform float uCloudShadowStrength;
        uniform float uCloudShadowInfluence;
        uniform vec3 uCloudLocalSurfaceDirection;
        uniform vec3 uCloudLocalSunDirection;

        varying vec2 vUv;
        varying vec3 vLight;

        ${EXPLORER_PALETTE_GLSL}

        vec2 cloudMaskUv(vec3 dir) {
          vec3 n = normalize(dir);
          float lon = atan(n.x, n.z);
          float lat = asin(clamp(n.y, -1.0, 1.0));
          return vec2(
            fract(lon / 6.28318530718 + 0.5 + uCloudMaskOffset),
            clamp(0.5 - lat / 3.14159265359, 0.0, 1.0)
          );
        }

        float playerCloudShadowMask() {
          if (uCloudShadowStrength <= 0.001 || uCloudShadowInfluence <= 0.001) return 0.0;
          vec3 surfaceDir = normalize(uCloudLocalSurfaceDirection);
          vec3 sunDir = normalize(uCloudLocalSunDirection);
          float daylight = smoothstep(-0.08, 0.62, dot(surfaceDir, sunDir));
          float offset = clamp(uCloudHeight, 0.0, 0.20) * 2.8 + 0.018;
          vec3 projectedDir = normalize(surfaceDir + sunDir * offset);
          float macroMask = texture2D(uCloudMask, cloudMaskUv(projectedDir)).r;
          float shadow = pow(smoothstep(0.05, 0.96, macroMask), 0.58);
          float strength = clamp(uCloudShadowStrength * 0.42, 0.0, 2.2);
          return shadow * daylight * strength * clamp(uCloudShadowInfluence, 0.0, 1.0);
        }

        void main() {
          vec3 texel = texture2D(uMap, vUv).rgb;
          vec3 color = explorerPalette(texel, 0.55) * vLight;
          float cloudShadow = playerCloudShadowMask();
          vec3 coolShadow = color * vec3(0.11, 0.14, 0.19);
          color = mix(color, coolShadow, clamp(cloudShadow, 0.0, 0.96));
          gl_FragColor = vec4(color, 1.0);
          #include <logdepthbuf_fragment>
        }
      `,
    });
  }

  private applyPose(pose: PlayerAvatarPose) {
    this.group.position.copy(pose.position);

    const up = pose.up.clone().normalize();
    const forward = pose.forward.clone().normalize();
    const right = new THREE.Vector3().crossVectors(up, forward).normalize();
    const orthogonalForward = new THREE.Vector3()
      .crossVectors(right, up)
      .normalize();
    const matrix = new THREE.Matrix4().makeBasis(right, up, orthogonalForward);
    this.group.quaternion.setFromRotationMatrix(matrix);
  }

  private play(
    name: AvatarActionName,
    timeScale: number,
    fadeSeconds = CROSS_FADE_SECONDS
  ): boolean {
    const action = this.actions.get(name);
    if (!action) return false;

    action.timeScale = timeScale;
    if (action === this.currentAction) return true;

    const previous = this.currentAction;
    this.currentAction = action;
    action.reset().setEffectiveWeight(1).fadeIn(fadeSeconds).play();
    previous?.fadeOut(fadeSeconds);
    return true;
  }

  private playAirborneAction(pose: PlayerAvatarPose) {
    const jump = this.actions.get("jump");
    const fall = this.actions.get("fall");

    if (pose.jumpStarted && jump) {
      this.play("jump", 1, AIR_TRANSITION_SECONDS);
      return;
    }

    if (this.currentAction !== jump && fall) {
      this.play("fall", 1, AIR_TRANSITION_SECONDS);
    }
  }

  private advanceAirborneAction(pose: PlayerAvatarPose) {
    const jump = this.actions.get("jump");
    if (!jump || this.currentAction !== jump) return;

    const jumpFinished = jump.time >= jump.getClip().duration - 1 / 60;
    const startedFalling = pose.verticalSpeed <= FALL_START_VERTICAL_SPEED;
    if (jumpFinished || startedFalling) {
      this.play("fall", 1, AIR_TRANSITION_SECONDS);
    }
  }

  private advanceLandingAction(groundAction: {
    name: GroundActionName;
    timeScale: number;
  }) {
    const land = this.actions.get("land");
    if (!land || this.currentAction !== land) {
      this.landingActive = false;
      this.play(groundAction.name, groundAction.timeScale);
      return;
    }

    if (land.time < land.getClip().duration - 1 / 60) return;

    this.landingActive = false;
    this.play(groundAction.name, groundAction.timeScale, LANDING_FADE_SECONDS);
  }

  private hasSkinnedMesh(model: THREE.Object3D): boolean {
    let found = false;
    model.traverse((child) => {
      if (child instanceof THREE.SkinnedMesh) found = true;
    });
    return found;
  }

  private updateMaterialUniforms(pose: PlayerAvatarPose) {
    if (!this.avatarMaterial) return;
    const sunDirection = pose.sunPosition.clone().sub(pose.position);
    if (sunDirection.lengthSq() < 1e-6) {
      sunDirection.copy(pose.up);
    } else {
      sunDirection.normalize();
    }
    this.avatarMaterial.uniforms.uSunDirection.value.copy(sunDirection);
    this.avatarMaterial.uniforms.uSunlightFactor.value = planetSunlightFactor(
      pose.up.dot(sunDirection),
      pose.planetRadius,
      pose.actorRadius,
      pose.atmosphereDepth,
    );
    this.avatarMaterial.uniforms.uSunColor.value.copy(pose.sunColor);
    this.avatarMaterial.uniforms.uAtmosphereLightColor.value.copy(
      pose.atmosphereLightColor
    );
    this.avatarMaterial.uniforms.uAtmosphereInfluence.value =
      pose.atmosphereInfluence;
    this.avatarMaterial.uniforms.uPlanetUp.value.copy(pose.up);
    if (pose.cloudMask) {
      this.avatarMaterial.uniforms.uCloudMask.value = pose.cloudMask;
    }
    this.avatarMaterial.uniforms.uCloudMaskOffset.value = pose.cloudMaskOffset;
    this.avatarMaterial.uniforms.uCloudHeight.value = pose.cloudHeight;
    this.avatarMaterial.uniforms.uCloudShadowStrength.value =
      pose.cloudShadowStrength;
    this.avatarMaterial.uniforms.uCloudShadowInfluence.value =
      pose.cloudShadowInfluence;
    this.avatarMaterial.uniforms.uCloudLocalSurfaceDirection.value.copy(
      pose.cloudLocalSurfaceDirection
    );
    this.avatarMaterial.uniforms.uCloudLocalSunDirection.value.copy(
      pose.cloudLocalSunDirection
    );
  }

  private updateProceduralFallback(dt: number, pose: PlayerAvatarPose) {
    if (!this.model) return;

    const movement = THREE.MathUtils.clamp(
      pose.speed / (pose.sprint ? 8.5 : 5.2),
      0,
      1
    );
    if (movement > 0.05 && pose.grounded) {
      this.proceduralPhase += dt * (pose.sprint ? 11.0 : 7.2);
    }
    const stride = Math.sin(this.proceduralPhase);
    const bob = pose.grounded
      ? Math.abs(stride) * PROCEDURAL_BOB_HEIGHT * movement
      : 0.02;
    this.model.position.y = this.modelBaseY + bob;
    this.model.rotation.x = pose.grounded
      ? Math.sin(this.proceduralPhase * 0.5) * 0.035 * movement
      : -0.1;
    this.model.rotation.z =
      -pose.moveX * 0.08 + Math.sin(this.proceduralPhase) * 0.018 * movement;
  }

  private prepareAnimationClip(
    clip: THREE.AnimationClip,
    name: AvatarActionName
  ): THREE.AnimationClip {
    const sourceClip =
      name === "jump" && clip.duration > JUMP_SKIP_SECONDS
        ? THREE.AnimationUtils.subclip(
            clip,
            name,
            Math.round(JUMP_SKIP_SECONDS * ANIMATION_CLIP_FPS),
            Math.floor(clip.duration * ANIMATION_CLIP_FPS),
            ANIMATION_CLIP_FPS
          )
        : clip;

    const tracks = sourceClip.tracks.map((track) => {
      if (!isRootBonePositionTrack(track.name)) return track.clone();

      const values = Array.from(track.values);
      const firstX = values[0] ?? 0;
      const firstY = values[1] ?? 0;
      const firstZ = values[2] ?? 0;
      // Only reached when the model has no hips bone to read; a rigged model
      // always sets this in prepareModel.
      if (!this.rootBoneRestPosition && name === "idle") {
        this.rootBoneRestPosition = new THREE.Vector3(firstX, firstY, firstZ);
      }
      const rootPosition =
        this.rootBoneRestPosition ?? new THREE.Vector3(firstX, firstY, firstZ);

      for (let i = 0; i < values.length; i += 3) {
        values[i] = rootPosition.x;
        values[i + 1] = rootPosition.y;
        values[i + 2] = rootPosition.z;
      }
      const sanitized = new THREE.VectorKeyframeTrack(
        track.name,
        Array.from(track.times),
        values
      );
      sanitized.setInterpolation(track.getInterpolation());
      return sanitized;
    });
    return new THREE.AnimationClip(
      name,
      sourceClip.duration,
      tracks
    ).optimize();
  }
}
