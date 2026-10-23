/**
 * E2E — O BECO SEM SAÍDA DO PRIMEIRO ACESSO, PELA TELA.
 *
 * ─── O defeito que esta spec vigia ──────────────────────────────────────────
 *
 * `app/auth/confirm/route.ts` firma a SESSÃO e só depois provisiona a
 * organização. Quando o provisionamento falha — banco indisponível por um
 * instante, permissão ainda propagando —, a pessoa fica logada e SEM
 * organização. Antes do conserto, daí em diante todo caminho fechava:
 *
 *     /login       entra de novo -> signInWithPassword.ts -> /app/inbox
 *     /app/inbox   "Aceite um convite ou contate o admin"
 *     /onboarding  sem org -> redirect("/login")            <- o laço
 *
 * As duas saídas que a frase oferecia não existem para quem INSTALOU o sistema:
 * não há convite (ninguém convidou) e não há admin (ele é o admin). Num
 * self-host a conta travada é a do dono, e destravar pedia SQL na mão.
 *
 * É caminho de PRIMEIRA IMPRESSÃO, e é por isso que ele é provado pela tela e
 * não por chamada de rota: um conserto de beco sem saída que não funcione
 * RECRIA o beco, e ninguém descobre até um cliente reclamar.
 *
 * ─── Por que o estado é montado pelo banco, e não pelo signup ───────────────
 *
 * O defeito é "e-mail confirmado, provisionamento falhou". Fazer o signup
 * inteiro e esperar que ele falhe é impossível de forçar de fora; o que se pode
 * reproduzir com fidelidade é o ESTADO FINAL — usuário com e-mail confirmado e
 * nenhuma linha em `user_organizations`. É exatamente o que o cliente tem no
 * disco quando o segundo passo falha.
 *
 * ─── As duas metades, e por que a segunda pesa igual ────────────────────────
 *
 * Provar só que quem NÃO tem organização chega à saída deixaria verde o
 * conserto degenerado: "redirecione todo mundo para /get-started". Isso
 * quebraria o login de toda a base — e a tela nova viraria um "abra outra
 * empresa" para quem já tem a sua. Por isso o CONTROLE: quem TEM organização
 * não é mandado para lá, nem digitando a URL.
 */
import { randomUUID } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const SENHA = "PrimeiroAcesso!2026#Deskcomm";

/**
 * O usuário do defeito: e-mail confirmado, nenhuma organização, cadastro SEM
 * convite. Numa instalação `aberto`, a empresa nasce sozinha no primeiro acesso.
 */
const emailOrfao = `orfao-${randomUUID().slice(0, 8)}@qa.local`;
/**
 * Sem organização MAS com convite pendente no `user_metadata` (aqui, um token
 * que não verifica): nunca ganha empresa própria — fica na tela de
 * `/get-started`, a saída de quem não pode ser provisionado sozinho.
 */
const emailComConvite = `convite-${randomUUID().slice(0, 8)}@qa.local`;
/** O CONTROLE: mesma jornada, mas com organização. */
const emailComOrg = `comorg-${randomUUID().slice(0, 8)}@qa.local`;

let idOrfao = "";
let idComConvite = "";
let idComOrg = "";
let orgId = "";
/** A organização que a recuperação CRIA — limpada no fim. */
let orgCriadaId = "";

test.beforeAll(async () => {
  const { data: orfao, error: e1 } = await svc.auth.admin.createUser({
    email: emailOrfao,
    password: SENHA,
    email_confirm: true,
    // O nome que o cadastro grava: é com ele que a empresa nasce.
    user_metadata: { org_name: "Clínica Recuperada E2E" },
  });
  if (e1 || !orfao.user) throw e1 ?? new Error("sem usuário órfão");
  idOrfao = orfao.user.id;

  const { data: convidado, error: e0 } = await svc.auth.admin.createUser({
    email: emailComConvite,
    password: SENHA,
    email_confirm: true,
    user_metadata: { invite_token: "convite-que-nao-verifica" },
  });
  if (e0 || !convidado.user) throw e0 ?? new Error("sem usuário com convite");
  idComConvite = convidado.user.id;
  // De propósito: NENHUMA linha em `user_organizations`. É o estado que o
  // provisionamento falho deixa no disco.

  const { data: comOrg, error: e2 } = await svc.auth.admin.createUser({
    email: emailComOrg,
    password: SENHA,
    email_confirm: true,
  });
  if (e2 || !comOrg.user) throw e2 ?? new Error("sem usuário de controle");
  idComOrg = comOrg.user.id;

  const { data: org, error: e3 } = await svc
    .from("organizations")
    .insert({
      slug: `primeiro-acesso-${randomUUID().slice(0, 8)}`,
      display_name: "Empresa Que Já Existe",
      legal_name: "Empresa Que Já Existe",
      status: "active",
      created_by: idComOrg,
      onboarded_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (e3 || !org) throw e3 ?? new Error("sem org de controle");
  orgId = org.id as string;

  await svc.from("user_organizations").insert({
    organization_id: orgId,
    user_id: idComOrg,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
});

test.afterAll(async () => {
  for (const id of [orgId, orgCriadaId].filter(Boolean)) {
    await svc.from("user_organizations").delete().eq("organization_id", id);
    await svc.from("crm_stages").delete().eq("organization_id", id);
    await svc.from("crm_pipelines").delete().eq("organization_id", id);
    await svc.from("organizations").delete().eq("id", id);
  }
  for (const id of [idOrfao, idComConvite, idComOrg].filter(Boolean)) {
    await svc.auth.admin.deleteUser(id);
  }
});

async function entrar(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(SENHA);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/(app|onboarding|get-started)/, { timeout: 30_000 });
}

test.describe("conta confirmada, sem organização e com convite pendente", () => {
  test("⭐ a porta do onboarding leva à saída, e não de volta ao login", async ({ page }) => {
    // ESTA é a porta do laço: antes, `/onboarding` mandava para `/login`, que
    // mandava para `/app/inbox`, que mandava aceitar um convite que não existe.
    await entrar(page, emailComConvite);
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/get-started/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /Configure sua organização/i })).toBeVisible();
  });

  test("⭐ a porta do welcome (o layout) leva ao mesmo lugar", async ({ page }) => {
    // Porta distinta da anterior: quem redireciona aqui é `layout.tsx`, não
    // `page.tsx`. Um conserto que arrumasse só a página deixaria esta aberta.
    await entrar(page, emailComConvite);
    await page.goto("/onboarding/welcome");
    await expect(page).toHaveURL(/\/get-started/, { timeout: 20_000 });
  });

  test("⭐ abrir o Inbox sem empresa leva à saída, e não ao Perfil", async ({ page }) => {
    // O layout de `/app` manda quem não tem vínculo para `/get-started`: antes
    // a pessoa ficava presa numa tela sem menu.
    await entrar(page, emailComConvite);
    await page.goto("/app/inbox");
    await expect(page).toHaveURL(/\/get-started/, { timeout: 20_000 });
  });
});

test.describe("conta confirmada, sem organização e SEM convite, em instalação aberta", () => {
  test("⭐ o login TERMINA com a empresa criada — e não no Perfil sem menu", async ({ page }) => {
    // O caso que faltava: antes, esta pessoa caía em /app/settings/profile sem
    // menu e ficava presa. O layout manda para /get-started, que provisiona
    // sozinho com o nome do cadastro. (Pressupõe a política `aberto`, o padrão.)
    await entrar(page, emailOrfao);

    await expect(page).toHaveURL(/\/onboarding\/welcome/, { timeout: 40_000 });
    await expect(page).not.toHaveURL(/settings\/profile/);

    // A organização existe DE VERDADE no banco, com o nome digitado — não é só
    // a URL que mudou.
    const { data } = await svc
      .from("user_organizations")
      .select("organization_id, role, organizations(display_name)")
      .eq("user_id", idOrfao)
      .maybeSingle();
    expect(data, "nenhum vínculo foi criado — a tela navegou sem provisionar").not.toBeNull();
    const vinculo = data as unknown as {
      organization_id: string;
      role: string;
      // O embed to-one do PostgREST chega objeto, mas o tipo gerado diz array —
      // aceitar os dois é o que o resto da casa faz (ver `settingsDoEmbed`).
      organizations: { display_name: string } | { display_name: string }[];
    };
    orgCriadaId = vinculo.organization_id;
    expect(vinculo.role).toBe("admin");
    const org = Array.isArray(vinculo.organizations)
      ? vinculo.organizations[0]
      : vinculo.organizations;
    expect(org?.display_name).toBe("Clínica Recuperada E2E");
  });
});

test.describe("CONTROLE — quem já tem organização não é mandado para a saída", () => {
  test("⭐ digitar /get-started com organização ativa devolve ao app", async ({ page }) => {
    // Sem este caso, "redirecione todo mundo para /get-started" ficaria verde e
    // quebraria a entrada de TODA a base — e a tela viraria um "abra outra
    // empresa" para quem já tem a sua.
    await entrar(page, emailComOrg);
    await page.goto("/get-started");
    await expect(page).toHaveURL(/\/app\/inbox/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /Configure sua organização/i })).toHaveCount(0);
  });

  test("o onboarding de quem tem organização NÃO cai no /get-started", async ({ page }) => {
    // O par do caso acima na outra ponta: o redirect novo em `/onboarding` não
    // pode ter passado a valer para quem tem org.
    await entrar(page, emailComOrg);
    await page.goto("/onboarding");
    await expect(page).not.toHaveURL(/\/get-started/, { timeout: 20_000 });
  });
});
