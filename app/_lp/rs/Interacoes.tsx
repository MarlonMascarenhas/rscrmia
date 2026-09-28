"use client";

import { useEffect } from "react";

/**
 * O COMPORTAMENTO DA LP QUE ERA `<script>` NA FONTE — AGORA DELEGAÇÃO DE EVENTO.
 *
 * O HTML original tinha três funções globais (`toggleFaq`, `toggleGuide`,
 * `openPrivacy`/`closePrivacy`) e um `querySelectorAll('a[href^="#"]')` para rolagem
 * suave. `openPrivacy`/`closePrivacy` não sobrevivem aqui — o modal de privacidade foi
 * substituído por links para `/legal/privacy` e `/legal/terms` (ver `markup.ts`) — mas
 * os outros dois comportamentos são os mesmos, só que via `data-lp` (React não aceita
 * `onclick="..."` como string) e um único listener no contêiner, em vez de um por
 * botão: `ANTES_DOS_PLANOS`/`DEPOIS_DOS_PLANOS` são strings estáticas, e o listener
 * teria de ser religado a cada troca — a delegação no `.lp-rs` resolve isso de uma vez.
 *
 * Renderiza `null`: este componente não tem markup próprio, só o efeito.
 */
export function Interacoes() {
  useEffect(() => {
    const container = document.querySelector<HTMLElement>(".lp-rs");
    if (!container) return;

    function aoClicar(evento: MouseEvent) {
      const alvo = evento.target as HTMLElement | null;
      if (!alvo) return;

      // FAQ: fecha todos os .faq-item.open do DOCUMENTO, abre o clicado se estava fechado.
      const botaoFaq = alvo.closest('[data-lp="faq"]');
      if (botaoFaq) {
        const item = botaoFaq.closest(".faq-item");
        if (item) {
          const jaEstavaAberto = item.classList.contains("open");
          document.querySelectorAll(".faq-item.open").forEach((i) => i.classList.remove("open"));
          if (!jaEstavaAberto) item.classList.add("open");
        }
        return;
      }

      // Guia: fecha os .guide-art.open só dentro do MESMO .guide-topic, abre o clicado.
      const botaoGuia = alvo.closest('[data-lp="guia"]');
      if (botaoGuia) {
        const item = botaoGuia.closest(".guide-art");
        if (item) {
          const jaEstavaAberto = item.classList.contains("open");
          item
            .closest(".guide-topic")
            ?.querySelectorAll(".guide-art.open")
            .forEach((i) => i.classList.remove("open"));
          if (!jaEstavaAberto) item.classList.add("open");
        }
        return;
      }

      // Rolagem suave para âncoras internas, só quando o alvo existe na página.
      const link = alvo.closest('a[href^="#"]');
      if (link) {
        const id = link.getAttribute("href")?.slice(1);
        const destino = id ? document.getElementById(id) : null;
        if (destino) {
          evento.preventDefault();
          destino.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    }

    container.addEventListener("click", aoClicar);
    return () => container.removeEventListener("click", aoClicar);
  }, []);

  return null;
}
