import * as THREE from 'three'

const vertexShader = /* glsl */ `
varying vec3 vDirection;
void main() {
  mat4 viewRot = viewMatrix;
  viewRot[3] = vec4(0.0, 0.0, 0.0, 1.0);
  vec4 worldPos = inverse(projectionMatrix * viewRot) * vec4(position.xy, 1.0, 1.0);
  vDirection = normalize(worldPos.xyz / worldPos.w);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

const fragmentShader = /* glsl */ `
varying vec3 vDirection;

vec3 hash33(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float a = hash33(i).x;
  float b = hash33(i + vec3(1,0,0)).x;
  float c = hash33(i + vec3(0,1,0)).x;
  float d = hash33(i + vec3(1,1,0)).x;
  float e = hash33(i + vec3(0,0,1)).x;
  float f1 = hash33(i + vec3(1,0,1)).x;
  float g = hash33(i + vec3(0,1,1)).x;
  float h = hash33(i + vec3(1,1,1)).x;

  return mix(
    mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
    mix(mix(e, f1, f.x), mix(g, h, f.x), f.y),
    f.z
  );
}

float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise3(p);
    p = p * 2.0 + 100.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 dir = normalize(vDirection);

  // Base - preto total
  vec3 color = vec3(0.0);

  // Nebulosa - vestígio mínimo
  float n1 = fbm(dir * 3.0 + vec3(10.0, 20.0, 30.0));
  color += vec3(0.0005, 0.001, 0.005) * smoothstep(0.35, 0.6, n1);

  float n2 = fbm(dir * 4.0 + vec3(50.0, 60.0, 70.0));
  color += vec3(0.002, 0.0005, 0.003) * smoothstep(0.4, 0.65, n2);

  // Estrelas: grid fixo - quantiza a direcao em celulas estaveis
  float starScale = 500.0;
  vec3 gridId = floor(dir * starScale);
  vec3 gridFrac = fract(dir * starScale) - 0.5;
  float distToCenter = length(gridFrac);

  vec3 starHash = hash33(gridId);

  // Estrelas comuns
  if (starHash.x > 0.988 && distToCenter < 0.35) {
    float falloff = 1.0 - smoothstep(0.0, 0.35, distToCenter);
    float brightness = (0.7 + starHash.y * 0.3) * falloff;
    vec3 starColor = mix(vec3(0.85, 0.9, 1.0), vec3(1.0, 0.92, 0.75), starHash.z);
    color += starColor * brightness;
  }

  // Estrelas brilhantes raras
  vec3 rareHash = hash33(gridId + vec3(42.0));
  if (rareHash.x > 0.997 && distToCenter < 0.25) {
    float falloff = 1.0 - smoothstep(0.0, 0.25, distToCenter);
    color += vec3(1.0, 0.95, 1.0) * falloff;
  }

  gl_FragColor = vec4(color, 1.0);
}
`

export function createSkybox(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(2, 2)
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    // depthWrite stays false: CloudCompositePass reads the scene depth texture
    // as tSceneDepth and needs sky pixels to read the cleared 1.0.
    depthWrite: false,
    // depthTest + a late renderOrder let early-Z reject the sky wherever
    // terrain already drew. The shader is ~2500 ALU per pixel (two 5-octave
    // fbm, 8 hash33 each) and its output is entirely view-direction dependent,
    // so every covered pixel it used to shade was thrown away. The vertex
    // shader emits z = w, i.e. the far plane, so the LEQUAL test passes
    // exactly where the depth buffer is still cleared.
    depthTest: true,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 1000
  return mesh
}
