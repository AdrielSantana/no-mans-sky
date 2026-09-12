# Backlog de performance

Estado depois da auditoria de 2026-08-28 e da primeira rodada de correções.
Tudo abaixo foi lido no código; os números são medidos, não estimados.

**Antes de atacar qualquer coisa daqui: meça de novo.** A lista original foi
construída sobre um profile que já não existe — a amostragem de terreno ficou
22,5% mais rápida, o build de chunk 21%, e três blocos grandes de main thread e
GPU sumiram. O HUD (`?perf`) agora reporta `draw`/`tri` de verdade.

E o custo mudou de lugar de novo em setembro: **comece pela 0f**, não pela 0.

---

## 0f. Setembro: o custo mudou de lugar — 2026-09-11

Leia isto antes da seção 0. A lista de alvos dela continua correta **como
medição de agosto** e errada **como prioridade**: o que ela manda atacar
primeiro hoje custa quase nada, e o que custa não aparece lá.

O que mudou não foi o código da vegetação, foi a densidade. O corte descrito na
0e (`treeDensity 0,2 → 0,08`) levou a vegetação de **13,24 ms de 29,89** para
**~1 ms de ~34,5**. Ela saiu do topo da lista por remoção de trabalho, não por
otimização. Quem seguir a ordem da seção 0 vai passar uma tarde em folhagem
para ganhar ruído — foi exatamente o que eu fiz na primeira metade deste dia.

### Quem ficou com o custo: o fragment shader do terreno far

A medição que separa: stub das funções do fragment shader far, cena assentada,
mesma câmera nos dois lados.

| configuração | frame | fps | draws | triângulos |
|---|---|---|---|---|
| baseline | 33,7 ms | 30 | 496 | 1.371.238 |
| fragmento far stubado | 17,25 ms | 57 | 496 | 1.371.238 |
| **diferença** | **16,45 ms** | | idêntico | idêntico |

**Draws e triângulos idênticos dos dois lados** — é isso que torna o número
utilizável. Nada de geometria, de contagem de chamada ou de CPU mudou; só o
trabalho por fragmento.

Ressalva: o absoluto está inflado. Esta máquina roda o Orca e uma VM em
paralelo, e o baseline de agosto (17,5 ms) foi tirado com ela ociosa. O que
sobrevive à carga é o **pareamento dentro da mesma rodada** mais os controles de
draws e triângulos; os 16,45 ms podem estar inflados na mesma proporção que o
baseline. A conclusão estrutural — a maior parte do frame é fragmento de
terreno — é sólida; o milissegundo exato não é.

O shader far tem 869 linhas de fragmento contra 856 do near e inclui os
**mesmos oito blocos GLSL** (`planet-generator.ts:1184-1237`): `TERRAIN_NOISE`,
`TERRAIN_HEIGHT_GLSL`, `TERRAIN_TEXTURE_GLSL`, `CLOUD_PATTERN_GLSL`,
`PLANET_LIGHTING_GLSL`, `TERRAIN_GRASS_AO_GLSL`, `TERRAIN_CLOUD_SHADOW_GLSL`,
`PLANET_TYPE_BIOMES_GLSL`. Um chunk a 20 km da câmera paga amostragem de
detalhe e AO de grama que ninguém tem como ver.

### A varredura de resolução concorda

| | fill (por unidade de pixel) | fixo |
|---|---|---|
| 2026-08-31 | 5,9 ms | 13,9 ms |
| 2026-09-11 | 22,51 ms | 14,2 ms |

O termo fixo praticamente não se mexeu; o frame cresceu inteiro do lado do
fragmento. Isso **corrige a 0d**, que conclui "o fill é real mas é menos de um
terço" — hoje é a maioria do frame.

### O que isso responde da 0e

A pergunta 1 ("draw calls nunca foram isolados") deixa de ser a maior pergunta
aberta. O teste de shader segurou 496 draws e 1,37 M triângulos fixos e ainda
assim moveu 16 ms: o termo dominante é fragmento, e o overhead de chamada, seja
qual for, cabe dentro dos ~14 ms de termo fixo. Isolá-lo continua não feito, mas
o teto do ganho agora é conhecido e é pequeno.

### O levantamento: qual dos oito blocos custa o quê — 2026-09-12

Feito em duas etapas independentes, porque uma sozinha não bastava. O
levantamento estático diz o que **executa**; a medição diz o que **custa**.
Onde discordassem, a medição venceria — não discordaram.

#### Etapa 1: grafo de chamadas (`client/scripts/glsl-survey.mjs`)

Roda sobre o fonte, então carga de máquina não encosta nele. Parte de `main()`
do fragmento far e só conta o que é alcançável, respeitando os desvios: a
soma ingênua dos oito blocos inventa um fragmento que não existe.

Para um chunk far num planeta rochoso (o caso real: `planetType: 'rocky'`,
`uTextureNearDistance 180` + `uTextureFadeDistance 420`, logo tudo além de
600 m):

| bloco | fetches | transcend. | alu | peso | % |
|---|---|---|---|---|---|
| `TERRAIN_TEXTURE_GLSL` | 8 | 18 | 264 | 400 | **65,5** |
| `PLANET_LIGHTING_GLSL` | 0 | 8 | 56 | 88 | 14,4 |
| main do far (bioma rochoso) | 0 | 4 | 46 | 62 | 10,1 |
| `CLOUD_PATTERN_GLSL` | 1 | 5 | 10 | 38 | 6,2 |
| `TERRAIN_GRASS_AO_GLSL` | 0 | 0 | 15 | 15 | 2,5 |
| `TERRAIN_CLOUD_SHADOW_GLSL` | 0 | 2 | 0 | 8 | 1,3 |

O peso é `fetch×8 + transcendental×4 + alu×1` — um chute sobre esta GPU, não
uma medição dela. Mas o ranking não depende do chute: o bloco de textura tem 8
dos 9 fetches **e** mais ALU que todos os outros somados.

**Três blocos incluídos no shader nunca são alcançados a partir de `main()`:**
`TERRAIN_NOISE`, `SIMPLEX_4D` e `TERRAIN_HEIGHT_GLSL`. `vHeight` chega como
varying — o ruído roda no vertex shader. Eles inflam a contagem de linhas (869
contra 856 do near) e o tempo de compilação, e custam **zero por fragmento**.
Num planeta rochoso `PLANET_TYPE_BIOMES_GLSL` também não executa: `uPlanetKind`
é uniforme, e o desvio escolhe `rockyBiome`, que mora no próprio far.

Isso invalida metade do plano que esta seção continha até ontem. Cortar
`TERRAIN_NOISE` do far não economiza nada, porque o compilador já o descartou.

#### Etapa 2: ablação pareada (`client/scripts/far-block-costs.js`)

DPR 1, walker na superfície, cena assentada, 468 draws, 5 repetições
intercaladas por alvo, mediana das diferenças pareadas. Só materiais far.

| alvo | ganho | dispersão | veredito |
|---|---|---|---|
| só os 8 `textureGrad` (`sampleBiomeTexture`) | **12,4 ms** | 2,8 | acima do piso |
| bloco de textura inteiro (`applyTerrainTexture`) | **11,1 ms** | 8,3 | acima do piso |
| controle (recompila sem mudar trabalho) | 0,1 ms | 3,6 | **piso = 3,6 ms** |
| `PLANET_LIGHTING_GLSL` | — | 6,3 | abaixo do piso |
| `TERRAIN_GRASS_AO_GLSL` | — | 18,7 | abaixo do piso |
| macro AO | — | 5,5 | abaixo do piso |
| `TERRAIN_CLOUD_SHADOW_GLSL` + nuvem | — | 27,9 | abaixo do piso |

Os dois primeiros são iguais dentro do ruído, e é esse o resultado: **os
fetches são o bloco**. O ruído em volta deles (mineral, estrata, bedPhase) não
aparece na conta.

Os quatro últimos **não foram medidos**, foram tentados: a dispersão passou do
efeito. O estático diz que são pequenos, a medição não contradiz, e nenhuma das
duas os quantifica. "Abaixo do piso" não é "zero".

Onde estão os 8 fetches: `sampleBiomeTexture` chama `sampleTerrainTexture`
quatro vezes (grama, rocha, areia, neve) e cada uma faz **dois** `textureGrad`
para descorrelacionar o ladrilho. Na faixa de transição (180–600 m) são 16, por
chamar o conjunto duas vezes para o crossfade.

#### Etapa 3: preço de cada corte (`client/scripts/far-cut-pricing.js`)

O que um bloco custa se sumir é um teto que ninguém entrega. Isto é o que cada
edição concreta compra, medido do mesmo jeito:

| corte | ganho | o que muda na tela |
|---|---|---|
| nenhuma textura de detalhe além de 600 m | **9,7 ms** | só a faixa far; perto e transição intactos |
| 1 amostra em vez de 2 por material | **7,6 ms** | mantém a textura, devolve o ladrilho visível |
| (teto: remover o bloco inteiro) | 11,1–12,4 ms | não é uma opção, é a régua |

Controle da mesma rodada: 0,7 ms, dispersão 2,1. Frame base 29,5–37,6 ms, então
9,7 ms é cerca de um terço do frame — na ordem de 33 → 50 fps.

**A escolha é de arte e é do Adriel.** Os dois cortes têm custo visual
diferente em lugares diferentes: um apaga detalhe longe, o outro deixa o padrão
se repetir perto. Nenhum dos dois é a opção segura.

#### O mecanismo para o corte já existe, e está inerte

`FAR_TEXTURE_LOD_BANDS` (`planet-renderer.ts:168`) tem cinco bandas,
`createFarLodMaterial` (`planet-renderer.ts:828`) cria um material por banda, e
`planet-renderer.ts:2123` escolhe a banda pelo LOD. Verificado no runtime:

- 5 materiais far, **1 fonte de fragmento distinta** — são o mesmo programa;
- `uTextureDetailScale`, `uTextureFarScale` e `uTextureFarStrength` aparecem
  **uma vez cada** no fragmento: a declaração. Nenhum é lido;
- os cinco materiais carregam valores diferentes (0,06 a 0,65) que nada lê.

Ou seja: a encanação por banda está pronta e passa água limpa. Um `#define` por
banda em `createFarLodMaterial` aproveita tudo que já existe — falta o corte
decidido, não a estrutura.

#### Armadilha de método: amplificar por resolução mente aqui

A primeira rodada mediu em DPR 2 para multiplicar o efeito por 4 e reescalou
dividindo por 4. Deu 6,6 ms. Medido direto em DPR 1, o mesmo alvo deu 11,1 ms.

O modelo `ganho ∝ dpr²` vale para trabalho de ALU por fragmento e **não vale
para trabalho preso a fetch de textura** — a 4× a resolução o cache de textura
se comporta de outro jeito, e a reescala subestimou por 2×. A amplificação
continua útil para **ordenar** alvos; o valor absoluto tem de sair do DPR em que
se quer a resposta.

### Etapa 4: o corte que entrou — 2026-09-12

Duas mudanças em `TERRAIN_TEXTURE_GLSL`, as duas dentro do material de terreno
e nenhuma nova uniform:

1. **`farAmount` sai por rampa.** Era `uTextureBlend * 0.42` fixo em qualquer
   distância; agora decai por `smoothstep(detailEnd, detailEnd * 2.0,
   cameraDistance)` e a faixa far pula os fetches quando sobra menos de 0,002
   de mistura. `detailEnd` é `uTextureNearDistance + uTextureFadeDistance` — o
   mesmo ponto onde o crossfade de perto termina — então a rampa começa
   exatamente onde a outra acaba, e acompanha as uniforms se alguém mexer
   nelas.
2. **Uma amostra em vez de duas nas bandas far.** `sampleTerrainTexture`
   retorna depois do primeiro `textureGrad` quando `scaleMultiplier <
   DECORRELATE_SCALE_MIN` (0,5 — entre o 0,14 da faixa far e o 1,0 da de
   perto). A segunda amostra existe para descorrelacionar ladrilho, e ladrilho
   é artefato de perto.

**Por que não o corte de 9,7 ms da Etapa 3.** Devolver `baseColor` no desvio
derruba a mistura de ~0,20 para 0 num único passo. As duas metades hoje se
encontram em `blend(baseColor, farTex, farAmount)`, então aquele corte poria um
anel visível no chão em 600 m. A rampa pega a maior parte do ganho sem a
emenda.

#### Medido ao contrário: o código novo é o baseline

DPR 1, walker assentado, 468 draws, 6 repetições com **ordem
contrabalanceada**, cada variante revertendo uma peça do que entrou:

| revertido | economiza | dispersão | variante 1º / baseline 1º |
|---|---|---|---|
| as duas peças | **7,18 ms** | 1,0 | −7,07 / −7,30 |
| só a rampa | 3,43 ms | 1,5 | −3,67 / −3,20 |
| só a amostra única | 0,88 ms | 0,7 | −0,97 / −0,80 |
| controle | 0,17 ms | 1,1 | −0,10 / −0,23 |

As duas ordens concordam em todas as linhas, o que é o sinal de que o resultado
é o efeito e não a deriva. Medido no sentido oposto (a mesma transformação
aplicada por cima do código antigo) deu 7,83 ms, então os dois sentidos fecham
dentro de 0,65 ms. **Frame 29,9 → 22,7 ms, 33,4 → 44,1 fps.**

**As peças não somam, e isso é informação:** 3,43 + 0,88 = 4,31, não 7,18. Com
a rampa desligada, tirar a segunda amostra vale 3,75 ms; com a rampa ligada
vale 0,88, porque a rampa já eliminou os fragmentos que pagariam por ela. A
segunda peça é pequena por si e fica porque não custa nada visualmente — quem
quiser simplificar, é ela que sai.

#### O que a mudança faz na tela

Diff de pixel em DPR 2 (2940×1474), **com as nuvens congeladas**
(`planet.cloudSpeed = 0`), medindo a diferença máxima por canal por pixel:

| par | dif. média | % de pixels > 8 níveis |
|---|---|---|
| piso: novo vs novo | 0,395 / 0,559 | 0,98% / 1,72% |
| **novo vs antigo** | **0,407 / 0,351** | **1,07% / 0,51%** |

A mudança cai dentro do piso: a oscilação da própria cena entre dois frames
iguais move mais pixel do que a edição. Isso é "não separável nesta câmera",
não "idêntico" — a vista tem muita areia de perto e o painel do editor cobre um
terço do quadro. Uma vista aberta para o horizonte é onde daria para ver, e o
ganho lá também é maior que os 7,18 ms medidos aqui.

**A primeira tentativa desse diff não mediu nada e quase passou por
resultado:** sem congelar as nuvens, o piso "novo vs novo" deu 13 e 27 de
diferença média, *maior* que o "novo vs antigo". A sombra de nuvem varre áreas
grandes do terreno entre uma foto e outra. Um teste cujo piso é maior que o
efeito não diz que o efeito é pequeno, diz que o teste está cego.

### Etapa 5: reprodução independente e dependência da pose — 2026-09-12

**O passo 0 reproduziu o ganho dentro do ruído: 6,87 ms contra 7,18 ms.**
Mesmo commit `b548dbc`, Chrome separado com perfil temporário e as quatro
flags anti-throttling, Apple M5/ANGLE Metal, canvas 1470×737, DPR 1, planeta
rochoso seed 67. `prepare({ plateauMs: 10000, timeoutMs: 600000 })` escolheu a
pose padrão e assentou em 132,6 s, com 468 draws e filas vazias.

Primeiro rodou só o controle: **0,03 ms**, dispersão 1,10 ms, ordens
+0,10/−0,03. Depois `priceVariants({ keys: ['control', 'revertBoth'],
repeats: 6, frames: 180, recompileMs: 2200 })`, com uma única linha de
instrumentação depois de `diffs.push`: guardar os valores locais `base` e
`cut`. Amostragem, warmup, ordem e estatística do harness original intactos.

| passo 0 | ganho assinado do harness | dispersão | variante 1º / baseline 1º |
|---|---|---|---|
| controle da rodada | +0,12 ms | 1,00 ms | +0,03 / +0,20 |
| `revertBoth` | **−6,87 ms** | 2,40 ms | −7,40 / −6,33 |

As seis diferenças da reversão foram −7,40, −7,30, −7,90, −5,50, −6,90 e
−6,20 ms. Os 468 draws se mantiveram; nenhum programa quebrado, troca de
planeta, queda do walker ou mudança de DPR. O piso desta rodada é 1,00 ms;
a distância para o resultado anterior é 0,31 ms. Médias das medianas dos seis
pares: **32,58 → 25,72 ms**. Isso reproduz o efeito, sem exigir igualdade de
frames absolutos entre sessões.

#### Método das poses

`client/scripts/far-pose-study.js` mantém as mesmas variantes far e seis pares
contrabalanceados, registra **os dois lados de cada par**, draws por frame,
triângulos, câmera e filas. Interrompe antes de `revertBoth` se o módulo da
média do controle passar de 0,50 ms. Dispersão continua sendo máximo menos
mínimo das diferenças pareadas; piso é o maior entre dispersão e módulo da
média do controle. Um efeito que não supera esse piso não é um ganho medido.

Cada pose nova passa por pelo menos 200 s de assentamento, filas vazias e
janela recente de pelo menos 10 s com draws estáveis e oscilação de frame
limitada a `max(1 ms, 6%)`. A janela é móvel: o mínimo global do `prepare`
antigo pode ter vindo do início do carregamento, quando faltava geometria, e
não garante sozinho um platô posterior.

Na reprodução, a guarda de 300 draws funciona. No vale olhando para baixo,
uma cena válida tem 256 draws; em órbita, o walker deve estar desligado. Para
essas poses, a guarda é explícita: mesmo planeta e controlador, modo da câmera
esperado, DPR/resolução constantes e estabilidade de draws dentro da pose.
Não se usa uma queda legítima de draws para fingir que a cena ainda é a padrão.

Cobertura é **estimativa geométrica**, rasterizada em 368×185 com as malhas e
vertex shaders visíveis do terreno, teste de profundidade e faixas de distância
à câmera. O denominador é o canvas inteiro. Não desconta oclusão por props,
avatar, oceano, nuvens, atmosfera ou painel do editor; não conta overdraw nem
pretende medir invocações do fragment shader. Informa separadamente material
far, >600 m e >1.200 m. A pose padrão deu 4,74% do canvas além de 600 m e
0% além de 1.200 m, com 9,86% coberto por materiais far.

**Correção da hipótese:** a mudança não começa inteira em 600 m. A rampa
atua de 600 a 1.200 m, mas a amostra única também reduz o conjunto far usado
no crossfade de 180–600 m. Além disso, `revertBoth` só altera
`farLodMaterials`; não reverte os materiais near e fallback, embora o commit
tenha mudado o GLSL compartilhado dos três. As quatro primeiras poses abaixo
medem o mesmo recorte da Etapa 4; órbita exige a comparação adicional descrita
depois da tabela.

#### Resultados por pose

Todos os tempos em ms. **Atual** é o código de `b548dbc`; **revertido** é o
mesmo frame com as duas peças revertidas no material testado. As colunas de
frame são médias das medianas dos seis pares, não uma amostra tirada depois.
Ganho é o sinal invertido de `revertBoth`; não foi corrigido subtraindo controle.

| pose | atual | revertido | ganho | dispersão | piso da rodada | terreno >600 m, estimado |
|---|---|---|---|---|---|---|
| vale, olhando para baixo | 16,63 | 16,65 | 0,02 — desprezível | 0,20 | 0,20 | 0,00% |
| superfície plana | 21,95 | 25,93 | **3,98** | 0,70 | 0,20 | 0,00% |
| crista, olhando o horizonte | 17,78 | 21,48 | **3,70** | 0,80 | 0,70 | 3,30% |
| sobrevoo a 55 m/s, altura 80 m | 17,73 | 21,52 | **3,78**, com streaming | 0,80 | 0,50 | 7,87% início / 16,30% fim |
| órbita, material fallback | 16,65 | 16,68 | 0,03 — desprezível | 0,10 | 0,10 | 27,61% |

| pose | controle assinado | ganho assinado: variante 1º / baseline 1º | draws | assentamento |
|---|---|---|---|---|
| vale | +0,02 | 0,00 / −0,03 | 256 | 200,3 s |
| plana | −0,02 | −4,00 / −3,97 | 360 | 201,8 s |
| crista | +0,10 | −3,80 / −3,60 | 330 | 220,3 s |
| sobrevoo | +0,05 | −3,60 / −3,97 | 215–434 na reversão | 227,3 s no início |
| órbita, fallback | −0,07 | −0,03 / −0,03 | 43 | 200,8 s |

As poses de terra foram escolhidas por amostragem numa região de ±6 km da
pose padrão. Comparando com oito pontos num anel de 500 m: o vale está 72,65 m
abaixo da média e a crista 125,14 m acima; na plana, a variação entre os oito
pontos é 17,72 m. Direções, yaw, pitch e câmeras de cada par estão no arquivo
de resultados. O vale tem uma árvore no primeiro plano, confirmada na captura;
não é uma vista limpa para avaliar qualidade visual.

**O voo é uma leitura com streaming, não uma ablação de geometria constante.**
É um trajeto de câmera em círculo máximo, velocidade tangencial nominal de
55 m/s, 80 m acima do terreno amostrado, seis segundos por metade do par
(~330 m). Reinicia a mesma rota depois do warmup, em vez de medir 180 frames
e deixar o lado mais lento viajar mais longe. O assentamento é no ponto de
partida; durante o trajeto, voltam a existir filas e a geometria muda. O
controle e as ordens fecham, mas não isolam quanto dos 3,78 ms veio do shader
e quanto da interação com o streaming. A cobertura é dos dois extremos, não
uma média temporal. Na conferência de resolução, >600 m deu 7,866% em
368×185 e 7,889% em 736×369; isso valida a discretização, não as oclusões
omitidas pelo estimador.

**A primeira leitura de órbita não testava o material visível.** A 37,5 km
de altitude, há só uma malha de terreno visível: a esfera de fallback.
Reverter só `farLodMaterials` deu 0,00 ms, dispersão 0,20, mas esses materiais
não cobriam pixel nenhum. Esse resultado foi guardado, sem ser usado como
medição do corte em órbita. Na comparação adicional, a mesma `priceVariants`
original recebeu `[planet.fallbackMaterial]`, a guarda passou a exigir
walker desligado e 43 draws, e o recorder guardou `base`/`cut` depois de cada
par. Controle e `revertBoth`, seis repetições, mesma amostragem e ordem. Deu
os 0,03 ms da tabela, com 43 draws, 55.100 triângulos e nenhum programa
quebrado. O harness novo seleciona fallback automaticamente em órbita e
também aceita `pricePose({ materialScope: 'fallback' })` explicitamente, para
repetir essa comparação sem remendar a lista de materiais.

#### O que a hipótese acertou, e o que ficou sem medir

O ganho depende da pose, mas **a fração visível além de 600 m não o explica
sozinha**. A plana economizou 3,98 ms com 0% de material far na imagem do
estimador; a crista tem terreno distante visível e economizou 3,70 ms. A
maior economia observada continua sendo a pose padrão, 6,87 ms. Não apareceu
o ranking presumido de que o horizonte necessariamente ganharia mais.

O custo de fragmentos que acabam ocultos é um próximo candidato a isolar:
contar só os pixels que sobrevivem ao teste de profundidade não conta todo
o trabalho rasterizado. O terreno é `DoubleSide` e usa profundidade
logarítmica, mas esta rodada **não isolou overdraw nem rejeição antecipada de
fragmentos**; isso é hipótese de investigação, não diagnóstico fechado.

Também ficaram sem medir o material near do commit completo, o custo de GPU
abaixo do limite de apresentação de ~60 Hz no vale/órbita, o impacto visual
nas poses novas e o termo fixo de ~14 ms. Nenhum corte adicional de qualidade
foi aplicado com base nestas leituras.

Dados dos pares e trajetórias:
[`client/scripts/results/far-pose-study-2026-09-12.json`](client/scripts/results/far-pose-study-2026-09-12.json).
Validação: controles nas próprias rodadas, seis pares por alvo, conferência
das médias/dispersões a partir dos pares, verificação de sintaxe do harness e
comparação da cobertura em duas resoluções.

**O ganho de frame é desprezível no vale olhando para baixo e nesta órbita.**

### Carregamento de chunk: o que mudou e o que foi refutado

Promoção incremental por quadrante entrou em `6496c55`. O portão de irmãos em
`collectLoadKeys` custava ~110 frames por nível (a frio, lod 10 só aparecia no
frame 1374), mas **é estrutural**: trocá-lo por travessia em profundidade
derruba o chão de lod 9 para lod 2. A saída foi desenhar o pai mascarado junto
com os filhos prontos, em vez de esperar os quatro.

Refutado, com medição, para não ser refeito:

| tentativa | resultado |
|---|---|
| podar a fila de carregamento ao se afastar | zero no frame (é CPU num frame de GPU) |
| memoizar `parseChunkKey` | zero no frame |
| orçamentos de CPU como campo de instância | zero no frame |
| cota de despacho para pais em colapso | pior: +11% colapsos, +7% chunks |
| `collectLoadKeys` em profundidade | chão cai para lod 2 |
| props como portão de promoção | não é o gargalo |

E a varredura de orçamento, que eu esperava que ajudasse e que piorou
monotonicamente (`client/scripts/budget-sweep.js`, walker ativo, 464 draws nas
quatro linhas):

| multiplicador | lod 8 | lod 9 | lod 10 | assentar | frame | fps |
|---|---|---|---|---|---|---|
| 1x (atual) | 7,8 s | 8,5 s | 9,3 s | 67,5 s | 21,2 ms | 47,2 |
| 2x | 16,1 | 18,3 | 21,1 | 224,7 | 35,1 ms | 28,5 |
| 4x | 44,3 | 50,1 | 54,1 | 276,9 | 31,3 ms | 31,9 |
| 8x | 43,0 | 48,3 | 51,4 | 261,6 | 31,8 ms | 31,4 |

Mais orçamento deixou a descida de LOD **mais lenta** e o fps **pior**, nas duas
pontas. O mecanismo não foi isolado; o resultado basta para não repetir. Os
defaults ficaram onde estavam.

**Sem número:** o A/B de frame time da promoção incremental. O Adriel viu a
melhora de carregamento na tela e a correção está provada por construção
(`runMaskIndexChecks`), mas `runPromotionAB` nunca rodou até o fim — uma
chamada estourou o timeout do driver e a máquina estava carregada na outra. É
uma rodada de máquina quieta, não uma investigação.

### Armadilhas de medição descobertas neste dia

Somam-se às da 0d.

1. **Meça na velocidade real do jogo.** `ship-flight.ts:30-31`: 55 m/s perto do
   chão, 380 em céu aberto, e os 12000 só acima de 0,12 raio
   (`ship-flight.ts:191`). Rodei um sobrevoo a 1400 m/s — 25× o limite real
   perto do chão — e invalidei um lote inteiro de conclusões sobre ordem de
   carregamento.
2. **O HMR do Vite ejeta o walker.** Qualquer edição de arquivo reconstrói o
   planeta, `setTargets` (`planet-walker-controller.ts:115`) desliga o walker, e
   a medição vira silenciosamente uma leitura de órbita (42 draws em vez de
   ~460). Custou três rodadas, e voltou a acontecer em 12/09 no meio deste
   levantamento. **Criar** arquivo novo em `client/scripts/` é seguro; **editar**
   um módulo que a página já importou não é. Guarde em `draws > 300`, registre
   draws por repetição (se o walker cair entre pares, as duas metades do par
   seguinte concordam em 42 e a checagem "draws iguais" passa mesmo assim) e
   não edite arquivo entre assentar e medir.
3. **Assentar exige platô de frame time, não só de geometria.** Com a checagem
   só de geometria, os baselines derivaram de 42,1 para 28,8 ms dentro da mesma
   rodada.
4. **Meça o piso de ruído na mesma rodada e imprima junto.** Com o Orca e a VM
   ligados ele chegou a 18,5 ms; numa tabela de ablação daquele dia só a
   primeira linha significava alguma coisa. Marque as outras como ruído em vez
   de as interpretar.
5. **Ordem fixa num par A/B mede a deriva como se fosse o efeito.** Medindo
   todo repeat como (variante, baseline), o controle — que recompila e não muda
   trabalho nenhum — deu +1,2 ms numa rodada e +3,6 ms na seguinte, e uma
   variante virou de +3,4 para −4,6 entre as duas. Quem mede em segundo herda a
   deriva. Alterne a ordem entre repetições (ABBA), use número par delas, e
   continue medindo o controle: ele é a checagem de que o cancelamento
   funcionou. Depois disso o controle ficou em 0,17 ms e as duas ordens passaram
   a concordar em todas as linhas.
6. **Stub de shader que reescreve a definição da função quebra a compilação** —
   e aí todas as ablações "ganham" exatamente o mesmo tanto. Pule as ocorrências
   precedidas de tipo de retorno e valide a contagem de programas.
7. **`probeSurfaceGaps` não enxerga fenda de T-junction.** Ele pergunta "existe
   chunk visível aqui", e numa fenda existe. Reportou 0 buracos no mesmo dia em
   que o Adriel viu buracos na tela. Para rachadura de borda o teste é
   `runStitchMaskChecks`, que compara o que o vizinho é informado, não o que a
   patch desenha.

---

## 0. Baseline medido na superfície — 2026-08-31

> **Superado como prioridade — ver 0f.** Tudo abaixo foi medido com
> `treeDensity 0,2`. Depois do corte para 0,08 a vegetação passou a valer ~1 ms,
> não 13,24, e a ordem de alvos no fim da seção deixou de apontar para o custo
> real. A tabela continua válida como registro do que foi medido naquele dia.

Primeira medição real deste branch. Chrome 152, Apple M5 (ANGLE Metal), modo
walk em terra firme, DPR 1 (o walker já derruba de 2 para 1 em
`planet-walker-controller.ts:262`), canvas 885x745, 941 draws, 7,0 M triângulos.

Método: A/B diferencial por frame time via CDP. Cada grupo é escondido forçando
`visible` a um getter constante — `o.visible = false` sozinho não funciona,
porque `planet.update()` reatribui a visibilidade todo frame e desfaz o teste
antes do próximo draw. Baselines pareados antes e depois de cada configuração
para cancelar deriva; dispersão do baseline ±0,11 a ±0,45 ms.

| configuração | fps | frame | ganho |
|---|---|---|---|
| baseline | 33,5 | 29,89 ms | — |
| sem folhagem | 46,5 | 21,49 ms | **8,40 ms** |
| sem sombra projetada | 40,7 | 24,56 ms | **5,33 ms** |
| sem grama | 40,4 | 24,94 ms | **4,40 ms** |
| sem props (tronco/pedra) | 40,1 | 25,26 ms | **4,29 ms** |
| sem folhagem + sem sombra | 52,0 | 19,21 ms | 10,68 ms |
| **sem vegetação nenhuma** | **60,1** | **16,65 ms** | **13,24 ms** |
| sem vegetação + sem sombra | 60,0 | 16,66 ms | 13,23 ms |

**Toda a distância até 60 fps é vegetação.** Sem ela o frame bate o teto de
vsync com folga: terreno, nuvens, oceano, atmosfera, bloom, SMAA e a cadeia de
pós inteira cabem no orçamento. Medidos separadamente, bloom e SMAA custam
−0,08 ms cada — ou seja, zero dentro do ruído.

Duas leituras que corrigem suposições anteriores:

- **O terreno é praticamente de graça.** Escondê-lo aparentava 17,05 ms, mas
  8,40 + 4,40 + 4,29 = 17,09: esconder os chunks esconde a vegetação presa a
  eles. A geometria de terreno em si não aparece na conta.
- **A sombra projetada é cara por causa da folhagem, não por si.** Sozinha
  custa 5,33 ms; depois de remover a folhagem, só 2,28 ms. O passe está
  redesenhando ~1,8 M de triângulos de cartões de folha num mapa 2048².

Alvos, em ordem de retorno medido:

1. **Folhagem (8,40 ms).** 600 objetos, 2037 instâncias, ~1,8 M triângulos —
   cerca de 900 triângulos de cartão por árvore (`winter-tree: 321 anchors, 963
   cards`; `oak-tree: 523 anchors, 1569 cards`). Alpha-test com `discard` mata
   early-Z e o overdraw de copa é alto. LOD de contagem de cartões por
   distância é o caminho.
2. **Folhagem fora do mapa de sombra (≈3 ms).** Sombra de tronco entrega quase
   toda a leitura visual; cartão de folha a 0,12 m por texel não resolve.
3. **Batching de props (4,29 ms).** 3348 instâncias em ~396 draws são 8,5
   instâncias por chamada — instanciar por chunk anula o ganho de instanciar.
   Agrupar por modelo entre chunks levaria a ~8 draws.
4. **Grama (4,40 ms)** para 800.854 instâncias em 753 draws. Batching aqui está
   bom (1063 por draw); o custo é fill. Prioridade menor que os três acima.

### Aviso sobre o profiler de GPU do HUD

`EXT_disjoint_timer_query_webgl2` existe neste backend mas **mente**: a soma das
regiões deu 54,8 ms num frame de 17,4 ms, com piso de ~7,5 ms por região (um
quad fullscreen a 0,66 MP não custa 7,46 ms). ANGLE/Metal parece medir latência
de command buffer, não trabalho. Use A/B diferencial de frame time; os números
do `gpu ...` no HUD só servem para comparar um mesmo rótulo consigo mesmo.

### Pendência separada: `planet.update` embaixo d'água

Medido submerso, com 1176 chunks visíveis: `planet.update` = **18,08 ms** de
CPU por frame (p95 24,5), contra 4,8 ms em terra. `walker.update` é 0,05 ms nos
dois casos. É um gargalo de CPU distinto do de vegetação e não foi investigado.

## 0d. O frame é limitado pela GPU, não pela CPU — 2026-08-31

Esta seção existe para impedir que a medição errada seja refeita. Anotada com a
máquina sob carga (um job de Docker rodando em paralelo), então os valores
absolutos estão inflados; as conclusões relativas e estruturais não dependem
disso.

### A armadilha

Instrumentar `performance.now()` em volta de `renderer.render()` deu **16,56 ms
num frame de 21 ms**, e eu li isso como "79% do frame é JavaScript". Está
errado. `render()` submete comandos, e quando a fila do driver enche a chamada
**bloqueia esperando a GPU**. O que aquele número mede é contrapressão, não
trabalho de CPU.

Três testes independentes confirmam que não é CPU:

| removido | trabalho cortado | efeito no frame |
|---|---|---|
| escada de LOD apertada | 760 k triângulos (−27%) | nada (rodada 1 −4,5 ms, rodada 2 +1,6 ms) |
| `scene.matrixWorldAutoUpdate = false` | ~2,4 ms de recomposição de matriz | **−0,10 ms** |
| sombra de nuvem movida para o vertex shader | `atan`+`asin`+`pow`+fetch por fragmento | pior (19,9 contra 17,2 ms) |

O teste de matriz é o mais forte: `updateMatrixWorld` medido isolado custa
0,88 ms e o render vazio cai de 1,37 para 0,14 ms sem ele — trabalho real,
removido, com zero efeito no frame.

### O que responde

Só resolução. Varrendo o pixel ratio numa cena assentada (692 draws, 2,85 M
triângulos):

| DPR | pixels | frame |
|---|---|---|
| 1,00 | 100% | 19,8 ms |
| 0,50 | 25% | 15,4 ms |
| 0,35 | 12% | 14,1 ms |

Ajustando `frame = fixo + fragmento × dpr²`: **fragmento ≈ 5,9 ms, fixo ≈ 13,9
ms**. O fill é real mas é menos de um terço. Os outros 13,9 ms não responderam
a triângulo nem a CPU — o suspeito que sobra é contagem de draw call e troca de
estado (692 draws), e isso ainda não foi testado isoladamente.

**Corrigido em 0f:** remedido em 2026-09-11, o ajuste deu fragmento ≈ 22,5 ms e
fixo ≈ 14,2 ms. O termo fixo mal se mexeu em onze dias; o fill virou a maioria
do frame. O suspeito que sobrava não era draw call, era o fragment shader do
terreno far.

### Como medir sem se enganar de novo

A cena faz streaming por 2 a 4 minutos depois de pousar. Medir antes disso
transforma carregamento em "resultado": qualquer configuração medida mais tarde
parece mais cara. Duas medições inteiras foram perdidas assim. `assentar()` em
`scratchpad/harness.mjs` só libera depois que draws e triângulos param de
crescer **e** passam de um piso mínimo — sem o piso ele aprova uma cena vazia
que ainda nem começou a carregar.

### A cena é renderizada 4× por frame

Não são 4 vezes a mesma imagem; são 4 passadas distintas sobre a mesma cena:

| passada | resolução | layer | draws | CPU em `render()` |
|---|---|---|---|---|
| cor principal | 1470×745 | 0 | 508 | 5,57 ms |
| shadow map do sol | 2048² orto | 3 | 124 | 3,48 ms |
| profundidade da nuvem | 735×372 | 1 | 2 | 3,44 ms |
| cor da nuvem | 735×372 | 1 | 2 | (as duas juntas) |

As duas de nuvem gastavam 3,44 ms para emitir 4 draws porque
`WebGLRenderer.projectObject` só poda subárvore em `visible === false` — falhar
no teste de layer ainda desce em todos os filhos. Corrigido (a passada agora
renderiza uma `Scene` enxuta apontada para os objetos que ela já coletava):
3,44 → 0,17 ms. **Não foi demonstrado ganho de frame time**, pelo motivo acima;
é folga de CPU, não fps.

O shadow map ainda paga a travessia inteira para achar 124 casters. Mesma
correção se aplica, mas a lista de casters muda a cada chunk que entra.

---

## 0e. Onde isto parou, e o que ficou por testar — 2026-08-31

Parado por decisão do Adriel: o jogo roda a 60 fps e o que restava custava
qualidade visível por ~1 ms de cada vez. Não é um beco sem saída, é um platô.

### Linha de base para comparar no futuro

Máquina ociosa (importante: com um job de Docker em paralelo os mesmos números
oscilaram 5 ms), editor, modo walk, ponto de terra no percentil 80, DPR 1,
cena assentada em **692 draws e 2,85 M triângulos**: frame ~17,5 ms. Pela
varredura de pixel ratio, fill ≈ metade do frame.

Densidades vigentes: `treeDensity 0.08`, `rockDensity 0.06`, `grassDensity
0.75`. Isso importa para ler qualquer número antigo: com `treeDensity 0.2`,
remover a folhagem inteira economizava 8,40 ms; com 0,08 economiza **1,9 ms**.
O corte de densidade rendeu mais do que todas as otimizações de código
somadas. Qualquer medição anterior a esse corte está superestimada.

### Menu de LOD, medido e fotografado

Ganho contra uma linha de base pareada tirada imediatamente antes de cada uma
(o controle — repetir a escada atual — deu 0,2 ms, que é o piso de ruído):

| escada | ganho | custo visual |
|---|---|---|
| `[227,402,557]` atual | — | — |
| `[110,220,380]` | 0,4 ms | nenhum perceptível |
| `[60,140,260]` | **1,1 ms** | copas visivelmente mais ralas a partir de ~60 m |
| `[30,70,140]` | 1,2 ms | idem, mais forte |

A escada preserva silhueta de propósito: `FOLIAGE_LOD_SIZE_BOOST` alarga os
cards conforme o tier cai. É por isso que ela corta vértices sem cortar pixels,
e por isso o ganho é pequeno num frame limitado por fill.

### O que continua sem resposta

1. **Draw calls nunca foram isolados.** São 692, e nada do que testei os
   mexeu. O único teste que tentei — esconder metade dos chunks — abriu buracos
   no céu e derrubou fill junto, além de ter rodado em DPR 2 por engano. Um
   teste válido precisa mudar a contagem de chamadas sem mudar pixels nem
   triângulos. É a maior pergunta aberta.
   **Rebaixada em 0f:** segurando 496 draws e 1,37 M triângulos fixos, só o
   shader far moveu 16 ms. O overhead de chamada cabe dentro dos ~14 ms de termo
   fixo. Continua sem ser isolado, mas o teto do ganho é pequeno.
2. **O shadow map ainda percorre a cena inteira** para achar 124 casters, pelo
   mesmo motivo que a passada de nuvem percorria (ver 0d). A mesma correção
   serve, mas a lista de casters muda a cada chunk que entra, então precisa de
   invalidação, não de um refresh a cada N frames.
3. **Early-Z na folhagem.** O `discard` do alpha test desliga o teste de
   profundidade antecipado, então todo fragmento de folha sombreia antes de ser
   descartado — exatamente o pior caso num frame limitado por fill. Nunca testei
   um depth prepass.
4. **`alphaToCoverage: alphaTest > 0` em `planet-props.ts`.** Só faz efeito com
   MSAA ligado. Nunca verifiquei se o alvo de render tem MSAA: se tiver, é caro;
   se não tiver, a linha é inerte e engana quem ler.

---

## 0b. Onde exatamente está o custo da vegetação — 2026-08-31

Segundo ponto de medição, mais denso que o de §0: 1412 draws, 9,9 M triângulos,
~42 ms de frame, 3894 objetos de vegetação. Números não comparáveis 1:1 com os
de §0 (outro local), mas as proporções internas valem.

### Decomposição do custo (24 ms de vegetação a 1,07 MP)

Variando a resolução e ajustando reta sobre três pontos (1,07 / 0,52 / 0,27 MP
→ 23,87 / 18,15 / 15,08 ms): **custo = 12,1 ms fixo + 11,0 ms por megapixel.**

| componente | ms | como foi medido |
|---|---|---|
| fill / overdraw | ~12 | inclinação da reta contra resolução |
| vértices na GPU | ~10 | resto do fixo, menos a CPU abaixo |
| submissão na CPU | 1,85 | `composer.render` com e sem vegetação, 1102 draws de diferença = 1,7 µs/draw |

**Draw call não é o gargalo.** É metade fill, metade processamento de vértice.
O vertex shader de prop faz iluminação por vértice, vento e o skirt — pesado, e
roda em ~7 M de vértices.

### Distribuição por distância (folhagem, 5,56 Mtri)

| faixa | % dos triângulos | ms | ms por Mtri |
|---|---|---|---|
| 0–50 m | 1,0 | — | — |
| 50–200 m | 18,5 | 8,89 | **3,80** |
| 200–400 m | 20,5 | 3,06 | 2,03 |
| 400–800 m | 21,1 | 2,88 | 1,70 |
| 800 m+ | 38,9 | 2,96 | 1,06 |

95% dos triângulos de folhagem estão além de 50 m e 80% além de 200 m — mas o
custo **por triângulo** cai por um fator de 3,6 com a distância, porque o que
está longe cobre poucos pixels. Cortar o desenho em 400 m devolve 5,84 ms de
40,5 (14%), não os 60% que a contagem de triângulos sugere.

### Apertar a escada de LOD rende pouco

`PROP_LOD_DISTANCE_FRACTIONS = [0.35, 0.62, 0.86]` sobre `propDistance = 2200`
deixa o tier 0 (100% dos cards) valendo até **770 m**. Testado em runtime
sobrescrevendo `resolvePropLodTier`:

| escada | tier0 até | Mtri | ganho |
|---|---|---|---|
| [0.35 0.62 0.86] (atual) | 770 m | 9,92 | — |
| [0.15 0.30 0.55] | 330 m | 8,63 | 1,69 ms |
| [0.07 0.18 0.40] | 154 m | 7,82 | 2,94 ms |
| [0.03 0.09 0.25] | 66 m | 6,54 | **6,07 ms** |

Mesmo o ajuste absurdo (tier 0 só até 66 m) tira 34% dos triângulos para ganhar
14% de frame. `FOLIAGE_LOD_FRACTIONS` termina em 0,15: a escada não consegue
descer o suficiente. **Impostor de 2 triângulos é o único degrau que falta.**

### Consequência para o plano

Nenhuma alavanca isolada fecha os ~24 ms. A ordem por retorno medido:

1. **Impostores além de ~400 m.** Ataca vértice e fill ao mesmo tempo, nos ~60%
   das instâncias que hoje custam 5,8 ms e ainda carregam geometria completa.
2. **Folhagem fora do mapa de sombra.** Medido em §0: 5,33 ms com folhagem,
   2,28 ms sem. Sombra de tronco entrega quase toda a leitura visual.
3. **Apertar a escada de LOD** para algo como [0.10 0.25 0.50]. Barato, ~3 ms,
   e complementa o impostor em vez de competir com ele.
4. **Reduzir overdraw perto** — menos cards e maiores. Ataca os ~12 ms de fill,
   mas mexe na aparência da copa e precisa de avaliação visual.

---

## 0c. Folhagem no mapa de sombra — FEITO, mas rende menos do que eu estimei

`onBeforeRender`/`onAfterRender` na malha de folhagem trocam o `drawRange` só
durante o passe de profundidade, então a copa entra no mapa no tier 3 (15% dos
cards) enquanto a câmera continua vendo o tier que a distância pede. Ajustável
via `PlanetRenderer.setFoliageShadowLodTier`; -1 tira a folhagem do mapa.

**Medido direto, contando triângulos do passe (imune à deriva térmica):**

| tier no mapa | Mtri no mapa de sombra |
|---|---|
| 0 (como era) | 0,99 |
| 3 (15% cards) | 0,72 |
| sem folhagem (-1) | 0,66 |

A folhagem é **0,33 Mtri de 0,99** — troncos e pedras são o dobro dela. A
estimativa de ~3 ms do §0 foi derivada indiretamente (`sem sombra` menos `sem
folhagem+sombra`) e estava **errada**: o efeito real é ~1 ms, abaixo do ruído
de medição. A mudança fica porque corta 27% da geometria do passe de sombra de
graça e sem diferença visível, não porque resolve o problema.

**Resolução do mapa não é alavanca.** 2048 → 512 é 16x menos fill no passe de
profundidade e não produziu mudança mensurável. O passe é limitado por
geometria, não por rasterização — o que também significa que aumentar a
resolução do mapa é mais barato do que parece.

**Aviso sobre o ambiente de medição.** Ao final desta sessão a mesma cena que
media 42 ms passou a medir 55–64 ms sem nenhuma mudança de código, e pares A/B
repetidos deram faixas de ±13 ms. Efeitos de 1–2 ms não são mensuráveis nesse
estado. Medir de novo em máquina fria antes de confiar em qualquer número
pequeno daqui.

---

## 1. Props — o subsistema mais pesado que sobrou

Todos os quatro problemas identificados foram corrigidos: backface culling e
alpha-test (1.1), LOD tiers (1.1b), raymarch de sombra fora da main thread
(1.2) e texturas (1.3). O que resta são refinamentos, não gargalos.

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

### 1.1b LOD tiers — FEITO
Tiers gerados offline com `gltf-transform weld` + `simplify --ratio 0.30
--error 0.02`, determinístico e sem custo de runtime:

Escadas autoradas, quatro tiers cada, 7,07 MB de VRAM por árvore:

| modelo | tier 0 | tier 1 | tier 2 | tier 3 |
|---|---|---|---|---|
| `oak_tree` | 3.970 | 1.032 | 275 | 90 |
| `winter_tree` | 3.774 | 1.024 | 302 | 88 |

Texturas por tier: 1024² / 512² / 256² / 128².

**Rochas voltaram** (`ROCKS_ENABLED` em `planet-props.ts`, ver §1.8). Os GLBs
entram por import dinâmico, então com a flag desligada eles saem do grafo de
módulos e nem são emitidos no build. O RNG de placement é semeado por tipo
(`${chunkKey}:${kind}`), então ligar ou desligar rocha **não move nenhuma
árvore**.

O alvo era 400–700 triângulos no tier 0 e 120–200 no tier 1; as quatro pedras
novas ficaram em 628–630 e 186–188.

Detalhes que importam se mexer nisso:
- **Os LOD herdam a matriz `normalize` do modelo base.** `loadPropModel` deriva
  essa matriz da bounding box; se o LOD derivasse a dele, a árvore daria um
  pulo na troca de tier, porque o simplificador move a caixa em ~0,02%.
- A troca é `mesh.geometry = <tier>`, reaproveitando os mesmos
  `InstancedBufferAttribute`. Placements, matrizes e valores de sombra
  sobrevivem — **trocar de tier nunca re-roda o raymarch de horizonte**.
- Geometrias por tier são construídas sob demanda e mantidas em cache: a
  maioria dos chunks só precisa de uma.
- As texturas embutidas nos GLB de LOD foram reduzidas a 8×8 porque só a
  geometria é lida — o material vem sempre do modelo base.
- Limiar em `PROP_LOD1_DISTANCE_FRACTION` (0,35 da distância de exibição, ~227m
  no game) com 12% de histerese. O histograma de tiers está exposto em
  `visibleLayersByLod` nos stats de debug, para calibrar contra o que está
  realmente na tela.

### 1.1c Convenção de assets de prop
Modelos com múltiplos tiers vivem num diretório por modelo, com os arquivos
nomeados `lod_0.glb` … `lod_N.glb` — **numerados pela contagem de triângulos**,
não pelo nome que o gerador deu. Exportadores costumam mentir: os quatro tiers
do carvalho chegaram como `lod_100`, `lod_100`, `lod_300` e `lod_0`, sendo os
valores reais 91, 1.044, 309 e 3.990.

**A pegadinha que importa:** tiers exportados independentemente por um gerador
(Meshy e afins) re-assam o próprio atlas — os UVs deles **não** batem com o do
modelo base. Emparelhar a textura do tier 0 com a geometria do tier 2 nesse caso
dá lixo. Já tiers produzidos decimando um mesh (`gltf-transform simplify`)
preservam os UVs e devem reusar o material base.

Não dá pra detectar isso do arquivo com confiança, então é declarado por asset
em `PropLodSpec.ownMaterial`. As duas árvores usam `true` em todos os tiers; um
tier decimado do mesh base usaria `false`.

**Importação:** use `node scripts/import-prop-lods.mjs <diretório>`. Ele ordena
por contagem de triângulo (não pelo nome), remove os mapas que o shader não lê,
poda, redimensiona por tier e **só apaga os originais depois que as quatro
saídas validam**.

Consequência: `updatePlanetPropMaterials` tem de percorrer **todos** os tiers,
senão props distantes ficam sem posição do sol, sombra de nuvem e tinta de
atmosfera.

Higiene de textura no import:
- Só a base color é lida pelo shader. `normalTexture`, `metallicRoughnessTexture`
  e afins devem ser removidos do material e podados — o carvalho chegou com
  10,4 MB de normal map e 1,4 MB de metallic-roughness que o `GLTFLoader`
  decodifica e o shader nunca amostra.
- Uma resolução por tier, acompanhando a faixa de distância:
  1024² / 512² / 256² / 128². A escada inteira do carvalho fica em **7,07 MB de
  VRAM** e 1,1 MB em disco, contra ~102 MB dos exports crus.

**Oportunidade registrada:** os modelos vêm *com* normal map. O shader de props
não usa nenhum e a iluminação é por vértice (`vLight`, `planet-props.ts:333`).
Adicionar normal mapping seria um upgrade visual maior do que qualquer
geometria extra — e permitiria alvos de triângulo mais baixos ainda.

### 1.2 Raymarch de sombra — FEITO
`computeHorizonSunLight` rodava 10 amostras de `samplePlanetHeightDetailed` por
instância, no main thread, durante a integração do chunk. Medido no worker
depois da mudança: **6,8 a 66,6 ms por camada de 33 instâncias** — bem acima dos
~4,4 ms/chunk que a auditoria estimou.

A computação é pura (lê só os arrays de placement, a direção do sol e os params
de terreno), então foi extraída inteira para `prop-sun-light.ts`, compartilhada
verbatim com o worker.

- **Um job por camada**, não por placement: camada é a unidade que nasce, morre
  e é invalidada, então rastrear staleness por camada mantém o bookkeeping
  honesto.
- **Um worker dedicado**, não um pool. Resultados que chegam tarde são
  descartados e re-pedidos; oversubscrever mataria o streaming de terreno
  (ver secção 2).
- No `attachPropLayer` a camada é iluminada com o **termo de normal apenas**
  (`skipHorizon`), que é praticamente grátis. Ela continua se reportando como
  stale, então o job real refina logo em seguida — árvores nunca aparecem
  pretas, e nada disso entra no orçamento de 2,5 ms de integração de chunk.
- Fallback preservado: sem `Worker`, com o worker em erro, ou com a fila cheia
  (`MAX_PROP_SUN_IN_FLIGHT`), cai no caminho main-thread orçado em 2 ms/frame.

Verificado bit-idêntico ao HEAD em 10.800 instâncias (3 presets × 4 direções de
sol, incluindo sol rasante onde o raymarch domina).

**Ainda não feito:** o early-out analítico. `blocker` só pode ficar não-zero se
algum `obstacleSlope` exceder `stylizedSunSlope - 0.015`; um limite por planeta
de slope alcançável colapsaria o caso diurno comum num compare. Agora que o
custo está fora da main thread isso virou otimização de latência, não de frame
time.

### 1.3 Texturas — FEITO
85,1 → 21,3 MB de VRAM. Ver secção 3.

---

### 1.4 Folhagem procedural — FEITO

As árvores são tronco e galhos de propósito: as folhas são geradas na engine
para que quantidade, tamanho, cor, balanço e translucidez sejam parâmetros vivos.

Como funciona (`tree-foliage.ts`):

1. **Âncoras** vêm só do `lod_0`. Para cada vértice soldado por posição, o raio
   local do galho é estimado por PCA numa vizinhança (`estimateLocalRadii`) —
   nos assets reais isso separa p05 de p95 por 6.6x, que é o sinal usado.
   Rejeição de Poisson espalha as âncoras pelos galhos.
   **Não dá para fazer isso nos tiers baixos**: oak `lod_2` tem 153 posições
   distintas e o estimador devolve zero na maior parte da malha.
2. **Cards** são quads gerados por âncora, embaralhados deterministicamente para
   que *qualquer prefixo* da lista seja uma amostra espacialmente uniforme.
3. **LOD é `setDrawRange`**, não troca de geometria. Por isso o embaralhamento
   importa: truncar em ordem de score depenaria um lado da árvore.
4. **Atlas de folha** é desenhado num canvas no load. Textura em vez de silhueta
   analítica porque só textura tem mipmap, e sem mipmap folha alpha-testada
   pequena serrilha muito.

Medido: oak 523 âncoras → 1569 cards, winter 295 → 885. 34 árvores num chunk
saem em **4 draw calls** (2 troncos + 2 folhagens).

Armadilhas que custaram tempo:

- **`MAX_VERTEX_ATTRIBS` é 16.** A primeira versão usava atributos separados
  para `uv`, `leafAxisY`, `leafCorner` e `leafHash` e batia em exatamente 16 com
  `instanceMatrix` (4) mais os 6 por instância — o programa não linkava, com
  "Too many attributes". Hoje corner, célula do atlas e hash dividem um `vec4`,
  o segundo eixo do card sai de `cross(leafAxisX, normal)` e a uv é calculada no
  shader. Ficou em 14. **Sobram 2 slots**: qualquer atributo novo em prop
  precisa caber nisso.
- **Um shader que não compila ainda conta triângulos** em `renderer.info`. Custou
  duas rodadas até eu capturar o console do headless.
- **O vento tem que ser a mesma função nos dois materiais.** Tronco e folha
  chamam `propWindSway` com os mesmos argumentos no mesmo ponto; qualquer
  divergência faz as folhas escorregarem do galho durante a rajada. Por isso
  `PROP_WIND_STIFFNESS` vive em `prop-shading.ts` e não em nenhum dos dois.
- **Cor é por espécie, não global** (`FoliagePalette` ao lado de `heightRange`).

### 1.5 Geometria compartilhada entre chunks — FEITO (achado no caminho)

`buildTierGeometry` fazia `geometry.clone()` por chunk, e
`BufferAttribute.clone()` copia o array: **cada chunk carregava e subia sua
própria cópia da malha da árvore** — 121 KB por oak por chunk, por tier já
visitado. Com folhagem por cima ia multiplicar.

Agora `buildInstancedGeometry` referencia os atributos da fonte e só acrescenta
os atributos instanciados. O contrapeso é `disposeInstancedGeometry`: os
atributos compartilhados são **desanexados antes** de `dispose()`, senão o
primeiro chunk a sair de cena apagaria os buffers que o resto do planeta ainda
está desenhando — e eles voltariam a subir no frame seguinte, para sempre,
conforme os chunks entram e saem.

Isso é seguro só porque os nomes não colidem: fonte usa `position`/`normal`/
`uv`/`leafAxisX`/`leafData`, instanciados usam o prefixo `instance`.

### 1.6 Folhagem — o que ficou de fora

- **Atlas de agulha para o conífero: descartado.** O mesmo atlas de folha larga
  serve as duas espécies e vai continuar assim — decisão do dono do projeto, não
  pendência.
- **`alphaToCoverage` continua inerte.** O SMAA do §5 é pós-tonemap e não
  destrava isso; precisaria de MSAA de verdade, e aí folhagem seria o primeiro
  lugar a se beneficiar.
- **Sem fade por distância nos cards.** O LOD corta em degraus via draw range;
  um fade de tamanho no último tier tiraria o pop.

### 1.7 Raízes flutuando em encosta — FEITO

Árvore em terreno inclinado ficava com as raízes no ar do lado de baixo. Não era
uma coisa só, eram três, medidas em cima das malhas de verdade:

1. **A causa principal, geométrica.** A base do oak é um disco de raio **0,156
   da altura da própria árvore** — a saia de raízes é larga. A árvore fica quase
   na vertical na encosta de propósito (`lerp(radial, normal, 0.18)`: ela cresce
   pro céu, não perpendicular ao morro), então o eixo dela e o do chão discordam
   por um ângulo `a` e a borda de baixo do disco sobe `raio * sin(a)`. Oak de
   13 m numa encosta de 20°: **0,73 m de luz do dia embaixo da raiz.** O winter
   tree da época, um cilindro de base 0,037, mal aparecia — o problema era quase
   todo do oak. Foi essa assimetria que apontou pra saia de raiz como causa.
2. **O pivô estava na copa.** `normalize` centrava o modelo em x/z pelo
   *bounding box*, que segue a copa: no oak isso põe a origem a 0,05 da altura
   de distância do próprio tronco. O `spin` aleatório então jogava esse offset
   pra uma direção diferente em cada árvore — na encosta, umas ficavam 25 cm
   mais altas e outras enterravam o mesmo tanto. Daí a inconsistência entre
   vizinhas. Agora `measureBasePivot` centra pela base.
3. **`sampleSurface` amostrava a superfície errada.** A malha do chunk divide
   cada célula na diagonal i10–i01; interpolar os quatro cantos de uma vez
   amostra o *patch bilinear*, que descola dos triângulos por um quarto do twist
   da célula. Em chunk grosseiro (props existem até `maxLod - 4`, células ~16×
   maiores) isso sozinho já pendura a árvore acima do chão em que ela foi
   plantada. Agora é baricêntrico no triângulo certo.

O `+0.08` de *levantada* que existia antes só piorava os três.

**Afundar a árvore não era a resposta.** Foi a primeira tentativa: descer o prop
por `baseRadius * escala * sin(a)`. Fecha a folga, mas pra fechar 0,73 m enterra
1,03 m morro acima — mais do que a saia inteira do oak, que tem 0,78 m de
altura. Some justamente a raiz que se queria ver.

**A resposta é a mesma das folhas: contato com o chão é da engine.** O vertex
shader do tronco agora *deforma a base* em vez de descer a árvore. Em chão
plano um vértice fica exatamente `position.y * scaleY` acima da superfície; o
desvio disso é a luz do dia. O shader cancela o desvio no fundo da malha e
solta o cancelamento subindo o tronco (`PROP_SKIRT_BAND = 0.12`, folgado o
bastante pra passar da saia de 0,06 sem vincar). A saia de raiz acompanha a
inclinação; nada afunda.

Medido varrendo o `spin` em 24 ângulos sobre a saia inteira:

| modelo | encosta | folga antes | folga afundando | enterro afundando | folga skirt | enterro skirt |
|---|---|---|---|---|---|---|
| oak 13 m | 20° | 0,73 m | 0,12 m | 1,03 m | **0,00 m** | **0,21 m** |
| oak 13 m | 30° | 1,03 m | 0,24 m | 1,45 m | **0,00 m** | **0,29 m** |
| winter 22 m | 20° | 0,95 m | 0,08 m | 1,31 m | **0,00 m** | **0,30 m** |
| winter 22 m | 30° | 1,37 m | 0,22 m | 1,83 m | **0,00 m** | **0,39 m** |

Sanidade do harness: em 0° de encosta a folga "antes" dá exatamente 0,08 m — a
levantada antiga. O enterro que sobra no skirt é a saia morro acima passando
abaixo do plano, que é o certo: é a árvore abraçando a encosta.

Sobrou só `PROP_GROUND_BIAS` (0,006 da altura) pra base nunca ficar exatamente
coplanar com o terreno.

**O pine ganhou raiz depois disso, e nessa ordem.** O winter tree foi
regerado com saia (raio da base 0,037 → 0,102), o que sob o código antigo teria
sido *pior* que o oak: 0,95 m de folga a 20°, 1,37 m a 30°. É o skirt que torna
o modelo com raiz viável — sem ele, dar raiz a um conífero de 22 m só aumentaria
o buraco. A escada nova é 4202/1025/407/91 triângulos e o anel de contato
sobrevive à decimação (largura da base 0,203–0,212 nos quatro tiers), que era o
risco real: o skirt só ancora o que estiver no `y` mais baixo da malha.
Folhagem sem ajuste nenhum — `extractBranchAnchors` deu 321 anchors / 963 cards
contra 295 / 885 do modelo antigo.

Eu escrevi aqui que valeria pra rock "sem nada a mais". Estava errado — a
banda constante de 0,12 quebra em prop achatado. Ver §1.8.

**O que ficou de fora:** a normal não é recalculada depois da deformação, então
o sombreado da saia fica levemente errado na encosta — é a parte mais escondida
da malha e não apareceu em teste. E o plano tangente é uma aproximação de
primeira ordem: terreno muito rugoso dentro da pegada da árvore ainda deixa
resíduo.

### 1.8 Pedras de volta — FEITO

Quatro pedras novas, duas tiers cada. Três coisas mudaram junto, e nenhuma foi
escolha estética: as três caíram das medições.

**1. Os 8 arquivos não eram uma escada.** Eram 4 pedras × 2 tiers. Rodar o
`import-prop-lods.mjs` na pasta teria produzido `lod_0..lod_9` de uma pedra
fictícia. E os nomes não pareavam — `Meshy_AI__…025821` parece a `rock_1` e é a
`rock_3b`. Pareei por forma (proporção da caixa normalizada + altura do
centroide, ambas preservadas pela decimação): a distância do par certo ficou em
0,033–0,057 contra 0,346–0,877 do segundo colocado, 6–25× de separação.

**2. A banda do skirt não podia ser constante.** `PROP_SKIRT_BAND` era 0,12 da
altura, escolhido pra passar da saia de raiz do oak. Mas a correção que o shader
precisa aplicar escala com o quanto a base *avança de lado*, enquanto a banda
escalava com a *altura* — e a laje (`rock_4`) avança 2,9 da própria altura.
Espalhar 44% da espessura dela sobre um doze avos dela teria rasgado a malha.

Agora a banda vem do modelo: `max(baseRadius, PROP_SKIRT_MIN_BAND)`, uniform
por material, escrito uma vez na carga. Isso mantém o *ângulo* de cisalhamento
constante em vez da distância. Sem teto: passando da altura do modelo a
correção deixa de ser dobra e vira rotação da malha inteira sobre o plano do
chão — que é exatamente o que uma pedra chata quer, e só um prop mais largo na
base do que alto chega a pedir.

Árvore quase não sente (banda do oak 0,12 → 0,133, do pine continua no piso).
Pedra sente tudo:

| pedra | baseRadius | banda | contato a 45° antes | depois |
|---|---|---|---|---|
| rock_1 | 0,448 | 0,448 | 0,00 m | 0,00 m |
| rock_2 | 0,744 | 0,744 | 0,00 m | 0,00 m |
| rock_3 | 1,066 | 1,066 | 0,13 m | **0,00 m** |
| rock_4 | 2,924 | 2,924 | 0,33 m | **0,00 m** |

**3. A escala de pedra estava dimensionada pela altura.** Com `scale.y =
rockHeight * squash` e jitter horizontal até 2,6× em x e 2,2× em z, a laje 6,2:1
virava uma panqueca de **40 m**. Aquele jitter existia pra fingir variedade a
partir de duas malhas; quatro malhas cobrindo de 1,0 a 6,2 de proporção já
carregam isso. Agora a pedra é dimensionada pela **maior dimensão**
(`rockSize / max(model.width, 1)`), com só ±17% de estica pra quebrar
repetição. A `ROCK_HEIGHT_RANGE` virou `ROCK_SIZE_RANGE` e finalmente é lida de
`model.heightRange`, em vez de o intervalo estar duplicado hardcoded dentro de
`buildKindPlacements`.

Em `rockSize` 5,5 m as quatro dão 5,5 × 5,5 / 5,5 × 3,4 / 5,5 × 2,3 / 5,5 × 0,9
metros — bola, achatada, baixa e laje.

**Pedra também quer ficar encravada.** Um matacão apoiado exatamente no vértice
mais baixo lê como largado ali. `PROP_GROUND_BIAS` virou dois números: a árvore
segue com o fio de cabelo (0,006 da altura, porque enterrar tronco esconde a
raiz que faz ela parecer plantada) e a pedra afunda 0,06–0,20, sorteado por
instância pra um campo delas não parecer carimbado.

**Custo:** 1024² no tier 0 (paridade com as pedras antigas — §3 já registrava
que o jogador chega perto), 256² no tier 1, que só entra a partir de 227 m onde
uma pedra de 5 m tem ~23 px. 5,65 MB de VRAM por pedra, 22,6 MB nas quatro. Cair
pra 512²/256² levaria a 6,6 MB se pesar.

### 1.9 Dispersão cai 256× com a distância — NÃO FEITO

Densidades baixadas a pedido para `treeDensity 0.2` / `rockDensity 0.15`. Mas o
número de densidade **não é a alavanca** que parece ser, e vale registrar por quê
antes de alguém mexer nele de novo.

`buildKindPlacements` calcula quantos props colocar a partir da contagem de
*células da grade*, que é constante em 1024 (`(gridSize - 1)²`), e não da **área**
do chunk. Só que o chunk quadruplica de área a cada nível de LOD, e prop existe
de `maxLod` até `maxLod - 4`, com `propDistance` de 2200 m no editor. Resultado,
com R=50000 e as densidades novas:

| lod | chunk | faixa de câmera | área | árvores | árv/ha | espaçamento |
|---|---|---|---|---|---|---|
| 11 | 49 m | 50–125 m | 0,24 ha | 7 | 29,4 | 18 m |
| 10 | 98 m | 125–313 m | 0,95 ha | 7 | 7,3 | 37 m |
| 9 | 195 m | 313–781 m | 3,81 ha | 7 | 1,8 | 74 m |
| 8 | 391 m | 781–1953 m | 15,3 ha | 7 | 0,46 | 148 m |
| 7 | 781 m | 1953 m+ | 61 ha | 7 | 0,12 | 295 m |

**256× de queda dentro do alcance visível, em degraus de 4×.** Floresta fechada
no pé, árvores avulsas no meio, horizonte vazio. Baixar a densidade global
multiplica as cinco faixas igualmente — a razão entre elas não muda.

E tem um segundo problema no mesmo lugar: o RNG é semeado com
`nodeKey(face, lod, x, y)`, que **inclui o lod**. Chunk pai e filhos sorteiam
posições sem relação nenhuma, então dividir um chunk não refina a distribuição:
**reembaralha todas as árvores daquela região de uma vez**. O pop ao andar não é
só de quantidade, é de posição.

Caminhos, do mais barato ao mais certo:

1. **Escalar `targetCount` pela área do chunk.** Uma linha, mas esbarra em
   `MAX_TREE_INSTANCES_PER_CHUNK = 34`: manter 29 árv/ha num chunk de lod 9
   pediria 112 instâncias, e de lod 7, 1793. O teto existe pra limitar o
   raymarch de sombra (§1.2, ~3,4 ms por chunk) — escalar sem mexer nele só
   move o degrau de lugar.
2. **Encurtar `propDistance`** pra caber em menos faixas de LOD. Resolve por
   remoção, ao custo do alcance de vista.
3. **Tirar o placement do chunk de terreno.** Grade virtual de tamanho fixo
   (ex. 100 m) independente do LOD: densidade uniforme por construção e o
   reembaralhamento some, porque a célula não muda quando o terreno divide. É a
   resposta certa e a mais cara — hoje a camada de prop pertence ao chunk, é
   anexada em `chunk.mesh` e some junto com ele.

## 1.10 Sombra projetada de props e player — FEITO

Props e player agora projetam sombra no terreno. Pedido do dono do projeto, e o
que substituiu o atlas de agulha como próximo item visual.

**Não é o `WebGLShadowMap` do three.** Aquele sistema exige que o material
*receptor* carregue a UBO de luzes e os chunks de sombra, e aqui toda superfície
é `ShaderMaterial` escrito à mão com iluminação própria — prop sombreia por
vértice, terreno por fragmento via `applyPlanetLighting`. Adotar as sombras do
three significaria adotar o modelo de luz dele inteiro. Ter o passe custa um
render ortográfico de profundidade e uma matriz.

**Receptor.** A iluminação do terreno é por fragmento e as três variantes de
material passam pela mesma `applyPlanetLighting`, então o ponto de inserção é
único: um multiplicador em `softDirect`, deixando o ambiente intacto — a sombra
da árvore lê como sombra, não como buraco no chão. Os uniforms são objetos
compartilhados mutados no lugar, então cada material só faz `...getSunShadowUniforms()`
na construção e nunca precisa de update próprio.

**Caster.** Os casters desenham com **o próprio material** no depth pass, não com
um material de profundidade substituto. Isso dá de graça: o vento do tronco, a
saia de chão do §1.7, o draw range de LOD da folhagem e — o que mais importa — o
`discard` de alpha-test da folha, que é o que faz a sombra ter formato de folha
em vez de retângulo por card. Um material substituto teria que duplicar tudo
isso e desalinharia na primeira vez que qualquer um fosse ajustado. Quem entra é
escolhido por layer (`SUN_SHADOW_CASTER_LAYER`), habilitada *além* da principal,
e a câmera de sombra só enxerga essa layer — terreno, oceano, nuvem e skybox
nunca entram no passe.

O chunk de logdepth do three não atrapalha: `vIsPerspective` faz o fragment cair
em `gl_FragCoord.z` quando a câmera é ortográfica.

**Dois bugs achados por teste, não por leitura.** Escrevi um teste em node com
um renderer falso (three faz a matemática sem GL) que projeta o topo de um
caster e o ponto do chão onde a sombra dele deve cair, e exige que os dois caiam
no mesmo texel:

1. `_up` vinha de `focus.normalize()`. Isso só é o radial do planeta se o
   planeta estiver na origem do mundo — e estes planetas orbitam. Com foco na
   origem ainda degenerava o `lookAt` de vez. Dava 73–119 texels de
   desalinhamento. Agora o up vem da direção do sol.
2. **Sem snap de texel.** A caixa seguia a câmera continuamente, então o mapa
   deslizava uma fração de texel por frame e toda borda de sombra rastejaria.
   Agora o foco é arredondado para múltiplos de texel no espaço da luz.

Depois: 13 asserções passando em elevação de sol de 20°, 35° e 60°, com foco em
posição de planeta em órbita — alinhamento em 0,000 texel, profundidade na ordem
certa, tudo dentro de [0,1], ponto a 500 m saindo da caixa, e raio 180 m cobrindo
exatamente o dobro de 90 m.

**Custo e ajustes.** 2048² cobrindo 120 m de raio dá ~0,12 m por texel, o que
resolve tronco. PCF 3×3, bias que escala com o quanto o sol está rasante (bias
constante gera acne em superfície de canto), e fade nos 18% externos da caixa
para não arrastar um retângulo de sombra pelo chão. Em órbita não há caster no
alcance e o passe degenera para um clear. Exposto no editor em *Diagnostics* com
liga/desliga, força, raio e resolução.

**Não verificado visualmente.** O SwiftShader desta máquina não completa um
frame nem da página isolada de sombra (`client/shadow-preview.html`, que não
carrega GLB nenhum) — o problema é o headless, não a cena. A matemática está
testada; o que não está é como fica na tela: bias, força e raio são justamente
os números que se ajustam olhando.

**Fora do escopo:** grama não projeta (seria ruído a 0,12 m por texel), props
não recebem sombra de props (só o terreno recebe), e não há cascata — fora dos
120 m não há sombra projetada, só o raymarch de horizonte do §1.2.

---

## 2. Pool global de workers — FEITO

`initTerrainWorkers` criava até `min(8, threads - 1)` workers **por
PlanetRenderer**, e `celestial-system.ts` cria um renderer para **todo corpo que
tem planet params** — cinco no sistema semeado (Mercúrio, Vênus, Terra, Marte,
Júpiter), sem nenhum gate de distância. Numa máquina de 10 threads isso era
**5 × 8 = 40 module workers vivos desde o primeiro sync**, cada um com sua
própria cópia do bundle de terreno, todos disputando os mesmos núcleos — para um
jogador que só pode estar em cima de um planeta por vez.

E os outros quatro não estavam nem trabalhando: assim que a quadtree de um
planeta distante assenta, ele para de pedir chunk. Eram 32 workers ociosos e
caros.

Isso já tinha evidência medida na paralelização do oceano:

| fatias | wall | maior fatia | trabalho real por fatia |
|---|---|---|---|
| 6 | 1748 ms | 1338 ms | ~380 ms |
| 3 | 1875 ms | 1479 ms | ~760 ms |

O número de fatias quase não importava porque o gargalo já era disponibilidade
de CPU — que é exatamente o sintoma de 40 workers em 10 núcleos.

Agora existe `terrain-worker-pool.ts`, um pool único de módulo. Renderer não
possui mais worker: ele **aluga** um por job e o pool devolve o slot sozinho
quando a resposta chega.

O detalhe que não é óbvio é a separação entre `busy` e `owner`. Quando um
renderer é descartado com job no ar, ele solta o *lease* mas o worker continua
calculando; marcar esse worker como livre entregaria a resposta pendente ao
handler do próximo dono. Então `releaseTerrainWorkersFor` limpa só o dono e os
handlers, e o slot se libera de fato quando a resposta aterrissa e cai num
handler nulo. Matar o worker seria pior: custaria um respawn de module worker
inteiro para poupar poucos ms de trabalho que ninguém espera.

`dispose()` também deixou de chamar `terminate()` — os workers são de todos os
planetas agora.

Verificado com um `Worker` falso em node, 9 asserções: cinco renderers geram 8
workers e não 40; o lease satura em 8 e devolve null; a resposta chega ao dono
certo; worker ocupado não é reentregue; resposta órfã é descartada em vez de
vazar pro dono seguinte; e encolher o pool preserva quem está ocupado.

**Não feito: prioridade por distância.** O backlog pedia, e continua sendo o
certo em teoria, mas vale menos do que parece — planeta distante para de pedir
chunk quando a quadtree assenta, então na prática o pool inteiro sobra pro
planeta debaixo do jogador. O que resta é um transiente de boot, onde os cinco
disputam as primeiras chunks na ordem em que `update()` os visita. Se um dia
incomodar, o formato é o pool receber jobs com prioridade em vez de os renderers
puxarem slots.

---

## 3. Assets — FEITO (parcialmente)

Redimensionados com `gltf-transform resize --filter lanczos3` para 1024², e a
textura do astronauta reconvertida para JPEG q92.

| asset | antes | depois | |
|---|---|---|---|
| `rock_1.glb` | 4,03 MB | 0,32 MB | 12,7× |
| `rock_2.glb` | 4,36 MB | 0,35 MB | 12,4× |
| `winter_tree.glb` | 5,03 MB | 1,02 MB | 5,0× |
| `oak_tree.glb` | 5,31 MB | 0,95 MB | 5,6× |
| `astronaut` (PNG→JPEG) | 6,72 MB | 1,26 MB | 5,3× |

- **VRAM de props: 85,1 → 21,3 MB.** `dist` inteiro: 32 MB → 11 MB.
- Geometria preservada exatamente — contagens de vértice e triângulo conferidas
  contra os valores originais nos quatro GLB.
- 1024², não 512², mesmo nas rochas: o jogador pode chegar perto delas.
  Combinado com anisotropia 16 (aplicada em `sourceMaterialMap`), 1024²
  resolve **mais** detalhe do que os 2048² originais resolviam a 1×.
- `astronaut.jpg` mantém 2048², então a VRAM dele não mudou — o ganho é de
  download. O PNG era colorType 2 (RGB, sem alpha) e o shader lê só `.rgb`,
  então não havia canal empacotado a perder.
- Anisotropia do avatar subida de 4 para 16, alinhando com terreno e props.

### Ainda pendente

**`astronaut.fbx` carrega 2,7 MB de mídia embutida.** Um `Video/Content` que o
`FBXLoader` transforma em blob URL e decodifica — e `prepareModel` substitui
todos os materiais três linhas depois, descartando o resultado. É a mesma
textura já servida separadamente. Reexportar sem mídia embutida levaria
3,4 MB → ~645 KB.

**Não** tente resolver em código com `URL.revokeObjectURL(map.image.src)`:
`map.image` ainda é null nesse ponto, o `TypeError` é engolido pelo catch, e o
astronauta nunca aparece. É edição de asset, não de código.

**KTX2** continua na mesa se quiser mais: cortaria a VRAM outros 4-8×. Use
**UASTC + Zstd** — ETC1S é visivelmente blocado em albedo ruidoso de rocha.

**Peso de repositório:** os arquivos do `pathfinder_spaceship` (20,2 MB) não são
importados por nenhum módulo. Como o Vite só empacota o que é importado, isso
nunca esteve no bundle — mas está no clone.

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

## 5. Antialiasing — FEITO (SMAA pós-tonemap)

`RenderPass` rasteriza em alvos com `samples = 0` (`engine.ts`), e antes deste
commit nada além do quad do `OutputPass` chegava ao framebuffer — ou seja, não
existia AA nenhum. `antialias: false` no renderer continua certo pelo mesmo
motivo de sempre: MSAA no backbuffer não teria aresta nenhuma pra resolver.

As duas rotas avaliadas eram MSAA no composer (`samples: 2`) e um pass
pós-tonemap. Ficou o segundo, como a análise original recomendava: MSAA
obrigaria **os dois** alvos a serem multisampled, porque a paridade de swap é
dinâmica (`needsSwap = hasClouds`, `UnderwaterPass.enabled`), o que sai em
RGBA16F multisampled em DPR 2 com até 4 resolves por frame.

`SMAAPass` entra **depois** do `OutputPass`, de propósito: SMAA detecta aresta
por luma e quer a imagem tonemapeada em LDR, não o alvo HalfFloat da cena. Os
alvos do composer seguem single-sampled e o depth read do cloud pass fica
intacto.

Dois detalhes que custaram leitura de fonte:

- **`setSize` manual na construção.** `EffectComposer.setSize` multiplica pelo
  pixel ratio e repassa pros passes, mas só roda sobre os passes que já existem.
  Pass adicionado depois nunca recebe um — e SMAA sem resolução de device
  caminha a busca de aresta na distância errada de texel. O `UnderwaterPass` já
  tinha a mesma linha pelo mesmo motivo.
- **Desligar não apaga a tela.** `EffectComposer.render` faz
  `pass.renderToScreen = (this.renderToScreen && this.isLastEnabledPass(i))`,
  então `smaaPass.enabled = false` devolve a tela pro `OutputPass` sem mais nada
  a mudar. Conferido no fonte do three 0.184, não assumido.

As duas texturas de lookup do SMAA são base64 inline, então nada é buscado da
rede — mas decodificam de forma assíncrona, então os primeiros frames passam
sem AA em vez de travar.

Exposto no editor como *Diagnostics → Antialias (SMAA)*, ligado por padrão, e
o HUD de diagnóstico mostra `aa=smaa|off`.

**Não medido:** o custo (a estimativa de 0,2–0,4 ms a 1080p é da análise
original, não medida aqui) e o resultado visual — o SwiftShader desta máquina
não completa um frame da cena.

`alphaToCoverage` continua ligado em grama e props e **continua inerte**: os
dois shaders escrevem alpha constante 1.0 e resolvem silhueta por `discard`
binário, e post-AA não muda isso — ele precisa de MSAA de verdade. Se um dia
existir, separar cobertura de silhueta do fade (dobrar o fade na cobertura vira
screen-door de 4 níveis).

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

### Os scripts que existem hoje — `client/scripts/`

Rodam no console do editor, sem build: `await (await
import('/scripts/<arquivo>')).<função>()`. Todos leem `window.__nmsEditorDebug`.

| script | função | o que responde |
|---|---|---|
| `mask-index-checks.js` | `runMaskIndexChecks` | 23 asserções de álgebra de índice: mascarar um quadrante remove exatamente aquele quadrante, e as quatro máscaras particionam a patch. Sem timing — responde em máquina carregada. |
| `mask-index-checks.js` | `runStitchMaskChecks` | 5 asserções sobre o que o vizinho é **informado**. É o único teste que pega fenda de T-junction; foi provado que discrimina a regressão que ele existe para pegar. |
| `glsl-survey.mjs` | `node client/scripts/glsl-survey.mjs` | levantamento estático: grafo de chamadas a partir do `main()` do fragmento far, com desvios respeitados. Roda no fonte, imune a carga de máquina, e é o único que enxerga bloco incluído mas nunca alcançado. |
| `far-block-costs.js` | `prepare`, `runFarBlockCosts` | custo por bloco GLSL, pareado e intercalado, com controle que recompila sem mudar trabalho. `prepare` é separado porque assentar leva minutos e o eval do CDP tem timeout. |
| `far-cut-pricing.js` | `priceCuts` | preço de cada corte concreto, não do bloco inteiro. Aborta se o trecho a reescrever não existe mais -- um `replace` que não casa devolve a fonte intacta e reporta o ruído como ganho. |
| `far-band-variants.js` | `priceVariants`, `applyVariant`, `restoreVariant` | variantes da faixa far com **ordem de par contrabalanceada**, `porOrdem` no resultado e controle na própria rodada. Tem também as variantes inversas, para medir uma mudança já commitada revertendo-a. `applyVariant` existe para segurar uma variante parada e fotografar. |
| `far-pose-study.js` | `findPoses`, `setPose`, `settle`, `pricePose`, `coverage`, `restoreStudy` | comparação por pose com seis pares, guarda de cena, controle que interrompe a rodada, rota a 55 m/s e cobertura geométrica por distância. Seleciona material fallback em órbita. Dados e limitações na Etapa 5 da 0f. |
| `pngdiff.mjs` (scratchpad) | `node pngdiff.mjs a.png b.png` | diff de pixel sem biblioteca de imagem -- decodifica PNG de 8 bits com o `zlib` do Node. Esta máquina não tem PIL, numpy nem ImageMagick. Congele `planet.cloudSpeed` antes de usar. |
| `shader-ablation.js` | `runFarShaderAblation` | custo do fragment shader far, com draws e triângulos controlados e guarda de programa quebrado. |
| `shader-probe.js` | `probeTerrainShaders` | contagem de operações por shader — para escolher o que ablacionar antes de gastar uma rodada. |
| `surface-perf-checks.js` | `runSurfacePerf`, `runSurfaceAblation2` | ablação por grupo na superfície, com piso de ruído medido e assentamento por platô de frame time. |
| `flyover-checks.js` | `runFlyoverBenchmark`, `runPriorityAudit`, `probeLadderDescent`, `probeLodReachability`, `probeSurfaceGaps`, `probeVegetationCoverage` | ordem e latência de carregamento de chunk. Rode nas velocidades de `ship-flight.ts`, não em velocidade arbitrária. |
| `promotion-checks.js` | `runPromotionAB` | A/B da promoção incremental contra a atômica antiga. **Ainda não rodou até o fim.** |
| `budget-sweep.js` | `runBudgetSweep` | varredura dos orçamentos de CPU por frame. Já rodada: ver a tabela na 0f. |

Um teste que não consegue ver a classe de bug que você está caçando é pior que
nenhum, porque devolve um número verde. `probeSurfaceGaps` reportou 0 buracos no
dia em que havia buracos na tela (0f, armadilha 6); foi preciso escrever
`runStitchMaskChecks` para ter uma resposta.

**`planet-terrain.ts` é compartilhado com o servidor SpacetimeDB.** Qualquer
mudança ali tem de ser bit-idêntica, ou cliente e servidor discordam sobre a
altura do terreno e o jogador afunda no chão. A ordem de multiplicação em
`grad4dot` é deliberada por esse motivo — a variante "otimizada" que fatora
`norm` no final diverge em 59,5% das amostras.
