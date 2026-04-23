import * as THREE from 'three'

const vertexShader = /* glsl */ `
varying vec3 vDirection;
void main() {
  vec4 worldPos = inverse(projectionMatrix * viewMatrix) * vec4(position.xy, 1.0, 1.0);
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

  // Base
  vec3 color = vec3(0.004, 0.002, 0.022);

  // Nebulosa - transicoes suaves com smoothstep
  float n1 = fbm(dir * 3.0 + vec3(10.0, 20.0, 30.0));
  color += vec3(0.01, 0.025, 0.09) * smoothstep(0.35, 0.6, n1);

  float n2 = fbm(dir * 4.0 + vec3(50.0, 60.0, 70.0));
  color += vec3(0.05, 0.008, 0.07) * smoothstep(0.4, 0.65, n2);

  float n3 = fbm(dir * 5.5 + vec3(90.0, 100.0, 110.0));
  color += vec3(0.003, 0.035, 0.05) * smoothstep(0.42, 0.62, n3);

  // Estrelas: grid fixo - quantiza a direcao em celulas estaveis
  float starScale = 200.0;
  vec3 gridId = floor(dir * starScale);
  vec3 gridFrac = fract(dir * starScale) - 0.5;
  float distToCenter = length(gridFrac);

  vec3 starHash = hash33(gridId);

  // Estrelas comuns - ponto suave
  if (starHash.x > 0.988 && distToCenter < 0.35) {
    float falloff = 1.0 - smoothstep(0.0, 0.35, distToCenter);
    float brightness = (0.3 + starHash.y * 0.5) * falloff;
    vec3 starColor = mix(vec3(0.8, 0.85, 1.0), vec3(1.0, 0.9, 0.7), starHash.z);
    color += starColor * brightness;
  }

  // Estrelas brilhantes raras - ponto mais definido
  vec3 rareHash = hash33(gridId + vec3(42.0));
  if (rareHash.x > 0.997 && distToCenter < 0.25) {
    float falloff = 1.0 - smoothstep(0.0, 0.25, distToCenter);
    color += vec3(0.5, 0.45, 0.55) * falloff;
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
    depthWrite: false,
    depthTest: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = -1000
  return mesh
}
