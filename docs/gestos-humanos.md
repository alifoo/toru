# Gestos humanos em demos gravadas

Fase 0 do plano `docs/plano-direcao-humana-2026-10-27.md`. O catálogo que o driver (Fase 2), a câmera (Fase 1b) e a skill (Fase 3) seguem. Valores em milissegundos e em pixels CSS do viewport, salvo indicação.

## O que a pesquisa diz

### Movimento do cursor
- **O deslocamento principal tem velocidade em sino** (sobe, pico, desce), bem descrito pelo modelo de *minimum jerk*. O modelo serve só para essa parte, e não para o movimento inteiro com as correções finais ([Fischer et al. / LQR, arXiv 2002.11596](https://arxiv.org/pdf/2002.11596); [Optimal Feedback Control, arXiv 2110.00443](https://arxiv.org/pdf/2110.00443)).
- **O fim do movimento tem pequenas correções.** O tamanho do alvo alonga a fase corretiva. A distância só escala a curva de velocidade, sem mudar a forma (Thompson et al., 2007, citado nos mesmos trabalhos). Submovimentos acontecem a cerca de 2,5 Hz, ou seja, uns 400 ms cada ([Lee et al., 1997](https://brain.umn.edu/1997-10-01__Manual_interception_of_moving_targets_II__On-line_control_of_overlapping_submovements.html)).
- **Passar do alvo e voltar existe e é medido** como entrada e saída do alvo antes de parar ([tabela de métricas, J. NeuroEng. Rehabil.](https://jneuroengrehab.biomedcentral.com/articles/10.1186/1743-0003-11-91/tables/5); [reentrada em Fitts, UMD](https://drum.lib.umd.edu/items/f3e5dc45-7acc-40c6-8dfd-a258b9c0bc9b)). Não achamos uma taxa populacional; usamos uma probabilidade baixa.
- **Pausas antes do clique crescem com a carga cognitiva** ([Yamanaka, GI 2020](https://graphicsinterface.org/proceedings/gi2020/gi2020-44)). Não há um valor-padrão publicado. Os guias de screencast falam em "uma fração de segundo".

### Direção em screencasts
- **Parar no elemento antes de clicar**, para o espectador ver onde o cursor parou. Mover devagar e com fluidez. Não sacudir o mouse pela tela ([UBC, Screencasting Best Practices](https://wiki.ubc.ca/images/b/b5/Screencasting_Best_Practices.pdf); [Clueso](https://help.clueso.io/screen-recording/recording-best-practices)).
- **Movimento deliberado até os elementos importantes**, pausa curta nos pontos-chave, nada de movimento rápido difícil de seguir (guia de demos do OpenScreen, o renderizador que o Toru usa).
- **Destaque de clique só quando necessário**, sem rastro de cursor ([Clueso](https://www.clueso.io/cluebooks/tasteful-screen-recording--faqs)). O Screen Studio recomenda cursor lento para apresentações ([help](https://Screen.studio/help)).
- **Zoom**:
  - fator sutil entre 1,5× e 2,2× (OpenScreen);
  - zoom sutil de 2 a 3 s ([TemperStack sobre o Screen Studio](https://www.temperstack.com/learn/screen-studio/add-zoom-effects/));
  - só nos passos que precisam ([Floik](https://www.floik.com/help-article/how-to-draw-attention-to-key-details-using-zoom));
  - uma mudança visual a cada ~10 s numa tela parada, que pode ser um gesto em vez de zoom ([CapCut](https://www.capcut.com/create/zoom-effects-for-tutorial-videos-guide-attention)).

  Usuários do Screen Studio pedem "remover todos os zooms" depois de gravações longas ([hub](https://hub.screen.studio/p/remove-all-zooms-button)), e reclamam que o zoom automático começa tarde demais antes do clique ([hub](https://hub.screen.studio/p/custom-settings-for-default-automatic-zoom-range)). É o mesmo defeito que corrigimos na etapa 1a.
- **O cursor é um guia fraco do olhar**: em aula gravada, o cursor do mouse não melhorou o aprendizado, mas um marcador do olhar do professor deixou mais fácil acompanhar ([Emhardt, Jarodzka et al., 2022](https://dspace.library.uu.nl/bitstream/1874/423929/1/What_is_my_teacher_talking_about_Effects_of_displaying_the_teacher_s_gaze_and_mouse_cursor_cues_in_video_lectures_on_students_learning.pdf)). Por isso o cursor precisa apontar de propósito para o que importa, e não só passear.

## Parâmetros do movimento (Fase 2)

| Parte | Valor | De onde vem |
|---|---|---|
| Duração do percurso | 550 ms + 0,5 ms/px, até 1,2 s (já é o atual) | Fitts; medido no Toru em 12/10 |
| Perfil de velocidade | *minimum jerk* (10t³ − 15t⁴ + 6t⁵) no deslocamento principal | arXiv 2002.11596 |
| Curvatura | desvio perpendicular de 2% a 6% da distância, lado aleatório, sem curva abaixo de 80 px | traços humanos não são retas |
| Correção final | 1 submovimento de 120 a 220 ms, 2 a 8 px, em 30% dos percursos acima de 300 px | submovimentos a ~2,5 Hz |
| Passe do alvo | em 15% dos percursos acima de 400 px: passa 4 a 10 px e volta no submovimento | reentrada medida em Fitts |
| Pausa antes do clique, mesmo enquadramento | 250 a 400 ms (hoje 160) | "uma fração de segundo" |
| Pausa antes do clique, enquadramento novo | 700 ms extras (etapa 1a) | a câmera leva ~1 s |
| Deriva parado | 1 a 3 px a cada 400 a 900 ms, só durante esperas acima de 1,5 s | mão parada não é imóvel |

Aleatoriedade com semente por gravação, para que um re-render dê o mesmo vídeo.

## Catálogo de gestos

Cada gesto vira uma ação semântica `emphasis` com a caixa do elemento, para a câmera reagir.

| Gesto | Ferramenta | Movimento | Duração | Quando usar | Câmera |
|---|---|---|---|---|---|
| **Apontar e repousar** | `browser_point` | percurso até o centro do elemento, para, deriva | 0,8 a 1,5 s parado | "olha aqui": um número, um status, um item novo na lista | enquadramento suave na caixa, sem zoom se ela ocupar mais de 25% da tela |
| **Contornar** | `browser_trace` `shape: circle` | uma volta em elipse a 12 px da caixa, *minimum jerk* no ângulo, começa e termina no canto superior esquerdo | 0,9 a 1,2 s | o resultado que prova o fluxo: um total, um card, uma linha nova | zoom sutil (até 1,6×) na caixa, segura até o fim do gesto + 1 s |
| **Sublinhar** | `browser_trace` `shape: underline` | da esquerda para a direita, 6 px abaixo da linha de base do texto | 0,6 a 0,9 s | um texto específico: um título, uma frase da prévia, um valor numa frase | igual a apontar |
| **Varrer** | `browser_sweep` `rows: N` | desce pelas linhas de uma tabela ou lista, parando ~150 ms no centro de cada uma | ~0,3 s por linha, no máximo 5 | mostrar que há vários resultados e que eles têm o campo certo | enquadramento na caixa das linhas varridas, sem zoom se for a tabela toda |
| **Hesitar** | automático antes de cliques marcados importantes | para sobre o botão com deriva | 400 a 700 ms extras | o clique que muda o estado: "Criar", "Enviar", "Ativar" | nenhuma (a câmera já assentou pela regra da etapa 1a) |
| **Rolar lendo** | `browser_read` | rolagem suave de 300 a 600 px por passo, pausa entre passos, cursor acompanha a área | 600 a 900 ms por pausa | uma página longa que precisa ser vista, não pulada | plano aberto, sem zoom |
| **Sair de cena** | `browser_move` (já existe) | estaciona fora do conteúdo | — | no resultado final, depois da ênfase | segura o resultado |

## Regras de direção (Fase 3)

1. **No máximo uma ênfase por tela de conteúdo**, duas se a tela for o resultado. Ênfase demais vira o novo defeito.
2. **Nenhum gesto em telas de transição**: assistente com "Próximo", aba, menu, carregamento. Clicar e seguir.
3. **Antes do resultado final, enfatizar a prova** (contornar o total, varrer a tabela) e depois sair de cena.
4. **Nunca sacudir, girar sem alvo ou circular texto de interface** (rótulos de botão, menus). Gesto só sobre dado ou resultado.
5. **Zoom é para ler**: digitação, resultado e elementos pequenos. Fator entre 1,5× e 2,2×, de 2 a 3 s, no máximo ~4 por minuto, com pelo menos 2 s em plano aberto entre dois zooms.
6. **Tela parada por mais de ~10 s pede uma mudança**: um gesto (apontar, varrer) em vez de mais um zoom.
7. **O gesto cabe no limite de 2 min da gravação**: em fluxos longos, ênfase só no resultado.

## Exemplo: o assistente de Sinais da Nock

| Tela | Direção |
|---|---|
| Catálogo de Sinais | apontar o card "Usa uma tecnologia" (é a escolha), clicar |
| Filtros | clicar "Nuvemshop", **apontar** o contador que cai de 5.813 para 1.618, "Próximo" |
| Público | clicar "Pequeno porte", "Próximo" (transição, sem gesto) |
| Prévia | **varrer** 4 linhas da tabela (a prova "Nuvemshop no código do site"), "Próximo" |
| O que entrega | "Próximo" (transição) |
| Custo | **sublinhar** "até 110 créditos por dia", "Próximo" |
| Lançar (resultado) | **contornar** o nome do sinal e a frequência, sair de cena |

## Em aberto (para o fundador)

- Demos de referência que você considera o padrão: com elas ajusto os parâmetros antes da Fase 2.
- Se o gesto de contornar deve deixar um traço desenhado na tela (como uma caneta) ou só mover o cursor. O plano assume só o cursor; o traço exigiria uma camada de anotação no render.
