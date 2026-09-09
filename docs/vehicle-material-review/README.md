# Integração visual da nave e do traje

A nave deixou de usar um ambiente de estúdio e uma DirectionalLight própria. O material agora calcula iluminação por nave a partir do Sol, sombra analítica do planeta, atmosfera e máscara de nuvens, tanto no editor quanto para jogadores locais e remotos. Adicionar naves não soma luzes ao casco das demais.

Direção aplicada: cerâmica fosca em tom mineral, pintura petróleo, cobre menos saturado e vidro escuro. Foram mantidos os mapas e a geometria existentes; o relevo do normal map foi suavizado e o brilho especular ficou mais contido. O traje recebe uma versão mais suave da mesma paleta e menos luz de preenchimento.

O desenho e parte do sombreado triangular já estão pintados no atlas original. Esta revisão harmoniza materiais e iluminação; não substitui a modelagem nem repinta o asset.

Validação: build e ESLint passaram; teste de renderização em vácuo confirmou a resposta à sombra e a independência de luzes adicionais; regressões de precisão do avatar e do cenário passaram sem pixels acima da tolerância. Nenhum erro de shader. Resultados em results.json. O aviso existente de tamanho do bundle permanece.

`/scripts/ship-material-checks.js` exporta `runShipLightingChecks()` e a prévia temporária `previewDaylight()` (retorna função de restauração). A prévia não altera o catálogo ou o relógio do servidor.
