import type { CSSProperties } from "react";

import type { OfertaDaLp, PlanoDaLp } from "../oferta";

/**
 * A SEÇÃO DE PLANOS — O ÚNICO PEDAÇO DO MARKUP QUE NÃO VEM DE `markup.ts`.
 *
 * O layout, as classes e os estilos inline são EXATAMENTE os do HTML original
 * (`<section class="plan-section" id="planos">`): o que muda é a origem do preço,
 * do nome e da lista de cada cartão, que agora vêm de `OfertaDaLp` (banco, via
 * `/admin/planos`) em vez de estarem escritos na página. Um preço na LP diferente
 * do que o checkout cobra é o pior tipo de divergência — o cliente a descobre
 * pagando.
 *
 * Os itens dos TRÊS planos originais (Essencial, Profissional, Completo) são
 * fixos e verbatim — inclusive o SVG do "check" e os `<strong>` — porque são texto
 * de marketing que o dono escreveu, não uma projeção de capacidades. Um plano com
 * outro nome (um clone que renomeou os planos, ou um plano novo) usa a lista
 * GERADA a partir de `plano.inclui`/`plano.tetos`, do mesmo jeito que o resto do
 * produto já faz em `app/_lp/secoes.tsx`.
 */

const ROTA_CADASTRO = "/signup";
const ROTA_PAINEL = "/painel";

/** Sem acento e sem caixa, para casar "Profissional" com "profissional" e afins. */
function normalizarNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** O símbolo que o `Intl` usa para a moeda — "R$" para BRL, e o dela para as demais. */
function simboloDaMoeda(moeda: string): string {
  const partes = new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).formatToParts(0);
  return partes.find((p) => p.type === "currency")?.value ?? moeda;
}

/** "197" para 19700 centavos; "217,50" para 21750 — sem símbolo, sem ",00" à toa. */
function valorSemSimbolo(cents: number): string {
  const formatado = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    cents / 100,
  );
  return formatado.endsWith(",00") ? formatado.slice(0, -3) : formatado;
}

/** O ícone de "incluso" — o mesmo SVG do HTML original, em todo item de toda lista. */
function Check() {
  return (
    <span className="ck">
      <svg viewBox="0 0 12 12">
        <polyline points="2,6 5,9 10,3" />
      </svg>
    </span>
  );
}

/** Verbatim do plano Essencial na fonte. */
function ListaEssencial() {
  return (
    <>
      <li>
        <Check />
        1 usuário
      </li>
      <li>
        <Check />
        1 conexão de WhatsApp
      </li>
      <li>
        <Check />
        Até 500 contatos
      </li>
      <li>
        <Check />
        Gestão de conversas e tags
      </li>
      <li>
        <Check />
        Respostas rápidas
      </li>
    </>
  );
}

/** Verbatim do plano Profissional na fonte. */
function ListaProfissional() {
  return (
    <>
      <li>
        <Check />
        Até <strong>5 usuários</strong>
      </li>
      <li>
        <Check />
        Até <strong>4 conexões</strong> de WhatsApp
      </li>
      <li>
        <Check />
        Até <strong>1.000 contatos</strong>
      </li>
      <li>
        <Check />
        Campanhas de WhatsApp
      </li>
      <li>
        <Check />
        Follow-up automático
      </li>
      <li>
        <Check />
        Relatórios avançados com IA
      </li>
      <li>
        <Check />
        Respostas rápidas
      </li>
    </>
  );
}

/** Verbatim do plano Completo na fonte. */
function ListaCompleto() {
  return (
    <>
      <li>
        <Check />
        <strong>Usuários ilimitados</strong>
      </li>
      <li>
        <Check />
        <strong>Conexões ilimitadas</strong>
      </li>
      <li>
        <Check />
        <strong>Contatos ilimitados</strong>
      </li>
      <li>
        <Check />
        Tudo do Profissional incluso
      </li>
      <li>
        <Check />
        IA para análise de conversas
      </li>
      <li>
        <Check />
        Suporte prioritário
      </li>
      <li>
        <Check />
        Sem nenhum limite de uso
      </li>
    </>
  );
}

/** Plano fora dos três originais: a lista vem do que o banco publicou. */
function ListaGerada({ plano }: { plano: PlanoDaLp }) {
  return (
    <>
      {plano.liberaTudo ? (
        <li>
          <Check />
          Todos os recursos, sem limites de uso
        </li>
      ) : null}
      {plano.inclui.map((item) => (
        <li key={item}>
          <Check />
          {item}
        </li>
      ))}
      {plano.tetos.map((teto) => (
        <li key={teto}>
          <Check />
          Até {teto}
        </li>
      ))}
    </>
  );
}

function Feats({ plano }: { plano: PlanoDaLp }) {
  switch (normalizarNome(plano.nome)) {
    case "essencial":
      return <ListaEssencial />;
    case "profissional":
      return <ListaProfissional />;
    case "completo":
      return <ListaCompleto />;
    default:
      return <ListaGerada plano={plano} />;
  }
}

/**
 * O botão de cada cartão. `so_convite` não oferece cadastro — a instalação só
 * aceita quem já foi convidado, então o botão leva ao painel de quem já é
 * cliente, nunca a `/signup`.
 */
function BotaoDoPlano({
  oferta,
  nomeDoPlano,
  className,
  style,
}: {
  oferta: OfertaDaLp;
  nomeDoPlano: string;
  className: string;
  style: CSSProperties;
}) {
  const soConvite = oferta.cadastro === "so_convite";
  return (
    <a href={soConvite ? ROTA_PAINEL : ROTA_CADASTRO} className={className} style={style}>
      {soConvite ? "Entrar" : `Começar com ${nomeDoPlano}`}
    </a>
  );
}

function GarantiaBar() {
  return (
    <div className="garantia-bar">
      <div className="garantia-icon">🛡️</div>
      <div>
        <h4>Cancele quando quiser, sem burocracia</h4>
        <p>
          Não temos contratos anuais obrigatórios nem multas de cancelamento. Você fica porque gosta — e a gente
          trabalha todo dia para merecer isso.
        </p>
      </div>
    </div>
  );
}

function Cartao({ plano, oferta }: { plano: PlanoDaLp; oferta: OfertaDaLp }) {
  const ehPop = normalizarNome(plano.nome) === "profissional";
  const { mensal, anual } = plano.precos;
  const principal = mensal ?? anual;
  const sufixo = mensal ? "/mês · sem fidelidade" : "/ano · sem fidelidade";

  return (
    <div className={ehPop ? "plan-card pop" : "plan-card"}>
      {ehPop ? <div className="pop-badge">🔥 Mais escolhido</div> : null}
      <div className="plan-name">{plano.nome}</div>
      {plano.descricao ? <div className="plan-tagline">{plano.descricao}</div> : null}
      {principal ? (
        <>
          <div className="plan-price-row">
            <span className="plan-cur">{simboloDaMoeda(principal.moeda)}</span>
            <span className="plan-val">{valorSemSimbolo(principal.valorCents)}</span>
          </div>
          <div className="plan-mo">{sufixo}</div>
        </>
      ) : null}
      <hr className="plan-hr" />
      <ul className="plan-feats">
        <Feats plano={plano} />
      </ul>
      <BotaoDoPlano
        oferta={oferta}
        nomeDoPlano={plano.nome}
        className={ehPop ? "btn btn-blue" : "btn btn-ghost"}
        style={
          ehPop
            ? { width: "100%", justifyContent: "center", borderRadius: "10px", padding: "14px" }
            : { width: "100%", justifyContent: "center" }
        }
      />
    </div>
  );
}

export function Planos({ oferta }: { oferta: OfertaDaLp }) {
  const semPlanoPublicado = oferta.planos.length === 0;
  const soConvite = oferta.cadastro === "so_convite";
  return (
    <section className="plan-section" id="planos">
      <div className="wrap">
        <div className="section-head" style={{ textAlign: "center" }}>
          <span className="section-label">Planos e Preços</span>
          <h2 className="section-title">Comece hoje. Cresça no seu ritmo.</h2>
          <p className="section-sub" style={{ margin: "0 auto" }}>
            Sem contrato anual obrigatório. Cancele a qualquer momento, sem burocracia.
          </p>
        </div>

        {semPlanoPublicado ? (
          <div style={{ textAlign: "center", marginTop: "48px" }}>
            <p className="section-sub">Os planos estão sendo atualizados. Crie sua conta para começar.</p>
            <a
              href={soConvite ? ROTA_PAINEL : ROTA_CADASTRO}
              className="btn btn-blue"
              style={{ marginTop: "20px" }}
            >
              {soConvite ? "Entrar" : "Criar minha conta"}
            </a>
          </div>
        ) : (
          <div className="plan-grid" style={{ marginTop: "48px" }}>
            {oferta.planos.map((plano) => (
              <Cartao key={plano.nome} plano={plano} oferta={oferta} />
            ))}
          </div>
        )}

        <GarantiaBar />
      </div>
    </section>
  );
}
