export const MAIN_RENDER_LAYER = 0
export const CLOUD_RENDER_LAYER = 1
export const CLOUD_OCCLUDER_RENDER_LAYER = 2
// Objects that draw into the sun shadow map. Enabled *in addition* to the main
// layer, so a caster still renders normally; the shadow camera sets its layer
// mask to this one alone and therefore never touches terrain, ocean or sky.
export const SUN_SHADOW_CASTER_LAYER = 3
