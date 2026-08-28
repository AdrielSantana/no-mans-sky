# Backlog de performance

Estado depois da auditoria de 2026-08-28 e da primeira rodada de correções.
Tudo abaixo foi lido no código; os números são medidos, não estimados.

**Antes de atacar qualquer coisa daqui: meça de novo.** A lista original foi
construída sobre um profile que já não existe — a amostragem de terreno ficou
22,5% mais rápida, o build de chunk 21%, e três blocos grandes de main thread e
GPU sumiram. O HUD (`?perf`) agora reporta `draw`/`tri` de verdade.

---

## 1. Props — o subsistema mais pesado que sobrou

Confirmado em uso: continua pesado. Backface culling e o alpha-test inútil já
foram corrigidos (1.1); o que resta é contagem de triângulos e VRAM.

### 1.1 Backface culling e alpha-test — FEITO
As árvores são **tronco e galhos, sem folhas** (escolha deliberada do autor).
Isso invalidou a análise original, que assumia cards de folhagem alpha-cut.

Verificado nos assets:
- `alphaMode: OPAQUE` nos dois GLB de árvore
- baseColor é **JPEG**, formato sem canal alpha — `texel.a` é sempre 1.0
- soldando os vértices por posição: `rock_1` fechada (0 arestas de borda),
  `oak_tree` 3 e `winter_tree` 20 em ~26k, **zero arestas não-manifold** nas
  três. Sólidos fechados com o fundo do tronco aberto, não superfícies de
  cards — cada card contribuiria com 4 arestas de borda.

Consequências, ambas corrigidas:
- `sourceMaterialAlphaTest` forçava `alphaTest >= 0.08` em qualquer árvore com
  mapa. Como o alpha é sempre 1.0, o `discard` nunca disparava — custo zero
  visual, mas a presença do `discard` no fragment shader **desativa early-Z**.
  Agora o discard sai do shader por `#define PROP_ALPHA_TEST` quando não há
  alpha test. Zerar o uniform não bastaria.
- `side` era `DoubleSide` hardcoded para árvores (e vinha `DoubleSide` do GLB
  para rochas), rasterizando ~17,5k triângulos por árvore **duas vezes** em
  backfaces nunca visíveis. Agora `FrontSide` nos dois.

**Se algum dia forem adicionados cards de folhagem a esses modelos, isto tem
de voltar a ser uma decisão por submesh.**

### 1.1b LOD tiers — ainda pendente, e agora mais fácil
Continua sendo 17.509 / 20.482 triângulos por árvore renderizados a até 648 m
(game) cobrindo 10-60 px de altura de tela.

A ressalva original — "decimação em runtime destrói a silhueta dos cards de
folhagem" — **não se aplica**: não há cards. Tronco e galhos são sólidos
fechados, então decimação em runtime é viável e tiers autorados deixam de ser
obrigatórios.

Mantenha a estrutura de `InstancedMesh` por chunk (é ela que faz o frustum
culling funcionar) e alterne por `.visible`, não por `.count`, usando o `dist`
já calculado em `updateChunkPropVisibility`.

### 1.2 Raymarch de sombra ainda é síncrono — `planet-props.ts:680-707`
`computeHorizonSunLight` roda 10 amostras de `samplePlanetHeightDetailed` por
instância, no main thread, durante a integração do chunk. ~4,4 ms/chunk medido
antes das otimizações de ruído; hoje ~3,4 ms.

- **Early-out analítico:** `blocker` só fica não-zero se algum `obstacleSlope`
  exceder `stylizedSunSlope - 0.015`. Um limite por planeta de slope alcançável
  colapsa o caso diurno comum num compare.
- **Perfil de horizonte no worker:** emita `horizonRadii` junto com os buffers
  de geometria em `terrain-worker.ts` e interpole.
  **Cacheie raios, não oclusão** — o termo vertical depende do raio da própria
  instância, então duas árvores no mesmo chunk em alturas diferentes precisam
  sombrear diferente.

### 1.3 Texturas 2048² — `planet-props.ts`
Ver secção 3. Melhor retorno por risco de tudo que sobrou: 85 → 21 MB de VRAM
sem tocar em código.

---

## 2. Pool global de workers — agora com evidência

`initTerrainWorkers` (`planet-renderer.ts`) cria até `min(8, threads-1)` workers
**por PlanetRenderer**, e `celestial-system.ts` cria um renderer por planeta.

Isto deixou de ser teórico. Ao paralelizar o job do oceano medi:

| fatias | wall | maior fatia | trabalho real por fatia |
|---|---|---|---|
| 6 | 1748 ms | 1338 ms | ~380 ms |
| 3 | 1875 ms | 1479 ms | ~760 ms |

Numa máquina de 10 núcleos, 8 workers de chunk + N de oceano saturam tudo: o
número de fatias deixa de importar porque o gargalo é disponibilidade de CPU.
Por isso `resolveOceanSliceCount` é deliberadamente conservador (`threads / 3`,
máx. 3) — oversubscrever deixa o streaming de terreno mais lento, e isso o
jogador vê.

**O conserto é um pool global compartilhado com prioridade por distância**, em
vez de um pool por planeta. Destrava a paralelização do oceano e acelera o
streaming ao mesmo tempo.

---

## 3. Assets — 28,8 MB → ~7 MB, zero linha de código

Medido parseando os arquivos. Nenhum GLB tem Draco ou KTX2 (`extensionsUsed`
é undefined nos quatro).

| arquivo | dims | disco | VRAM (RGBA8+mips) |
|---|---|---|---|
| `rock_1.glb` / `rock_2.glb` | 2048² | 4,1 / 4,5 MB | 21,3 MB cada |
| `oak_tree.glb` / `winter_tree.glb` | 2048² | 5,4 / 5,2 MB | 21,3 MB cada |
| `astronaut.png` | 2048² | 6,9 MB | 21,3 MB |
| tiles de terreno (4×) | 1024² | 0,9 MB | 22,6 MB |

A geometria dos props é minúscula — `rock_1` tem 3.120 triângulos e **93% do
arquivo é uma JPEG embutida**.

- `gltf-transform resize` para 1024² (512² nas rochas, que medem 0,9-5,5 m):
  GLBs para ~5 MB, VRAM para ~21 MiB.
- Se for de KTX2, use **UASTC + Zstd**. ETC1S é visivelmente blocado em albedo
  ruidoso de rocha — seria regressão.
- `astronaut.png` é colorType 2 (RGB, sem alpha) e o shader lê só `.rgb`.
  JPEG q92 medido: 1,29 MB (5,3× menor).
- `astronaut.fbx` carrega um `Video/Content` de 2,7 MB — a **mesma** textura já
  servida como PNG, que o `FBXLoader` decodifica e `prepareModel` descarta três
  linhas depois. Reexporte sem mídia embutida: 3,4 MB → ~645 KB.
  **Não** tente resolver em código com `URL.revokeObjectURL(map.image.src)`:
  `map.image` ainda é null nesse ponto, o `TypeError` é engolido pelo catch, e
  o astronauta nunca aparece.

Nota: os arquivos do `pathfinder_spaceship` (20,2 MB) não são importados por
nenhum módulo. Como o Vite só empacota o que é importado, é peso de repositório,
não de bundle.

---

## 4. macroAO — 46% do build de chunk

Só o hoisting de alocação foi feito. A subamostragem continua na mesa, mas com
uma ressalva que a auditoria original não capturou:

`sampleDirectionalAo` recebe `center = macroHeight`, que é a altura do **próprio
vértice**, em frequência cheia. O AO não é uma função suave na escala do `step`,
então subamostrar e bilerpar ingenuamente borra variação de alta frequência.

**Abordagem correta:** interpolar apenas as *estatísticas de vizinhança* — os
seis pontos médios `(a+b)/2` e o min/max dos 12 vizinhos — e recombinar com o
`center` exato por vértice. Isso preserva a dependência do vértice e só
interpola o que de facto varia na escala do `step`.

Cuidados:
- Endpoints inclusive em `[u0,u1]×[v0,v1]` para vizinhos de mesmo LOD
  compartilharem amostras de borda (sem costura).
- **Não** hardcode `lod >= 6` com 9×9: a frequência segura depende de
  `terrain.frequency`, que varia 2,0-4,0 entre presets.
- **Não** estenda ao `microAo` — os taps dele são métricos (0,45-3,7 m),
  comparáveis ao espaçamento de vértice em lod 7.
- Valide com `max |Δ| ≤ 0.02` (≈0,5% de luminância em `amount 0.28`).

**Ressalva de valor:** o build roda em worker pool, então isto não move o p95
numa máquina com 8+ núcleos. O que compra é latência de pop-in de LOD.

---

## 5. Antialiasing — não existe nenhum hoje

`RenderPass` rasteriza em alvos com `samples = 0` (`engine.ts:29-37`), e nada
além do quad do `OutputPass` chega ao framebuffer. `antialias: false` já foi
aplicado (era custo puro sem benefício), mas AA de verdade continua ausente.

Duas rotas:
- **MSAA no composer** (`samples: 2`): funciona, mas **ambos** os alvos ficam
  multisampled obrigatoriamente — a paridade de swap é dinâmica
  (`needsSwap = hasClouds`, `UnderwaterPass.enabled`). Custo: RGBA16F
  multisampled em DPR 2, até 4 resolves por frame.
- **Pass pós-tonemap** (SMAA/FXAA): um pass fullscreen, ~0,2-0,4 ms a 1080p,
  deixa os alvos HalfFloat e o depth read do cloud pass intactos.

**Recomendado:** post-AA, salvo se a medição de MSAA 2× surpreender.

`alphaToCoverage` está ligado em grama e props e é **inerte** — os dois shaders
escrevem alpha constante 1.0 e resolvem silhueta por `discard` binário. Só vale
mexer depois de existir MSAA, e então separando cobertura de silhueta do fade
(dobrar o fade na cobertura vira screen-door de 4 níveis).

---

## 6. Itens menores verificados

- **`collectRenderKeys` sem teste de facing** (`planet-renderer.ts`). O
  hemisfério de trás inteiro é submetido todo frame. O vertex shader far roda um
  `terrainFbm` de 3 oitavas por vértice, que backface culling não elimina.
  Alternativa de baixo risco ao conserto de winding (que é de três arquivos:
  `terrain-geometry`, as saias, e `buildIndexForStitching`, que descarta os
  triângulos de saia quando há stitching ativo — sob `FrontSide` isso vira
  buraco para o espaço).
  *Meça o `draw` no HUD antes de decidir.*
- **Espectro iFFT base sem gate de distância** (`planet-renderer.ts`): 20 passes
  fullscreen 512² incondicionais, enquanto o de detalhe já tem cadência.
  **Pré-requisito:** o decaimento de espuma em `ocean-gpu-ifft.ts:542` decai por
  *update*, não por segundo — sem corrigir isso você troca GPU por pop de espuma.
- **Alvos ping-pong do iFFT são RGBA16F carregando 2 canais**
  (`ocean-gpu-ifft.ts`). `RGFormat` no spectrum/ping/pong, mantendo os outputs em
  RGBA. **Não** mexa no `DataTexture` de h0: o buffer é alocado com stride 4 e
  trocar só o format corrompe o espectro inicial.
- **`oceanMesh.frustumCulled = false`** (`planet-renderer.ts`). Conserte com
  `boundingSphere` explícito em vez de desligar culling.
- **`CLOUD_OCCLUDER_RENDER_LAYER` nunca é renderizado.** É habilitado em toda
  mesh de chunk, no oceano e na fallbackSphere, mas `engine.ts` só importa
  `CLOUD_RENDER_LAYER`. Custo de `layers.enable` a zero de benefício.
- **`CloudCompositePass` traversa o grafo 3× por frame** (`engine.ts`). Cada
  `renderer.render()` chama `scene.updateMatrixWorld()`, e `projectObject`
  recursa nos filhos fora do teste de visibilidade — o teste de layer não poda a
  árvore. `matrixAutoUpdate = false` não aparece em lugar nenhum do projeto.
- **`client/src/game/planet/noise.ts` é código morto** — zero importadores.
- **`grassHeight` podia ser uniform** (`fluffy-grass.ts`): só alimenta a escala
  da instância. Como uniform, o slider deixa de precisar de rebuild.

---

## 7. Deliberadamente NÃO feito

**Passo métrico fixo na normal do terreno** (`terrain-geometry.ts`).
`normalSampleStep` é proporcional ao tamanho da célula, logo ao LOD: o mesmo
ponto do mundo recebe normal diferente em LOD 5 e 6, e o sombreamento "pula"
quando um chunk divide.

Um passo fixo em metros elimina o pop — mas em chunks grosseiros passa a
amostrar bem abaixo do espaçamento de vértice, trocando pop de LOD por aliasing
de normal. Além disso este item veio do agente crítico e **não passou pela
verificação adversarial**, ao contrário do resto da auditoria.

Precisa de uma decisão de arte, não de uma otimização.

---

## Como validar mudanças aqui

O harness de teste diferencial usado na primeira rodada compara a implementação
nova contra `git HEAD` sobre entradas aleatórias. Vale reconstruí-lo para
qualquer mudança em terreno, AO ou geometria:

- Amostragem de terreno: 400k direções × 5 presets, comparando as 5 funções
  exportadas de `planet-terrain.ts` com `Object.is`.
- Geometria de chunk: 144 builds (4 presets × 6 nós × 3 gridSizes × skirts),
  comparando os 8 buffers.
- Índice de stitching: 72 configurações, comparando o índice efetivamente
  desenhado (respeitando `drawRange`).

**`planet-terrain.ts` é compartilhado com o servidor SpacetimeDB.** Qualquer
mudança ali tem de ser bit-idêntica, ou cliente e servidor discordam sobre a
altura do terreno e o jogador afunda no chão. A ordem de multiplicação em
`grad4dot` é deliberada por esse motivo — a variante "otimizada" que fatora
`norm` no final diverge em 59,5% das amostras.
