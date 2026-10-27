# Progresso: direção humana nas gravações

Plano: `docs/plano-direcao-humana-2026-10-27.md` (aprovado em 27/10/2026). Um PR por etapa, empilhados; nenhum merge sem o fundador.

## Etapas

- [x] **1a · Câmera antes do clique** (Fase 1, itens 1 e 2) · branch `feat/direcao-fase-1-camera`
  - [x] Todo zoom abre pelo menos 800 ms antes do clique, inclusive o primeiro (`proposeZoomRegions`, `clickSettleMs`)
  - [x] Nada é cortado nem acelerado de 1,5 s antes a 0,5 s depois de cada clique (`clickReserveRanges`, `pointerActivity`)
  - [x] O driver segura 700 ms o clique que abre um enquadramento novo (`opensNewShot`, `newShotHoldMs`)
  - [x] Testes: render-contract 98, browser 137, workspace inteiro verde
- [x] **0 · Estudo dos gestos humanos** · branch `feat/direcao-fase-0-estudo`
  - [x] Pesquisa: cinemática do apontar (minimum jerk, submovimentos, reentrada) e guias de screencast/zoom
  - [x] Catálogo `docs/gestos-humanos.md`: parâmetros do movimento, 7 gestos, regras de direção, exemplo da Nock
  - [ ] Medir em demos de referência do fundador (espera a lista dele; não bloqueia a Fase 1b)
- [x] **1b · Menos zoom e checagem de entrega** (Fase 1, itens 3 e 4) · branch `feat/direcao-fase-1b-menos-zoom`
  - [x] Sem zoom em clique que só avança o fluxo ("Próximo", "Voltar", "Continuar" ou página que muda em até 1,5 s); a tela seguinte abre um grupo novo e a câmera já está aberta e parada quando o botão é clicado (`movesFlowOn`)
  - [x] Grupo pelo contêiner do DOM: o driver mede o painel em volta do alvo (`CapturePointer.container`) e cliques no mesmo painel (IoU > 0,7) são um enquadramento só, no painel
  - [x] Teto de 4 zooms/min e 2 s abertos entre zooms; perto, a câmera segura em vez de sair e voltar; digitação e resultado nunca saem (`paceZooms`)
  - [x] Checagem de entrega: `camera_late` e `zoom_pumping` (`reviewCamera`, usado por `assessDemo` com o config do render); só em demos dirigidas
- [x] **2 · Gestos no driver e nas ferramentas** · branch `feat/direcao-fase-2-gestos`
  - [x] Percurso humano: *minimum jerk*, curva de 2–6%, correção final e passe do alvo, pausa de 250–400 ms antes do clique, semente por gravação
  - [x] Deriva parado (1–3 px) ao apontar e na hesitação antes de "Criar", "Enviar", "Ativar" e afins
  - [ ] Deriva durante `browser_wait` longo (fica para depois: precisa de um método novo na extensão só para isso)
  - [x] `browser_point`, `browser_trace` (circle, underline), `browser_sweep` no driver (`gesture`), no protocolo local e na extensão; `browser_read` composto no servidor com `scrollBy`
  - [x] Extensão antiga ou janela do Mac sem `gesture`: o servidor só aponta o cursor (`pointer move`)
  - [x] Ação semântica `emphasis`: zoom sutil (até 1,6×) do começo do gesto até 1 s depois; nada acima de 25% da tela; nunca cortado pelo ritmo
  - [x] `run-plan.ts` aceita `point`, `trace`, `sweep`, `read` (fora do roteiro do navegador do Toru); o estúdio casa gestos com `emphasis`
- [x] **3 · Skill de direção** · branch `feat/direcao-fase-3-skill` e alifoo/toru-skills#1
  - [x] `references/direction.md`: o que o Toru já faz, os 4 gestos, 7 regras, exemplo e a checagem de entrega
  - [x] `SKILL.md` e `tools.md` 0.5.0 (plano aceita gestos; `camera_late`, `zoom_pumping`), espelhados em `packages/agent-skills`
  - [x] `recording-guide.ts` e as instruções do servidor mandam dirigir o olhar uma vez por tela, nunca em transição
  - Ordem de merge: toru-skills#1 só depois de os gestos (#21) estarem em produção
- [ ] **4 · Avaliação** (banco de 6 fluxos, métricas, nota do fundador; espera aprovação e extensão pronta)

## Registro

- 27/10: etapa 1a pronta (este arquivo criado), PR #18.
- 27/10: Fase 0 pronta (catálogo).
- 27/10: etapa 1b pronta, PR #20 (render-contract 107 testes, browser +2).
- 27/10: Fase 2 pronta, PR #21 (browser 145, render-contract 110, mcp 277).
- 27/10: Fase 3 pronta (skill 0.5.0).
