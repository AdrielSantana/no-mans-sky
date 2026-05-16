import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

import astronautModelUrl from "../assets/models/astronaut/astronaut.fbx?url";
import astronautTextureUrl from "../assets/models/astronaut/astronaut.png?url";
import fallingIdleUrl from "../assets/animations/locomotion_pack/falling_idle.fbx?url";
import fallingToLandUrl from "../assets/animations/locomotion_pack/falling_to_land.fbx?url";
import idleUrl from "../assets/animations/locomotion_pack/idle.fbx?url";
import jumpingUrl from "../assets/animations/locomotion_pack/jumping.fbx?url";
import runningUrl from "../assets/animations/locomotion_pack/running.fbx?url";
import walkingUrl from "../assets/animations/locomotion_pack/walking.fbx?url";

type GroundActionName = "idle" | "walk" | "run";
type AvatarActionName = GroundActionName | "jump" | "fall" | "land";

export interface PlayerAvatarPose {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  sunPosition: THREE.Vector3;
  sunColor: THREE.Color;
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
const MODEL_FOOT_GROUND_OFFSET = -0.89;
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
      texture.anisotropy = 4;
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
    this.avatarMaterial = this.createAvatarMaterial(texture);

    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.frustumCulled = false;
      child.castShadow = true;
      child.receiveShadow = true;
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
        uPlanetUp: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <skinning_pars_vertex>
        #include <logdepthbuf_pars_vertex>

        uniform vec3 uSunDirection;
        uniform vec3 uSunColor;
        uniform vec3 uPlanetUp;

        varying vec2 vUv;
        varying vec3 vLight;

        void main() {
          vUv = uv;
          #include <skinbase_vertex>
          #include <beginnormal_vertex>
          #include <skinnormal_vertex>
          #include <begin_vertex>
          #include <skinning_vertex>

          vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
          vec3 worldNormal = normalize(mat3(modelMatrix) * objectNormal);
          vec3 upDir = normalize(uPlanetUp);
          vec3 sunDir = normalize(uSunDirection);

          float day = smoothstep(-0.18, 0.12, dot(upDir, sunDir));
          float direct = max(dot(worldNormal, sunDir), 0.0);
          float wrap = max(dot(worldNormal, sunDir) * 0.5 + 0.5, 0.0);
          float sky = 0.16 + 0.22 * max(dot(worldNormal, upDir) * 0.5 + 0.5, 0.0);
          float groundBounce = 0.10 * max(dot(worldNormal, -upDir) * 0.5 + 0.5, 0.0) * day;

          vec3 nightAmbient = vec3(0.120, 0.130, 0.155);
          vec3 dayAmbient = vec3(0.18, 0.19, 0.20);
          vec3 ambient = mix(nightAmbient, dayAmbient, day) * sky;
          vec3 sunlight = uSunColor * (direct * 1.12 + wrap * 0.22) * day;
          vec3 terrain = vec3(0.23, 0.25, 0.20) * groundBounce;
          vLight = max(ambient + sunlight + terrain, vec3(0.12));

          gl_Position = projectionMatrix * viewMatrix * worldPos;
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <logdepthbuf_pars_fragment>

        uniform sampler2D uMap;

        varying vec2 vUv;
        varying vec3 vLight;

        void main() {
          vec3 texel = texture2D(uMap, vUv).rgb;
          gl_FragColor = vec4(texel * vLight, 1.0);
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
    this.avatarMaterial.uniforms.uSunColor.value.copy(pose.sunColor);
    this.avatarMaterial.uniforms.uPlanetUp.value.copy(pose.up);
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
