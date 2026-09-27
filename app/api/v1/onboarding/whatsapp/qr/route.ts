import { loadOnboardingChannel } from "@/lib/channels/onboarding-session";
import { exigirAcessoLiberado } from "@/lib/planos/guarda";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";

/**
 * Proxy WAHA's QR endpoint so the browser can <img src="..." /> without
 * exposing the API key.
 *
 * WAHA exposes: GET /api/{session}/auth/qr?format=image → image/png bytes.
 */
export async function GET() {
  const user = await loadAuthUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return new NextResponse(null, { status: 404 });

  // Gate de COBRANÇA (migration 0393). Esta rota resolve a organização por
  // `resolveActiveOrg` e não passa por `requireRole`, então a guarda é explícita —
  // é o terceiro dos três pontos do gate. Quem prova que nenhuma rota ficou fora
  // dos três é `tests/unit/planos-gate-cobre-toda-rota.test.ts`.
  //
  // LER é o produto: deixar a leitura aberta entregaria o essencial de graça a
  // quem venceu.
  const semAcesso = await exigirAcessoLiberado(activeOrg.orgId, {
    idioma: user?.idioma,
  });
  if (semAcesso) return semAcesso;

  const baseUrl = process.env.WAHA_API_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrl || !apiKey || apiKey === "dev_plaintext_change_me") {
    return new NextResponse(null, { status: 503 });
  }

  const channel = await loadOnboardingChannel(await createClient(), activeOrg.orgId);
  if (!channel || channel.archived_at) return new NextResponse(null, { status: 404 });
  const sessionName = channel.waha_session_name;
  const upstream = await fetch(
    `${baseUrl}/api/${encodeURIComponent(sessionName)}/auth/qr?format=image`,
    { headers: { "X-Api-Key": apiKey }, cache: "no-store" },
  );
  if (!upstream.ok) {
    return new NextResponse(null, {
      status: upstream.status,
      headers: { "x-waha-status": String(upstream.status) },
    });
  }

  const ct = upstream.headers.get("content-type") ?? "image/png";
  const buf = await upstream.arrayBuffer();
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "content-type": ct,
      "cache-control": "no-store, max-age=0",
    },
  });
}
