import * as THREE from 'three'

export function previewDaylight() {
  const d=window.__nmsDebug,e=d.engine,s=d.system,t=s.walkerController.getActiveTarget()
  const callback=e.frameCallback,savedSun=e.getSunPosition(new THREE.Vector3())
  const up=s.ship.object.position.clone().sub(t.worldPosition).normalize()
  const sun=t.worldPosition.clone().addScaledVector(up,400000),color=e.getSunColor(new THREE.Color())
  e.stop();e.setSunPosition(sun)
  e.start(dt=>{
    s.walkerController.update(dt);s.landed.update(t.worldPosition,t.worldQuaternion,t.sampleSurfaceRadius);s.boarding.update(dt)
    s.ship.setSunLighting(sun,color,1,t)
    for(const p of s.planetRenderers.values()){p.setSunPosition(sun);p.update(e.camera,dt)}
  })
  return ()=>{e.stop();e.setSunPosition(savedSun);e.start(callback)}
}

export function runShipLightingChecks() {
  const {engine:e,system:s}=window.__nmsDebug,ship=s.ship,root=ship.object
  const parent=root.parent,position=root.position.clone(),rotation=root.quaternion.clone(),visible=root.visible
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1,.05,200)
  const target=new THREE.WebGLRenderTarget(128,128),previous=e.renderer.getRenderTarget()
  const oldGroups=root.children.map(g=>g.visible),sun=new THREE.Vector3(20,30,-40),color=new THREE.Color('#ffe3ba')
  scene.add(root);root.position.set(0,0,0);root.quaternion.identity();root.visible=true
  root.children.forEach((g,i)=>g.visible=i===0)
  camera.position.set(12,8,-18);camera.lookAt(0,2,0)
  const materialState=[];root.traverse(o=>{if(o.isMesh)for(const m of [].concat(o.material)){if(m.uniforms)materialState.push([m,Object.fromEntries(Object.entries(m.uniforms).map(([k,u])=>[k,u.value?.isTexture?u.value:(u.value?.clone?u.value.clone():u.value)]))])}})
  const sample=()=>{
    e.renderer.setRenderTarget(target);e.renderer.render(scene,camera)
    const data=new Uint8Array(128*128*4);e.renderer.readRenderTargetPixels(target,0,0,128,128,data)
    let luminance=0;for(let i=0;i<data.length;i+=4)luminance+=data[i]*.2126+data[i+1]*.7152+data[i+2]*.0722
    return {data,luminance}
  }
  try{
    ship.setSunLighting(sun,color,1);const lit=sample()
    const light=new THREE.DirectionalLight(0xffffff,100);light.position.set(1,1,1);scene.add(light)
    const extra=sample();light.removeFromParent();light.dispose()
    ship.setSunLighting(sun,color,0);const night=sample()
    if(lit.data.some((value,i)=>value!==extra.data[i]))throw new Error('Another ship light changes this hull')
    if(!(night.luminance<lit.luminance*.25&&night.luminance>0))throw new Error('Ship does not follow sunlight/shadow')
    return {independentOfSceneLights:true,shadowToSunRatio:night.luminance/lit.luminance,
      shaderErrors:e.renderer.info.programs.filter(p=>p.diagnostics&&!p.diagnostics.runnable).length}
  }finally{
    if(parent)parent.add(root);root.position.copy(position);root.quaternion.copy(rotation);root.visible=visible
    root.children.forEach((g,i)=>g.visible=oldGroups[i]);for(const[m,u]of materialState)for(const[k,value]of Object.entries(u))m.uniforms[k].value=value
    e.renderer.setRenderTarget(previous);target.dispose()
  }
}
