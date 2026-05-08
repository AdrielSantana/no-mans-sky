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
        <div className="editor-row">
          <span className="editor-label">Terrain AO</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.terrainAoStrength.min}
            max={RANGES.terrainAoStrength.max}
            step={RANGES.terrainAoStrength.step}
            value={params.terrainAoStrength}
            onChange={e => set('terrainAoStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.terrainAoStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Micro Strength</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.microDetailStrength.min}
            max={RANGES.microDetailStrength.max}
            step={RANGES.microDetailStrength.step}
            value={params.microDetailStrength}
            onChange={e => set('microDetailStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.microDetailStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Micro Scale</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.microDetailScale.min}
            max={RANGES.microDetailScale.max}
            step={RANGES.microDetailScale.step}
            value={params.microDetailScale}
            onChange={e => set('microDetailScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.microDetailScale.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Micro Relief</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.microReliefMeters.min}
            max={RANGES.microReliefMeters.max}
            step={RANGES.microReliefMeters.step}
            value={params.microReliefMeters}
            onChange={e => set('microReliefMeters', Number(e.target.value))}
          />
          <span className="editor-value">{params.microReliefMeters.toFixed(2)}m</span>
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
            <span className="editor-label" style={{ width: 'auto' }}>LOD Stitching</span>
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
          <span className="editor-label">Deep Water</span>
          <input
            className="editor-color"
            type="color"
            value={params.oceanDeepColor}
            onChange={e => set('oceanDeepColor', e.target.value)}
          />
          <span className="editor-value">{params.oceanDeepColor}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Shallow</span>
          <input
            className="editor-color"
            type="color"
            value={params.oceanShallowColor}
            onChange={e => set('oceanShallowColor', e.target.value)}
          />
          <span className="editor-value">{params.oceanShallowColor}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Foam Color</span>
          <input
            className="editor-color"
            type="color"
            value={params.oceanFoamColor}
            onChange={e => set('oceanFoamColor', e.target.value)}
          />
          <span className="editor-value">{params.oceanFoamColor}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Clarity</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.oceanClarity.min}
            max={RANGES.oceanClarity.max}
            step={RANGES.oceanClarity.step}
            value={params.oceanClarity}
            onChange={e => set('oceanClarity', Number(e.target.value))}
          />
          <span className="editor-value">{params.oceanClarity.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Absorption</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.oceanAbsorption.min}
            max={RANGES.oceanAbsorption.max}
            step={RANGES.oceanAbsorption.step}
            value={params.oceanAbsorption}
            onChange={e => set('oceanAbsorption', Number(e.target.value))}
          />
          <span className="editor-value">{params.oceanAbsorption.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Turbidity</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.oceanTurbidity.min}
            max={RANGES.oceanTurbidity.max}
            step={RANGES.oceanTurbidity.step}
            value={params.oceanTurbidity}
            onChange={e => set('oceanTurbidity', Number(e.target.value))}
          />
          <span className="editor-value">{params.oceanTurbidity.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Reflection</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.oceanReflectionStrength.min}
            max={RANGES.oceanReflectionStrength.max}
            step={RANGES.oceanReflectionStrength.step}
            value={params.oceanReflectionStrength}
            onChange={e => set('oceanReflectionStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.oceanReflectionStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Wave Height</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.oceanWaveHeight.min}
            max={RANGES.oceanWaveHeight.max}
            step={RANGES.oceanWaveHeight.step}
            value={params.oceanWaveHeight}
            onChange={e => set('oceanWaveHeight', Number(e.target.value))}
          />
          <span className="editor-value">{params.oceanWaveHeight.toFixed(1)}m</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Wind Speed</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.oceanWindSpeed.min}
            max={RANGES.oceanWindSpeed.max}
            step={RANGES.oceanWindSpeed.step}
            value={params.oceanWindSpeed}
            onChange={e => set('oceanWindSpeed', Number(e.target.value))}
          />
          <span className="editor-value">{params.oceanWindSpeed.toFixed(1)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Wave Detail</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.oceanDetail.min}
            max={RANGES.oceanDetail.max}
            step={RANGES.oceanDetail.step}
            value={params.oceanDetail}
            onChange={e => set('oceanDetail', Number(e.target.value))}
          />
          <span className="editor-value">{params.oceanDetail.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Choppiness</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.oceanChoppiness.min}
            max={RANGES.oceanChoppiness.max}
            step={RANGES.oceanChoppiness.step}
            value={params.oceanChoppiness}
            onChange={e => set('oceanChoppiness', Number(e.target.value))}
          />
          <span className="editor-value">{params.oceanChoppiness.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Foam</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.oceanFoamStrength.min}
            max={RANGES.oceanFoamStrength.max}
            step={RANGES.oceanFoamStrength.step}
            value={params.oceanFoamStrength}
            onChange={e => set('oceanFoamStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.oceanFoamStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Specular</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.oceanSpecularStrength.min}
            max={RANGES.oceanSpecularStrength.max}
            step={RANGES.oceanSpecularStrength.step}
            value={params.oceanSpecularStrength}
            onChange={e => set('oceanSpecularStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.oceanSpecularStrength.toFixed(2)}</span>
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
        <div className="editor-section-title">Grass</div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.grassEnabled}
              onChange={e => set('grassEnabled', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Fluffy Grass</span>
          </label>
        </div>
        <div className="editor-row">
          <span className="editor-label">Density</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.grassDensity.min}
            max={RANGES.grassDensity.max}
            step={RANGES.grassDensity.step}
            value={params.grassDensity}
            onChange={e => set('grassDensity', Number(e.target.value))}
          />
          <span className="editor-value">{params.grassDensity.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Height</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.grassHeight.min}
            max={RANGES.grassHeight.max}
            step={RANGES.grassHeight.step}
            value={params.grassHeight}
            onChange={e => set('grassHeight', Number(e.target.value))}
          />
          <span className="editor-value">{params.grassHeight.toFixed(2)}m</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Wind</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.grassWindStrength.min}
            max={RANGES.grassWindStrength.max}
            step={RANGES.grassWindStrength.step}
            value={params.grassWindStrength}
            onChange={e => set('grassWindStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.grassWindStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Distance</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.grassDistance.min}
            max={RANGES.grassDistance.max}
            step={RANGES.grassDistance.step}
            value={params.grassDistance}
            onChange={e => set('grassDistance', Number(e.target.value))}
          />
          <span className="editor-value">{params.grassDistance.toFixed(0)}m</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Base Color</span>
          <input
            className="editor-color"
            type="color"
            value={params.grassColorA}
            onChange={e => set('grassColorA', e.target.value)}
          />
          <span className="editor-value">{params.grassColorA}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Tip Color</span>
          <input
            className="editor-color"
            type="color"
            value={params.grassColorB}
            onChange={e => set('grassColorB', e.target.value)}
          />
          <span className="editor-value">{params.grassColorB}</span>
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
          <span className="editor-label">Twilight Color</span>
          <input
            className="editor-color"
            type="color"
            value={params.atmosphereTwilightColor}
            onChange={e => set('atmosphereTwilightColor', e.target.value)}
          />
          <span className="editor-value">{params.atmosphereTwilightColor}</span>
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
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Clouds</div>
        <div className="editor-row">
          <span className="editor-label">Coverage</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudCoverage.min}
            max={RANGES.cloudCoverage.max}
            step={RANGES.cloudCoverage.step}
            value={params.cloudCoverage}
            onInput={e => set('cloudCoverage', Number(e.currentTarget.value))}
            onChange={e => set('cloudCoverage', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudCoverage.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Opacity</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudOpacity.min}
            max={RANGES.cloudOpacity.max}
            step={RANGES.cloudOpacity.step}
            value={params.cloudOpacity}
            onInput={e => set('cloudOpacity', Number(e.currentTarget.value))}
            onChange={e => set('cloudOpacity', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudOpacity.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Scale</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudScale.min}
            max={RANGES.cloudScale.max}
            step={RANGES.cloudScale.step}
            value={params.cloudScale}
            onInput={e => set('cloudScale', Number(e.currentTarget.value))}
            onChange={e => set('cloudScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudScale.toFixed(1)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Softness</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudSoftness.min}
            max={RANGES.cloudSoftness.max}
            step={RANGES.cloudSoftness.step}
            value={params.cloudSoftness}
            onInput={e => set('cloudSoftness', Number(e.currentTarget.value))}
            onChange={e => set('cloudSoftness', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudSoftness.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Height</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudHeight.min}
            max={RANGES.cloudHeight.max}
            step={RANGES.cloudHeight.step}
            value={params.cloudHeight}
            onInput={e => set('cloudHeight', Number(e.currentTarget.value))}
            onChange={e => set('cloudHeight', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudHeight.toFixed(3)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Speed</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudSpeed.min}
            max={RANGES.cloudSpeed.max}
            step={RANGES.cloudSpeed.step}
            value={params.cloudSpeed}
            onInput={e => set('cloudSpeed', Number(e.currentTarget.value))}
            onChange={e => set('cloudSpeed', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudSpeed.toFixed(3)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Shadow</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudShadow.min}
            max={RANGES.cloudShadow.max}
            step={RANGES.cloudShadow.step}
            value={params.cloudShadow}
            onInput={e => set('cloudShadow', Number(e.currentTarget.value))}
            onChange={e => set('cloudShadow', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudShadow.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Volume</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudVolume.min}
            max={RANGES.cloudVolume.max}
            step={RANGES.cloudVolume.step}
            value={params.cloudVolume}
            onInput={e => set('cloudVolume', Number(e.currentTarget.value))}
            onChange={e => set('cloudVolume', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudVolume.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Storms</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudStorms.min}
            max={RANGES.cloudStorms.max}
            step={RANGES.cloudStorms.step}
            value={params.cloudStorms}
            onInput={e => set('cloudStorms', Number(e.currentTarget.value))}
            onChange={e => set('cloudStorms', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudStorms.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Bands</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudBands.min}
            max={RANGES.cloudBands.max}
            step={RANGES.cloudBands.step}
            value={params.cloudBands}
            onInput={e => set('cloudBands', Number(e.currentTarget.value))}
            onChange={e => set('cloudBands', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudBands.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Detail</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudDetail.min}
            max={RANGES.cloudDetail.max}
            step={RANGES.cloudDetail.step}
            value={params.cloudDetail}
            onInput={e => set('cloudDetail', Number(e.currentTarget.value))}
            onChange={e => set('cloudDetail', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudDetail.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Color</span>
          <input className="editor-color" type="color" value={params.cloudColor} onChange={e => set('cloudColor', e.target.value)} />
          <span className="editor-value">{params.cloudColor}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Color Strength</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudColorStrength.min}
            max={RANGES.cloudColorStrength.max}
            step={RANGES.cloudColorStrength.step}
            value={params.cloudColorStrength}
            onInput={e => set('cloudColorStrength', Number(e.currentTarget.value))}
            onChange={e => set('cloudColorStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudColorStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.cloudBillboards}
              onChange={e => set('cloudBillboards', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Billboards</span>
          </label>
        </div>
        <div className="editor-row">
          <span className="editor-label">Billboard Count</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.cloudBillboardCount.min}
            max={RANGES.cloudBillboardCount.max}
            step={RANGES.cloudBillboardCount.step}
            value={params.cloudBillboardCount}
            onInput={e => set('cloudBillboardCount', Number(e.currentTarget.value))}
            onChange={e => set('cloudBillboardCount', Number(e.target.value))}
          />
          <span className="editor-value">{params.cloudBillboardCount}</span>
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
        <div className="editor-row">
          <span className="editor-label">Planet Rotation</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.planetRotationSpeed.min}
            max={RANGES.planetRotationSpeed.max}
            step={RANGES.planetRotationSpeed.step}
            value={params.planetRotationSpeed}
            onInput={e => set('planetRotationSpeed', Number(e.currentTarget.value))}
            onChange={e => set('planetRotationSpeed', Number(e.target.value))}
          />
          <span className="editor-value">{params.planetRotationSpeed.toFixed(1)}°/s</span>
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
              checked={params.debugClouds}
              onChange={e => set('debugClouds', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Clouds</span>
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
