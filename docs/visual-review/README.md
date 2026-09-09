# Revisão visual do planeta — 8 de setembro de 2026

A aplicação foi inspecionada em `http://localhost:5173/?editor&perf`, com seed 67, raio de 25.000 m e os parâmetros existentes do editor. Os modelos, a nave, o controlador e as alterações anteriores do workspace foram preservados.

## Experimentar

Recarregue a página para reconstruir os materiais WebGL. No topo do editor, **Apply Mineral Dawn** aplica uma proposta de direção visual: vegetação em tons de sálvia, rocha acobreada, água azul-esverdeada e iluminação quente. **Restore Look** restaura os valores de aparência anteriores. O preset não altera seed, relevo, resolução de geometria ou distâncias de LOD. Os parâmetros iniciais continuam sendo os do usuário.

## Alterações

- **Nuvens:** cada fragmento consulta a profundidade real da cena antes de calcular a densidade. A comparação usa a profundidade logarítmica da versão instalada do Three.js. Isso substitui o teste por uma casca sólida que não representava os recortes dos billboards. A composição agora trata corretamente a cor já multiplicada por alpha; foi removida uma passagem de profundidade. O buffer de nuvens preserva HDR.
- **Forma das nuvens:** billboards formados por lóbulos, bordas erodidas e base sombreada. Sua extensão radial foi limitada em relação à altitude sobre o raio de referência e o oceano. A oclusão continua necessária para montanhas mais altas.
- **Solo:** duas amostras decorrelacionadas de textura, mescladas por um campo espacial contínuo, com gradientes explícitos para seleção de mipmaps. Os materiais próximos e distantes compartilham a mesma escala de textura por distância, evitando mudanças associadas ao nível do chunk. Variações amplas de cor mineral ajudam a quebrar a uniformidade.
- **Microdetalhe:** perturbação da normal em escala de centímetros, com filtragem por tamanho do pixel e distância. Afeta a resposta à luz; não muda colisões nem a silhueta geométrica.
- **Profundidade da paisagem:** terreno distante perde contraste em direção à cor da atmosfera quando observado da superfície.
- **Água:** normais de ondas, espuma de crista e brilhos muito pequenos são atenuados quando não podem ser resolvidos na tela. As ondas próximas continuam presentes.
- **Carregamento:** termina a cobertura dos quatro irmãos antes de solicitar seus descendentes; diferencia patches cuja distância ao volume envolvente era igualmente zero; limita a fila de resultados produzidos antes de sua integração na GPU. A troca pai/filhos continua sendo atômica.

## Validação

- Build de produção: `pnpm --dir client build` passou. O Vite ainda avisa sobre o tamanho do bundle principal.
- ESLint dos arquivos alterados passou.
- Programas WebGL usados nas vistas de órbita e superfície: nenhum erro de compilação observado.
- Testes reais de pixels: nuvens atrás de terreno e água, nuvens à frente, casca vista de fora e de dentro. Os dez testes de renderização/visibilidade e cobertura de chunks passaram.
- Apply/Restore verificados pela interface: cor restaurada e seed preservada.

Para repetir os testes, abra o editor em desenvolvimento e execute no console:

```js
await (await import('/scripts/visual-checks.js')).runVisualChecks()
```

Os testes criam uma cena pequena isolada usando o renderer ativo, os shaders de nuvem e o compositor de produção. Os recursos temporários são descartados ao terminar.

## Limites e próximo trabalho

Não há medição controlada que permita afirmar ganho de FPS. O navegador embutido limitou frames em segundo plano; parte da inspeção avançou a simulação manualmente para carregar os materiais. Os números do overlay durante esse procedimento não são um benchmark. O carregamento frio ainda requer centenas de chunks; a alteração melhora a ordem e limita o acúmulo, mas não torna a geração instantânea.

O solo ainda usa projeção por face dominante: a variação reduz a repetição, mas não elimina todas as possíveis transições nos limites entre faces do cubo. A malha ainda troca de LOD sem morphing de vértices. As nuvens continuam sendo uma casca e billboards, não um volume percorrível por ray marching. A água continua com reflexão aproximada de céu.

Para uma paisagem realmente marcante, a próxima intervenção deve concentrar-se em formas reconhecíveis (escarpas, afloramentos e vales), distribuição de vegetação em comunidades e composição dos locais de exploração. Isso exige trabalho no gerador e no espalhamento, além de shaders. Esta entrega melhora os materiais, corrige a oclusão e fornece uma direção visual comparável; não substitui esse trabalho de composição.

## Registro visual

[Superfície com Mineral Dawn](mineral-dawn-surface.png). A imagem registra uma planície próxima da costa; mostra também o limite atual da composição da paisagem.

[Costa confirmada](mineral-dawn-coast.png): a água foi localizada por amostragem de altura, aproximadamente 1,4 km da posição inicial. O personagem foi reposicionado em terra firme, perto de 10 m acima do nível do mar. O HUD foi ocultado apenas para as capturas. A vista inicialmente chamada de costa era outra direção e foi descartada.
