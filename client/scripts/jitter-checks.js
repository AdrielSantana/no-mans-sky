import * as THREE from 'three'

// A rigid translation of actor AND camera must not deform a frozen skinned mesh.
export function captureAvatarTranslationPair() {
  const {engine:e,system:s}=window.__nmsDebug
  const avatar=s.walkerController.avatar.group
  if(!s.walkerController.avatar.loaded) throw new Error('Avatar assets not ready')
  const parent=avatar.parent,position=avatar.position.clone(),rotation=avatar.quaternion.clone(),visible=avatar.visible
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1,.05,100)
  scene.background=new THREE.Color('#718e9e')
  const target=new THREE.WebGLRenderTarget(512,512),oldTarget=e.renderer.getRenderTarget()
  const images=[],buffers=[]
  try {
    scene.add(avatar);avatar.visible=true;avatar.quaternion.identity()
    for(const offset of [0,.031]) {
      avatar.position.set(360000+offset,15000+offset,60000+offset)
      camera.position.copy(avatar.position).add(new THREE.Vector3(0,1,3.5));camera.lookAt(avatar.position.clone().add(new THREE.Vector3(0,.9,0)))
      e.renderer.setRenderTarget(target);e.renderer.render(scene,camera)
      const pixels=new Uint8Array(512*512*4);e.renderer.readRenderTargetPixels(target,0,0,512,512,pixels);buffers.push(pixels)
      const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512
      const ctx=canvas.getContext('2d'),data=ctx.createImageData(512,512)
      for(let y=0;y<512;y++)data.data.set(pixels.subarray(y*2048,(y+1)*2048),(511-y)*2048)
      ctx.putImageData(data,0,0);images.push(canvas.toDataURL())
    }
    let changed=0,absoluteError=0
    for(let i=0;i<buffers[0].length;i+=4){let error=0;for(let c=0;c<3;c++)error+=Math.abs(buffers[0][i+c]-buffers[1][i+c]);if(error>6)changed++;absoluteError+=error}
    return {changedPixels:changed,meanChannelError:absoluteError/(512*512*3),images}
  } finally {
    if(parent)parent.add(avatar);else scene.remove(avatar)
    avatar.position.copy(position);avatar.quaternion.copy(rotation);avatar.visible=visible
    e.renderer.setRenderTarget(oldTarget);target.dispose()
  }
}

export function compareWorldProjection(legacyProjection = false) {
  const {engine:e}=window.__nmsDebug
  const target=new THREE.WebGLRenderTarget(640,360),oldTarget=e.renderer.getRenderTarget()
  const camera=e.camera.clone(),scenePosition=e.scene.position.clone(),buffers=[],shaders=new Map()
  // Freeze every animation and only translate scene + camera together.
  if(legacyProjection)e.scene.traverse(object=>{
    for(const material of [].concat(object.material||[])){
      if(!material.isShaderMaterial||shaders.has(material))continue
      const source=material.vertexShader
      if(!source.includes('vec4 worldPos =')&&!source.includes('vec4 worldPosition ='))continue
      const world=source.includes('vec4 worldPosition =')?'worldPosition':'worldPos'
      const changed=source.replace(/projectionMatrix \* modelViewMatrix \* (?:vec4\([^;]+\)|localPosition|localPos);/g,`projectionMatrix * viewMatrix * ${world};`)
      if(changed!==source){shaders.set(material,source);material.vertexShader=changed;material.needsUpdate=true}
    }
  })
  const shadows=e.sunShadow.isEnabled();e.sunShadow.setEnabled(false)
  try{
    for(const offset of [0,.031]){
      e.scene.position.copy(scenePosition).addScalar(offset)
      camera.position.copy(e.camera.position).addScalar(offset)
      e.renderer.setRenderTarget(target);e.renderer.render(e.scene,camera)
      const pixels=new Uint8Array(640*360*4);e.renderer.readRenderTargetPixels(target,0,0,640,360,pixels);buffers.push(pixels)
    }
    let changed=0,error=0
    for(let i=0;i<buffers[0].length;i+=4){let delta=0;for(let c=0;c<3;c++)delta+=Math.abs(buffers[0][i+c]-buffers[1][i+c]);if(delta>6)changed++;error+=delta}
    return {legacyProjection,changedPixels:changed,meanChannelError:error/(640*360*3)}
  }finally{
    e.scene.position.copy(scenePosition);e.scene.updateMatrixWorld(true)
    for(const [m,shader]of shaders){m.vertexShader=shader;m.needsUpdate=true}
    e.sunShadow.setEnabled(shadows);e.renderer.setRenderTarget(oldTarget);target.dispose()
  }
}

export function runJitterChecks() {
  const avatar=captureAvatarTranslationPair()
  const world=compareWorldProjection(false)
  if(avatar.changedPixels>0||avatar.meanChannelError>0.01)throw new Error('Frozen skinning changes under rigid world translation')
  if(world.changedPixels>10||world.meanChannelError>0.05)throw new Error('World projection loses camera-relative precision')
  return {avatar:{changedPixels:avatar.changedPixels,meanChannelError:avatar.meanChannelError},world}
}
