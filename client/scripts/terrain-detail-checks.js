import * as THREE from 'three'

// Actual near-terrain shader, frozen relief/light, same camera-relative patch.
export function checkTerrainDetailTranslation() {
  const e=window.__nmsDebug.engine,p=window.__nmsDebug.system.planetRenderers.get('2')
  const material=p.material.clone(),geometry=new THREE.PlaneGeometry(4,4,16,16)
  geometry.rotateX(-Math.PI/2);geometry.translate(0,25000,0)
  const count=geometry.attributes.position.count
  for(const [name,value]of Object.entries({terrainHeight:.1,terrainMicroAo:1,terrainMacroAo:1,terrainGrassPatch:0}))geometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(count).fill(value),1))
  if(material.uniforms.uShadowParams)material.uniforms.uShadowParams.value.x=0
  if(material.uniforms.uCloudShadowStrength)material.uniforms.uCloudShadowStrength.value=0
  const scene=new THREE.Scene(),mesh=new THREE.Mesh(geometry,material),camera=new THREE.PerspectiveCamera(50,1,.05,100)
  scene.add(mesh);camera.up.set(0,0,-1)
  const target=new THREE.WebGLRenderTarget(256,256),previous=e.renderer.getRenderTarget(),buffers=[]
  try{
    for(const offset of [0,.009]){
      mesh.position.set(360000+offset,15000+offset,60000+offset)
      const centre=mesh.position.clone().add(new THREE.Vector3(0,25000,0))
      camera.position.copy(centre).add(new THREE.Vector3(0,3,0));camera.lookAt(centre)
      material.uniforms.uSunPosition.value.copy(centre).add(new THREE.Vector3(20000,50000,30000))
      e.renderer.setRenderTarget(target);e.renderer.render(scene,camera)
      const pixels=new Uint8Array(256*256*4);e.renderer.readRenderTargetPixels(target,0,0,256,256,pixels);buffers.push(pixels)
    }
    let changed=0,error=0
    for(let i=0;i<buffers[0].length;i+=4){let delta=0;for(let c=0;c<3;c++)delta+=Math.abs(buffers[0][i+c]-buffers[1][i+c]);if(delta>6)changed++;error+=delta}
    const result={changedPixels:changed,meanChannelError:error/(256*256*3)}
    if(changed>10||result.meanChannelError>0.02)throw new Error(`Terrain microrelief is not translation-stable: ${JSON.stringify(result)}`)
    return result
  }finally{e.renderer.setRenderTarget(previous);geometry.dispose();material.dispose();target.dispose()}
}
