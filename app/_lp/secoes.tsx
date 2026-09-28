import Link from "next/link";

import { LogotipoDoProduto } from "@/components/branding/MarcaDoProduto";
import { Button } from "@/components/ui/button";

import type { OfertaDaLp, PlanoDaLp } from "./oferta";

/**
 * AS SEÇÕES DA LP — TEXTO EM PORTUGUÊS, DE PROPÓSITO, E SEM `t()`.
 *
 * A LP é a vitrine comercial de uma operação brasileira, não uma tela do painel: o
 * sistema de i18n existe para a interface de quem já é cliente, e traduzir a página
 * de venda seria manter uma segunda cópia de marketing sem ninguém para lê-la em
 * espanhol. Por isso `app/_lp` e `app/page.tsx` estão declarados como "fora do
 * produto" em `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`, com essa razão.
 *
 * ═══ O QUE ESTA PÁGINA PODE AFIRMAR ═══
 *
 * Cada frase abaixo descreve algo que existe no código ou nos pilares do `VISION.md`.
 * Não há número de cliente, depoimento, "aumenta X%" nem comparação nominal com
 * concorrente: nenhum deles existe para ser medido, e inventar um é o defeito que
 * o `CLAUDE.md` proíbe em toda camada. O que depende de uma REGRA do produto (o teste
 * grátis) vem de `oferta.ts` e muda de forma quando a regra não vale.
 *
 * O nome do produto NUNCA é escrito aqui: vem da marca da instalação, como no resto
 * do produto (white-label). `tests/unit/branding.test.ts` varre este diretório.
 */

const ROTA_CADASTRO = "/signup";
const ROTA_PAINEL = "/painel";

const brl = (cents: number, moeda: string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(cents / 100);

/**
 * O rótulo do botão principal: `null` = a instalação não oferece cadastro
 * (modo `so_convite` — `/signup` recusaria quem chega sem convite). Com
 * aprovação, o botão pede o acesso em vez de prometer a conta na hora. Só
 * promete "teste grátis" quando o teste existe.
 */
export function rotuloDoCadastro(oferta: OfertaDaLp): string | null {
  if (oferta.cadastro === "so_convite") return null;
  if (oferta.cadastro === "com_aprovacao") return "Solicitar acesso";
  return oferta.testeGratisDias !== null ? "Começar teste grátis" : "Criar minha conta";
}

function BotaoDeCadastro({ oferta, tamanho = "lg" }: { oferta: OfertaDaLp; tamanho?: "lg" | "default" }) {
  const rotulo = rotuloDoCadastro(oferta);
  if (rotulo === null) {
    return (
      <Button asChild size={tamanho}>
        <Link href={ROTA_PAINEL}>Entrar</Link>
      </Button>
    );
  }
  return (
    <Button asChild size={tamanho}>
      <Link href={ROTA_CADASTRO}>{rotulo}</Link>
    </Button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function Cabecalho({ nome, oferta }: { nome: string; oferta: OfertaDaLp }) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label={nome} className="shrink-0">
          <LogotipoDoProduto nome={nome} />
        </Link>
        <nav aria-label="Seções da página" className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <a className="hover:text-foreground" href="#recursos">Recursos</a>
          <a className="hover:text-foreground" href="#como-funciona">Como funciona</a>
          {oferta.planos.length > 0 ? <a className="hover:text-foreground" href="#planos">Planos</a> : null}
          <a className="hover:text-foreground" href="#perguntas">Perguntas</a>
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={ROTA_PAINEL}>Entrar</Link>
          </Button>
          {rotuloDoCadastro(oferta) !== null ? <BotaoDeCadastro oferta={oferta} tamanho="default" /> : null}
        </div>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/** Uma ilustração do produto, feita de HTML: nenhum dado real, nenhuma métrica. */
function IlustracaoDoProduto() {
  const etapas = [
    { titulo: "Novo", cards: ["Cliente A", "Cliente B"] },
    { titulo: "Em conversa", cards: ["Cliente C"] },
    { titulo: "Fechado", cards: ["Cliente D"] },
  ];
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto w-full max-w-xl rounded-xl border bg-card p-4 shadow-lg sm:p-5"
    >
      <div className="grid gap-4 sm:grid-cols-5">
        <div className="space-y-2 sm:col-span-3">
          <p className="text-xs font-medium text-muted-foreground">Conversa</p>
          <div className="max-w-[85%] rounded-lg rounded-tl-none bg-muted px-3 py-2 text-sm">
            Oi! Vocês têm horário para esta semana?
          </div>
          <div className="ml-auto max-w-[85%] rounded-lg rounded-tr-none bg-primary px-3 py-2 text-sm text-primary-foreground">
            Temos sim! Posso te mostrar os horários livres?
          </div>
          <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            <span className="inline-block size-2 rounded-full bg-primary" />
            Agente de IA respondendo
          </div>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <p className="text-xs font-medium text-muted-foreground">Funil</p>
          {etapas.map((e) => (
            <div key={e.titulo} className="rounded-md border bg-background p-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{e.titulo}</p>
              <div className="space-y-1">
                {e.cards.map((c) => (
                  <div key={c} className="rounded-md bg-muted px-2 py-1 text-xs">{c}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] text-muted-foreground">Ilustração</p>
    </div>
  );
}

export function Hero({ oferta }: { oferta: OfertaDaLp }) {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[32rem]"
        style={{
          background:
            "radial-gradient(60rem 28rem at 50% -8rem, color-mix(in oklab, var(--primary) 16%, transparent), transparent)",
        }}
      />
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-24">
        <div className="space-y-6">
          <p className="text-sm font-medium text-primary">Atendimento e vendas por WhatsApp</p>
          <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            Atenda, qualifique e venda pelo WhatsApp com agentes de IA no seu time.
          </h1>
          <p className="max-w-xl text-lg text-muted-foreground text-pretty">
            Centralize as conversas num funil só. Os agentes de IA resolvem o que dá para resolver e passam
            para o time humano o que importa, com tudo registrado.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <BotaoDeCadastro oferta={oferta} />
            <Button asChild size="lg" variant="outline">
              <a href="#como-funciona">Ver como funciona</a>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {oferta.cadastro === "so_convite"
              ? "O acesso é feito por convite. Já tem conta? Entre pelo botão acima."
              : oferta.cadastro === "com_aprovacao"
                ? oferta.testeGratisDias !== null
                  ? `${oferta.testeGratisDias} dias de teste grátis a partir da aprovação do seu acesso. Sem cartão de crédito.`
                  : "Peça o seu acesso: a conta é liberada depois da aprovação."
                : oferta.testeGratisDias !== null
                  ? `${oferta.testeGratisDias} dias de teste grátis. Sem cartão de crédito.`
                  : "Crie a sua conta e comece a configurar o atendimento."}
          </p>
        </div>
        <IlustracaoDoProduto />
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const RECURSOS: ReadonlyArray<{ titulo: string; texto: string }> = [
  {
    titulo: "WhatsApp de duas formas",
    texto:
      "Conecte o seu número por QR code ou pelo canal oficial da Meta. O sistema controla o ritmo dos envios para reduzir o risco de bloqueio.",
  },
  {
    titulo: "Agentes de IA que conhecem o seu negócio",
    texto:
      "Alimente o agente com o conteúdo da sua empresa e escolha se ele responde sozinho ou sugere a resposta para o time aprovar.",
  },
  {
    titulo: "Passagem para uma pessoa, sem perder o fio",
    texto:
      "Quando a IA não deve continuar, a conversa vai para alguém do time com o histórico junto e o motivo registrado.",
  },
  {
    titulo: "Um funil que anda com a conversa",
    texto:
      "Cada negócio tem o seu card. O agente pode mover etapas, aplicar etiquetas e disparar automações conforme a conversa avança.",
  },
  {
    titulo: "Agenda e campanhas",
    texto:
      "Marque atendimentos pela conversa e faça campanhas para a sua base, com janela de horário e limite de envio.",
  },
  {
    titulo: "Pensado para a LGPD",
    texto:
      "Os dados de cada empresa ficam isolados, as ações ficam numa trilha de auditoria, e um contato pode ser anonimizado a pedido do titular.",
  },
];

export function Recursos() {
  return (
    <section id="recursos" className="scroll-mt-20 border-t bg-muted/40">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
        <div className="max-w-2xl space-y-3">
          <h2 className="text-3xl font-bold tracking-tight">Tudo o que o atendimento precisa, num lugar só</h2>
          <p className="text-muted-foreground">
            Do primeiro &quot;oi&quot; ao fechamento, sem trocar de ferramenta no meio do caminho.
          </p>
        </div>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {RECURSOS.map((r) => (
            <li key={r.titulo} className="rounded-xl border bg-card p-5">
              <h3 className="font-semibold">{r.titulo}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{r.texto}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const PASSOS: ReadonlyArray<{ titulo: string; texto: string }> = [
  { titulo: "Conecte o seu WhatsApp", texto: "Leia o QR code ou ligue o canal oficial. As conversas passam a chegar no painel." },
  { titulo: "Ensine o agente", texto: "Cadastre o que ele precisa saber e defina em que situações ele deve chamar uma pessoa." },
  { titulo: "Acompanhe tudo no funil", texto: "Veja cada negócio andar, com o histórico da conversa e quem fez o quê." },
];

export function ComoFunciona() {
  return (
    <section id="como-funciona" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
        <h2 className="max-w-2xl text-3xl font-bold tracking-tight">Como funciona</h2>
        <ol className="mt-10 grid gap-6 md:grid-cols-3">
          {PASSOS.map((p, i) => (
            <li key={p.titulo} className="relative rounded-xl border bg-card p-6">
              <span className="mb-4 flex size-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                {i + 1}
              </span>
              <h3 className="font-semibold">{p.titulo}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{p.texto}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function Nichos() {
  const nichos = ["E-commerce", "Clínicas", "Imobiliárias", "Infoprodutos", "Serviços e agências"];
  return (
    <section className="border-t bg-muted/40">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-14 sm:px-6">
        <h2 className="text-2xl font-bold tracking-tight">Para quem vende conversando</h2>
        <p className="max-w-2xl text-muted-foreground">
          O funil usa o vocabulário do seu negócio: o que é &quot;cliente&quot; numa loja vira &quot;paciente&quot; numa clínica,
          e &quot;fechado&quot; pode ser &quot;pago&quot; ou &quot;agendado&quot;.
        </p>
        <ul className="flex flex-wrap gap-2">
          {nichos.map((n) => (
            <li key={n} className="rounded-full border bg-card px-4 py-1.5 text-sm">{n}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function CartaoDePlano({ plano, oferta }: { plano: PlanoDaLp; oferta: OfertaDaLp }) {
  const { mensal, anual } = plano.precos;
  const principal = mensal ?? anual;
  return (
    <li className="flex flex-col rounded-xl border bg-card p-6">
      <h3 className="text-lg font-semibold">{plano.nome}</h3>
      {plano.descricao ? <p className="mt-1 text-sm text-muted-foreground">{plano.descricao}</p> : null}
      {principal ? (
        <p className="mt-5">
          <span className="text-4xl font-bold tracking-tight">{brl(principal.valorCents, principal.moeda)}</span>
          <span className="text-sm text-muted-foreground">{mensal ? " /mês" : " /ano"}</span>
        </p>
      ) : null}
      {mensal && anual ? (
        <p className="mt-1 text-sm text-muted-foreground">ou {brl(anual.valorCents, anual.moeda)} por ano</p>
      ) : null}
      <ul className="mt-5 flex-1 space-y-2 text-sm">
        {plano.liberaTudo ? <li>Todos os recursos, sem limites de uso</li> : null}
        {plano.inclui.map((i) => (
          <li key={i}>{i}</li>
        ))}
        {plano.tetos.map((t) => (
          <li key={t} className="text-muted-foreground">Até {t}</li>
        ))}
      </ul>
      <div className="mt-6">
        <BotaoDeCadastro oferta={oferta} tamanho="default" />
      </div>
    </li>
  );
}

export function Planos({ oferta }: { oferta: OfertaDaLp }) {
  // Sem plano publicado a seção INTEIRA some: uma vitrine vazia é pior que nenhuma.
  if (oferta.planos.length === 0) return null;
  return (
    <section id="planos" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
        <div className="max-w-2xl space-y-3">
          <h2 className="text-3xl font-bold tracking-tight">Planos</h2>
          <p className="text-muted-foreground">Escolha o plano da sua operação.</p>
        </div>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {oferta.planos.map((p) => (
            <CartaoDePlano key={p.nome} plano={p} oferta={oferta} />
          ))}
        </ul>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function Perguntas({ oferta }: { oferta: OfertaDaLp }) {
  const itens: Array<{ p: string; r: string }> = [
    ...(oferta.testeGratisDias !== null
      ? [
          {
            p: "Preciso de cartão de crédito para testar?",
            r: "Não. O teste começa no cadastro, sem cartão. Você só escolhe um plano quando decidir continuar.",
          },
        ]
      : []),
    {
      p: "Os dados da minha empresa ficam separados dos de outras empresas?",
      r: "Sim. Cada empresa tem os seus dados isolados no banco, e esse isolamento é verificado automaticamente a cada alteração do produto.",
    },
    {
      p: "Posso conectar o número que já uso?",
      r: "Sim, por QR code ou pelo canal oficial da Meta. O sistema controla o ritmo dos envios para reduzir o risco de bloqueio, mas nenhum sistema elimina esse risco por completo.",
    },
    {
      p: "A IA responde sozinha?",
      r: "Você escolhe. O agente pode responder sozinho ou sugerir a resposta para alguém do time aprovar antes de enviar. E você define quando ele deve chamar uma pessoa.",
    },
    {
      p: "Como fica a LGPD?",
      r: "O sistema registra as ações numa trilha de auditoria e permite exportar e anonimizar os dados de um contato a pedido do titular. A empresa continua sendo a responsável pelos dados que coleta.",
    },
    {
      p: "Posso cancelar quando quiser?",
      r: "Sim. Ao cancelar, você continua com acesso até o fim do período já pago, e os seus dados não são apagados.",
    },
  ];
  return (
    <section id="perguntas" className="scroll-mt-20 border-t bg-muted/40">
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:py-20">
        <h2 className="text-3xl font-bold tracking-tight">Perguntas frequentes</h2>
        <div className="mt-8 divide-y rounded-xl border bg-card">
          {itens.map((i) => (
            <details key={i.p} className="group p-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                {i.p}
                <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-sm text-muted-foreground">{i.r}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function ChamadaFinal({ oferta }: { oferta: OfertaDaLp }) {
  return (
    <section>
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-16 text-center sm:px-6 lg:py-20">
        <h2 className="text-3xl font-bold tracking-tight text-balance">
          Comece a atender melhor a partir de hoje
        </h2>
        <BotaoDeCadastro oferta={oferta} />
      </div>
    </section>
  );
}

export function Rodape({ nome }: { nome: string }) {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-6">
        <p>© {new Date().getFullYear()} {nome}</p>
        <nav aria-label="Rodapé" className="flex items-center gap-5">
          <Link className="hover:text-foreground" href="/legal/terms">Termos de uso</Link>
          <Link className="hover:text-foreground" href="/legal/privacy">Privacidade</Link>
          <Link className="hover:text-foreground" href={ROTA_PAINEL}>Entrar</Link>
        </nav>
      </div>
    </footer>
  );
}
