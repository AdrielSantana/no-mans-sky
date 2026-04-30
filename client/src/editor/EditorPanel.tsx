import type { EditorParams } from './editor-defaults'
import { DEFAULT_PARAMS, RANGES, TYPE_PRESETS } from './editor-defaults'
import './EditorPanel.css'

interface Props {
  params: EditorParams
  onChange: (params: EditorParams) => void
}

export function EditorPanel({ params, onChange }: Props) {
  const set = <K extends keyof EditorParams>(key: K, value: EditorParams[K]) => {
    onChange({ ...params, [key]: value })
  }

  const setPlanetType = (planetType: string) => {
    const preset = TYPE_PRESETS[planetType]
    onChange({ ...params, planetType, ...preset })
  }

  return (
    <div className="editor-panel">
      <div className="editor-title">Planet Editor</div>

      <div className="editor-section">
        <div className="editor-section-title">Planet Type</div>
        <div className="editor-row">
          <span className="editor-label">Type</span>
          <select
            className="editor-select"
            value={params.planetType}
            onChange={e => setPlanetType(e.target.value)}
          >
            <option value="rocky">Rocky</option>
            <option value="gas">Gas Giant</option>
            <option value="ice">Ice</option>
          </select>
        </div>
        <div className="editor-row">
          <span className="editor-label">Seed</span>
          <input
            className="editor-number"
            type="number"
            value={params.seed}
            onChange={e => set('seed', Number(e.target.value))}
          />
        </div>
        <div className="editor-btn-row">
          <button className="editor-btn" onClick={() => set('seed', Math.floor(Math.random() * 99999))}>
            Randomize
          </button>
          <button className="editor-btn" onClick={() => onChange({ ...DEFAULT_PARAMS })}>
            Reset
          </button>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Geometry</div>
        <div className="editor-row">
          <span className="editor-label">Radius</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.planetRadius.min}
            max={RANGES.planetRadius.max}
            step={RANGES.planetRadius.step}
            value={params.planetRadius}
            onChange={e => set('planetRadius', Number(e.target.value))}
          />
          <span className="editor-value">{params.planetRadius}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Terrain Scale</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.terrainScale.min}
            max={RANGES.terrainScale.max}
            step={RANGES.terrainScale.step}
            value={params.terrainScale}
            onChange={e => set('terrainScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.terrainScale.toFixed(2)}</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">World Gen</div>
        <div className="editor-row">
          <span className="editor-label">Octaves</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.octaves.min}
            max={RANGES.octaves.max}
            step={RANGES.octaves.step}
            value={params.octaves}
            onChange={e => set('octaves', Number(e.target.value))}
          />
          <span className="editor-value">{params.octaves}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Lacunarity</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.lacunarity.min}
            max={RANGES.lacunarity.max}
            step={RANGES.lacunarity.step}
            value={params.lacunarity}
            onChange={e => set('lacunarity', Number(e.target.value))}
          />
          <span className="editor-value">{params.lacunarity.toFixed(1)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Gain</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.gain.min}
            max={RANGES.gain.max}
            step={RANGES.gain.step}
            value={params.gain}
            onChange={e => set('gain', Number(e.target.value))}
          />
          <span className="editor-value">{params.gain.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Frequency</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.frequency.min}
            max={RANGES.frequency.max}
            step={RANGES.frequency.step}
            value={params.frequency}
            onChange={e => set('frequency', Number(e.target.value))}
          />
          <span className="editor-value">{params.frequency.toFixed(1)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Warp</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.warpStrength.min}
            max={RANGES.warpStrength.max}
            step={RANGES.warpStrength.step}
            value={params.warpStrength}
            onChange={e => set('warpStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.warpStrength.toFixed(2)}</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Terrain Layers</div>
        <div className="editor-row">
          <span className="editor-label">Continents</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.continentalScale.min}
            max={RANGES.continentalScale.max}
            step={RANGES.continentalScale.step}
            value={params.continentalScale}
            onChange={e => set('continentalScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.continentalScale.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Mountains</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.mountainScale.min}
            max={RANGES.mountainScale.max}
            step={RANGES.mountainScale.step}
            value={params.mountainScale}
            onChange={e => set('mountainScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.mountainScale.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Plains</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.plainsScale.min}
            max={RANGES.plainsScale.max}
            step={RANGES.plainsScale.step}
            value={params.plainsScale}
            onChange={e => set('plainsScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.plainsScale.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Hills</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.hillsScale.min}
            max={RANGES.hillsScale.max}
            step={RANGES.hillsScale.step}
            value={params.hillsScale}
            onChange={e => set('hillsScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.hillsScale.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Mountain Belts</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.mountainBeltScale.min}
            max={RANGES.mountainBeltScale.max}
            step={RANGES.mountainBeltScale.step}
            value={params.mountainBeltScale}
            onChange={e => set('mountainBeltScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.mountainBeltScale.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Relief Variety</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.reliefVariety.min}
            max={RANGES.reliefVariety.max}
            step={RANGES.reliefVariety.step}
            value={params.reliefVariety}
            onChange={e => set('reliefVariety', Number(e.target.value))}
          />
          <span className="editor-value">{params.reliefVariety.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Hydraulic</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.erosionStrength.min}
            max={RANGES.erosionStrength.max}
            step={RANGES.erosionStrength.step}
            value={params.erosionStrength}
            onChange={e => set('erosionStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.erosionStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Thermal</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.thermalStrength.min}
            max={RANGES.thermalStrength.max}
            step={RANGES.thermalStrength.step}
            value={params.thermalStrength}
            onChange={e => set('thermalStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.thermalStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Fine Detail</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.detailStrength.min}
            max={RANGES.detailStrength.max}
            step={RANGES.detailStrength.step}
            value={params.detailStrength}
            onChange={e => set('detailStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.detailStrength.toFixed(2)}</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">LOD ({params.lodMultipliers.length} levels)</div>
        <div className="editor-row">
          <span className="editor-label">Grid Size</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.gridSize.min}
            max={RANGES.gridSize.max}
            step={RANGES.gridSize.step}
            value={params.gridSize}
            onChange={e => set('gridSize', Number(e.target.value))}
          />
          <span className="editor-value">{params.gridSize}</span>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.skirts}
              onChange={e => set('skirts', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Skirts</span>
          </label>
        </div>
        <div className="editor-row">
          <span className="editor-label">Horizon</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.horizonMargin.min}
            max={RANGES.horizonMargin.max}
            step={RANGES.horizonMargin.step}
            value={params.horizonMargin}
            onChange={e => set('horizonMargin', Number(e.target.value))}
          />
          <span className="editor-value">{params.horizonMargin.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Workers</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.terrainWorkers.min}
            max={RANGES.terrainWorkers.max}
            step={RANGES.terrainWorkers.step}
            value={params.terrainWorkers}
            onChange={e => set('terrainWorkers', Number(e.target.value))}
          />
          <span className="editor-value">{params.terrainWorkers === 0 ? 'Auto' : params.terrainWorkers}</span>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.autoLod}
              onChange={e => set('autoLod', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Auto LOD</span>
          </label>
        </div>
        {params.lodMultipliers.map((val, i) => (
          <div className="editor-row" key={i}>
            <span className="editor-label">LOD {i + 1}</span>
            <input
              className="editor-slider"
              type="range"
              min={RANGES.lodMultiplier.min}
              max={RANGES.lodMultiplier.max}
              step={RANGES.lodMultiplier.step}
              value={val}
              disabled={params.autoLod}
              onChange={e => {
                const next = [...params.lodMultipliers]
                next[i] = Number(e.target.value)
                set('lodMultipliers', next)
              }}
            />
            <span className="editor-value">{val.toFixed(2)}</span>
          </div>
        ))}
        {!params.autoLod && (
          <div className="editor-btn-row">
            <button
              className="editor-btn"
              disabled={params.lodMultipliers.length <= 1}
              onClick={() => set('lodMultipliers', params.lodMultipliers.slice(0, -1))}
            >
              Remove Last
            </button>
            <button
              className="editor-btn"
              disabled={params.lodMultipliers.length >= 15}
              onClick={() => {
                const last = params.lodMultipliers[params.lodMultipliers.length - 1] ?? 1
                set('lodMultipliers', [...params.lodMultipliers, Math.max(0.01, last * 0.45)])
              }}
            >
              Add Level
            </button>
          </div>
        )}
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Surface</div>
        <div className="editor-row">
          <span className="editor-label">Water Level</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.waterLevel.min}
            max={RANGES.waterLevel.max}
            step={RANGES.waterLevel.step}
            value={params.waterLevel}
            onChange={e => set('waterLevel', Number(e.target.value))}
          />
          <span className="editor-value">{params.waterLevel.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Color A</span>
          <input
            className="editor-color"
            type="color"
            value={params.colorA}
            onChange={e => set('colorA', e.target.value)}
          />
          <span className="editor-value">{params.colorA}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Color B</span>
          <input
            className="editor-color"
            type="color"
            value={params.colorB}
            onChange={e => set('colorB', e.target.value)}
          />
          <span className="editor-value">{params.colorB}</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Textures</div>
        <div className="editor-row">
          <span className="editor-label">Scale</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.textureScale.min}
            max={RANGES.textureScale.max}
            step={RANGES.textureScale.step}
            value={params.textureScale}
            onChange={e => set('textureScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.textureScale.toFixed(0)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Strength</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.textureBlend.min}
            max={RANGES.textureBlend.max}
            step={RANGES.textureBlend.step}
            value={params.textureBlend}
            onChange={e => set('textureBlend', Number(e.target.value))}
          />
          <span className="editor-value">{params.textureBlend.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Near Dist</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.textureNearDistance.min}
            max={RANGES.textureNearDistance.max}
            step={RANGES.textureNearDistance.step}
            value={params.textureNearDistance}
            onChange={e => set('textureNearDistance', Number(e.target.value))}
          />
          <span className="editor-value">{params.textureNearDistance.toFixed(0)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Fade Dist</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.textureFadeDistance.min}
            max={RANGES.textureFadeDistance.max}
            step={RANGES.textureFadeDistance.step}
            value={params.textureFadeDistance}
            onChange={e => set('textureFadeDistance', Number(e.target.value))}
          />
          <span className="editor-value">{params.textureFadeDistance.toFixed(0)}</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Atmosphere</div>
        <div className="editor-row">
          <span className="editor-label">Color</span>
          <input
            className="editor-color"
            type="color"
            value={params.atmosphereColor}
            onChange={e => set('atmosphereColor', e.target.value)}
          />
          <span className="editor-value">{params.atmosphereColor}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Density</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereDensity.min}
            max={RANGES.atmosphereDensity.max}
            step={RANGES.atmosphereDensity.step}
            value={params.atmosphereDensity}
            onChange={e => set('atmosphereDensity', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereDensity.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Haze</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereHazeStrength.min}
            max={RANGES.atmosphereHazeStrength.max}
            step={RANGES.atmosphereHazeStrength.step}
            value={params.atmosphereHazeStrength}
            onInput={e => set('atmosphereHazeStrength', Number(e.currentTarget.value))}
            onChange={e => set('atmosphereHazeStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereHazeStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Haze Dist</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereHazeDistance.min}
            max={RANGES.atmosphereHazeDistance.max}
            step={RANGES.atmosphereHazeDistance.step}
            value={params.atmosphereHazeDistance}
            onInput={e => set('atmosphereHazeDistance', Number(e.currentTarget.value))}
            onChange={e => set('atmosphereHazeDistance', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereHazeDistance.toFixed(2)}R</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Horizon Glow</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereHorizonGlow.min}
            max={RANGES.atmosphereHorizonGlow.max}
            step={RANGES.atmosphereHorizonGlow.step}
            value={params.atmosphereHorizonGlow}
            onInput={e => set('atmosphereHorizonGlow', Number(e.currentTarget.value))}
            onChange={e => set('atmosphereHorizonGlow', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereHorizonGlow.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Sun Glare</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereSunGlare.min}
            max={RANGES.atmosphereSunGlare.max}
            step={RANGES.atmosphereSunGlare.step}
            value={params.atmosphereSunGlare}
            onInput={e => set('atmosphereSunGlare', Number(e.currentTarget.value))}
            onChange={e => set('atmosphereSunGlare', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereSunGlare.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Glare Size</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereSunGlareSize.min}
            max={RANGES.atmosphereSunGlareSize.max}
            step={RANGES.atmosphereSunGlareSize.step}
            value={params.atmosphereSunGlareSize}
            onInput={e => set('atmosphereSunGlareSize', Number(e.currentTarget.value))}
            onChange={e => set('atmosphereSunGlareSize', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereSunGlareSize.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Twilight Width</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereTwilightWidth.min}
            max={RANGES.atmosphereTwilightWidth.max}
            step={RANGES.atmosphereTwilightWidth.step}
            value={params.atmosphereTwilightWidth}
            onInput={e => set('atmosphereTwilightWidth', Number(e.currentTarget.value))}
            onChange={e => set('atmosphereTwilightWidth', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereTwilightWidth.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Twilight</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereTwilightStrength.min}
            max={RANGES.atmosphereTwilightStrength.max}
            step={RANGES.atmosphereTwilightStrength.step}
            value={params.atmosphereTwilightStrength}
            onInput={e => set('atmosphereTwilightStrength', Number(e.currentTarget.value))}
            onChange={e => set('atmosphereTwilightStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereTwilightStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Extinction</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereExtinctionStrength.min}
            max={RANGES.atmosphereExtinctionStrength.max}
            step={RANGES.atmosphereExtinctionStrength.step}
            value={params.atmosphereExtinctionStrength}
            onInput={e => set('atmosphereExtinctionStrength', Number(e.currentTarget.value))}
            onChange={e => set('atmosphereExtinctionStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereExtinctionStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Night Color</span>
          <input
            className="editor-color"
            type="color"
            value={params.atmosphereNightColor}
            onChange={e => set('atmosphereNightColor', e.target.value)}
          />
          <span className="editor-value">{params.atmosphereNightColor}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Night Ambient</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereNightAmbient.min}
            max={RANGES.atmosphereNightAmbient.max}
            step={RANGES.atmosphereNightAmbient.step}
            value={params.atmosphereNightAmbient}
            onInput={e => set('atmosphereNightAmbient', Number(e.currentTarget.value))}
            onChange={e => set('atmosphereNightAmbient', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereNightAmbient.toFixed(2)}</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Lighting</div>
        <div className="editor-row">
          <span className="editor-label">Sun Color</span>
          <input
            className="editor-color"
            type="color"
            value={params.sunColor}
            onChange={e => set('sunColor', e.target.value)}
          />
          <span className="editor-value">{params.sunColor}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Sun Tint</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.sunTintStrength.min}
            max={RANGES.sunTintStrength.max}
            step={RANGES.sunTintStrength.step}
            value={params.sunTintStrength}
            onChange={e => set('sunTintStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.sunTintStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Sun Azimuth</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.sunAzimuth.min}
            max={RANGES.sunAzimuth.max}
            step={RANGES.sunAzimuth.step}
            value={params.sunAzimuth}
            onChange={e => set('sunAzimuth', Number(e.target.value))}
          />
          <span className="editor-value">{params.sunAzimuth.toFixed(0)}°</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Sun Elevation</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.sunElevation.min}
            max={RANGES.sunElevation.max}
            step={RANGES.sunElevation.step}
            value={params.sunElevation}
            onChange={e => set('sunElevation', Number(e.target.value))}
          />
          <span className="editor-value">{params.sunElevation.toFixed(0)}°</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Diagnostics</div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugBloom}
              onChange={e => set('debugBloom', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Bloom</span>
          </label>
        </div>
        <div className="editor-row">
          <span className="editor-label">Bloom Strength</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.bloomStrength.min}
            max={RANGES.bloomStrength.max}
            step={RANGES.bloomStrength.step}
            value={params.bloomStrength}
            onInput={e => set('bloomStrength', Number(e.currentTarget.value))}
            onChange={e => set('bloomStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.bloomStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Bloom Radius</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.bloomRadius.min}
            max={RANGES.bloomRadius.max}
            step={RANGES.bloomRadius.step}
            value={params.bloomRadius}
            onInput={e => set('bloomRadius', Number(e.currentTarget.value))}
            onChange={e => set('bloomRadius', Number(e.target.value))}
          />
          <span className="editor-value">{params.bloomRadius.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Bloom Threshold</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.bloomThreshold.min}
            max={RANGES.bloomThreshold.max}
            step={RANGES.bloomThreshold.step}
            value={params.bloomThreshold}
            onInput={e => set('bloomThreshold', Number(e.currentTarget.value))}
            onChange={e => set('bloomThreshold', Number(e.target.value))}
          />
          <span className="editor-value">{params.bloomThreshold.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Exposure</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.toneMappingExposure.min}
            max={RANGES.toneMappingExposure.max}
            step={RANGES.toneMappingExposure.step}
            value={params.toneMappingExposure}
            onInput={e => set('toneMappingExposure', Number(e.currentTarget.value))}
            onChange={e => set('toneMappingExposure', Number(e.target.value))}
          />
          <span className="editor-value">{params.toneMappingExposure.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugOcean}
              onChange={e => set('debugOcean', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Ocean</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugAtmosphere}
              onChange={e => set('debugAtmosphere', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Atmosphere</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugSimpleTerrain}
              onChange={e => set('debugSimpleTerrain', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Simple Terrain</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugNearTerrainShader}
              onChange={e => set('debugNearTerrainShader', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Near Terrain Shader</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugFarTerrainShader}
              onChange={e => set('debugFarTerrainShader', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Far Terrain Shader</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugFallbackTerrainShader}
              onChange={e => set('debugFallbackTerrainShader', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Fallback Terrain Shader</span>
          </label>
        </div>
      </div>
    </div>
  )
}
